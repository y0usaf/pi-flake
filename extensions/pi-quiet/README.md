# pi-quiet

Minimalist chrome, emoticon soul. The logo header is gone; every surface
that remains carries a small ASCII face:

- **Agent run active** → no loader row; the editor's whole top border
  pulses `dim → muted → accent → muted` until pi is done.
- **Tool rows** → `(>_o) bash $ make`, `(^-^) write`, `(o_O) grep`,
  `(@_@) find`, `(-_-) ls`; a failed row flips to `(x_x)` in the error
  color. Results keep pi's builtin rendering: diffs, highlighting,
  ctrl+o, plus the builtin prompt snippets and guidelines. read/edit are
  untouched — pi-hashline registers those tool names.
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
