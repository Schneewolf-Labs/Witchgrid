# Hemlock 2.1.1 — feedback from the Witchgrid spike

Built a small HTTP control plane (~250 lines across `http_server.hml`, `cp.hml`, `services.hml`) using `@stdlib/net.TcpListener`, `@stdlib/sqlite`, `@stdlib/json`, `@stdlib/process`, `@stdlib/signal`. Compiled with `hemlockc`, deployed as a single 1 MB ELF, end-to-end tested against a real `llama-server` spawned through it. Overall: 🟢 — the language is plenty capable of standing this up, the stdlib coverage is wide enough we never had to reach for raw FFI from user code, and the compiled binary "just runs" on a stock Ubuntu box.

These are the friction points worth filing as separate issues.

> **Update 2026-05-10** (final): every item below now resolved upstream.
> - Items #1, #2, #3: c5ced27 ("fix three compiler-strictness parity gaps")
> - Item #4: #533 (`posix_spawn` primitive in `@stdlib/process`)
> - Item #4b follow-up: #534 (`fs.open_fd` + `fs.fileno` raw-fd file open)
> - Item #5: #531 (per-library FFI handles — closes the silent-corruption-on-two-imports bug)
> - Items #6, #7: #535 (string-literal object-literal keys + `obj?[key]` safe-index)
> - Bonus: build-system fix in flight ([fix-incremental-build-deps branch](https://github.com/hemlang/hemlock/pull/new/fix-incremental-build-deps)) — Makefile didn't track header deps, so any header-touching commit silently produced miscompiled binaries on incremental `make`.
>
> Witchgrid spike now: direct `posix_spawn(argv, { stdin: null_fd, stdout: log_fd, stderr: log_fd, setsid: true })` with no shell wrapper anywhere. Object-literal profile names use the natural string-key syntax. **Hemlock 2.1.x is fully ready for v1 of Witchgrid.**

---

## 1. ✅ FIXED — Compiler stricter than interpreter on `?.` for optional field access

**Severity:** Medium — was a silent parity gap.

**Repro:**

```hemlock
let payload = { name: "x" };
let extra = payload.extra ?? "default";   // <-- (A)
```

- 2.1.1: `hemlock` ran `(A)` fine and returned `"default"`. `hemlockc` failed at runtime with `Object has no field 'extra' (use ?. for optional access)`.
- post-c5ced27: both interpreter and compiler reject `(A)` with the same error.

The fix went the safer direction (tighten interpreter rather than relax compiler) — agreed with that call. Workaround for users: `payload?.extra ?? "default"`.

---

## 2. ✅ FIXED — `substr(start)` with one arg returned garbage

**Severity:** High — failed loudly only later, with a misleading type error.

**Repro:**

```hemlock
let s = "key: value";
let v = s.substr(5).trim();
//   2.1.1: error: 'trim' is not a function (got i8)
```

post-c5ced27: compiler now type-errors on single-arg `substr` at compile time. 

(Future quality-of-life: making `substr(start)` mean "from `start` to end" Python-style would also be lovely, but that's a feature ask — the bug-fix as shipped is fine.)

---

## 3. ✅ FIXED — `export let X = X;` after a local `fn X` was rejected

**Severity:** Low — easy workaround, but the pattern is common.

```hemlock
fn serve(host, port, routes) { /* ... */ }
export let serve = serve;
//   2.1.1: error: Variable 'serve' already defined in this scope
```

post-c5ced27: handled as `export { X };` shortcut. Verified working under both backends. 

---

## 4. ✅ FIXED — No detached/background spawn primitive (was)

**Severity:** Medium for our use case; the one stdlib hole we couldn't work around natively.

`@stdlib/process` gives us `exec(cmd)` and `exec_argv(argv)`, both of which **block until the child exits and capture its stdout**. `fork()` exists but the docs warn it's interpreter-hostile (child inherits all VM state). There's no `posix_spawn`-shaped primitive that returns a PID without waiting.

For Witchgrid we need to launch `llama-server` and walk away with a handle. The workaround we ended up using:

```hemlock
let cmd = env_prefix + "nohup " + join_args(argv)
        + " > " + log_path + " 2>&1 < /dev/null & echo $!";
let result = exec(cmd);
let pid = i32(result.output.trim());
```

This works (the `&` detaches, `echo $!` returns the child PID, the parent shell exits immediately so `exec` returns). But it forces shell interpretation, has injection risk, and means we can't capture spawn-time errors — `nohup` succeeds and the child dies later (we observed this when the model path was bogus: `pid` came back, `kill(pid, 0)` reported alive for a few hundred ms, then it was gone with diagnostics only in the log file).

**Resolved by #533**: `posix_spawn(argv, opts?) -> { pid }` shipped with options `{ env, stdin, stdout, stderr, cwd, setsid }`. The redirection opts take raw fds (not paths), which composes nicely with the new `@stdlib/ipc` `pipe_create()` / `fd_close()` / `dup2()` for piping work. Named `posix_spawn` (not `spawn`) so it doesn't collide with the language-level task `spawn` builtin — good call.

For Witchgrid we use `posix_spawn(["sh", "-c", "exec llama-server ... > log 2>&1"], { setsid: true })`. The shell wrapper stays only because we can't open a log file *as an fd* from Hemlock yet — `fs.open(path, mode)` returns a `File` object, not an `i32`. See ⚠️ #5 follow-up below.

### 4b. ✅ FIXED follow-up — `fs.open_fd` + `fs.fileno` (PR #534)

Both shipped exactly as proposed. Witchgrid's services.hml now does direct posix_spawn with no shell wrapper:

```hemlock
let log_fd = open_fd(log_path, "w");
let null_fd = open_fd("/dev/null", "r");
let r = posix_spawn(argv, {
    stdin: null_fd, stdout: log_fd, stderr: log_fd, setsid: true,
});
fd_close(log_fd); fd_close(null_fd);
```

Verified end-to-end: PPID of llama-server is the witchgrid binary directly (no sh in the chain), `CUDA_VISIBLE_DEVICES` propagates to the child via setenv-around-spawn and the parent's environ stays clean. Shell-injection surface area dropped to zero.

---

## 5. ✅ FIXED — FFI `_ffi_lib` was a single global, last-loaded-wins (PR #531)

**Severity:** High — silent corruption that only manifests at first FFI call site, depends on module load order.

**Repro:** A program that imports both `@stdlib/sqlite` and `@stdlib/uuid` (or any two stdlib modules whose codegen emits separate `hml_ffi_load(...)` calls):

```hemlock
import { open_db } from "@stdlib/sqlite";
import { v4 } from "@stdlib/uuid";

let db = open_db("test.db");
//   Uncaught exception: FFI function 'sqlite3_open' not found in library
```

Looking at the generated C for cp.hml (`hemlockc -k`):

```c
static void *_ffi_lib = NULL;
static void *_ffi_ptr_sqlite3_open = NULL;

HmlValue hml_fn_sqlite3_open(...) {
    if (!_ffi_ptr_sqlite3_open) {
        _ffi_ptr_sqlite3_open = hml_ffi_sym(_ffi_lib, "sqlite3_open");  // (B)
        // ...
    }
}

// elsewhere in init order:
_ffi_lib = hml_ffi_load("libsqlite3.so.0");
// later, also:
_ffi_lib = hml_ffi_load("libcrypto.so.3");        // <-- last wins
```

`_ffi_lib` is shared across all FFI bindings, and symbol resolution at `(B)` is lazy. So whichever library was loaded LAST during module init becomes the lookup target for ALL FFI symbols on first call. In our case: importing `@stdlib/uuid` (which loads `libcrypto.so.3` for `RAND_bytes`) clobbered the sqlite library handle, so `sqlite3_open` couldn't be resolved.

This isn't a theoretical issue — we hit it the first time we ran the compiled binary. The interpreter is unaffected (presumably uses a per-binding library handle).

**Resolved in PR #531**: codegen now stamps each `extern fn` with its preceding `import_ffi` library path during the pre-pass (per-module scope, so loads in module A can't poison module B), emits one `_ffi_lib_<sanitized>` global per unique library, and each wrapper looks up against its own handle. The shared sanitization helper lives in `codegen_internal.h` so the IMPORT_FFI emission and the wrapper agree purely by both sanitizing the same path string. Regression test at `tests/parity/modules/ffi_two_libraries.hml`.

---

## 6. ✅ FIXED — Object literal keys must be bare identifiers (PR #535)

**Severity:** Low — workaround is fine, but the parser error is misleading.

```hemlock
let p = {
    "chat-mahou": { ... },        // <-- error: Expect field name
};
```

The hyphen forces us to use string-literal keys, which the parser rejects. Workaround: build via bracket-assign:

```hemlock
let p = {};
p["chat-mahou"] = { ... };
```

Fine, but the parser error `Expect field name` doesn't suggest the bracket-assign workaround, and it's not obvious that string-literal keys aren't allowed at all (they're a JS-ism most users will reach for).

**Ask:** either accept string-literal keys in object literals (preferred — common JS-ism, no semantic issue), or improve the error to say "object-literal keys must be bare identifiers; use `obj[\"chat-mahou\"] = ...` for non-identifier keys".

---

## 7. ✅ FIXED — `obj["key"]` asymmetry (PR #535, same change as #6)

`obj?[key]` safe-index syntax shipped alongside the string-key fix. Symmetric with `obj?.foo`.

---

## What worked great

For balance — and there's a lot here:

- **`@stdlib/net.TcpListener`** — clean enough that a usable HTTP/1.1 server fits in 120 lines. `read_line()` + `read(n)` is exactly the right level for hand-rolled protocol code.
- **`@stdlib/sqlite`** — `query(db, sql, params)` returning an array of objects with column-named fields is *perfect*. No ORM ceremony, no manual type coercion. `hex(randomblob(16))` for IDs ended up being our uuid replacement and is honestly fine.
- **`@stdlib/json`** — `parse` / `stringify` mirror JS semantics, round-trip is faithful.
- **`@stdlib/process`** — `exec()` returning `{output, exit_code}` and `kill(pid, SIGTERM)` is straightforward; the gap is just the missing `spawn()` (item #4).
- **`hemlockc`** — produced a 1 MB binary on first try. Dynamic deps (`libm`, `libffi`, `libcrypto`, `libc`) are all on every Linux box; no Python venv, no `node_modules`, no Docker image. The compiled binary spawned a real `llama-server`, took completion requests through it, and shut it down cleanly via SIGTERM. **This is a real superpower for ops-shaped tooling.**
- **Module system** — embedding `import { ... } from "./services"` and re-exporting from there worked first try. The `import { exec as db_exec } from "@stdlib/sqlite"` aliasing also resolved cleanly when we needed to disambiguate from `@stdlib/process.exec`.
- **Iteration speed** — `hemlock cp.hml` for live-edit + `hemlockc cp.hml -o witchgrid` for the deploy artifact is a really pleasant dev loop. The sub-second compile time is great.

---

## Witchgrid context (for the curious)

This spike is part of choosing the implementation language for [Witchgrid](https://github.com/Schneewolf-Labs/Witchgrid), an inference orchestrator. There's an existing Python v0.3 (FastAPI + uvicorn + sqlite). The Hemlock port is being evaluated as a replacement because the deploy story (single binary, no runtime) is dramatically better for a tool that's meant to run on a half-dozen heterogeneous Linux boxes. After items #4 and #5 are sorted, it's looking very viable.

— filed by nbeerbower, 2026-05-09 / updated post-c5ced27
