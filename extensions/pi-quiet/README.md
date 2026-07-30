# pi-quiet

Minimalist chrome, emoticon soul. The logo header is gone; every surface
that remains carries a small ASCII face:

- **Agent run active** → no loader row; the editor's whole top border
  pulses `dim → muted → accent → muted` until pi is done.
- **Tool rows** → dim while running, then `(>_o) bash $ make · ok ·
  ctrl+o`, `(o_O) grep · 14 hits · ctrl+o`, `(@_@) find · 7 found`,
  `(-_-) ls · 12 entries`: success is one line, output hidden behind
  ctrl+o (expanded output sits under a thin `  │ ` rail). A failed row
  flips to `(x_x)` and speaks: full output under an error-colored rail.
  write keeps pi's builtin diff rendering — diffs beat quiet. read/edit
  are untouched — pi-hashline registers those tool names.
- **Editor (idle)** → `(^-^) ─────` as the top border, bottom border
  gone. The face wears the editor border color, which pi drives from the
  thinking level — the smiley doubles as your thinking indicator.
- **Hidden thinking** → no label at all; a hidden thinking run leaves one
  blank line. `ctrl+t` toggles the full thinking text back on.

Footer stays pi's default. All personality is data tables at the top of
`quiet.ts` — swap a row, change the character. One interval drives the
border pulse while a run is active.

## Usage

Bundled via pi-flake. Opt in while `testing`:

```nix
programs.pi.extensions.quiet = true;
```

Or standalone: `pi -e extensions/pi-quiet/extensions/quiet.ts`
