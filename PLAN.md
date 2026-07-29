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

Last touched: P4c landed and is ticked. P4 is complete end to end (stage library,
`exec`, `/build`, `/quick`); the next open item is P5 (router + picker).

What landed. A fourth stage, `quick`, in `extensions/pi-loom/src/stages.ts`, and
`workflows/quick/` — `command.json`, `quick.js`, `README.md` — as its only
consumer. One agent, no plan stage, no review stage, and **no worktree**: the
agent edits the user's own checkout and the change is left unstaged in their
tree. `checks.pi-loom-quick-workflow` (`nix/checks/loom-quick-workflow.sh`) is
the gate. DESIGN.md gained the paragraph on why `quick` is `exec`'s opposite and
on exactly what its gate can and cannot prove.

Gates actually run: `nix build .#pi-loom-cli` (pass); the three affected harnesses
by hand against `"$(readlink -f result)/bin/loom"` — quick-workflow, stages,
exec-stage (all pass); `nix flake check -L` (pass, all 14 checks, including
`biome-lint`).

**Acceptance honesty.** DESIGN.md's P4c criterion is that `/quick "<task>"`
completes a one-line change with a single agent, no plan stage and no review
stage. The completed change was **not** observed: it needs an agent to return,
and the nix sandbox has no model key. What was proven is everything around it —
discovery from the installed path, usage rejection before a run exists, exactly
one phase entered (`quick`, never `plan`), zero worktrees opened, and a real
pre-agent working-tree snapshot that left the probe repo's index byte-identical.
A real-model `/quick` run is still worth doing once by hand.

Design decisions worth not re-litigating:

- **No worktree is the feature, not an omission.** DESIGN.md's decision table
  says so directly: plan → exec → review on a typo is ceremony that kills
  adoption. `/quick` stays inside the engine (budgeted, checkpointed, auditable)
  while costing one agent and landing where the user is already looking.
- **The diff still comes from git.** `quick` snapshots the whole working tree
  with `git add -A` + `git write-tree` through a throwaway `GIT_INDEX_FILE`,
  before the agent and again after. The user's index, tree and refs are never
  touched; the only trace is unreferenced objects that `git gc` prunes.
- **Both sides snapshotted the same way.** That is what makes pre-existing dirt
  cancel out of the diff instead of being blamed on the agent. A `git stash
  create` base would have been asymmetric — it excludes untracked files, so every
  file the user had left untracked would have looked like the agent created it.
- **`quick` reuses `EXEC_OUTPUT`.** Both stages ask the agent for `{ summary,
  notes }` only and let git supply `files`/`diff`, so a caller can swap one for
  the other without changing how it reads the artifact.

Traps for the next step:

- **The available-stage assertions are substring matches.** `loom-stages.sh` and
  `loom-exec-stage.sh` matched `*"available stages: plan, exec, review"*`, which
  still passes after a stage is appended — the check silently stops proving the
  list. Both now name all four; a fifth stage must extend them again.
- **Never put a backtick or a `$` followed by `{` inside `STAGE_LIBRARY_SOURCE`.**
  That string is a TS template literal: a backtick ends it (unrelated-looking
  `TS2304: Cannot find name` errors) and a dollar-brace interpolates. Shell inside
  it must use `$(...)` and bare `$var`, which is why the snapshot command reads
  `dir="$(mktemp -d)"` and `"$dir/index"`.
- **`git status` rewrites the index stat cache.** A harness that copies
  `.git/index` and then runs `git status` will see its own bookkeeping as a diff.
  Capture status first, copy the index second, compare in that order.
- **A clean probe repo cannot prove a snapshot happened.** `git write-tree` on an
  unmodified tree reproduces HEAD's existing tree object and writes nothing, so
  the loose-object count assertion needs the probe repo dirtied first (one
  modified tracked file, one untracked file).
- **`workflows/` is not in the `pi-loom` package.** The install path is the
  system flake placing `workflows/*/` into `<agentDir>/workflows/`. A new shipped
  workflow needs a nix check that copies the directory in itself —
  `loom-quick-workflow.sh` takes it as its second argument — and a matching entry
  in `~/nixos/.../modules/dev/pi/workflows.nix`. **`/quick` is not in that file
  yet**; until it is, the user sees `/build` but not `/quick`.
- **The `/workflows` listing has its own customType.** Runs deliver under
  `"customType":"workflow"`, the listing under `"customType":"workflow-list"`. A
  harness waiting on the wrong one burns its whole timeout and then reports an
  empty listing, which looks like a discovery bug and is not one.
- **A failed run is still delivered as a workflow message**, formatted
  `Workflow <name> failed (runId=...): error=<CODE>: <message>; ...; artifacts:
  runDirectory=... statePath=... journalPath=...`. That string is how an offline
  check reads a failure, since nothing completes without a model.
- **The cheapest offline evidence lives in two files per run.** `state.json` has
  `state`, `phase`, `phaseHistory[].phase` and `error.code`; `snapshot.json` has
  `args` *after* argsSchema defaults were applied. Ordering and argument wiring
  are both provable from those without any agent returning.
- **How to reach an agent boundary offline:** pass a model that does not exist.
  `WorkflowAgentExecutor.resolve()` throws `UNKNOWN_MODEL` at the top of
  `execute()`, before the attempt loop, before any session or socket, so there is
  no retry, no backoff and no network.
- **A nix store copy is read-only.** `cp -r ${./workflows/quick} …` then
  `chmod -R u+w` in the harness, or the run store cannot treat it as an install.
