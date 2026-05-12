# Lessons from flammen.ai v1.0 → Witchgrid priorities

flammen.ai shipped v1.0.0 on 2026-05-09 against a fleet of inference services hand-wired by env vars. This document captures the friction encountered during that build, sketches the scale-out scenarios flammen.ai is heading toward, and translates both into priorities for Witchgrid v1. This document was originally written against the Python prototype's v0.3 vocabulary; the Hemlock port now calls the current slice v0.1, so the status labels below are updated to reflect the repository as audited.

flammen.ai is the **first consumer** Witchgrid is designed against. The features that ease its actual operational pain are the ones that earn v1's place.

## The fleet, today

```
VPS (flammen.ai)               Schneewolf (192.168.8.154)            NN900 (192.168.8.217)
──────────────────             ──────────────────────────            ───────────────────
NuxtFlammen   :3000            FlameWorker (GPU)                     A1111  :7860
FlameWorker (CPU)              FlameGen                                NikuMixXL4
FlameCaption                   FlameCaption (planned: moondream3)
llama-mahou (CPU Q3)  :8080    llama-mahou (4060 Q4 128K)   :8080
                               llama-designer (CPU)         :8081
                               Phoenix-Qwen2.5-7B-v1 Q3     :8085
                               jupyter Qwen3.5-9B (stray)   :8082
                               (Mahou on A6000)             :????

   3 boxes, 4 different inference engines (llama.cpp, A1111, moondream2 transformers,
   Phoenix), ~6 distinct model loads, zero shared visibility.
```

## Pain points encountered during the v1.0 build

Each item is something that actually happened during the build, not speculation.

### Manual swap-and-restart for every model change
Quant comparisons (Mahou Q4 vs Q8, Phoenix Q3 vs Q8), checkpoint A/B testing in A1111 (NikuXLv0.1 → NikuMixXL4 → NikuMixXL5 → NikuMix2.5), and Phoenix model bumps were all hand-rolled: SSH, kill the process, edit a startup flag, restart, watch logs, validate. Each took 5-15 minutes of toil and broke any worker that happened to fire mid-swap.

### "Which box has what loaded right now?" lived in human memory
Repeated moments of "I think the A6000 has Mahou loaded but let me check," followed by `ssh + nvidia-smi + ps aux | grep llama-server` archeology to reconstruct what was running. When FlameCaption was added, real concern was raised that loading the captioning model would *evict* the SDXL checkpoint A1111 was holding — because no system could answer "is there room?"

### Per-GPU placement done by hand
When the 7B Phoenix evals stood up on Schneewolf, the first launch OOM'd because it defaulted to GPU 0 (occupied by Mahou). Fixed by manually setting `CUDA_VISIBLE_DEVICES=2,3` after the operator did the "which GPUs are free?" calculation themselves. No automation, no claim-tracking — just trust.

### VRAM-budget arithmetic done in chat
The Mahou-on-Schneewolf migration involved a multi-line back-of-envelope:
> "Mahou-Nemo 12B Q4_K_M ≈ 7.1 GB model + KV cache. KV per token ≈ 0.16 MB at FP16. 16 GB on a 4060 Ti = 32 K context (5 GB KV + 7 GB model + 1 GB compute = 13 GB)."
Then again to push 128 K with q4 KV. Every model placement decision replays this arithmetic.

### SSH-and-fix as the entire deploy/operate loop
Every restart, every env edit, every model swap, every "did it actually come back up?" check went through SSH. Multiple background "restart workers" tasks failed silently. New service URLs (`PHOENIX_URL=...`) had to be appended to each consumer's `.env` by hand on every box that consumed them.

### Port juggling and stray services
Three llama-server instances on one box (`:8080` Mahou, `:8081` designer, `:8083` Phoenix) plus a forgotten Qwen3.5-9B on `:8082` under a different user that the operator no longer remembered putting there. No registry, no source of truth.

### A1111 checkpoint contention with no coordination
The image path constantly negotiated which SDXL was loaded. Ad-hoc reload-checkpoint API calls; no concept of "model X is now active on box Y" anywhere a worker could read.

### Resilience by accident
Two FlameWorkers (VPS-CPU + Schneewolf-GPU) racing on the same `inference` queue gave us free failover — purely because pgmq's `SELECT FOR UPDATE SKIP LOCKED` happens to behave that way. There is no health check, no draining, no "the GPU box is down, route all traffic to CPU" decision in the system. It works by emergent property, not design.

### Telemetry has the data; nothing surfaces it live
`generation_attempts.model_version` and `worker_id` are stamped on every attempt. The flammen admin Workers tab now aggregates last-7-days activity. But "what's running where, *right now*, with how much VRAM left" still requires the SSH+nvidia-smi+grep dance.

### Cross-box deployment is a discrete project each time
Moving FlameCaption from VPS to Schneewolf, then Mahou+FlameWorker from VPS to Schneewolf, were each 30-45 min manual procedures. There's no orchestration to script "redeploy this service to that node and update consumers" — only documented runbooks.

## flammen.ai's scale-out trajectory

