#!/usr/bin/env bash
# Witchgrid integration test: measured VRAM, pins, the declarative layout
# API (GET /api/layout, POST /api/layout/plan|apply, MCP tools), verified
# stop, the clean signal mask of spawned services, and stale-but-served
# GET /services — with a real CP + agent, the fake llama-server and a fake
# nvidia-smi (4 × 16380 MB GPUs; a fake server "holds" --fake-vram MB split
# over its CUDA_VISIBLE_DEVICES). No GPU or model needed.
#
# The fleet is a scaled-down replay of schneewolf on 2026-11-15: from
#   GPU0 niku + luna(1/4) + voice | GPU1 luna(1/4) + mahou(1/2)
#   GPU2 luna(1/4) + mahou(1/2)    | GPU3 luna(1/4) + familiar
# to one main service per card:
#   GPU0 luna + voice | GPU1 riko | GPU2 mahou (patched) | GPU3 familiar + niku
#
# Usage (repo root, binaries built):
#   CP_PORT=8865 AGENT_PORT=8866 bash tests/integration/run_layout.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CP_BIN="${CP_BIN:-$ROOT/cp/witchgrid-cp}"
AGENT_BIN="${AGENT_BIN:-$ROOT/agent/witchgrid-agent}"
MODEL="$ROOT/tests/fixtures/nemo_llama.gguf"
CP_PORT="${CP_PORT:-8865}"
AGENT_PORT="${AGENT_PORT:-8866}"
CP_URL="http://127.0.0.1:${CP_PORT}"
AGENT_URL="http://127.0.0.1:${AGENT_PORT}"
NODE_ID="layout-node"
CAP=16380; MARGIN=512; USABLE=$((CAP - MARGIN))
# service ports (all > 18900, clear of anything live on this box)
P_NIKU=18931; P_LUNA=18932; P_VOICE=18933; P_MAHOU=18934; P_FAM=18935; P_RIKO=18936; P_STUB=18937

TMP="$(mktemp -d)"
BIN="$TMP/bin"; mkdir -p "$BIN" "$TMP/cp" "$TMP/agent" "$TMP/models"
cp "$ROOT/tests/integration/fake_llama_server.py" "$BIN/llama-server"; chmod +x "$BIN/llama-server"
cp "$ROOT/tests/integration/fake_nvidia_smi.py" "$BIN/nvidia-smi"; chmod +x "$BIN/nvidia-smi"
# hide any real AMD GPUs on the test box (the agent probes rocm-smi too)
printf '#!/bin/sh\nexit 1\n' > "$BIN/rocm-smi"; chmod +x "$BIN/rocm-smi"

