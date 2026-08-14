# pi-agents

Multi-agent extension for pi. Root agents get three orchestration tools — `spawn_agent`, `kill_agent`, `list_agents` — plus every spawned child gets `read`, `write`, `edit`, `bash`, `report`, `submit_answers`, and descendant-scoped orchestration tools of its own.

Every invocation carries a **contract**: AskUserQuestion-style questions (options, optional free text) the child must answer via `submit_answers` before its run can end. The tool result is those answers as data — the child behaves like a typed function call, not a chat transcript. `report` is a progress channel only.

An agent's lifetime is its contract: it exists from spawn until it answers, then it is removed. Follow-up work is a new spawn with the prior answers folded into the task. Recursive spawning is bounded by `pi-agents.json` via `maxDepth` and `maxLiveAgents`.

## Install

Bundled by this flake. Enable via the NixOS module:

```nix
programs.pi.extensions.agents = true;
```

`agents` is a `testing`-stage extension: built and checked, but not in the
default `pi-full` bundle, so it stays opt-in until the orchestration path has
been exercised end to end.

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
  "orchestrator": false
}
```

Depth is counted from the root session at depth `0`:

- `maxDepth: 0` → no spawned agents
- `maxDepth: 1` → root can spawn children, children cannot spawn descendants
- `maxDepth: 2` → grandchildren allowed

`maxLiveAgents` caps the total number of live agents kept in the in-memory registry at once.

Defaults: `maxDepth: 1`, `maxLiveAgents: 6`, no `model` override, `orchestrator: false`.

`orchestrator: true` strips `write`/`edit`/`bash` from the main session at session start, so file mutations route through spawned executor agents; `read`/`find`/`grep`/`ls` stay for context-gathering and verification. The `/orchestrate` command toggles the same mode at runtime. `bash` is stripped because it is the write escape hatch (`sed -i`) — remove the hatch rather than police it.

`model` picks the model every spawned child runs on — the point being to push delegated work onto a cheaper model than the parent session. Accepted forms:

- `"provider/modelId"` — exact, e.g. `"anthropic/claude-haiku-4-5"`, `"vercel-ai-gateway/moonshotai/kimi-k2"` (provider is everything before the first `/`).
- `"modelId"` — bare id, accepted when exactly one available provider offers it; ambiguous ids are rejected with the list of qualified matches.

Unset means children inherit whatever model the parent session has active. A spec that resolves to nothing fails loudly: the session-start notification reports it and `spawn_agent` throws, rather than silently falling back. Descendants use the same configured model, not their parent's.

Unknown keys in `pi-agents.json` are a hard error, so a typo like `"models"` is reported instead of being silently ignored: a UI notification fires at session start, and `spawn_agent` throws until the config is fixed.

## Tools

### `spawn_agent(id, system_prompt, task, contract, [timeout_seconds])`

Creates a new child agent with its own system prompt. The child gets `read`, `write`, `edit`, `bash`, `report`, `submit_answers`, and descendant-scoped `spawn_agent`/`kill_agent`/`list_agents` tools. Blocks until the contract is fulfilled.

`contract` is a non-empty array of questions: `{ id?, label?, prompt, options?: [{label, value?, description?, recommended?}], allowOther? }`. The host normalizes it (caps: 8 questions, 8 options each, dedupe, derived ids) and appends an "Unable to determine" (`__unable__`) option to every question so the child can punt explicitly instead of fabricating. Zero options + `allowOther` (the default) makes a plain free-text question.

If the child ends a run without a valid `submit_answers` call, it is re-prompted ("nudged") up to 10 times, then the call errors. On spawn errors the subtree is removed; the result content is the formatted answers, and `details.answers` carries them structurally.

A child is **removed as soon as its contract is fulfilled** — spawn is a typed function call: contract in, answers out, agent gone. There is no persistent-agent mode; the parent holds the answers as data and folds them into the next spawn's task when work continues.

Multiple `spawn_agent` calls in one turn run concurrently (parallel tool execution). Spawning is rejected when it would exceed configured `maxDepth` or `maxLiveAgents`.

- `timeout_seconds` — optional, must be a finite number greater than 0. If the child is still running when the deadline expires it is aborted, removed from the registry, and an error is thrown.

**File-system access:** child `read`, `write`, `edit`, and `bash` are pi's built-in tools, created against the child's inherited working directory. None of them are confined to that tree — absolute paths outside it are accepted, and `bash` has the same OS-level file and network access as the user running pi. There is no sandbox; the working directory is a default, not a boundary.

### `submit_answers(answers)` (child-only)

The contract's completion path. `answers` is `[{id, value}]`, one entry per contract question. Each value must be an option value, free text where the question permits it, or `__unable__` to punt. Invalid or incomplete submissions return a tool error listing the problems, so the child can correct and retry; a later call revises an earlier one within the same run.

### `report(message)` (child-only)

Progress channel. Reports stream to the parent via `tool_execution_update` during execution and are appended under the answers in the final result. They are **not** the result — if a child never calls `submit_answers`, the nudge loop kicks in, and after 10 nudges the run errors rather than silently returning prose.

### `kill_agent(id)`

Aborts a running child and frees its resources; descendants are killed recursively. Fulfilled contracts remove agents automatically, so this is the abort lever for stuck or unwanted runs.

### `list_agents()`

Lists currently active child agent IDs and their status. Because fulfilled contracts auto-remove agents, entries are in-flight runs. The root agent sees the full registry; descendant agents only see their own subtree.

Example output:
```
• worker — running, depth 1, root child, anthropic/claude-haiku-4-5, 3 reports, contract pending
• reviewer — running, depth 2, parent worker, anthropic/claude-haiku-4-5, 0 reports, contract pending
```

## Nix

A subflake, wired into the root flake as the `piAgents` path input. All commands below run from the repository root.

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

While a child is running, you see a live activity feed with a braille spinner. The header carries the child's model, so a `model` override in `pi-agents.json` is visible at a glance:

```
⠹ worker · 6 actions · claude-haiku-4-5
  → read src/auth.ts
  ✓ read done
  → edit src/auth.ts
  ✓ edit done
  ↑ report "Refactored auth to use tokens"
