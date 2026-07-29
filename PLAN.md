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

Last touched: P5b-ii landed and is ticked, which closes P5b whole. The next
open item is P5c (workflow picker at startup, Esc drops to chat).

What landed. `bash` is active again in `loom`, and each invocation is
classified instead. New file `extensions/pi-loom-router/src/shell-policy.ts`
exports `classifyShellCommand(command)`; `src/index.ts` dropped `bash` from
`GATED_TOOLS` (now `["edit", "write"]`) and registered a `tool_call` handler
that returns `{ block: true, reason: verdict.reason }` for a refused command.
New check `checks.pi-loom-router-shell` (`nix/checks/loom-router-shell.sh`) and
the matching `flake.nix` entry. `nix/checks/loom-router-gate.sh` moved `bash`
from its must-be-absent list to its must-be-present list. DESIGN.md gained a
**Read-only shell** paragraph and a supersession note on P5b-i's acceptance;
the router README was rewritten around the two mechanisms.

**The policy is default-deny and deliberately small.** An allowlist of command
names with no writing mode; argument rules for the few that grow one with a
flag (`sed -i`, `find -delete`/`-exec`, `sort -o`, `fd -x`); subcommand
narrowing for `git` (read-only verbs only — `branch`, `tag`, `remote`, `config`
and `stash` are absent because each has a read form and a write form one flag
apart) and for `nix` (`eval`, `search`, `flake show|metadata`, `store ls|cat`;
`nix build` is refused because it drops a `./result` symlink into the tree).
A quote-aware scanner splits on `;`, `&&`, `||`, `|`, `&`, newlines and parens,
and refuses outright what it cannot judge: command substitution, backticks,
process substitution, heredocs, and output redirects to anything but
`/dev/null` (`2>&1` and other descriptor dups pass).

Gates actually run: `nix build .#pi-loom-router` (pass);
`nix build .#checks.x86_64-linux.pi-loom-router-shell` (pass, seconds);
`nix build .#checks.x86_64-linux.pi-loom-router-gate` (pass, 12s — the one that
proves the new relative import resolves inside a real `loom`); `biome lint .`
via `nix run nixpkgs#biome` (exit 0, one pre-existing warning in
`pi-loom/src/workflow-evals.ts`, none in the new files); `nix flake check -L`
(pass, all checks, 28s warm).

**Five negative controls, each run against a mutated copy of the package in
`/tmp`, never against the real tree.** Classifier forced to allow everything →
`mutating command was allowed through: rm -rf src`. Forced to refuse
everything → `read-only command was refused: ls -la src`. `tool_call`
registration removed → `the router registered no tool_call handler`. `bash` put
back into `GATED_TOOLS` → `the chat agent lost 'bash', which P5b-ii is supposed
to keep`. `ROUTE_HINT` stripped from the refusal → `the refusal for 'rm -rf
src' never names /quick`. Nothing in this check passes vacuously.

Design decisions worth not re-litigating:

- **Two mechanisms, on purpose.** `setActiveTools` addresses names, which is
  right for `edit`/`write` (tools that exist to mutate) and useless for `bash`
  (`ls -la` and `rm -rf src` are the same tool). Do not try to fold the shell
  policy back into the name gate.
- **Guardrail, not a sandbox.** Any string classifier loses to an adversary
  willing to obfuscate. The containment for a hostile model is the exec-stage
  worktree, not a better regex. Resist growing this file into a parser.
- **The handler is scoped to the chat session.** Workflow sub-agents are built
  by `createAgentSession(...)` with explicit `extensionFactories`
  (`extensions/pi-loom/src/agent-execution.ts:205`), so the router is not in
  their stack and an exec stage keeps its full shell. Read from the code, not
  runtime-verified — no offline check can launch a sub-agent.
- **No registry entry, still.** An entry in `extensions/registry.nix` is what
  makes an extension installable through `programs.pi.extensions.<name>`; the
  router would be a silent mutilation of a normal `pi` session. The gate check
  asserts `pi-full` bundles no copy, which fires if someone "tidies up".
