# pi-agents

Minimal async, recursive, session-local sub-agents for pi.

This extension exposes **one tool**: `agent_task`. It starts one-shot sub-agent tasks in the background, lets agents check/wait/cancel/list them, and gives every sub-agent the same tool so recursion works naturally without a large orchestration API.

## Model

- **Async first**: `agent_task({ action: "start", ... })` returns immediately.
- **One-shot tasks**: no persistent workers and no `delegate` state machine.
- **Recursive by construction**: each task can start descendant tasks with `agent_task`.
- **Session-local**: tasks live in memory and are cancelled on session shutdown/reload.
- **Scoped**: root sees all tasks; a sub-agent sees only its descendants.
- **Bounded**: defaults are `maxDepth=3`, `maxLiveTasks=16`, task runtime timeout `10m`.
- **Standard tools**: sub-agents use pi's standard `read`, `write`, `edit`, `bash`, `ls`, `grep`, and `find` tool factories, plus `report` and `agent_task`.

No tmux, no git worktrees, no durable registry, no attach/detach. Use side-agent/worktree systems for long-running isolated implementation work.

## Tool

### `agent_task`

```ts
{
  action: "start" | "check" | "wait" | "cancel" | "list",
  id?: string,
  task?: string,
  system_prompt?: string,
  timeout_seconds?: number
}
```

### `start`

Starts a background sub-agent task and returns immediately.

```json
{
  "action": "start",
  "id": "api-review",
  "system_prompt": "You are a concise API reviewer.",
  "task": "Review the proposed agent_task API and identify risks."
}
```

Returns:

```json
{
  "ok": true,
  "task": {
    "id": "api-review",
    "status": "running",
    "depth": 1,
    "startedAt": 1760000000000,
    "reports": [],
    "activity": []
  }
}
```

`timeout_seconds` on `start` is the task runtime limit. If omitted, the default is 10 minutes.

### `check`

Non-blocking status/result check.

```json
{ "action": "check", "id": "api-review" }
```

### `wait`

Waits for a task to finish.

```json
{ "action": "wait", "id": "api-review", "timeout_seconds": 30 }
```

- If the task finishes, returns its final result.
- If the wait times out, returns the current running status.
- `timeout_seconds: 0` behaves like a non-blocking check.
- `timeout_seconds` on `wait` does **not** cancel the underlying task.

### `cancel`

Cancels a task and its descendants.

```json
{ "action": "cancel", "id": "api-review" }
```

### `list`

Lists visible tasks.

```json
{ "action": "list" }
```

Root sees all tasks. A sub-agent sees only descendant tasks it started.

## Recommended usage

Fan out explicitly from the parent/root agent:

```text
agent_task start api-review
agent_task start impl-review
agent_task start product-review
...continue other work...
agent_task wait api-review
agent_task wait impl-review
agent_task wait product-review
synthesize
```

Sub-agents can also recurse when it is useful:

```text
root task
└─ implementation reviewer
   ├─ types reviewer
   └─ concurrency reviewer
```

This avoids the old persistent-agent/delegate tree and makes recursion a simple task primitive.

## Caveats

- Tasks are **not durable**. Shutdown/reload cancels them.
- Tasks are **not isolated**. They share the current workspace.
- Parallel file edits can conflict. Prefer async tasks for research/review/checks, or use worktrees for independent implementation.
- Children share the parent's model.
- `bash` has the same OS-level access as normal pi bash.

## License

MIT
