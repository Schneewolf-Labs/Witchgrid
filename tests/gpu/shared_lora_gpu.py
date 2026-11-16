#!/usr/bin/env python3
"""Shared-base LoRA serving — real-model checks (opt-in; needs a GPU + GGUFs).

Driven by tests/gpu/run_shared_lora_gpu.sh, which boots a CP + agent and
creates three sharing profiles over one base GGUF: wg-a (LoRA A), wg-b
(LoRA B), wg-base (no LoRA). This script:

  1. reference outputs from DEDICATED llama-servers (base + --lora A, base +
     --lora B, plain base), started and stopped here one at a time
  2. spawns the three members through the CP (one shared llama-server)
  3. equivalence: member port vs dedicated, temperature 0 — generated
     tokens and per-token logprobs (max |diff|) for /completion and
     /v1/chat/completions, plus the CP /v1/llama route
  4. KV/prompt-cache safety across adapters on the Witchgrid shared server
     (A,P → B,Q → B,R → B,P), and the same sequence on a control server
     WITHOUT --cache-ram 0 to show what the mitigation prevents
  5. concurrency: wall/TTFT with two members generating at once vs. two
     dedicated servers
  6. VRAM per process

Prints a human summary and writes the raw numbers to $OUT (json).
Only kills processes it started (by pid).
"""
import json, os, subprocess, sys, threading, time, urllib.request

LS = os.environ["LLAMA_SERVER"]
BASE = os.environ["BASE_GGUF"]
LORA_A = os.environ["LORA_A"]
LORA_B = os.environ["LORA_B"]
CP = os.environ["CP_URL"]
NODE = os.environ["NODE_ID"]
GPU = int(os.environ.get("WG_GPU", "0"))
P_A, P_B, P_BASE = (int(x) for x in os.environ["MEMBER_PORTS"].split(","))
REF_PORT = int(os.environ.get("REF_PORT", "18961"))
REF_PORT2 = REF_PORT + 1
CTX, NP = int(os.environ.get("CTX", "8192")), int(os.environ.get("NP", "2"))
OUT = os.environ.get("OUT", "shared_lora_gpu.json")
LOGDIR = os.environ.get("LOGDIR", ".")
results = {}


def http(method, url, body=None, timeout=900):
    data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    return json.loads(raw) if raw else None


def wait_health(port, secs=300):
    t0 = time.time()
    while time.time() - t0 < secs:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=3) as r:
                if r.status == 200:
                    return time.time() - t0
        except Exception:
            pass
        time.sleep(0.5)
    raise SystemExit(f"port {port} never became healthy")


def port_free(port):
    import socket
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)   # TIME_WAIT is fine
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def start_server(port, extra, tag):
    # a stale/foreign listener would answer /health and silently stand in
    # for the reference server
    assert port_free(port), f"reference port {port} is already in use"
    log = open(os.path.join(LOGDIR, f"ref-{tag}.log"), "w")
    env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(GPU))
    p = subprocess.Popen([LS, "-m", BASE, "--host", "127.0.0.1", "--port", str(port), "-c", str(CTX),
                          "-np", str(NP), "-ngl", "99", "-fa", "on", "--jinja"] + extra,
                         stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env)
    wait_health(port)
    assert p.poll() is None, f"reference server {tag} exited (see ref-{tag}.log)"
    return p


def stop_server(p):
    p.terminate()
    try:
        p.wait(30)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()


FILLER = " ".join(f"Fact {i}: lantern {i} glows {['red', 'blue', 'green', 'amber'][i % 4]}." for i in range(120))
P = "<|im_start|>user\nYou are a narrator. " + FILLER + "\nDescribe yourself in two sentences.<|im_end|>\n<|im_start|>assistant\n"
Q = "Quarterly report draft. " + FILLER[::-1][:2000] + "\nSummary:"
R = "Riddle time! " + " ".join(f"item{i}" for i in range(300)) + "\nAnswer:"
CHAT = [{"role": "user", "content": "In one sentence: who are you and what do you like?"}]


