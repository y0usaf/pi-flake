# pi-agents DESIGN

Multi-agent orchestration for pi: root tools `agent`, `agent_answer`,
`agent_kill`, `agent_list`, `agent_output`, `agent_loop`.
Children are literal `pi --mode rpc` subprocesses whose lifetime is exactly
one contract — spawn, answer, removed (stage 2's rpc-child engine). Stage 3
adds opted-in background spawns (`background: true` on `agent`): the tool
returns a session handle immediately, the child runs detached, and the
outcome is delivered solely by an injected message
(see the 2026-08 background decisions below).

## Locked decisions

- **2026-08 — Children are pi subprocesses over RPC.** A spawned child is no
  longer an in-process `Agent`; it is a literal `pi --mode rpc` subprocess
  spawned via `process.execPath`, loading this same extension in child mode
  (the `PI_AGENTS_CHILD` env protocol in contract.ts). The parent reads the
  child's tool calls from the RPC event stream (`tool_execution_start` args)
  and the child's session JSONL under its dedicated session dir is the
  durable record. Rationale: every child writes a real session JSONL
  (durable transcript, inspectable, resumable) — visibility and
  crash-survival become properties inherited from pi rather than features
  built here; real OS isolation fires the reversal condition in the 2026-08
  no-file-system-confinement decision, making confinement (re)enforceable;
  children are "literally pi" (context files, skills, user extensions
  included). Recorded evidence: SIGTERM runs the child's `session_shutdown`,
  so a graceful cascade kills grandchildren; a stored `~/.pi/agent/auth.json`
  wins over env, so scrubbing the env keeps auth; extension deps resolve in
  the compiled binary via VIRTUAL_MODULES with no node_modules.
- **2026-08 — maxLiveAgents becomes per-process for descendants.** Each pi
  process enforces its own registry cap (`maxLiveAgents`); a global
  cross-process cap is deferred. Named divergence from the prior shared
  in-process budget: with children as separate OS processes there is no one
  registry to count against, so each process enforces its configured cap for
  its own descendants.
- **2026-08 — Child session files live under a dedicated session dir.** Child
  session JSONL defaults to `.pi/agents/sessions/` under the parent cwd,
  overridable via the `sessionDir` config key. Keeps the parent's `/resume`
  session list unpolluted and doubles as the audit directory for child
  activity.
- **2026-08-03 — The single-file split is user-directed; the registry extraction is sanctioned.**
  The user directed the modular split of the extension now, in advance of the
  2026-08+ decision's deferred trigger (a third orchestration feature, or a
  demonstrably unmaintainable file). The registry extraction in particular is
  sanctioned by its own reversal condition, which has fired: `agent_loop`'s
  interpreter (`runWorkflow`) is a second consumer of the registry machinery — it
  drives `spawnChild`/`spawnPanel`/`killSubtree` — the second consumer the registry
  extraction was waiting for. Per `[[canon:design-doc]]`: divergence from a
  documented decision is fine; undocumented divergence is drift — so the divergence
  is recorded here rather than happening silently. Scope is strictly structural: code
  moved verbatim into `config.ts`, `contract.ts`, `state.ts`; renderers consolidated
  in `render.ts`; `multiAgent()` and `children`/`reservedIds` moved out of
  `index.ts` into `registry.ts` as `createRegistry()`; `index.ts` is now a thin
  composition root wiring the registry, spawn, loop, and orchestrator modules (see
  Architecture for the module map). No behavior, message, constant, schema, or tool
  name changes.
- **2026-08+ — `agent_loop` lands as a second orchestration feature inside pi-agents.**
  A bounded single-loop interpreter (`goal` / `doer` / `check` / `strategy` /
  `converge` / `budget`) reuses `spawnChild` and `spawnPanel` as its execution
  machinery — no new spawn path, caps (`maxDepth`/`maxLiveAgents`) apply, and
  `agent_kill` aborts an in-flight loop. The registry-file-split extraction is
  deferred: it lands when a third orchestration feature appears or the file
  demonstrably exceeds maintainable size. The panel-usage gap fix (member
  `usage` now travels in `AgentToolDetails.panel.members`) rode along.
