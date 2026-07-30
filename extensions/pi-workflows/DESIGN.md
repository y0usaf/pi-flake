# pi-workflows — design

A workflow shell for Pi. A session opens on a list of workflows, the chosen one
collects its inputs by asking the user, and then runs. Free-form conversation is
what happens when you dismiss the list.

The extension is a fork of `pi-extensible-workflows` 3.4.2 and ships both the
engine and the transcript renderer as two entry points of one package.

## Locked decisions

**2026-07-29 — The picker is the dispatch mechanism. There is no router.**
An earlier draft added a route table mapping input text to workflows, plus a
three-state session machine deciding where each keystroke went. Both were
deleted before implementation: if the user picks from a list, the human is the
router, and the list of workflow packs already on disk is the table. Nothing
classifies, matches or infers. `[[canon:least-code]]`.

**2026-07-29 — Questions are pack configuration, asked before launch.**
A pack declares a `questions` array in `command.json`; the picker asks them with
`ctx.ui.select` and `ctx.ui.input`, and the answers become the workflow's `args`
object. A pack that declares no questions but does declare `argKey` gets one
free-text question synthesized for that key, so every pack already on disk is
pickable without editing its `command.json`.
The alternative was an `ask()` primitive callable mid-script. That was
rejected as the more expensive shape: `checkpoint()` is the existing mid-run
question and it costs roughly forty dense lines in `host.ts:2045` because it must
persist an awaiting state, replay from the journal, fall back to
`workflow_respond` when no UI is attached, and survive abort. A value-returning
peer would additionally change the persisted answer type in `persistence.ts`,
since `awaitCheckpoint` resolves to a boolean. Asking up front costs none of
that and keeps the questions readable as data rather than as a code path.
`[[canon:least-power]]`, `[[canon:least-code]]`.

**2026-07-29 — Dispatch stays out of the model's hands.**
`exposeWorkflowTools` remains `false` (`src/host.ts:1631`), so the seven tools in
`INTERNAL_WORKFLOW_TOOLS` (`src/host.ts:20`) are absent from the default path. An
earlier proposal enumerated workflow templates in a tool description and let the
agent's tool selection do the routing; it was rejected because it moves the same
knowledge from a form you can read into a form you must run, and because the
agent may decline to use it on any given turn.

**2026-07-29 — The picker calls the same code path as the slash command.**
The pack scan at `host.ts:2775` already registers one slash command per pack and
launches it through `workflowTool.execute`. The picker reuses that handler rather
than reimplementing launch, so a pack has exactly one launch path whether it was
typed or chosen. `[[canon:no-privileged-path]]`.

**2026-07-29 — Two render surfaces, split by what Pi's primitives can do.**
Finished phases become custom session entries (`pi.appendEntry`): durable,
scrollable, they survive `/resume`, and the LLM never sees them. The single
in-flight phase is a widget (`ctx.ui.setWidget`): it animates and is ephemeral.
This is not a preference. `EntryRenderer` is
`(entry, { expanded }, theme) => Component` with no `invalidate()`, and
`pi.appendEntry` returns `void`, so an entry can neither animate nor be updated
after it is written.

**2026-07-29 — Group transcript rows by `phaseHistory`, not `structuralPath`.**
Measured across every run in `~/.pi/workflows/projects`: `phaseHistory` is
populated in all of them, `structuralPath` in one. Phases are also hard
barriers, because `phaseBridge` calls `scheduler.flush()` before recording one,
so no agent can straddle a phase boundary and grouping is never ambiguous.
`structuralPath` still drives extra indentation where it is present. One entry
per phase, not per agent: a 28-agent run writes six entries instead of
twenty-eight rows carrying the same information.

**2026-07-29 — Event names are imported from `./types.js`, superseding the
earlier local-declaration decision.** While the renderer lived in a separate
package, declaring the ten event-name strings locally avoided adding npm
resolution, a lockfile and a version pin in order to obtain strings. The fork
put producer and consumer in one package, so that cost is gone and
`src/transcript.ts:26` imports the names and payload types directly. A renamed
event is now a compile error instead of a silent no-op.

**2026-07-29 — Fork baseline: upstream 3.4.2 plus `src/transcript.ts`.**
Verified by direct comparison against the reference tree at
`@extensions/vekexasia_pi-extensible-workflows/`: every file in `src/` is
identical except `host.ts` and the new `transcript.ts`. The `host.ts` divergence
is 131 changed lines: three trailing blank lines inherited from the fork commit,
and the picker described above. Re-sync policy: take upstream releases by copying
the reference tree forward and reapplying our diff. Prefer new modules over edits
to `host.ts`; when a change must touch `host.ts`, say so in the commit message so
the re-sync cost is visible where it is incurred. The picker is such a change,
because the pack scan it extends already lives there.

## Architecture

Two extension entry points, declared in `package.json` under `pi.extensions`:
`src/index.ts` (engine) and `src/transcript.ts` (renderer).

