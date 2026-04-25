# pi-compact

Pi extension: compact chat rendering for Pi's interactive TUI.

## What it does

- patches Pi's interactive tool-row renderer
- tool calls → configurable: Pi default, borderless, or one width-aware summary line
- edit results → compact `+N -N` diff counts instead of success prose
- expanded tool calls → original rendering/output
- thinking blocks → compact elapsed-seconds + character-count row by default
- user messages → configurable: Pi default, borderless markdown, or fully compact one-line summaries; optional plain gap line

## Configuration

Defaults: `tools.mode="compact"`, `tools.gap=false`, `user.mode="borderless"`, `user.gap=true`, `thinking.mode="compact"`.

Pi settings (`~/.pi/agent/settings.json` or `.pi/settings.json`) under `extensionSettings`:

```json
{
  "extensionSettings": {
    "pi-compact": {
      "tools": {
        "mode": "compact",
        "gap": false
      },
      "user": {
        "mode": "borderless",
        "gap": true
      },
      "thinking": {
        "mode": "compact"
      }
    }
  }
}
```

`pi-compact` has exactly three optional config objects: `tools`, `user`, and `thinking`.

Tool/user modes:

| Value | Tool rendering | User rendering |
|---|---|---|
| `normal` | Pi default tool content rendering | Pi default user message content rendering |
| `borderless` | Pi tool rendering with top/bottom background padding removed | Multi-line markdown with top/bottom background padding removed |
| `compact` | One-line tool summary | One-line `› …` summary |

`tools.gap=true` adds/preserves a plain separator line before tool rows. `user.gap=false` removes the plain gap line after borderless/compact user messages. Runtime aliases `borderless-tight` and `compact-tight` set `gap=false`.

`thinking.mode="compact"` → one-line row (`thinking for N.N seconds, N characters` → `thought for N.N seconds, N characters`). `thinking.mode="normal"` → Pi default rendering.

Colours come from the active Pi theme. Customize them with Pi themes, not this extension.

Project settings override global settings per nested option.

Toggle at runtime:

```text
/compact-user normal|borderless|borderless-tight|compact|compact-tight|gap|no-gap|toggle|cycle|status
/compact-tools normal|borderless|borderless-tight|compact|compact-tight|gap|no-gap|toggle|cycle|status
/compact-thinking normal|compact|toggle|status
/compact-status
```

## Scope

This is UI-only. Tool execution, user messages, and conversation context are unchanged.

Tool compaction covers built-ins and extension tools such as:
- `agent_task` / `report`
- `web_fetch`
- `web_search` / `web_browse`

## Limitation

Pi still renders one row per tool call, so this cannot merge multiple sibling tool calls into one physical terminal line. That still needs an upstream layout change.

## Usage

```bash
pi -e ./extensions/pi-compact/src/index.ts
```

Or install/load as a Pi package.
