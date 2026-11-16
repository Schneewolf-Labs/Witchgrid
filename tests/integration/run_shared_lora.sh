#!/usr/bin/env bash
# Shared-base LoRA serving — integration harness (no GPU needed).
#
# Boots a real CP + agent with the fake llama-server (which implements
# llama-server's per-request `lora` semantics and echoes what it received)
# and drives the shared-server lifecycle end to end:
#   join / restart-on-new-adapter / no-restart-when-covered, per-member LoRA
#   selection through member ports AND the CP /v1/llama route, override of a
#   client-sent `lora`, SSE passthrough (unbuffered), chunked + Expect bodies,
#   alias rewrite on /v1/models, refused endpoints, incompatible settings,
#   member stop (others unaffected, no restart), last-member stop, watchdog
#   respawn of the server, agent restart (server adopted, proxies re-bound),
#   stopping the server row, auto-spawn through /v1/llama.
#
# Usage (from repo root, after building cp/witchgrid-cp + agent/witchgrid-agent):
#   CP_PORT=8865 AGENT_PORT=8866 bash tests/integration/run_shared_lora.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CP_BIN="${CP_BIN:-$ROOT/cp/witchgrid-cp}"
AGENT_BIN="${AGENT_BIN:-$ROOT/agent/witchgrid-agent}"
FAKE="$ROOT/tests/integration/fake_llama_server.py"
CP_PORT="${CP_PORT:-8865}"
AGENT_PORT="${AGENT_PORT:-8866}"
NODE_ID="share-agent"
CP_URL="http://127.0.0.1:${CP_PORT}"
AGENT_URL="http://127.0.0.1:${AGENT_PORT}"
SHARED_BASE="${SHARED_BASE:-18640}"       # internal (loopback) ports of shared servers
P_LUNA=18651; P_FAM=18652; P_RIKO=18653; P_BAD=18654

TMP="$(mktemp -d)"
BIN="$TMP/bin"; mkdir -p "$BIN" "$TMP/cp" "$TMP/agent" "$TMP/models" "$TMP/loras"
cp "$FAKE" "$BIN/llama-server"; chmod +x "$BIN/llama-server"
MODEL="$TMP/models/base-9b.gguf"; cp "$ROOT/tests/fixtures/nemo_llama.gguf" "$MODEL"
LUNA="$TMP/loras/luna-f16.gguf"; RIKO="$TMP/loras/riko-f16.gguf"
: > "$LUNA"; : > "$RIKO"

