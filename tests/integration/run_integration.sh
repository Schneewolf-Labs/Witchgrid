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

CP_PORT=8765                                    # CP binds 8765 (not yet env-configurable)
AGENT_PORT=8766
NODE_ID="test-agent"
SVC_PORT=18950
CP_URL="http://127.0.0.1:${CP_PORT}"
AGENT_URL="http://127.0.0.1:${AGENT_PORT}"

TMP="$(mktemp -d)"
BIN="$TMP/bin"; mkdir -p "$BIN" "$TMP/cp" "$TMP/agent" "$TMP/models"
cp "$FAKE" "$BIN/llama-server"; chmod +x "$BIN/llama-server"

CP_PID=""; AGENT_PID=""
cleanup() {
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
( cd "$TMP/cp" && WITCHGRID_DATA_DIR="$TMP/cp" "$CP_BIN" ) >"$TMP/cp.log" 2>&1 &
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
	"$AGENT_BIN" >"$TMP/agent.log" 2>&1 &
AGENT_PID=$!; disown "$AGENT_PID" 2>/dev/null || true
# wait for the node to register with the CP
for i in $(seq 1 30); do
	curl -fsS "$CP_URL/nodes" 2>/dev/null | grep -q "$NODE_ID" && break; sleep 0.3
done

echo "[integration] assertions:"

check "CP /healthz ok" \
	bash -c "curl -fsS '$CP_URL/healthz' | python3 -c 'import sys,json; sys.exit(0 if json.load(sys.stdin).get(\"status\")==\"ok\" else 1)'"

check "agent registered + /nodes reflects it" \
	bash -c "curl -fsS '$CP_URL/nodes' | python3 -c 'import sys,json; ns=json.load(sys.stdin); sys.exit(0 if any(n[\"node_id\"]==\"$NODE_ID\" for n in ns) else 1)'"

check "node reports auto_restart (watchdog) state" \
	bash -c "curl -fsS '$CP_URL/nodes' | python3 -c 'import sys,json; ns=json.load(sys.stdin); n=[x for x in ns if x[\"node_id\"]==\"$NODE_ID\"][0]; sys.exit(0 if n.get(\"auto_restart\") in (True,False) else 1)'"

check "spawn a service (designer-cpu, fake backend) via POST /services" \
	bash -c "curl -fsS -X POST '$CP_URL/services' -H 'content-type: application/json' -d '{\"profile\":\"designer-cpu\",\"node_id\":\"$NODE_ID\",\"model\":\"$MODEL\",\"port\":$SVC_PORT}' | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get(\"pid\") else 1)'"

check "/resolve/designer-cpu returns the running service base_url" \
	bash -c "curl -fsS '$CP_URL/resolve/designer-cpu' | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get(\"port\")==$SVC_PORT else 1)'"

check "the spawned backend answers /health" \
	bash -c "curl -fsS 'http://127.0.0.1:$SVC_PORT/health' | python3 -c 'import sys,json; sys.exit(0 if json.load(sys.stdin).get(\"status\")==\"ok\" else 1)'"

check "non-stream /v1/llama proxy returns JSON" \
	bash -c "curl -fsS -X POST '$CP_URL/v1/llama/designer-cpu/completion' -H 'content-type: application/json' -d '{\"prompt\":\"hi\",\"n_predict\":4}' | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if \"content\" in d else 1)'"

check "SSE /v1/llama proxy streams text/event-stream data: frames" \
	bash -c "curl -fsS --no-buffer -X POST '$CP_URL/v1/llama/designer-cpu/completion' -H 'content-type: application/json' -d '{\"prompt\":\"hi\",\"stream\":true}' | grep -q '^data: '"

echo "[integration] $PASS passed, $FAIL failed"
if [ "$FAIL" -ne 0 ]; then
	echo "--- cp.log (tail) ---"; tail -n 20 "$TMP/cp.log"
	echo "--- agent.log (tail) ---"; tail -n 20 "$TMP/agent.log"
	exit 1
fi
