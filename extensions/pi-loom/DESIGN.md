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
| 01 extension-first core | partial | `pi-loom` = engine (mechanism). `pi-loom-builtins` (stages, roles, shipped workflows) and `pi-loom-router` (tool gate, picker) are policy and use only the public API. If a builtin needs a private hook, the API grows. **Known divergence since P4a:** the stage library's *content* (the `plan`, `exec` and `review` prompts) ships inside the engine at `src/stages.ts`, because the registry accepts host-side functions over RPC and has no surface yet for extension-supplied sandbox source. The divergence closes when `pi-loom-builtins` exists and that surface is the thing it registers through.
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
                         human.ask, human.edit, human.review, workflow
      agent-execution.ts sub-agent sessions, outputSchema, model selection
      artifacts.ts       NEW — typed run artifacts (plan, diff, verdict)
      stages.ts          stage library source, appended to every workflow body
      workflow-commands.ts  command.json meaning + discovery (was: schema.ts)
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

**`human.edit` is `ctx.ui.editor(title, prefill)`, and returns a record, not a
string.** The editor resolves to `undefined` when the human closes it without
saving, and to the buffer otherwise — but a buffer saved byte-for-byte
unchanged and an abandoned editor both yield the original text, so a bare
string cannot express the difference the workflow has to branch on. The
primitive therefore resolves to `{ text, changed, abandoned }`, with `changed`
computed in `RunStore.answerHumanEdit` against the prefill it parked, so the
flags mean the same thing no matter which side answered.

Abandonment is where `human.edit` deliberately diverges from `human.ask`. A
dismissed question is a refusal to answer *now*, so it re-routes to the main
agent; a closed editor is a decision, so it settles the run. The agent-facing
`workflow_edit` tool exists only for runs with no UI attached, and omitting its
`text` argument produces the same abandoned outcome.

**`human.review` is a closed verdict plus an open note.** The three verdicts
(`approve`, `changes`, `reject`) are fixed in `HUMAN_REVIEW_VERDICTS` rather
than supplied per call, which is exactly what separates it from `human.ask`: a
later stage can `switch` on the verdict without knowing which review produced
it. The note is the only channel by which a `changes` verdict says what to
change, so it is carried in the result record and not just shown to the human.

The subject under review does not fit a picker title, so the UI path is two
rounds: the diff or artifact is appended to the session as a display-only
custom message (`triggerTurn: false`, so an idle session spends no model turn),
then `ctx.ui.select` asks for the verdict and, for the two non-approve
verdicts, `ctx.ui.input` collects the note. Dismissing the verdict picker
re-routes to the main agent exactly as `human.ask` does; dismissing the note
prompt does not, because the verdict was already the decision and an empty note
is a legal outcome the workflow can branch on.

**One declaration mechanism for slash commands** (doctrine 05). A workflow
becomes a slash command through exactly one artifact: a `command.json` beside
its script, in one of three scan roots. `argsSchema` is a JSON Schema object
declaring the arguments; `src/workflow-commands.ts` generates the usage text
from it and validates every invocation before a run is launched. Nothing about
arguments is hand-written twice: the palette hint is the generated signature,
and the rejection message is the generated usage block, so a schema edit cannot
leave stale prose behind. Specs without `argsSchema` keep the pre-P3 behaviour
untouched, so the declaration is opt-in per workflow rather than a migration.

