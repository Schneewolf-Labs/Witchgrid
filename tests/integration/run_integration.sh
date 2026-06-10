#!/usr/bin/env bash
# Witchgrid integration harness — boots a real CP + agent and drives the
# control-plane flows end to end, with a fake llama-server (no GPU/model
# needed) standing in for the inference backend. Covers what the pure-unit
# tests can't: registration round-trip, spawn + health-gating, /resolve,
# the /v1/llama proxy, and SSE passthrough.
#
# Usage (from repo root, after the binaries are built):
#   cp/witchgrid-cp and agent/witchgrid-agent must exist.
#   bash tests/integration/run_integration.sh
#
# Exits non-zero if any assertion fails (CI gate). Self-contained: temp
# data dirs, fake binary on a private PATH, full teardown on exit.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CP_BIN="${CP_BIN:-$ROOT/cp/witchgrid-cp}"
AGENT_BIN="${AGENT_BIN:-$ROOT/agent/witchgrid-agent}"
FAKE="$ROOT/tests/integration/fake_llama_server.py"
MODEL="$ROOT/tests/fixtures/nemo_llama.gguf"   # a valid GGUF for any metadata read

CP_PORT="${CP_PORT:-8765}"                      # default bind (override: CP_PORT=… to dodge a live CP)
AGENT_PORT="${AGENT_PORT:-8766}"
NODE_ID="test-agent"
SVC_PORT=18950
HEARTBEAT_SECS=1                                # fast agent heartbeat (liveness tests)
STALE_SECS=4                                    # CP evicts a silent node after ~4x heartbeat
CP_URL="http://127.0.0.1:${CP_PORT}"
AGENT_URL="http://127.0.0.1:${AGENT_PORT}"
AGENT2_PORT="${AGENT2_PORT:-8767}"             # 2nd agent for the multi-node test (#2)
NODE_ID2="test-agent-2"
AGENT2_URL="http://127.0.0.1:${AGENT2_PORT}"

TMP="$(mktemp -d)"
BIN="$TMP/bin"; mkdir -p "$BIN" "$TMP/cp" "$TMP/agent" "$TMP/models"
cp "$FAKE" "$BIN/llama-server"; chmod +x "$BIN/llama-server"

