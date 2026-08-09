# pi-rust-kernel

[Pi](https://github.com/earendil-works/pi) coding agent extension that gives pi a persistent Rust evaluation tool: `rust`.

The `rust` tool runs code in a long-lived Rust child process backed by the [evcxr](https://github.com/evcxr/evcxr) evaluation library. Variables, functions, and types persist across `rust` calls within the session — a typed scratchpad for computations, data exploration, and quick algorithms. State dies with the session; a new session starts fresh.

## Usage

Call the `rust` tool from pi:

```
rust code: "let x: i64 = (1..=100).sum(); x"   → 5050 (x is now defined)
rust code: "x * 2"                              → 10100 (x persisted)
```

Parameters:

- `code` (required) — Rust source to evaluate in the persistent kernel.
- `timeoutMs` (optional) — per-call timeout in ms. Default `60000`, clamped to `1000..300000`.

## Kernel API

Inside evaluated code, an injected `kernel` module is available:

- `kernel::read(path) -> String` — read a file (hashline-style `LINEID|line` preview).
- `kernel::write(path, content)` — create or overwrite a file.
- `kernel::edit(path, edits_json)` — edit a file; `edits_json` is a JSON array of `{oldText,newText}` pairs.
- `kernel::bash(cmd) -> String` — run a shell command child-side and return its stdout.
- `kernel::rlm::run(task)` — spawn a child `pi` agent with the task and return its answer (blocking).
- `kernel::rlm::list()` / `kernel::rlm::kill(id)` — list/kill spawned child agents.

The first four reach the host through the bridge socket; `bash` runs direct in the child.

## What persists

- `let`/`fn`/`struct`/`enum`/`impl` declarations — variables, functions, and types survive across calls.

The kernel runs single-threaded and executes calls sequentially.

## Caveats

- **First call is slow.** The first `rust` call compiles a fresh evcxr module (~5s in a release build). Subsequent calls are incremental and fast (~0.2-0.5s). The host grants the first call extra timeout.
- **Timeout restarts the kernel.** Long-running or never-settling code hits the per-call timeout and the kernel is killed and restarted — all state is lost. The result text says so explicitly.
- **`rlm.run` is blocking, not async.** Unlike pi-js-kernel, `kernel::rlm::run` blocks until the child agent finishes and returns its final text; it does not return an admission handle or support panel/loop/answer/peek.

## Requirements

- Pi (bundled in pi-flake, or load standalone)
- A Rust toolchain for the child at runtime. The nix-built extension wraps the child with rustc/cargo/gcc/mold; a dev load needs those on PATH (see `RUST_SRC_PATH`).

## Development

From the flake root, load the extension directly (build the child first):

```shell
cd extensions/pi-rust-kernel/child && cargo build --release
pi -e extensions/pi-rust-kernel
```

The extension registers the `rust` tool; state persists across calls for the session.

Lint and type-check:

```shell
biome lint extensions/pi-rust-kernel/index.ts
cd extensions/pi-rust-kernel && npx tsc --noEmit --skipLibCheck index.ts   # needs pi types resolvable
```

Validate through Nix (once the flake wiring lands):

```shell
nix build .#pi-rust-kernel
nix flake check
```