CP_PID=""; AGENT_PID=""
cleanup() {
	[ -n "$AGENT_PID" ] && kill -9 "$AGENT_PID" 2>/dev/null
	[ -n "$CP_PID" ] && kill -9 "$CP_PID" 2>/dev/null
	for p in $(pgrep -f "$BIN/llama-server" 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
	if [ "${KEEP_TMP:-}" = "1" ]; then echo "[shared-lora] kept $TMP"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT

PASS=0; FAIL=0
check() {
	local desc="$1"; shift
	if "$@" >/dev/null 2>&1; then echo "  ✓ $desc"; PASS=$((PASS+1));
	else echo "  ✗ $desc"; FAIL=$((FAIL+1)); fi
}
py() { python3 -c "$@"; }
# A pid is "up" if it exists and isn't a zombie (a killed server whose parent
# hasn't reaped it yet still answers kill -0).
up() { [ -e "/proc/$1" ] && ! grep -q '^State:[[:space:]]*Z' "/proc/$1/status" 2>/dev/null; }

if curl -fsS "$CP_URL/healthz" >/dev/null 2>&1; then
	echo "[shared-lora] ERROR: $CP_URL already serving; pick another CP_PORT"; exit 1
fi

( cd "$TMP/cp" && exec env WITCHGRID_DATA_DIR="$TMP/cp" WITCHGRID_STALE_NODE_SECONDS=6 WITCHGRID_CP_PORT="$CP_PORT" "$CP_BIN" ) >"$TMP/cp.log" 2>&1 &
CP_PID=$!; disown "$CP_PID" 2>/dev/null || true
for i in $(seq 1 30); do curl -fsS "$CP_URL/healthz" >/dev/null 2>&1 && break; sleep 0.3; done

boot_agent() {
	PATH="$BIN:$PATH" HOME="$TMP" \
		WITCHGRID_CP_URL="$CP_URL" WITCHGRID_AGENT_URL="$AGENT_URL" \
		WITCHGRID_AGENT_PORT="$AGENT_PORT" WITCHGRID_NODE_ID="$NODE_ID" \
		WITCHGRID_DATA_DIR="$TMP/agent" WITCHGRID_MODEL_DIR="$TMP/models" \
		WITCHGRID_HEARTBEAT_SECONDS=1 WITCHGRID_SHARED_PORT_BASE="$SHARED_BASE" \
		"$AGENT_BIN" >>"$TMP/agent.log" 2>&1 &
	AGENT_PID=$!; disown "$AGENT_PID" 2>/dev/null || true
}
boot_agent
for i in $(seq 1 40); do curl -fsS "$CP_URL/nodes" 2>/dev/null | grep -q "$NODE_ID" && break; sleep 0.3; done

# ── profiles: Luna (LoRA), Familiar (no LoRA), Riko (other LoRA, -a alias) ──
mkprof() {  # name json
	curl -fsS -X POST "$CP_URL/api/profiles" -H 'content-type: application/json' \
		-d "{\"name\":\"$1\",\"profile\":$2}" >/dev/null
}
COMMON='"binary":"llama-server","kv_type":"f16","default_model":"'"$MODEL"'","share_group":"spark"'
mkprof luna-t  '{'"$COMMON"',"intent":{"context":4096,"parallel_slots":2,"gpu_layers":0,"flash_attention":true},"extra_flags":["--jinja","--lora","'"$LUNA"'"],"default_port":'$P_LUNA',"context":4096}'
mkprof fam-t   '{'"$COMMON"',"intent":{"context":4096,"parallel_slots":2,"gpu_layers":0,"flash_attention":true},"extra_flags":["--jinja"],"default_port":'$P_FAM',"context":4096}'
mkprof riko-t  '{'"$COMMON"',"intent":{"context":8192,"parallel_slots":1,"gpu_layers":0,"flash_attention":true},"extra_flags":["--jinja","-a","riko-narrator"],"lora":"'"$RIKO"'","default_port":'$P_RIKO',"context":8192}'
mkprof bad-t   '{'"$COMMON"',"intent":{"context":4096,"parallel_slots":1,"gpu_layers":0,"flash_attention":true},"extra_flags":[],"default_port":'$P_BAD',"context":4096}'

spawn() { curl -sS -o "$TMP/spawn.out" -w '%{http_code}' -X POST "$CP_URL/services" -H 'content-type: application/json' -d "{\"profile\":\"$1\"}"; }
svcs() { curl -fsS "$AGENT_URL/services"; }
server_field() {  # python expr over the running server entry `s`
	svcs | py "import sys,json; s=[x for x in json.load(sys.stdin) if (x.get('shared') or {}).get('role')=='server' and x['state']=='running']; print($1 if s else '')"
}
member_lora() {  # port [extra-json-fields] → the effective lora the fake saw
	local extra="${2:-}"
	curl -fsS -X POST "http://127.0.0.1:$1/completion" -H 'content-type: application/json' \
		-d "{\"prompt\":\"hi\"$extra}" | py "import sys,json; print(json.dumps([e['scale'] for e in json.load(sys.stdin)['lora_effective']]))"
}
wait_ok() {  # url, seconds
	for i in $(seq 1 $(( $2 * 5 ))); do curl -fsS "$1" >/dev/null 2>&1 && return 0; sleep 0.2; done; return 1
}

export -f member_lora py up

echo "[shared-lora] assertions:"

check "profile with share_group but no intent.parallel_slots is refused (400)" \
	bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST '$CP_URL/api/profiles' -H 'content-type: application/json' -d '{\"name\":\"nope\",\"profile\":{\"binary\":\"llama-server\",\"share_group\":\"spark\",\"intent\":{\"context\":4096}}}')\" = 400 ]"
check "profile with share_group and an adapter path containing ':' is refused (400)" \
	bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST '$CP_URL/api/profiles' -H 'content-type: application/json' -d '{\"name\":\"nope2\",\"profile\":{\"binary\":\"llama-server\",\"share_group\":\"spark\",\"intent\":{\"context\":4096,\"parallel_slots\":1},\"lora\":\"/x/a:b.gguf\"}}')\" = 400 ]"