These are forward-looking but already-named in the project:

- **Heterogeneous GPU fleet, currently un-pooled.** Schneewolf has 4× 16 GB 4060s; there's an A6000 (48 GB Ampere) on .154; an RDNA2 6900 XT on Sabre; NN900 hosts A1111. Today none of this is "a pool" — every workload is hand-pinned.
- **Future quality pipeline adds 3+ model dependencies.** Z-Image (FP8, Ada-only) + Qwen Image Edit + a custom VLM hand-detector are all on the roadmap. Each needs the right arch on the right box. Today that's a manual project per model.
- **moondream2 → moondream 3 / Photon migration is hardware-blocked on Ada.** Currently runs on the A6000 because Ampere can't do FP8. The migration target (Schneewolf 4060s) needs FlameCaption co-located there. Should be trivial; today it's a multi-day deploy.
- **Phoenix and future Mahou-replacement models will need head-to-head evals.** Q3 vs Q8, vNext vs current, etc. — every comparison is a deploy today.
- **Latency-tier failover (planned for credits roadmap).** Premium queue gets GPU; free tier spills to CPU under load. Needs explicit routing logic that doesn't exist yet.
- **Multi-project reuse (the actual reason Witchgrid is being built now).** flammen.ai is one consumer. Merlina (training UI), FlameKindling (dataset gen), and future projects all want the same backplane.

## What this means for Witchgrid v1 priorities

Mapping the pain above against what is already in Hemlock v0.1 (control plane + node agent + dashboard + spawn/stop llama-server + routing API + auto-spawn):

### Already covered by Hemlock v0.1 (just need to use them)
- Node registry + hardware reporting → **solves "what boxes do I have"**
- Spawn/stop llama-server services → **solves "swap-and-restart toil"**
- `/v1/llama/{model}/{path}` routing → **solves "every consumer hardcodes a URL"**
- First-live routing across multiple instances of the same profile → **starts to formalize the failover-by-accident pattern**. True round-robin/least-loaded balancing is still a gap.

### Gap-list to make flammen.ai an actual consumer (suggested v1 scope)

1. **Engine support beyond llama.cpp.** A1111 has to be a first-class engine, not just llama-server. Same for moondream/transformers when FlameCaption migrates. Service template format should make adding an engine = config not code.

2. **Capacity-aware placement.** Partially shipped for llama.cpp/GGUF: CP parses model metadata, estimates weights + KV-cache, and first-fits onto one GPU using agents' reported `free_mb`. Remaining v1 work: agent-side model inspection/catalogs so CP does not need shared paths, architecture constraints (FP8/Ada/etc.), multi-GPU splits, and broader engine support.

3. **Health checks → routing exclusion.** Partially shipped: CP only routes to agent-reported `alive=true` services and auto-spawn waits for llama-server `/health`. Remaining work: richer per-engine health checks and load-aware exclusion.

4. **Auto-spawn on first request.** Shipped for llama.cpp profiles with `default_model`. Remaining work: model catalog aliases, non-llama engines, and better handling when the model path exists only on the target agent.

5. **Live dashboard panel for "what's loaded right now."** Shipped for nodes, services, profiles, and capabilities; it still needs engine-specific panels beyond llama.cpp.

6. **Model catalog scanning.** Each node agent scans known dirs (`~/AI/gguf_models`, A1111 checkpoints, etc.) and reports what's *available*, not just what's loaded. Without this, "spawn Mahou on Schneewolf" requires the operator to know the file is there.

### Explicitly not v1 (defer)
- Auth / multi-tenancy (single-operator)
- Push-models-between-nodes sync (read-only catalog is fine)
- Precise CUDA-talking VRAM accounting (naive is enough)
- Pod scheduling abstractions, networking layers, manifests (this is not Kubernetes)
- Job-queue functionality (consumers bring their own pgmq)

## Acceptance criteria: "flammen.ai swaps to Witchgrid"

Witchgrid v1 is done when this works for flammen.ai:

```bash
# Each consumer's .env changes from per-service URLs:
LLAMA_SERVER_URL=http://192.168.8.154:8080      # before
A1111_URL=http://192.168.8.217:7860              # before
PHOENIX_URL=http://192.168.8.154:8085            # before
LLAMA_DESIGNER_URL=http://192.168.8.154:8081     # before

# To one base URL:
WITCHGRID_URL=http://witchgrid:8000              # after
# Workers ask Witchgrid for the right backend per request.
```

…and:
- A new model variant (Phoenix Q4) becomes a click in the dashboard, not an SSH session.
- moondream3 migration to the 4060s is "edit one line in the service template," and Witchgrid figures out which 4060 has room.
- An A6000 reboot routes Mahou traffic to the Schneewolf 4060 without a worker config change.
- "What's running on the A6000 right now?" is answered by opening the dashboard.

The transcript pivot moment was concrete: when Phoenix became the *fourth* llama-server endpoint and the env-var-config-only design hit its ceiling. v1's job is to make the fifth, sixth, and tenth endpoints not feel that ceiling.
