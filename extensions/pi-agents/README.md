# pi-agents

Multi-agent extension for pi. Root agents get six orchestration tools — `agent`, `agent_answer`, `agent_kill`, `agent_list`, `agent_output`, `agent_loop`. Every spawned child is a literal `pi --mode rpc` subprocess — a full pi session with all built-in tools, context files, skills, and user extensions — plus the child-mode `report`, `submit_answers`, and `ask_parent` wrappers; descendant-scoped orchestration tools are included only when maxDepth allows further nesting.

Every invocation carries a **contract**: AskUserQuestion-style questions (options, optional free text) the child must answer via `submit_answers` before its run can end. The tool result is those answers as data — the child behaves like a typed function call, not a chat transcript. `report` is a progress channel only.

An agent's lifetime is its contract: it exists from spawn until it answers, then it is removed. Follow-up work is a new spawn with the prior answers folded into the task. Recursive spawning is bounded by `pi-agents.json` via `maxDepth` and `maxLiveAgents`.

## Install

Bundled by this flake. Enable via the NixOS module:

```nix
programs.pi.extensions.agents = true;
```

`agents` is an `active`-stage extension and is included in the default
`pi-full` bundle.

For a one-off session without installing anything:

```bash
pi -e extensions/pi-agents/index.ts
```

## Configuration

Extension config is loaded from:

- Global (default): `~/.pi/agent/pi-agents.json`
- Project: `.pi/pi-agents.json`

Project settings override global settings.

Example:

```json
{
  "maxDepth": 1,
  "maxLiveAgents": 6,
  "model": "anthropic/claude-haiku-4-5",
  "panelModels": ["anthropic/claude-haiku-4-5", "openai/gpt-4o-mini"],
  "orchestrator": false,
  "sessionDir": ".pi/agents/sessions"
}
```

Depth is counted from the root session at depth `0`:

- `maxDepth: 0` → no spawned agents
- `maxDepth: 1` → root can spawn children, children cannot spawn descendants
- `maxDepth: 2` → grandchildren allowed

`maxLiveAgents` caps the total number of live agents kept in the in-memory registry at once.

Defaults: `maxDepth: 1`, `maxLiveAgents: 6`, no `model` or `panelModels` override, `orchestrator: false`.

`orchestrator: true` strips `write`/`edit`/`bash` from the main session at session start and adds pi's built-in `grep`/`find`/`ls`, so the main session can read and search but never execute: file mutations, builds, tests, and `git` inspection all route through spawned executor agents. The `/orchestrate` command toggles the same mode at runtime. There is no shell left to defect through, so nothing polices it — the tradeoff is that verification is whatever a child reports, not a fact the host checked.

`model` picks the model every spawned child runs on — the point being to push delegated work onto a cheaper model than the parent session. Accepted forms:

- `"provider/modelId"` — exact, e.g. `"anthropic/claude-haiku-4-5"`, `"vercel-ai-gateway/moonshotai/kimi-k2"` (provider is everything before the first `/`).
- `"modelId"` — bare id, accepted when exactly one available provider offers it; ambiguous ids are rejected with the list of qualified matches.

Unset means children inherit whatever model the parent session has active. A spec that resolves to nothing fails loudly: the session-start notification reports it and `agent` throws, rather than silently falling back. Descendants use the same configured model, not their parent's. The resolved model is passed to the child process as `--model <provider/modelId>` on its `pi` command line.