```

When done, the header shows contract completion, and the collapsed body lists the answers (pi's expand key — Ctrl+O by default — shows the full activity log, reports, and contract):

```
✓ worker · 2/2 answered · 6 actions · 1 report · claude-haiku-4-5
  • files-changed 3 files under src/auth/
  • risks ◌ unable to determine
```

The model is a bare id, following pi's own `/model` picker; the provider is appended as a `[provider]` badge only when the child runs on a different provider than the session, so the common case stays short:

```
✓ worker · 6 actions · 1 report · kimi-k2 [vercel-ai-gateway]
```

## Flow

```
Parent: "Refactor auth and write tests in parallel"
├─ spawn_agent("refactor", "You refactor code.", "Refactor the auth module",
│              contract=[{prompt: "Which files changed?"},
│                        {prompt: "Behavior preserved?", options: [{label: "Yes"}, {label: "No"}]}])
│   ├─ child reads files, edits code
│   ├─ report("Refactored 3 files")          ← progress, streamed to parent
│   └─ submit_answers([{id: "question-1", value: "auth.ts, session.ts, index.ts"},
│                      {id: "question-2", value: "yes"}])   ← fulfilled; agent removed
│
└─ spawn_agent("tests", "You write tests.", "Write tests for auth",
               contract=[{prompt: "How many tests pass?"}])
    ├─ child reads code, writes test files
    └─ submit_answers([{id: "question-1", value: "12"}])   ← fulfilled; agent removed

// Both run concurrently. Parent gets both contracts' answers as data.

Parent: "Now update the migration docs for that refactor"
└─ spawn_agent("docs", "You write docs.",
               "The auth refactor changed auth.ts, session.ts, index.ts; behavior preserved. Update the migration docs.",
               contract=[{prompt: "Docs updated where?"}])
    └─ fresh executor; the prior answers travel in the task, not in agent state

Parent: "Is anything still running?"
└─ list_agents()
    └─ • docs — running, depth 1, root child, anthropic/claude-haiku-4-5, 0 reports, contract pending

Parent: "Abort it"
└─ kill_agent("docs")
    └─ running child aborted, subtree freed
```

## Caveats / Known Limitations

- **One model for the whole subtree** — `model` in `pi-agents.json` applies to every child and descendant; there is no per-`spawn_agent` override. Unset means all children use the parent session's active model.
- **Children run in-process** — they are not isolated processes; a crash or infinite loop in a child can affect the parent session.
- **Recursive spawning is config-bounded** — descendants may spawn more descendants only while doing so stays within configured `maxDepth` and `maxLiveAgents`.
- **Subtree-scoped control** — descendant agents can only manage agents in their own subtree; they cannot spawn into or kill arbitrary siblings' branches.
- **No file-system confinement** — child `read`/`write`/`edit`/`bash` are pi's built-in tools running with the user's OS-level file and network access. The working directory is where relative paths resolve, nothing more.
- **Minimal allowlisted env for `bash`** — child shell commands receive a small allowlisted environment: `PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, locale/timezone variables, `TERM`/`COLORTERM`, `TMPDIR`, `XDG_RUNTIME_DIR`, and TLS/CA certificate variables (`SSL_CERT_FILE`, `SSL_CERT_DIR`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`). This filters which *environment variables* children inherit — it does not protect secrets stored in files, since a child can read them via `bash`. Pass genuinely needed extra variables inline per command.
- **Child text is sanitized for the terminal** — reports and activity previews have ANSI/OSC escape sequences stripped before rendering, so a child cannot inject terminal control sequences into the TUI.
- **Contract nudges cost tokens** — a child that ends its run without `submit_answers` is re-prompted up to 10 times before the call errors. A wedged or refusing child burns those turns; `timeout_seconds` bounds the wall clock.

## License

MIT