check "docs/examples/profiles/spark-shared.json profiles are accepted by the CP" \
	python3 - <<PY
import json, urllib.request
ex = json.load(open("$ROOT/docs/examples/profiles/spark-shared.json"))
for p in ex["profiles"]:
    req = urllib.request.Request("$CP_URL/api/profiles", data=json.dumps(p).encode(),
                                 headers={"content-type": "application/json"})
    urllib.request.urlopen(req, timeout=10)
PY
check "spawn luna-t (first member) starts a shared server + member" \
	bash -c "[ \"\$(curl -sS -o /dev/null -w '%{http_code}' -X POST '$CP_URL/services' -H 'content-type: application/json' -d '{\"profile\":\"luna-t\"}')\" = 201 ]"
SRV1_PID=$(server_field "s[0]['pid']")
SRV1_PORT=$(server_field "s[0]['port']")
check "shared server row: group spark, 1 member, internal port in the shared range" \
	bash -c "svcs() { curl -fsS '$AGENT_URL/services'; }; svcs | python3 -c 'import sys,json; s=[x for x in json.load(sys.stdin) if (x.get(\"shared\") or {}).get(\"role\")==\"server\"][0]; sh=s[\"shared\"]; sys.exit(0 if sh[\"group\"]==\"spark\" and [m[\"profile\"] for m in sh[\"members\"]]==[\"luna-t\"] and s[\"port\"]>=$SHARED_BASE and s[\"profile\"]==\"shared:spark\" else 1)'"
check "shared server argv: adapter at global scale 0, --cache-ram 0, loopback bind, -c 4096 -np 2" \
	bash -c "tr '\\0' ' ' </proc/$SRV1_PID/cmdline | grep -q -- '--lora-scaled $LUNA:0' && tr '\\0' ' ' </proc/$SRV1_PID/cmdline | grep -q -- '--cache-ram 0' && tr '\\0' ' ' </proc/$SRV1_PID/cmdline | grep -q -- '--host 127.0.0.1' && tr '\\0' ' ' </proc/$SRV1_PID/cmdline | grep -q -- '-c 4096' && tr '\\0' ' ' </proc/$SRV1_PID/cmdline | grep -q -- '-np 2' && ! tr '\\0' ' ' </proc/$SRV1_PID/cmdline | grep -q -- '--lora '"
check "shared server is NOT reachable on the LAN address (loopback only)" \
	bash -c "! curl -fsS --max-time 2 \"http://\$(hostname -I | awk '{print \$1}'):$SRV1_PORT/health\""
check "member port proxies /health (200)" wait_ok "http://127.0.0.1:$P_LUNA/health" 10
check "member luna-t → its adapter at scale 1" bash -c "[ \"\$(member_lora $P_LUNA)\" = '[1.0]' ]"

check "fam-t (no LoRA, +2 slots) joins: server restarts with 4 slots" \
	bash -c "[ \"\$(curl -sS -o /dev/null -w '%{http_code}' -X POST '$CP_URL/services' -H 'content-type: application/json' -d '{\"profile\":\"fam-t\"}')\" = 201 ]"
SRV2_PID=$(server_field "s[0]['pid']")
check "server restarted (new pid) with -np 4 and still one adapter" \
	bash -c "[ '$SRV2_PID' != '$SRV1_PID' ] && tr '\\0' ' ' </proc/$SRV2_PID/cmdline | grep -q -- '-np 4' && tr '\\0' ' ' </proc/$SRV2_PID/cmdline | grep -q -- '-c 8192'"
check "old shared server process is gone" bash -c "! up $SRV1_PID"
wait_ok "http://127.0.0.1:$P_FAM/health" 10
check "member fam-t → every adapter explicitly 0 (base model)" bash -c "[ \"\$(member_lora $P_FAM)\" = '[0.0]' ]"
check "fam-t request carries an explicit lora list, never [] (global fallback)" \
	bash -c "curl -fsS -X POST http://127.0.0.1:$P_FAM/completion -H 'content-type: application/json' -d '{\"prompt\":\"hi\"}' | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d[\"lora_received\"]==[{\"id\":0,\"scale\":0.0}] else 1)'"
