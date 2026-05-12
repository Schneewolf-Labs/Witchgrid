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
└── fixtures/
    ├── llama_help_enum_fa.txt    # modern build: -fa [on|off|auto]
    └── llama_help_legacy_fa.txt  # older build: -fa as bare boolean
```

## What's covered (and what's not)

In:
- `intent.render_argv` — short vs long form, value vs boolean_or_enum kinds, legacy boolean translation, extra_flags, error paths
- `intent.explain` — output shape + per-line error annotation
- `capabilities.parse_help` — short/long extraction, value-shape detection, multi-alias, section divider + continuation skipping

Out (deliberate — these layers do I/O):
- `services.spawn_service` — would need a fake binary to spawn; integration territory
- `hardware.probe` — calls `nvidia-smi`
- `capabilities.introspect` — calls a real `llama-server --help`; covered transitively when CI runs against a real binary
- `gguf.read_metadata` — file I/O; would need a fixture GGUF (deferred)
- HTTP routing — covered by the manual smoke in `cp/README.md`

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
