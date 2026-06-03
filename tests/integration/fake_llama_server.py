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

    port = 8080
    for i, a in enumerate(args):
        if a == "--port" and i + 1 < len(args):
            port = int(args[i + 1])

    from http.server import BaseHTTPRequestHandler, HTTPServer

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

        def do_GET(self):
            if self.path.startswith("/health"):
                self._json(200, {"status": "ok"})
            else:
                self._json(404, {"error": "fake: no GET " + self.path})

        def do_POST(self):
            n = int(self.headers.get("content-length", 0) or 0)
            raw = self.rfile.read(n) if n else b""
            try:
                body = json.loads(raw or b"{}")
            except Exception:
                body = {}
            if body.get("stream") is True:
                # SSE: a few token chunks then a terminal frame, llama.cpp shape.
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.end_headers()
                for i, tok in enumerate([" one", " two", " three"]):
                    frame = {"index": 0, "content": tok, "stop": False,
                             "tokens_predicted": i + 1}
                    self.wfile.write(("data: " + json.dumps(frame) + "\n\n").encode())
                    self.wfile.flush()
                done = {"index": 0, "content": "", "stop": True, "tokens_predicted": 3}
                self.wfile.write(("data: " + json.dumps(done) + "\n\n").encode())
                self.wfile.flush()
            else:
                self._json(200, {"content": " ok", "stop": True,
                                 "tokens_predicted": 1, "tokens_evaluated": 1})

    HTTPServer(("0.0.0.0", port), Handler).serve_forever()


main()