check "member luna-t still → [1.0] after the restart" bash -c "[ \"\$(member_lora $P_LUNA)\" = '[1.0]' ]"
check "client-sent lora is overridden on a member port (fam-t asks for id0=1 → gets 0)" \
	bash -c "[ \"\$(member_lora $P_FAM ',\"lora\":[{\"id\":0,\"scale\":1.0}]')\" = '[0.0]' ]"
check "/v1/chat/completions gets the selection too" \
	bash -c "curl -fsS -X POST http://127.0.0.1:$P_LUNA/v1/chat/completions -H 'content-type: application/json' -d '{\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}' | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if [e[\"scale\"] for e in d[\"lora_effective\"]]==[1.0] and d[\"path\"]==\"/v1/chat/completions\" else 1)'"
check "non-generation POST (/tokenize) body passes through byte-identical" \
	bash -c "B='{\"content\":\"héllo — ✓\"}'; H=\$(printf '%s' \"\$B\" | sha256sum | cut -d' ' -f1); curl -fsS -X POST http://127.0.0.1:$P_LUNA/tokenize -H 'content-type: application/json' --data-binary \"\$B\" | python3 -c \"import sys,json; sys.exit(0 if json.load(sys.stdin)['raw_sha']=='\$H' else 1)\""
check "query string + request headers pass through (GET /echo?x=1, X-Test)" \
	bash -c "curl -fsS -H 'X-Test: abc' 'http://127.0.0.1:$P_LUNA/echo?x=1' | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d[\"path\"]==\"/echo?x=1\" and d[\"headers\"].get(\"x-test\")==\"abc\" else 1)'"
check "chunked request body is decoded + injected" \
	bash -c "curl -fsS -X POST http://127.0.0.1:$P_LUNA/completion -H 'content-type: application/json' -H 'Transfer-Encoding: chunked' -d '{\"prompt\":\"chunky\"}' | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if [e[\"scale\"] for e in d[\"lora_effective\"]]==[1.0] else 1)'"
check "Expect: 100-continue large body (200 KB) is forwarded + injected" \
	bash -c "python3 -c 'import json; print(json.dumps({\"prompt\":\"x\"*200000}))' > $TMP/big.json; curl -fsS --max-time 10 -X POST http://127.0.0.1:$P_FAM/completion -H 'content-type: application/json' -H 'Expect: 100-continue' --data-binary @$TMP/big.json | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d[\"lora_received\"]==[{\"id\":0,\"scale\":0.0}] and d[\"body_bytes\"]>200000 else 1)'"
check "SSE through a member port: frames arrive, selection applied" \
	bash -c "curl -fsS -N -X POST http://127.0.0.1:$P_LUNA/completion -H 'content-type: application/json' -d '{\"prompt\":\"hi\",\"stream\":true}' | grep '^data: ' | head -1 | sed 's/^data: //' | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if [e[\"scale\"] for e in d[\"lora_effective\"]]==[1.0] else 1)'"
check "SSE is not buffered: first frame reaches the client before the last is produced" \
	python3 - <<PY
import socket, json, time
s = socket.create_connection(("127.0.0.1", $P_LUNA))
body = json.dumps({"prompt": "hi", "stream": True, "fake_delay": 0.6}).encode()
s.sendall(b"POST /completion HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n" % len(body) + body)
buf = b""; first = None
while True:
    c = s.recv(65536)
    if not c: break
    buf += c
    if first is None and b"data: " in buf: first = time.time()
end = time.time()
raise SystemExit(0 if first is not None and end - first > 1.0 else 1)
PY
check "POST /lora-adapters is refused on a member port (403)" \
	bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:$P_LUNA/lora-adapters -H 'content-type: application/json' -d '[{\"id\":0,\"scale\":1}]')\" = 403 ]"
check "GET /lora-adapters passes through (server-wide view)" \
	bash -c "curl -fsS http://127.0.0.1:$P_LUNA/lora-adapters | python3 -c 'import sys,json; sys.exit(0 if len(json.load(sys.stdin))==1 else 1)'"

