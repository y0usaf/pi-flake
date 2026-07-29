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

Last touched: P6c-i landed and is ticked. The next open item is P6c-ii
(`/wf-new` dry-run and commit), which is the consumer of what this step built.

What landed. `dryRun({ directory })`: a sandbox global that loads a workflow
directory the way Pi registers slash commands and launches it once with
deliberately invalid arguments — no model, no API key, no run. Engine changes:
`dryRunWorkflowCommand` + `DRY_RUN_ARGUMENTS` in `src/workflow-commands.ts`,
`validateDryRun` and the extracted `validateWorkflowScriptStructure` in
`src/validation.ts`, `DryRunInput` and `WorkflowBridge.dryRun` in `src/types.ts`,
the `dryRun` RPC method and sandbox entry in `src/execution.ts`, `dryRunBridge`
plus both launch-site wirings in `src/host.ts`, and one line in
`SANDBOX_GLOBALS` (`src/stages.ts`) so it reaches the generated authoring
contract. New: `nix/checks/loom-dry-run.sh` and `checks.pi-loom-dry-run`.
DESIGN.md gained a `dryRun` section after the `/wf-new` section and a split P6c
roadmap entry. **No workflow calls `dryRun` yet** — that is P6c-ii.

**The dry run is the registration path, not a copy of it.** It calls
`discoverWorkflowCommands`, `validateWorkflowCommandSpec`,
`workflowCommandUsage` and `parseWorkflowCommandArgs` — the same functions
`src/host.ts` registers commands with. A hand-written "does this look like a
workflow?" checker would diverge from the loader the first time the loader
changed, and the scaffold it blessed would fail at its first real launch.

**"Launched with deliberately invalid arguments" stops at the argument gate.**
`parseWorkflowCommandArgs` rejecting `{"__loomDryRun":true}` is the last thing
that happens before a run exists, so reaching it proves discovery and usage
generation. It is *not* a second `loom` process: the sandbox has no binary path,
and everything past the gate needs a model. A JSON object rather than malformed
text, because with `argKey` set unparseable text is a valid launch. A command
whose schema accepts the sentinel reports `rejectedInvalidArguments: false`
instead of failing.

Gates actually run: `nix build .#pi-loom` (pass);
`nix build .#checks.x86_64-linux.pi-loom-dry-run -L` (pass);
`nix flake check -L` (pass, all 31 checks, `biome-lint` among them).

**Two engine mutants, each reverted from a `/tmp` backup after the run.**
Replacing `validateWorkflowScriptStructure(readFileSync(...))` with a bare
`readFileSync` → `a script that redeclares stage was accepted`. Commenting out
the shadow-clash `fail(...)` → `a name already claimed by an installed root was
accepted`. Both exit 1; the restored tree exits 0.

Design decisions worth not re-litigating:

- **`dryRun` is a global, not a stage.** Every stage runs exactly one agent
  under a fixed output contract; a dry run runs none. `stage("dryrun", ...)`
  would make the stage list mean two things, and would have forced the
  `plan, exec, review, quick, scaffold` substring assertion in three check
  scripts to grow for a step that runs no model.
- **Shadowing is a failure, not a warning.** The first scan root to claim a name
  wins, so a scaffold whose name is already taken registers and can still never
  be launched. Self-comparison is by `specPath`, which is why the bridge
  resolves the directory to an absolute path before calling.
- **The script is parsed, never run.** `validateWorkflowScriptStructure` is the
  half of `preflight` needing only script text (parse, reserved instrumentation
  identifiers, stage-library collision). Splitting it out means a dry run needs
  no model list or settings path, and cannot drift from the launch guards.
- **The path rule is `validateDryRun`, in `src/validation.ts`.** Relative only,
  no `..`, resolved against the run's cwd by the host bridge — the same rule the
  scaffold stage's `directory` gets, for the same reason: reading is a
  capability too.
- **P6 is split by failure mode, not by file.** Writing the files (P6a), asking
  the questions (P6b), proving the result loads (P6c-i) and committing it
  (P6c-ii) fail differently; only P6a and P6c-i are reusable by anything other
  than `/wf-new`.
- **The picker lives in the router, not the engine**, and offers a choice by
  prefilling `/<name> ` into the editor rather than launching a run: no
  extension API dispatches a slash command.

Traps for the next step:

