# pi-agents DESIGN

Multi-agent orchestration for pi: root tools `spawn_agent`, `kill_agent`,
`list_agents`; in-process child `Agent` instances whose lifetime is exactly
one contract — spawn, answer, removed.

## Locked decisions

- **2026-08 — Child tools are pi's built-ins, not bespoke copies.** Children
  get `createReadTool`/`createWriteTool`/`createEditTool`/`createBashTool`
  against the child cwd. A previous hand-rolled suite (~230 lines) duplicated
  pi behavior with worse truncation, no diff details, and a TOCTOU-vulnerable
  confinement check. The env allowlist is applied via `spawnHook`;
  `exposeSessionEnvironment: false` keeps session vars out of child shells.
- **2026-08 — No file-system confinement.** `bash` is unconfined by design, so
  a path-checking layer on read/write/edit only stops accidents, not an
  adversarial child — and its realpath check was raceable via `bash`. Dropped
  in favor of honest documentation: cwd is a default, not a boundary.
  Reversal condition: children move to real process/OS isolation, at which
  point confinement becomes enforceable and worth restoring.
- **2026-08 — Spawn reserves synchronously, teardown is identity-checked.**
  `reservedIds` is added before any `await` so parallel `spawn_agent` calls
  cannot both pass the capacity/duplicate checks. `killSubtree` marks states
  killed and aborts them, but only deletes idle states; an in-flight
  spawn removes its own state in `finally` once the prompt settles,
  and only if `children.get(id) === state`. No work continues against an
  unregistered agent.
- **2026-08 — The subtree is removed on any error.** A failed run leaves
  nothing behind; there is no partially-alive agent state to reason about.
- **2026-08 — Spawning is always asynchronous.** `spawn_agent` returns a handle
  immediately and the agent runs in the background; when its run settles, the
  result is pushed into the session via
  `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` and the
  agent is removed. The parent is never held in a "working" state, so it can
  chat while agents run. Panels are async too: N members run in the background
  and one aggregated tally is pushed when all settle. `list_agents` is the
  status channel and `kill_agent` aborts a running agent.
- **2026-08 — Child-controlled text is sanitized before rendering.** Reports
  and activity previews pass through `stripControlSequences` (OSC, CSI, C0)
  so a prompt-injected child cannot write terminal escapes into the TUI.
- **2026-07 — Contract-first invocations; the result is data.** `spawn_agent`
  requires an AskUserQuestion-style contract (questions, options,
  `allowOther`). The child gets a `submit_answers` tool; the run
  completes only once it has been called, and the tool result is the
  validated answers — `report` is demoted to a progress channel. Prose
  results were unparseable and had no mechanical done-check; answers-as-data
  moves the result down the least-power ladder (`[[canon:least-power]]`).
  Normalization is ported from pi-interview `protocol.ts`, not shared:
  second consumer, extract a shared module when a third appears.
- **2026-07 — Contract enforcement is a capped nudge loop.** A model cannot
  be prevented from ending its turn, so an unfulfilled contract is re-prompted,
  at most `MAX_CONTRACT_NUDGES` (10) times — the watchdog bound; abort,
  timeout, and kill still interrupt it. A model refusing at nudge 10 refuses
  at 500. After the cap: error, and the subtree is torn down.
- **2026-07 — Contract schema diverges from pi-interview deliberately.**
  Zero options plus `allowOther` is a legal free-text question (edit-style
  tasks have no enumerable options); the host-added option is "Unable to
  determine" (`__unable__`) — an explicit punt beats fabrication; free-text
  answers cap at 2000 chars (agents write more than users).
- **2026-07 — An agent's lifetime is its contract; delegate and keep are
  removed.** The subtree is removed the moment it answers, unconditionally.
  A keep/delegate persistence mode existed for one release; it made survival
  a per-call boolean an LLM parent had to repeat correctly forever, and
  contract answers already travel as data into the next spawn's task.
  Reversal condition: executors demonstrably rebuilding large context every
  spawn — then revisit persistence, not before.