CP_PID=""; AGENT_PID=""
cleanup() {
	[ -n "$AGENT_PID" ] && kill -9 "$AGENT_PID" 2>/dev/null
	[ -n "$CP_PID" ] && kill -9 "$CP_PID" 2>/dev/null
	# fake servers the agent spawned (setsid, they outlive it): only ours —
	# their argv carries this run's private $BIN path.
	for p in $(pgrep -f "$BIN/llama-server" 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
	rm -rf "$TMP"
}
trap cleanup EXIT

PASS=0; FAIL=0
check() {
	local desc="$1"; shift
	if "$@" >/dev/null 2>&1; then echo "  ✓ $desc"; PASS=$((PASS+1));
	else echo "  ✗ $desc"; FAIL=$((FAIL+1)); fi
}
py() { python3 -c "$1"; }

if curl -fsS "$CP_URL/healthz" >/dev/null 2>&1; then
	echo "[layout] ERROR: $CP_URL already serving; pick another CP_PORT"; exit 1
fi
if curl -fsS "$AGENT_URL/healthz" >/dev/null 2>&1; then
	echo "[layout] ERROR: $AGENT_URL already serving; pick another AGENT_PORT"; exit 1
fi

( cd "$TMP/cp" && exec env WITCHGRID_DATA_DIR="$TMP/cp" WITCHGRID_STALE_NODE_SECONDS=20 \
	WITCHGRID_MEASURE_MIN_UPTIME_S=1 WITCHGRID_CP_PORT="$CP_PORT" "$CP_BIN" ) >"$TMP/cp.log" 2>&1 &
CP_PID=$!; disown "$CP_PID" 2>/dev/null || true
for i in $(seq 1 30); do curl -fsS "$CP_URL/healthz" >/dev/null 2>&1 && break; sleep 0.3; done

boot_agent() {
	PATH="$BIN:$PATH" HOME="$TMP" \
		WITCHGRID_CP_URL="$CP_URL" WITCHGRID_AGENT_URL="$AGENT_URL" \
		WITCHGRID_AGENT_PORT="$AGENT_PORT" WITCHGRID_NODE_ID="$NODE_ID" \
		WITCHGRID_DATA_DIR="$TMP/agent" WITCHGRID_MODEL_DIR="$TMP/models" \
		WITCHGRID_HEARTBEAT_SECONDS=1 WITCHGRID_LOCAL_SERVICES="$TMP/no-local" \
		WITCHGRID_SHARED_PORT_BASE=18960 \
		FAKE_SMI_MATCH="$BIN/llama-server" FAKE_GPU_OVERHEAD_MB=100 \
		"$AGENT_BIN" >>"$TMP/agent.log" 2>&1 &
	AGENT_PID=$!; disown "$AGENT_PID" 2>/dev/null || true
	for i in $(seq 1 50); do curl -fsS "$AGENT_URL/healthz" >/dev/null 2>&1 && break; sleep 0.2; done
}
boot_agent
for i in $(seq 1 30); do curl -fsS "$CP_URL/nodes" 2>/dev/null | grep -q "$NODE_ID" && break; sleep 0.3; done

mkprofile() {  # name port vram [extra json fields] — create, or replace a seeded default
	local prof='{"binary":"llama-server","intent":{"context":4096,"gpu_layers":99},"extra_flags":["--fake-vram","'"$3"'"],"default_port":'"$2"',"context":4096,"kv_type":"f16","default_model":"'"$MODEL"'"'"${4:-}"'}'
	curl -s -o /dev/null -X POST "$CP_URL/api/profiles" -H 'content-type: application/json' -d '{"name":"'"$1"'","profile":'"$prof"'}'
	curl -fsS -o /dev/null -X PUT "$CP_URL/api/profiles/$1" -H 'content-type: application/json' -d "$prof"
}
spawn() {  # profile gpus-json port
	curl -fsS -X POST "$CP_URL/services" -H 'content-type: application/json' \
		-d '{"profile":"'"$1"'","node_id":"'"$NODE_ID"'","gpus":'"$2"',"port":'"$3"'}'
}
svc_field() {  # profile field  → from CP /services
	curl -fsS "$CP_URL/services" | py "import sys,json; s=[x for x in json.load(sys.stdin) if x.get('profile')=='$1' and x.get('state','running')=='running']; print(json.dumps(s[0]['$2']) if s else '')"
}

echo "[layout] building the morning fleet…"
mkprofile image-niku $P_NIKU 4450
mkprofile luna-spark $P_LUNA 12010
mkprofile riko-voice $P_VOICE 900
mkprofile chat-mahou $P_MAHOU 16120
mkprofile familiar-spark $P_FAM 10870
mkprofile riko-narrator $P_RIKO 11000
NIKU=$(spawn image-niku '[0]' $P_NIKU)
spawn luna-spark '[0,1,2,3]' $P_LUNA >/dev/null
spawn riko-voice '[0]' $P_VOICE >/dev/null
spawn chat-mahou '[1,2]' $P_MAHOU >/dev/null
spawn familiar-spark '[3]' $P_FAM >/dev/null
sleep 3   # a heartbeat records measurements (min uptime 1 s in this test)

echo "[layout] assertions:"
NIKU_PID=$(echo "$NIKU" | py 'import sys,json; print(json.load(sys.stdin)["pid"])')

# ── signal mask: a service spawned from an agent worker thread must not
#    start with SIGTERM (or anything else) blocked
check "spawned service starts with an empty signal mask (SigBlk 0)" \
	bash -c "grep -q '^SigBlk:[[:space:]]*0000000000000000' /proc/$NIKU_PID/status"

# ── measured VRAM ──
check "GET /services reports measured vram_mb per GPU (luna split 3002/3/3/2…)" \
	bash -c "curl -fsS '$CP_URL/services' | python3 -c 'import sys,json; s=[x for x in json.load(sys.stdin) if x[\"profile\"]==\"luna-spark\"][0]; v=s[\"vram_mb\"]; sys.exit(0 if sorted(v.keys())==[\"0\",\"1\",\"2\",\"3\"] and s[\"vram_total_mb\"]==12010 and s[\"profile_fp\"] else 1)'"
check "agent GET /vram: per-GPU used/total and 'other' (driver overhead) separated" \
	bash -c "curl -fsS '$AGENT_URL/vram' | python3 -c 'import sys,json; d=json.load(sys.stdin); g=d[\"gpus\"][0]; sys.exit(0 if g[\"total_mb\"]==$CAP and g[\"used_mb\"]==100+4450+3004+900 and g[\"services_mb\"]==4450+3004+900 and g[\"other_mb\"]==100 else 1)'"
check "/nodes: per-GPU used_mb + which services hold it" \
	bash -c "curl -fsS '$CP_URL/nodes' | python3 -c 'import sys,json; n=[x for x in json.load(sys.stdin) if x[\"node_id\"]==\"$NODE_ID\"][0]; g=n[\"hardware\"][\"gpus\"][3]; names=sorted(s[\"profile\"] for s in g[\"services\"]); sys.exit(0 if names==[\"familiar-spark\",\"luna-spark\"] and g[\"used_mb\"]>13000 else 1)'"

# ── GET /api/layout ──
LAYOUT=$(curl -fsS "$CP_URL/api/layout")
check "GET /api/layout lists the five services with measured MB" \
	bash -c "echo '$LAYOUT' | python3 -c 'import sys,json; d=json.load(sys.stdin); ps=sorted(e[\"profile\"] for e in d[\"desired\"]); sys.exit(0 if ps==[\"chat-mahou\",\"familiar-spark\",\"image-niku\",\"luna-spark\",\"riko-voice\"] and len(d[\"nodes\"][0][\"gpus\"])==4 else 1)'"
check "POSTing the GET document back to /plan is a no-op" \
	bash -c "curl -fsS -X POST '$CP_URL/api/layout/plan' -H 'content-type: application/json' -d '$LAYOUT' | python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d[\"ok\"] and d[\"noop\"] and d[\"steps\"]==[] else 1)'"

TARGET='{
  "keep_unlisted": true, "pin": true, "margin_mb": '$MARGIN',
  "desired": [
    {"profile":"luna-spark","node_id":"'$NODE_ID'","gpus":[0]},
    {"profile":"riko-voice","node_id":"'$NODE_ID'","gpus":[0]},
    {"profile":"riko-narrator","node_id":"'$NODE_ID'","gpus":[1],"vram_mb":11000},
    {"profile":"chat-mahou","node_id":"'$NODE_ID'","gpus":[2],"vram_mb":9600},
    {"profile":"familiar-spark","node_id":"'$NODE_ID'","gpus":[3]},
    {"profile":"image-niku","node_id":"'$NODE_ID'","gpus":[3]}
  ],
  "profile_patches": {"chat-mahou": {"extra_flags": ["--fake-vram","9600"]}}
}'
PLAN=$(curl -fsS -X POST "$CP_URL/api/layout/plan" -H 'content-type: application/json' -d "$TARGET")
echo "$PLAN" > "$TMP/plan.json"
check "plan: ok; profile patches first (Mahou's needs a restart, pins don't)" \
	py "import json; d=json.load(open('$TMP/plan.json')); st=d['steps']; np=sum(1 for s in st if s['op']=='patch_profile'); pp={s['profile']:s for s in st if s['op']=='patch_profile'}; exit(0 if d['ok'] and np==6 and all(s['op']=='patch_profile' for s in st[:np]) and pp['chat-mahou']['restart'] and not pp['riko-voice']['restart'] and pp['riko-voice']['patch']['pin']['gpus']==[0] else 1)"
