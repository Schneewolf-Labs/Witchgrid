#!/usr/bin/env bash
# Shared-base LoRA serving — opt-in real-model check (GPU + GGUFs required;
# not run in CI). Boots a CP + agent on test ports with a REAL llama-server,
# creates three sharing profiles over one base (LoRA A, LoRA B, no LoRA) and
# runs tests/gpu/shared_lora_gpu.py: output equivalence vs dedicated servers,
# KV/prompt-cache safety across adapters, concurrency, VRAM.
#
#   BASE_GGUF=~/AI/gguf_models/b4/B4-9B-noMTP-Q8_0.gguf \
#   LORA_A=~/AI/loras/riko/Riko-9B-distill-A-f16.gguf \
#   LORA_B=~/AI/loras/Familiar-9B-luna-F2-f16.gguf \
#   LLAMA_SERVER=~/AI/llama.cpp/build/bin/llama-server \
#   CP_PORT=8865 AGENT_PORT=8866 WG_GPU=0 bash tests/gpu/run_shared_lora_gpu.sh
#
# Needs ~3 base copies of VRAM at peak (shared server + two dedicated
# comparison servers in the concurrency step). Uses ports 18951-18953
# (members), 18970+ (shared), 18961-18962 (reference servers); kills only
# what it started.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${BASE_GGUF:?set BASE_GGUF}" "${LORA_A:?set LORA_A}" "${LORA_B:?set LORA_B}"
LLAMA_SERVER="${LLAMA_SERVER:-$(command -v llama-server)}"
CP_PORT="${CP_PORT:-8865}"; AGENT_PORT="${AGENT_PORT:-8866}"
CP_URL="http://127.0.0.1:$CP_PORT"; AGENT_URL="http://127.0.0.1:$AGENT_PORT"
NODE_ID="gpu-share-agent"; WG_GPU="${WG_GPU:-0}"
P_A=18951; P_B=18952; P_BASE=18953
CTX="${CTX:-8192}"; NP="${NP:-2}"

TMP="$(mktemp -d)"; mkdir -p "$TMP/bin" "$TMP/cp" "$TMP/agent" "$TMP/models"
ln -s "$LLAMA_SERVER" "$TMP/bin/llama-server"
CP_PID=""; AGENT_PID=""
cleanup() {
	# members/servers first, through the API (the agent owns them)
	if [ -n "$AGENT_PID" ]; then
		local rows; rows=$(curl -fsS "$AGENT_URL/services" 2>/dev/null | python3 -c 'import sys,json; print(" ".join(x["id"]+":"+str(x["pid"]) for x in json.load(sys.stdin) if (x.get("shared") or {}).get("role")=="server"))' 2>/dev/null)
		for r in $rows; do
			curl -s -o /dev/null -X POST "$AGENT_URL/services/stop" -H 'content-type: application/json' -d "{\"id\":\"${r%%:*}\"}"
			# SIGTERM may be blocked in agent-spawned servers (see services.hml
			# halt_server); this pid is one this run's agent started.
			sleep 1; kill -9 "${r##*:}" 2>/dev/null
		done
		kill "$AGENT_PID" 2>/dev/null
	fi
	[ -n "$CP_PID" ] && kill "$CP_PID" 2>/dev/null
	echo "[gpu] logs kept in $TMP"
}
trap cleanup EXIT

( cd "$TMP/cp" && exec env WITCHGRID_DATA_DIR="$TMP/cp" WITCHGRID_CP_PORT="$CP_PORT" "$ROOT/cp/witchgrid-cp" ) >"$TMP/cp.log" 2>&1 &
CP_PID=$!
for i in $(seq 1 30); do curl -fsS "$CP_URL/healthz" >/dev/null 2>&1 && break; sleep 0.3; done
PATH="$TMP/bin:$PATH" HOME="$TMP" WITCHGRID_CP_URL="$CP_URL" WITCHGRID_AGENT_URL="$AGENT_URL" \
	WITCHGRID_AGENT_PORT="$AGENT_PORT" WITCHGRID_NODE_ID="$NODE_ID" WITCHGRID_DATA_DIR="$TMP/agent" \
	WITCHGRID_MODEL_DIR="$TMP/models" WITCHGRID_HEARTBEAT_SECONDS=5 WITCHGRID_SHARED_PORT_BASE=18970 \
	"$ROOT/agent/witchgrid-agent" >"$TMP/agent.log" 2>&1 &
AGENT_PID=$!
for i in $(seq 1 60); do curl -fsS "$CP_URL/nodes" 2>/dev/null | grep -q "$NODE_ID" && break; sleep 0.5; done

mk() {  # name port lora-json-or-null
	local lora=""; [ "$3" != "null" ] && lora=",\"lora\":\"$3\""
	curl -fsS -X POST "$CP_URL/api/profiles" -H 'content-type: application/json' -d "{\"name\":\"$1\",\"profile\":{\"binary\":\"llama-server\",\"share_group\":\"gpu-test\",\"intent\":{\"context\":$CTX,\"parallel_slots\":$NP,\"gpu_layers\":99,\"flash_attention\":true},\"extra_flags\":[\"--jinja\"],\"default_port\":$2,\"context\":$CTX,\"kv_type\":\"f16\",\"default_model\":\"$BASE_GGUF\"$lora}}" >/dev/null
}
mk wg-a "$P_A" "$LORA_A"; mk wg-b "$P_B" "$LORA_B"; mk wg-base "$P_BASE" null

LLAMA_SERVER="$LLAMA_SERVER" BASE_GGUF="$BASE_GGUF" LORA_A="$LORA_A" LORA_B="$LORA_B" \
	CP_URL="$CP_URL" NODE_ID="$NODE_ID" WG_GPU="$WG_GPU" MEMBER_PORTS="$P_A,$P_B,$P_BASE" \
	CTX="$CTX" NP="$NP" OUT="$TMP/results.json" LOGDIR="$TMP" \
	python3 "$ROOT/tests/gpu/shared_lora_gpu.py"
RC=$?
echo "[gpu] raw results: $TMP/results.json"
exit $RC
