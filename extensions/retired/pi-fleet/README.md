# pi-fleet

Multi-agent fleet orchestration. Supersedes `pi-agent`: keeps its manager
recursion (spawn a pi child with a contract, registry, kill-subtree) and adds a
**reasonix worker layer** with durable, resumable fleet state.

```
supervisor (pi session)           rx_fleet / rx_* tools + agent* tools
  └── fleet-manager (pi child)    one per project, spawned via the agent tool
        └── worker (reasonix)     one per slice, `reasonix subagent run`
```

## Tools

Manager layer (absorbed from pi-agent):

- `agent` — spawn a child agent with a contract
- `agent_answer` — answer a suspended child's questions
- `agent_kill` / `agent_list` / `agent_output` — supervise children
- `agent_loop` — declarative goal-loop interpreter

Worker layer (new):

- `rx_run` — run ONE reasonix subagent worker (`reasonix subagent run <profile> <task>`)
- `rx_fleet` — run a manifest-driven fleet loop (slices, deps, worktrees, backoff, READY_FOR_REVIEW detection)
- `rx_list` / `rx_kill` / `rx_output` — supervise the worker table

## Roles

A worker's role is a **reasonix subagent profile** (name, prompt, model, effort,
allowed tools) — declared and stored by reasonix itself:

```bash
reasonix subagent create worker --description "..." --prompt "..." --model provider/id
reasonix subagent list
```

## Fleet manifest

```json
{
  "project": "ekko",
  "repo": "/home/y0usaf/dev/ekko",
  "base": "main",
  "stateDir": "/home/y0usaf/.pi/fleets/ekko",
  "slices": [
    {"id": "proto", "profile": "worker", "task": "do X", "deps": "_",
     "worktree": "/tmp/fleet-ekko-proto"}
  ]
}
```

- `deps` = whitespace slice ids or `_`; a slice waits on `READY_FOR_REVIEW`/`DONE` markers.
- Slices own **disjoint** source paths — worktree isolation is what makes fan-out safe.
- `rx_fleet` does NOT merge: a git slice is READY when its branch has closure
  commits ahead of base; the manager reviews and merges via git.

## State

Durable, resumable, under `stateDir`:

- `fleet.log` — loop timeline
- `<slice>/RUNNING | READY_FOR_REVIEW | DONE` — markers
- `<slice>/run.log` — worker stdout

## Config

`~/.pi/agent/pi-fleet.json` (or `.pi/pi-fleet.json`):

```json
{
  "maxDepth": 1,
  "maxLiveAgents": 6,
  "model": "anthropic/claude-haiku-4-5",
  "reasonix": "reasonix",
  "fleetStateDir": ".pi/fleets"
}
```