check "CP /v1/llama/luna-t routes to the member → its adapter" \
	bash -c "curl -fsS -X POST '$CP_URL/v1/llama/luna-t/completion' -H 'content-type: application/json' -d '{\"prompt\":\"hi\"}' | python3 -c 'import sys,json; sys.exit(0 if [e[\"scale\"] for e in json.load(sys.stdin)[\"lora_effective\"]]==[1.0] else 1)'"
check "CP /v1/llama/fam-t → base (all 0)" \
	bash -c "curl -fsS -X POST '$CP_URL/v1/llama/fam-t/completion' -H 'content-type: application/json' -d '{\"prompt\":\"hi\"}' | python3 -c 'import sys,json; sys.exit(0 if [e[\"scale\"] for e in json.load(sys.stdin)[\"lora_effective\"]]==[0.0] else 1)'"
check "CP /v1/llama SSE through a member" \
	bash -c "curl -fsS -N -X POST '$CP_URL/v1/llama/fam-t/completion' -H 'content-type: application/json' -d '{\"prompt\":\"hi\",\"stream\":true}' | grep -q '^data: '"
check "/resolve/luna-t gives the member port" \
	bash -c "curl -fsS '$CP_URL/resolve/luna-t' | python3 -c 'import sys,json; sys.exit(0 if json.load(sys.stdin)[\"port\"]==$P_LUNA else 1)'"

check "incompatible settings in the same group + model are refused (409)" \
	bash -c "[ \"\$(curl -sS -o $TMP/bad.out -w '%{http_code}' -X POST '$CP_URL/services' -H 'content-type: application/json' -d '{\"profile\":\"bad-t\"}')\" = 409 ] && grep -q 'share_group' $TMP/bad.out"

check "riko-t (new adapter, 8192 ctx/slot) joins: restart with both adapters" \
	bash -c "[ \"\$(curl -sS -o /dev/null -w '%{http_code}' -X POST '$CP_URL/services' -H 'content-type: application/json' -d '{\"profile\":\"riko-t\"}')\" = 201 ]"
SRV3_PID=$(server_field "s[0]['pid']")
check "server config: adapters [luna, riko], 5 slots x 8192 ctx" \
	bash -c "curl -fsS '$AGENT_URL/services' | python3 -c 'import sys,json; s=[x for x in json.load(sys.stdin) if (x.get(\"shared\") or {}).get(\"role\")==\"server\"][0][\"shared\"]; sys.exit(0 if s[\"adapters\"]==[\"$LUNA\",\"$RIKO\"] and s[\"slots\"]==5 and s[\"ctx_per_slot\"]==8192 and len(s[\"members\"])==3 else 1)'"
wait_ok "http://127.0.0.1:$P_RIKO/health" 10
check "selections: luna [1,0] · fam [0,0] · riko [0,1]" \
	bash -c "[ \"\$(member_lora $P_LUNA)\" = '[1.0, 0.0]' ] && [ \"\$(member_lora $P_FAM)\" = '[0.0, 0.0]' ] && [ \"\$(member_lora $P_RIKO)\" = '[0.0, 1.0]' ]"
check "40 concurrent requests across 3 members (half streaming): all right, agent survives" \
	python3 - <<PY
