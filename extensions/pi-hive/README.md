# pi-hive

Multi-agent orchestration extension for pi. It exposes one orchestration tool, `agent`, with action-based operations for spawning child agents, delegation, chains, parallel fan-out/fan-in, async runs, and status.

Children are in-process `Agent` instances that persist across interactions with their full conversation history. Recursive spawning is bounded by `pi-hive.json` via `maxDepth` and `maxLiveAgents`.

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

Extension config is loaded from:

- Global: `~/.pi/agent/pi-hive.json`
- Project: `.pi/pi-hive.json`

Project settings override global settings.

Example:

```json
{
  "maxDepth": 1,
  "maxLiveAgents": 20
}
```

Depth is counted from the root session at depth `0`:

- `maxDepth: 0` → no spawned agents
- `maxDepth: 1` → root can spawn children, children cannot spawn descendants
- `maxDepth: 2` → grandchildren allowed

`maxLiveAgents` caps the total number of live agents kept in the in-memory registry at once.

## Tool: `agent`

Use `agent` with an `action` field.

Actions:

| Action | Purpose |
|---|---|
| `spawn` | Create a child agent with its own system prompt + task. |
| `delegate` | Send follow-up work to an existing child. |
| `kill` | Kill a child agent/subtree. |
| `list` | List active child agents. |
| `chain` | Run agent steps sequentially. |
| `parallel` | Spawn multiple child agents concurrently and fan in results. |
| `workflow` | Run a deterministic workflow object, file path, or named saved workflow. |
| `list_workflows` | Progressive discovery: list available workflow names/descriptions. |
| `show_workflow` | Progressive discovery: show one workflow definition. |
| `list_runs` | List async runs. Root only. |
| `result` | Return current status/result for an async run. Root only. |
| `wait` | Wait for an async run to complete. Root only. |
| `cancel` | Cancel an async run and kill associated child agents. Root only. |


Root `spawn`, `delegate`, `chain`, `parallel`, and `workflow` support `async: true`; children can use the same actions synchronously for descendant-scoped orchestration.

State is scoped by workspace (`ctx.cwd`): child ids and async run ids are visible only within the workspace that created them. State is in-memory and cleared on session shutdown.

### Spawn

```ts
{
  action: "spawn",
  id: "scout",
  system_prompt: "You scout code and report concise findings.",
  task: "Find relevant files for the auth flow",
  timeout_seconds: 120
}
```

Async:

```ts
{
  action: "spawn",
  id: "reviewer",
  system_prompt: "You review code for correctness.",
  task: "Review the current diff",
  async: true,
  run_id: "review-1"
}
```

### Delegate

```ts
{
  action: "delegate",
  id: "scout",
  message: "Now inspect the test coverage for those files"
}
```

### Chain

Existing child ids are delegated to; new child ids are spawned and **must** include a non-empty `system_prompt`. Step tasks support `{previous}` (last step output) and `{all}` (all previous step outputs). Root chain calls support `async: true`; descendant chain calls are synchronous.
```ts
{
  action: "chain",
  steps: [
    { id: "scout", system_prompt: "You scout code.", task: "Find relevant files" },
    { id: "planner", system_prompt: "You plan changes.", task: "Plan from:\n{previous}" }
  ]
}
```

### Parallel

```ts
{
  action: "parallel",
  tasks: [
    { id: "correctness", system_prompt: "You review correctness.", task: "Review the diff" },
    { id: "tests", system_prompt: "You review tests.", task: "Review the diff" }
  ]
}
```



### Workflows

Workflows are plain JSON: no CUE/compiler layer. Steps run deterministically in order. A step can be a single agent step, a parallel barrier, or a `while` loop. `while` loops may be nested and run until their `until` condition is met or the run is cancelled. Tasks support `{previous}`, `{all}`, `{step:<id>}`, and loop-local `{iteration}` substitutions.

Progressive disclosure: workflow contents are **not** injected at session start. The model can discover them on demand via `agent({ action: "list_workflows" })`, inspect one via `agent({ action: "show_workflow", workflow_name: "..." })`, then run it via `agent({ action: "workflow", workflow_name: "..." })`.

Recommended paths:

- Project workflows: `.pi/agent/workflows/<name>.json`
- Global workflows: `~/.pi/agent/workflows/<name>.json`

Slash command for humans:

```bash
/workflow                 # list workflows
/workflow list            # list workflows
/workflow show review     # show one workflow
/workflow review          # ask the model to run workflow "review"
/workflow run review      # same
```

Use a named workflow:
```ts
{ action: "workflow", workflow_name: "review" }
```

Lookup order for `workflow_name: "review"`:

1. `.pi/agent/workflows/review.json`
2. `~/.pi/agent/workflows/review.json`

Explicit path still works:
```ts
{ action: "workflow", workflow_path: ".pi/agent/workflows/review.json" }
```

Inline still works:
```ts
{
  action: "workflow",
  workflow: {
    name: "review",
    steps: [
      { id: "scan", system_prompt: "You scan code.", task: "Find risky files" },
      {
        type: "parallel",
        id: "reviewers",
        tasks: [
          { id: "correctness", system_prompt: "You review correctness.", task: "Review these files:\n{previous}" },
          { id: "tests", system_prompt: "You review tests.", task: "Review test coverage for:\n{previous}" }
        ]
      },
      { id: "summary", system_prompt: "You summarize reviews.", task: "Summarize:\n{step:reviewers}" }
    ]
  }
}
```

Loop example:

```json
{
  "type": "while",
  "id": "quality-loop",
  "until": {
    "step": "review",
    "last_line_equals": "STATUS: APPROVED"
  },
  "steps": [
    {
      "id": "implement",
      "system_prompt": "You implement requested changes.",
      "task": "Implement or revise. Iteration {iteration}. Context:\n{all}"
    },
    {
      "id": "review",
      "system_prompt": "You review implementation quality.",
      "task": "Review the implementation. End with exactly one final line: STATUS: APPROVED or STATUS: CHANGES_REQUESTED"
    }
  ]
}
```

Nested loops are supported. Loops are uncapped; cancel the workflow run to stop a loop whose `until` condition is not reached.


### Run management

```ts
{ action: "list_runs" }
{ action: "result", run_id: "review-1" }
```

Runs are persisted to `.pi/agent/runs/` per workspace and capped to 100 records. At most 10 async runs may be running per workspace. To stop async work, kill the relevant child agent with `kill`. `details.run`/`details.runs` expose serializable DTOs, not internal promises/controllers.

### Agent management

```ts
{ action: "list" }
{ action: "kill", id: "scout" }
```


## Limits and validation

- `timeout_seconds` and child `bash.timeout`: integer seconds, `1..86400`.
- Child `read.offset`: integer line number `>= 1`.
- Child `read.limit`: integer line count `1..10000`; omitted reads are capped to 10000 lines and 50000 rendered chars.
- Child `read`/`edit`: regular files only, max 2 MiB input file.
- Child `write`/`edit` output: max 2 MiB.
- Child `report`: max 100 reports, 20000 chars/report, 100000 chars total per agent.
- Child `bash`: default timeout 120s; on timeout/abort pi-hive sends SIGTERM, then SIGKILL, then force-returns partial output if pipes never close. `bash` is best-effort and not a sandbox.

## Caveats / Known Limitations

- Children share the parent's model — there is no per-child model selection yet.
- Children run in-process — they are not isolated processes.
- `bash` is not file-system confined; child agents with `bash` have the same OS-level access as the user running pi.
- Async run state is persisted under `.pi/agent/runs/`; live in-memory state still clears on session shutdown.

## License

MIT

