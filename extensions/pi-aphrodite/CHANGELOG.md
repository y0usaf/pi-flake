# Changelog

## Unreleased

- Split the single compression threshold into two knobs matching upstream Aphrodite's routing: `APHRODITE_TOOL_THRESHOLD` (default `4096`, upstream's `tool_threshold_token`) for generic tool output and `APHRODITE_TERMINAL_THRESHOLD` (default `1024`, upstream's `terminal_threshold`) for shell output. Shell output means the bash tool and user `!<cmd>` alike — both route to the terminal threshold, as upstream's terminal hook does.
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