check "plan: every step's projection stays within capacity − margin" \
	py "import json; d=json.load(open('$TMP/plan.json')); exit(0 if all(v<=$USABLE for s in d['steps'] for v in s['projected_mb'].values()) else 1)"
check "plan: Mahou leaves GPU1 before the narrator starts; one service parked" \
	py "import json; d=json.load(open('$TMP/plan.json')); st=[(s['op'],s['profile']) for s in d['steps']]; m=st.index(('start','chat-mahou')); r=st.index(('start','riko-narrator')); exit(0 if m<r and sum(1 for s in d['steps'] if s.get('parked'))==1 else 1)"
check "plan: voice and familiar untouched, ports kept, downtime + estimates reported" \
	py "import json; d=json.load(open('$TMP/plan.json')); ok=all(s['profile'] not in ('riko-voice','familiar-spark') for s in d['steps'] if s['op']!='patch_profile'); ports={s['profile']:s.get('port') for s in d['steps'] if s['op']=='start'}; exit(0 if ok and ports.get('luna-spark')==$P_LUNA and ports.get('image-niku')==$P_NIKU and len(d['downtime'])>=3 and len(d['estimates'])==6 else 1)"
check "plan: luna is sized from its measurement (12010 MB on one card)" \
	py "import json; d=json.load(open('$TMP/plan.json')); e=[x for x in d['estimates'] if x['profiles']==['luna-spark']][0]; exit(0 if e['total_mb']==12010 and e['source'].startswith('measured') else 1)"

