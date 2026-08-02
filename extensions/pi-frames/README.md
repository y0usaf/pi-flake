# pi-frames

Bordered, state-tinted output frames for the builtin `bash`, `write`, `grep`, `find`, and `ls` rows. Each builtin definition and execution contract is preserved; only the rendering is overridden, via `renderShell: "self"`, so tool output appears inside a flush-edged frame with a status bar whose border and interior tint track the call's pending/success/error state. `read` and `edit` are intentionally untouched because pi-hashline owns them. Enable with `pi -e ./extensions/pi-frames` (or the flake's opt-in extension setting).

## Credits

Frame rendering is vendored from [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT, Copyright 2025 Mario Zechner, Copyright 2025-2026 Can Bölük), commit `403931b9`, files `packages/coding-agent/src/tui/output-block.ts`, `packages/coding-agent/src/tui/status-line.ts`, and `packages/coding-agent/src/tui/tree-list.ts`. Trims from the vendored source: sixel/image passthrough, the render cache (`CachedOutputBlock`, `Hasher`), and the `TERMINAL`/`ImageProtocol` hooks. The box-drawing glyphs, the dot separator, and the status icons are inlined as local constants; the tree-list trim drops the `trailingSummary` collapse, the `maxCollapsedLines` budget, and the `TreeContext` depth.
