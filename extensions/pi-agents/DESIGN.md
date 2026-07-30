# pi-agents DESIGN

Multi-agent orchestration for pi: root tools `agent`, `agent_answer`,
`agent_kill`, `agent_list`; in-process child `Agent` instances whose lifetime is exactly
one contract — spawn, answer, removed.

## Locked decisions

- **2026-08 — Root tools are a noun-prefix family: `agent`, `agent_answer`, `agent_kill`, `agent_list`.** `spawn` was the inaccurate part: it promises a background handle this extension explicitly does not have. The call blocks and the agent is removed when it returns, and background spawn / handle polling is listed under Deferred. Noun-prefix grouping keeps the four tools adjacent wherever tools are listed alphabetically. Precedent: Kimi Code CLI groups the same way (`Agent`/`AgentSwarm`, `TaskOutput`/`TaskStop`, `CronList`), as do modern CLIs (`docker container ls`, `gh pr create`). Bare `agent` matches Claude Code, which renamed its subagent tool `Task` to `Agent` in v2.1.63, and OpenCode's `task`; it also matches pi's own bare-word built-ins (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`), against which `spawn_agent` was the outlier. The smaller thing rejected, per `[[canon:least-code]]`: renaming only the spawn tool and leaving three verb_noun siblings — same churn, no grouping benefit. Panel plurality is deliberately not addressed by the name. A panel is still one delegation act with a strategy parameter; a separate swarm tool would relitigate the 2026-08 panels-as-a-parameter decision. Reversal condition: if models measurably mis-select the verb-less `agent` tool, restore a verb.
- **2026-08 — Panel roster is config data, not per-call LLM output.** Model choice moves down the least-power ladder from generated string to config file; explicit per-call `models` still wins because config is a default, not a lock. A smaller `size` takes the first N configured models, making list order a priority order, and the roster is validated at session start. Reversal condition: if per-call model choice proves necessary for panel quality, revisit the default roster.
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
  `reservedIds` is added before any `await` so parallel `agent` calls
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
- **2026-07 — Contract-first invocations; the result is data.** `agent`
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
  spawn — then revisit persistence, not before. Amended 2026-08: an unanswered
  upward ask suspends the contract rather than ending the agent; see the
  suspension decision below.
- **2026-08 — Upward asks suspend, not terminate.** Children get `ask_parent`
  with the same question shape, normalized by the same `normalizeContract`, and
  parents answer via `agent_answer`, validated by the same
  `validateContractAnswers`, including the host-added `__unable__` punt (a
  parent may not know either). Context preservation is the point: punt-plus-
  respawn already covered the terminal case. Suspended agents stay registered
  and count against `maxLiveAgents` because they hold context and memory.
  `MAX_ASKS` bounds parent round-trips, with the nudge cap as ultimate watchdog.
  `agent_answer` is subtree-scoped exactly like `agent_kill`; ancestor answering
  is legitimate. There is no suspension deadline: idle suspension costs
  nothing, while `agent_kill` and visible `awaiting answers` status cover
  abandonment. Reversal: add a deadline if abandoned suspended agents appear;
  restrict to direct-parent-only answering if ancestor answering causes confusion.
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
  the default. Amended 2026-08: `bash` leaves the main session as well; see
  the read-only orchestrator decision below.
- **2026-08 — Defection tripwire: detection over classification.** In
  orchestrator mode, `git status --porcelain` is snapshotted before each host
  bash call and compared after; a working-tree delta injects a loud steer-message
  correction. A bash command blocklist is an arms race against a Turing-complete
  shell, while the working tree is ground truth and catches writes by any
  binary. This is advisory, not blocking, so the correction remains visible in
  the transcript. Reversal condition: kernel-level read-only bash (bwrap via
  `spawnHook`) if loud-but-advisory proves insufficient. Amended 2026-08:
  the tripwire machinery was removed when orchestrator mode stopped exposing
  bash; see the read-only orchestrator decision below.
- **2026-08 — Contract answers fail loud at the cap.** Silent truncation
  violated the fail-loud rule on the extension's primary result channel;
  over-cap free-text answers are rejected with a reason and the child resubmits
  condensed via the existing revision path. The cap is 4000 chars because dense
  analysis answers were observed truncating mid-sentence at the former 2000-char
  cap.
- **2026-08 — Role presets are rejected as over-build.** Name-as-convention
  plus few-shot minimal executor/scout spawn shapes in `promptGuidelines`
  replace a host-owned preset table: the minimal legal contract is already one
  free-text question, so role identity lives in the agent id and a one-line
  system prompt by convention. The extension never parses agent ids for
  behavior; magic-string dispatch fails silent. Reversal condition: delegation
  still failing to occur after the gate and tripwire have had a fair trial.
- **2026-08 — Panels are a spawn parameter, not a separate consult tool.** A
  panel belongs on `agent`: aggregation already has a home in the
  existing result builder, while a second orchestration tool would trigger the
  registry extraction this document already names as the condition for
  splitting the module. The smaller thing rejected, per `[[canon:least-code]]`,
  is a separate `consult` tool. Model diversity is the feature, not panel size:
  N samples from one model correlate because they are the same function, not
  because the answer is right, so `models` is first-class and `size` alone is
  the degenerate case. Consensus is mechanical only for enumerated options;
  free-text answers are listed verbatim and never tallied, because exact
  string matches across free text are meaningless. Panel members have no
  `ask_parent`: a judge's job is a verdict under uncertainty, and
  `__unable__` already expresses "cannot determine" without holding a slot
  open. The no-`models` path follows ordinary child-model resolution rather
  than the parent's model, so panels and plain spawns cannot disagree about
  which model a child runs on. If a third distinct multi-agent shape beyond
  fan-out/join and executor delegation is being hand-repeated in prose across
  sessions, extract a declarative workflow format instead of growing more
  `agent` parameters.
- **2026-08 — The orchestrator reads but never executes.** `bash` joins
  `write`/`edit` in `ORCHESTRATOR_STRIPPED`, and orchestrator mode adds pi's
  built-in `grep`/`find`/`ls` to the active set. Search was the only thing
  `bash` was legitimately doing in the main session, and those three tools
  are already registered by `createAllToolDefinitions`, so the change is
  names in a set, not new code. With no shell in the main session defection
  is structurally impossible rather than advisorily corrected: the
  git-porcelain tripwire, the bash-classification clause of the gate prompt,
  and the matching `promptGuidelines` line are deleted with nothing
  replacing them. The cost is named and accepted — the orchestrator can no
  longer run `git diff` or `nix build`, so inspection and verification are
  delegated and arrive as contract answers, which makes verification a
  child's claim rather than a fact the host checked. The smaller thing
  rejected, per `[[canon:least-code]]`, is keeping `bash` and only adding
  `grep`/`find`/`ls`: it preserves the escape hatch the tripwire exists to
  police, so the snapshot machinery survives with it. A narrow allowlisted
  git-read tool was rejected as new code reintroducing the
  command-classification problem the tripwire decision already lost. A panel
  (gpt-5.6-sol, claude-fable-5, kimi-k3) split 2–1 against the stricter
  variant that also removes `read`; the grounding argument they shared — an
  orchestrator writing contracts about files it has never seen — is exactly
  what `read`/`grep`/`find`/`ls` answer. Children are unchanged: they keep
  `bash` and do not get `grep`/`find`/`ls` until a child is observed wasting
  tokens on unmanaged `rg` output. Reversal condition: one week of use in
  which a verifier child reports a passing build that a later host-side
  check contradicts, or in which wanting `git diff` in the main session is
  logged more than once a day — then restore `bash` with the tripwire, or
  take the deferred bwrap read-only shell.

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

The registry owns child lifecycle. The child extension boundary is
`buildChildAgent` (index.ts:1394-1414), which assembles `createChildTools`,
`createChildManagementTools`, and the child-only `buildReportTool`,
`buildSubmitAnswersTool`, and `buildAskParentTool`; everything a child can
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
  bash via `spawnHook`, Linux-only. Now the reversal path rather than the
  tripwire's escalation: it lands only if removing `bash` outright costs more
  in delegated verification than a sandboxed shell would cost in machinery.
- **Suspension deadline / requestId tokens** — duplicate or late agent_answer calls already fail loudly (claim lock, cleared pendingAsk); deadlines and generation tokens land only if abandonment or answer races are observed.

## Roadmap

- **Phase 1 (done 2026-07): testing stage.** Built and checked, excluded from
  `pi-full`. Exit criterion met: contract orchestration exercised end to end
  (spawn → contract → submit_answers → auto-removal) with no orphaned agents.
- **Phase 2 (current): active stage.** Ships in the default bundle. Criterion:
  one full week of regular use without a lifecycle bug report.
- **Phase 3 — incentive alignment.** Criterion: one week of orchestrator-mode
  use in which every file mutation either went through a spawned executor or
  tripped a visible correction.
- **Phase 4 — panel judgment.** Criterion: panels are used for at least one
  documented judgment call with a split verdict rendered as an option tally.
