# pi-quiet — design

## Locked decisions

- **2026-07-29 — hidden thinking has no words, only a blank line.**
  (Supersedes the "random hidden-thinking label" clause of the 2026-08-11
  personality entry: in use, "conjuring..." was chrome, and hidden should
  mean hidden.) `setHiddenThinkingLabel("")` — `interactive-mode.ts` uses
  `label ?? default`, so an empty string survives, and
  `assistant-message.ts` still emits its one `Text` per hidden thinking
  run. That `Text` holds only ANSI escapes, whose `.trim()` is not empty,
  so it renders one blank padded line rather than zero lines. Accepted:
  one blank line reads as paragraph spacing. Rejected smaller-looking
  thing: monkey-patching
  `AssistantMessageComponent.prototype.updateContent` to strip thinking
  parts for true zero height — ~10 LoC reaching into a builtin's private
  `hideThinkingBlock` field, silently broken by an upstream rename.
  Reversed if pi ever treats an empty label as "add no child". ctrl+t
  still reveals full thinking: the toggle rebuilds chat from untouched
  session messages.
- **2026-07-29 — tool rows are pi's own; quiet registers no tools.**
  (Supersedes four entries that together described a tool-override layer
  that is now deleted: same-day "quiet rows: success is silent, failure
  speaks", 2026-08-11 "tool rows get faces, results stay builtin",
  2026-07-29 "override the builtin *definitions*", 2026-07-29 "error face
  `(x_x)` lives in `renderCall`", and 2026-08-11 "quiet never faces a tool
  another extension owns".) In use the quiet rows looked worse than pi's
  defaults, and the override cost more than looks. Two mechanical reasons,
  both verified in pi 0.82.1: (1) `renderCall` and `renderResult` for one
  tool share `context.state`, so replacing one slot breaks its partner —
  `src/core/tools/bash.ts:459` writes `state.startedAt` in `renderCall`
  and reads it in `renderResult` for the elapsed timer and its 1s refresh
  interval, both silently lost under a custom `renderCall`; (2) a tool
  name is claimed by the first extension that registers it
  (`extensions/runner.ts:450`, first-wins, no error), so quiet could only
  ever reach the five names nobody else owned — pi-hashline's read/edit,
  every extension tool, and the hard-wired skill block
  (`SkillInvocationMessageComponent`) kept the default boxed shell, and
  the transcript came out half quiet, half boxed. Deleting the layer buys
  uniform rows, ~120 LoC, and pi's diffs, syntax highlight, streaming and
  ctrl+o expansion back. Reversed if pi grows a render-only override that
  applies to every row without claiming a tool name — that, not per-tool
  registration, is what quiet tool rows would need.
- **2026-08-11 — colors stay in themes.** Border/accent muting is theme
  JSON (data), not code. This extension touches only surfaces a theme
  cannot reach.
- **2026-08-11 — footer stays default.** (Supersedes same-day custom
  one-line footer, then its mood face.) In use, pi's builtin footer was
  already minimal and its info density won; the face belongs on the
  editor, where the thinking-level color gives it meaning.
- **2026-08-11 — personality is data, not machinery.** Bare removal read
  as boring in use, so the one surface quiet still draws carries an ASCII
  face: `EDITOR_FACE` in the editor border. A constant, not a code path.
  ASCII only — full-width kaomoji risk misalignment. Rejected in use:
  blink-glyph spinner (motion without meaning), per-tool faces (see the
  tool-rows entry), random hidden-thinking label (hidden should mean
  hidden).
- **2026-08-11 — editor keeps one border, face rides its color.**
  (Supersedes same-day deferral of editor changes.) `QuietEditor extends
  CustomEditor` post-processes `super.render()`: `(^-^)` embedded in the
  top border, bottom border dropped. The face is colored with
  `this.borderColor`, which interactive-mode live-updates to the
  thinking-level (or bash-mode) color — the face doubles as the thinking
  indicator for free. Top border stays because the transcript/editor
  boundary must survive; fully borderless blends when idle.
- **2026-07-29 — editor border is the working indicator.** (Supersedes
  "no timers, no subscriptions" in the 2026-08-11 personality entry.)
  `setWorkingVisible(false)` removes the loader row; while the agent run
  is active, one interval (`PULSE_MS`, guarded start,
  cleared on agent_end/agent_settled/session_shutdown, `.unref()`ed)
  drives `tui.requestRender()`, and `QuietEditor.render()` paints the
  whole top border through PULSE (`dim→muted→accent→muted`). Blink-glyph
  spinner rejected: motion was right, glyph-swapping read as noise;
  color-ramp strobing was requested in use. Truecolor shine sweep
  (rainbow-editor-style RGB math) rejected: ~30 LoC of color code that
  ignores the theme. Cost of hiding the loader row: the "(Esc to
  interrupt)" hint is gone too — accepted, interrupt is muscle memory.
  The interval pattern follows pi's own rainbow-editor example.

## Architecture

- `extensions/quiet.ts` — one file, chrome only. Decision constants
  (PULSE, PULSE_MS, EDITOR_FACE) up top; machinery below: a `QuietEditor`
  render post-pass with pulse paint, module-level agent state
  (`agentActive`, `pulseTimer`, `pulseFrame`, `editor`), and hooks:
  `session_start` (`setHeader`, `setWorkingVisible(false)`,
  `setHiddenThinkingLabel("")`, `setEditorComponent`) plus
  `agent_start`/`agent_end`/`agent_settled`/`session_shutdown` driving the
  pulse. No tools, no commands, no config.
- `[[canon:no-privileged-path]]` n/a: single-file extension, no plugin
  surface of its own; reversed if it ever grows per-surface toggles.

## Deferred

- Toggle command (`/quiet`) — add when someone actually wants default
  chrome back mid-session; until then restart without the extension.
- Transparent tool and skill boxes — the boxed background behind every
  tool row and skill block is theme data (`toolPendingBg`,
  `toolSuccessBg`, `toolErrorBg`, `customMessageBg`), and `""` resolves to
  `\x1b[49m`, the terminal's own background, in `theme.ts:bgAnsi`. So it
  ships as a theme file if it ships at all — never as code here.

## Roadmap

- Phase 1 (done when `nix build .#pi-quiet` passes and the TUI shows no
  header, no loader row, pi's own tool rows, a pulsing editor border
  during agent runs, default footer): ship as `testing`.
- Phase 2 (done when it has survived two weeks of daily use without
  wanting default chrome back): promote to `active` in registry.nix.
