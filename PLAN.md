# PLAN

Active work queue for this repo. The `next` skill (`.pi/skills/next/`)
implements exactly one open item per run; `/loop-next` runs that skill in a
fresh sub-agent until this file has no unchecked boxes.

**Checkbox state lives only in this file.** `extensions/pi-loom/DESIGN.md`
owns the *why* and the per-phase acceptance criteria; its Roadmap section
must not carry unchecked-box markers, because two checklists drift within
one loop iteration. Read the matching DESIGN.md phase before starting an
item.

A checkbox marks a real open work item: a phase, or a phase split into
smaller items when one step cannot land it whole. Notes and already-landed
slices are plain dashes. The driver counts open items with a plain grep that
cannot tell a work item from one quoted in a sentence, so never write a box
marker into prose here — the count would lie.

## Handoff

Last touched: P1 (alias package) landed and is ticked.

What landed. `checks.pi-loom-cli-smoke` in `flake.nix`, driven by the new
`nix/checks/loom-cli-smoke.sh`. It boots the real `loom` wrapper in
`--mode rpc` under a throwaway `HOME` and asserts the three runtime halves
of P1 that a build-only check cannot see: `/workflow` is registered; every
CLI-loaded extension resolves to a store path that appears in the wrapper's
own `-e` flags, with nothing user- or project-scoped (that is the "only the
loom stack" criterion); and a probe workflow dropped into
`<agentDir>/workflows` logs from inside the forked child's vm sandbox and
returns its value. About 4 s in the Nix sandbox, no network, no real API
key — the probe never calls `agent()`.

Gates actually run: `nix build .#checks.x86_64-linux.pi-loom-cli-smoke`
(pass, prints `smoke: /workflow present, stack clean, workflow child
spawned and returned`), `biome lint .` (pass, 1 pre-existing warning),
`nix flake check -L` (pass, all 14 checks).

Evidence for the two P1 criteria that are not expressible as assertions in
that script:

- **`pi` byte-identical.** `nix eval --raw .#pi.drvPath` returns
  `/nix/store/pwzphnn83nnf3c7qb1419fidypp59jmy-pi-0.82.1.drv` both on this
  tree and at `470c359`, the commit before the alias package existed. Same
  derivation, therefore same output.
- **The check actually bites.** Run against a copy of the `loom` script
  with the `PI_WORKFLOW_NODE_PATH` export deleted, it fails with `smoke: no
  log line from inside the workflow child`. That negative control is
  deliberately not in CI: a check asserting that an unsupported
  configuration stays broken becomes a maintenance hazard.

Traps for the next step:

- **Downstream flag renamed.** `~/nixos/hosts/y0usaf-desktop/finix/materialized-packages.nix`
  sets `"extensible-workflows" = true;`. That key no longer exists; it is now
  `loom`. `lib.enabledExtensions` asserts on unknown flags, so the system flake
  fails to evaluate the moment it bumps this input. Flip the flag in the same
  change that bumps the input (the `ship` skill does both).
- **Fork identity is still upstream-named on purpose.** package.json is still
  `pi-extensible-workflows@3.4.2`, and the scan-root constants still resolve
  `<agentDir>/pi-extensible-workflows/{SYSTEM.md,roles}`. Renaming moves paths
  inside the user's agent dir, so it must land with the system flake, not
  before. Rationale is in DESIGN.md under Architecture.
- The ref tree is no longer a package and is excluded from `biome.jsonc`;
  keep it that way, it is only a diff base for upstream fixes.
- **Two facts the smoke harness depends on.** Pi's agent dir defaults to
  `$HOME/.pi/agent`, not the XDG data path the installed system uses; and an
  RPC `prompt` is refused before command dispatch unless a model resolves
  with a key, which is why the script passes throwaway
  `--provider/--model/--api-key` flags. Reuse the script for P8 rather than
  rediscovering both.

## Current phase

- [x] **P0 — fork + ref reset.** Engine forked to `extensions/pi-loom/`, ref
      tree reset to the `a94500e` vendor import, `packages.pi-loom` builds.
- [x] **P1 — alias package.** `packages.pi-loom-cli` builds the `loom`
      wrapper; `checks.pi-loom-cli-smoke` boots it and proves `/workflow`
      registers, only the wrapper's own extensions load, and a workflow
      child process spawns.
- [ ] **P2 — human primitives.** `human.ask/edit/review` in the DSL,
      backed by `pi-interview` and `$EDITOR`.
- [ ] **P3 — declaration mechanism.** JSON-Schema args in `command.json`,
      generated usage, `/workflows` listing, project-local `.pi/workflows/`
      scan root.
- [ ] **P4 — stage library + `/build` + `/quick`.**
- [ ] **P5 — router + picker.**
- [ ] **P6 — `/wf-new` meta-workflow.**
- [ ] **P7 — ecosystem fill.** `/explore`, `/debug`, `/review`; migrate the
      `ship` and `next` skills to workflows.
- [ ] **P8 — bare-core CI.** `checks.pi-loom-bare`.

Acceptance criteria for every phase above: see the Roadmap section of
`extensions/pi-loom/DESIGN.md`.
