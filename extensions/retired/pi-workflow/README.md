# pi-workflow

`/workflow` — pick an installed agent_loop workflow and run it.

## Install

Workflows are plain `agent_loop` workflow JSON files:

```bash
mkdir -p ~/.pi/workflows
cp my-workflow.json ~/.pi/workflows/
```

## Usage

- `/workflow` — menu of installed workflows
- `/workflow NAME` — run a workflow by name without the menu
- `/workflow NAME GOAL...` — run a workflow by name with the goal provided inline

A workflow whose `goal` is missing or is a `PLACEHOLDER: ...` stub prompts for
the goal (TUI mode), or errors with a usage hint (non-TUI). The goal can also
be supplied inline as arguments after the workflow name.

Selecting a workflow injects a user message telling the current agent to
run it with its own `agent_loop` tool (an extension cannot call the
main-session `agent_loop` directly; `pi.sendUserMessage()` is the bridge).

## Example workflow

```json
{
  "goal": "Refactor src/auth.ts to reduce its function count below 5 without changing behavior",
  "doer": {
    "system_prompt": "You are a cheap experimenter. Produce one concrete improvement.",
    "contract": [{ "prompt": "Describe your change and why it helps" }]
  },
  "check": {
    "use": "agent",
    "system_prompt": "Judge strictly. Does the change meet the goal?",
    "contract": [
      { "prompt": "Verdict?", "options": [{ "label": "Pass" }, { "label": "Fail" }] },
      { "prompt": "What flaws remain?" }
    ],
    "passValue": "pass"
  },
  "strategy": { "population": 1, "survivors": 1 },
  "converge": { "quorum": 1 },
  "budget": { "maxGenerations": 2, "maxSpawns": 6 }
}
```

## Notes

- `~/.pi/workflows/` is user-managed; workflows are not bundled with the extension.
- The picker needs TUI mode. Non-TUI: use `/workflow NAME`.