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

Last touched: P4b-i landed and is ticked. P4b was split in two first (P4b-i the
`exec` stage, P4b-ii the `/build` workflow); the next open item is P4b-ii.

What landed. The `exec` stage: `stage("exec", { item, worktree?, context?, model?,
role?, label? })` implements one plan item inside an isolated git worktree and
returns `{ summary, notes, files, diff, diffTruncated, branch, path }`. The agent
is asked only for `summary` and `notes`; `files` and `diff` come from git, so an
unreported edit still shows up. `checks.pi-loom-exec-stage`
(`nix/checks/loom-exec-stage.sh`) is the runtime gate. DESIGN.md now carries the
P4b-i / P4b-ii acceptance criteria and a paragraph on why exec's artifact is
git's word rather than the model's.

Gates actually run: `nix build .#pi-loom` (pass),
`nix build .#checks.x86_64-linux.pi-loom-exec-stage -L` (pass),
`nix build .#checks.x86_64-linux.pi-loom-stages -L` (pass, after updating its
stage-list assertion), `nix flake check -L` (pass, every check including the new
`pi-loom-exec-stage`; `biome lint .` unchanged at 1 pre-existing warning and 5
infos).

Design decisions worth not re-litigating:

- **exec takes its base commit before the agent exists.** `git rev-parse HEAD`
  runs inside the worktree first; the diff is `git diff <base>` afterwards. That
  is what lets several exec calls share one worktree and still each report only
  their own item's diff, since the engine commits the worktree as every agent
  returns.
- **The model is never asked which files it touched.** git is asked. The output
  schema is only `{summary, notes}` on purpose: asking for a `files` list you
  then discard invites drift between what the model says and what is true.
- **`git add -A` before diffing.** The engine's own snapshot does the same, so
  this is not novel state mutation, and it is what makes new files appear in the
  diff at all.
- **Diff text is capped at 200000 characters** with `diffTruncated` reporting it.
  Uncapped, one runaway item would either bury the review prompt or breach the
  engine's 10 MB RPC boundary and kill the run.
- **exec hardcodes no model, role or tool list.** Same reason as every other
  stage: the library is not preflighted against the caller's capabilities, so
  everything capability-shaped comes from the caller, whose script *is*
  preflighted. With no `tools` option the agent inherits the workflow's full tool
  set, which is what gives it edit and write.

Traps for the next step:

- **The offline gate stops at exec's agent call.** `loom-exec-stage.sh` proves
  the worktree is open, populated, branch-owned and base-recorded *before* the
  agent launches, and nothing after it: every post-agent line needs the agent to
  have returned, and the sandbox has no network and no key. P4b-ii's `/build`
  check faces the same wall; assert the wiring, never a model's output.
- **How to reach an agent boundary offline:** pass a model that does not exist.
  `WorkflowAgentExecutor.resolve()` throws `UNKNOWN_MODEL` at the top of
  `execute()`, before the attempt loop, before any session or socket, so there is
  no retry, no backoff and no network. The probe catches it and the run still
  completes, which keeps the harness's completion parsing unchanged.
- **Never put a backtick inside `STAGE_LIBRARY_SOURCE`.** That string is a TS
  template literal, so a backtick in a sandbox-side comment ends it and the build
  fails with unrelated-looking `TS2304: Cannot find name` errors. Use plain
  quotes in the appended source; backticks are fine in the surrounding TS.
- **The stage list is asserted as a literal string.** `loom-stages.sh` matches
  `available stages: plan, exec, review`. Adding or reordering a stage means
  updating that assertion in the same commit.
- **Worktree-scoped shell operations are journal-visible.** Their keys start with
  `shell/worktree/worktree%2Fnamed%2F<name>/`, and the recorded value is
  `{exitCode, stdout, stderr}`. That is how the check proves the base commit was
  read inside the worktree rather than in the repo.
- **`git worktree list` in the probe repo sees the engine's worktree** even
  though the worktree directory lives under the run store
  (`~/.pi/workflows/projects/<slug>/sessions/<sid>/runs/<runid>/worktrees/`).
  Worktree metadata is registered in the repo's `.git`, which is what makes the
  count assertion possible.
- **`extensions/pi-loom/skills/pi-extensible-workflows/SKILL.md` is still
  modified in the working tree and still deliberately uncommitted.** Same state
  as the previous four handoffs: `HEAD` content is byte-identical to the vendored
  upstream copy, the working-tree content is a rewrite by something outside these
  steps. Left untouched again; commits here stage explicit paths, never `-A`.
  Decide what it is before committing it. It also means the agent-facing docs for
  `stage(...)` and `exec` were *not* written — that file is where they belong.
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
  `loom-project-workflows.sh`, `loom-stages.sh` and `loom-exec-stage.sh` export it
  explicitly; the three older harnesses do not.
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
- **Two facts all seven harnesses depend on.** Pi's agent dir defaults to
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
- [ ] **P4b-ii — `/build`.** plan → exec → review over one worktree, keyed per
      plan item.
- [ ] **P4c — `/quick`.**
- [ ] **P5 — router + picker.**
- [ ] **P6 — `/wf-new` meta-workflow.**
- [ ] **P7 — ecosystem fill.** `/explore`, `/debug`, `/review`; migrate the
      `ship` and `next` skills to workflows.
- [ ] **P8 — bare-core CI.** `checks.pi-loom-bare`.

Acceptance criteria for every phase above: see the Roadmap section of
`extensions/pi-loom/DESIGN.md`.