- **Policy loads last** (final `-e` in `loomStack`) and **name matching covers
  tool overrides** (pi-hashline registers its own `edit` under the builtin's
  name). Both unchanged from P5b-i.

Traps for the next step:

- **The router now cannot run `nix build` or `nix flake check`.** That is the
  policy working as designed, but it bites P7 directly: migrating the `next`
  and `ship` skills to workflows means the validation step has to run inside a
  stage, not from the chat seat.
- **The allowlist will refuse legitimate read-only tools it has not heard of**
  (`bat`, `delta`, `tokei`, `xargs` even in read-only use). Extending it is one
  line in `READ_ONLY_COMMANDS`; widening the parser is not the answer.
- **A stub-`ExtensionAPI` harness is now a proven pattern here and costs
  milliseconds.** `loom-router-shell.sh` imports the built package's
  `src/index.ts`, hands it a stub `pi` that records `on(...)` handlers, and
  calls them with synthetic events — the same shape upstream uses in
  `packages/coding-agent/test/plan-mode-extension.test.ts`. Prefer it over
  booting pi in RPC mode whenever the assertion is about an extension's own
  decisions.
- **Node runs extension TypeScript directly, but only with a literal `.ts`
  specifier.** Type stripping is default-on from Node 22.18 (nixpkgs
  `nodejs_22` is 22.23.1), so `node driver.mjs` can `import()` a `.ts` file.
  `./shell-policy.ts` is written with its real extension because jiti (pi's
  loader) resolves both forms while Node resolves only the literal path.
- **No offline check can prove pi *invokes* a `tool_call` handler.** Emitting
  one needs an assistant message, so it needs a model. The split used here:
  `pi-loom-router-shell` proves what the handler decides,
  `pi-loom-router-gate` proves the extension loads in a live `loom` session.
- **Never give the router a test hook.** The gate check reads the active set
  from a *witness* extension appended through trailing argv, and from a
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
  appends another extension. That is how `loom-tool-boundary.sh` and
  `loom-router-gate.sh` observe or simulate policy without editing the stack.
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
  file yet**; until it is, the user sees `/build` but not `/quick`.
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
- **The SKILL.md question resolved itself mid-step, from outside this loop.**
  `extensions/pi-loom/skills/pi-extensible-workflows/SKILL.md` was modified and
  deliberately uncommitted through eight handoffs; at 23:10 during this step it
  was committed by the user as `9b022f4 docs(pi-loom): rewrite workflow skill
  for the fork's real surface`, so this step's commit sits on top of it and the
  tree is clean. Nothing here touched that file — commits stage explicit paths,
  never `-A`. Two consequences: HEAD moved under a running step once, so
  re-read `git log` rather than trusting a remembered SHA; and the file is now
  a live, owned document, which is where the agent-facing docs for `stage(...)`,
  `exec`, `/build`, `/quick`, the router gate and the shell policy belong. As of
  that commit they still describe none of them — check before assuming.
- **Stages are still invisible to the model.** `workflow_catalog` lists
  registered functions, not stages. Nothing tells an agent that `stage(...)`
  exists. Wiring them into a catalog is a natural P6 item, and it matters more
  now that the chat agent is refused writes and has to know what to delegate.
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
  flags. `loom-router-shell.sh` is the first check that drives no pi at all and
  needs neither.

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
- [ ] **P5c — picker.** Startup overlay; Esc drops to chat.
- [ ] **P6 — `/wf-new` meta-workflow.**
- [ ] **P7 — ecosystem fill.** `/explore`, `/debug`, `/review`; migrate the
      `ship` and `next` skills to workflows.
- [ ] **P8 — bare-core CI.** `checks.pi-loom-bare`.

Acceptance criteria for every phase above: see the Roadmap section of
`extensions/pi-loom/DESIGN.md`.
