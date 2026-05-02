# pi-minimal-ui

Minimal Pi UI extension with compact, Crush-inspired chrome:

- a full-width header above the editor with a thinking-level gradient diagonal rule
- a prompt rail (`:::`) instead of a detached centered box, so the editor aligns with the chat flow
- hidden default footer
- a Crush-style cycling-ribbon spinner that replaces Pi's default `⠋ Working...` (no label)

```text
pi ╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱ ~/Dev/pi-flake ·  main • ↑12k ↓2k $0.043 18.4%/272k • openai-codex/gpt-5.5 · high • ⚡
::: ask pi something
  │ continued prompt line
```

The status header follows terminal width and truncates from the right. When the selected model supports thinking, non-muted header text gradients from Pi green to the current thinking-level color; greyed metadata stays dim. The editor keeps Pi's multiline editor behavior while dropping the box frame in favor of a subtle left rail.

## Statusline data

- active directory, git branch, and session name
- token/cache/cost totals
- context usage
- provider/model and thinking level
- extension status icons from `ctx.ui.setStatus()` — e.g. `pi-codex-fast`'s `⚡`

## Input rail

Extends Pi's `CustomEditor`, so normal editor behavior is preserved:

- submit, Esc, Ctrl-D, model shortcuts
- autocomplete and slash menu
- paste/history/cursor/IME behavior
- thinking-level rail color

## Working spinner

Replaces the default `⠋ Working...` loader via `ctx.ui.setWorkingIndicator()` with a Crush-inspired cycling-character ribbon — no label, no ellipsis, just the animation:

- a 10-cell ribbon of cycling glyphs (`0-9 a-f A-F ~!@#$%^&*()+=_-`)
- gradient mirrors the sidebar header: solid Pi accent when thinking is off, accent → current thinking-level color when on
- staggered birth phase: each cell starts as `.` and ignites into the cycle on its own random offset
- 20 fps, 40 pre-rendered frames, regenerated on `before_agent_start` / `model_select` so the gradient tracks the live thinking level

## Usage

```bash
pi -e ./extensions/pi-minimal-ui
```

Or install/load as a bundled package via this flake.
