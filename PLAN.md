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

Last touched: P5c landed and is ticked, which closes P5 whole. The next open
item is P6 (`/wf-new` meta-workflow).

What landed. `loom` now opens on a picker listing the workflows it can run, and
Esc drops to chat. New file `extensions/pi-loom-router/src/picker.ts`;
`src/index.ts` registers a **second** `session_start` handler that calls
`offerWorkflowPicker(pi.getCommands(), ctx)` when `event.reason === "startup"`.
New check `checks.pi-loom-router-picker` (`nix/checks/loom-router-picker.sh`)
and the matching `flake.nix` entry. DESIGN.md gained a **Startup picker**
paragraph and a fuller P5c roadmap entry; the router README gained a picker
section and package.json's description now mentions it.

**Discovery reads back what the engine registered instead of rescanning.** The
filter anchors on `/workflows`, which `pi-loom` registers unconditionally: its
`sourceInfo.path` is the engine's identity for the session, and every other
command from that same path is a workflow except `/workflow`. Measured in a
real `loom`, not assumed — `/build`, `/quick`, `/workflows` and `/workflow` all
report `<store>/pi-loom-3.4.2/src/index.ts` while `pi-interview`, `pi-atelier`
and the inline llama command each report their own file.

**A choice prefills `/build ` into the editor; it does not launch the run.**
No extension API dispatches a slash command — `pi.sendUserMessage` calls the
session's `prompt()` with command handling off, so `/build fix the parser`
would reach the model as literal text. That constraint matches the requirement:
since P3a every workflow's first argument is a task description the picker
cannot know, so the user types it and presses Enter with pi's palette showing
the generated usage.

Gates actually run: `nix build .#pi-loom-cli` (pass);
`nix build .#checks.x86_64-linux.pi-loom-router-picker` (pass, seconds);
`nix build .#checks.x86_64-linux.pi-loom-router-gate` (pass, 12s — the leg that
proves the new handler does not wedge a live RPC session); `biome lint .` via
`nix run nixpkgs#biome` (exit 0, one pre-existing warning in
`pi-loom/src/workflow-evals.ts`, none in the new files); `nix flake check -L`
(pass, all 28 checks, 17s warm).

**The visual half was verified once by hand through a pty**, because no offline
check can render a dialog. A `python3` `pty.fork()` harness ran `loom` in a real
terminal with `/build` and `/quick` installed in a throwaway agent dir, and the
captured screen showed the overlay (`Start a workflow — or Esc to chat`, three
rows, the usage tails stripped); Esc left the editor empty and the session
READY; Enter on the highlighted row left exactly `/build ` in the editor. That
evidence is real but is not in CI.

**Nine negative controls, each against a mutated copy in `/tmp`, never the real
tree.** Picker handler removed → `startup offered 0 picker(s)`. Mode guard
removed → `mode 'rpc' opened a dialog that nothing can answer`. Filter widened
→ `the picker offers /workflows, which is not a workflow`. Reason guard removed
→ `session_start reason 'reload' opened an uninvited picker`. Editor guard
removed → `the picker interrupted a session that already had text`. Usage-tail
trim disabled → caught. Chat row renamed to start with a slash *and* its
identity guard removed → `the chat row left '/chat ' in the editor`. Picker
registered before the gate → `'edit' was still active while the picker was
open`. One control was **vacuous and is worth knowing why**: removing only the
`option === CHAT_OPTION` guard changes nothing, because the label does not
start with `/` and the regex rejects it anyway. Two independent properties
protect that row; the check catches the loss of both, not of either.

Design decisions worth not re-litigating:

- **The picker lives in the router, not the engine.** `pi-loom` is installable
  into a plain `pi` through `extensions/registry.nix`, so a startup overlay
  there would violate P5's "`pi` sessions are unaffected". `pi-loom-router` is
  already loom-only and already the thing that decides what the chat seat is
  for, so routing the *user* belongs beside routing the model.
- **Startup only.** `session_start` also fires for `reload`, `new`, `resume`
  and `fork`. A modal on `/reload`, or when returning to existing work, is a
  nuisance rather than an offer. Widening to `new` later is one condition.
- **Prefill, not launch.** See above; also means `loom --tools read` and every
  other narrowing still applies, because nothing bypasses command dispatch.
- **Two mechanisms plus one affordance.** P5b-i addresses tool names, P5b-ii
  addresses shell invocations, P5c addresses the user. Do not fold any of the
  three into another.

Traps for the next step:

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
- **A pty harness is now a proven way to verify TUI behaviour by hand.**
  `python3` `pty.fork()`, `os.execv` the binary, read the master fd, strip ANSI
  with `sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g'`. Use it for evidence when a claim is
  about rendering; do not try to make it a nix check.
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
- **The available-stage assertions are substring matches.** `loom-stages.sh`
  and `loom-exec-stage.sh` name all four stages; a fifth must extend them.
- **Never put a backtick or a `$` followed by `{` inside `STAGE_LIBRARY_SOURCE`.**
  That string is a TS template literal: a backtick ends it (unrelated-looking
  `TS2304: Cannot find name` errors) and a dollar-brace interpolates. Shell
  inside it must use `$(...)` and bare `$var`.
- **`git status` rewrites the index stat cache.** A harness that copies
  `.git/index` and then runs `git status` sees its own bookkeeping as a diff.
  Capture status first, copy the index second.
- **A clean probe repo cannot prove a snapshot happened.** `git write-tree` on
  an unmodified tree reproduces HEAD's tree and writes nothing, so the
  loose-object assertion needs the probe repo dirtied first.
- **`workflows/` is not in the `pi-loom` package.** The install path is the
  system flake placing `workflows/*/` into `<agentDir>/workflows/`. A new
  shipped workflow needs a nix check that copies the directory in itself and an
  entry in `~/nixos/.../modules/dev/pi/workflows.nix`. **`/quick` is not in that
  file yet**; until it is, the picker on the user's real machine shows `/build`
  and not `/quick`.
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
- **Stages are still invisible to the model.** `workflow_catalog` lists
  registered functions, not stages. Nothing tells an agent that `stage(...)`
  exists. Wiring them into a catalog is a natural P6 item, and it matters more
  now that the chat agent is refused writes and has to know what to delegate.
- **`extensions/pi-loom/skills/pi-extensible-workflows/SKILL.md` is now a live,
  owned document** (committed by the user as `9b022f4`). It is where the
  agent-facing docs for `stage(...)`, `exec`, `/build`, `/quick`, the router
  gate, the shell policy and now the picker belong. As of this step it still
  describes none of them — check before assuming.
- **The `next` skill's own doc says `nix flake check` runs 13 checks.** It runs
  28. Left unedited on purpose (out of scope for P5c), but worth a one-word fix
  next time `.pi/skills/next/SKILL.md` is touched for its own sake.
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
- [ ] **P6 — `/wf-new` meta-workflow.**
- [ ] **P7 — ecosystem fill.** `/explore`, `/debug`, `/review`; migrate the
      `ship` and `next` skills to workflows.
- [ ] **P8 — bare-core CI.** `checks.pi-loom-bare`.

Acceptance criteria for every phase above: see the Roadmap section of
`extensions/pi-loom/DESIGN.md`.