CP_PID=""; AGENT_PID=""; AGENT2_PID=""
cleanup() {
	[ -n "$AGENT2_PID" ] && kill -9 "$AGENT2_PID" 2>/dev/null
	[ -n "$AGENT_PID" ] && kill -9 "$AGENT_PID" 2>/dev/null
	[ -n "$CP_PID" ] && kill -9 "$CP_PID" 2>/dev/null
	# the agent posix_spawn'd the fake (setsid) — it outlives the agent
	for p in $(pgrep -f "$BIN/llama-server" 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
	rm -rf "$TMP"
}
trap cleanup EXIT

PASS=0; FAIL=0
check() {  # check "desc" <test-cmd...>
	local desc="$1"; shift
	if "$@" >/dev/null 2>&1; then echo "  ✓ $desc"; PASS=$((PASS+1));
	else echo "  ✗ $desc"; FAIL=$((FAIL+1)); fi
}
# Pre-flight: a stale CP squatting on 8765 would make our checks silently
# hit the wrong process (its agent is gone → spawns fail). Fail fast.
if curl -fsS "$CP_URL/healthz" >/dev/null 2>&1; then
	echo "[integration] ERROR: $CP_URL already serving — stale CP? Free port $CP_PORT and retry."
	exit 1
fi

echo "[integration] booting CP ($CP_URL)…"
( cd "$TMP/cp" && WITCHGRID_DATA_DIR="$TMP/cp" WITCHGRID_STALE_NODE_SECONDS="$STALE_SECS" WITCHGRID_CP_PORT="$CP_PORT" "$CP_BIN" ) >"$TMP/cp.log" 2>&1 &
CP_PID=$!; disown "$CP_PID" 2>/dev/null || true
for i in $(seq 1 30); do curl -fsS "$CP_URL/healthz" >/dev/null 2>&1 && break; sleep 0.3; done
if ! curl -fsS "$CP_URL/healthz" >/dev/null 2>&1; then
	echo "[integration] ERROR: CP never answered /healthz"; echo "--- cp.log ---"; cat "$TMP/cp.log"; exit 1
fi

echo "[integration] booting agent ($AGENT_URL, fake llama-server on PATH)…"
# HOME=$TMP isolates the agent from any real Witchgrid install on this host:
# current_binary_path() looks under $HOME/.witchgrid/llama-server, so an
# empty temp HOME forces the bare-name PATH lookup → our fake. (On a clean
# CI runner there's no install anyway; this just makes it work locally too.)
PATH="$BIN:$PATH" \
	HOME="$TMP" \
	WITCHGRID_CP_URL="$CP_URL" \
	WITCHGRID_AGENT_URL="$AGENT_URL" \
	WITCHGRID_AGENT_PORT="$AGENT_PORT" \
	WITCHGRID_NODE_ID="$NODE_ID" \
	WITCHGRID_DATA_DIR="$TMP/agent" \
	WITCHGRID_MODEL_DIR="$TMP/models" \
		WITCHGRID_HEARTBEAT_SECONDS="$HEARTBEAT_SECS" \
	"$AGENT_BIN" >"$TMP/agent.log" 2>&1 &
AGENT_PID=$!; disown "$AGENT_PID" 2>/dev/null || true
# wait for the node to register with the CP
for i in $(seq 1 30); do
	curl -fsS "$CP_URL/nodes" 2>/dev/null | grep -q "$NODE_ID" && break; sleep 0.3
done

echo "[integration] assertions:"

check "CP /healthz ok" \
	bash -c "curl -fsS '$CP_URL/healthz' | python3 -c 'import sys,json; sys.exit(0 if json.load(sys.stdin).get(\"status\")==\"ok\" else 1)'"

# version single-source-of-truth, surfaced in /healthz + /metrics
check "/healthz reports a version" \
	bash -c "curl -fsS '$CP_URL/healthz' | python3 -c 'import sys,json; sys.exit(0 if json.load(sys.stdin).get(\"version\") else 1)'"

check "/metrics exposes witchgrid_build_info" \
	bash -c "curl -fsS '$CP_URL/metrics' | grep -q '^witchgrid_build_info{version='"

check "agent registered + /nodes reflects it" \
	bash -c "curl -fsS '$CP_URL/nodes' | python3 -c 'import sys,json; ns=json.load(sys.stdin); sys.exit(0 if any(n[\"node_id\"]==\"$NODE_ID\" for n in ns) else 1)'"

check "node reports auto_restart (watchdog) state" \
	bash -c "curl -fsS '$CP_URL/nodes' | python3 -c 'import sys,json; ns=json.load(sys.stdin); n=[x for x in ns if x[\"node_id\"]==\"$NODE_ID\"][0]; sys.exit(0 if n.get(\"auto_restart\") in (True,False) else 1)'"

# /events is the live-state SSE stream the dashboard consumes. It must emit
# an initial 'event: state' snapshot frame on connect. The stream never ends,
# so we time-box curl and capture (not pipe — the timeout exit would trip
# pipefail) then grep the body.
check "/events SSE emits an initial state frame" \
	bash -c "out=\$(curl -sN --max-time 4 '$CP_URL/events'); echo \"\$out\" | grep -q '^event: state'"

check "spawn a service (designer-cpu, fake backend) via POST /services" \
	bash -c "curl -fsS -X POST '$CP_URL/services' -H 'content-type: application/json' -d '{\"profile\":\"designer-cpu\",\"node_id\":\"$NODE_ID\",\"model\":\"$MODEL\",\"port\":$SVC_PORT}' | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get(\"pid\") else 1)'"

check "/resolve/designer-cpu returns the running service base_url" \
	bash -c "curl -fsS '$CP_URL/resolve/designer-cpu' | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get(\"port\")==$SVC_PORT else 1)'"

check "the spawned backend answers /health" \
	bash -c "curl -fsS 'http://127.0.0.1:$SVC_PORT/health' | python3 -c 'import sys,json; sys.exit(0 if json.load(sys.stdin).get(\"status\")==\"ok\" else 1)'"

# /api/state is the one-shot snapshot the health banner paints from (same
# shape /events streams). Must report nodes + services, each service tagged
# with alive + state (running/failed) so the banner can triage.
check "/api/state snapshot reports services with alive + state" \
	bash -c "curl -fsS '$CP_URL/api/state' | python3 -c 'import sys,json; d=json.load(sys.stdin); svc=d.get(\"services\",[]); sys.exit(0 if isinstance(d.get(\"nodes\"),list) and any(s.get(\"state\")==\"running\" and s.get(\"alive\") for s in svc) else 1)'"

# /api/ready is the spawn-progress probe: reports a running service's health
# (ready=true once it answers /health) so the UI shows loading → ready.
check "/api/ready reports the spawned service ready" \
	bash -c "curl -fsS '$CP_URL/api/ready/designer-cpu' | python3 -c 'import sys,json; sys.exit(0 if json.load(sys.stdin).get(\"ready\")==True else 1)'"

# Guided-wizard contract: the freeform profile JSON the wizard builds (with
# default_device + intent) must round-trip through POST /api/profiles. (Spawn-
# ability of freeform CP profiles is already covered by the seeded-profile
# spawn tests above; we don't re-spawn here to avoid leaving a service the
# fast-heartbeat watchdog would churn on.)
check "API-created freeform profile round-trips (wizard create contract)" \
	bash -c "curl -fsS -X POST '$CP_URL/api/profiles' -H 'content-type: application/json' -d '{\"name\":\"wiz-it\",\"profile\":{\"binary\":\"llama-server\",\"intent\":{\"context\":4096,\"gpu_layers\":0},\"extra_flags\":[\"--jinja\"],\"default_port\":18098,\"context\":4096,\"kv_type\":\"q4_0\",\"default_device\":\"cpu\",\"default_model\":\"$MODEL\"}}' >/dev/null && curl -fsS '$CP_URL/api/profiles/wiz-it' | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get(\"binary\")==\"llama-server\" and d.get(\"default_device\")==\"cpu\" and d.get(\"intent\",{}).get(\"gpu_layers\")==0 and \"--jinja\" in d.get(\"extra_flags\",[]) else 1)'"

check "non-stream /v1/llama proxy returns JSON" \
	bash -c "curl -fsS -X POST '$CP_URL/v1/llama/designer-cpu/completion' -H 'content-type: application/json' -d '{\"prompt\":\"hi\",\"n_predict\":4}' | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if \"content\" in d else 1)'"

check "SSE /v1/llama proxy streams text/event-stream data: frames" \
	bash -c "curl -fsS --no-buffer -X POST '$CP_URL/v1/llama/designer-cpu/completion' -H 'content-type: application/json' -d '{\"prompt\":\"hi\",\"stream\":true}' | grep -q '^data: '"

# ── robustness assertions (lock in v0.8.0 behavior; test-cases-todo.md) ──

# #10: a node's role and its hardware.gpus must agree — cpu ⇒ no GPUs, gpu ⇒ ≥1.
# Portable across a CPU-only CI runner and a real GPU box.
check "node role is consistent with hardware.gpus (#10)" \
	bash -c "curl -fsS '$CP_URL/nodes' | python3 -c 'import sys,json; n=[x for x in json.load(sys.stdin) if x[\"node_id\"]==\"$NODE_ID\"][0]; r=n.get(\"role\"); g=n.get(\"hardware\",{}).get(\"gpus\"); sys.exit(0 if r in (\"cpu\",\"gpu\") and isinstance(g,list) and ((g==[]) if r==\"cpu\" else len(g)>0) else 1)'"

# #7: auto-spawn via the proxy must refuse cleanly (503) when the profile has no
# resolvable model (default_model null + alias not in any catalog), not hang/500.
check "auto-spawn refuses with 503 when no model is resolvable (#7)" \
	bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST '$CP_URL/v1/llama/memory-phoenix/completion' -H 'content-type: application/json' -d '{\"prompt\":\"hi\"}')\" = '503' ]"

