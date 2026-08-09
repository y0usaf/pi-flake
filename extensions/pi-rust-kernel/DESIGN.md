# pi-rust-kernel

A Pi extension that gives pi a persistent Rust evaluation scratchpad tool: `rust`.

## Locked decisions

- **Use evcxr::EvalContext as the persistent eval engine.** The value of a persistent Rust tool is the typed interpreter state, and evcxr is the mature library that delivers it: it keeps the accumulated program and recompiles only what changed, so variables/functions/types persist across eval calls. Reimplementing persistent eval by accumulating source and recompiling a crate per request would be an abstraction we can avoid (canon:least-code). (2026-08-08)
- **The child is a compiled Rust binary speaking NDJSON over stdio** (same protocol shape as pi-js-kernel's `{type:eval}`/`{type:result}`). The host never touches kernel state directly — it writes one eval request line per call, waits for the result line, and applies the timeout/abort watchdog by killing and respawning the child (state lost). This reuses the proven host architecture. (2026-08-08)
- **The child re-spawns itself as a subprocess and needs a Rust toolchain at runtime.** evcxr::EvalContext compiles user code on the fly via a subprocess; the Nix derivation compiles the child and wraps it with rustc/cargo/gcc/mold on PATH plus RUST_SRC_PATH (mirroring nixpkgs' evcxr package). Dev loads fall back to the cargo-built `child/target/release` binary. (2026-08-08)
- **A background thread drains evcxr's output channels continuously.** evcxr's `eval` blocks until its stdout sender is drained, so a println! in user code deadlocks eval unless the channels are being drained concurrently. The child spawns drain threads at startup into a shared buffer and snapshots it after each eval. (2026-08-08)
- **The last expression's value is the result.** evcxr surfaces the trailing expression value as `EvalOutputs{"text/plain"}`; a bare `let` statement yields none. Mirrors pi-js-kernel's `result` field. (2026-08-08)
- **`kernel_bash` is injected into the persistent context.** A child-side helper (pre-evaluated at startup) lets user code run shell commands: `kernel_bash("...") -> String`. Mirrors pi-js-kernel's child-side bash. The startup compile is paid once (the slow first call), so subsequent evals reuse the warm context. (2026-08-08)
- **The first call is slow (cold compile); subsequent calls are fast.** In a release build the cold start is ~5s (evcxr compiles the initial module); warm evals are ~0.2-0.5s. The host grants extra timeout to the first call. (2026-08-08)
- **No host-bridge (kernel.read/edit/rlm) in this version.** evcxr evaluates user code synchronously in a subprocess, so mid-eval host callbacks are not possible the way they are in node:repl. The kernel is a pure eval scratchpad plus child-side kernel_bash. (2026-08-08)

## Architecture

- `index.ts` — machinery and tool registration: owns the child process handle, the NDJSON framing, the timeout/abort watchdog, and the `rust` tool's `registerTool` entry. It never reads kernel internals, only the wire response (canon:functional-core).
- `child/` — a Rust crate (`pi-rust-kernel-child`) compiled by the Nix derivation. `src/main.rs` is the decision-free execution core: reads one JSON request line, evaluates it in a persistent `evcxr::EvalContext`, writes one JSON response line. No timeout logic, no session policy.
- The wire protocol is the boundary between the two: request `{"type":"eval","id","code"}`, response `{"type":"result","id","ok","stdout","stderr","result"?,"error"?}`.

## Deferred

- Host-bridge (kernel.read/edit/bash/rlm): mid-eval host callbacks are not possible with evcxr's synchronous subprocess eval. A redesign would need a way for evaluated code to issue host requests (e.g. a pre-injected helper that talks to the host over a side channel), which is a design of its own.
- Rail skinning / A-collapse: pi-prime-tools' left-rail rendering and the single-tool collapse are not applied yet; the `rust` tool renders with pi's default and other tools stay available. A later phase can add the rail and collapse like pi-js-kernel.
- Interrupt-without-kill: abort currently SIGKILLs the kernel and loses state. A signal-based interrupt that keeps the context is the obvious next step but needs evcxr cooperation.
- State snapshot/seed on resume: evcxr state is not serializable in a trivial way; a new session starts fresh.

## Roadmap

- Phase 1 — this tool: `rust` works end to end in a dev load (`pi -e extensions/pi-rust-kernel`): spawn, evaluate, persist state across calls, timeout restarts the kernel with state loss, abort kills the kernel, session shutdown cleans up the child.
- Phase 2 — nix bundle: flake wiring lands (child built with rustPlatform, wrapped with the Rust toolchain, registry entry), `nix build .#pi-rust-kernel` and `nix flake check` green, and the bundled extension runs with the store child.
- Phase 3 — polish: rail skinning + A-collapse, and (if the design pans out) a host-bridge.
