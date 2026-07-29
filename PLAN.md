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

Last touched: P4b-ii landed and is ticked. P4b is now complete; the next open
item is P4c (`/quick`).

What landed. `workflows/build/` — `command.json`, `build.js`, `README.md` — the
`/build` workflow: plan once, then per plan item exec followed by review, all
exec calls sharing one worktree named `build`. It owns no prompt of its own;
every prompt comes from the stage library. A `changes` verdict feeds the review
note back into a repair exec, up to `maxFixes` (default 1); a `reject` ends that
item. The return value is keyed per item (`items[]`, plus a `verdicts` map and
`counts`). `checks.pi-loom-build-workflow` (`nix/checks/loom-build-workflow.sh`)
is the gate. DESIGN.md gained a paragraph on /build's verdict policy and on
exactly what its gate can and cannot prove.

Gates actually run: `nix build .#pi-loom-cli` (pass), the check by hand against
`"$(readlink -f result)/bin/loom"` (pass),
`nix build .#checks.x86_64-linux.pi-loom-build-workflow -L` (pass),
`nix flake check -L` (pass, all checks; `biome lint .` unchanged at 1
pre-existing warning and 5 infos).

**Acceptance honesty.** DESIGN.md's P4b-ii criterion is that `/build "<task>"`
emits a plan artifact, an exec diff and a review verdict keyed per plan item.
Those three artifacts were **not** observed: every one needs an agent to have
returned, and neither the nix sandbox nor this step had a model key. What was
proven is the wiring around them — discovery from the installed path, argument
rejection with generated usage, and plan-before-exec ordering. DESIGN.md's own
P4b split rationale says this half's acceptance needs a real model, so the box
is ticked on that reading. A real-model `/build` run is still worth doing once
by hand before trusting it.

Design decisions worth not re-litigating:

- **One worktree for the whole run.** Every exec call passes `worktree: "build"`,
  and the engine keys worktrees by name, so item 2 builds on item 1. Each item
  still reports only its own diff because exec takes its base commit at its own
  start and the engine commits the worktree as each agent returns.
- **`changes` retries, `reject` does not.** A `changes` note says what to fix, so
  it is actionable context for another exec pass. `reject` means the approach is
  wrong; another blind pass entrenches it. Rejected items stay in the report with
  their verdict.
- **Report diffs are clipped twice.** exec caps its diff at 200000 characters;
  /build clips again at 20000 per item for the returned report, keeping
  `diffChars` and `diffTruncated`. Full diffs live on the engine-owned branch
  named in `worktree.branch`.
- **The reviewer is shown the diff, not the summary.** `reviewSubject()` passes
  exec's full (exec-capped) diff into the review stage. Reviewing a summary is
  reviewing a claim.
- **Empty string means "not given" for `model`.** The stage library omits an
  empty model rather than validating it, so `reviewModel` defaulting to `model`
  defaulting to `""` leaves the session default intact.

Traps for the next step:

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
- **`workflows/` is not in the `pi-loom` package.** The install path is the
  system flake placing `workflows/*/` into `<agentDir>/workflows/`. A new shipped
  workflow therefore needs a nix check that copies the directory in itself —
  `loom-build-workflow.sh` takes it as its second argument — and a matching
  entry in `~/nixos/.../modules/dev/pi/workflows.nix` before a user sees it.
- **A nix store copy is read-only.** `cp -r ${./workflows/build} …` then
  `chmod -R u+w` in the harness, or the run store cannot treat it as an install.
- **`local a="$1" b="$work/$a"` in one statement fails under `set -u`.** Bash
  does not expose `a` to the rest of its own `local` statement; the error reads
  `name: unbound variable`. Split the declarations.
- **Never put a backtick inside `STAGE_LIBRARY_SOURCE`.** That string is a TS
  template literal, so a backtick in a sandbox-side comment ends it and the build
  fails with unrelated-looking `TS2304: Cannot find name` errors.
- **The stage list is asserted as a literal string.** `loom-stages.sh` matches
  `available stages: plan, exec, review`. Adding or reordering a stage means
  updating that assertion in the same commit.
- **`extensions/pi-loom/skills/pi-extensible-workflows/SKILL.md` is still
  modified in the working tree and still deliberately uncommitted.** Same state
  as the previous five handoffs: `HEAD` content is byte-identical to the vendored
  upstream copy, the working-tree content is a rewrite by something outside these
  steps. Left untouched again; commits here stage explicit paths, never `-A`.
  Decide what it is before committing it. It also means the agent-facing docs for
  `stage(...)`, `exec` and now `/build` were *not* written — that file is where
  they belong.
- **Stages are still invisible to the model.** `workflow_catalog` lists
  registered functions, not stages. Nothing tells an agent that `stage(...)`
  exists, and `STAGE_LIBRARY[].description/required/optional/output` are
  documentation nothing consumes yet. Wiring them into a catalog is a natural
  P5 item once the SKILL.md ownership question is settled.
- **The flake only sees git-tracked files.** A new source or check script that is
  not `git add`ed does not exist inside `nix build`. Stage before building.
- **`result` is a relative symlink.** The check harnesses `cd` into a temp
  project, so running one by hand needs `"$(readlink -f result)/bin/loom"`, not
  `./result/bin/loom`.
- **`PI_CODING_AGENT_DIR` leaks into hand-run harnesses.** Inside the nix sandbox
  the agent dir defaults to `$HOME/.pi/agent`, but running a check script from a
  Pi session inherits `PI_CODING_AGENT_DIR` and the user-scope scan finds the real
  agent dir instead of the throwaway one. `loom-workflow-args.sh`,
  `loom-project-workflows.sh`, `loom-stages.sh`, `loom-exec-stage.sh` and
  `loom-build-workflow.sh` export it explicitly; the three older harnesses do not.
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
- **Two facts all eight harnesses depend on.** Pi's agent dir defaults to
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
- [ ] **P4c — `/quick`.**
- [ ] **P5 — router + picker.**
- [ ] **P6 — `/wf-new` meta-workflow.**
- [ ] **P7 — ecosystem fill.** `/explore`, `/debug`, `/review`; migrate the
      `ship` and `next` skills to workflows.
- [ ] **P8 — bare-core CI.** `checks.pi-loom-bare`.

Acceptance criteria for every phase above: see the Roadmap section of
`extensions/pi-loom/DESIGN.md`.
