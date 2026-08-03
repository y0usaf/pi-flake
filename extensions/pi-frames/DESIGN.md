## Locked decisions
- Dated 2026-08-01: `renderShell: "self"` is adopted — it supersedes pi-toolskin's rejection. The frame needs flush edges, which is the escape clause pi-toolskin's own decision named (a compelling renderer-only need).
- Dated 2026-08-01: frame drawing is vendored from can1357/oh-my-pi (MIT) commit 403931b9, trimmed. Sixel passthrough, the render cache (`CachedOutputBlock`, `Hasher`), and the `TERMINAL`/`ImageProtocol` hooks are dropped because upstream pi-tui lacks those hooks and the cache optimizes a cost not yet measured.
- Dated 2026-08-01: presentation stays data tables — SPECS and LINE_BUDGETS are carried from pi-toolskin.
- Dated 2026-08-01: `[[canon:no-privileged-path]]` is n/a: this is a public-API extension with no second plugin layer.
- Dated 2026-08-01: `[[canon:daemon-thin-client]]` is n/a: no state outlives the session.
- Dated 2026-08-01: layout switched from a status line embedded in the top-border label to an interior command row plus a labeled `Output` tee separator (one continuous box: plain `+ - +` top bar → `$ <command>`/`<label> <primary>` interior rows that wrap, never truncate → `+--- Output ---+` → tail-clipped body → bracketed `[✓ …]`/`[✗ …]` footer → `+ - +`). Applies to the framed builtins `bash`/`write`/`grep` only; `find`/`ls` render inline per the 2026-08-02 decision. Reason: matches oh-my-pi's actual rendered rows (user-verified against real output). The border-label variant was rejected because long commands truncate in the bar; the interior header wraps instead. The status icon is no longer drawn in the border; state reads from border color plus the footer.
- Dated 2026-08-01: borders switched from box-drawing to plain ASCII (corners/tees `+`, sides `-`/`|`), and the state color — previously border strokes only — now washes the whole box (borders plus unstyled interior text) via a stabilized foreground pass that re-injects after SGR resets; explicitly styled interior text keeps its own colors.
- Dated 2026-08-01: `find` and `ls` result bodies render as an oh-my-pi flat tree vendored from can1357/oh-my-pi (MIT) commit `403931b9`, `packages/coding-agent/src/tui/tree-list.ts` — files get a dim extension badge, directories an accent `[D]`, and clipped collapsed views end with the muted `... N more files/entries` summary on the final `'--` row (see the 2026-08-02 decision: these trees now render inline with ASCII connectors). `maxCollapsed` comes from the tool's LINE_BUDGETS collapsed value. Trims from the vendored source: the `trailingSummary`/caller-driven collapse, the `maxCollapsedLines` budget, and the `TreeContext` depth. Non-path content upstream emits (the `No files found matching pattern`/`(empty directory)` messages and the appended `[N results limit…]` notice block) passes through outside the tree. `bash`/`grep`/`write` keep the plain tail view.
- Dated 2026-08-02: `find`/`ls` result rows render inline — a plain call line plus a bare flat tree, with no output-block frame, no `Output` tee, and no bracketed footer — matching oh-my-pi's inline file-list rendering. Tree connectors are ASCII (`|--` branch, `'--` last row, `...` summary): the last-row `'--` mirrors oh-my-pi's ASCII symbol preset (`theme.tree.last` = `"'" + "--"`), and the inline call line carries the ASCII status icon prefix (`[*]` pending, `[ok]` success, `[!!]` error — `status.pending`/`status.success`/`status.error` in their ASCII_SYMBOLS map). Inline rows otherwise carry no state wash (no box tint or border color): truncation info survives only in the pass-through notice.

## Architecture
- `src/specs.ts` is decision-making: which builtins are framed (`bash`/`write`/`grep`) vs inline (`find`/`ls`) and how arguments read.
- `src/frame.ts`, `src/status.ts`, `src/render.ts` are machinery: vendored frame drawing, status-line composition, and TUI slot adaptation.
- `src/format.ts` and `src/skin.ts` carry pi-toolskin's pure, dependency-injected formatting and the definition skinner so tests run with zero node_modules.
- `src/index.ts` is wiring: spreads builtin definitions, tags `renderShell: "self"`, and registers the framed overrides.

## Deferred
- Read/edit frames are blocked by pi-hashline ownership; reverse when hashline imports the frame helper.
- read result batching is owned by pi-hashline; revisit here only after the frame handoff.
- grep match-line trees are deferred — they need match-line parsing against grep's `path:line:match` content, not the flat path lines find/ls emit; revisit on demand.
- Sixel/image passthrough is deferred; reverse if upstream pi-tui exposes an image-protocol query.

## Roadmap
- [ ] Phase 1: framed output for the owned builtins (frames for `bash`/`write`/`grep`, inline trees for `find`/`ls`) with tests (criterion: nix checks green).
- [ ] Phase 2: pi-hashline adopts the frame helper for read/edit.
- [ ] Phase 3: revisit bg-stabilization against upstream markdown/syntax output.