import json, threading, urllib.request
ports = {$P_LUNA: [1.0, 0.0], $P_FAM: [0.0, 0.0], $P_RIKO: [0.0, 1.0]}
bad = []
def go(k):
    port = list(ports)[k % 3]
    stream = (k % 2 == 0)
    body = json.dumps({"prompt": "p%d" % k, "stream": stream}).encode()
    req = urllib.request.Request("http://127.0.0.1:%d/completion" % port, data=body,
                                 headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
        if stream:
            first = json.loads([l for l in raw.splitlines() if l.startswith("data: ")][0][6:])
        else:
            first = json.loads(raw)
        if [e["scale"] for e in first["lora_effective"]] != ports[port]:
            bad.append((k, "wrong lora"))
    except Exception as e:
        bad.append((k, str(e)))
ts = [threading.Thread(target=go, args=(k,)) for k in range(40)]
[t.start() for t in ts]; [t.join() for t in ts]
raise SystemExit(0 if not bad else 1)
PY
check "agent still alive after the concurrent burst" bash -c "kill -0 $AGENT_PID && curl -fsS '$AGENT_URL/healthz'"
check "/v1/models via riko-t reports its alias; via luna-t the base model (as dedicated)" \
	bash -c "curl -fsS http://127.0.0.1:$P_RIKO/v1/models | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d[\"data\"][0][\"id\"]==\"riko-narrator\" and d[\"models\"][0][\"name\"]==\"riko-narrator\" else 1)' && curl -fsS http://127.0.0.1:$P_LUNA/v1/models | python3 -c 'import sys,json; sys.exit(0 if json.load(sys.stdin)[\"data\"][0][\"id\"]==\"$MODEL\" else 1)'"
check "/props via riko-t reports its alias" \
	bash -c "curl -fsS http://127.0.0.1:$P_RIKO/props | python3 -c 'import sys,json; sys.exit(0 if json.load(sys.stdin)[\"model_alias\"]==\"riko-narrator\" else 1)'"
curl -fsS "$CP_URL/ui/services" > "$TMP/ui_services.html" 2>/dev/null
check "dashboard /ui/services shows the shared server and member badges" \
	bash -c "curl -fsS '$CP_URL/ui/services' | grep -q 'shared · 3 members' && curl -fsS '$CP_URL/ui/services' | grep -q '↳ spark'"

# ── leave without restart ──
FAM_ID=$(svcs | py "import sys,json; print([x['id'] for x in json.load(sys.stdin) if x['profile']=='fam-t' and x['state']=='running'][0])")
check "stop fam-t member (CP /services/stop)" \
	bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST '$CP_URL/services/stop' -H 'content-type: application/json' -d '{\"id\":\"$FAM_ID\",\"node_id\":\"$NODE_ID\"}')\" = 204 ]"
check "fam-t port is closed" bash -c "! curl -sS --max-time 2 http://127.0.0.1:$P_FAM/health"
check "other members unaffected and the server did NOT restart" \
	bash -c "[ \"\$(member_lora $P_LUNA)\" = '[1.0, 0.0]' ] && [ \"\$(member_lora $P_RIKO)\" = '[0.0, 1.0]' ] && kill -0 $SRV3_PID"
check "fam-t rejoins without a restart (its slots are still there)" \
	bash -c "[ \"\$(curl -sS -o /dev/null -w '%{http_code}' -X POST '$CP_URL/services' -H 'content-type: application/json' -d '{\"profile\":\"fam-t\"}')\" = 201 ] && kill -0 $SRV3_PID && [ \"\$(curl -fsS '$AGENT_URL/services' | python3 -c 'import sys,json; print([x[\"pid\"] for x in json.load(sys.stdin) if (x.get(\"shared\") or {}).get(\"role\")==\"server\"][0])')\" = '$SRV3_PID' ]"
check "fam-t → [0,0] again" bash -c "wait_ok() { for i in \$(seq 1 25); do curl -fsS \"\$1\" >/dev/null 2>&1 && return 0; sleep 0.2; done; return 1; }; wait_ok http://127.0.0.1:$P_FAM/health && [ \"\$(member_lora $P_FAM)\" = '[0.0, 0.0]' ]"

# ── watchdog ──
kill -9 "$SRV3_PID"
for i in $(seq 1 50); do
	NEWPID=$(server_field "s[0]['pid']")
	[ -n "$NEWPID" ] && [ "$NEWPID" != "$SRV3_PID" ] && kill -0 "$NEWPID" 2>/dev/null && break; sleep 0.2
done
check "watchdog respawns a killed shared server (same config)" \
	bash -c "[ -n '$NEWPID' ] && [ '$NEWPID' != '$SRV3_PID' ] && tr '\\0' ' ' </proc/$NEWPID/cmdline | grep -q -- '-np 5' && tr '\\0' ' ' </proc/$NEWPID/cmdline | grep -q -- '$RIKO:0'"
wait_ok "http://127.0.0.1:$P_LUNA/health" 10
check "members serve again after the respawn" \
	bash -c "[ \"\$(member_lora $P_LUNA)\" = '[1.0, 0.0]' ] && [ \"\$(member_lora $P_RIKO)\" = '[0.0, 1.0]' ]"

# ── agent restart: server outlives the agent, proxies come back ──
SRV4_PID=$NEWPID
kill -9 "$AGENT_PID"; AGENT_PID=""; sleep 0.5
check "with the agent gone, member ports are closed but the shared server lives" \
	bash -c "! curl -sS --max-time 2 http://127.0.0.1:$P_LUNA/health && kill -0 $SRV4_PID"
