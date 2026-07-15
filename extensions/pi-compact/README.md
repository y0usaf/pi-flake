# pi-compact

Minimal Pi TUI renderer. Tool rows stay explicit without boxes or noise.

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

User messages render as one line with `>`. Thinking blocks stay hidden in the transcript. Expand tools with Pi's native tool-expansion key to see original output.

No settings, modes, gaps, backgrounds, or runtime commands.

## Scope

UI-only. Tool execution, messages, thinking, and conversation context remain unchanged. Hidden thinking affects display only.

Extension tools always show tool name plus generic argument summaries, so unfamiliar tools remain explicit.

## Usage

```bash
pi -e ./extensions/pi-compact/src/index.ts
```

Or install/load as a Pi package.

## Credit

Tool icon vocabulary extracted from `pi-harness/pi-extension/harness-sidechannel.js`.
