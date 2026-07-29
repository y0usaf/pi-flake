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

Last touched: P3b landed and is ticked. The next open item is P4 (stage library
+ `/build` + `/quick`).

What landed. A third workflow-command scan root: `<cwd>/.pi/workflows/<name>/`,
so a repo carries its own slash commands. Discovery moved out of `host.ts` into
`src/workflow-commands.ts` (`workflowCommandRoots`, `discoverWorkflowCommands`,
`workflowCommandListing`), which now owns both what a spec means and which
specs exist. New `/workflows` command (plural; `/workflow` singular still
controls runs) prints every scope with its root path, the commands under it,
any shadowed specs and any skipped ones, as a display-only session message
(`present`, `triggerTurn: false`, customType `workflow-list`).

Gates actually run: `nix build .#pi-loom-cli` (pass),
`nix build .#checks.x86_64-linux.pi-loom-project-workflows -L` (pass, prints
`project-workflows: a .pi/workflows command.json reached the palette and ran,
/workflows named every scope, a project spec could not shadow user scope, and a
malformed project spec was skipped without aborting load`), `nix flake check -L`
(pass, all checks, biome unchanged at 1 pre-existing warning + 5 infos).

Design decisions worth not re-litigating:

- **Precedence is first-root-wins, builtin then user then project.** A project
  cannot shadow a name the user already has, so cloning a repo cannot redefine
  `/ship`. Deliberate override stays deferred with installable packs. The
  shadowed spec is reported by `/workflows`, not dropped silently.
- **Project specs fail soft, operator specs fail loud.** A malformed
  `command.json` in a builtin or user root still throws at load; one in the
  project root is collected into `discovery.problems` and listed as skipped, so
  a foreign repo cannot abort extension load.
- **The project root is `process.cwd()`.** Command registration happens at
  extension load, before any `ctx` with a `cwd` exists, and Pi resolves the
  project from the directory it was started in.
- **Project-scope commands refuse to run when `ctx.isProjectTrusted()` is
  false**, but Pi core does not count `.pi/workflows` among the resources that
  trigger a trust prompt (`TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES` is
  settings.json, extensions, skills, prompts, themes, SYSTEM.md,
  APPEND_SYSTEM.md), so a repo whose only `.pi` content is workflows is
  auto-trusted. Discovery never executes a script, so the remaining gate is
  that a human types the command. Recorded in DESIGN.md as residual exposure.

Traps for the next step:

- **`extensions/pi-loom/skills/pi-extensible-workflows/SKILL.md` is still
  modified in the working tree and still deliberately uncommitted.** Same state
  as the previous handoff described: `HEAD` content is byte-identical to the
  vendored upstream copy, the working-tree content is a rewrite by something
  outside these steps (mtime is newer than every commit here). It was left
  untouched again rather than reverted or swept into the commit. Decide what it
  is before committing it.
- **The flake only sees git-tracked files.** A new source or check script that
  is not `git add`ed does not exist inside `nix build`. Stage before building.
- **`result` is a relative symlink.** The check harnesses `cd` into a temp
  project, so running one by hand needs `"$(readlink -f result)/bin/loom"`, not
  `./result/bin/loom`.
- **`PI_CODING_AGENT_DIR` leaks into hand-run harnesses.** Inside the nix
  sandbox the agent dir defaults to `$HOME/.pi/agent`, but running a check
  script from a Pi session inherits `PI_CODING_AGENT_DIR` and the user-scope
  scan finds the real agent dir instead of the throwaway one.
  `loom-workflow-args.sh` and `loom-project-workflows.sh` export it explicitly;
  the three older harnesses do not and will mislead if run by hand.
- **Never `head -1` a presented message.** Usage text and the `/workflows`
  listing are multi-line, so harnesses serialise with `jq -c` before decoding.
- **`inputsSettled()` gates on four parking lots** (checkpoints, questions,
  edits, reviews). Anything that parks a new kind of human input must add its
  lot there or a pending item will look like a running run.
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
- **Two facts all five harnesses depend on.** Pi's agent dir defaults to
  `$HOME/.pi/agent`, not the XDG data path the installed system uses; and an
  RPC `prompt` is refused before command dispatch unless a model resolves
  with a key, which is why the scripts pass throwaway
  `--provider/--model/--api-key` flags. Reuse them for P8 rather than
  rediscovering both.

## Current phase

- [x] **P0 — fork + ref reset.** Engine forked to `extensions/pi-loom/`, ref
      tree reset to the `a94500e` vendor import, `packages.pi-loom` builds.
- [x] **P1 — alias package.** `packages.pi-loom-cli` builds the `loom`
      wrapper; `checks.pi-loom-cli-smoke` boots it and proves `/workflow`
      registers, only the wrapper's own extensions load, and a workflow
      child process spawns.
- [x] **P2a — `human.ask`.** Frozen `human` object in the workflow sandbox,
      `humanBridge` + `journal.awaitingHuman` in the host, `workflow_answer`
      tool as the agent-facing fallback, `checks.pi-loom-human-ask` proving the
      round trip.
- [x] **P2b — `human.edit`.** `ctx.ui.editor` round trip on a text artifact,
      `humanEditBridge` + `journal.awaitingEdit` in the host, `workflow_edit`
      tool as the agent-facing fallback, `checks.pi-loom-human-edit` proving a
      saved edit, an unchanged buffer, and an abandoned editor stay distinct.
- [x] **P2c — `human.review`.** Fixed `approve`/`changes`/`reject` verdict plus
      a free-text note, `humanReviewBridge` + `journal.awaitingReview` in the
      host, `workflow_review` tool as the agent-facing fallback,
      `checks.pi-loom-human-review` proving the note crosses into the next
      stage.
- [x] **P3a — schema-declared args.** `argsSchema` in `command.json`,
      `src/workflow-commands.ts` generating usage and validating every
      invocation, both shipped workflows declaring schemas,
      `checks.pi-loom-workflow-args` proving rejection-with-usage, defaults and
      text-scalar coercion.
- [x] **P3b — project scope.** `<cwd>/.pi/workflows/` as a third scan root,
      scoped discovery in `src/workflow-commands.ts`, a `/workflows` listing
      naming every scope and root, `checks.pi-loom-project-workflows` proving a
      project spec runs, cannot shadow user scope, and cannot abort load.
- [ ] **P4 — stage library + `/build` + `/quick`.**
- [ ] **P5 — router + picker.**
- [ ] **P6 — `/wf-new` meta-workflow.**
- [ ] **P7 — ecosystem fill.** `/explore`, `/debug`, `/review`; migrate the
      `ship` and `next` skills to workflows.
- [ ] **P8 — bare-core CI.** `checks.pi-loom-bare`.

Acceptance criteria for every phase above: see the Roadmap section of
`extensions/pi-loom/DESIGN.md`.
