# Changelog

## Unreleased

- `aphrodite_retrieve` now defines `renderResult`, so its transcript row respects pi's expand/collapse toggle (`app.tools.expand`): one summary line (`300L 2.5KB · ctrl+o to expand`) collapsed, full text expanded, errors always in full. Pi's fallback result renderer ignores `expanded` and printed every retrieved line — up to the 2000-line cap — in collapsed rows. Adds a peer dependency on `@earendil-works/pi-tui` for `Text`.
- **Context engine**, ported from upstream Aphrodite's `[compression] engine_*` keys onto pi's `context` event (fired before each LLM call). Once context usage passes `APHRODITE_ENGINE_PERCENT` (default `45`; `0` disables), tool results outside the protected window — `APHRODITE_ENGINE_PROTECT_FIRST` (2) and `APHRODITE_ENGINE_PROTECT_LAST` (5) — are replaced by CCR markers, subject to `APHRODITE_ENGINE_MIN_MESSAGES` (8) and `APHRODITE_ENGINE_MIN_BYTES` (1024). The pass is idempotent (marked messages are skipped), idles when `getContextUsage()` reports unknown token counts, and deliberately ignores the skip list — an aged `read` result has no claim to stay whole. `/aphrodite status` reports the engine percentage and how many messages it has compressed.
- New `APHRODITE_SKIP_TOOLS`: comma-separated tool names whose output is never compressed at insertion time, default `read`. Set it to an empty string to compress every tool. `/aphrodite status` reports the active skip list.
- Raised the default insertion-time thresholds above upstream's numbers: `APHRODITE_TOOL_THRESHOLD` `4096` → `16384`, `APHRODITE_TERMINAL_THRESHOLD` `1024` → `8192`. An audit of 141 local sessions (2778 compressions, 2495 retrievals) found that below ~16KB a marker is answered by an immediate full retrieval 83–90% of the time, so the extra request costs more than the marker saves; `read` was retrieved 97% of the time at any size, hence the default skip. Insertion-time compression and the context engine are now independent: the first stays conservative about fresh output, the second reclaims it once aged.
- Split the single compression threshold into two knobs matching upstream Aphrodite's routing: `APHRODITE_TOOL_THRESHOLD` for generic tool output and `APHRODITE_TERMINAL_THRESHOLD` for shell output (upstream's `terminal_threshold`). Upstream has two tool thresholds because it runs two proxies (`tool_threshold_token` on `:9798`, `tool_threshold_cache` on `:9797`); this port has one process and therefore one knob. Shell output means the bash tool and user `!<cmd>` alike — both route to the terminal threshold, as upstream's terminal hook does. All thresholds are byte counts here and upstream alike.
- `APHRODITE_MIN_BYTES` remains honored as a legacy fallback for both thresholds when the specific knob is unset.

## 0.4.0

- Entry retention, ported from upstream Aphrodite's `SqliteCcrStore`: entries now carry a per-row `ttl_seconds` and a lazy purge (debounced to one sweep per minute, no background thread) deletes expired rows on store/retrieve; reads exclude expired rows between sweeps.
- New `APHRODITE_TTL_SECONDS` (default `604800` = 7 days; `0` = never expire). Upstream's own default is 1 hour.
- Store is now an upsert: re-storing identical content refreshes `created_at`/TTL instead of `INSERT OR IGNORE`.
- Pre-TTL databases migrate automatically on open: the `ttl_seconds` column is added and legacy rows are stamped with the configured TTL.
- `/aphrodite status` now reports the configured TTL and the purged-row count.

## 0.3.0

- **Breaking:** the Aphrodite proxy is gone. Compression now runs entirely in-process: output is hashed (sha256, 16 hex chars) and stored in a local SQLite file (`node:sqlite` on Node, `bun:sqlite` under Bun), and `aphrodite_retrieve` reads from the same file. No server, no `APHRODITE_URL`/`APHRODITE_MGMT_TOKEN`; new `APHRODITE_DB_PATH` (default `$XDG_STATE_HOME/pi/aphrodite-ccr.db`).
- Store opens lazily on first use; open/write failure marks the store unavailable and falls back silently to uncompressed output, with `/aphrodite on` retrying — same failure semantics as the old proxy path.
- `/aphrodite status` labels the health field `store:` instead of `proxy:`.

## 0.2.0

- Footer status now includes proxy availability (`aphrodite:on·up` / `on·down` / `on·…`), refreshed on session start (async probe), after store/probe transitions, and via `/aphrodite status` — sidebar panels that list footer statuses (e.g. pi-atelier) show proxy health live.
- `user_bash` compression, on by default: `!<cmd>` output is buffered, stored via `/ccr/create`, and emitted once as a preview plus CCR marker. `!!<cmd>` is never intercepted; `/aphrodite bash on|off` toggles the path.
- `/aphrodite status` output now reports the user-bash toggle.

## 0.1.0
- Initial release.
- `tool_result` handler compresses oversized text tool output via the Aphrodite `/ccr/create` endpoint and substitutes a preview plus `<<<CCR:hash|type|size>>>` marker.
- User `!`/`!!<cmd>` shell output deliberately untouched — `BashOperations.exec` streams via `onData`, so compressing it would require hiding live output.
- `aphrodite_retrieve` tool resolves markers through `/retrieve` with `query`/`offset`/`limit` support.
- `/aphrodite` command toggles compression and reports proxy status.
- Silent fallback to uncompressed output on any proxy failure.
