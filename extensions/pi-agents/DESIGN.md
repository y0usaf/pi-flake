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
- **2026-08 — Blocking spawn.** The tool returns when the run finishes;
  parallel tool execution provides concurrency. No background-spawn handle
  API until a use case forces one.
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
- **2026-08 — Orchestrator mode: the main session delegates mutations.**
  The `orchestrator` config key (default false) and the `/orchestrate`
  command strip `write`/`edit` from the main session via
  `pi.setActiveTools`; schema removal beats a `tool_call` block, which
  leaves the tool visible and burns turns on rejections. `read`/`bash`
  stay so the orchestrator can gather context and verify; `bash` is a
  known escape hatch (`sed -i`), so this is a strong default, not a
  sandbox. `maxDepth` stays 1: the evidenced pattern is one orchestrator
  with parallel workers (Anthropic's research system; Cognition's
  context-loss argument against deep delegation) — each extra hop
  re-summarizes the task in prose, and blocking spawns make a deep chain
  serialize while consuming the shared maxLiveAgents budget. Reversal: a
  demonstrated executor→verifier need raises maxDepth per-project, not
  the default.
- **2026-08 — Defection tripwire: detection over classification.** In
  orchestrator mode, `git status --porcelain` is snapshotted before each host
  bash call and compared after; a working-tree delta injects a loud steer-message
  correction. A bash command blocklist is an arms race against a Turing-complete
  shell, while the working tree is ground truth and catches writes by any
  binary. This is advisory, not blocking, so the correction remains visible in
  the transcript. Reversal condition: kernel-level read-only bash (bwrap via
  `spawnHook`) if loud-but-advisory proves insufficient.
- **2026-08 — Contract answers fail loud at the cap.** Silent truncation
  violated the fail-loud rule on the extension's primary result channel;
  over-cap free-text answers are rejected with a reason and the child resubmits
  condensed via the existing revision path. The cap rises from 2000 to 4000
  chars because dense analysis answers were observed truncating mid-sentence at
  2000.
- **2026-08 — Role presets are rejected as over-build.** Name-as-convention
  plus few-shot minimal executor/scout spawn shapes in `promptGuidelines`
  replace a host-owned preset table: the minimal legal contract is already one
  free-text question, so role identity lives in the agent id and a one-line
  system prompt by convention. The extension never parses agent ids for
  behavior; magic-string dispatch fails silent. Reversal condition: delegation
  still failing to occur after the gate and tripwire have had a fair trial.

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
  authorization, spawn/kill lifecycle — decision-making

The registry owns child lifecycle. The extension boundary is
`createChildTools` + `createChildManagementTools`: everything a child can
invoke is declared there. `[[canon:no-privileged-path]]` is `n/a` beyond
that — the extension *is* the feature; there is no builtins layer to split
out. Reversal: if a second orchestration feature (e.g. teams, shared
blackboard) appears, extract a registry module both use.

## Deferred

- **Per-spawn model override** — config sets one model for all children.
  Deferred until per-role models are actually needed; the tool schema is the
  obvious extension point.
- **Background spawn / handle polling** — blocking semantics plus parallel
  tool calls cover current use. A `wait_agent`/`status` split is the planned
  shape if long-running children become common.
- **Hard process-wide caps on config values** — project `.pi/pi-agents.json`
  can raise `maxDepth`/`maxLiveAgents` arbitrarily. Accepted because the user
  opts into the extension per-project; hard caps land if multi-agent runs
  prove expensive in practice.
- **Resource budgets** (report bytes, spawn churn, token budget) — no
  evidence of abuse yet; `maxLiveAgents` bounds concurrency, which is the
  practical cost driver.
- **Kernel-level read-only bash for orchestrator mode** — bwrap-wrapped host
  bash via `spawnHook`, Linux-only. Deferred until the defection tripwire proves
  insufficient.

## Roadmap

- **Phase 1 (done 2026-07): testing stage.** Built and checked, excluded from
  `pi-full`. Exit criterion met: contract orchestration exercised end to end
  (spawn → contract → submit_answers → auto-removal) with no orphaned agents.
- **Phase 2 (current): active stage.** Ships in the default bundle. Criterion:
  one full week of regular use without a lifecycle bug report.
- **Phase 3 — incentive alignment.** Criterion: one week of orchestrator-mode
  use in which every file mutation either went through a spawned executor or
  tripped a visible correction.