def probs(port, prompt, lora=None, n=24, cache=True, path="/completion", base_url=None):
    b = {"prompt": prompt, "n_predict": n, "temperature": 0, "top_k": 1, "seed": 1,
         "n_probs": 1, "cache_prompt": cache, "return_tokens": True}
    if lora is not None:
        b["lora"] = lora
    url = (base_url or f"http://127.0.0.1:{port}") + path
    r = http("POST", url, b)
    lp = [x["top_logprobs"][0]["logprob"] for x in r["completion_probabilities"]]
    return {"tokens": r["tokens"], "lp": lp, "cache_n": r.get("timings", {}).get("cache_n"),
            "slot": r.get("id_slot"), "text": r["content"]}


def chat(port, lora=None, base_url=None):
    b = {"messages": CHAT, "temperature": 0, "max_tokens": 24, "seed": 1, "logprobs": True,
         "top_logprobs": 1, "cache_prompt": False}
    if lora is not None:
        b["lora"] = lora
    r = http("POST", (base_url or f"http://127.0.0.1:{port}") + "/v1/chat/completions", b)
    c = r["choices"][0]
    return {"text": c["message"]["content"], "lp": [x["logprob"] for x in c["logprobs"]["content"]]}


def maxdiff(a, b):
    if len(a) != len(b):
        return float("inf")
    return max((abs(x - y) for x, y in zip(a, b)), default=0.0)


def vram_by_pid():
    out = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
                         capture_output=True, text=True).stdout
    m = {}
    for line in out.strip().splitlines():
        pid, mb = (x.strip() for x in line.split(","))
        m[int(pid)] = int(mb)
    return m


# ── 1. references from dedicated servers ─────────────────────────────
print("[gpu] references from dedicated servers…", flush=True)
refs = {}
for tag, extra in [("a", ["--lora", LORA_A]), ("b", ["--lora", LORA_B]), ("base", [])]:
    p = start_server(REF_PORT, extra, tag)
    refs[tag] = {"P": probs(REF_PORT, P, cache=False), "chat": chat(REF_PORT)}
    if tag == "a":
        results["vram_dedicated_mb"] = vram_by_pid().get(p.pid)
    stop_server(p)
print("[gpu]   A vs B logprob maxdiff on P: %.4f (adapters really differ)" % maxdiff(refs["a"]["P"]["lp"], refs["b"]["P"]["lp"]))

# ── 2. members through the CP (one shared server) ─────────────────────
print("[gpu] spawning members through the CP…", flush=True)
t0 = time.time()
for name in ["wg-a", "wg-b", "wg-base"]:
    http("POST", CP + "/services", {"profile": name, "node_id": NODE, "gpus": [GPU]})
for port in (P_A, P_B, P_BASE):
    wait_health(port)
results["members_ready_s"] = round(time.time() - t0, 1)
svcs = http("GET", CP + "/services")
srv = [s for s in svcs if (s.get("shared") or {}).get("role") == "server"]
assert len(srv) == 1, f"expected one shared server, got {len(srv)}"
srv = srv[0]
results["shared_server"] = {"pid": srv["pid"], "port": srv["port"], "adapters": srv["shared"]["adapters"],
                            "slots": srv["shared"]["slots"], "ctx": srv["shared"]["context"]}
results["vram_shared_mb"] = vram_by_pid().get(srv["pid"])

# ── 3. equivalence ─────────────────────────────────────────────────────
eq = {}
for tag, port in [("a", P_A), ("b", P_B), ("base", P_BASE)]:
    got = probs(port, P, cache=False)
    gc = chat(port)
    eq[tag] = {"tokens_equal": got["tokens"] == refs[tag]["P"]["tokens"],
               "logprob_maxdiff": maxdiff(got["lp"], refs[tag]["P"]["lp"]),
               "chat_text_equal": gc["text"] == refs[tag]["chat"]["text"],
               "chat_logprob_maxdiff": maxdiff(gc["lp"], refs[tag]["chat"]["lp"])}
