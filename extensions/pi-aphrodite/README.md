# pi-aphrodite

[Pi](https://github.com/earendil-works/pi) coding agent extension that compresses oversized tool output through an [Aphrodite](https://github.com/PlayForm/Aphrodite) CCR proxy before it reaches the model context.

When `pi-aphrodite` is loaded, it hooks the mutable `tool_result` event: agent tool output above the byte threshold is stored in the Aphrodite proxy (`POST /ccr/create`) and replaced with a compact preview plus a `<<<CCR:hash|type|size>>>` marker:

```text
[bash:terminal 142L 8.4KB | error[E0432]: unresolved import ...]
<<<CCR:0123abcd…|terminal|8604>>>
Full output (8.4KB) stored by pi-aphrodite. Use the aphrodite_retrieve tool with hash "0123abcd…" to fetch it.
```

The model recovers the original text on demand with the `aphrodite_retrieve` tool (proxied to `POST /retrieve`), which supports case-insensitive line filtering (`query`) and pagination (`offset`/`limit`).

If the proxy is unreachable, CCR is disabled, or a request fails for any reason, `pi-aphrodite` falls back silently and the original output is kept. User `!<cmd>` shell output also lands in model context, so it is compressed too — **on by default**. Because `BashOperations.exec` streams via `onData`, output is buffered and shown once when the command finishes; use `!!<cmd>` (never intercepted, excluded from context) for a live raw stream, or `/aphrodite bash off` to disable.

Aphrodite's compression pipeline is fully programmatic (regex classifier + type-aware previews + BLAKE3/SQLite store). No model call happens inside the compress step; the only agent decision is whether to retrieve.

## Prerequisites

- Pi v0.60.0 or later
- An [Aphrodite](https://github.com/PlayForm/Aphrodite) proxy running on loopback (default `http://127.0.0.1:9797`) with CCR enabled

If the proxy is unavailable, compression attempts are skipped for the rest of the session unless `/aphrodite on` is used to retry discovery.

## Configuration

| Variable               | Default                  | Purpose                                    |
| ---------------------- | ------------------------ | ------------------------------------------ |
| `APHRODITE_URL`        | `http://127.0.0.1:9797`  | Proxy base URL                             |
| `APHRODITE_MGMT_TOKEN` | unset                    | Bearer token for the management endpoints  |
| `APHRODITE_MIN_BYTES`  | `1024`                   | Minimum output size (bytes) to compress    |

## Commands

```text
/aphrodite          toggle compression on/off
/aphrodite bash     toggle !<cmd> output compression (default on)
/aphrodite status   probe the proxy and show counters
```

A footer indicator shows the current state: `aphrodite:on·up` / `aphrodite:on·down` / `aphrodite:on·…` (probing) / `aphrodite:off`. It is published through `ctx.ui.setStatus("pi-aphrodite", …)`, so sidebar extensions that list footer statuses (e.g. pi-atelier's Extensions panel) show proxy health live.

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
- `pi-aphrodite` compresses **output after execution**, for any tool, and keeps the original retrievable through the proxy's store.

They compose: rtk shrinks what a command emits, aphrodite shrinks whatever is still too large.
