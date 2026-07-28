# Changelog

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
