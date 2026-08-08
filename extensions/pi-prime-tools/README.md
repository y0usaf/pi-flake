# pi-prime-tools

Prime-agent-style one-line tool cells for the builtin `bash`, `write`, `grep`, `find`, and `ls` rows, plus the `js` kernel tool (via pi-js-kernel's own renderers).

Each tool call renders as **one status line** — the ipython-cell pattern from prime-agent:

```
✓ bash · $ cargo build · ↓ 42 lines · 3.2s · (ctrl+o to expand)
◇ js · await fetch("https://api") · ↓ 1 line · 0.4s · (ctrl+o to expand)
✗ grep · ls missing · (ctrl+o to expand)
```

The line is identical collapsed or expanded; expanding (toggle tool output) only attaches the output below it. The marker carries the state: queued (muted `…`/`[*]`), running (animated spinner), done (`✓`/`[ok]`), error (`✗`/`[!!]`). All glyphs come from the shared symbol preset, so `PI_SYMBOLS=ascii` swaps markers, spinner, and tree connectors for ASCII.

`find`/`ls` results render as flat tree rows (`├─`/`└─`, ascii `|--`/`'--`) when expanded.

`read` is untouched (pi-hashline owns its hashline frame — a one-line cell would break LINEID anchor alignment). `edit` is untouched (pi's own diff-preview renderer). Both keep their self-shells.

Enable with `pi -e ./extensions/pi-prime-tools` (active by default in the flake bundle).

## Credits

Call-row formatting and tree rows are adapted from pi-frames (retired 2026-08-08), which vendored them from [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT, Copyright 2025 Mario Zechner, Copyright 2025-2026 Can Bölük), commit `403931b9`. The one-line cell layout itself is a port of prime-agent's ipython-cell (`ipython-cell.ts` — collapsed line with marker · preview · stats · duration · expand hint).
