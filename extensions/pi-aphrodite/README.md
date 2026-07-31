# pi-aphrodite

[Pi](https://github.com/earendil-works/pi) coding agent extension that compresses oversized tool output into a **local SQLite store** before it reaches the model context. No proxy, no server — hashing and storage happen in-process.

When `pi-aphrodite` is loaded, it hooks the mutable `tool_result` event: agent tool output above the byte threshold is written to the store and replaced with a compact preview plus a `<<<CCR:hash|type|size>>>` marker:

```text
[bash:terminal 142L 8.4KB | error[E0432]: unresolved import ...]
<<<CCR:0123abcd…|terminal|8604>>>
Full output (8.4KB) stored by pi-aphrodite. Use the aphrodite_retrieve tool with hash "0123abcd…" to fetch it.
```

The model recovers the original text on demand with the `aphrodite_retrieve` tool, which supports case-insensitive line filtering (`query`) and pagination (`offset`/`limit`).

## Two compression points

**At insertion** (`tool_result`): output above the threshold is compressed the moment the tool returns. Conservative by default, because the model is usually about to read what it just asked for — hence high thresholds and a `read` skip list.

**When aged** (`context`, fired before each LLM call): once the conversation passes `APHRODITE_ENGINE_PERCENT` of the model's context window, tool results outside the protected window — the first `APHRODITE_ENGINE_PROTECT_FIRST` and last `APHRODITE_ENGINE_PROTECT_LAST` messages — are replaced by markers. This is upstream Aphrodite's context engine, and it needs no guess about future need: the model read those results many turns ago.

The engine ignores the skip list on purpose. `read` is skipped at insertion because a freshly read file is about to be used; the same file five turns later has no such claim.

If the store file cannot be opened or a write fails, `pi-aphrodite` falls back silently and the original output is kept; `/aphrodite on` retries opening the store. User `!<cmd>` shell output also lands in model context, so it is compressed too — **on by default**. Because `BashOperations.exec` streams via `onData`, output is buffered and shown once when the command finishes; use `!!<cmd>` (never intercepted, excluded from context) for a live raw stream, or `/aphrodite bash off` to disable.

The compression pipeline is fully programmatic (regex classifier + type-aware previews + sha256/SQLite store). No model call happens inside the compress step; the only agent decision is whether to retrieve.

Stored entries expire: a lazy purge (debounced to one sweep per minute, no background thread) deletes rows older than `APHRODITE_TTL_SECONDS` — default 7 days — and reads treat expired rows as missing between sweeps. Re-storing identical content refreshes its TTL. This mirrors upstream [Aphrodite](https://github.com/PlayForm/Aphrodite)'s `SqliteCcrStore` retention, whose own default is 1 hour.

## Prerequisites

- Pi v0.60.0 or later (Node.js ≥ 22.19 runtime — uses `node:sqlite`; under Bun it uses `bun:sqlite`)

That's all. The store is a local file; nothing else needs to run.

## Configuration

| Variable                     | Default                                            | Purpose                                 |
| ---------------------------- | -------------------------------------------------- | --------------------------------------- |
| `APHRODITE_TOOL_THRESHOLD`   | `32768`                                            | Minimum size (bytes) to compress generic tool output |
| `APHRODITE_TERMINAL_THRESHOLD` | `32768`                                           | Minimum size (bytes) to compress shell output — bash tool and user `!<cmd>` alike |
| `APHRODITE_SKIP_TOOLS`       | `read`                                             | Comma-separated tool names never compressed; `APHRODITE_SKIP_TOOLS=` (empty) compresses every tool |
| `APHRODITE_ENGINE_PERCENT`   | `45`                                               | Context-window fill (%) that activates the context engine; `0` disables it (upstream's `engine_threshold_pct`) |
| `APHRODITE_ENGINE_PROTECT_FIRST` | `2`                                            | Messages at the start of the conversation the engine never touches |
| `APHRODITE_ENGINE_PROTECT_LAST` | `5`                                             | Messages at the end the engine never touches — also what keeps the prompt cache stable |
| `APHRODITE_ENGINE_MIN_MESSAGES` | `8`                                             | Conversation length below which the engine idles |
| `APHRODITE_ENGINE_MIN_BYTES` | `1024`                                             | Minimum size (bytes) of an aged tool result before the engine compresses it |
| `APHRODITE_MIN_BYTES`        | unset                                              | Legacy fallback applied to both thresholds when the specific knob is unset |
| `APHRODITE_DB_PATH`   | `$XDG_STATE_HOME/pi/aphrodite-ccr.db` (or `~/.local/state/pi/aphrodite-ccr.db`) | SQLite file for the CCR store |
| `APHRODITE_TTL_SECONDS` | `604800` (7 days)                                | Entry time-to-live; `0` = never expire    |

### Why these defaults differ from upstream

Upstream [Aphrodite](https://github.com/PlayForm/Aphrodite) measures in **bytes** too (`tool_threshold_token = 512 # token proxy threshold (bytes)` — `token` names the proxy on `:9798`, not the unit), so this port's original `4096` / `1024` were unit-correct. The problem is that upstream pairs those low thresholds with four mechanisms this port has not yet implemented, and without them a low threshold is a net loss.

An audit of 141 local Pi sessions (2778 compressions, 2495 retrievals) measured what happens when the threshold fires alone:

| store size | compressions | retrieved in full | net context |
| ---------- | ------------ | ----------------- | ----------- |
| 0–2 KB     | 976          | 90%               | −0.08 MB    |
| 2–4 KB     | 741          | 90%               | +0.05 MB    |
| 4–8 KB     | 662          | 88%               | +0.35 MB    |
| 8–16 KB    | 293          | 83%               | +0.60 MB    |
| 16–32 KB   | 90           | 73%               | +0.75 MB    |
| 32–64 KB   | 40           | 55%               | +1.16 MB    |

Below roughly 16 KB the model answers a marker with an immediate `aphrodite_retrieve` of the same bytes, so the compression costs one extra request and returns the content anyway. `read` behaved that way at every size (97% retrieval), which is why it ships on the skip list.

A new three-model measurement across 513 local session JSONL files confirms the higher cutoff. Under the previous 16 KB / 8 KB pair, 191 CCR markers replaced 4,027,231 bytes; 170 `aphrodite_retrieve` calls retrieved 142 markers (74%). Retrieval was 70.6% (60/85) at 8–16 KB, 84.9% (62/73) at 16–32 KB, and 60.6% (20/33) at 32–64 KB; 157 of 190 compressions landed in the 8–32 KB range. Those 170 round-trips re-prefilled 7.5–8.8 million input plus cache-read tokens to keep only about 1.94 MB (roughly 0.49 million tokens) out of context — about 15:1 in raw tokens, and still unfavorable at cache-read pricing. Only the 32 KB+ bucket has a retrieval rate low enough and a per-hit byte win large enough to earn its marker. The previous 16 KB / 8 KB pair therefore still lost tokens once retrieval round-trips were charged.

### Upstream mechanisms: ported and not

| Upstream | What it does | Here |
| -------- | ------------ | ---- |
| Context engine | At 45% context fill, compresses **middle** turns to CCR markers, protecting the first 2 and last 5 messages | **ported** — `APHRODITE_ENGINE_*` on pi's `context` event |
| `code_multiplier = 3.0` | Triples the threshold for `code_*` content types | not ported — largely covered by the `read` skip list |
| Enriched previews | Per-type shapes: `[grep:4 hits in 3 files …]`, `[test:220 pass 0 fail]`, `[git:2M 1A 1D 3??]`, plus code structure maps | not ported — one shape: first meaningful line, capped at 120 chars |
| `classifier_poll` | Skips CCR entirely for outputs the classifier calls clean | not ported |

The context engine was the load-bearing gap, and it is now closed. A store-wide measurement found it firing at most 68 times: 68 of 3,617 rows never appear in session logs, so it is not currently carrying the value the earlier design assumed. The two compression points are independent safeties: insertion-time compression stays conservative (high thresholds, `read` skipped) so a fresh result is never hidden from a model about to read it, while the engine reclaims the same content once it has aged out. Set the environment variables above to restore upstream-parity numbers at the insertion point.

## Commands

```text
/aphrodite          toggle compression on/off
/aphrodite bash     toggle !<cmd> output compression (default on)
/aphrodite status   probe the store and show counters
```

A footer indicator shows the current state: `aphrodite:on·up` / `aphrodite:on·down` / `aphrodite:on·…` (probing) / `aphrodite:off`. It is published through `ctx.ui.setStatus("pi-aphrodite", …)`, so sidebar extensions that list footer statuses (e.g. pi-atelier's Extensions panel) show store health live.

`aphrodite_retrieve` rows honour pi's expand/collapse toggle (`app.tools.expand`, `ctrl+o` by default): collapsed rows show one summary line (`300L 2.5KB · ctrl+o to expand`), expanded rows show the retrieved text in full, and failures always render in full. Without that renderer pi's fallback prints every retrieved line — up to the 2000-line cap — in collapsed rows too.

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
