# pi-tool-management

Pi extension that lets you manage this extension's global disabled-tools list from a `/tools` menu and persists it in `~/.pi/agent/tool-settings.json`.

## What it does

- scans the current tool registry each time `/tools` opens
- includes built-ins + tools added by extensions
- shows tools that are blocked externally (hidden by another extension or runtime mode)
- persists disabled tools globally in `~/.pi/agent/tool-settings.json`
- reconciles the disabled list on session start, tree navigation, before each agent run, and before each provider request
- keeps unknown disabled tool names so dynamically loaded tools can stay blocked when they appear later
- leaves newly introduced tools allowed by default unless they are listed in `disabledTools`

## Requirements

- Pi / `@earendil-works/pi-coding-agent` `^0.74.0`
- `@earendil-works/pi-tui` `^0.74.0` (provided by compatible Pi extension environments)

## Usage

```bash
# Install as a pi package
pi install ./extensions/pi-tool-management

# Or load directly for one session
pi -e ./extensions/pi-tool-management/src/index.ts
```

Commands:
- `/tools` — open the global disabled-tools menu
- `/tools-status` — show current settings path, disabled list, and tools blocked externally

## Settings file

`~/.pi/agent/tool-settings.json`

```json
{
  "version": 1,
  "disabledTools": ["bash", "web_fetch"]
}
```

Notes:
- settings are global to the current Pi agent home (`~/.pi/agent`) and shared across projects unless you change that home
- only tools are managed; extension commands/hooks/UI stay loaded
- this is this extension's global disabled-tools model: listed tools are removed from the active tool set when this extension's hooks run
- `allowed` means “not blocked by this extension”; when this extension allows a tool but Pi is not currently exposing it (another extension or runtime mode may be hiding it), `/tools` shows it as `blocked (external)` and `/tools-status` lists it under `blockedExternally`
- enforcement is still hook-order dependent: another extension that runs later and rewrites active tools can override this extension’s filtering
- reopening `/tools` rescans the current tool list; if a tool is registered while the menu is already open, close + reopen to refresh it
- unknown disabled tool names are retained even when the current session has not loaded those tools yet
- if a save fails, the extension keeps the in-memory settings for the current session; change a toggle again to retry persistence