**The extension boundary is `src/execution.ts`.** Workflow scripts do not run
in the host process. `execution.ts` forks a child process (`fork(childFile,
...)`, line 400) and evaluates the script inside a `node:vm` context with code
generation disabled (line 274) and every dangerous global replaced with
`undefined` (line 273). The child and host exchange only JSON-compatible values
over an RPC channel that rejects anything else (line 440). A script therefore
cannot hold a reference to host state at all; it can name an RPC method and
receive a value. `src/registry.ts` is the registration half of the same
boundary: extension-supplied functions receive `deepFreeze(structuredClone(...))`
inputs and their outputs are schema-checked before entering the journal
(`registry.ts:150`). `[[canon:functional-core]]`.

| Module | Kind | Responsibility |
|---|---|---|
| `types.ts` | decision | wire contract: event names, payload shapes, settings shape |
| `utils.ts` | machinery | freezing, cloning, JSON guards, model reference parsing |
| `validation.ts` | decision | what a valid settings file, schema and resource policy are |
| `registry.ts` | decision | what an extension may register; the catalog it produces |
| `execution.ts` | machinery | the fork + `vm` sandbox and its JSON RPC bridge |
| `agent-execution.ts` | machinery | real Pi sessions via `createAgentSession`, fair scheduling, steering |
| `budget.ts` | decision | aggregate spend limits and the instruction issued on breach |
| `persistence.ts` | machinery | `RunStore`, session leases, run directory layout |
| `host.ts` | decision | tools, commands, bridges, lifecycle hooks — everything Pi-facing |
| `transcript.ts` | machinery | phase entries and the in-flight widget |
| `herdr.ts` | machinery | handing a live agent session to a herdr pane |
| `session-handoff.ts` | machinery | turn-boundary handshake for that handover |
| `workflow-artifacts.ts` | machinery | run artifact paths |
| `workflow-evals*.ts`, `eval-capture-extension.ts` | machinery | offline eval harness, opt-in |

`host.ts` is 3,493 lines and holds every decision Pi can observe. It is not
being split: it is otherwise byte-identical to upstream, so a reorganisation
would cost the whole re-sync benefit and buy nothing that
`[[canon:least-code]]` values.

The workflow pack scan lives at `host.ts:2775` and reads three roots:
`<package>/workflows`, `<package>/../workflows`, and `<agentDir>/workflows`. A
pack is a directory holding `command.json` plus a script. The picker is the same
list, offered by `/workflows` and at session start.

State that outlives a single Pi process: none. `session_shutdown`
(`host.ts:3376`) marks every non-terminal run `interrupted`, aborts it, cancels
its scheduler work, releases the session lease and resets the registry.
`RunStore` persists enough to inspect and retry a run afterwards, but no process
keeps running. `[[canon:daemon-thin-client]]` is therefore `n/a`. What would
reverse it: a workflow that must keep executing while no Pi client is attached,
such as a scheduled or webhook-triggered run. At that point the run loop moves
behind a wire protocol carrying an integer version and Pi becomes one client.

## Deferred

- **Mid-run questions that return a value.** Only `checkpoint()`'s approve or
  reject is available inside a running script. Reversed by the first pack whose
  question depends on a value computed during the run; until then, questions are
  answerable before launch.
- **Routing free-form text to a workflow.** No table, no classifier. Reversed if
  picking from the list ever feels slower than typing the intent, which cannot be
  known before the list has entries.
- **Steering a running step by typing.** `steer` exists on agent sessions
  (`agent-execution.ts:831`) but the TUI path to it is the `/workflow` navigator,
  not the prompt. Abort already works. Reversed by a run that needs correcting
  mid-step often enough to be annoying.
- **Packs as catalog entries.** Packs produce a slash command and never enter
  `WorkflowRegistry`, so `workflow_catalog` cannot see them. This only matters if
  the agent dispatches workflows, which it does not.
- **No test harness.** `package.json` declares `test:layout`, `test:run` and
  `test:herdr` pointing at `test/workspace-layout.test.mjs` and
  `dist/test/*.test.js`; no `test/` directory was vendored, so `npm test` fails
  and `nix build` never notices because it runs only `npmBuildScript = "build"`.
  Upstream's tests were not part of the reference tree, and back-filling them is
  not planned.
- **Subtree collapse in the transcript.** `EntryRenderOptions` is `{ expanded }`
  only, so a row expands but a phase group cannot fold. Fine at 3–12 agents;
  revisit above roughly 30.
- **Themed widget lines.** `ctx.ui.setWidget` takes plain strings and receives
  no `Theme`, so only transcript entries are themed.
- **Repaint coalescing.** `paintWidget()` runs on every agent state change,
  unmeasured under a large fan-out. `[[canon:unix]]` says measure first, so this
  waits for a real run that shows the problem.

## Roadmap

| Phase | Done when |
|---|---|
| 1 — picker | **done 2026-07-29.** `/workflows` opens the pack list, and an interactive session offers it at startup; choosing a pack asks its questions and launches with the answers as `args`; dismissing leaves an ordinary session. `nix build .#pi-workflows` and `nix flake check` both exited 0. |
| 2 — packs worth picking | A third pack exists beyond `workflows/ideation` and `workflows/loop-next`, and at least one pack declares a multi-question `questions` array rather than relying on the synthesized `argKey` question. |
