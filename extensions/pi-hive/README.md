# pi-hive

Multi-agent extension for pi. The model-facing API is intentionally small: launch workers with `agent`, continue them with `send_message`, inspect them with `list_agents`, and stop them with `kill_agent`.

Child agents are in-process `Agent` instances with their own conversation history. Recursive spawning is bounded by `pi-hive.json` via `maxDepth` and `maxLiveAgents`.

## Install

```bash
# Source/dev flow
nix develop
npm ci
npm run typecheck
pi -e ./index.ts

# Package/install flow
nix build
pi install ./result
```

## Configuration

Loaded from:

- Global: `~/.pi/agent/pi-hive.json`
- Project: `.pi/pi-hive.json`

Project overrides global.

```json
{
  "maxDepth": 1,
  "maxLiveAgents": 20
}
```

Depth starts at root session `0`:

- `maxDepth: 0` → no spawned agents
- `maxDepth: 1` → root can spawn children; children cannot spawn descendants
- `maxDepth: 2` → grandchildren allowed

## Agent types

Built-in:

- `general-purpose` — code research, analysis, and scoped implementation

Custom agent types are Markdown files:

- Project: `.pi/agents/<name>.md`
- Project: `.pi/agent/agents/<name>.md`
- Global: `~/.pi/agent/agents/<name>.md`

Example:

```md
---
name: code-reviewer
description: Review code changes for correctness, tests, and edge cases
tools: read, bash, report
---
You are a code review agent. Inspect the requested files/diff and report concise findings.
Focus on correctness, tests, regressions, and risky assumptions.
```

Supported frontmatter:

- `name` — optional; defaults to filename
- `description` — shown by `list_agent_types`
- `tools` — optional comma list or `[read, bash, report]`; `*`/omitted = all child tools

## Preferred tools

### `agent`

Launch a new worker.

```ts
{
  description: "Auth flow scout",
  prompt: "Find the files involved in login/session validation. Report paths and responsibilities under 200 words.",
  subagent_type: "general-purpose",
  name: "auth-scout",
  timeout_seconds: 120
}
```

Long-running background work:

```ts
{
  description: "Review current diff",
  prompt: "Review the current git diff for correctness and tests. Report blockers only.",
  subagent_type: "code-reviewer",
  name: "diff-review",
  run_in_background: true,
  run_id: "diff-review-1"
}
```

If `name` is omitted, pi-hive generates an id and includes `agent_id` in the result.

### `send_message`

Send follow-up work to an existing agent.

```ts
{
  to: "auth-scout",
  message: "Now check test coverage for those files."
}
```

Background follow-up:

```ts
{
  to: "diff-review",
  message: "Re-check after the latest edits.",
  run_in_background: true
}
```

### `list_agents` / `kill_agent`

```ts
{}
```

```ts
{ id: "auth-scout" }
```

### `list_agent_types`

Progressive discovery for custom agent types.

```ts
{}
```

## Background runs

Background `agent`, `send_message`, and `run_workflow` calls return a `run_id`.

```ts
{ run_id: "diff-review-1" }                    // run_status
{ run_id: "diff-review-1", wait: true }        // run_status, wait for result
{ run_id: "diff-review-1" }                    // cancel_run
{}                                             // list_runs
```

Run records are persisted to `.pi/agent/runs/` per workspace and capped to 100 records. At most 10 async runs may be running per workspace.

## Workflows

Workflows are separate from agent launching.

Discovery:

```ts
{}                                      // list_workflows
{ workflow_name: "review" }            // show_workflow
```

Run:

```ts
{ workflow_name: "review" }            // run_workflow
{ workflow_name: "review", run_in_background: true }
```

Recommended paths:

- Project: `.pi/agent/workflows/<name>.json`
- Global: `~/.pi/agent/workflows/<name>.json`

Slash command:

```bash
/workflow                 # list workflows
/workflow list            # list workflows
/workflow show review     # show one workflow
/workflow review          # ask the model to run workflow "review"
/workflow run review      # same
```

Workflow JSON still supports sequential agent steps, parallel barriers, and `while` loops with `{previous}`, `{all}`, `{step:<id>}`, and `{iteration}` substitutions.

## Legacy compatibility

The old action-multiplexed tool is still available as `hive` for compatibility:

```ts
{ action: "spawn", id: "scout", system_prompt: "...", task: "..." }
```

Prefer the split tools above for new usage.

## Limits and validation

- `timeout_seconds` and child `bash.timeout`: integer seconds, `1..86400`
- Child `read.offset`: integer line number `>= 1`
- Child `read.limit`: integer line count `1..10000`; omitted reads are capped to 10000 lines and 50000 rendered chars
- Child `read`/`edit`: regular files only, max 2 MiB input file
- Child `write`/`edit` output: max 2 MiB
- Child `report`: max 100 reports, 20000 chars/report, 100000 chars total per agent
- Child `bash`: default timeout 120s; timeout/abort sends SIGTERM, then SIGKILL; `bash` is best-effort and not a sandbox

## Caveats

- Children share the parent's model — no per-child model selection yet.
- Children run in-process — they are not isolated processes.
- `bash` is not filesystem-confined; child agents with `bash` have the same OS-level access as the user running pi.
- Async run state persists under `.pi/agent/runs/`; live in-memory agent state clears on session shutdown.

## License

MIT