Slash-command text is untyped, which is why parsing is more than `JSON.parse`.
Bare text lands under `argKey`; non-object JSON is wrapped under `argKey` too
(`/loop-next 10` used to reach the script as the bare number `10`, where the
script's `maxSteps` lookup silently missed); declared `default` values are
filled; and a string that a schema declares as `integer`, `number` or `boolean`
is coerced when the literal converts exactly. The coercion and default passes
are hand-written on purpose: TypeBox's `Value.Convert` and `Value.Default` key
off an internal `Kind` symbol and are silent no-ops on the plain JSON Schema a
`command.json` carries, while `Value.Check` and `Value.Errors` do read plain
JSON Schema, so validation itself stays real JSON Schema semantics.

**Three scan roots, and a project may only add.** A `command.json` is found in
the package (`builtin`), in the agent dir (`user`), or in the repo Pi was
started in (`project`, at `<cwd>/.pi/workflows/<name>/`). The project root is
the point of P3b: a repo carries the workflows that only make sense inside it,
and nothing global is edited to install them. Precedence is first-root-wins in
that order, so a project cannot shadow a name the user already has — cloning a
repo must not silently redefine `/ship`. The shadowed spec is not dropped in
silence either; `/workflows` lists it as shadowed, together with every scope's
root path, which is the only way a user can tell an installed command from one
that arrived with a checkout. Deliberate cross-scope override stays deferred
with installable packs, where the precedence question has to be answered once
for all three scopes.

Two failure modes shape the discovery code in `src/workflow-commands.ts`. A
malformed spec in a builtin or user root throws, because those are the
operator's own files and a silent skip would hide a typo. A malformed spec in
the project root is collected and reported by `/workflows` instead: extension
load must not be abortable by a file that arrived with someone else's repo.
And a project-scope command refuses to run when `ctx.isProjectTrusted()` is
false, the same trust decision that gates project settings and roles; the
command stays registered and explains itself rather than vanishing. Note the
residual exposure honestly: Pi core does not count `.pi/workflows` among the
resources that require a trust prompt, so a repo whose only `.pi` content is
workflows is auto-trusted. Registration is inert — discovery reads JSON and
never executes the script — so the remaining requirement is that a human types
the command.

**The stage library is source, not a module.** A stage is a reviewed, reusable
workflow step: it takes an input record, runs one agent under a fixed output
contract, and returns a typed artifact, so `/build`, `/quick` and everything
after them share one planning prompt and one review contract instead of each
carrying a copy that drifts. The delivery mechanism is forced by the sandbox: a
workflow body runs inside `vm.createContext` with no module loader — no
`import`, no `require`, no filesystem — so shared code cannot be imported, only
injected. `runWorkflow` therefore appends `src/stages.ts`'s source to every body
before instrumentation, and everything in that source is a **function
declaration**.

Two consequences are load-bearing. Function declarations hoist, so
`stage("plan", { ... })` is callable from the script's first line although the
definitions sit after the author's `return`; a `const` there would spend the
whole run in its temporal dead zone. And appending rather than prepending keeps
the author's byte offsets unchanged — `instrumentWorkflow` turns each
`agent(...)` call's start/end offsets into that agent's call-site identity, which
retry and resume match on, so editing the library must not renumber user code.

The library is engine code and is deliberately not preflighted against the
caller's capabilities, which is why no stage hardcodes a model or a role: both
come from the caller, whose script *is* preflighted. The one thing the author
gives up is the name: a top-level `stage` (or `__stage*`) declaration is
rejected at launch by `stageLibraryConflict` in `src/validation.ts`, because the
concatenated source would otherwise be a `SyntaxError` raised inside a child
process, or worse, a silent override of the author's own function. Nested
declarations are untouched — those only shadow within their own scope.

`stage("review", ...)` returns the same `{ verdict, note }` shape as
`human.review`, with the same fixed `approve` / `changes` / `reject` vocabulary.
That is not a coincidence: it lets a workflow switch on `.verdict` without
knowing whether a model or a person judged the work, so swapping automated
review for human review is a one-line change.

`stage("exec", ...)` is the one stage whose artifact is not the agent's own
words. It opens (or reuses) a named worktree with `withWorktree`, records that
worktree's `HEAD` as a base commit *before* the agent exists, and after the
agent returns asks git — not the model — which files changed and what the diff
is. The agent is only asked for a `summary` and reviewer `notes`. An agent that
forgets, or declines, to mention an edit therefore cannot hide it: the reviewer
reads `git diff <base>`. Several exec calls sharing one worktree each report
only their own item's diff, because each takes its base at its own start, and
the engine commits the worktree as every agent returns.

`/build` (`workflows/build/`) is the first consumer of all three stages, and it
owns no prompt of its own — only wiring. It runs plan once, then per plan item
exec followed by review, and every exec call passes the same worktree name, so
item 2 sees item 1's code while each item still reports only its own diff. The
verdict vocabulary decides what happens next: `changes` is the one verdict a
repair pass can act on, because its note says precisely what to fix, so the note
becomes the next exec's context, up to `maxFixes` times. `reject` means the
approach is wrong, which another blind pass would entrench, so it ends that item
and leaves the verdict standing in the report.

What `checks.pi-loom-build-workflow` can prove stops where the network does. The
plan artifact, the exec diff and the review verdict all require an agent to have
returned, so the gate proves *ordering* instead: it installs the shipped
`workflows/build/` into a throwaway agent dir exactly as the system flake does,
rejects a task-less launch before a run exists, and launches with a model name
that does not resolve — which fails inside the plan phase, having entered no
item phase and opened no worktree. A `/build` that called exec before plan could
not produce that state.

`stage("quick", ...)` is `exec`'s deliberate opposite, and `/quick`
(`workflows/quick/`) is its only consumer: one agent, no plan, no review, and
**no worktree**. The trade is the one recorded in the decision table — plan →
exec → review on a typo is ceremony, and ceremony is what makes people route
around a workflow engine entirely — so the agent edits the user's own checkout
and the change is sitting unstaged in their tree when the run returns.

Dropping the worktree costs the diff base that `exec` gets for free, so `quick`
takes its own: before the agent exists, and again after it returns, it runs
`git add -A` and `git write-tree` **through a throwaway `GIT_INDEX_FILE`** and
keeps the resulting tree object. Two properties follow. The user's index,
working tree and refs are never touched — the only trace is unreferenced objects
that `git gc` prunes — and because both sides are captured identically,
everything that was already dirty at launch cancels out of the diff instead of
being attributed to the agent. The artifact is still git's rather than the
model's, which is the property `exec` and `quick` are unwilling to give up:
both return the same `{ summary, notes }` contract from the agent and let git
supply `files` and `diff`.

`checks.pi-loom-quick-workflow` stops at the same wall as `/build`'s gate: the
change itself needs a model. What it proves offline is that `/quick` reaches one
stage and only one — an unresolvable model name fails the run inside the `quick`
phase with no other phase entered, where a `/quick` that planned first would have
failed in `plan` — that no worktree was opened, and that the pre-agent snapshot
genuinely ran, by writing objects into a deliberately dirty probe repository
while leaving its index byte-identical and its `git status` output unchanged.

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
- **P3 — declaration mechanism.** One way to declare a workflow command, and
      one place a repo can keep its own. Split in two because the halves are
      independent: the argument contract is engine-side, the scan root is
      discovery-side.
  - **P3a — schema-declared args.** JSON-Schema `argsSchema` in
      `command.json` plus generated usage. *Accept: bad args are rejected with
      generated usage text and no run starts; the generated signature is what
      the command palette shows.*
  - **P3b — project scope.** Project-local `.pi/workflows/` scan root and a
      `/workflows` listing that names each command's scope. *Accept: a workflow
      dropped into a repo's `.pi/workflows/` appears as a slash command without
      restart-time editing of any global file, and `/workflows` shows where each
      command came from.*
- **P4 — stage library + `/build` + `/quick`.** *Accept: `/build "<task>"`
      emits a plan artifact, an exec diff, and a review verdict keyed per
      plan item; `/quick "<task>"` completes a one-line change with a single
      agent and no review stage.* Split in three because the library is the
      mechanism and the two commands are its first two consumers; landing the
      commands first would bake their prompts into their own scripts, which is
      the copy-paste drift the library exists to prevent.
  - **P4a — stage library.** `stage(name, input)` reaching every workflow
      body without an import, plus the `plan` and `review` stages. *Accept:
      a workflow calls a stage with no import; an unknown stage name and
      invalid stage input fail inside the sandbox before any agent launches;
      a script whose own top-level declaration collides with the library is
      refused at launch with a message naming the collision.*
  - **P4b — `exec` stage + `/build`.** The stage that writes code inside a
      worktree, and the workflow that chains plan → exec → review. *Accept:
      `/build "<task>"` emits a plan artifact, an exec diff, and a review
      verdict keyed per plan item.* Split in two: the stage is engine code with
      an offline-provable contract, the workflow is policy whose acceptance
      needs a real model, and bundling them would make the engine half
      unverifiable in CI.
    - **P4b-i — `exec` stage.** One plan item implemented inside an isolated
      git worktree, returning the diff git recorded rather than the diff the
      model claims. *Accept: exec is listed among the stages and enforces its
      input contract inside the sandbox; the worktree exists, is populated and
      is on its own engine-owned branch before the implementing agent is
      launched; the diff base is the worktree's own HEAD, read from inside it.*
    - **P4b-ii — `/build`.** The workflow chaining plan → exec → review over
      one worktree. *Accept: `/build "<task>"` emits a plan artifact, an exec
      diff, and a review verdict keyed per plan item.*
  - **P4c — `/quick`.** *Accept: `/quick "<task>"` completes a one-line
      change with a single agent, no plan stage and no review stage.*
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
