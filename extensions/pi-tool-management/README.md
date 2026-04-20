# pi-tool-management

Pi extension that lets you manage this extension's global disabled-tools list from a `/tools` menu and persists it in `~/.pi/agent/tool-settings.json`.

## What it does

- scans the current tool registry each time `/tools` opens
- includes built-ins + tools added by extensions
- persists disabled tools globally in `~/.pi/agent/tool-settings.json`
- reconciles the disabled list on session start, tree navigation, before each agent run, and before each provider request
- keeps unknown disabled tool names so dynamically loaded tools can stay blocked when they appear later
- merges local changes with the latest on-disk settings before saving to reduce cross-process lost updates
- leaves newly introduced tools allowed by default unless they are listed in `disabledTools`
- writes settings atomically to avoid partial/corrupt saves

## Requirements

- Pi / `@mariozechner/pi-coding-agent` `^0.67.0`
- `@mariozechner/pi-tui` `^0.67.0` (provided by compatible Pi extension environments)

## Usage

```bash
# Install as a pi package
pi --install ./extensions/pi-tool-management

# Or load directly for one session
pi -e ./extensions/pi-tool-management/src/index.ts
```

Commands:
- `/tools` — open the global disabled-tools menu
- `/tools-status` — show current settings path + disabled list

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
- `allowed` here means “not blocked by this extension”; another extension can still keep a tool temporarily inactive, or re-add it later depending on hook order
- enforcement is still hook-order dependent: another extension that runs later and rewrites active tools can override this extension’s filtering
- reopening `/tools` rescans the current tool list; if a tool is registered while the menu is already open, close + reopen to refresh it
- unknown disabled tool names are retained even when the current session has not loaded those tools yet
- if a save fails, the extension keeps the last known in-memory settings for the current session and retries persistence on later reconciliations
