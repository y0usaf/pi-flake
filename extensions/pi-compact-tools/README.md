# pi-compact-tools

Pi extension: collapsed tool executions render as a single compact summary line.

## What it does

- patches Pi's interactive tool-row renderer
- applies to built-ins + extension tools
- collapsed view → one summary line per tool call
- expanded view → original tool rendering/output

## Scope

This is UI-only. Tool execution/behavior is unchanged.

It covers built-ins and extension tools such as:
- `spawn_agent` / `delegate` / `kill_agent` / `list_agents`
- `web_fetch`
- `web_search` / `web_browse`

## Limitation

Pi still renders one row per tool call, so this cannot merge multiple sibling tool calls into one physical terminal line. That still needs an upstream layout change.

## Usage

```bash
pi -e ./extensions/pi-compact-tools/src/index.ts
```

Or install/load as a Pi package.
