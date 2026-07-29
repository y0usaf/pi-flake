# pi-quiet

Minimalist chrome, emoticon soul. The logo header is gone; every surface
that remains carries a small ASCII face:

- **Streaming** → a blinking face: `(o_o)` … `(-_-)`
- **Tool rows** → `(>_o) bash $ make`, `(^-^) write`, `(o_O) grep`,
  `(@_@) find`, `(-_-) ls`. Results keep pi's builtin rendering: diffs,
  highlighting, ctrl+o. read/edit are untouched — pi-hashline owns those
  tool names, and tool registration is exclusive per name.
- **Editor** → `(^-^) ─────` as the top border, bottom border gone. The
  face wears the editor border color, which pi drives from the thinking
  level — the smiley doubles as your thinking indicator.
- **Hidden thinking** → random flavor label per session ("scheming...").

Footer stays pi's default. All personality is data tables at the top of
`quiet.ts` — swap a row, change the character. No timers, no
subscriptions.

## Usage

Bundled via pi-flake. Opt in while `testing`:

```nix
programs.pi.extensions.quiet = true;
```

Or standalone: `pi -e extensions/pi-quiet/extensions/quiet.ts`
