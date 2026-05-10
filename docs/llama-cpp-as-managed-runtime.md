# Witchgrid as the llama.cpp manager (not just a wrapper)

Brainstorm captured 2026-05-10. Not a spec — the design space sketch for "what if Witchgrid owned llama.cpp itself, not just spawn-and-supervise of an externally-installed copy."

## The pain

llama.cpp ships a release roughly every other day. The HTTP API stays mostly stable but the CLI surface drifts constantly:

- **Flag renames:** `--cache-type-k` was for a while `-ctk`; some intermediate releases accepted both, current accepts only one.
- **Flag semantics changes:** `-fa` used to be a bare boolean; current build wants `-fa on|off|auto`. We hit this first try with the spike — `-fa` was followed by `-m` and llama-server thought `-m` was the value for `-fa`. Silent argv corruption.
- **Capability flags appear/disappear:** `--no-mmap`, `--cont-batching`, `--parallel` (-np), `-ngl` semantics around partial offload, `-fa` only existing on CUDA builds, `--cache-type-v` only existing if compiled with the right flag, etc.
- **Build matrix:** CUDA-12.4 + sm86, CUDA-12.4 + sm89, CPU-AVX2, CPU-AVX512, Metal, ROCm. The right binary depends on the GPU on the box.
- **Source build is a project:** `git clone + cmake -DGGML_CUDA=on -DLLAMA_CUDA_F16=ON` etc. Has to match the CUDA toolkit version. Build can take 5-15 min on the GPU box itself.

The flammen.ai v1 build had us SSH'd into Schneewolf rebuilding llama.cpp three times in a month, each time chasing a flag that had moved or a capability we wanted that wasn't in our build. Same operator pain that motivates Witchgrid's existence — just one layer down.

## What's possible

If Witchgrid owned llama.cpp the way k8s owns its workload images, the operator never has to think about it again. The same control plane that places models on GPUs would also acquire and version the binary that runs them.

This is scope creep on the v0.x "fancy wrapper" framing — but it's the *right* creep, because it eliminates a category of operator pain Witchgrid was already adjacent to.

## Three layers

### 1. Capability introspection (cheap, ship first)

Each registered llama-server binary on each agent gets `--help` parsed once at registration time. The capability set lands in sqlite:

```
binaries (
  id            text primary key,
  agent_id      text references agents(id),
  path          text,                       -- /usr/local/bin/llama-server
  build_hash    text,                       -- llama.cpp git sha
  flavor        text,                       -- 'cuda-12.4-sm86' | 'cpu-avx2' | ...
  flags_json    text,                       -- parsed --help: which flags exist + their value shapes
  detected_at   timestamptz
)
```

The profile template stops being "literal argv" and becomes *intent*:

```yaml
chat-mahou:
  context: 131072
  cache_type_k: q4_0
  cache_type_v: q4_0
  parallel_slots: 1
  gpu_layers: all
  flash_attention: true
  format: chatml
```

Witchgrid's argv-builder maps that intent against the chosen binary's flag set:

- `flash_attention: true` + binary supports `-fa on|off|auto` → emit `-fa on`
- `flash_attention: true` + binary supports `-fa` (boolean) → emit `-fa`
- `flash_attention: true` + binary doesn't support `-fa` → refuse to schedule on this binary, OR emit nothing + log a warning

Same for cache_type, gpu_layers, etc. **The flag-rename arms race becomes a non-event.** Profiles outlast llama.cpp upgrades.

This alone is worth shipping in v0.x, before any of the acquisition stuff. It's a few hundred lines of `--help` parser + an argv-builder dispatch table.

### 2. Binary management (medium lift, big win)

Each agent maintains a registry on disk:

```
~/.witchgrid/
  llama-server/
    b3500/
      llama-server
      meta.json    { build_hash, cmake_flags, cuda_version, sm_arch, ... }
    b3520/
      llama-server
      meta.json
    vendored -> b3500    # symlink to the version Witchgrid shipped with
    current  -> b3520    # symlink to the operator's chosen default
```

The placement algorithm picks a `(box, GPU set, binary version)` tuple, not just `(box, GPU set)`. Default is `current`; profiles can pin (`binary_version: b3500` if you know b3520 broke your model). Fallback is "the previous version still on disk."

This is also the foundation for safe upgrades — see canary section below.

### 3. Acquisition (deferred — the build matrix bites)

Three modes that compose:

**a. Vendored.** The Witchgrid release tarball includes one known-good `llama-server` per common flavor (CUDA-sm86, CPU-AVX2, maybe CPU-AVX512). Bumps Witchgrid release size from 1 MB to maybe 100 MB but means *"scp the tarball, systemctl start"* gives you a working setup with **zero llama.cpp involvement on the operator side**. This is the killer onboarding story.

**b. Prebuilt download.** Pull releases from `ggerganov/llama.cpp` GitHub. The official CUDA prebuilts cover sm75/sm86/sm89; matches by GPU arch + CUDA version. Downloads to `~/.witchgrid/llama-server/<build>/`, runs `--help` to populate the capability cache, registers as available.

**c. Source build.** `git clone` + `cmake -DGGML_CUDA=on -DLLAMA_CUDA_F16=ON` (or the appropriate flags for the box). Agent reports its build prereqs (`cmake` present, `nvcc` present + version, `gcc` version) so CP knows which agents are *capable* of source builds. This is for the cases where prebuilts don't cover your GPU (Hopper sm90, AMD ROCm, Apple Silicon) or you want bleeding edge.

The acquisition layer is where it gets gnarly — the build matrix is real, source builds fail in interesting ways, prebuilt URLs change. Worth deferring until layers 1 + 2 prove the model and there's a real operator hitting it.

## Phasing into the roadmap

Ordered by ratio of "operator pain eliminated" to "implementation cost":

| When  | Ship | Eliminates |
|-------|------|------------|
| v0.1  | Capability introspection (parse `--help`, intent-based profiles, derived argv) | Flag-rename breakage. Profiles outlast llama.cpp upgrades. |
| v0.2  | Vendored binary in the release tarball | "First install llama.cpp" from onboarding. Witchgrid is one tarball, one systemd unit, done. |
| v0.3  | Binary registry + version pinning per profile | Safe rollback when an upgrade breaks a model. Multi-version coexistence on one box. |
| v0.4  | Prebuilt download from GitHub releases | "How do I update?" becomes a UI button. |
| v0.5+ | Source build with build-prereq detection | Covers boxes with non-prebuilt GPU archs. The annoying-to-maintain piece — defer until clear demand. |
| 1.x   | Auto-canary (see below) | Operator never has to manually validate an upgrade. |

## The really spicy version (1.x, not now)

Auto-canary on new upstream releases:

1. CP polls `ggerganov/llama.cpp` GitHub releases (or a webhook fires).
2. Agent with idle GPU capacity downloads + builds (or just downloads prebuilt) the new version.
3. CP runs an eval pass: same prompts that the current chat profile handles in production, fired through the new binary. Measures perplexity (against the same logits), latency, output-stability (same seed → same output), token-throughput.
4. CP diffs against the current version's baseline. If green across all metrics, mark the new version as a candidate. If degraded, mark broken + open a PR-style notification ("b3540 regressed throughput 12% on chat-mahou — keeping b3520").
5. Operator approves the flip in the dashboard. Or auto-flip if the eval gates pass with margin.

This is the "Witchgrid is a real platform" version. The architecture should leave the door open for it (binaries are versioned + multi-resident from v0.3 onward, evals are a structured artifact not a one-shot).

## Open design questions

- **Where do vendored binaries live in the Witchgrid source tree?** Probably not in the repo (100 MB blobs in git is misery). Maybe a separate release-artifacts repo, or pulled at release-build time from GitHub releases of llama.cpp directly.
- **How are flag-set deltas surfaced?** When upgrading b3520 → b3540, what tells the operator "your `chat-mahou` profile uses `-fa on` and the new build dropped that"? Probably: profile validation runs against every available binary on every agent, and any "this profile won't work on this binary" combo surfaces in the dashboard.
- **Do we own model files too?** GGUF management has the same shape (download + version + verify checksum + multi-version on disk). Probably yes, eventually — same pattern, but defer until binary management has proven out.
- **What about non-llama.cpp engines?** A1111 has the same problem in spades (web UI updates, extension compat, checkpoint loaders). The capability-introspection model probably generalizes; the acquisition model probably doesn't (A1111 is a Python-venv beast, not a single binary). Cross that bridge later.

## Why this matters more than it looks

The cheap framing of Witchgrid is "k8s for inference." The accurate framing is *"the missing operator layer for keeping a heterogeneous GPU fleet happy."* Inference engines are unstable, fast-moving, hardware-coupled software — exactly the kind of thing that benefits from an opinionated manager that knows your fleet, knows the engine, and handles the boring parts.

The day flammen.ai's operator can ignore llama.cpp's existence is the day Witchgrid earned its keep.
