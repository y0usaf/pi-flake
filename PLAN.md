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

Last touched: P5b was split in two and P5b-i landed and is ticked. The next
open item is P5b-ii (read-only shell), which is the only part of P5b's stated
acceptance still missing.

What landed. A new package, `pi-loom-router`
(`extensions/pi-loom-router/{package.json,README.md,src/index.ts}`), packaged in
`flake.nix` as `packages.pi-loom-router` with `stdenvNoCC` — no build, no
node_modules, because the source imports only types. It is last in `loomStack`,
and has **no entry in `extensions/registry.nix`**, which is what keeps it out of
`pi-full` and out of reach of every extension flag. At `session_start`, and
again at `before_agent_start`, it calls `setActiveTools` to remove `edit`,
`write` and `bash` and add `grep`, `find` and `ls`. Gated by
`checks.pi-loom-router-gate` (`nix/checks/loom-router-gate.sh`). DESIGN.md gained
a **Router gate** paragraph under Architecture and a two-way split of P5b in the
Roadmap; `registry.nix`'s header comment now explains why a package can be
missing from it.

**The gate had to become a swap, and this was measured, not guessed.** The first
version only subtracted the mutating three. Instrumenting the check to print the
witnessed active set showed the result was `["read","aphrodite_retrieve"]`: pi's
default active set is `read`, `bash`, `edit`, `write`, while `grep`, `find` and
`ls` are *configured but inactive*, so subtraction alone leaves a router that
cannot list a directory or search for a symbol. DESIGN.md rejects exactly that
under "Hard router (no file access at all)". The gate now adds the read-only
three back, intersected with `pi.getAllTools()` so `loom --tools read` still
bounds the session. Witnessed result is now
`["read","aphrodite_retrieve","grep","find","ls"]`.

Gates actually run: `nix build .#pi-loom-router` (pass); `nix build
.#pi-loom-cli` (pass); `loom-router-gate.sh` by hand against `"$(readlink -f
result)/bin/loom"` (pass, ~10s); `nix flake check -L` (pass, all 26 checks,
including `biome-lint`, `pi-loom-tool-boundary` and the new
`pi-loom-router-build` / `pi-loom-router-gate`).

**Both halves of the check have verified negative controls.** With `GATED_TOOLS`
emptied and `loom` rebuilt, the harness failed with `the chat agent still holds
'edit' in loom, so the router gate did not fire`. With `RESTORED_TOOLS` emptied,
it failed with `the gated chat agent has no 'grep', so it cannot read the repo it
is supposed to route over`. The good file was restored from a copy in `/tmp` and
the passing run repeated. So neither assertion passes vacuously.

Design decisions worth not re-litigating:

- **`bash` is gated whole, not narrowed.** `setActiveTools` addresses tool names,
  not invocations; a gate that leaves `bash` reachable is not a gate, since
  `bash` writes any file `edit` could. Narrowing is a different mechanism
  (`tool_call` returning `{ block: true, reason }`) and is P5b-ii.
- **No registry entry, on purpose.** An entry in `extensions/registry.nix` is
  what makes an extension installable through `programs.pi.extensions.<name>`.
  The router strips edit/write/bash, which is correct in `loom` and would be a
  silent mutilation of a normal `pi` session, so it is wired straight into
  `loomStack` instead. The check asserts `pi-full` bundles no copy of it, which
  is the assertion that fires if someone "tidies up" by adding the entry.
- **Policy loads last.** The router is the final `-e` in `loomStack` so its
  `session_start` handler runs after every handler that might still be enabling
  tools. Nothing depends on that today; it costs nothing and removes a class of
  ordering bug.
- **Name matching covers tool overrides.** pi-hashline registers its own `edit`
  under the builtin's name, so one `edit` entry gates both.

Traps for the next step:

- **Never give the router a test hook.** The check reads the active set from a
  *witness* extension appended through trailing argv, and reads it from a
  **command handler**, not from `session_start`: two extensions' `session_start`
  handlers have no guaranteed order, but a slash command is dispatched long after
  startup settles, so what it sees is the gate's final answer.
