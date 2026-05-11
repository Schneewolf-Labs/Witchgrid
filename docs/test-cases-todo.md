# Test cases to write

Bugs / edge cases hit during development that don't have automated coverage yet. When the testing pattern is in place, each of these becomes one test. Newest first.

## Multi-box and placement

1. **CP must not crash when the spawn payload's `model` path is unreadable from CP's filesystem.** Discovered during the first sabre↔schneewolf smoke: schneewolf had Mahou at `/home/nbeerbower/AI/models/...`, sabre at `/mnt/BALTEUS/...`. Posting the schneewolf path to CP made `read_metadata` throw out of `pick_placement`, taking down the CP process. Now caught + returns 422 with a helpful message; assert that.

2. **Cross-box agent registration round-trips hardware faithfully.** Specifically: agent on box B, CP on box A, GET /nodes from box A reflects the actual `nvidia-smi` output on box B (gpu count, names, free_mb), not box A's hardware. Caught a bug where the agent reported the *agent box's* hardware but with the *CP box's* `agent_url` if the env vars were swapped — easy to misread.

3. **Stale agent falls out of placement after `STALE_NODE_SECONDS`.** Boot CP+agent, kill agent, wait >90s, POST /services → expect 503-ish (no live placement target) not "spawned on dead agent". GET /nodes still shows the dead node with its old `last_seen_at` (visibility-only).

4. **Heartbeat advances `last_seen_at`.** Boot agent, snapshot `last_seen_at` from /nodes, wait one heartbeat tick, assert it advanced by ~heartbeat_seconds.

## Auto-spawn

5. **Concurrent first-requests for the same unspawned profile.** Fire 5 simultaneous `POST /v1/llama/chat-mahou/completion`s. Today CP serializes through its single accept loop so the second through fifth arrive after the first has already spawned + the service is in the registry. Assert that only one spawn happens, no port collisions, no extra llama-servers. (When CP becomes multi-threaded this becomes a real race; the test will catch it.)

6. **Auto-spawn refuses cleanly when no GPU has free VRAM.** Fill GPU memory artificially (or set a tiny `STALE_NODE_SECONDS` to drop the only fit-able node), POST /v1/llama/chat-mahou/completion → expect 503 with the "no GPU has free VRAM" body, not a hung request or a 502.

7. **Auto-spawn refuses when the profile has `default_model: null`.** POST /v1/llama/designer-cpu/completion (no default_model in our shipped config) → 503 with "no default_model declared".

8. **Auto-spawn waits for `/health` to flip to 200 before proxying.** Wedge a slow-loading model (or fake llama-server with a 5s health delay), POST inference → CP holds the connection, returns the real reply only after health is OK. Don't return mid-load 503s.

## GGUF parser

9. **Mistral-Nemo metadata lie.** `claimed_context(parsed)` returns 1024000, `safe_context(parsed)` returns 131072 (override applied). Add a small fixture GGUF for this — synthetic header, no tensor data needed.

10. **CPU-only nodes report `role: "cpu"` and `gpus: []`.** Mock `nvidia-smi` returning non-zero (or simply not on PATH) → `hardware.probe()` returns `{role: "cpu", gpus: []}` cleanly, no exception.

11. **`max_context_tokens` caps at `safe_context`.** A model with claimed=1024K, safe=128K, asked for max ctx on a card that COULD fit 600K of KV → return 128K, not 600K.

12. **Bad GGUF magic throws clear error.** Read a non-GGUF file (e.g., empty or random bytes) → throws `"not a GGUF file: <path>"`, not a confusing buffer-bounds exception.

## Hemlock regressions worth pinning

These were Hemlock bugs (now fixed upstream); having a Witchgrid-side smoke ensures we notice if they ever come back in a future Hemlock version.

13. **Two FFI libs in one binary.** Spike used to break because importing `@stdlib/uuid` (libcrypto) clobbered `@stdlib/sqlite` (libsqlite3) in compiled binaries — one shared `_ffi_lib` global, last load wins. Fixed in Hemlock #531; assert a CP binary that uses both still works.

