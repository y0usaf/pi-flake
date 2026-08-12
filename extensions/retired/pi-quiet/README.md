# pi-quiet

Oh-My-Posh-style two-line prompt. The logo header is gone; what remains:

- **Status bar** → the editor's top border is a live OMP bar:
  `╭─ pi ❯ [M] <model> - [thinking] ❯ [T] ~/cwd ❯ ctx: %/window ❯ $cost ❯─╮`
  It shows the current model (and thinking level when applicable), the
  session cwd, context usage, and cumulative session spend.
- **Face input line** → the first editor line is prefixed with `(^-^)`,
  so idle input reads `(^-^) <type here>`.
- **Agent run active** → the bar (and face) pulse
  `dim → muted → accent → muted` until pi is done; the bar IS the working
  indicator, so there is no loader row.
- **Hidden thinking** → no label at all; a hidden thinking run leaves one
  blank line. `ctrl+t` toggles the full thinking text back on.
- **Footer** → pi's default footer is untouched.
- **Tool rows** → untouched. Quiet registers no tools, so builtin rows
  keep their diffs, syntax highlight, bash elapsed timer and `ctrl+o`
  expansion, and rows owned by other extensions stay consistent with
  them.

Constants at the top of `quiet.ts` hold the face and the pulse ramp; one
interval drives the pulse while a run is active.

## Usage

Bundled via pi-flake. Opt in while `testing`:

```nix
programs.pi.extensions.quiet = true;
```

Or standalone: `pi -e extensions/pi-quiet/extensions/quiet.ts`
