# pi-minimal

Minimal Pi TUI. Compact tool rows, one-line user messages, compact thinking, borderless editor — every feature toggleable at runtime, everything on by default.

## Display

```text
> refactor the auth middleware

→ ◰ read src/auth.ts:1-20 · ✓ 20 lines
→ $ bash git status · ✓ 3 lines
→ ✎ edit src/auth.ts · ✓ +4 -2
∴ thought · 420 chars

> ask pi to
| refactor this
~/Dev/pi-flake (main)
```

- Tool rows: single explicit line, icon + name + argument summary + status. Expand with Pi's native tool-expansion key for original output.
- User messages: one `>` line + blank line.
- Thinking: one `∴` row (`compact`), full block (`normal`), or gone (`hidden`). Pi's native `Ctrl-T` hide still wins.
- Editor: borderless `>` / `|` prompt, footer unchanged.

Rows use the active Pi theme: accent icons, thinking-level prompt marker, dim arguments, semantic pending/success/error status.

## Commands

```text
/minimal                                   status of all features
/minimal tools on|off|toggle               compact tool rows
/minimal user on|off|toggle                one-line user messages
/minimal thinking normal|compact|hidden    thinking display
/minimal thinking on|off|toggle            feature off = normal
/minimal editor on|off|toggle              borderless editor
```

`/compact-thinking` remains as an alias for `/minimal thinking …`.

Command toggles last for the session. Persistent defaults via `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "extensionSettings": {
    "pi-minimal": {
      "tools": true,
      "user": true,
      "thinking": { "mode": "compact" },
      "editor": true
    }
  }
}
```

Project settings override global settings. The legacy `pi-compact` key is still read for the thinking mode.

## Scope

UI-only. Tool execution, messages, thinking, and conversation context remain unchanged; display modes affect rendering only.

## Usage

```bash
pi -e ./extensions/pi-minimal/src/index.ts
```

Or install/load as a Pi package.

## Credit

Tool icon vocabulary extracted from `pi-harness/pi-extension/harness-sidechannel.js`.
