#!/usr/bin/env python3
"""A stand-in for llama-server, for Witchgrid integration tests.

CI has no GPU and no models, so we can't spawn the real thing. The agent
spawns whatever `llama-server` is on PATH; dropping this in (named
`llama-server`) lets the integration harness exercise the full control
plane — registration, placement/spawn, health-gating, /resolve, the
/v1/llama proxy, and SSE passthrough — without a model.

Three modes, dispatched by argv (the agent invokes all three):
  --help / -h   → print a llama-server-shaped help so capabilities.parse
                  extracts the flags the profiles reference. Exit 0.
  --version     → print a version line for probe_version. Exit 0.
  (otherwise)   → server mode: find --port, bind 0.0.0.0:port, serve
                  GET /health → 200 {"status":"ok"}
                  POST /completion → JSON, or text/event-stream when the
                    request body has "stream": true. Run until killed.
"""
import os
import signal
import sys
import json

# Minimal llama-server --help covering the flags the shipped profiles'
# intents render (ctx-size, cache-type-k/v, gpu-layers, parallel,
# flash-attn) plus host/port/model — enough for capabilities.parse_help.
HELP = """build: 9999 (fakehash) with cc for x86_64-linux-gnu

----- common params -----

-h,    --help, --usage                  print usage and exit
       --version                        show version and build info
-c,    --ctx-size N                     size of the prompt context (default: 4096)
-fa,   --flash-attn [on|off|auto]       set Flash Attention use (default: 'auto')
-ctk,  --cache-type-k TYPE              KV cache data type for K (default: f16)
-ctv,  --cache-type-v TYPE              KV cache data type for V (default: f16)
-ngl,  --gpu-layers, --n-gpu-layers N   number of layers to store in VRAM
-np,   --parallel N                     number of parallel sequences to decode (default: 1)
-a,    --alias STRING                   set model name aliases, comma-separated (to be used by API)
       --lora FNAME                     path to LoRA adapter (use comma-separated values to load multiple
                                        adapters)
       --lora-scaled FNAME:SCALE,...    path to LoRA adapter with user defined scaling (format:
                                        FNAME:SCALE,...)
       --lora-init-without-apply        load LoRA adapters without applying them (apply later via POST
                                        /lora-adapters) (default: disabled)
-cram, --cache-ram N                    set the maximum cache size in MiB (default: 8192, -1 - no limit, 0 -
                                        disable)
       --jinja                          use jinja template for chat (default: disabled)
       --host HOST                      ip address to listen (default: 127.0.0.1)
       --port PORT                      port to listen (default: 8080)
-m,    --model FNAME                    model path
"""


