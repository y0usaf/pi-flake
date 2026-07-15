# pi-compact

Minimal Pi TUI renderer. Tool rows stay explicit without boxes or noise, with theme-aware colour accents.

## Display

Collapsed tools use one plain row:

```text
→ ◰ read src/index.ts:1-20 · ✓ 20 lines
→ $ bash git status · ✓ 3 lines
→ ✎ edit src/index.ts · ✓ +4 -2
→ + write README.md (12 lines) · ✓ written
```

Icons come from the extracted `pi-harness` compact tool renderer:

| Tool | Icon |
|---|---|
| `read` | `◰` |
| `bash` | `$` |
| `edit` | `✎` |
| `write` | `+` |
| `find` / `grep` | `⌕` |
| `ls` | `▦` |
| other tools | `•` |

User messages render as one line with `>`, followed by one blank line. Thinking blocks render as one compact row by default. Pi's native `Ctrl-T` toggle still hides/shows thinking; expand tools with Pi's native tool-expansion key to see original output.
Rows use active Pi theme: accent icons, turn-specific thinking-level prompt marker, dim arguments, semantic pending/success/error status.

## Thinking display

Default mode: `compact`, shown as `∴ thinking · 420 chars` while streaming or `∴ thought · 420 chars` after completion.

Set mode in `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "extensionSettings": {
    "pi-compact": {
      "thinking": { "mode": "compact" }
    }
  }
}
```

Modes: `compact`, `hidden`, `normal`. Project settings override global settings. Runtime: `/compact-thinking compact|hidden|normal|toggle`.

## Scope

UI-only. Tool execution, messages, thinking, and conversation context remain unchanged. Thinking mode only affects display.

Extension tools always show tool name plus generic argument summaries, so unfamiliar tools remain explicit.

## Usage

```bash
pi -e ./extensions/pi-compact/src/index.ts
```

Or install/load as a Pi package.

## Credit

Tool icon vocabulary extracted from `pi-harness/pi-extension/harness-sidechannel.js`.
