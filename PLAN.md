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

Last touched: P0 (fork + ref reset) landed and is ticked.

What landed. `extensions/pi-loom/` now holds the engine source (the four
local commits, unchanged) and `extensions/vekexasia_pi-extensible-workflows/`
is back at its vendor-import state `a94500e`: `git diff a94500e -- <ref tree>`
is empty, and only the four files those commits touched differ between the two
trees (`execution.ts`, `host.ts`, `types.ts`, `validation.ts`).
`packages.pi-extensible-workflows` is gone, replaced by `packages.pi-loom`;
`loomStack`, `checks.pi-loom-build`, `lib.extensionPackagesFor`, the NixOS
option, and both workflow READMEs point at it.

Gates actually run: `nix build .#pi-loom` (pass), `biome lint .` (pass, 1
pre-existing warning), `nix flake check -L` (pass, "all checks passed!").
Extra evidence for the "`/ideate` and `/loop-next` still run" criterion, which
needs an interactive session that CI cannot give: `diff -r` between the old
`pi-extensible-workflows` store output built from commit `2b43eef` and the new
`pi-loom` output is empty, so the fork ships byte-identical bytes to the engine
that is running this loop. A real interactive run is still owed; it is folded
into the P1 runtime-acceptance sub-item below.

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

## Current phase

- [x] **P0 — fork + ref reset.** Engine forked to `extensions/pi-loom/`, ref
      tree reset to the `a94500e` vendor import, `packages.pi-loom` builds.
- [ ] **P1 — alias package.** Partially landed; do not redo the Nix work.
  - Landed: `packages.pi-loom-cli` (`writeShellScriptBin "loom"` wrapping
    `pi --no-extensions` with five `-e` flags plus `PI_WORKFLOW_NODE_PATH`)
    and `checks.pi-loom-cli-build`. Verified only that it evaluates and
    builds.
  - Remaining: runtime acceptance — `/workflow` present in `loom`, a
    workflow child process actually spawns, and `pi` byte-identical to
    before (compare store paths across the change).
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
