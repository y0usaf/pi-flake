# pi-input-box

Minimal Pi extension that replaces the default editor with a centered, square-corner, compact input box.

```text
                         ┌──────────────────────────────────────────────┐
                         │ ask pi something                             │
                         └──────────────────────────────────────────────┘
```

It extends Pi's `CustomEditor`, so normal editor behavior is preserved:

- submit, Esc, Ctrl-D, model shortcuts
- autocomplete and slash menu
- paste/history/cursor/IME behavior
- thinking-level border color

## Usage

```bash
pi -e ./extensions/pi-input-box
```

Or install/load as a bundled package via this flake.
