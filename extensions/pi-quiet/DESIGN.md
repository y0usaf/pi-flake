# pi-quiet — design

## Locked decisions

- **2026-08-11 — tool rows get faces, results stay builtin.** (Supersedes
  same-day "chrome only, no tool-render override": in use, tool rows were
  the loudest chrome left.) Overrides re-register the seven builtins with
  a custom `renderCall` only; `renderResult` is omitted, so builtin
  result rendering (diffs, syntax highlight, ctrl+o expansion) is
  inherited per extensions.md "Rendering: resolved per slot". Rejected
  smaller thing: minimal-mode.ts-style full re-render, ~6x the code for
  worse results.
- **2026-08-11 — colors stay in themes.** Border/accent muting is theme
  JSON (data), not code. This extension touches only surfaces a theme
  cannot reach.
- **2026-08-11 — footer stays default.** (Supersedes same-day custom
  one-line footer, then its mood face.) In use, pi's builtin footer was
  already minimal and its info density won; the face belongs on the
  editor, where the thinking-level color gives it meaning.
- **2026-08-11 — personality is data, not machinery.** Bare removal read
  as boring in use, so every remaining surface carries an ASCII face:
  blink spinner, tool-row faces, editor-border face, random
  hidden-thinking label. Each is a constant table; no timers, no event
  subscriptions. ASCII only — full-width kaomoji risk misalignment.
  Pacing animation rejected in use: motion without meaning; a blink is
  enough.
- **2026-08-11 — editor keeps one border, face rides its color.**
  (Supersedes same-day deferral of editor changes.) `QuietEditor extends
  CustomEditor` post-processes `super.render()`: `(^-^)` embedded in the
  top border, bottom border dropped. The face is colored with
  `this.borderColor`, which interactive-mode live-updates to the
  thinking-level (or bash-mode) color — the face doubles as the thinking
  indicator for free. Top border stays because the transcript/editor
  boundary must survive; fully borderless blends when idle.

## Architecture

- `extensions/quiet.ts` — one file. Decision tables (BLINK, LABELS,
  TOOL_ROWS, EDITOR_FACE) up top; machinery below: a generic
  tool-override loop (execute delegates to cwd-cached builtins), a
  `QuietEditor` render post-pass, and a `session_start` hook with four
  `ctx.ui` calls (`setHeader`, `setWorkingIndicator`,
  `setHiddenThinkingLabel`, `setEditorComponent`). No state, no
  commands, no config.
- `[[canon:no-privileged-path]]` n/a: single-file extension, no plugin
  surface of its own; reversed if it ever grows per-surface toggles.

## Deferred

- Toggle command (`/quiet`) — add when someone actually wants default
  chrome back mid-session; until then restart without the extension.
- Muted theme companion file — separate concern, ships as a theme if at
  all.
- Error face `(x_x)` on failed tool rows — needs a `renderResult`
  override, which would forfeit inherited builtin result rendering;
  revisit only if pi exposes result status to `renderCall`.

## Roadmap

- Phase 1 (done when `nix build .#pi-quiet` passes and the TUI shows no
  header, blink spinner, face tool rows, face-border editor, default
  footer): ship as `testing`.
- Phase 2 (done when it has survived two weeks of daily use without
  wanting default chrome back): promote to `active` in registry.nix.
