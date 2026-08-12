# pi-management

Pi extension that manages two global disable-lists from menus and persists each
in its own JSON file:

- `/tools` — disabled **tools**, in `~/.pi/agent/tool-settings.json`
- `/extensions` — disabled **extensions**, in `~/.pi/agent/extension-settings.json`

Merged from the former `pi-tool-management` and `pi-extension-management`. Both
settings files keep their original names and keys, so existing files work
unchanged with no migration.

## Layout

| File | Role |
| --- | --- |
| `src/store.ts` | Shared versioned JSON list store: atomic write, serialized saves, deduped load warnings |
| `src/tools.ts` | Tool registry scan + active-set enforcement, `/tools` and `/tools-status` |
| `src/extensions.ts` | Filesystem extension discovery + projections, `/extensions` and `/extensions-status` |
| `src/index.ts` | Registers both |

`store.ts` takes the file name and the array key as parameters. That is the only
reason the two domains can share it: the on-disk shapes differ solely in which
key holds the list.

## Requirements

- Pi / `@earendil-works/pi-coding-agent` `^0.74.0`
- `@earendil-works/pi-tui` `^0.74.0` (provided by compatible Pi extension environments)

## Usage

```bash
# Install as a pi package
pi install ./extensions/pi-management

# Or load directly for one session
pi -e ./extensions/pi-management/src/index.ts
```

Commands:

- `/tools` — open the global disabled-tools menu
- `/tools-status` — settings path, disabled list, tools blocked externally
- `/extensions` — open the disabled-extensions menu
- `/extensions-status` — settings path, `PI_EXT_DISABLED`, bundle roots, discovered extensions

## Tools

- scans the tool registry each time `/tools` opens: built-ins plus tools added by extensions
- reconciles the disabled list on session start, tree navigation, before each agent run, and before each provider request
- keeps unknown disabled names so dynamically loaded tools stay blocked when they appear later
- new tools are allowed by default unless listed in `disabledTools`

```json
{
  "version": 1,
  "disabledTools": ["bash", "web_fetch"]
}
```

Notes:

- `allowed` means "not blocked by this extension". When this extension allows a tool but Pi is not currently exposing it, `/tools` shows `blocked (external)` and `/tools-status` lists it under `blockedExternally`
- enforcement is hook-order dependent: an extension that runs later and rewrites active tools can override this filtering
- if a tool is registered while `/tools` is open, close + reopen to refresh
- only tools are managed; extension commands, hooks, and UI stay loaded

## Extensions

Discovery mirrors pi's own three sources: `PI_DEFAULT_PACKAGES` bundle roots,
`~/.pi/agent/extensions/`, and `<cwd>/.pi/extensions/`.

The JSON file is the truth. Two levers read projections of it:

- **bundle** extensions — the `PI_EXT_DISABLED` env var, read by the
  Nix-generated `.pi-gate.ts` shim on every `/reload`
- **user/project** extensions — `-pattern` entries in pi's own `settings.json`
  `extensions` array, the same lever `pi config` uses

```json
{
  "version": 1,
  "disabledExtensions": ["caveman", "extensions/scratch.ts"]
}
```

Notes:

- `SELF_NAME` in `src/extensions.ts` is `"management"` and hides this extension from its own menu. It **must** match the bundle attribute name in the root `flake.nix`; if it drifts you can disable the manager and lock yourself out of both menus, recoverable only by hand-editing `extension-settings.json`
- toggling saves to disk, updates the env, then `waitForIdle` + `reload`, in that order — a reload re-reads the file, so a still-queued save would revert the toggle

## Both

- settings are global to the current Pi agent home (`~/.pi/agent`) and shared across projects
- malformed or unreadable settings keep the last-known-good in-memory state and warn once; the matching `*-status` command keeps the warning visible
- deleting a settings file resets that in-memory list on the next load
- saves are serialized and atomically replace the file; a failed save leaves in-memory changes active for the session, and the next toggle retries
