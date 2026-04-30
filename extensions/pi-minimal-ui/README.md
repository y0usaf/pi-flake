# pi-minimal-ui

Minimal Pi UI extension that combines:

- a centered statusline above the editor that wraps to multiple lines when needed
- a centered, square-corner, compact input box
- hidden default footer

```text
                         [~/Dev/pi-flake ·  main] [↑12k ↓2k $0.043 18.4%/272k] [openai-codex/gpt-5.5 · high · ⚡]
                         ┌──────────────────────────────────────────────┐
                         │ ask pi something                             │
                         └──────────────────────────────────────────────┘
```

Both components share the same width policy: 90% terminal width, max 100 columns, min 24 columns. Statusline overflow wraps bracketed groups onto additional lines before truncating a group that is individually wider than the shared width.

## Statusline data

- active directory, git branch, and session name
- token/cache/cost totals
- context usage
- provider/model and thinking level
- extension status icons from `ctx.ui.setStatus()` — e.g. `pi-codex-fast`'s `⚡`

## Input box

Extends Pi's `CustomEditor`, so normal editor behavior is preserved:

- submit, Esc, Ctrl-D, model shortcuts
- autocomplete and slash menu
- paste/history/cursor/IME behavior
- thinking-level border color

## Usage

```bash
pi -e ./extensions/pi-minimal-ui
```

Or install/load as a bundled package via this flake.
