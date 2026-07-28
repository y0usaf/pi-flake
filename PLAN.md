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

Last touched: scaffolding commit. `/loop-next` had stopped early because
this file did not exist and no `next` skill was installed; the roadmap
lived in DESIGN.md where the driver could not see it.

Tree state: clean. Two commits landed the prior WIP —
`refactor(workflows): source workflows from agentDir, not the package`
and `feat(pi-loom): design doc and pi-loom-cli alias package`.

Ordering note that will bite: **P1 landed before P0.** `packages.pi-loom-cli`
composes the unforked `pi-extensible-workflows` package. P0 must swap that
entry for the `pi-loom` fork and add `pi-loom-builtins` + `pi-loom-router`;
the placeholder is marked in `flake.nix` next to `loomStack`.

## Current phase

- [ ] **P0 — fork + ref reset.** Copy vendored source to
      `extensions/pi-loom/` (currently DESIGN.md only), replay the four
      local commits there, hard-reset the vendored tree to pristine
      upstream 3.4.2.
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