- **`before_agent_start` re-gating is not covered by the check.** It only fires
  on a submitted prompt, and a slash command bypasses it, so proving it needs a
  model. It is three lines of the same filter; treat it as unproven if it ever
  looks suspect.
- **Running the harness by hand inherits `PI_DEFAULT_PACKAGES`.** Inside a Pi
  session, the plain-`pi` leg of `loom-router-gate.sh` reports extension tools
  (`web_search`, `aphrodite_retrieve`) that the nix sandbox will not have. The
  assertions only require edit/write/bash, so both environments pass, but do not
  read that list as pi's default set.
- **`pi-full` is now inside a check closure.** `pi-loom-router-gate` takes it as
  its third argument for the bundle assertion, so `nix flake check` builds
  `pi-full` too.
- **Action methods are illegal during extension loading.** Calling
  `pi.getActiveTools()` in a factory body kills the whole stack with
  `Failed to load extension ... Extension runtime not initialized. Action methods
  cannot be called during extension loading.` The router only ever calls them
  from `session_start` and `before_agent_start`.
- **A policy extension can be stood in for by trailing argv.** `loom` ends in
  `exec pi --no-extensions <stack> "$@"`, so `loom -e /tmp/probe.ts ...` appends
  another extension. That is how both `loom-tool-boundary.sh` and
  `loom-router-gate.sh` observe or simulate policy without editing the stack.
- **preflight rejects an unknown model before a run exists.** A probe script that
  hardcodes `model: "...not-a-real-model"` inside `agent(...)` never produces a
  `state.json`: it is refused at launch as a notify. Pick per assertion: a notify
  probe proves preflight order, a run probe proves snapshot contents.
- **The `UNKNOWN_MODEL` notify keeps the raw detail inline**, reading
  `The workflow requested the unavailable model Unknown model <name> (settings:
  ...).` The formatter only strips a colon form, so match two substrings rather
  than one sentence.
- **The available-stage assertions are substring matches.** `loom-stages.sh` and
  `loom-exec-stage.sh` name all four stages; a fifth stage must extend them
  again.
- **Never put a backtick or a `$` followed by `{` inside `STAGE_LIBRARY_SOURCE`.**
  That string is a TS template literal: a backtick ends it (unrelated-looking
  `TS2304: Cannot find name` errors) and a dollar-brace interpolates. Shell inside
  it must use `$(...)` and bare `$var`.
- **`git status` rewrites the index stat cache.** A harness that copies
  `.git/index` and then runs `git status` will see its own bookkeeping as a diff.
  Capture status first, copy the index second, compare in that order.
- **A clean probe repo cannot prove a snapshot happened.** `git write-tree` on an
  unmodified tree reproduces HEAD's existing tree object and writes nothing, so
  the loose-object count assertion needs the probe repo dirtied first.
- **`workflows/` is not in the `pi-loom` package.** The install path is the
  system flake placing `workflows/*/` into `<agentDir>/workflows/`. A new shipped
  workflow needs a nix check that copies the directory in itself and a matching
  entry in `~/nixos/.../modules/dev/pi/workflows.nix`. **`/quick` is not in that
  file yet**; until it is, the user sees `/build` but not `/quick`.
- **The `/workflows` listing has its own customType.** Runs deliver under
  `"customType":"workflow"`, the listing under `"customType":"workflow-list"`. A
  harness waiting on the wrong one burns its whole timeout.
- **A failed run is still delivered as a workflow message**, formatted
  `Workflow <name> failed (runId=...): error=<CODE>: <message>; ...; artifacts:
  runDirectory=... statePath=... journalPath=...`.
- **The cheapest offline evidence lives in two files per run.** `state.json` has
  `state`, `phase`, `phaseHistory[].phase` and `error.code`; `snapshot.json` has
  `tools` (the launch boundary) and `args` *after* argsSchema defaults.
