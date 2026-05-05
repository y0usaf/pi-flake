# pi-compact

Pi extension: compact chat rendering for Pi's interactive TUI.

## What it does

- patches Pi's interactive tool-row renderer
- tool calls → configurable: Pi default, hidden, borderless, or one Crush-inspired summary row: `✓ bash ╱ git status`
- edit results → compact `+N -N` line counts from Pi diffs or `pi-hashline` metrics instead of success prose
- expanded tool calls → original rendering/output
- thinking blocks → compact tool-style `🧠 1.2s · 420 chars` row by default, or hidden entirely
- user messages → configurable: Pi default, hidden, borderless markdown, or compact prompt-style `::: …` summaries; optional plain gap line
- `pi-context-janitor` notices → compact one-line `🧹 truncated …` status rows; janitor metadata entries stay hidden

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
| `compact` | One-line `status tool ╱ details` summary | One-line `::: …` summary |
| `hidden` | Suppress tool rows | Suppress user message rows |

`tools.gap=true` adds/preserves a plain separator line before tool rows. `user.gap=false` removes the plain gap line after borderless/compact user messages. Runtime aliases `borderless-tight` and `compact-tight` set `gap=false`; `hide`/`off` alias `hidden`.

`thinking.mode="compact"` → one-line tool-style row (`🧠 1.2s · 420 chars`). `thinking.mode="hidden"` → suppress thinking rows entirely (UI-only; model still thinks). `thinking.mode="normal"` → Pi default rendering.

Colours come from the active Pi theme. Customize them with Pi themes, not this extension.

Project settings override global settings per nested option.

Toggle at runtime:

```text
/compact-user normal|borderless|borderless-tight|compact|compact-tight|hidden|gap|no-gap|toggle|cycle|status
/compact-tools normal|borderless|borderless-tight|compact|compact-tight|hidden|gap|no-gap|toggle|cycle|status
/compact-thinking normal|compact|hidden|toggle|status
/compact-status
```

## Scope

This is UI-only. Tool execution, user messages, thinking, and conversation context are unchanged; `hidden` only affects rendering.

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
