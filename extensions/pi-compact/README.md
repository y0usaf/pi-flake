# pi-compact

Pi extension: compact chat rendering for Pi's interactive TUI.

## What it does

- patches Pi's interactive tool-row renderer
- collapsed tool calls → one width-aware summary line
- expanded tool calls → original rendering/output
- optional user inputs → one width-aware summary line

## Configuration

Defaults: `tools=true`, `user=false`, colours = Pi theme defaults.

Pi settings (`~/.pi/agent/settings.json` or `.pi/settings.json`):

```json
{
  "pi-compact": {
    "user": true,
    "tools": true,
    "tool_colour": "#1e293b",
    "user_colour": "#312e81"
  }
}
```

`tool_colour` / `user_colour` are optional compact-row background colours. Invalid/missing hex → Pi theme default.

Precedence for `user`: CLI flag → env → project settings → global settings → off.

Enable user compaction with CLI/env:

```bash
pi -e ./extensions/pi-compact/src/index.ts --compact-user-inputs
PI_COMPACT_USER_INPUTS=1 pi -e ./extensions/pi-compact/src/index.ts
```

Toggle at runtime:

```text
/compact-user-inputs on|off|toggle|status
/compact-tools on|off|toggle|status
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
