# pi-aphrodite

[Pi](https://github.com/earendil-works/pi) coding agent extension that compresses oversized tool output into a **local SQLite store** before it reaches the model context. No proxy, no server — hashing and storage happen in-process.

When `pi-aphrodite` is loaded, it hooks the mutable `tool_result` event: agent tool output above the byte threshold is written to the store and replaced with a compact preview plus a `<<<CCR:hash|type|size>>>` marker:

```text
[bash:terminal 142L 8.4KB | error[E0432]: unresolved import ...]
<<<CCR:0123abcd…|terminal|8604>>>
Full output (8.4KB) stored by pi-aphrodite. Use the aphrodite_retrieve tool with hash "0123abcd…" to fetch it.
```

The model recovers the original text on demand with the `aphrodite_retrieve` tool, which supports case-insensitive line filtering (`query`) and pagination (`offset`/`limit`).

If the store file cannot be opened or a write fails, `pi-aphrodite` falls back silently and the original output is kept; `/aphrodite on` retries opening the store. User `!<cmd>` shell output also lands in model context, so it is compressed too — **on by default**. Because `BashOperations.exec` streams via `onData`, output is buffered and shown once when the command finishes; use `!!<cmd>` (never intercepted, excluded from context) for a live raw stream, or `/aphrodite bash off` to disable.

The compression pipeline is fully programmatic (regex classifier + type-aware previews + sha256/SQLite store). No model call happens inside the compress step; the only agent decision is whether to retrieve.

## Prerequisites

- Pi v0.60.0 or later (Node.js ≥ 22.19 runtime — uses `node:sqlite`; under Bun it uses `bun:sqlite`)

That's all. The store is a local file; nothing else needs to run.

## Configuration

| Variable              | Default                                            | Purpose                                 |
| --------------------- | -------------------------------------------------- | --------------------------------------- |
| `APHRODITE_MIN_BYTES` | `1024`                                             | Minimum output size (bytes) to compress |
| `APHRODITE_DB_PATH`   | `$XDG_STATE_HOME/pi/aphrodite-ccr.db` (or `~/.local/state/pi/aphrodite-ccr.db`) | SQLite file for the CCR store |

## Commands

```text
/aphrodite          toggle compression on/off
/aphrodite bash     toggle !<cmd> output compression (default on)
/aphrodite status   probe the store and show counters
```

A footer indicator shows the current state: `aphrodite:on·up` / `aphrodite:on·down` / `aphrodite:on·…` (probing) / `aphrodite:off`. It is published through `ctx.ui.setStatus("pi-aphrodite", …)`, so sidebar extensions that list footer statuses (e.g. pi-atelier's Extensions panel) show store health live.

## Install

### Nix

This extension is packaged in the [pi-flake](https://github.com/y0usaf/pi-flake) repository as `pi-aphrodite` and exposed to the NixOS module under the bundled name `aphrodite`.

### Development

```shell
bun test          # run tests
tsc --noEmit      # type-check
```

## How it differs from pi-rtk

Both extensions cut LLM token usage, at opposite ends of the pipe:

- [pi-rtk](../pi-rtk/) rewrites shell **commands before execution** so less output is produced at all (bash only).
- `pi-aphrodite` compresses **output after execution**, for any tool, and keeps the original retrievable from the local store.

They compose: rtk shrinks what a command emits, aphrodite shrinks whatever is still too large.
