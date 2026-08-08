# pi-prime-tools

Minimalist left-rail frames for Pi's builtin tool rows — `bash`, `write`, `grep`, `find`, `ls` — and the `js` kernel tool (skinned here, registered by pi-js-kernel).

Each tool call renders as a left rail indented two from the margin: bare `+` corner, `|` rail, content indented two, no horizontal strokes, no right rail, no background. State colors the rail (pending=accent, success=dim, error=error).

```
  +
  |  bash $ cargo build
  |  out1
  |  out2
  +
```

Collapsed rows show only the call line inside a closed rail (`  +` / `  |  bash $ cargo build` / `  +`); expanding attaches the output and moves the closing corner to the result. `find`/`ls` results render as flat tree rows (`|--`/`'--`, unicode `├─`/`└─`).

Glyphs come from the shared symbol preset: `PI_SYMBOLS=ascii` gives `+ |`, unicode gives `┌ │`. The flake wrapper forces ascii.

`read` is untouched (builtin syntax-highlighted, line-numbered renderer — a plain rail would lose the highlighting). `edit` is untouched (builtin diff-preview renderer).

Enable with `pi -e ./extensions/pi-prime-tools` (active by default in the flake bundle).

## Credits

Call-row formatting and tree rows are adapted from the earlier pi-prime-tools cell design, which vendored them from [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT, Copyright 2025 Mario Zechner, Copyright 2025-2026 Can Bölük), commit `403931b9`. The rail frame itself is the shared/frame.ts output-block renderer (same vendored source).
