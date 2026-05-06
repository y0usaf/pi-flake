# pi-minimal-editor

Minimal editor-border chrome for Pi.

- keeps Pi's default editor behavior
- replaces only the rendered top/bottom editor borders
- moves footer/status metadata into those borders
- hides the default footer because the data is already in the editor borders
- border chrome uses Pi's thinking-level border color

```text
[pi][~/Dev/pi-flake][ main]────────────────────────────[↑12k ↓2k $0.043 18.4%/272k]
ask pi something
continued prompt line
[openai-codex/gpt-5.5][high]──────────────────────────────────────────────────[⚡]
```

## Border data

- top border: `pi`, cwd, git branch, session name, token/cache/cost totals, context usage
- bottom border: provider/model, thinking level, extension status icons

## Behavior preserved

Extends Pi's `CustomEditor`, so normal editor behavior is preserved:

- submit, Esc, Ctrl-D, model shortcuts
- autocomplete and slash menu
- paste/history/cursor/IME behavior
- multiline editing

## Usage

```bash
pi -e ./extensions/pi-minimal-editor
```

Or install/load as a bundled package via this flake.

## Configuration

Override the Pi base color (`accent`) and per-thinking-level colors via Pi's settings file under `extensionSettings["pi-minimal-editor"]`. Global lives at `~/.pi/agent/settings.json`, project lives at `<repo>/.pi/settings.json`; project wins, `thinking` keys merge.

Legacy `extensionSettings["pi-minimal-ui"]` color settings are also read for compatibility.

```jsonc
// ~/.pi/agent/settings.json
{
  "$schema": "./extensions/pi-minimal-editor/pi-minimal-editor.schema.json", // optional, for editor IntelliSense
  "extensionSettings": {
    "pi-minimal-editor": {
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

Values are CSS hex (`#RGB` or `#RRGGBB`, leading `#` optional). Unset keys fall back to the active theme.

Where each color is used:

- `colors.pi` → `pi` label and current-path text
- `colors.thinking.<level>` → editor border chrome and thinking label

Full schema: [`pi-minimal-editor.schema.json`](./pi-minimal-editor.schema.json).