via_cp = probs(None, P, cache=False, base_url=CP + "/v1/llama/wg-a")
eq["a_via_cp_route"] = {"tokens_equal": via_cp["tokens"] == refs["a"]["P"]["tokens"],
                        "logprob_maxdiff": maxdiff(via_cp["lp"], refs["a"]["P"]["lp"])}
# a client trying to select another member's adapter on wg-base's port
forged = probs(P_BASE, P, cache=False, lora=[{"id": 0, "scale": 1.0}, {"id": 1, "scale": 1.0}])
eq["base_port_client_lora_ignored"] = {"logprob_maxdiff_vs_base": maxdiff(forged["lp"], refs["base"]["P"]["lp"])}
results["equivalence"] = eq

# HTTP/1.0 streaming (nginx's default upstream protocol): the member port
# must frame the response exactly like the server does for that client.
def raw_stream(port, body):
    import socket
    s = socket.create_connection(("127.0.0.1", port))
    b = json.dumps(body).encode()
    s.sendall(b"POST /completion HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n" % len(b) + b)
    buf = b""
    while True:
        c = s.recv(65536)
        if not c:
            break
        buf += c
    head, _, rest = buf.partition(b"\r\n\r\n")
    lines = head.decode().split("\r\n")
    hdrs = {l.split(":", 1)[0].lower(): l.split(":", 1)[1].strip() for l in lines[1:] if ":" in l}
    return {"status": lines[0], "transfer_encoding": hdrs.get("transfer-encoding"),
            "frames": rest.count(b"data: ")}
body = {"prompt": "Hello", "n_predict": 8, "stream": True, "temperature": 0}
direct = raw_stream(srv["port"], dict(body, lora=[{"id": i, "scale": 0.0} for i in range(len(srv["shared"]["adapters"]))]))
proxied = raw_stream(P_BASE, body)
results["http10_stream"] = {"direct": direct, "member_port": proxied}

# ── 4. cache safety across adapters ───────────────────────────────────
def cache_sequence(fn_a, fn_b):
    steps = []
    for name, fn, prompt, ref in [("A,P", fn_a, P, refs["a"]), ("B,Q", fn_b, Q, None),
                                  ("B,R", fn_b, R, None), ("B,P", fn_b, P, refs["b"]),
                                  ("B,P again", fn_b, P, refs["b"]), ("A,P", fn_a, P, refs["a"])]:
        g = fn(prompt)
        steps.append({"step": name, "slot": g["slot"], "cache_n": g["cache_n"],
                      "maxdiff_vs_dedicated": (maxdiff(g["lp"], ref["P"]["lp"]) if ref else None)})
    return steps

# fresh slots: the members' server was just used for equivalence with
# cache_prompt false; the sequence below uses the default (cache on)
results["cache_witchgrid"] = cache_sequence(lambda pr: probs(P_A, pr), lambda pr: probs(P_B, pr))
print("[gpu] control server WITHOUT --cache-ram 0 (what the mitigation prevents)…", flush=True)
ctrl = start_server(REF_PORT, ["--lora-scaled", f"{LORA_A}:0,{LORA_B}:0"], "control")
SEL_A = [{"id": 0, "scale": 1.0}, {"id": 1, "scale": 0.0}]
SEL_B = [{"id": 0, "scale": 0.0}, {"id": 1, "scale": 1.0}]
results["cache_control_default_cache_ram"] = cache_sequence(
    lambda pr: probs(REF_PORT, pr, lora=SEL_A), lambda pr: probs(REF_PORT, pr, lora=SEL_B))
stop_server(ctrl)

