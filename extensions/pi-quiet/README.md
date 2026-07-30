# pi-quiet

Minimalist chrome. The logo header is gone; what remains:

- **Agent run active** → no loader row; the editor's whole top border
  pulses `dim → muted → accent → muted` until pi is done.
- **Editor (idle)** → `(^-^) ─────` as the top border, bottom border
  gone. The face wears the editor border color, which pi drives from the
  thinking level — the smiley doubles as your thinking indicator.
- **Hidden thinking** → no label at all; a hidden thinking run leaves one
  blank line. `ctrl+t` toggles the full thinking text back on.
- **Tool rows** → untouched. Quiet registers no tools, so builtin rows
  keep their diffs, syntax highlight, bash elapsed timer and `ctrl+o`
  expansion, and rows owned by other extensions stay consistent with
  them.

Footer stays pi's default. Constants at the top of `quiet.ts` hold the
face and the pulse ramp; one interval drives the border pulse while a run
is active.

## Usage

Bundled via pi-flake. Opt in while `testing`:

```nix
programs.pi.extensions.quiet = true;
```

Or standalone: `pi -e extensions/pi-quiet/extensions/quiet.ts`