INFEASIBLE='{"desired":[{"profile":"familiar-spark","node_id":"'$NODE_ID'","gpus":[3]},{"profile":"riko-narrator","node_id":"'$NODE_ID'","gpus":[3],"vram_mb":11000}]}'
check "infeasible plan → 409 naming GPU 3 and the overflow" \
	bash -c "curl -s -o '$TMP/inf.json' -w '%{http_code}' -X POST '$CP_URL/api/layout/plan' -H 'content-type: application/json' -d '$INFEASIBLE' | grep -q 409 && python3 -c 'import json; d=json.load(open(\"$TMP/inf.json\")); o=d[\"overflows\"][0]; exit(0 if o[\"gpu\"]==3 and o[\"over_by_mb\"]>0 and \"GPU 3\" in d[\"error\"] else 1)'"
check "apply without confirm: true is refused (400)" \
	bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST '$CP_URL/api/layout/apply' -H 'content-type: application/json' -d '$INFEASIBLE')\" = 400 ]"

# ── MCP ──
check "MCP tools/list has get_layout, plan_layout, apply_layout, get_layout_run" \
	bash -c "curl -fsS -X POST '$CP_URL/mcp' -H 'content-type: application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' | python3 -c 'import sys,json; n={t[\"name\"] for t in json.load(sys.stdin)[\"result\"][\"tools\"]}; exit(0 if {\"get_layout\",\"plan_layout\",\"apply_layout\",\"get_layout_run\"}<=n else 1)'"
check "MCP plan_layout returns the same plan" \
	bash -c "curl -fsS -X POST '$CP_URL/mcp' -H 'content-type: application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"plan_layout\",\"arguments\":$(echo "$TARGET" | tr -d '\n')}}' | python3 -c 'import sys,json; r=json.load(sys.stdin)[\"result\"]; d=json.loads(r[\"content\"][0][\"text\"]); exit(0 if not r[\"isError\"] and d[\"ok\"] and len(d[\"steps\"])>=6 else 1)'"

# ── apply ──
echo "[layout] applying the target layout…"
APPLY=$(curl -s -X POST "$CP_URL/api/layout/apply" -H 'content-type: application/json' -d "$(echo "$TARGET" | python3 -c 'import sys,json; d=json.load(sys.stdin); d["confirm"]=True; print(json.dumps(d))')")
echo "$APPLY" > "$TMP/apply.json"
check "apply: done, every step ok" \
	py "import json; d=json.load(open('$TMP/apply.json')); exit(0 if d['status']=='done' and d['log'] and all(s['ok'] for s in d['log']) else 1)"
check "apply: measured usage after every step stayed within capacity − margin" \
	py "import json; d=json.load(open('$TMP/apply.json')); exit(0 if all(v<=$USABLE for s in d['log'] for v in s['measured_mb'].values()) else 1)"
check "apply: the fleet is now one main service per card, on the old ports" \
	bash -c "curl -fsS '$CP_URL/services' | python3 -c 'import sys,json; s={x[\"profile\"]:(x[\"gpus\"],x[\"port\"]) for x in json.load(sys.stdin) if x.get(\"state\")==\"running\"}; want={\"luna-spark\":([0],$P_LUNA),\"riko-voice\":([0],$P_VOICE),\"riko-narrator\":([1],$P_RIKO),\"chat-mahou\":([2],$P_MAHOU),\"familiar-spark\":([3],$P_FAM),\"image-niku\":([3],$P_NIKU)}; exit(0 if s==want else 1)'"