# #1: a model path unreadable from the CP must return 422 (not crash the CP).
# Assert the 422 AND that the CP is still answering afterwards.
check "unreadable model path returns 422 and CP survives (#1)" \
	bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST '$CP_URL/services' -H 'content-type: application/json' -d '{\"profile\":\"memory-phoenix\",\"node_id\":\"$NODE_ID\",\"model\":\"/nonexistent/nope.gguf\",\"port\":18960}')\" = '422' ] && curl -fsS '$CP_URL/healthz' >/dev/null"

# #19: spawning onto an OS-occupied port — the backend can't bind and dies within
# the grace window — must surface as a 502 'spawn died immediately', not a false
# 201 that leaves the CP routing at a dead service.
python3 -c "import socket,time; s=socket.socket(); s.bind(('0.0.0.0',18961)); s.listen(1); time.sleep(20)" & SQ=$!; sleep 0.5
check "spawn onto an OS-occupied port surfaces 502, not false success (#19)" \
	bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST '$CP_URL/services' -H 'content-type: application/json' -d '{\"profile\":\"memory-phoenix\",\"node_id\":\"$NODE_ID\",\"model\":\"$MODEL\",\"port\":18961}')\" = '502' ]"
kill "$SQ" 2>/dev/null; wait "$SQ" 2>/dev/null

