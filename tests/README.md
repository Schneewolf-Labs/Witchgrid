# tests — Witchgrid test suite

Hemlock-side unit tests for the pure-function layers. Built on `@stdlib/testing` (`describe / test / assert_eq / assert_throws / run`).

## Run

From the repo root:

```bash
hemlock tests/run.hml
```

Exits non-zero if any test fails — the same `tests/run.hml` is what CI invokes.

## Layout

```
tests/
├── run.hml                # entry point: imports + run()
├── intent_test.hml        # agent/intent.hml — intent → argv translation
├── capabilities_test.hml  # agent/capabilities.hml — --help parser
├── gguf_test.hml          # cp/gguf.hml — GGUF parser + VRAM estimator
└── fixtures/
    ├── llama_help_enum_fa.txt    # modern build: -fa [on|off|auto]
    ├── llama_help_legacy_fa.txt  # older build: -fa as bare boolean
    ├── make_gguf_fixtures.py     # generator for the synthetic GGUFs below
    ├── nemo_llama.gguf           # llama, context_length=1024000 (the lie)
    ├── normal_llama.gguf         # llama, honest 131072 context
    ├── gguf_v2.gguf              # valid magic, unsupported version
    └── bad_magic.bin             # not a GGUF
```

## What's covered (and what's not)

In:
- `intent.render_argv` — short vs long form, value vs boolean_or_enum kinds, legacy boolean translation, extra_flags, error paths
- `intent.explain` — output shape + per-line error annotation
- `capabilities.parse_help` — short/long extraction, value-shape detection, multi-alias, section divider + continuation skipping
- `gguf.read_metadata` / `claimed_context` / `safe_context` / `kv_per_token_bytes` / `max_context_tokens` / `estimate_vram_mb` / `estimate_vram_from_ingredients` — parsed against synthetic header-only fixtures: arch metadata, the Mistral-Nemo 1024000→131072 override, context capping, kv/VRAM math, bad-magic + unsupported-version errors

Out (deliberate — these layers do I/O):
- `services.spawn_service` — would need a fake binary to spawn; integration territory
- `hardware.probe` — calls `nvidia-smi`
- `capabilities.introspect` — calls a real `llama-server --help`; covered transitively when CI runs against a real binary
- HTTP routing / placement / auto-spawn — integration territory; need a CP+agent harness (next up)

## Adding tests

New tests should sit alongside the file they cover:

```hemlock
import { describe, test, assert_eq } from "@stdlib/testing";
import { thing_under_test } from "../agent/my_module";

describe("my_module.thing_under_test", fn() {
    test("does the thing", fn() {
        assert_eq(thing_under_test(input), expected);
    });
});
```

Then add `import "./my_module_test";` to `run.hml` so it gets picked up.

For fixtures, drop the file into `tests/fixtures/` and read with `read_file("tests/fixtures/<name>")` (paths are relative to the CWD that `hemlock tests/run.hml` was invoked from — i.e. the repo root).
