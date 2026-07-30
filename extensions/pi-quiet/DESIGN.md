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
- **2026-08-11 — tool rows get faces, results stay builtin.** (Supersedes
  same-day "chrome only, no tool-render override": in use, tool rows were
  the loudest chrome left.) Overrides re-register builtins with a custom
  `renderCall` only; `renderResult` is omitted, so builtin result
  rendering (diffs, syntax highlight, ctrl+o expansion) is inherited per
  extensions.md "Rendering: resolved per slot". Rejected smaller thing:
  minimal-mode.ts-style full re-render, ~6x the code for worse results.
- **2026-07-29 — quiet rows: success is silent, failure speaks.**
  (Supersedes "results stay builtin" in the 2026-08-11 faces entry: user
  direction — minimalism outranks builtin result fidelity.) bash, grep,
  find, ls set `renderShell: "self"` (no Box padding/status bg) and
  override `renderResult`: a successful result renders an empty Container
  and parks a dim digest on the call row instead (` · ok · ctrl+o`,
  ` · 14 hits · ctrl+o`); ctrl+o expands to the full output under a dim
  rail `  │ `; a failed result renders its full output under an
  error-colored rail — bash throws on non-zero exit, so the thrown
  message (output + "Command exited with code N") IS the failure rail.
  Digests count non-empty result-text lines (details carry only
  truncation metadata; exit codes never reach the renderer). The call row
  doubles as state indicator: dim face while running, accent once the
  digest lands, `(x_x)` on error. Digest handoff: `renderResult` writes
  `context.state.digest` and re-invalidates via `queueMicrotask` (the
  call slot renders first in a pass; the microtask re-render picks the
  digest up, guarded by an equality check so it cannot loop). write keeps
  builtin result rendering — its diff view beats quiet. Rejected:
  duration in the digest (`executionStarted` is a boolean, not a
  timestamp); uniform face column (user kept per-tool personality).
- **2026-08-11 — quiet never faces a tool another extension owns.**
  Registering a tool name is exclusive: two extensions claiming one name
  is a hard load error (pi refused to start when quiet and pi-hashline
  both registered read/edit). So TOOL_ROWS covers only bash, write,
  grep, find, ls; hashline's read/edit render plain. Reversed if pi ever
  grows a render-only override that does not claim the name.
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
- **2026-07-29 — override the builtin *definitions*, not the wrapped
  tools.** `createLsTool(cwd)` and friends return `AgentTool`, which
  `wrapToolDefinition` builds without `promptSnippet`/`promptGuidelines`
  (bash is the lone exception: it re-attaches them by hand). Registering
  those wrappers dropped write/grep/find/ls prompt metadata from the
  system prompt — `agent-session.ts` builds `_toolPromptSnippets` from
  the override registry, and extensions.md states prompt metadata is not
  inherited. TOOL_ROWS now carries `create*ToolDefinition`.
- **2026-07-29 — error face `(x_x)` lives in `renderCall`.** (Supersedes
  the Deferred entry that called this impossible.) `ToolRenderContext`
  carries `isError` into the call slot as well: `tool-execution.ts`
  rebuilds the render context on every `updateDisplay()`, and result
  arrival triggers one. (Its "no `renderResult` override" clause is
  superseded by the 2026-07-29 quiet-rows entry above: digest rows now
  override `renderResult`; write still inherits builtin rendering.)
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

- `extensions/quiet.ts` — one file. Decision tables (PULSE, TOOL_ROWS,
  EDITOR_FACE, ERROR_FACE, EMPTY_RESULT) up top; machinery below: a
  generic tool-override loop over per-cwd memoized builtin definitions
  (digest rows add self-shell + railed `renderResult`, digest parked in
  row-local `context.state`), a `QuietEditor` render post-pass with pulse
  paint, module-level agent state (`agentActive`, `pulseTimer`,
  `pulseFrame`, `editor`), and hooks: `session_start` (`setHeader`,
  `setWorkingVisible(false)`, `setHiddenThinkingLabel("")`,
  `setEditorComponent`) plus
  `agent_start`/`agent_end`/`agent_settled`/`session_shutdown` driving
  the pulse. No commands, no config.
- `[[canon:no-privileged-path]]` n/a: single-file extension, no plugin
  surface of its own; reversed if it ever grows per-surface toggles.

## Deferred

- Toggle command (`/quiet`) — add when someone actually wants default
  chrome back mid-session; until then restart without the extension.
- Muted theme companion file — separate concern, ships as a theme if at
  all.

## Roadmap

- Phase 1 (done when `nix build .#pi-quiet` passes and the TUI shows no
  header, no loader row, face tool rows, pulsing editor border during
  agent runs, default footer): ship as `testing`.
- Phase 2 (done when it has survived two weeks of daily use without
  wanting default chrome back): promote to `active` in registry.nix.