# #17: with the profile's default_port (18085) held by a foreign process, an
# auto-port spawn (no explicit port) must detect the OS-level contention and pick
# the next free port — and the backend must actually come up there.
python3 -c "import socket,time; s=socket.socket(); s.bind(('0.0.0.0',18085)); s.listen(1); time.sleep(20)" & SQ2=$!; sleep 0.5
check "auto-port spawn avoids an OS-occupied default_port (#17)" \
	bash -c "curl -fsS -X POST '$CP_URL/services' -H 'content-type: application/json' -d '{\"profile\":\"memory-phoenix\",\"node_id\":\"$NODE_ID\",\"model\":\"$MODEL\"}' | python3 -c 'import sys,json; d=json.load(sys.stdin); p=d.get(\"port\"); sys.exit(0 if d.get(\"pid\") and p and p!=18085 else 1)'"
kill "$SQ2" 2>/dev/null; wait "$SQ2" 2>/dev/null

# device toggle: the first-class CPU/GPU override. Forcing a GPU profile
# (chat-mahou, gpu_layers 99) onto CPU must place + spawn regardless of GPUs
# and report device=cpu. Portable: on a CPU-only runner chat-mahou would
# otherwise 503 (no GPU); device=cpu is exactly what makes it run.
check "device=cpu forces a GPU profile onto CPU (first-class toggle)" \
	bash -c "curl -fsS -X POST '$CP_URL/services' -H 'content-type: application/json' -d '{\"profile\":\"chat-mahou\",\"node_id\":\"$NODE_ID\",\"model\":\"$MODEL\",\"device\":\"cpu\",\"port\":18805}' | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get(\"pid\") and d.get(\"device\")==\"cpu\" else 1)'"

check "invalid device value is rejected with 400" \
	bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST '$CP_URL/services' -H 'content-type: application/json' -d '{\"profile\":\"designer-cpu\",\"node_id\":\"$NODE_ID\",\"model\":\"$MODEL\",\"device\":\"banana\",\"port\":18806}')\" = '400' ]"

# #4: a live agent's heartbeat must keep advancing its last_seen_at. Snapshot,
# then poll until it moves forward (cadence forced fast via
# WITCHGRID_HEARTBEAT_SECONDS, but each beat refreshes hardware so real spacing
# jitters — poll-until rather than a fixed sleep). ISO 'YYYY-MM-DD HH:MM:SS'
# compares lexicographically = chronologically.
node_last_seen() { curl -fsS "$CP_URL/nodes" | python3 -c 'import sys,json; n=[x for x in json.load(sys.stdin) if x["node_id"]=="'"$NODE_ID"'"][0]; print(n.get("last_seen_at",""))'; }
LS1=$(node_last_seen)
HB_ADVANCED=0
for _ in $(seq 1 20); do
	LS2=$(node_last_seen)
	if [ -n "$LS2" ] && [ "$LS2" \> "$LS1" ]; then HB_ADVANCED=1; break; fi
	sleep 1
done
check "heartbeat advances the node's last_seen_at (#4)" \
	bash -c "[ $HB_ADVANCED -eq 1 ]"

