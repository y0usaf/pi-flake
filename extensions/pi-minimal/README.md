# pi-minimal

Minimal Pi TUI. Compact tool rows + thinking, fully visible user messages, borderless editor — every feature toggleable at runtime, everything on by default.

## Display

```text
✨ refactor the auth middleware
keep API behavior unchanged
add regression coverage

✓ ◰ read src/auth.ts:1-20 · 20 lines
✓ $ bash git status · 3 lines
✓ ✎ edit src/auth.ts · +4 -2
⠹ ⌕ grep TODO @ .
∴ thought · 12s

> ask pi to
| refactor this
~/Dev/pi-flake (main)
```

- Tool rows: single explicit line, status-first — `✓`/`✕` glyph (or braille spinner while running), icon + name + argument summary + outcome. Expand with Pi's native tool-expansion key for original output.
- Edit outcomes: diff counts colored per theme (`+4` success, `-2` error).
- Long paths middle-truncate (`packages/…/tools/read.ts`) so the basename stays visible; truncated text elsewhere is hard-cut, no `…` suffix.
- User messages: full, unclipped input with original line breaks and terminal wrapping; bold terminal bright-yellow `✨` prefix + blank line.
- Thinking: spinner + live elapsed time while streaming, `∴ thought · 12s` when done (`compact`); historic rows without timing fall back to char count. Full block (`normal`) or gone (`hidden`); Pi's native `Ctrl-T` hide still wins.
- Editor: borderless `>` / `|` prompt, footer unchanged.

Rows use active Pi theme for tool/thinking colors; user messages use terminal bright-yellow palette for Kimi-style emphasis.

## Commands

```text
/minimal                                   status of all features
/minimal tools on|off|toggle               compact tool rows
/minimal user on|off|toggle                unclipped user messages
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