- **A Node-import check leg is impossible for anything reaching
  `src/validation.ts`.** It imports `@earendil-works/pi-coding-agent`, a peer
  dependency that exists only inside a running Pi, so
  `node --import ...src/workflow-commands.ts` dies with `ERR_MODULE_NOT_FOUND`
  (the built `dist/` fails the same way). `loom-stages.sh` and
  `loom-scaffold-stage.sh` get away with it because `src/stages.ts` imports one
  *type* and nothing else. Anything deeper needs a real `loom` run.
- **`jq`'s `//` is the alternative operator and treats `false` as empty.**
  `jq -r '.flag // ""'` turns a real `false` into `""`, so an assertion against
  `"false"` can never pass — the failure looks like a wrong value, not a wrong
  accessor. `loom-dry-run.sh` keeps `field()` for strings and adds
  `flag() { jq -r "(.$1 | tostring)" ...; }` for booleans.
- **One `loom` run can carry a whole check.** `loom-dry-run.sh` drives eleven
  scenarios through one probe workflow that launches no agent: the run is the
  only fixed cost (about ten seconds), each extra scenario is a `try/catch` and
  one field in the returned artifact. Prefer that over one run per case.
- **`dryRunWorkflowCommand` scans the *parent* of the directory it is given**,
  because that is how a workflows root is scanned. Fixtures sharing a parent
  can shadow each other by name, so `loom-dry-run.sh` gives every fixture its
  own parent directory.
- **A parked run is only `awaiting_input` while pi is alive.** `session_shutdown`
  promotes every non-terminal run to `interrupted`
  (`SHUTDOWN_TERMINAL_RUN_STATES`, `src/host.ts:23`), so a harness that reads
  `state.json` after the process exits sees `interrupted` and cannot tell a park
  from a crash. `loom-wf-new-workflow.sh` makes every parked-run assertion
  before closing fd 3. The question and the state are both written before the
  choice UI is emitted, so the request line arriving is proof they are on disk.
- **A stage that creates a directory before its agent is offline evidence.**
  `stage("scaffold", ...)` runs `mkdir -p` before `agent(...)`, so a run killed
  at model resolution still leaves the directory behind. Answering the
  *non-default* scope makes that directory a fact only an answered question
  could produce — cheaper and less forgeable than any log assertion.
- **`ctx.ui.select` blocks forever in RPC mode.** It emits an
  `extension_ui_request` and waits for a client response, with no timeout unless
  one is passed (`src/modes/rpc/rpc-mode.ts:136`). Every pi-driving check here
  drives `loom` with a stdin script that cannot answer a dialog, so an
  unguarded startup dialog hangs the whole suite until each check's 300s
  timeout instead of failing it. `ctx.mode !== "tui"` is the documented guard
  and is asserted by `loom-router-picker.sh`. Anything that adds interactive UI
  at startup needs the same guard.
- **One extension may register several handlers for one event.** They run in
  registration order and are awaited one at a time
  (`src/core/extensions/runner.ts:796`), each in its own try/catch, so a
  throwing handler cannot kill its siblings. Order is a real invariant here:
  the gate is registered first so it has already applied before the picker's
  first await.
- **Pi starts its TUI before initialising extensions**, explicitly "so
  session_start handlers can use interactive dialogs"
  (`src/modes/interactive/interactive-mode.ts:725`). Awaiting a dialog in
  `session_start` is sanctioned, not a hack.
- **No extension API dispatches a slash command.** `pi.sendUserMessage` looks
  like one and is not. Anything that wants to *run* a command has to go through
  the editor or register its own handler.
- **A pty harness is a proven way to verify TUI behaviour by hand.**
  `python3` `pty.fork()`, `os.execv` the binary, read the master fd, strip ANSI
  with `sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g'`. Use it for evidence when a claim is
  about rendering; do not try to make it a nix check.
- **The appended stage library can be executed outside pi entirely.** Import the
  built package's `src/stages.ts` in Node, call `stageLibrarySource()`, and
  evaluate `new (async function(){}).constructor("agent", "shell", "prompt",
  "withWorktree", source + "; return { stage: stage };")`. That hands you the
  real `stage()` with stub globals in milliseconds, which is the only way to see
  what a stage does *after* its agent returns without paying for a model.
  `loom-scaffold-stage.sh` leg A is built on it.
- **The router still cannot run `nix build` or `nix flake check`.** Policy
  working as designed, but it bites P7: migrating `next` and `ship` to
  workflows means validation runs inside a stage, not from the chat seat.
