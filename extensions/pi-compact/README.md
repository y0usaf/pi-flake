# pi-compact

Pi extension: compact chat rendering for Pi's interactive TUI.

## What it does

- patches Pi's interactive tool-row renderer
- collapsed tool calls → one width-aware summary line
- edit results → compact `+N -N` diff counts instead of success prose
- expanded tool calls → original rendering/output
- thinking blocks → compact elapsed-seconds + character-count row by default, or fully hidden
- optional user inputs → one width-aware summary line

## Configuration

Defaults: `tools=true`, `thinking="compact"`, `user=true`.

Pi extension settings (`~/.pi/agent/extension-settings.json` or `.pi/extension-settings.json`):

```json
{
  "pi-compact": {
    "user": true,
    "tools": true,
    "thinking": "compact"
  }
}
```

`thinking`: `compact`/`true` → one-line row (`thinking for N.N seconds, N characters` → `thought for N.N seconds, N characters`), `hidden` → no row, `normal`/`false` → Pi default rendering.

Colours come from the active Pi theme. Customize them with Pi themes, not this extension.

Precedence for `user`: CLI flag → env → project settings → global settings → on.

User compaction is on by default. Disable via settings/env or toggle at runtime:

```bash
PI_COMPACT_USER_INPUTS=0 pi -e ./extensions/pi-compact/src/index.ts
```

Toggle at runtime:

```text
/compact-user-inputs on|off|toggle|status
/compact-tools on|off|toggle|status
/compact-thinking compact|hidden|normal|toggle|status
/compact-status
```

## Scope

This is UI-only. Tool execution, user messages, and conversation context are unchanged.

Tool compaction covers built-ins and extension tools such as:
- `spawn_agent` / `delegate` / `kill_agent` / `list_agents`
- `web_fetch`
- `web_search` / `web_browse`

## Limitation

Pi still renders one row per tool call, so this cannot merge multiple sibling tool calls into one physical terminal line. That still needs an upstream layout change.

## Usage

```bash
pi -e ./extensions/pi-compact/src/index.ts
```

Or install/load as a Pi package.
