# pi-recurse

A Pi extension: spawn a full Pi child agent session with the `recurse` tool.

## What it does

`recurse` spawns `pi --print` as a subprocess. The child is a full Pi session
— all built-in tools (read, write, edit, bash, grep, find, ls), all
user-configured extensions, its own model, its own system prompt, its own
context. It fulfills the task, outputs the answer, and exits.

That's it. That's the recursion primitive.

## Why

Replaces `pi-rlm` (JS eval evaluator), `pi-agents` (orchestration),
`pi-rust-kernel` (Rust evcxr eval) — all three, with one tool.

- Process as the primitive. A child is a subprocess. No evaluator to manage,
  no guest protocol, no RPC pipe to fix. POSIX handles lifecycle.
- Task as the contract. The prompt is just a prompt. The child gets all Pi
  tools. It answers.
- Timeout kills the process. Built-in, no double-pipe.

When the child also has this extension, it can recurse further — unbounded
depth, one process per level. Like `fork`.

## Parameters

- `task` (string, required) — the prompt for the child agent.
- `model` (string, optional) — model override for the child, e.g. `anthropic/claude-haiku-4.5`.
- `cwd` (string, optional) — working directory for the child.
- `timeout` (number, optional) — timeout in ms. Default 600000 (10 min).