# #2: multi-node registration integrity. Boot a SECOND agent (distinct node_id +
# agent_url); the CP must keep them separate — each node carries the agent_url WE
# gave it (the bug this guards swapped one box's hardware onto another box's
# agent_url) and its own populated hardware block. Both agents probe the same
# host here, so this asserts identity/round-trip integrity, not cross-box
# hardware difference (that would need a mocked nvidia-smi — tracked follow-up).
PATH="$BIN:$PATH" HOME="$TMP" \
	WITCHGRID_CP_URL="$CP_URL" WITCHGRID_AGENT_URL="$AGENT2_URL" \
	WITCHGRID_AGENT_PORT="$AGENT2_PORT" WITCHGRID_NODE_ID="$NODE_ID2" \
	WITCHGRID_DATA_DIR="$TMP/agent2" WITCHGRID_MODEL_DIR="$TMP/models" \
	WITCHGRID_HEARTBEAT_SECONDS="$HEARTBEAT_SECS" \
	"$AGENT_BIN" >"$TMP/agent2.log" 2>&1 &
AGENT2_PID=$!; disown "$AGENT2_PID" 2>/dev/null || true
for _ in $(seq 1 30); do curl -fsS "$CP_URL/nodes" 2>/dev/null | grep -q "$NODE_ID2" && break; sleep 0.3; done

check "both agents register as distinct nodes (#2)" \
	bash -c "curl -fsS '$CP_URL/nodes' | python3 -c 'import sys,json; ids={n[\"node_id\"] for n in json.load(sys.stdin)}; sys.exit(0 if {\"$NODE_ID\",\"$NODE_ID2\"} <= ids else 1)'"

check "each node round-trips its own agent_url + hardware, no swap (#2)" \
	bash -c "curl -fsS '$CP_URL/nodes' | python3 -c 'import sys,json; ns={n[\"node_id\"]:n for n in json.load(sys.stdin)}; a=ns.get(\"$NODE_ID\"); b=ns.get(\"$NODE_ID2\"); sys.exit(0 if (a and b and a[\"agent_url\"]==\"$AGENT_URL\" and b[\"agent_url\"]==\"$AGENT2_URL\" and a.get(\"hardware\",{}).get(\"cpu_cores\",0)>0 and b.get(\"hardware\",{}).get(\"cpu_cores\",0)>0) else 1)'"

# stop the 2nd agent so the #3 staleness test runs against a clean fleet.
kill -9 "$AGENT2_PID" 2>/dev/null; AGENT2_PID=""

# #3: a silenced agent must drop out of live placement after STALE_NODE_SECONDS
# (forced short here). Kill the agent to stop heartbeats, wait past the cutoff,
# then: a spawn aimed at it is refused (503, not "spawned on a dead agent"),
# /metrics reports node_up=0 (the cutoff fired), and /nodes still lists it
# (visibility-only — soft-delete philosophy). This MUST be the last block: it
# tears down the agent.
kill -9 "$AGENT_PID" 2>/dev/null; AGENT_PID=""
sleep $((STALE_SECS + 2))
check "spawn aimed at a downed agent is refused (503), not falsely spawned (#3)" \
	bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST '$CP_URL/services' -H 'content-type: application/json' -d '{\"profile\":\"designer-cpu\",\"node_id\":\"$NODE_ID\",\"model\":\"$MODEL\",\"port\":18970}')\" = '503' ]"
check "downed node is node_up=0 in /metrics yet still listed in /nodes (#3)" \
	bash -c "curl -fsS '$CP_URL/nodes' | python3 -c 'import sys,json; sys.exit(0 if any(n[\"node_id\"]==\"$NODE_ID\" for n in json.load(sys.stdin)) else 1)' && curl -fsS '$CP_URL/metrics' | grep -q 'witchgrid_node_up{node=\"$NODE_ID\"} 0'"

echo "[integration] $PASS passed, $FAIL failed"
if [ "$FAIL" -ne 0 ]; then
	echo "--- cp.log (tail) ---"; tail -n 20 "$TMP/cp.log"
	echo "--- agent.log (tail) ---"; tail -n 20 "$TMP/agent.log"
	exit 1
fi