check "apply: stopped processes are really gone (old niku pid)" \
	bash -c "[ ! -e /proc/$NIKU_PID ]"
check "apply: Mahou runs the patched profile; profiles carry pins" \
	bash -c "curl -fsS '$CP_URL/api/profiles/chat-mahou' | python3 -c 'import sys,json; p=json.load(sys.stdin); exit(0 if p[\"extra_flags\"]==[\"--fake-vram\",\"9600\"] and p[\"pin\"]=={\"node_id\":\"$NODE_ID\",\"gpus\":[2],\"port\":$P_MAHOU} else 1)'"
check "applying the same layout again is a no-op" \
	bash -c "curl -s -X POST '$CP_URL/api/layout/apply' -H 'content-type: application/json' -d '$(echo "$TARGET" | python3 -c 'import sys,json; d=json.load(sys.stdin); d["confirm"]=True; print(json.dumps(d))')' | python3 -c 'import sys,json; d=json.load(sys.stdin); exit(0 if d[\"status\"]==\"noop\" else 1)'"
check "GET /api/layout now reports pin: true (round-trip stays a no-op)" \
	bash -c "curl -fsS '$CP_URL/api/layout' | python3 -c 'import sys,json; d=json.load(sys.stdin); exit(0 if d[\"pin\"] is True else 1)'"
RUN_ID=$(py "import json; print(json.load(open('$TMP/apply.json'))['run_id'])")
check "GET /api/layout/runs/{id} returns the run log" \
	bash -c "curl -fsS '$CP_URL/api/layout/runs/$RUN_ID' | python3 -c 'import sys,json; d=json.load(sys.stdin); exit(0 if d[\"status\"]==\"done\" and d[\"log\"] else 1)'"

check "dashboard /ui/layout draws a bar segment per service per GPU" \
	bash -c "curl -fsS '$CP_URL/ui/layout' | python3 -c 'import sys; h=sys.stdin.read(); exit(0 if h.count(\"layout-bar\")==4 and \"luna-spark\" in h and \"riko-narrator\" in h and \"seg-other\" in h else 1)'"

# ── pins ──
NIKU_ID=$(svc_field image-niku id | tr -d '"')
curl -fsS -X POST "$CP_URL/services/stop" -H 'content-type: application/json' \
	-d '{"id":"'"$NIKU_ID"'","node_id":"'"$NODE_ID"'"}' >/dev/null
curl -fsS -X POST "$CP_URL/v1/llama/image-niku/completion" -H 'content-type: application/json' -d '{"prompt":"x"}' >/dev/null 2>&1
check "auto-spawn of a pinned profile lands on its pin (GPU 3, same port)" \
	bash -c "[ \"\$(curl -fsS '$CP_URL/services' | python3 -c 'import sys,json; s=[x for x in json.load(sys.stdin) if x[\"profile\"]==\"image-niku\" and x.get(\"state\")==\"running\"]; print(s[0][\"gpus\"], s[0][\"port\"])')\" = '[3] $P_NIKU' ]"
check "POST /services with no placement follows the pin (placed_by: pin)" \
	bash -c "curl -fsS -X POST '$CP_URL/services/stop' -H 'content-type: application/json' -d '{\"id\":\"'\$(curl -fsS '$CP_URL/services' | python3 -c 'import sys,json; print([x for x in json.load(sys.stdin) if x[\"profile\"]==\"image-niku\" and x.get(\"state\")==\"running\"][0][\"id\"])')'\",\"node_id\":\"$NODE_ID\"}' && curl -fsS -X POST '$CP_URL/services' -H 'content-type: application/json' -d '{\"profile\":\"image-niku\"}' | python3 -c 'import sys,json; d=json.load(sys.stdin); exit(0 if d[\"placed_by\"]==\"pin\" and d[\"gpus\"]==[3] and d[\"port\"]==$P_NIKU else 1)'"