- **2026-08 — Leaf children do not receive orchestration tool schemas.** A child that cannot spawn receives no `agent`, `agent_answer`, `agent_kill`, or `agent_list` schemas, avoiding a large unusable contract schema tree. The gate reads the resolved per-cwd config, so project `maxDepth` overrides still allow legitimate nesting. Accepted loss: a leaf cannot use `agent_list` for self-introspection. Reversal condition: a child is observed needing `agent_list` purely for self-status.
- **2026-08 — Root tools are a noun-prefix family: `agent`, `agent_answer`, `agent_kill`, `agent_list`, `agent_output`.** `spawn` was the inaccurate part of the original name: it promised a background handle this extension did not have. Blocking remains default, and the deferred wait/status split landed (stage 3) as `agent_wait` and `agent_output` alongside a `background` flag on `agent` — still noun-prefixed, so the family stays adjacent whenever tools are listed alphabetically. **Amended 2026-08:** the wait/status split was then reversed — `agent_wait` and its mailbox were deleted; a background spawn returns a handle, `agent_output` peeks, and the injected follow-up message is the sole delivery (see the background-delivery reversal decision below). Precedent: Kimi Code CLI groups the same way (`Agent`/`AgentSwarm`, `TaskOutput`/`TaskStop`, `CronList`), as do modern CLIs (`docker container ls`, `gh pr create`). Bare `agent` matches Claude Code, which renamed its subagent tool `Task` to `Agent` in v2.1.63, and OpenCode's `task`; it also matches pi's own bare-word built-ins (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`). The smaller thing rejected, per `[[canon:least-code]]`: renaming only the spawn tool and leaving verb_noun siblings — same churn, no grouping benefit. Panel plurality is deliberately not addressed by the name. A panel is still one delegation act with a strategy parameter; a separate swarm tool would relitigate the 2026-08 panels-as-a-parameter decision. Reversal condition: if models measurably mis-select the verb-less `agent` tool, restore a verb.
- **2026-08 — Panel roster is config data, not per-call LLM output.** Model choice moves down the least-power ladder from generated string to config file; explicit per-call `models` still wins because config is a default, not a lock. A smaller `size` takes the first N configured models, making list order a priority order, and the roster is validated at session start. Reversal condition: if per-call model choice proves necessary for panel quality, revisit the default roster.
- **2026-08 — Child tools are pi's built-ins, not bespoke copies.** Children
  were first given `createReadTool`/`createWriteTool`/`createEditTool`/
  `createBashTool` against the child cwd — a previous hand-rolled suite
  (~230 lines) duplicated pi behavior with worse truncation, no diff
  details, and a TOCTOU-vulnerable confinement check. The env allowlist was
  applied via `spawnHook`; `exposeSessionEnvironment: false` kept session
  vars out of child shells. **Amended 2026-08 (stage 2):** the spawnHook
  allowlist governed in-process child bash, which no longer exists — children
  are now literal `pi --mode rpc` subprocesses that get pi's own built-ins
  (and extensions) with pi's own env handling, so the allowlist is dead code
  and was deleted. Auth note, verified: a stored `~/.pi/agent/auth.json`
  beats env anyway, so scrubbing the env would not strip child credentials.
  Reversal condition: bwrap-level isolation of child subprocesses, at which
  point a per-child env policy becomes enforceable again.
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
- **2026-08 — Blocking-spawn decision reversed for opted-in background spawns.** The deferred background entry's trigger fired (dated 2026-08): the user needs to keep prompting the main session during long child runs. `agent` gains `background: true` — the tool reserves + launches exactly as a blocking spawn, but returns immediately with a session-file handle (`details {id, sessionFile, background: true}`) while the drive loop runs detached on a promise stored on `ChildState.background`. The shape was the deferred entry's named wait/status split (`agent_wait`/`agent_output`) plus a background flag, not a default change: blocking stays the default because answers-as-tool-result is the cleaner contract when the parent has nothing else to do. The split landed as `agent_wait`/`agent_output`, then `agent_wait` and its mailbox were deleted (2026-08) because the injected follow-up message is the delivery and participates in LLM context; `agent_output` alone remains for peeking. The detached drive never rejects (an unhandled rejection must never surface outside the extension), so the promise is always awaitable.
- **2026-08 — Lifetime rule amended: a mailbox state between fulfillment and collection.** **REVERSED 2026-08 — no mailbox exists.** A background child that fulfills (or errors / times out) is torn down exactly like a blocking child — child process SIGTERM→SIGKILL, subtree removed, the `maxLiveAgents` slot freed — and the result is announced by an injected follow-up message, which is the delivery itself (it participates in LLM context). Nothing is parked: there is no bounded queue, no tombstones, no consume. `agent_output` on a finished id reports not-found (the agent is gone from the registry; the session file is the audit record).
- **2026-08 — Injection defaults: followUp for results, steer for asks.** A finished background child announces via `pi.sendMessage` with `deliverAs: "followUp"` + `triggerTurn: true` — the result waits for the running turn to finish so it cannot derail the parent mid-task (steer after a long run would inject mid-flight answers into an LLM prompt doing something else). A background child's `ask_parent` suspends someone who now needs an answer, so it injects with `deliverAs: "steer"` + `triggerTurn: true` carrying the rendered questions and the `agent_answer` instruction; answering it resumes the child detached (its outcome is announced by another injected follow-up message).
- **2026-08 — Background results deliver via injected follow-up message only; agent_wait and mailbox deleted.** The wait/status split (`agent_wait`/`agent_output`) LANDED with the background-spawn decision, then `agent_wait` and its entire mailbox/tombstone machinery were REMOVED because the injected follow-up message was already the delivery (per the injection-defaults decision above). Reasoning: the follow-up message participates in LLM context, so a separate pull mechanism (`agent_wait`) was redundant — the message was already the delivery. `agent_output` stays as the peek tool for status during a run. Tradeoff: no structured `details.answers` available to the parent after the fact — answers travel as rendered text in the message, not as parseable data. `agent_wait`'s `timeout_seconds` wait-for-live-child feature was also unused (the follow-up message model is push, not pull).
- **2026-08 — Background children do not survive session shutdown.** `registry.shutdown` aborts them like any child: a background agent's lifetime is still exactly the parent session's. Adoption on restart (re-spawning from session files) is deferred. `panel` + `background` together are a hard error ("panels cannot run in background yet") — see Deferred.
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
  at 500. After the cap: error, and the subtree is torn down. Amendment
  2026-08: the cap is lowered to 2 and each nudge carries the contract
  questions, because identical zero-information re-prompts were the cost;
  reverse this if children are observed first submitting after nudge 2.
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
  open. Amendment 2026-08: an all-free-text panel contract is now a pre-spawn
  hard error rather than a prose guideline. The no-`models` path follows ordinary child-model resolution rather
  than the parent's model, so panels and plain spawns cannot disagree about
  which model a child runs on. If a third distinct multi-agent shape beyond
  fan-out/join and executor delegation is being hand-repeated in prose across
  sessions, extract a declarative workflow format instead of growing more
  `agent` parameters. The trigger fires on a written record — the sessions
  and the shape named in Deferred — not on an impression that workflows would
  be nice; an unrecorded pattern has not fired it.
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

Modular extension; each module holds one DESIGN section and nothing else.
Public surfaces are deliberately narrow — each module's exports fit on one
screen, and the import graph is acyclic at runtime (`index.ts` is the
composition root; the value-level edges are `spawn.ts →
config/contract/state/registry`, `loop.ts → config/contract/state/registry/
spawn`, `registry.ts → state`, plus `render.ts → contract.ts`, `state.ts →
render.ts/contract.ts`, `contract.ts → config.ts`; type-only edges are
erased, and no module imports `index.ts`).

- `config.ts` — env allowlist (data); config load/validate + model
  resolution (decision-making: what limits apply, which model children run)
- `contract.ts` — contract schemas, normalization, answer validation, prompt
  rendering, the shared nudge-prompt builder (`buildNudgePrompt`), the
  child-only report/submit_answers/ask_parent tool schemas, the child-mode
  env protocol (`readChildEnv`/`buildChildEnv` + the `PI_AGENTS_*` vars), and
  the child-mode tool wrappers (`buildChildModeSubmitTool`/
  `buildChildModeReportTool`/`buildChildModeAskTool`) registered by index.ts's
  child-mode branch. The in-process `runUntilContractFulfilled` loop moved to
  rpc-child.ts; contract.ts keeps the pure nudge-text builder it shares
  (decision-making — pure)
- `state.ts` — child state, the `ChildEngine` interface (the live RPC process
  handle a ChildState owns), `subscribeRpcChild`, `collectResult`, usage/
  activity/timeout helpers, panel tally (machinery). ChildState also carries
  the detached background drive (`background.promise`, never-rejecting) and
  the spawn-time `timeoutSeconds` reused for detached resumes. The in-process
  `createChildTools` + `buildReportTool` were deleted with the stage-2
  rpc-child rewrite (children are pi subprocesses and no longer need bespoke
  in-process tool assembly).
- `rpc-child.ts` — subprocess spawn + JSONL event pump + the drive loop:
  spawns `pi --mode rpc` children via `process.execPath` with the child-mode
  env protocol from contract.ts, pumps their JSONL events, captures tool
  data from `tool_execution_start` args, and drives each contract run to
  fulfillment/suspension/error (machinery). LANDED with stage 2.
- `registry.ts` — the per-session registry created by `createRegistry()`
  inside `multiAgent()`: the `children` map, `reservedIds`, and every subtree
  operation (`getCallerState`, `isInSubtree`, `getSubtreeIds`,
  `getScopedEntries`, `formatScopedAgentIds`, `getAccessibleTarget`,
  `killSubtree`, `removeStateIfCurrent`, `listAgentsResult`), plus the
  session-shutdown teardown (`registry.shutdown()`). The registry
  owns child lifecycle (machinery).
- `spawn.ts` — spawn machinery: `createSpawnTools({ registry, session,
  getConfig, inject })` returning the `spawnChild`/`spawnPanel`/
  `answerAgent`/`killAgentResult`/`outputAgent` functions (typed
  `SpawnChildFn`/`SpawnPanelFn`/`AnswerAgentFn`/`KillAgentResultFn`/
  `OutputAgentFn`), the per-session `SessionState`, the
  internal run lifecycle `finishExchange`, the background detached drive
  `runDetached` (injects the follow-up message announcing a completed
  background run — the delivery itself — and steer-for-asks via the `inject`
  dep), and the tool schemas they own (`spawnSchema` + `background`,
  `answerAgentSchema`, `killSchema`, `listSchema`, `outputSchema`).
  `spawnChild` no longer assembles an in-process Agent (the old
  `buildChildAgent`/`createChildManagementTools` were deleted with the
  stage-2 rpc-child rewrite); it spawns a literal `pi --mode rpc` subprocess
  via rpc-child.ts and drives it to contract fulfillment/suspension/error
  (decision-making: the capacity/duplicate reservation and the panel cap live
  here)
- `loop.ts` — the `agent_loop` interpreter: `runWorkflow` +
  `LoopCandidate`/`LoopLedgerEntry` + `workflowSchema`/`agentLoopSchema`
  (`StringEnum` helper, `StaticWorkflowType`), assembled by
  `createLoop({ spawn, registry, getConfig })` (decision-making: quorum,
  strategy, and budget interpretation)
- `orchestrator.ts` — orchestrator mode: `ORCHESTRATOR_*` constants,
  `applyOrchestrator`, the `/orchestrate` command, and the
  `before_agent_start` gate hook, assembled by `createOrchestrator(pi)`
  (decision-making: which tools the main session sees)
- `render.ts` — renderers (machinery, TUI only)
- `index.ts` — thin composition root: the default-export `multiAgent()`,
  session-level state (`cachedRegistry`/`cachedGetApiKey`/`configCache`/
  `sessionTheme` on the `session` object), the registry instance + wiring
  (`getConfig`, `adoptSessionContext`, the spawn/loop/orchestrator factories),
  the inject callback (index.ts owns the `pi` ExtensionAPI handle and bridges
  spawn.ts's inject policy to `pi.sendMessage`), the six root-tool
  registrations (`agent`, `agent_answer`, `agent_kill`, `agent_list`,
  `agent_output`, `agent_loop`), and the
  `session_start`/`session_shutdown` handlers (decision-making + composition)

The child extension boundary is `rpc-child.ts` (stage 2, landed): it spawns
the child as a literal `pi --mode rpc` subprocess whose tools are the three
child-mode wrappers in contract.ts (`submit_answers`/`report`/`ask_parent`),
registered by index.ts's child-mode branch (`readChildEnv()` at the top of
`multiAgent`); the root orchestration tools register in child mode only when
`depth + 1 <= config.maxDepth`. The in-process boundary it replaced
(`buildChildAgent` in spawn.ts assembling `createChildTools`,
`createChildManagementTools`, `buildReportTool`, `buildSubmitAnswersTool`,
`buildAskParentTool`) was deleted — the parent now reads the child's tool
data from the RPC event stream instead of sharing in-process closures.
`[[canon:no-privileged-path]]` is `n/a` beyond that — the extension *is* the
feature; there is no builtins layer to split out. The registry extraction
reversal fired 2026-08+: `agent_loop`'s `runWorkflow` is the second consumer
of the registry (it drives `spawnChild`/`spawnPanel`/`killSubtree`), so the
registry moved into its own module (see the 2026-08-03 decision).

## Deferred

- **Per-spawn model override** — config sets one model for ordinary
  non-panel children. A per-member model is available for panels because
  model diversity is their purpose; a per-spawn override for an ordinary
  non-panel child remains deferred, with the tool schema as the obvious
  extension point.
- **Background panels** — `background: true` with `panel` is a hard error
  ("panels cannot run in background yet"): a panel's aggregate tally is a
  fan-out/join the parent typically waits for, and only the blocking path
  builds it today. Reversal condition: a recorded use case where a panel
  must keep running while the main session prompts onward.
- **Background children surviving session shutdown (adoption on restart)** —
  a background child killed by session end re-spawns from its session JSONL
  (the session file in the spawn handle is the recovery seed) when the next
  session opens with the same project. Needs a resumption protocol for child
  session dirs (pi names them with uuidv7) and a policy for "the old session
  is gone" ambiguity. Reversal condition: a recorded restart where the lost
  background work was genuinely needed rather than cheaply re-spawned.
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
- **Declarative workflow DAG** — a host-evaluated stage graph (fan-out over a
  prior stage's answers, dependency edges, answer interpolation) covering what
  a workflow script would, at rung 2-3 instead of rung 5. **PARTIALLY LANDED
  via `agent_loop` (2026-08+): a bounded single-loop interpreter — doers→
  checkers→select, repeated — is in; no DAG, no branches, and declarations
  ride on panel/agent spawn parameters rather than a stage graph.** The
  waived-trigger divergence: the third-shape trigger was named as a
  precondition for any declarative format, and `agent_loop` landed without a
  recorded third shape, on request, to prove the orchestration family can
  compose on the existing spawn machinery. Remaining DAG features (stages,
  edges, interpolation) stay deferred until a recorded need. The rejected form is
  upstream `pi-dynamic-workflows`' vm-sandboxed JS script: it is rung 5 where
  the trigger names a declarative format, its determinism claim does not
  survive LLM children, `ask_parent` has no answerer when the parent is a
  script, and a plan frozen at script-authoring time is less adaptive than an
  orchestrator that re-plans each turn with every child's answers in hand. Also
  rejected: upstream's `opts.schema`/`structured_output` as a second result
  channel next to contracts. Record instances here, dated, when a third shape
  is actually observed being hand-repeated.
- **Child crash checkpoint/resume** — a host crash or kill destroys an
  in-flight child's transcript, leaving partially-applied edits on disk with
  no resume. Rejected as the extension's first write path: a checkpoint file
  is a disk twin of the `children` map that every teardown path must
  maintain, while the data worth having already sits lower on the
  least-power ladder — the parent session JSONL under `~/.pi/agent/sessions/`
  persists the child's spawn args before the tool runs, and the working tree
  holds whatever landed. The genuinely expensive artifact, the child's
  accumulated transcript, is unrecoverable either way: `initialState` cannot
  carry `pendingToolCalls`, `continue()` requires the transcript to end on a
  user or tool-result message, and replaying tool calls whose write/edit/bash
  effects already hit disk is not idempotent. Recovery is a re-spawn from the
  session JSONL's spawn args plus `git status`/`git diff`, with the
  interruption stated in the task. Reversal condition: task-only
  checkpoint/resume (spawn params + contract + reports, resumed with a fresh
  `Agent` and `prompt()`, never `continue()`) lands only together with the
  deferred background-spawn/handle API, and only after this entry holds two
  dated incident records — each naming the host session file and the child id
  — in which a crash destroyed an in-flight run that re-spawn could not
  recover without redoing more than 30 minutes of child wall-clock work.
  Raising `maxDepth` above 1 is a separate trigger: a grandchild's spawn args
  live only in its parent child's in-memory transcript, so the JSONL fallback
  does not cover nested subtrees. A write-only post-mortem log is the cheaper
  variant if debugging rather than recovery is what is wanted — it needs no
  teardown maintenance, so the disk-twin objection does not apply.

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
- **Phase 5 — subprocess children.** Criterion: one spawn end-to-end over RPC
  with contract answers captured from the event stream.
