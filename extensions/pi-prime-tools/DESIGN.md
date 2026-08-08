# pi-prime-tools — DESIGN.md

## Locked decisions

- **Tool rows render as a minimalist left rail, not pi's default bg-colored Box.** Each skinned tool (`bash`, `write`, `grep`, `find`, `ls`, plus `js` via pi-js-kernel) renders with `renderShell: "self"` and a shared frame: bare `+` corner, `|` rail, content indented two, no horizontal strokes, no right rail, no background. State lives in the rail color (pending=accent, success=dim, error=error), not a box. Glyphs come from the shared symbol preset — `PI_SYMBOLS=ascii` gives the `+|+` look, unicode gives `┌│└`; the flake wrapper forces ascii. (2026-08-08)
- **Call slot owns the top corner, result slot the bottom, one continuous rail.** The two slots mount as separate components, so the result slot's first render signals `state.hasResult` and queues a microtask `context.invalidate()` that rebuilds the row (pi issue #3830's double-render guard) — the call slot then drops its bottom corner. Collapsed non-error rows render nothing and the call keeps its own bottom corner, so a collapsed row is still a closed rail. Errors always render. (2026-08-08)
- **Rendering is skinned per registration site; the skin is shared, not global.** An extension cannot restyle a tool it does not register: tool renderers resolve per definition (`toolDefinition.renderCall ?? builtIn`), extension-vs-extension same-name tools merge first-wins, and `getAllTools()` exposes metadata only — no execute. So the builtins are skinned here (create*ToolDefinition spread keeps builtin execution), and js is skinned inside pi-js-kernel against this package's renderers. One renderer, two registration sites. (2026-08-08)
- **Content machinery carried over from the cell design, trimmed.** specs.ts (call rows, now with a js entry), tree.ts (find/ls flat trees), format.ts (callHeaderLine) survive. The cell components — marker, spinner, duration, per-call stats — died with the cell look: a rail carries no marker or spinner; the call line is the summary and expanding attaches output below. (2026-08-08)
- **read and edit are not skinned.** read keeps its builtin syntax-highlighted, line-numbered renderer (a plain rail would lose the highlighting); edit keeps its builtin diff-preview renderer. Skinning either would lose functionality for a cosmetic win. (2026-08-08)
- **Symbols stay shared.** extensions/shared/symbols.ts keeps working: rail corners/vertical, tree connectors. `PI_SYMBOLS=ascii` and `PI_SYMBOL_OVERRIDES` continue to govern. The spinner glyphs died with the cells (removed from the preset tables). (2026-08-08)

## Architecture

- `src/index.ts` — registration: skins bash/write/grep/find/ls definitions via skinDefinition (renderShell "self" + rail renderCall/renderResult); exports skinDefinition + definitions for pi-js-kernel.
- `src/render.ts` — the two render slots: renderCall builds the SPECS call line in a rail frame; renderResult renders expanded output (tree rows for find/ls) and closes the rail. Imported by pi-js-kernel for the js tool.
- `src/specs.ts`, `src/format.ts`, `src/tree.ts` — data tables + string formatting (call rows incl. js, tree rows). Pure functions; the decision-free core.
- `extensions/shared/frame.ts` — the rail frame renderer (vendored oh-my-pi output-block, `style: "rail"`), the single owner of the look.
- `pi-js-kernel` — applies this skin to its js registration (imports renderCall/renderResult from this package; vendored into its nix bundle); the kernel itself stays untouched.

## Deferred

- One-line summary stats (line count, duration) on the call row: the cell design had them; the rail intentionally dropped them for minimalism. Re-adding means stashing a result summary in context.state like the cells did.
- read/edit skinning: blocked on not wanting to lose their builtin renderers, not on mechanism.

## Roadmap

- Phase 1: rail skin for bash/write/grep/find/ls (done).
- Phase 2: js tool skinned through this package (done — pi-js-kernel imports the renderers).
- Phase 3 (check): rail looks right under both symbol presets; collapsed/expanded/error states closed rails.
