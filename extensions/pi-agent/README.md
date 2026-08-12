# pi-agent

Multi-agent orchestration monolith: spawn, orchestrate, panel, loop, and workflow commands for pi. Replaces pi-agents + pi-workflow with one extension.

## Tools

- `agent` — spawn a child agent with a contract
- `agent_answer` — answer a suspended child agent's questions
- `agent_kill` — kill a child agent
- `agent_list` — list active agents
- `agent_output` — peek at a background agent
- `agent_loop` — declarative goal-loop interpreter

## Commands

- `/orchestrate` — toggle orchestrator mode (strips write/edit/bash, delegates mutations via agents)
- `/workflow` — pick and run an installed agent_loop workflow

## Routes for exec

Agent tools register in the shared exec route registry, so they're dispatchable via `exec({ route: "agent", ... })`.

## Config

See `~/.pi/agent/pi-agents.json` (or `.pi/pi-agents.json`):

```json
{
  "maxDepth": 1,
  "maxLiveAgents": 6,
  "model": "anthropic/claude-haiku-4-5",
  "panelModels": ["anthropic/claude-haiku-4-5", "google/gemini-flash-2-0"],
  "orchestrator": false
}
```