14. **HTTP POST body sends body + Content-Type + Content-Length in compiled binary.** Was broken in Hemlock 2.2.0 (runtime ignored body/content_type args). Fixed in 2.2.1; assert agent's POST /register actually delivers the JSON.

## Coexistence with non-Witchgrid processes

Operator boxes have other stuff running — flammen.ai's existing
llama-servers, Jupyter, A1111, ad-hoc workloads. Witchgrid is the
*new tenant*, not the only tenant. Tests must reflect this.

17. **`pick_port` must detect OS-level port contention, not just its own services table.** Today it walks Witchgrid's known services and bumps past those, but it has no idea another process owns a port. Hit this immediately on schneewolf — port 8080 was held by an existing flammen.ai llama-server, our spawn picked 8080 anyway, llama-server failed `couldn't bind HTTP server socket` and the agent reported success because posix_spawn returned a PID. Test: bind a TCP listener on the profile's default_port, POST /services → expect Witchgrid to detect and pick the next free port.

18. **`pick_placement` must account for VRAM consumed by non-Witchgrid processes.** Agent's nvidia-smi already reports `free_mb`, which IS the right number — but we should test that placement respects "GPU 0 has 720 MB free even though total is 16 GB" and avoids it for a 12B chat profile. Currently works because we trust nvidia-smi; lock it in.

19. **Spawn failure surfaces to operator quickly.** Today: agent's posix_spawn returns a PID, agent returns 201, llama-server crashes 50ms later, only visible by tailing the log file. The 201 → CP doesn't know the spawn failed → next routing request fires at the dead service. Test: spawn with a bad model path or contended port → expect agent to wait briefly + check the process is still alive + return a useful error if it died. Or: CP polls /health for a few seconds after spawn and returns the spawn-time error if health never flips.

## Operability

15. **`witchgrid.db` lives at a predictable location.** Today both CP and agent open `witchgrid.db` / `witchgrid-agent.db` relative to CWD, which means starting the binary from a different directory creates a new empty DB. Test would assert (a) location is configurable via env and (b) either default is absolute or the binary errors loudly when CWD is unexpected.

16. **Multiple spawn requests on the same profile pick different ports.** Already verified manually (port autoinc 8080 → 8081 when first is occupied). Lock it in.

## Hemlock language pitfalls (would have caught with tests)

20. **`file.read()` with no args returns "" on `/proc` pseudo-files.** The stat-size of /proc files is 0, and `read()` honors that. Workaround: always pass an explicit max-bytes for /proc reads. Hit this writing `process_alive` — the code looked correct but always returned false because the state line was never found in the empty read.

21. **`string[i]` returns a `rune`, not a `string`.** Comparing a rune to a string literal (`c != " "`) is mismatched types — compiler warns, interpreter silent. Always use rune literals (`c != ' '`) for string-character comparisons. Bit me twice in `process_alive`'s whitespace skip + state-char comparison; both conditions silently always-true.

22. **`throw` from a code path that runs concurrently with an async task crashes the process** with `longjmp causes uninitialized stack frame`. The agent has a heartbeat `async fn` running detached on a worker thread; throwing from the main HTTP handler during that window aborts the whole process. Workaround in our code: structured error returns (`return { spawn_error: msg };`) instead of throw. Worth filing upstream on Hemlock side.

23. **CP's `/v1/llama/{profile}/*` proxy garbles the response body when llama-server returns non-trivial JSON.** Verified end-to-end: client gets a body that python's `json.loads` rejects with `Expecting ',' delimiter` mid-string. Hitting llama-server directly works fine. Likely the same rune-vs-byte handling that bit `process_alive` — somewhere in the proxy path we're indexing bytes as runes and corrupting multi-byte UTF-8 sequences. Need to audit the http_request → response.body chain.

## How to test

Hemlock has the `@stdlib/test` shape; small fixture GGUFs can be checked in (a few KB each — header only, no tensor data — synthetic). Network tests need a CP+agent harness that spins up both in-process or as subprocesses; defer until we have the harness pattern figured out.