`sessionDir` names the directory child session JSONL files are written to, resolved against the parent cwd at use time. Defaults to `.pi/agents/sessions/` under the parent cwd. See [Session files](#session-files) below.

Unknown keys in `pi-agents.json` are a hard error, so a typo like `"models"` is reported instead of being silently ignored: a UI notification fires at session start, and `agent` throws until the config is fixed.

## Session files

Every child writes a durable per-child session JSONL, exactly like a real pi session — because the child is one. The file lives under `sessionDir` (default `.pi/agents/sessions/`) resolved against the parent cwd, and is named by pi (a random uuidv7, not computable). It is the durable transcript of the child's run: inspectable, resumable, and kept out of the parent's `/resume` session list on purpose.

The session file doubles as the audit directory for child activity. A background spawn returns the path immediately in its handle (`agent_list` lines carry a shortened version too), so the transcript of a detached child is discoverable before it finishes.

### Environment protocol (debugging)

The spawn machinery marks a child as a descendant via three env vars it adds to the `pi --mode rpc` subprocess:

- `PI_AGENTS_CHILD=1` — this process is a spawned child.
- `PI_AGENTS_DEPTH=<n>` — the child's depth (parent depth + 1).
- `PI_AGENTS_CONTRACT=<json>` — the normalized contract questions (without the host-added `__unable__` option; the child re-adds it).

`index.ts` reads these at the top of `multiAgent()` (`readChildEnv`); a child registers only the three child-mode tools (`submit_answers`/`report`/`ask_parent`) plus, when `depth + 1 <= maxDepth`, the root orchestration tools. The parent does not run the child's tools in-process — it reads the child's tool calls and answers from the RPC event stream. These vars are for debugging the boundary; you normally never touch them.

## Tools

### `agent(id, system_prompt, task, contract, [timeout_seconds], [background])`

Creates a new child agent with its own system prompt. The child is a literal `pi --mode rpc` subprocess: a full pi session with all built-in tools (`read`/`write`/`edit`/`bash`/`grep`/`find`/`ls`), context files, skills, and user extensions, plus the child-mode `report`, `submit_answers`, and `ask_parent` tools, and descendant-scoped orchestration tools when maxDepth allows further nesting. Blocks until the contract is fulfilled.

`contract` is a non-empty array of questions: `{ id?, label?, prompt, options?: [{label, value?, description?, recommended?}], allowOther? }`. The host normalizes it (caps: 8 questions, 8 options each, dedupe, derived ids) and appends an "Unable to determine" (`__unable__`) option to every question so the child can punt explicitly instead of fabricating. Zero options + `allowOther` (the default) makes a plain free-text question.

If the child ends a run without a valid `submit_answers` call, it is re-prompted ("nudged") up to 2 times, with each nudge restating the contract questions, then the call errors. On spawn errors the subtree is removed; the result content is the formatted answers, and `details.answers` carries them structurally.

A child is **removed as soon as its contract is fulfilled** — spawn is a typed function call: contract in, answers out, agent gone. There is no persistent-agent mode; the parent holds the answers as data and folds them into the next spawn's task when work continues.

Multiple `agent` calls in one turn run concurrently (parallel tool execution). Spawning is rejected when it would exceed configured `maxDepth` or `maxLiveAgents`.

- `timeout_seconds` — optional, must be a finite number greater than 0. If the child is still running when the deadline expires it is aborted, removed from the registry, and an error is thrown.
- `panel` — optional `{ size?: number, models?: string[] }` for an independent panel on one identical contract. Model precedence is explicit `models`, then configured `panelModels`, then configured `model`, then the parent session's model. Omitting `models` uses the configured roster; `panel: {}` uses the whole roster, while `size` takes its first N entries (or creates N clones when no roster is configured). If both explicit `models` and `size` are present they must agree, and the final count must be 2–5. Members run concurrently with ids `<id>-1` through `<id>-N`; the panel id itself is never registered. The result is one aggregate containing a per-question agreement tally, with `DISAGREEMENT` leading when members split. Tallying is mechanical only for questions with enumerated options; free-text answers are listed verbatim, not presented as consensus. Panel members do not receive `ask_parent`: a judge answers or punts with `__unable__` rather than suspending. A partial failure kills surviving members and fails the whole panel.
- `background` — optional boolean. Run the child detached: the tool returns immediately with a session handle (`details { id, sessionFile, background: true }`) while the child runs on a background promise. When it fulfills (or errors or times out) an injected follow-up message announces it (the delivery itself, participating in LLM context); inspect progress with `agent_output`. A background child that calls `ask_parent` suspends and injects an urgent steer message; `agent_answer` resumes it detached again, and its outcome is announced by another injected follow-up message. Blocking stays the default; `background` with `panel` is a hard error (see Background mode below for the full semantics).

**File-system access:** children are full pi sessions, so their `read`/`write`/`edit`/`bash` (and `grep`/`find`/`ls`) are pi's own built-ins, running against the child's inherited working directory. None of them are confined to that tree — absolute paths outside it are accepted, and a child's `bash` has the same OS-level file and network access as the user running pi. There is no sandbox; the working directory is a default, not a boundary.

### `ask_parent(questions)` (child-only)

Asks the parent for information using the contract question shape: `{ id?, label?, prompt, options?: [{label, value?, description?, recommended?}], allowOther? }`. The questions pass through the same host normalizer as `contract` (including derived ids, deduplication, and the question/option caps), and every question gets the host-added `__unable__` option. Calling again in the same turn revises the pending questions. The child run **suspends rather than ends**; `agent` returns the pending questions while the child stays alive and registered. The ask budget is capped at 8 asks per child; once exhausted, `ask_parent` errors and the child must submit its contract, using `__unable__` where blocked.

### `submit_answers(answers)` (child-only)

The contract's completion path. `answers` is `[{id, value}]`, one entry per contract question. Each value must be an option value, free text where the question permits it, or `__unable__` to punt. Invalid or incomplete submissions return a tool error listing the problems, so the child can correct and retry; a later call revises an earlier one within the same run.

### `report(message)` (child-only)

Progress channel. The parent reads a child's report calls from the child's RPC event stream and appends them under the answers in the final result; they also stream to the TUI during execution. They are **not** the result — if a child never calls `submit_answers`, the nudge loop kicks in, and after 2 nudges the run errors rather than silently returning prose; each nudge restates the contract questions.

### `agent_answer(id, answers, [timeout_seconds])`

Answers a suspended descendant's pending questions, then resumes it; the call blocks until the child fulfills its contract or asks again. Answers are checked by the same validator as contract submissions, including the host-added `__unable__` punt, so a parent may also not know. Access is subtree-scoped exactly like `agent_kill`: an agent can answer only descendants in its own subtree. A suspended agent remains registered and holds its `maxLiveAgents` slot until answered or killed.

### `agent_kill(id)`

Aborts a running child and frees its resources; descendants are killed recursively. Fulfilled contracts remove agents automatically, so this is the abort lever for stuck or unwanted runs.

### `agent_list()`

Lists currently active child agent IDs and their status. Because fulfilled contracts auto-remove agents, entries are in-flight runs. The root agent sees the full registry; descendant agents only see their own subtree. Background children are marked `(background)` and their line carries the session file path.

Example output:
```
• worker — running, depth 1, root child, anthropic/claude-haiku-4-5, 3 reports, contract pending
• reviewer — running, depth 2, parent worker, anthropic/claude-haiku-4-5, 0 reports, contract pending
• docs — running (background), depth 1, root child, anthropic/claude-haiku-4-5, 0 reports, session ~/.pi/agents/sessions/<uuidv7>.jsonl, contract pending
```

### `agent_output(id)`

Non-blocking peek at a background agent: status, model, action count, recent activity lines, reports so far, and its session file. Works for running and suspended (awaiting answers) children. A finished agent is removed after its follow-up message is delivered; the session file remains the audit record.

### Background mode

`background: true` on `agent` is push-only: the spawn returns a handle immediately and the drive loop runs detached — fulfillment, error, or timeout is announced by an injected follow-up message, which is the delivery itself:

1. The tool reserves + spawns exactly like a blocking spawn, but returns immediately with `{ id, sessionFile, background: true }`. The child runs on a promise stored on its state; the tool's own abort never kills it.
2. On fulfillment (or error / timeout) the result is announced by an injected message: `pi.sendMessage` with `deliverAs: "followUp"` and `triggerTurn: true`, so the announcement waits for the running turn to finish and joins the LLM context as a normal message (the delivery — the child's answers travel as rendered text in that message).
3. A background child that calls `ask_parent` suspends — it now needs an answer — and injects an urgent message with `deliverAs: "steer"` and `triggerTurn: true`, carrying the rendered questions and the `agent_answer` instruction. Answering resumes the child detached again; its outcome is announced by another injected follow-up message.
4. Background children do not survive session shutdown: `registry.shutdown()` aborts them like any child, so a background agent's lifetime is still exactly the parent session's. Adoption on restart (re-spawning from session files) is deferred.

`panel` + `background` together is a hard error ("panels cannot run in background yet").

### `agent_loop(workflow)`

Runs a deterministic goal-loop: spawn `strategy.population` doers toward a
`goal`, judge each candidate against `check.contract` (one checker child per
candidate, or a `panel` for more robust verdicts), keep the top
`strategy.survivors` by score, and iterate — mutating or pairing survivors —
until the best score reaches `converge.quorum` or the `budget` cap is hit.
`workflow` is declarative data only: no control flow, no expressions. It
reuses the `agent`/`panel` machinery wholesale — children get the same tools,
`maxDepth`/`maxLiveAgents` caps apply, `agent_kill` aborts an in-flight run,
and doers run on the cheap configured `model` while checkers may use a
`panelModels` roster.

The checker contract's FIRST question must be an enumerated verdict question
whose option values include `check.passValue` (scored mechanically); remaining
questions are folded into next-generation critiques as free text.

Example (plain refine loop):

```json
{
  "workflow": {
    "goal": "Refactor src/auth.ts so it has no any-typed casts and every function is pure where feasible.",
    "doer": {
      "system_prompt": "You are a careful senior refactorer. Produce the best artifact for the goal, then summarize what you changed.",
      "contract": [{ "prompt": "Summarize the refactor you produced and its verification." }]
    },
    "check": {
      "use": "panel",
      "system_prompt": "Judge the candidate artifact against the goal strictly on the evidence shown. Return the verdict option values.",
      "contract": [
        { "prompt": "Verdict?", "options": [{ "label": "pass" }, { "label": "fail" }] },
        { "prompt": "Strongest concrete improvement." }
      ],
      "passValue": "pass"
    },
    "strategy": { "population": 1, "survivors": 1 },
    "converge": { "quorum": 1 },
    "budget": { "maxGenerations": 3, "maxSpawns": 12 }
  },
  "timeout_seconds": 900
}
```

## Nix

Built inline by the root flake. All commands below run from the repository root.

```bash
# Build this extension alone
nix build .#pi-agents

# Build pi with all active extensions
nix build .#pi-full

# Dev shell with node 22
nix develop ./extensions/pi-agents
```

The package is the extension directory itself; the root flake's
`piWithExtensions` copies it into `share/pi/extensions/agents/` behind a
`PI_EXT_DISABLED` gate.

## TUI

While a child is running, you see a live activity feed with a braille spinner and a `⎿` continuation feed. The header carries the child's model, so a `model` override in `pi-agents.json` is visible at a glance:

```
⠹ worker · 6 actions · claude-haiku-4-5
  ⎿  → read src/auth.ts
  ⎿  ✓ read done
  ⎿  → edit src/auth.ts
  ⎿  ✓ edit done
  ⎿  ↑ report "Refactored auth to use tokens"
  Press Ctrl+O for live detail
```

Stats are joined with middle dots; token/cost usage appears in the header once the child has consumed tokens:

```
✓ worker · 6 actions · 1 report · claude-haiku-4-5 · ↑12.3k · ↓456 · $0.0042
```

When done, the header shows contract completion, and the collapsed body lists the answers (pi's expand key — Ctrl+O by default — shows the full activity log, reports, and contract):

```
✓ worker · 6 actions · 1 report · claude-haiku-4-5 · 2/2 answered
  • files-changed 3 files under src/auth/
  • risks ◌ unable to determine
```

A suspended child carries the status text `awaiting answers (2q)` in its header, for example:

```
✓ worker · 3 actions · claude-haiku-4-5 · awaiting answers (2q)
```

The model is a bare id, following pi's own `/model` picker; the provider is appended as a `[provider]` badge only when the child runs on a different provider than the session, so the common case stays short:

```
✓ worker · 6 actions · 1 report · kimi-k2 [vercel-ai-gateway]
```

## Flow

```
Parent: "Refactor auth and write tests in parallel"
├─ agent("refactor", "You refactor code.", "Refactor the auth module",
│              contract=[{prompt: "Which files changed?"},
│                        {prompt: "Behavior preserved?", options: [{label: "Yes"}, {label: "No"}]}])
│   ├─ child reads files, edits code
│   ├─ report("Refactored 3 files")          ← progress, streamed to parent
│   └─ submit_answers([{id: "question-1", value: "auth.ts, session.ts, index.ts"},
│                      {id: "question-2", value: "yes"}])   ← fulfilled; agent removed
│
└─ agent("tests", "You write tests.", "Write tests for auth",
               contract=[{prompt: "How many tests pass?"}])
    ├─ child reads code, writes test files
    └─ submit_answers([{id: "question-1", value: "12"}])   ← fulfilled; agent removed

// Both run concurrently. Parent gets both contracts' answers as data.

Parent: "Ask the worker if the migration needs a compatibility note"
└─ agent("worker", ...)
    ├─ child calls ask_parent([{prompt: "Is compatibility required?"}])
    └─ returns pending questions; worker stays alive and registered
Parent: "Compatibility is required"
└─ agent_answer("worker", [{id: "question-1", value: "yes"}])
    └─ worker resumes and submit_answers([{id: "question-1", value: "updated migration docs"}])

Parent: "Now update the migration docs for that refactor"
└─ agent("docs", "You write docs.",
               "The auth refactor changed auth.ts, session.ts, index.ts; behavior preserved. Update the migration docs.",
               contract=[{prompt: "Docs updated where?"}])
    └─ fresh executor; the prior answers travel in the task, not in agent state

Parent: "Is anything still running?"
└─ agent_list()
    └─ • docs — running, depth 1, root child, anthropic/claude-haiku-4-5, 0 reports, contract pending

Parent: "Abort it"
└─ agent_kill("docs")
    └─ running child aborted, subtree freed

Parent: "Is this diff safe to merge?"
└─ agent("diff-judge", "You judge diffs.", "Review the auth diff",
               contract=[{prompt: "Verdict?", options: [{label: "safe"}, {label: "unsafe"}]}],
               panel={models: ["anthropic/claude-haiku-4-5", "openai/gpt-4o-mini", "google/gemini-2.5-flash"]})
    ├─ diff-judge-1 · claude-haiku-4-5 → safe
    ├─ diff-judge-2 · gpt-4o-mini → unsafe
    └─ diff-judge-3 · gemini-2.5-flash → safe
    └─ result: DISAGREEMENT — safe: 2, unsafe: 1

Parent: "Draft the migration docs; I'll keep working meanwhile"
└─ agent("docs", "You draft docs.", "Draft the migration docs for the refactor.",
               contract=[{prompt: "Docs drafted where?"}],
               background=true)
    └─ returns { id: "docs", sessionFile: ".pi/agents/sessions/<uuidv7>.jsonl", background: true } immediately
    └─ parent keeps prompting on other tasks; child runs detached
    └─ child fulfills → injected follow-up message is the delivery:
       "[pi-agents] background agent docs finished" joins the LLM context
       carrying the answers as rendered text (nothing parked, nothing to collect)
```

## Caveats / Known Limitations

- **One model for ordinary spawns** — `model` in `pi-agents.json` applies to every ordinary child and descendant; panels use explicit per-member `models` when supplied, otherwise the configured `panelModels` roster, then `model`. Unset means ordinary children use the parent session's active model.
- **Panel lifecycle and cost** — killing a panel means killing member ids `<id>-1` through `<id>-N`; the panel id is never registered. A panel multiplies token cost by N, and each member counts individually against `maxLiveAgents`.
- **Panel consensus is narrow** — consensus is mechanical only on questions with enumerated options; free-text answers are listed verbatim rather than tallied.
- **Children run as subprocesses** — each child is a separate `pi --mode rpc` OS process with real isolation, so a crash or infinite loop in a child is contained rather than taking down the parent session. Teardown signals the child (SIGTERM, then SIGKILL after the grace window); the child's own `session_shutdown` — the SIGTERM handler pi runs — makes the cascade reach grandchildren. A background child is still a child of the parent session: session shutdown aborts it too.
- **Per-child startup cost** — each child is a fresh pi process, so a spawn pays pi's session startup (extension load, context init) before the contract prompt runs. Several concurrent spawns multiply that on first use; `maxLiveAgents` bounds how far concurrency can go.
- **`maxLiveAgents` is per-process** — each pi process enforces its own registry cap for its own descendants; there is no global cross-process budget, so a nested child's spawns are capped by its own config, not by the parent's registry.
- **Recursive spawning is config-bounded** — descendants may spawn more descendants only while doing so stays within configured `maxDepth` and `maxLiveAgents`.
- **Subtree-scoped control** — descendant agents can only manage agents in their own subtree; they cannot spawn into or kill arbitrary siblings' branches.
- **No file-system confinement** — child `read`/`write`/`edit`/`bash` are pi's built-in tools running with the user's OS-level file and network access. The working directory is where relative paths resolve, nothing more.
- **Full environment inheritance** — a child subprocess inherits the parent's entire environment plus the child-mode `PI_AGENTS_*` protocol vars; there is no env allowlist anymore. The old in-process child-bash allowlist was deleted with the rpc-child rewrite because children are full pi sessions that handle their own env. Environment secrets reach the child, and a child can read secrets in files via its own `bash`.
- **Child text is sanitized for the terminal** — reports and activity previews have ANSI/OSC escape sequences stripped before rendering, so a child cannot inject terminal control sequences into the TUI.
- **Suspended children hold capacity** — a child awaiting answers holds a live slot indefinitely; there is no suspension deadline. Kill it with `agent_kill` if it should be abandoned.
- **Upward asks are bounded** — each child gets at most 8 `ask_parent` calls; after that it must submit its contract (using `__unable__` where needed).
- **Contract nudges cost tokens** — a child that ends its run without `submit_answers` is re-prompted up to 2 times before the call errors; each nudge restates the contract questions. A wedged or refusing child burns those turns; `timeout_seconds` bounds the wall clock.

## License

MIT
