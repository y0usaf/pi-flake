# pi-rust-kernel

A Pi extension that gives pi a persistent Rust evaluation scratchpad tool: `rust`.

## Locked decisions

- **Use evcxr::EvalContext as the persistent eval engine.** The value of a persistent Rust tool is the typed interpreter state, and evcxr is the mature library that delivers it: it keeps the accumulated program and recompiles only what changed, so variables/functions/types persist across eval calls. Reimplementing persistent eval by accumulating source and recompiling a crate per request would be an abstraction we can avoid (canon:least-code). (2026-08-08)
- **The child is a compiled Rust binary speaking NDJSON over stdio** (same protocol shape as pi-js-kernel's `{type:eval}`/`{type:result}`). The host never touches kernel state directly — it writes one eval request line per call, waits for the result line, and applies the timeout/abort watchdog by killing and respawning the child (state lost). This reuses the proven host architecture. (2026-08-08)
- **The child re-spawns itself as a subprocess and needs a Rust toolchain at runtime.** evcxr::EvalContext compiles user code on the fly via a subprocess; the Nix derivation compiles the child and wraps it with rustc/cargo/gcc/mold on PATH plus RUST_SRC_PATH (mirroring nixpkgs' evcxr package). Dev loads fall back to the cargo-built `child/target/release` binary. (2026-08-08)
- **A background thread drains evcxr's output channels continuously.** evcxr's `eval` blocks until its stdout sender is drained, so a println! in user code deadlocks eval unless the channels are being drained concurrently. The child spawns drain threads at startup into a shared buffer and snapshots it after each eval. (2026-08-08)
- **The last expression's value is the result.** evcxr surfaces the trailing expression value as `EvalOutputs{"text/plain"}`; a bare `let` statement yields none. Mirrors pi-js-kernel's `result` field. (2026-08-08)
- **A `mod kernel` is injected into the persistent context.** Pre-evaluated at startup so user code can call `kernel::read(path)`, `kernel::write(path, content)`, `kernel::edit(path, edits_json)`, `kernel::bash(cmd)`, and `kernel::rlm::run(task)`/`list`/`kill`. `kernel::bash` is child-side (direct `sh`); the rest cross the host bridge. The startup compile is paid once (the slow first call). (2026-08-08)
- **The first call is slow (cold compile); subsequent calls are fast.** In a release build the cold start is ~5s (evcxr compiles the initial module); warm evals are ~0.2-0.5s. The host grants extra timeout to the first call. (2026-08-08)
- **Host bridge over a Unix socket.** evcxr evaluates user code synchronously in a re-spawned subprocess with no event loop, so the js-kernel's Promise-based host_request mechanism cannot be expressed directly. Instead, the pre-injected `kernel::*` functions do a synchronous round-trip over a Unix socket: the child runs a background socket server that forwards each request to the host as a `host_request` NDJSON line and returns the `host_response` to the caller. A single stdin dispatcher thread routes lines (`host_response` -> the socket server's pending request, `eval` -> the main eval loop) so there is one reader on stdin. The socket path is exposed via `PI_RUST_KERNEL_SOCKET` (set before `EvalContext::new()` so the subprocess inherits it). (2026-08-08)
- **A-collapse: `rust` is the single model-visible tool.** `pi.setActiveTools(["rust"])` after registration (mirrors pi-js-kernel). Built-in tools stay registered under the hood (the bridge reuses file operations); all file/shell/agent work goes through `kernel::*` inside evaluated Rust. (2026-08-08)

## Architecture

- `index.ts` — machinery and tool registration: owns the child process handle, the NDJSON framing, the timeout/abort watchdog, and the `rust` tool's `registerTool` entry. It never reads kernel internals, only the wire response (canon:functional-core).
- `child/` — a Rust crate (`pi-rust-kernel-child`) compiled by the Nix derivation. `src/main.rs` is the decision-free execution core: evaluates requests in a persistent `evcxr::EvalContext`, drains output channels, and runs the bridge socket server that relays `host_request`/`host_response` to the host. No timeout logic, no session policy.
- The wire protocol is the boundary between the two sides: request `{"type":"eval","id","code"}`, response `{"type":"result","id","ok","stdout","stderr","result"?,"error"?}`, plus mid-eval `{"type":"host_request","id","request"}` / `{"type":"host_response","id","result"}` for the bridge.`

## Deferred

- Rail skinning: pi-prime-tools' left-rail rendering is not applied yet; the `rust` tool renders with pi's default. A later phase can add the rail like pi-js-kernel.
- rlm richness: the rust kernel's `kernel::rlm::run` is a blocking `pi --print` spawn returning the child's final text; it lacks pi-js-kernel's async admission handles, panel/loop/answer/peek, and the contract/ask_parent two-way protocol.`
- Interrupt-without-kill: abort currently SIGKILLs the kernel and loses state. A signal-based interrupt that keeps the context is the obvious next step but needs evcxr cooperation.
- State snapshot/seed on resume: evcxr state is not serializable in a trivial way; a new session starts fresh.

## Roadmap

- Phase 1 — this tool: `rust` works end to end in a dev load (`pi -e extensions/pi-rust-kernel`): spawn, evaluate, persist state across calls, timeout restarts the kernel with state loss, abort kills the kernel, session shutdown cleans up the child.
- Phase 2 — nix bundle: flake wiring lands (child built with rustPlatform, wrapped with the Rust toolchain, registry entry), `nix build .#pi-rust-kernel` and `nix flake check` green, and the bundled extension runs with the store child.
- Phase 3 — completed: host bridge (kernel::read/write/edit/bash/rlm.*) and A-collapse. Remaining polish: rail skinning and a richer rlm surface.