# ── 5. concurrency ─────────────────────────────────────────────────────
def stream_job(port, n, out, k, lora=None):
    b = {"prompt": f"Story {k}: Once upon a time", "n_predict": n, "ignore_eos": True, "temperature": 0.7,
         "stream": True, "cache_prompt": False}
    if lora is not None:
        b["lora"] = lora
    req = urllib.request.Request(f"http://127.0.0.1:{port}/completion", data=json.dumps(b).encode(),
                                 headers={"content-type": "application/json"})
    t0 = time.time(); ttft = None; ntok = 0
    with urllib.request.urlopen(req, timeout=900) as r:
        for line in r:
            if line.startswith(b"data: "):
                d = json.loads(line[6:])
                if d.get("content"):
                    ntok += 1
                    if ttft is None:
                        ttft = time.time() - t0
    out[k] = {"ttft_s": round(ttft or -1, 2), "total_s": round(time.time() - t0, 2), "tokens": ntok}


def run(jobs, n=256, stagger=0.0):
    out = [None] * len(jobs)
    ts = []
    for k, (port, lora) in enumerate(jobs):
        t = threading.Thread(target=stream_job, args=(port, n, out, k, lora))
        t.start(); ts.append(t)
        if stagger:
            time.sleep(stagger)
    t0 = time.time()
    for t in ts:
        t.join()
    return out

conc = {}
run([(P_A, None)], n=16)
conc["single member (A)"] = run([(P_A, None)])
conc["2x same member (A+A)"] = run([(P_A, None), (P_A, None)])
conc["2x different adapters (A+B)"] = run([(P_A, None), (P_B, None)], stagger=0.3)
conc["2x adapter+base (A+base)"] = run([(P_A, None), (P_BASE, None)], stagger=0.3)
print("[gpu] two dedicated servers for comparison…", flush=True)
d1 = start_server(REF_PORT, ["--lora", LORA_A], "conc-a")
d2 = start_server(REF_PORT2, [], "conc-base")
run([(REF_PORT, None)], n=16)
conc["2x dedicated servers (A + base)"] = run([(REF_PORT, None), (REF_PORT2, None)], stagger=0.3)
stop_server(d1); stop_server(d2)
results["concurrency"] = conc

json.dump(results, open(OUT, "w"), indent=2)

# ── summary ──────────────────────────────────────────────────────────
print("\n=== shared-LoRA GPU results ===")
print(f"shared server: pid {srv['pid']} adapters {len(srv['shared']['adapters'])} slots {srv['shared']['slots']} ctx {srv['shared']['context']}")
print(f"VRAM: one dedicated (base+A, ctx {CTX}/{NP}) {results['vram_dedicated_mb']} MiB; shared (3 members) {results['vram_shared_mb']} MiB")
ok = True
for k, v in eq.items():
    print(f"equivalence {k}: {v}")
    if "logprob_maxdiff" in v and v["logprob_maxdiff"] != 0.0:
        ok = False
    if "tokens_equal" in v and not v["tokens_equal"]:
        ok = False
if eq["base_port_client_lora_ignored"]["logprob_maxdiff_vs_base"] != 0.0:
    ok = False
h10 = results["http10_stream"]
print(f"HTTP/1.0 streaming: direct {h10['direct']} | member port {h10['member_port']}")
if h10["direct"]["status"] != h10["member_port"]["status"] or \
        h10["direct"]["transfer_encoding"] != h10["member_port"]["transfer_encoding"] or \
        h10["member_port"]["frames"] < 2:
    ok = False
print("cache (Witchgrid shared server, --cache-ram 0):")
for s in results["cache_witchgrid"]:
    print("   ", s)
    if s["maxdiff_vs_dedicated"] not in (None, 0.0):
        ok = False
print("cache (control: same adapters, llama-server default --cache-ram):")
for s in results["cache_control_default_cache_ram"]:
    print("   ", s)
print("concurrency (256 tokens each, streaming):")
for k, v in conc.items():
    print(f"   {k}: {v}")
print("RESULT:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
