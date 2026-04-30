# pi-hive

Multi-agent orchestration extension for pi. It exposes one orchestration tool, `agent`, with action-based operations for spawning child agents, delegation, chains, parallel fan-out/fan-in, async runs, status, and cancellation.

Children are in-process `Agent` instances that persist across interactions with their full conversation history. Recursive spawning is bounded by `pi-hive.json` via `maxDepth` and `maxLiveAgents`.

## Install

```bash
# Run directly for this session only (-e loads an extension without installing it)
pi -e ./index.ts

# Or install the package path
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
  "maxLiveAgents": 6
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
| `list_runs` | List async runs. Root only. |
| `result` | Return current status/result for an async run. Root only. |
| `wait` | Wait for an async run to complete. Root only. |
| `cancel` | Cancel an async run and kill associated child agents. Root only. |

Root `spawn`, `delegate`, `chain`, and `parallel` support `async: true`; children can use the same actions synchronously for descendant-scoped orchestration.

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

Existing child ids are delegated to; new child ids are spawned. Step tasks support `{previous}` and `{all}`.

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

### Run management

```ts
{ action: "list_runs" }
{ action: "result", run_id: "review-1" }
{ action: "wait", run_id: "review-1", timeout_seconds: 30 }
{ action: "cancel", run_id: "review-1" }
```

`wait` timeouts do not cancel the run.

### Agent management

```ts
{ action: "list" }
{ action: "kill", id: "scout" }
```

## Caveats / Known Limitations

- Children share the parent's model — there is no per-child model selection yet.
- Children run in-process — they are not isolated processes.
- `bash` is not file-system confined; child agents with `bash` have the same OS-level access as the user running pi.
- Async run state is in-memory and cleared on session shutdown.

## License

MIT

