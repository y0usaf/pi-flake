# pi-loom — design & roadmap

A loom holds fixed warp threads under tension so a shuttle can weave weft
across them into cloth. **pi-loom is a workflow runtime for Pi**: the
warp is a declared workflow (stages, roles, budgets, human gates), the
shuttle is a sub-agent, and the cloth is a committed change. It exists
because Pi's default loop — one agent, full tool access, unbounded chat —
has no unit of trust: nothing scopes a change, nothing verifies execution
against intent, and nothing survives a context reset. pi-loom makes **the
run** that unit.

Forked from [pi-extensible-workflows](https://github.com/vekexasia/pi-extensible-workflows)
3.4.2 (MIT), vendored pristine at `@extensions/vekexasia_pi-extensible-workflows/`
as a reference tree.

## Vision

- **As replaceable as pi itself** — every loom feature (commands, stages,
  roles, the router, the picker) is registered through the same public API
  a user extension would use.
- **As mechanical as a build system** — "did the executor do what the plan
  said" is a diff against a typed artifact, not a vibe check from a
  reviewer agent reading the room.
- **As conversational as chat when it needs to be** — a human is a
  callable participant (`human.ask`, `human.edit`, `human.review`) sitting
  beside `agent(...)` in the same DSL, not an out-of-band approval channel.
- **As self-extending as Emacs** — the workflow that authors workflows
  (`/wf-new`) is itself a workflow, so the ecosystem grows without
  hand-writing forty scripts.

Reference implementations are pinned, not copied loosely:
`@extensions/vekexasia_pi-extensible-workflows/` stays at pristine upstream
and is the source of truth for engine patterns; diffs against it are how we
take upstream fixes.

## Doctrine conformance

| Doctrine | Status | Notes |
|---|---|---|
| 01 extension-first core | follows | `pi-loom` = engine (mechanism). `pi-loom-builtins` (stages, roles, shipped workflows) and `pi-loom-router` (tool gate, picker) are policy and use only the public API. If a builtin needs a private hook, the API grows. |
| 02 snapshot in, actions out | follows | Workflow scripts receive immutable `args` + prior artifacts and return values; they never touch host state. Every `agent(...)`/`human.*` dispatch runs under the existing budget + timeout watchdog. Named exception: `withWorktree(name, cb)` grants real filesystem writes inside an isolated worktree — the worktree *is* the guard. |
| 03 daemon + thin client | diverges | Runs are session-scoped child processes, not a daemon. Accepted because a run that outlives its session has no viewer to report to today. Revisit if cross-session run supervision is wanted (see Deferred). |
| 04 declarative front, idempotent executor | partial | Nix declares the *stack* (which extensions compose `loom`) and system-level workflow placement. Workflow control flow stays in JS. Nix-declared workflows deferred until the stage library is stable. |
| 05 one declaration mechanism | follows | One unit: **the workflow**. One declaration: a directory with `command.json` (name, description, JSON-Schema args) + a script. A slash command, an agent-tool launch, a registered function, and a nested `workflow(name, args)` call all resolve through that single registration. No hand-wired special cases. |
| 06 bare core must boot | follows | Bare = `pi -e extensions/pi-loom` with no builtins and no router: `/workflow` registers, ad-hoc inline workflows launch, agent keeps full tools (plain Pi + an engine). CI-checked in `checks.pi-loom-bare`. |
| 07 nix source of truth | follows | Built and verified via `nix build` / `nix flake check`. `npm run build` inside the extension is the sanctioned native fallback for iteration only. |

## Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Fork vs. layer on upstream | Fork | Shared roles, composition, and typed artifacts could ship as a layer; the human primitives, arg schemas, command scanning, and tool gating are engine-level. Half a feature set is not an architecture. |
| Upstream copy | Hard reset to pristine 3.4.2, never edited | Reference tree (canon: `ref/` follows upstream conventions). It is the diff base for cherry-picking upstream fixes. Our four local commits (JSON IPC, real-node spawn, per-workflow commands, argKey) move into the fork. |
| Human in the loop | A DSL participant, not a policy | `human.ask/edit/review` sit beside `agent(...)`. Autonomous vs. hand-held becomes a swap of one call, not a fork of the workflow. Directly resolves "even human-in-loop should be facilitated by the extensibility." |
| Main-agent capability in loom | Router only: workflow tools + read-only | Mutation lives inside runs, so every change is budgeted, checkpointed, worktree-isolated, resumable, auditable. Read-only file access retained because blind routing degrades badly. |
| "Prompt the agent directly" | Routes to `workflow_compose` | The agent writes an inline workflow and launches it. Free-form work still lands in a run — no escape hatch that bypasses the unit of trust. |
| Ecosystem growth | `/wf-new` meta-workflow + shared stage library | A workflow that interviews, drafts `command.json` + script, dry-runs, and commits. Stage library keeps each new workflow ~20 lines of wiring instead of a copy of the same prompt. |
| Entry point | Workflow picker overlay at `session_start` | Feasible with no core patch: `session_start` (`reason: startup`) + `ctx.ui.custom(..., { overlay: true })` with focus handles. Esc drops to chat. |
| Shipping shape | **Alias package, not a second pi binary** | `packages.pi-loom-cli` = `writeShellScriptBin "loom"` running `pi --no-extensions -e <loom stack>`. No second `piWithExtensions` derivation, no renamed `pi`, no duplicate bundle — just argv plus one env var. Documented-supported (`usage.md`: "Combine `--no-*` with explicit flags to load exactly what you need"). |
| Config/state isolation | Shared `~/.pi/agent`, no `PI_CODING_AGENT_DIR` split | The only real collision was tool-gating. Fixed design-side: the router gate is **session-scoped in memory** via `setActiveTools` at `session_start`, never persisted. No collision → no split → no duplicated credentials. Runs already namespace by session id. |
| Engine ownership | One engine, two frontends | Plain `pi` keeps the engine (agent tools opt-in, as today) so `/ideate` works from a normal session. `loom` = engine + builtins + router + picker. One codebase, not two. |
| `/quick` in v1 | Required, not deferred | Plan→exec→review on a typo is ceremony that kills adoption by week two. `/quick` = one agent, no review stage, no worktree. |

## Architecture

```
extensions/
  vekexasia_pi-extensible-workflows/   ref — pristine upstream 3.4.2, never edited
  pi-loom/                             ENGINE (mechanism)
    src/
      host.ts            command registration, run lifecycle, TUI blocks
      execution.ts       DSL: agent, parallel, pipeline, phase, checkpoint,
                         human.ask, workflow
      agent-execution.ts sub-agent sessions, outputSchema, model selection
      human.edit/review  NEXT — the remaining human participants (P2b, P2c)
      artifacts.ts       NEW — typed run artifacts (plan, diff, verdict)
      schema.ts          NEW — JSON-Schema arg validation + generated usage
      registry.ts        extension-registered functions, stages, roles
      persistence.ts     run store, resume, retry
      budget.ts          watchdog: tokens, cost, duration, agent launches
  pi-loom-builtins/                    POLICY
    stages/              plan, exec, verify, review, repair, commit
    roles/               planner.md, executor.md, reviewer.md, ...
    workflows/           build, quick, explore, debug, review, wf-new, ideate, loop-next
  pi-loom-router/                      POLICY
    gate.ts              setActiveTools at session_start (in-memory, not persisted)
    picker.ts            startup overlay: recent / pinned / all workflows
```

Packaging (`flake.nix`):

```
packages.pi-loom            engine extension
packages.pi-loom-builtins   stage library + shipped workflows
packages.pi-loom-router     gate + picker
packages.pi-loom-cli        writeShellScriptBin "loom" → pi --no-extensions -e <stack>
```

The vendored ref tree is **not** a package: nothing under
`extensions/vekexasia_pi-extensible-workflows/` is built or shipped, it has no
`extensions/registry.nix` entry, and `biome.jsonc` excludes it so upstream
conventions never fight our lint gate. Its baseline is the vendor import
commit `a94500e` (upstream 3.4.2 core package, plus the workspace-free
`package-lock.json` that import had to regenerate) — that commit, not the npm
tarball, is what "pristine" means when diffing.

Identity strings inside the fork stay upstream-named on purpose: the npm
package is still `pi-extensible-workflows@3.4.2`, and `WORKFLOW_DIRECTORY`
(`src/agent-execution.ts`) plus `ROLE_DIRECTORY` (`src/validation.ts`) still
resolve `<agentDir>/pi-extensible-workflows/{SYSTEM.md,roles}`. Renaming them
moves on-disk scan roots that live in the user's agent dir, so it has to land
in lockstep with the system flake that populates those paths; it is deferred
until the router and builtins settle, not forgotten.

The loom stack re-declares its extensions explicitly, because
`--no-extensions` discards the `pi-full` bundle. That is the point: it
proves doctrine 06 at runtime. Stack = loom trio + `pi-interview`
(backs `human.ask`) + `pi-aphrodite` (compression for long runs) +
`pi-hashline` (edit anchors for executor sub-agents) + `pi-atelier`
(status rail = live run progress). `pi-tool-management` is **excluded**:
it persists a global disabled-tools list and would fight the router.

Load-bearing detail: `PI_WORKFLOW_NODE_PATH` is exported only by the
`pi-full` wrapper (`flake.nix`, `lib.piWithExtensions`). The `loom` alias
wraps plain `packages.pi`, so it must export that variable itself or
workflow child processes fail to spawn.
That claim is now enforced, not asserted: `checks.pi-loom-cli-smoke`
(`nix/checks/loom-cli-smoke.sh`) boots the real `loom` in `--mode rpc`
with a throwaway `HOME`, drops a probe workflow into `<agentDir>/workflows`,
and requires the child to log from inside its vm sandbox and return a
value. Strip the `export` line from the wrapper and the same script fails
with `Workflow child exited with code 1`. The harness needs no network and
no real API key because the probe never calls `agent()`; P8's bare-core
check reuses it.

**`human.ask` is backed by `ctx.ui.select`, not by `pi-interview`.** The
original intent was to reuse pi-interview's questionnaire UI. That is not
reachable: pi-interview exposes its questionnaire only as the `interview_user`
*tool*, and pi's extension API (`dist/core/extensions/types.d.ts`) has no
cross-extension tool invocation — an extension can register tools and read
`ctx.ui`, but cannot call another extension's tool. So `human.ask` renders
through the core `ExtensionUIContext.select`, which every run mode implements
(interactive dialog, RPC `extension_ui_request`, no-op when headless).
pi-interview stays in the loom stack for the *agent's* own clarifying questions;
the two paths are complementary, not layered. If pi upstream ever grows a
programmatic tool-invocation hook, revisit — the bridge is one function
(`humanBridge` in `host.ts`).

A question that the human dismisses is not a cancelled run. `human.ask` parks
the question in the run journal (`awaitingHuman`), so it survives a session
restart, and hands it to the main agent as a `workflow_answer` tool call.
Whichever side answers first settles the same journal entry, because
`RunStore.answerHumanRequest` only resolves a question still parked there.

## Extension surface contract

**Read path.** A workflow script receives a frozen `args` object (validated
against its `command.json` schema) plus read access to prior artifacts of
the same run. Stages receive `(input artifact, context)` and return an
artifact. Nothing in the script can reach host session state.

**Write path.** Scripts emit actions by returning values and by awaiting
the DSL: `agent(...)`, `human.*(...)`, `workflow(...)`, `parallel(...)`,
`withWorktree(...)`. Filesystem mutation is legal only inside a worktree
scope or inside a sub-agent's own tool calls.

**Watchdog.** Every dispatch runs under the run budget (tokens, cost,
duration, agent launches) with the existing pause/approve/resume path.
Budget exhaustion suspends the run rather than killing it; resume applies
a budget patch.

**Extension state.** Registered stages/roles/functions live in the engine
registry, keyed by name; duplicate names are hard errors (builtins register
first). Router gate state is per-session and in memory only.

**Named exceptions.** (1) `withWorktree` grants real writes — guarded by
isolation, not by the API. (2) The router's `setActiveTools` mutates
session tool visibility; it is the one policy extension permitted to do so,
and it never persists.

## Deferred (and why)

- **Nix-declared workflows** (doctrine 04). Nix expresses stacks and
  placement well and control flow badly. Revisit once the stage library is
  stable enough that a workflow really is data (stage list + roles +
  budget) rather than code.
- **Installable workflow packs** (npm / flake inputs). Needs name-collision
  precedence rules across global / project / pack scopes first.
- **Run daemon** (doctrine 03). Would enable runs that outlive a session
  and cross-session supervision. Deferred because there is no second viewer
  yet; a daemon now is machinery without demand.
- **Separate `PI_CODING_AGENT_DIR` for loom.** Unnecessary once router state
  is in-memory. Revisit only if a real persisted collision appears.
- **Hard router (no file access at all).** Rejected: routing decisions made
  without reading the repo get chatty and wrong.
- **Nix-generated `programs.pi.loom.enable`.** Wanted, but after the alias
  package proves the stack; then the module generates the same alias from
  the extension registry and `nix flake check` covers composition.

## Roadmap

Phases and their acceptance criteria. **Progress is not tracked here** —
the root `PLAN.md` owns the checkbox state and is what `/loop-next` reads.
Deliberately no checkboxes below: two checklists for the same work drift
apart within one loop iteration.

- **P0 — fork + ref reset.** Copy vendored source to `extensions/pi-loom/`,
      replay the four local commits there, hard-reset the vendored tree to
      pristine upstream 3.4.2. *Accept: `nix build .#pi-loom` succeeds;
      `git diff` of the vendored tree against upstream 3.4.2 is empty;
      `/ideate` and `/loop-next` still run on the fork.*
- **P1 — alias package.** `packages.pi-loom-cli`. *Accept: `loom`
      launches Pi with only the loom stack, `/workflow` is present, a
      workflow child process spawns (proves `PI_WORKFLOW_NODE_PATH`), and
      `pi` is byte-identical to before.*
- **P2 — human primitives.** The human as a callable DSL participant. Split
      into three because each backing mechanism is different: a choice UI, an
      editor round trip, and a structured verdict.
  - **P2a — `human.ask`.** Choice question, backed by `ctx.ui.select` (not
      `pi-interview`; see Architecture for why), with a `workflow_answer` tool
      as the agent-facing fallback. *Accept: a workflow calling `human.ask`
      renders the choice UI in the main session and resumes with the selected
      value.*
  - **P2b — `human.edit`.** Hand a text artifact to `$EDITOR` and take the
      edited text back. RPC mode already carries an `editor` UI method.
      *Accept: a workflow calling `human.edit` opens the editor prefilled and
      resumes with the saved buffer, and an unchanged buffer is distinguishable
      from an abandoned edit.*
  - **P2c — `human.review`.** Verdict over a diff or artifact: approve,
      request changes with a note, reject. *Accept: a workflow calling
      `human.review` resumes with a typed verdict whose note text reaches the
      next stage.*
- **P3 — declaration mechanism.** JSON-Schema args in `command.json`,
      generated usage, `/workflows` listing, project-local `.pi/workflows/`
      scan root. *Accept: bad args are rejected with generated usage text; a
      workflow dropped into a repo's `.pi/workflows/` appears as a slash
      command without restart-time editing of any global file.*
- **P4 — stage library + `/build` + `/quick`.** *Accept: `/build "<task>"`
      emits a plan artifact, an exec diff, and a review verdict keyed per
      plan item; `/quick "<task>"` completes a one-line change with a single
      agent and no review stage.*
- **P5 — router + picker.** *Accept: in `loom`, the main agent has no
      edit/write/mutating-bash tool; startup shows the workflow picker; Esc
      drops to chat; `pi` sessions are unaffected.*
- **P6 — `/wf-new` meta-workflow.** *Accept: `/wf-new` interviews, writes
      a runnable `command.json` + script + README into the repo, dry-runs
      it, and commits.*
- **P7 — ecosystem fill.** `/explore`, `/debug`, `/review`; migrate the
      `ship` and `next` skills to workflows. *Accept: each shipped skill has
      a workflow equivalent whose stages are enforced rather than described
      in prose.*
- **P8 — bare-core CI.** *Accept: `checks.pi-loom-bare` builds Pi with
      the engine only and asserts `/workflow` registers while zero builtin
      commands do.*
