# pi-prime-tools — DESIGN.md

## Locked decisions

- **One line per tool call, collapsed; output attaches on expand.** Each tool
  renders a single status line — marker · label · call preview · stats ·
  duration · expand hint — following prime-agent's ipython-cell pattern
  (ipython-cell.ts: the top line is identical collapsed or expanded;
  expanding only attaches code and output below it). The first port attempt
  (a flat panel with header + always-visible content) was rejected for not
  matching this look. (2026-08-08)
- **Marker carries state, no box.** queued (muted …/[*]) → running (animated
  spinner) → done (✓/[ok]) / error (✗/[!!]). No borders, no background, no
  state-tinted frame — the marker color and the preview text carry the
  information, exactly like prime's cells. (2026-08-08)
- **Spinner is a component-local interval.** TOOL_CELL_PULSE_INTERVAL_MS =
  250, ticking context.invalidate() (the bash renderer's self-refresh
  pattern). Tools run sequentially, so one timer at a time suffices; a global
  pulse ticker (prime's interactive-mode) would need core surgery.
  (2026-08-08)
- **Call and result are two slots sharing one line.** The extension API
  mounts renderCall and renderResult as separate components, so the call slot
  renders the line and the result slot stashes a summary (line count,
  duration, error name) into context.state for the call slot to show. A
  one-shot microtask invalidate (pi-frames' double-render guard) repaints the
  line with the fresh stats after the same mount pass. (2026-08-08)
- **Expanded output is full, not clipped.** Collapsed rows show nothing below
  the line (the line itself is the summary); expanded rows show the full
  output — tree rows for find/ls, plain lines otherwise. No line budgets, no
  "N earlier lines" clipping (that was the panel design's tailBody, dropped).
  The js tool keeps its own 10-line cap: kernel output can be enormous.
  (2026-08-08)
- **Content machinery carried over from pi-frames, trimmed.** specs.ts
  (call rows), tree.ts (find/ls flat trees) survive; format.ts is reduced to
  callHeaderLine (tailBody/resultLines/badges died with the panel design).
  Credits preserved: oh-my-pi vendored code stays attributed. (2026-08-08)
- **read and edit are not skinned.** pi-hashline owns read (its frame keeps
  LINEID anchors flush); pi's built-in edit renderer owns edit (diff
  preview). Skinning either would lose functionality for a cosmetic win.
  (2026-08-08)
- **Symbols stay shared.** The ascii translator (extensions/shared/symbols.ts)
  keeps working: cell markers, spinner frames (unicode ◇◈◆◈, ascii -\|/),
  tree connectors. PI_SYMBOLS=ascii and PI_SYMBOL_OVERRIDES continue to
  govern. pi-frames is retired; shared/frame.ts survives only because
  pi-hashline's read-tool (vendored into pi-js-kernel) imports it.
  (2026-08-08)

## Architecture

- `src/index.ts` — registration: skins bash/write/grep/find/ls definitions
  via skinDefinition (renderShell "self" + cell renderCall/renderResult).
- `src/render.ts` — the two render slots: renderCall builds the one-line
  ToolCallCellComponent (marker · preview · stats · duration · hint);
  renderResult stashes the summary and renders expanded output (tree rows
  for find/ls).
- `src/specs.ts`, `src/format.ts`, `src/tree.ts` — data tables + string
  formatting (call rows, tree rows). Pure functions; the decision-free core.
- `extensions/shared/tool-cell.ts` — the cell primitives (cellState,
  cellMarker, ToolCallCellComponent, ToolResultCellComponent), shared with
  pi-js-kernel's js tool so one cell style covers builtins and the kernel
  tool.
- `extensions/shared/symbols.ts` — the ascii translator, unchanged API.

## Deferred

- **Latest-tool-only expand hint.** prime suppresses "(to expand)" on all but
  the newest tool (selectLatestToolExpandHint); the extension API exposes no
  "is latest" flag, so the hint shows on every cell. Acceptable noise; a
  core change could pass showExpandHint through the render context.
- **Elapsed-time clock while running.** prime's bash shows a live duration
  via a 1s interval. The cell shows duration only after settle; a
  running-clock interval could be added to ToolCallCellComponent the same
  way the spinner works.
- **Edit tool cell.** pi's edit renderer is self-shelled and rich; replacing
  it with a cell would lose the diff preview — larger than the payoff here.

## Roadmap

- Phase 1 — cell extension: bash/write/grep/find/ls render as one-line cells
  with marker + preview + stats + duration + expand hint; expanded rows show
  output/tree rows. DONE (2026-08-08).
- Phase 2 — js tool: pi-js-kernel switches to renderShell "self" and renders
  through the shared tool-cell module; the flake vendors shared/ into the
  js-kernel bundle. DONE (2026-08-08).
- Phase 3 — retirement: pi-frames deleted, the panel patch and panel module
  (first port attempts) dropped, registry + checks wired to pi-prime-tools.
  DONE (2026-08-08).