- **The allowlist will refuse legitimate read-only tools it has not heard of**
  (`bat`, `delta`, `tokei`, `xargs` even in read-only use). Extending it is one
  line in `READ_ONLY_COMMANDS`; widening the parser is not the answer.
- **The stub-`ExtensionAPI` harness is the default tool here now** — two checks
  use it and both run in milliseconds. Import the built package's
  `src/index.ts`, hand it a stub `pi` that records `on(...)` handlers, call them
  with synthetic events. Prefer it over booting pi in RPC mode whenever the
  assertion is about an extension's own decisions.
- **Node runs extension TypeScript directly, but only with a literal `.ts`
  specifier.** Type stripping is default-on from Node 22.18 (nixpkgs
  `nodejs_22` is 22.23.1). `./picker.ts` and `./shell-policy.ts` are written
  with their real extension because jiti (pi's loader) resolves both forms
  while Node resolves only the literal path.
- **Never give the router a test hook.** `loom-router-gate.sh` reads the active
  set from a *witness* extension appended through trailing argv, and from a
  **command handler**, not `session_start`: two extensions' `session_start`
  handlers have no guaranteed order, but a slash command is dispatched long
  after startup settles.
- **`before_agent_start` re-gating is still not covered by any check.** It only
  fires on a submitted prompt, which a slash command bypasses, so proving it
  needs a model. Treat it as unproven if it ever looks suspect.
- **Running a harness by hand inherits `PI_DEFAULT_PACKAGES`.** Inside a Pi
  session the plain-`pi` leg of `loom-router-gate.sh` reports extension tools
  (`web_search`, `aphrodite_retrieve`) the nix sandbox will not have.
- **`pi-full` is inside a check closure.** `pi-loom-router-gate` takes it as its
  third argument, so `nix flake check` builds `pi-full` too.
- **Action methods are illegal during extension loading.** Calling
  `pi.getActiveTools()` in a factory body kills the whole stack with `Failed to
  load extension ... Extension runtime not initialized.` The router only calls
  them from `session_start` and `before_agent_start`.
- **A policy extension can be stood in for by trailing argv.** `loom` ends in
  `exec pi --no-extensions <stack> "$@"`, so `loom -e /tmp/probe.ts ...`
  appends another extension. That is how `loom-tool-boundary.sh`,
  `loom-router-gate.sh` and this step's `getCommands()` probe observed policy
  without editing the stack.
- **preflight rejects an unknown model before a run exists.** A probe script
  that hardcodes a fake model inside `agent(...)` never produces a
  `state.json`: it is refused at launch as a notify. Pick per assertion.
- **The `UNKNOWN_MODEL` notify keeps the raw detail inline**, reading `The
  workflow requested the unavailable model Unknown model <name> (settings:
  ...).` Match two substrings rather than one sentence.
- **The available-stage assertions are substring matches, in three files now.**
  `loom-stages.sh`, `loom-exec-stage.sh` and `loom-scaffold-stage.sh` all spell
  out `plan, exec, review, quick, scaffold`; a sixth stage must extend all
  three.
- **Never put a backtick, a `$` followed by `{`, or a regex literal inside
  `STAGE_LIBRARY_SOURCE`.** That string is a TS template literal: a backtick
  ends it (unrelated-looking `TS2304: Cannot find name` errors), a dollar-brace
  interpolates, and a regex literal's slashes and backslashes have to survive
  two levels of escaping. Shell inside it must use `$(...)` and bare `$var`;
  patterns must use `new RegExp("...")` with no backslashes.
- **`__stageGit` is now `__stageShell`.** It was never git-specific — it is the
  one command runner every stage uses, and non-zero exit is a stage failure.
  Renaming it shifted the `agent(...)` call-site offsets *inside the library*,
  which is sanctioned (only the author's own offsets must stay put), but it does
  mean a run in flight across this engine upgrade cannot resume.
- **`git status` rewrites the index stat cache.** A harness that copies
  `.git/index` and then runs `git status` sees its own bookkeeping as a diff.
  Capture status first, copy the index second.
- **A clean probe repo cannot prove a snapshot happened.** `git write-tree` on
  an unmodified tree reproduces HEAD's tree and writes nothing, so the
  loose-object assertion needs the probe repo dirtied first.
- **`workflows/` is not in the `pi-loom` package.** The install path is the
  system flake placing `workflows/*/` into `<agentDir>/workflows/`. A new
  shipped workflow needs a nix check that copies the directory in itself and an
  entry in `~/nixos/.../modules/dev/pi/workflows.nix`. **Neither `/quick` nor
  `/wf-new` is in that file yet**; until they are, the picker on the user's real
  machine shows `/build` and neither of them.
- **The `/workflows` listing has its own customType.** Runs deliver under
  `"customType":"workflow"`, the listing under `"customType":"workflow-list"`.
- **A failed run is still delivered as a workflow message**, formatted
  `Workflow <name> failed (runId=...): error=<CODE>: <message>; ...; artifacts:
  runDirectory=... statePath=... journalPath=...`.
- **The cheapest offline evidence lives in two files per run.** `state.json`
  has `state`, `phase`, `phaseHistory[].phase` and `error.code`;
  `snapshot.json` has `tools` (the launch boundary) and `args` *after*
  argsSchema defaults.
- **A nix store copy is read-only.** `cp -r ${./workflows/quick} …` then
  `chmod -R u+w` in the harness, or the run store cannot treat it as an install.
- **`local a="$1" b="$work/$a"` in one statement fails under `set -u`.** Bash
  does not expose `a` to the rest of its own `local` statement; the error reads
  `name: unbound variable`. Split the declarations.
- **The authoring contract reaches a scaffolding agent, never the chat agent.**
  `WORKFLOW_AUTHORING_CONTRACT` (stages, and now `dryRun`) is handed to a model
  only through the `scaffold` prompt. `workflow_catalog` still lists registered
  functions and model aliases, not stages, so nothing tells the chat agent in
  `loom` that `stage(...)` or `dryRun(...)` exists. Folding them into that tool
  is still an open idea; P6c-ii does not need it.
- **`extensions/pi-loom/skills/pi-extensible-workflows/SKILL.md` is a live,
  owned document** (committed by the user as `9b022f4`). It is where the
  agent-facing docs for `stage(...)`, `exec`, `scaffold`, `/build`, `/quick`,
  `/wf-new`, the router gate, the shell policy and the picker belong. As of this
  step it still describes none of them — check before assuming.
- **The `next` skill's own doc says `nix flake check` runs 13 checks.** It runs
  31. Left unedited on purpose (out of scope), but worth a one-word fix next
  time `.pi/skills/next/SKILL.md` is touched for its own sake.
- **The flake only sees git-tracked files.** A new source or check script that
  is not `git add`ed does not exist inside `nix build`. Stage before building.
- **`result` is a relative symlink.** The check harnesses `cd` into a temp
  project, so running one by hand needs `"$(readlink -f result)/bin/loom"`.
- **`PI_CODING_AGENT_DIR` leaks into hand-run harnesses.** Running a check
  script from a Pi session inherits it and the user-scope scan finds the real
  agent dir instead of the throwaway one. The newest pi-driving harnesses
  export it explicitly; the three oldest do not.
- **Never `head -1` a presented message.** Usage text and the `/workflows`
  listing are multi-line, so harnesses serialise with `jq -c` before decoding.
- **`inputsSettled()` gates on four parking lots** (checkpoints, questions,
  edits, reviews). Anything that parks a new kind of human input must add its
  lot there or a pending item will look like a running run.
- **Downstream flag renamed.** `~/nixos/hosts/y0usaf-desktop/finix/materialized-packages.nix`
  sets `"extensible-workflows" = true;`. That key no longer exists; it is now
  `loom`. `lib.enabledExtensions` asserts on unknown flags, so the system flake
  fails to evaluate the moment it bumps this input. Flip the flag in the same
  change that bumps the input (the `ship` skill does both). Note `router` is
  **not** a valid flag and must never become one.
- **Fork identity is still upstream-named on purpose.** package.json is still
  `pi-extensible-workflows@3.4.2`, and the scan-root constants still resolve
  `<agentDir>/pi-extensible-workflows/{SYSTEM.md,roles}`. Renaming moves paths
  inside the user's agent dir, so it must land with the system flake.
- The ref tree is no longer a package and is excluded from `biome.jsonc`; keep
  it that way, it is only a diff base for upstream fixes.
- **Two facts every pi-driving harness depends on.** Pi's agent dir defaults to
  `$HOME/.pi/agent`, not the XDG data path the installed system uses; and an RPC
  `prompt` is refused before command dispatch unless a model resolves with a
  key, which is why the scripts pass throwaway `--provider/--model/--api-key`
  flags. `loom-router-shell.sh` and `loom-router-picker.sh` drive no pi at all
  and need neither.

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
- [x] **P5a — launch boundary vs. model visibility.** A run's tool ceiling comes
      from `pi.getAllTools()` (what the session was configured with) instead of
      `pi.getActiveTools()` (what the model may call now), on the launch path
      and on both resume paths; `checks.pi-loom-tool-boundary` gates a session
      the way P5b's router will and proves the snapshot keeps `edit`, `write`
      and `bash` while preflight stops only at the unknown model.
- [x] **P5b-i — router gate.** `pi-loom-router` is its own package
      (`extensions/pi-loom-router/`), wired into the `loom` stack only and
      deliberately absent from `extensions/registry.nix`; at `session_start`
      and `before_agent_start` it swaps `edit`, `write` and `bash` out of the
      chat agent's active set and `grep`, `find` and `ls` in, in memory, never
      persisted. `checks.pi-loom-router-gate` proves the swap in `loom`, that
      plain `pi` keeps all three mutating tools, that `pi-full` bundles no copy
      of the router, and that a run launched in a gated session still records
      all three in its launch snapshot.
- [x] **P5b-ii — read-only shell.** `bash` is back on the chat agent and the
      invocation is judged instead of the name: `extensions/pi-loom-router/src/`
      `shell-policy.ts` classifies every command from a `tool_call` handler and
      returns `{ block: true, reason }` for anything that can write, with a
      reason naming `/quick` and `/build`. `checks.pi-loom-router-shell` drives
      the extension's own handlers with a stub `ExtensionAPI` over 13 read-only
      and 20 mutating commands.
- [x] **P5c — picker.** `loom` opens on a workflow picker and Esc drops to
      chat: `extensions/pi-loom-router/src/picker.ts` filters `pi.getCommands()`
      down to the engine's workflow commands, offers them through
      `ctx.ui.select` from a second `session_start` handler registered after the
      gate, and prefills the chosen one into the editor as `/<name> `.
      `checks.pi-loom-router-picker` drives the extension's own handlers with a
      stub `ExtensionAPI` over nine scenarios; the overlay's rendering needs a
      terminal and was verified by hand through a pty — see the handoff.
- [x] **P6a — `stage("scaffold", ...)`.** One agent writes `command.json`, the
      script it names and a README into `.pi/workflows/<name>/`, prompted with
      an authoring contract generated from `STAGE_LIBRARY`
      (`WORKFLOW_AUTHORING_CONTRACT`) rather than written as prose; the engine
      then reads the manifest back off disk and refuses a scaffold that would
      not load. `checks.pi-loom-scaffold-stage` proves the generated contract,
      the validate-then-mkdir-then-agent-then-verify ordering, and seven
      unloadable scaffolds, in Node against the built package; a second leg
      re-proves the input contract inside the real vm sandbox. The generated
      workflow's quality needs a real model — see the handoff.
- [x] **P6b — `/wf-new` interview.** `human.ask` turns questions into the
      scaffold stage's input, one question per input: the `name` answer becomes
      the stage's `name`, `scope` its `directory`, `shape` its `context`.
      Nothing is inferred from the task, so an unanswered run parks in the
      `interview` phase; `workflows/wf-new/` is the shipped directory and
      `checks.pi-loom-wf-new-workflow` proves the park and the answered path.
      The scaffolded workflow's quality needs a real model — see the handoff.
- [x] **P6c-i — `dryRun({ directory })`.** A sandbox global over a host bridge
      that calls the command-registration path itself — `discoverWorkflow
      Commands`, `validateWorkflowCommandSpec`, `workflowCommandUsage`,
      `parseWorkflowCommandArgs` in `src/workflow-commands.ts` — then launches
      the directory once with deliberately invalid arguments and stops at the
      gate a real slash command stops at. The script is parsed under the
      launch-time guards (`validateWorkflowScriptStructure`) and never run;
      `checks.pi-loom-dry-run` proves one directory that registers, one that
      declares no schema, and six ways a scaffold would not register, in a
      single model-free run.
- [ ] **P6c-ii — `/wf-new` dry-run and commit.** Dry-run the freshly scaffolded
      directory, then commit it — and report a failure before committing
      anything when it would not register.
- [ ] **P7 — ecosystem fill.** `/explore`, `/debug`, `/review`; migrate the
      `ship` and `next` skills to workflows.
- [ ] **P8 — bare-core CI.** `checks.pi-loom-bare`.

Acceptance criteria for every phase above: see the Roadmap section of
`extensions/pi-loom/DESIGN.md`.