- **`local a="$1" b="$work/$a"` in one statement fails under `set -u`.** Bash
  does not expose `a` to the rest of its own `local` statement; the error reads
  `name: unbound variable`. Split the declarations.
- **`extensions/pi-loom/skills/pi-extensible-workflows/SKILL.md` is still
  modified in the working tree and still deliberately uncommitted.** Same state
  as the previous six handoffs: `HEAD` content is byte-identical to the vendored
  upstream copy, the working-tree content is a rewrite by something outside these
  steps. Left untouched again; commits here stage explicit paths, never `-A`.
  Decide what it is before committing it. It also means the agent-facing docs for
  `stage(...)`, `exec`, `/build` and now `quick`/`/quick` were *not* written —
  that file is where they belong.
- **Stages are still invisible to the model.** `workflow_catalog` lists
  registered functions, not stages. Nothing tells an agent that `stage(...)`
  exists, and `STAGE_LIBRARY[].description/required/optional/output` are
  documentation nothing consumes yet. Wiring them into a catalog is a natural P5
  item once the SKILL.md ownership question is settled.
- **The flake only sees git-tracked files.** A new source or check script that is
  not `git add`ed does not exist inside `nix build`. Stage before building.
- **`result` is a relative symlink.** The check harnesses `cd` into a temp
  project, so running one by hand needs `"$(readlink -f result)/bin/loom"`, not
  `./result/bin/loom`.
- **`PI_CODING_AGENT_DIR` leaks into hand-run harnesses.** Inside the nix sandbox
  the agent dir defaults to `$HOME/.pi/agent`, but running a check script from a
  Pi session inherits `PI_CODING_AGENT_DIR` and the user-scope scan finds the real
  agent dir instead of the throwaway one. `loom-workflow-args.sh`,
  `loom-project-workflows.sh`, `loom-stages.sh`, `loom-exec-stage.sh`,
  `loom-build-workflow.sh` and `loom-quick-workflow.sh` export it explicitly; the
  three older harnesses do not.
- **Never `head -1` a presented message.** Usage text and the `/workflows` listing
  are multi-line, so harnesses serialise with `jq -c` before decoding.
- **`inputsSettled()` gates on four parking lots** (checkpoints, questions, edits,
  reviews). Anything that parks a new kind of human input must add its lot there
  or a pending item will look like a running run.
- **Downstream flag renamed.** `~/nixos/hosts/y0usaf-desktop/finix/materialized-packages.nix`
  sets `"extensible-workflows" = true;`. That key no longer exists; it is now
  `loom`. `lib.enabledExtensions` asserts on unknown flags, so the system flake
  fails to evaluate the moment it bumps this input. Flip the flag in the same
  change that bumps the input (the `ship` skill does both).
- **Fork identity is still upstream-named on purpose.** package.json is still
  `pi-extensible-workflows@3.4.2`, and the scan-root constants still resolve
  `<agentDir>/pi-extensible-workflows/{SYSTEM.md,roles}`. Renaming moves paths
  inside the user's agent dir, so it must land with the system flake, not before.
  Rationale is in DESIGN.md under Architecture.
- The ref tree is no longer a package and is excluded from `biome.jsonc`; keep it
  that way, it is only a diff base for upstream fixes.
- **Two facts all nine harnesses depend on.** Pi's agent dir defaults to
  `$HOME/.pi/agent`, not the XDG data path the installed system uses; and an RPC
  `prompt` is refused before command dispatch unless a model resolves with a key,
  which is why the scripts pass throwaway `--provider/--model/--api-key` flags.
  Reuse them for P8 rather than rediscovering both.

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
- [x] **P4a — stage library.** `stage(name, input)` appended to every workflow
      body as hoisted function declarations (`src/stages.ts`), the `plan` and
      `review` stages, a launch-time guard on colliding top-level declarations,
      and `checks.pi-loom-stages` proving all three offline.
- [x] **P4b-i — `exec` stage.** `stage("exec", ...)` implements one plan item
      inside an isolated git worktree (`__stageExec` in `src/stages.ts`) and
      reports the diff git recorded, not the diff the model claims;
      `checks.pi-loom-exec-stage` proves the worktree is open, populated and
      base-recorded before the implementing agent launches.
- [x] **P4b-ii — `/build`.** `workflows/build/` chains plan → exec → review over
      one worktree named `build`, keyed per plan item, with `changes` verdicts
      feeding repair passes; `checks.pi-loom-build-workflow` proves discovery
      from the installed path, usage rejection before a run exists, and
      plan-before-exec ordering. The three artifacts themselves need a real
      model — see the acceptance-honesty note in the handoff.
- [x] **P4c — `/quick`.** `stage("quick", ...)` makes a one-line change with a
      single agent in the user's own checkout — no plan, no review, no worktree —
      and still reports git's diff, taken from working-tree snapshots written to
      a throwaway index before and after the agent; `workflows/quick/` is its
      only consumer and `checks.pi-loom-quick-workflow` proves one phase, no
      worktree and a non-destructive snapshot. The completed change itself needs
      a real model — see the acceptance-honesty note in the handoff.
- [ ] **P5 — router + picker.**
- [ ] **P6 — `/wf-new` meta-workflow.**
- [ ] **P7 — ecosystem fill.** `/explore`, `/debug`, `/review`; migrate the
      `ship` and `next` skills to workflows.
- [ ] **P8 — bare-core CI.** `checks.pi-loom-bare`.

Acceptance criteria for every phase above: see the Roadmap section of
`extensions/pi-loom/DESIGN.md`.
