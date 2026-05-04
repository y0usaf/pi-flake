# pi-minimal-ui

Minimal Pi UI extension with compact, Crush-inspired chrome:

- a full-width header above the editor with a thinking-level gradient diagonal rule
- a prompt rail (`:::`) instead of a detached centered box, so the editor aligns with the chat flow
- hidden default footer
- a Crush-style cycling-ribbon spinner that replaces Pi's default `⠋ Working...` (no label)

```text
pi ╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱ ~/Dev/pi-flake ·  main • ↑12k ↓2k $0.043 18.4%/272k • openai-codex/gpt-5.5 · high • ⚡
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
- a 15-cell ribbon of cycling glyphs (`0-9 a-f A-F ~!@#$%^&*()+=_-`)
- gradient mirrors the sidebar header: solid Pi accent when thinking is off, accent → current thinking-level color when on
- deterministic dot-to-ribbon startup phase: it begins from `...............` and then hands off to the seamless loop
- 20 fps, 16 startup frames + seamless loop, regenerated on `before_agent_start` / `model_select` so the gradient tracks the live thinking level

## Usage

```bash
pi -e ./extensions/pi-minimal-ui
```

Or install/load as a bundled package via this flake.

## Configuration

Override the Pi base color (`accent`) and per-thinking-level colors via Pi's settings file under `extensionSettings["pi-minimal-ui"]`. Global lives at `~/.pi/agent/settings.json`, project lives at `<repo>/.pi/settings.json`; project wins, `thinking` keys merge.

```jsonc
// ~/.pi/agent/settings.json
{
  "$schema": "./extensions/pi-minimal-ui/pi-minimal-ui.schema.json", // optional, for editor IntelliSense
  "extensionSettings": {
    "pi-minimal-ui": {
      "colors": {
        "pi": "#00c878",
        "thinking": {
          "off":     "#888888",
          "minimal": "#a0e0ff",
          "low":     "#80c0ff",
          "medium":  "#a080ff",
          "high":    "#ff80a0",
          "xhigh":   "#ff8060"
        }
      }
    }
  }
}
```

Values are CSS hex (`#RGB` or `#RRGGBB`, leading `#` optional). Unset keys fall back to the active theme. Settings are re-read on `session_start`, `before_agent_start`, and `model_select`, so edits take effect on the next turn without a restart.

Where each color is used:

- `colors.pi` → header `pi` prefix, edge `///`, diagonal rule, current-path text, header gradient start, spinner solid/start color
- `colors.thinking.<level>` → model-info thinking label + header/spinner gradient end (only when reasoning is on)

Full schema: [`pi-minimal-ui.schema.json`](./pi-minimal-ui.schema.json).