# ── rollback: a step that fails restores what the run changed ──
BROKEN=$(echo "$TARGET" | python3 -c 'import sys,json; d=json.load(sys.stdin); d["confirm"]=True; d["profile_patches"]={"riko-voice":{"extra_flags":["--fake-vram","900","--fake-exit"]}}; print(json.dumps(d))')
VOICE_PID_BEFORE=$(svc_field riko-voice pid)
RB=$(curl -s -X POST "$CP_URL/api/layout/apply" -H 'content-type: application/json' -d "$BROKEN")
echo "$RB" > "$TMP/rb.json"
check "failed step → status rolled_back, with the failing step and a rollback log" \
	py "import json; d=json.load(open('$TMP/rb.json')); exit(0 if d['status']=='rolled_back' and d['result']['failed_step']['profile']=='riko-voice' and d['result']['rollback'] else 1)"
check "rollback restored the voice profile and restarted voice where it was" \
	bash -c "curl -fsS '$CP_URL/api/profiles/riko-voice' | python3 -c 'import sys,json; p=json.load(sys.stdin); exit(0 if \"--fake-exit\" not in p[\"extra_flags\"] else 1)' && [ \"\$(curl -fsS '$CP_URL/services' | python3 -c 'import sys,json; s=[x for x in json.load(sys.stdin) if x[\"profile\"]==\"riko-voice\" and x.get(\"state\")==\"running\" and x[\"alive\"]]; print(s[0][\"gpus\"], s[0][\"port\"])')\" = '[0] $P_VOICE' ]"