- **2026-08 — Panels are a `spawn_agent` parameter, not a separate consult tool.**
  A panel is N independent judges on one identical contract, fanning out
  to `<id>-1..N` and aggregating into a per-question agreement tally.
  Aggregation already has a home in the existing result builder, while a
  second orchestration tool would trigger the registry extraction this
  document already names as the condition for splitting the module. Model
  diversity is the feature, not panel size: N samples from one model
  correlate because they are the same function, not because the answer is
  right, so `models` (and the `panelModels` config roster) is first-class and
  `size` alone is the degenerate case. Consensus is mechanical only for
  enumerated options; free-text answers are listed verbatim and never
  tallied, because exact string matches across free text are meaningless.
  A partial member failure kills surviving members and fails the whole
  panel. If a third distinct multi-agent shape beyond fan-out/join and
  executor delegation is being hand-repeated in prose across sessions,
  extract a declarative workflow format instead of growing more
  `spawn_agent` parameters.
- **2026-08 — Orchestrator mode: the main session delegates mutations.**
  The `orchestrator` config key (default false) and the `/orchestrate`
  command strip `write`/`edit`/`bash` from the main session via
  `pi.setActiveTools`; schema removal beats a `tool_call` block, which
  leaves the tool visible and burns turns on rejections. `read`/`find`/
  `grep`/`ls` stay so the orchestrator can gather context and verify;
  `bash` is stripped because it is the write escape hatch (`sed -i`) —
  remove the hatch rather than police it. `maxDepth` stays 1: the
  evidenced pattern is one orchestrator
  with parallel workers (Anthropic's research system; Cognition's
  context-loss argument against deep delegation) — each extra hop
  re-summarizes the task in prose, and blocking spawns make a deep chain
  serialize while consuming the shared maxLiveAgents budget. Reversal: a
  demonstrated executor→verifier need raises maxDepth per-project, not
  the default.
- **2026-08 — Per-spawn working directory.** `spawn_agent` takes an optional
  `cwd`, resolved against the spawner's cwd (session cwd for the root, the
  spawning agent's cwd for descendants); default is the session cwd. No
  confinement — cwd is a default, not a boundary, consistent with the existing
  no-file-system-confinement decision. Enables one orchestrator to fan out
  children across multiple project folders.

## Architecture

Single-file extension (`index.ts`). Sections, in order:

- env allowlist — data
- schemas + config load/validate — decision-making (what limits apply,
  which model children run)
- contract normalization, answer validation, prompt rendering, nudge loop —
  decision-making (pure except the loop's prompts)
- `stripControlSequences`, timeout helpers, activity formatting — machinery
- `createChildTools` — thin wrappers over pi built-ins — machinery
- child state, `subscribeChild`, `collectResult` — machinery
- renderers — machinery (TUI only)
- `multiAgent()` — registry (`children`, `reservedIds`), subtree
  authorization, spawn/kill lifecycle, panel fan-out/join — decision-making

The registry owns child lifecycle. The extension boundary is
`createChildTools` + `createChildManagementTools`: everything a child can
invoke is declared there. `[[canon:no-privileged-path]]` is `n/a` beyond
that — the extension *is* the feature; there is no builtins layer to split
out. Reversal: if a second orchestration feature (e.g. teams, shared
blackboard) appears, extract a registry module both use.

## Deferred

- **Per-spawn model override** — config sets one model for ordinary
  non-panel children. A per-member model is available for panels because
  model diversity is their purpose; a per-spawn override for an ordinary
  non-panel child remains deferred, with the tool schema as the obvious
  extension point.
- **Background spawn / handle polling** — shipped as always-async spawning with
  the result pushed into the session on settle (see Locked decisions).
  `list_agents` is the status channel.
- **Hard process-wide caps on config values** — project `.pi/pi-agents.json`
  can raise `maxDepth`/`maxLiveAgents` arbitrarily. Accepted because the user
  opts into the extension per-project; hard caps land if multi-agent runs
  prove expensive in practice.
- **Resource budgets** (report bytes, spawn churn, token budget) — no
  evidence of abuse yet; `maxLiveAgents` bounds concurrency, which is the
  practical cost driver.

## Roadmap

- **Phase 1 (done 2026-07): testing stage.** Built and checked, excluded from
  `pi-full`. Exit criterion met: contract orchestration exercised end to end
  (spawn → contract → submit_answers → auto-removal) with no orphaned agents.
- **Phase 2 (current): active stage.** Ships in the default bundle. Criterion:
  one full week of regular use without a lifecycle bug report.