def main():
    args = sys.argv[1:]
    if "--help" in args or "-h" in args or "--usage" in args:
        sys.stdout.write(HELP)
        return
    if "--version" in args:
        sys.stdout.write("version: 9999 (fakehash)\n")
        return

    # Server mode: re-exec once with argv[0] set to this file's path, so
    # /proc/<pid>/cmdline starts with ".../llama-server" like the real
    # binary. The agent's ownership check reads argv[0]; under the plain
    # shebang argv[0] is "python3", and the agent would refuse to treat
    # the fake as its own server (no SIGKILL escalation, watchdog churn).
    if os.environ.get("FAKE_LLAMA_REEXEC") != "1":
        os.environ["FAKE_LLAMA_REEXEC"] = "1"
        me = os.path.abspath(__file__)
        os.execv(sys.executable, [me, me] + args)

    # --ignore-sigterm: behave like a llama-server stuck in a long call,
    # so the agent's stop path has to escalate to SIGKILL.
    if "--ignore-sigterm" in args:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)

    port = 8080
    host = "0.0.0.0"
    model = "fake-model.gguf"
    alias = None
    adapters = []          # [{"id", "path", "scale"}] like GET /lora-adapters
    for i, a in enumerate(args):
        nxt = args[i + 1] if i + 1 < len(args) else None
        if a == "--port" and nxt:
            port = int(nxt)
        elif a == "--host" and nxt:
            host = nxt
        elif a in ("-m", "--model") and nxt:
            model = nxt
        elif a in ("-a", "--alias") and nxt:
            alias = nxt.split(",")[0]
        elif a == "--lora" and nxt:
            for p in nxt.split(","):
                adapters.append({"id": len(adapters), "path": p, "scale": 1.0})
        elif a == "--lora-scaled" and nxt:
            for item in nxt.split(","):
                p, sc = item.split(":")
                adapters.append({"id": len(adapters), "path": p, "scale": float(sc)})
    model_name = alias or model
    load_s = float(os.environ.get("FAKE_LLAMA_LOAD_SECONDS", "0") or 0)
    import time
    started = time.time()

    def effective_lora(req_lora):
        """llama-server semantics: listed ids get their scale, unlisted 0;
        no field / empty list = the global scales."""
        if not req_lora:
            return [{"id": a["id"], "scale": a["scale"]} for a in adapters]
        want = {e.get("id"): e.get("scale", 0.0) for e in req_lora}
        return [{"id": a["id"], "scale": float(want.get(a["id"], 0.0))} for a in adapters]

    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer as HTTPServer

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass  # quiet

        def _json(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _loading(self):
            if time.time() - started < load_s:
                self._json(503, {"error": {"code": 503, "message": "Loading model",
                                           "type": "unavailable_error"}})
                return True
            return False

        def do_GET(self):
            if self.path.startswith("/health"):
                if self._loading():
                    return
                self._json(200, {"status": "ok"})
            elif self.path.startswith("/lora-adapters"):
                self._json(200, adapters)
            elif self.path.startswith("/v1/models") or self.path.startswith("/models"):
                self._json(200, {"object": "list",
                                 "models": [{"name": model_name, "model": model_name}],
                                 "data": [{"id": model_name, "object": "model"}]})
            elif self.path.startswith("/props"):
                self._json(200, {"model_alias": model_name, "model_path": model})
            elif self.path.startswith("/echo"):
                self._json(200, {"path": self.path, "method": "GET",
                                 "headers": {k.lower(): v for k, v in self.headers.items()}})
            else:
                self._json(404, {"error": "fake: no GET " + self.path})

        def do_POST(self):
            if self._loading():
                return
            n = int(self.headers.get("content-length", 0) or 0)
            raw = self.rfile.read(n) if n else b""
            try:
                body = json.loads(raw or b"{}")
            except Exception:
                body = {}
            if not isinstance(body, dict):
                body = {}
            # json.loads keeps the LAST duplicate key, like llama-server's parser.
            lora_req = body.get("lora")
            info = {"path": self.path, "lora_received": lora_req,
                    "lora_effective": effective_lora(lora_req),
                    "body_bytes": len(raw), "raw_sha": __import__("hashlib").sha256(raw).hexdigest(),
                    "headers": {k.lower(): v for k, v in self.headers.items()}}
            if self.path.startswith("/lora-adapters"):
                self._json(200, {"success": True})
                return
            if body.get("stream") is True:
                # SSE: a few token chunks then a terminal frame, llama.cpp shape.
                delay = float(body.get("fake_delay", 0) or 0)
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.end_headers()
                for i, tok in enumerate([" one", " two", " three"]):
                    frame = {"index": 0, "content": tok, "stop": False,
                             "tokens_predicted": i + 1, "t": time.time()}
                    if i == 0:
                        frame.update(info)
                    self.wfile.write(("data: " + json.dumps(frame) + "\n\n").encode())
                    self.wfile.flush()
                    if delay:
                        time.sleep(delay)
                done = {"index": 0, "content": "", "stop": True, "tokens_predicted": 3,
                        "t": time.time()}
                self.wfile.write(("data: " + json.dumps(done) + "\n\n").encode())
                self.wfile.flush()
            else:
                out = {"content": " ok", "stop": True, "model": model_name,
                       "tokens_predicted": 1, "tokens_evaluated": 1}
                out.update(info)
                self._json(200, out)

    HTTPServer((host, port), Handler).serve_forever()


main()