# ── share_group in a layout: luna + familiar onto ONE server on GPU 0 ──
SHARED=$(echo "$TARGET" | python3 -c '
import sys,json
d=json.load(sys.stdin); d["confirm"]=True
for e in d["desired"]:
    if e["profile"]=="familiar-spark": e["gpus"]=[0]
    if e["profile"]=="luna-spark": e["vram_mb"]=13000   # the whole shared server
pt={"share_group":"spark","intent":{"parallel_slots":1},"extra_flags":["--fake-vram","13000"]}
d["profile_patches"]={"luna-spark":pt,"familiar-spark":pt}
print(json.dumps(d))')
curl -s -X POST "$CP_URL/api/layout/plan" -H 'content-type: application/json' -d "$SHARED" > "$TMP/shplan.json"
check "shared plan: one server for both, sized once (13000 MB on GPU 0), second join restarts it" \
	py "import json; d=json.load(open('$TMP/shplan.json')); e=[x for x in d['estimates'] if x.get('shared_group')=='spark'][0]; st=[s for s in d['steps'] if s['op']=='start' and s.get('shared_group')=='spark']; exit(0 if d['ok'] and sorted(e['profiles'])==['familiar-spark','luna-spark'] and e['mb']=={'0':13000} and len(st)==2 and st[1].get('restarts_shared') else 1)"
curl -s -X POST "$CP_URL/api/layout/apply" -H 'content-type: application/json' -d "$SHARED" > "$TMP/shapply.json"
check "shared apply: done; one shared server on GPU 0 serving both ports" \
	bash -c "python3 -c 'import json; d=json.load(open(\"$TMP/shapply.json\")); exit(0 if d[\"status\"]==\"done\" else 1)' && curl -fsS '$CP_URL/services' | python3 -c 'import sys,json; s=json.load(sys.stdin); srv=[x for x in s if (x.get(\"shared\") or {}).get(\"role\")==\"server\" and x[\"state\"]==\"running\"]; m={x[\"profile\"]:x[\"port\"] for x in s if (x.get(\"shared\") or {}).get(\"role\")==\"member\" and x[\"alive\"]}; exit(0 if len(srv)==1 and srv[0][\"gpus\"]==[0] and m=={\"luna-spark\":$P_LUNA,\"familiar-spark\":$P_FAM} else 1)' && curl -fsS http://127.0.0.1:$P_LUNA/health && curl -fsS http://127.0.0.1:$P_FAM/health"
check "shared apply: GPU 3 freed of familiar; measured usage stayed within capacity − margin" \
	py "import json; d=json.load(open('$TMP/shapply.json')); exit(0 if all(v<=$USABLE for s in d['log'] for v in s['measured_mb'].values()) and d['log'][-1]['measured_mb']['$NODE_ID:3']<=100+4450 else 1)"
check "re-applying the shared layout is a no-op" \
	bash -c "curl -s -X POST '$CP_URL/api/layout/apply' -H 'content-type: application/json' -d '$SHARED' | python3 -c 'import sys,json; exit(0 if json.load(sys.stdin)[\"status\"]==\"noop\" else 1)'"

DROP=$(echo "$SHARED" | python3 -c '
import sys,json
d=json.load(sys.stdin); d.pop("confirm"); d["keep_unlisted"]=False
d["desired"]=[e for e in d["desired"] if e["profile"]!="image-niku"]
print(json.dumps(d))')
check "keep_unlisted: false stops an unlisted service and drops its pin" \
	bash -c "curl -fsS -X POST '$CP_URL/api/layout/plan' -H 'content-type: application/json' -d '$DROP' | python3 -c 'import sys,json; d=json.load(sys.stdin); st=[(s[\"op\"],s[\"profile\"]) for s in d[\"steps\"]]; p=[s for s in d[\"steps\"] if s[\"op\"]==\"patch_profile\" and s[\"profile\"]==\"image-niku\"]; exit(0 if d[\"ok\"] and (\"stop\",\"image-niku\") in st and p and p[0][\"patch\"]=={\"pin\":None} and len(st)==2 else 1)'"

# ── verified stop of an ADOPTED service that ignores SIGTERM ──
mkprofile stubborn $P_STUB 100 ',"pin":null'
curl -fsS -X PUT "$CP_URL/api/profiles/stubborn" -H 'content-type: application/json' -d '{"binary":"llama-server","intent":{"context":4096,"gpu_layers":99},"extra_flags":["--fake-vram","100","--ignore-sigterm"],"default_port":'$P_STUB',"context":4096,"kv_type":"f16","default_model":"'"$MODEL"'"}' >/dev/null
STUB=$(spawn stubborn '[1]' $P_STUB)
STUB_PID=$(echo "$STUB" | py 'import sys,json; print(json.load(sys.stdin)["pid"])')
STUB_ID=$(echo "$STUB" | py 'import sys,json; print(json.load(sys.stdin)["id"])')
kill -9 "$AGENT_PID" 2>/dev/null; sleep 0.5
# ── GET /services while the agent is down: last known, marked stale ──
HDRS=$(curl -s -D - -o "$TMP/stale.json" "$CP_URL/services")
check "agent down: GET /services still lists its services, marked stale (+ header)" \
	bash -c "echo '$HDRS' | grep -qi '^x-witchgrid-stale: $NODE_ID' && python3 -c 'import json; s=json.load(open(\"$TMP/stale.json\")); exit(0 if len(s)>=6 and all(x.get(\"stale\") for x in s) else 1)'"
boot_agent
sleep 1.5
T0=$(date +%s.%N)
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$CP_URL/services/stop" -H 'content-type: application/json' -d '{"id":"'"$STUB_ID"'","node_id":"'"$NODE_ID"'"}')
T1=$(date +%s.%N)
check "stop of an adopted SIGTERM-ignoring service returns only when it is gone (204)" \
	bash -c "[ '$CODE' = 204 ] && [ ! -e /proc/$STUB_PID ]"
check "…and doesn't wait out the full grace (SIGTERM ignored → SIGKILL after ~1 s)" \
	py "exit(0 if $T1 - $T0 < 6 else 1)"

# LAYOUT_ARTIFACTS=<dir>: keep the request/response documents (docs examples)
if [ -n "${LAYOUT_ARTIFACTS:-}" ]; then
	mkdir -p "$LAYOUT_ARTIFACTS"
	echo "$LAYOUT" > "$LAYOUT_ARTIFACTS/get_layout.json"
	echo "$TARGET" > "$LAYOUT_ARTIFACTS/target.json"
	cp "$TMP/plan.json" "$TMP/apply.json" "$TMP/rb.json" "$TMP/inf.json" "$LAYOUT_ARTIFACTS/" 2>/dev/null
	curl -fsS "$CP_URL/api/layout" > "$LAYOUT_ARTIFACTS/get_layout_after.json" 2>/dev/null
fi

echo "[layout] $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
	echo "--- cp.log (tail) ---"; tail -40 "$TMP/cp.log"
	echo "--- agent.log (tail) ---"; tail -60 "$TMP/agent.log"
	exit 1
fi
