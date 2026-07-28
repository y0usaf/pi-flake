# Changelog

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
