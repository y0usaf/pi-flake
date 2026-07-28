# Changelog

## 0.1.0

- Initial release.
- `tool_result` handler compresses oversized text tool output via the Aphrodite `/ccr/create` endpoint and substitutes a preview plus `<<<CCR:hash|type|size>>>` marker.
- User `!`/`!!<cmd>` shell output deliberately untouched — `BashOperations.exec` streams via `onData`, so compressing it would require hiding live output.
- `aphrodite_retrieve` tool resolves markers through `/retrieve` with `query`/`offset`/`limit` support.
- `/aphrodite` command toggles compression and reports proxy status.
- Silent fallback to uncompressed output on any proxy failure.