- **A nix store copy is read-only.** `cp -r ${./workflows/quick} …` then
  `chmod -R u+w` in the harness, or the run store cannot treat it as an install.
- **`local a="$1" b="$work/$a"` in one statement fails under `set -u`.** Bash
  does not expose `a` to the rest of its own `local` statement; the error reads
  `name: unbound variable`. Split the declarations.
- **`extensions/pi-loom/skills/pi-extensible-workflows/SKILL.md` is still
  modified in the working tree and still deliberately uncommitted.** Same state
  as the previous seven handoffs: `HEAD` content is byte-identical to the vendored
  upstream copy, the working-tree content is a rewrite by something outside these
  steps. Left untouched again; commits here stage explicit paths, never `-A`.
  Decide what it is before committing it. It also means the agent-facing docs for
  `stage(...)`, `exec`, `/build`, `/quick` and now the router gate were *not*
  written — that file is where they belong.
- **Stages are still invisible to the model.** `workflow_catalog` lists
  registered functions, not stages. Nothing tells an agent that `stage(...)`
  exists. Wiring them into a catalog is a natural P6 item once the SKILL.md
  ownership question is settled. It matters more now: the gated chat agent cannot
  edit, so it has to know what to delegate to.
- **The flake only sees git-tracked files.** A new source or check script that is
  not `git add`ed does not exist inside `nix build`. Stage before building.
- **`result` is a relative symlink.** The check harnesses `cd` into a temp
  project, so running one by hand needs `"$(readlink -f result)/bin/loom"`.
- **`PI_CODING_AGENT_DIR` leaks into hand-run harnesses.** Running a check script
  from a Pi session inherits it and the user-scope scan finds the real agent dir
  instead of the throwaway one. The seven newest harnesses export it explicitly;
  the three oldest do not.
- **Never `head -1` a presented message.** Usage text and the `/workflows` listing
  are multi-line, so harnesses serialise with `jq -c` before decoding.
- **`inputsSettled()` gates on four parking lots** (checkpoints, questions, edits,
  reviews). Anything that parks a new kind of human input must add its lot there
  or a pending item will look like a running run.
- **Downstream flag renamed.** `~/nixos/hosts/y0usaf-desktop/finix/materialized-packages.nix`
  sets `"extensible-workflows" = true;`. That key no longer exists; it is now
  `loom`. `lib.enabledExtensions` asserts on unknown flags, so the system flake
  fails to evaluate the moment it bumps this input. Flip the flag in the same
  change that bumps the input (the `ship` skill does both). Note `router` is
  **not** a valid flag and must never become one.
- **Fork identity is still upstream-named on purpose.** package.json is still
  `pi-extensible-workflows@3.4.2`, and the scan-root constants still resolve
  `<agentDir>/pi-extensible-workflows/{SYSTEM.md,roles}`. Renaming moves paths
  inside the user's agent dir, so it must land with the system flake, not before.
- The ref tree is no longer a package and is excluded from `biome.jsonc`; keep it
  that way, it is only a diff base for upstream fixes.
- **Two facts all eleven harnesses depend on.** Pi's agent dir defaults to
  `$HOME/.pi/agent`, not the XDG data path the installed system uses; and an RPC
  `prompt` is refused before command dispatch unless a model resolves with a key,
  which is why the scripts pass throwaway `--provider/--model/--api-key` flags.

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
- [ ] **P5b-ii — read-only shell.** `bash` back on the chat agent behind a
      `tool_call` classifier.
- [ ] **P5c — picker.** Startup overlay; Esc drops to chat.
- [ ] **P6 — `/wf-new` meta-workflow.**
- [ ] **P7 — ecosystem fill.** `/explore`, `/debug`, `/review`; migrate the
      `ship` and `next` skills to workflows.
- [ ] **P8 — bare-core CI.** `checks.pi-loom-bare`.

Acceptance criteria for every phase above: see the Roadmap section of
`extensions/pi-loom/DESIGN.md`.
