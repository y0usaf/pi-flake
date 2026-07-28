---
name: next
description: >-
  Implement exactly one open item from this repository's root PLAN.md, validate
  it through the Nix flake, commit it, and hand off to the following step. Use
  when asked to "do the next thing", "work the plan", "continue the roadmap", when
  invoked as /skill:next, or when driven by the /loop-next workflow. Scoped to
  pi-flake: acceptance is `nix build` / `nix flake check`, never cargo or npm.
compatibility: Requires git, Nix with flakes enabled, and a root PLAN.md. Repo-local skill; do not copy to projects with different acceptance gates.
metadata:
  author: y0usaf
  version: "1"
---

# Next

Advance `PLAN.md` by exactly one item per run.

## Execution contract

- Do **one** open item. Not two. A step that lands one item cleanly beats a
  step that half-lands three.
- Work autonomously. Do not stop to ask for a plan or routine confirmation.
- **Never report a check as passing unless you ran it and saw it pass.** If a
  gate is too slow or fails for unrelated reasons, say so in the handoff and
  in your step summary. Fabricated evidence is worse than a blocked step.
- Never discard user work: no `reset --hard`, no `clean`, no force push, no
  blanket `stash`, no destructive checkout.
- Commit only the work of this step. If the tree is dirty when you start with
  changes you did not make, stop and report rather than sweeping them into
  your commit.
- Do not push. `/loop-next` runs many steps; pushing is a separate decision.

## Acceptance gates

Doctrine 07 (Nix as source of truth): validate through the flake, not the
language's native tool. This repo has no Rust and no test runner of its own.

```bash
nix build .#<package>          # fast targeted gate while iterating
nix flake check                # full gate, 13 checks, run before committing
biome lint .                   # what checks.biome-lint runs; fastest lint signal
```

`nix flake check` builds every package including `pi-build`, so the first run
after a dependency change is slow (tens of minutes cold, under a minute warm).
Prefer targeted `nix build` while iterating; run the full check once before you
commit.

If `nix flake check` cannot complete in the time available, commit only if the
targeted builds for everything you touched pass, and record in the handoff
exactly which gate was skipped and why.

## Workflow

### 1. Orient

```bash
git -C . status --short --branch
git log -8 --oneline
```

Read `PLAN.md` top to bottom. Its **Handoff** section is the previous step's
message to you: ordering traps, partially landed slices, skipped gates. Trust
it over your own assumptions about repo state.

The tree must be clean before you change anything. If it is not, and the
changes are not yours, stop: report `committed: false` and describe what you
found, unchanged.

### 2. Pick one item

Take the **topmost unchecked box** in `PLAN.md` unless the Handoff explicitly
redirects you. Then read the matching phase in `extensions/pi-loom/DESIGN.md`
under Roadmap: that is where the acceptance criteria live, and PLAN.md
deliberately does not repeat them.

If the item is too large to land in one step, split it in `PLAN.md` into
checkbox sub-items, implement the first, and leave the rest open. The open-box
count rising is correct and expected; the loop only stops at zero or on a
failed commit.

### 3. Implement

Follow `AGENTS.md` in the repo root and the design canon it points at. Keep the
change focused and preserve unrelated work. Credit vendored extensions by name
(`@extensions/<owner>_<name>/`).

### 4. Validate

Run the targeted build for everything you touched, then `nix flake check`.
Paste real command output into your reasoning. If a check fails, fix it or
revert your change — do not check the box.

### 5. Close the loop

Update `PLAN.md` in the same commit as the work:

- Tick the box **only if** the DESIGN.md acceptance criteria are actually met.
  If you landed part of it, leave the box open and record what landed as
  plain sub-bullets, so the next step does not redo it.
- Rewrite the **Handoff** section to describe this step: what landed, which
  gates you ran, which you skipped, and any ordering trap you discovered.
  Replace it; do not append a growing log.
- Never write a literal unchecked-box marker into prose anywhere in
  `PLAN.md`. The driver counts open items with a plain grep and cannot tell a
  work item from one quoted in a sentence.

Commit with a Conventional Commits subject matching repo history
(`feat(scope):`, `fix(scope):`, `refactor(scope):`, `chore(deps):`), and a body
explaining the mechanism and why this approach, not just what changed.

### 6. Report

Before finishing, run and report the exact count:

```bash
grep -c '\[ \]' PLAN.md || true
```

Report it as `openBoxes`. Report `committed: true` only if `git log -1` shows
your commit and `git status --porcelain` is empty.