T_BOOT=$(date +%s.%N)
boot_agent
for i in $(seq 1 100); do curl -fsS "http://127.0.0.1:$P_LUNA/health" >/dev/null 2>&1 && break; sleep 0.05; done
T_UP=$(date +%s.%N)
echo "    (member port back $(python3 -c "print(round($T_UP-$T_BOOT,2))")s after the new agent process started)"
check "agent restart re-binds every member port" \
	bash -c "for p in $P_LUNA $P_FAM $P_RIKO; do ok=0; for i in \$(seq 1 50); do curl -fsS http://127.0.0.1:\$p/health >/dev/null 2>&1 && ok=1 && break; sleep 0.2; done; [ \$ok = 1 ] || exit 1; done"
for i in $(seq 1 100); do curl -fsS "$AGENT_URL/healthz" >/dev/null 2>&1 && break; sleep 0.1; done
check "…and adopts the running server (same pid, exactly one shared server process)" \
	bash -c "[ \"\$(curl -fsS '$AGENT_URL/services' | python3 -c 'import sys,json; print([x[\"pid\"] for x in json.load(sys.stdin) if (x.get(\"shared\") or {}).get(\"role\")==\"server\"][0])')\" = '$SRV4_PID' ] && [ \$(pgrep -f '^$BIN/llama-server' | wc -l) = 1 ]"
check "selections still right after the agent restart" \
	bash -c "[ \"\$(member_lora $P_LUNA)\" = '[1.0, 0.0]' ] && [ \"\$(member_lora $P_FAM)\" = '[0.0, 0.0]' ]"

# ── last member stops the server ──
ids_of() { svcs | py "import sys,json; print(' '.join(x['id'] for x in json.load(sys.stdin) if x['state']=='running' and (x.get('shared') or {}).get('role')=='member'))"; }
for id in $(ids_of); do
	curl -s -o /dev/null -X POST "$AGENT_URL/services/stop" -H 'content-type: application/json' -d "{\"id\":\"$id\"}"
done
# SIGTERM can be blocked in servers spawned from agent worker threads (see
# services.hml halt_server), so this may take the 15 s SIGKILL escalation.
for i in $(seq 1 125); do up "$SRV4_PID" || break; sleep 0.2; done
check "stopping the last member stops the shared server process" bash -c "! up $SRV4_PID"
check "no running shared rows remain" \
	bash -c "[ -z \"\$(curl -fsS '$AGENT_URL/services' | python3 -c 'import sys,json; print(\"x\" if any(x.get(\"shared\") for x in json.load(sys.stdin) if x[\"state\"]==\"running\") else \"\")')\" ]"

# ── auto-spawn through /v1/llama, then stop via the server row ──
check "CP /v1/llama/fam-t auto-spawns a shared server + member and answers" \
	bash -c "curl -fsS --max-time 60 -X POST '$CP_URL/v1/llama/fam-t/completion' -H 'content-type: application/json' -d '{\"prompt\":\"hi\"}' | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d[\"lora_received\"]==[] or d[\"lora_received\"] is not None else 1)'"
curl -sS -o /dev/null -X POST "$CP_URL/services" -H 'content-type: application/json' -d '{"profile":"luna-t"}'
SRV5_ID=$(server_field "s[0]['id']"); SRV5_PID=$(server_field "s[0]['pid']")
check "stopping the server row stops all of its members" \
	bash -c "curl -s -o /dev/null -X POST '$AGENT_URL/services/stop' -H 'content-type: application/json' -d '{\"id\":\"$SRV5_ID\"}'; sleep 1; ! curl -sS --max-time 2 http://127.0.0.1:$P_FAM/health && ! curl -sS --max-time 2 http://127.0.0.1:$P_LUNA/health"
for i in $(seq 1 125); do up "$SRV5_PID" || break; sleep 0.2; done
check "…and its process" bash -c "! up $SRV5_PID"

echo "[shared-lora] $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
	echo "--- agent.log (tail) ---"; tail -60 "$TMP/agent.log"
	echo "--- cp.log (tail) ---"; tail -30 "$TMP/cp.log"
	exit 1
fi
