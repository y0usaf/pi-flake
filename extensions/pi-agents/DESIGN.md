# pi-agents DESIGN

Multi-agent orchestration for pi: root tools `spawn_agent`, `delegate`,
`kill_agent`, `list_agents`; in-process child `Agent` instances with their own
tools and conversation history.

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
  spawn/delegate removes its own state in `finally` once the prompt settles,
  and only if `children.get(id) === state`. No work continues against an
  unregistered agent.
- **2026-08 — spawn removes on any error; delegate removes only on timeout.**
  A failed spawn leaves a child that never ran its task — useless, so it is
  torn down. A failed delegate leaves a working child with valuable history,
  so it survives ordinary errors; timeout is destructive because the child may
  be wedged.
- **2026-08 — Blocking spawn/delegate.** Tools return when the run finishes;
  parallel tool execution provides concurrency. No background-spawn handle
  API until a use case forces one.
- **2026-08 — Child-controlled text is sanitized before rendering.** Reports
  and activity previews pass through `stripControlSequences` (OSC, CSI, C0)
  so a prompt-injected child cannot write terminal escapes into the TUI.
- **2026-07 — Contract-first invocations; the result is data.** `spawn_agent`
  and `delegate` require an AskUserQuestion-style contract (questions,
  options, `allowOther`). The child gets a `submit_answers` tool; the run
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
  at 500. After the cap: error — spawn tears the child down (prior decision),
  delegate keeps it.
- **2026-07 — Contract schema diverges from pi-interview deliberately.**
  Zero options plus `allowOther` is a legal free-text question (edit-style
  tasks have no enumerable options); the host-added option is "Unable to
  determine" (`__unable__`) — an explicit punt beats fabrication; free-text
  answers cap at 2000 chars (agents write more than users).

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
  authorization, spawn/delegate/kill lifecycle — decision-making

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

## Roadmap

- **Phase 1 (current): testing stage.** Built and checked, excluded from
  `pi-full`. Criterion for leaving: orchestration exercised end to end in
  real sessions with no orphaned agents after timeout/kill, then set
  `stage = "active"` in `extensions/registry.nix`.
- **Phase 2: active stage.** Ships in the default bundle. Criterion: one
  full week of regular use without a lifecycle bug report.
