# pi-kimi

Kimi Code-style agent features for [pi](https://github.com/earendil-works/pi), as a pi package.
No visuals, no web server — the agent-loop capabilities: subagents, plan mode, permissions,
lifecycle hooks, and todos.

## What's included

### Subagents (`subagent`, `task_list`, `task_output`, `task_stop` tools)

Delegate work to subagents running as separate pi processes with isolated context windows.

- **Built-in agents** mirroring Kimi Code's trio:
  - `coder` — full toolset, edits code, verifies, reports back
  - `explore` — read-only recon (read, grep, find, ls, bash)
  - `plan` — read-only implementation planning
- User (`~/.pi/agent/agents/*.md`) and project (`.pi/agents/*.md`) agent definitions are
  discovered too and override built-ins by name (frontmatter: `name`, `description`,
  optional `tools`, `model`).
- **Modes**: single `{agent, task}`, parallel `{tasks: [...]}` (max 8, concurrency 4),
  chain `{chain: [...]}` with `{previous}` placeholder.
- **Background**: `runInBackground: true` returns a task id immediately; poll with
  `task_output` (`block: true` to wait), kill with `task_stop`, list with `task_list`.
- **Resume**: every run reports its task id; pass `resume: "<id>"` with a follow-up
  `task` to continue that subagent's session.

State lives under `~/.pi/agent/pi-kimi/` (task status files, event logs, session dirs).

### Plan mode (`/plan` command, `Ctrl+Alt+P`, `--plan` flag)

Kimi Code-style read-only planning, implemented as a guard rather than a tool swap:

- All tools stay available. `write`/`edit` are blocked for everything **except the
  current plan file** (`~/.pi/agent/pi-kimi/plans/plan-<timestamp>.md`, path shown when
  plan mode activates); `task_stop` is blocked until you leave plan mode.
- Bash is not allowlisted — it follows the normal pi-kimi permission rules, same as Kimi.
- The agent explores, then writes a numbered `Plan:` list into the plan file. On turn end
  you choose to execute it (progress tracked via `[DONE:n]` markers), stay in plan mode,
  or refine it. State (including the plan file path) persists across session resume.

### Permissions (allow/ask/deny rules)

Rules from `<project>/.pi/pi-kimi/permissions.json`, then
`~/.pi/agent/pi-kimi/permissions.json`, then built-in defaults. First match wins.

```json
{
  "rules": [
    { "action": "allow", "tool": "bash", "pattern": "^git status\\b" },
    { "action": "deny", "tool": "write", "pattern": "**/.env.production" },
    { "action": "ask", "tool": "bash", "pattern": "\\bnpm publish\\b" }
  ]
}
```

- `bash`: `pattern` is a regex against the command.
- `read`/`write`/`edit`: `pattern` is a glob (`**`, `*`, `?`) against the resolved path.
- `tool: "*"` matches every tool.
- Defaults: ask on `rm -rf`, `sudo`, force-push, `git reset --hard`, pipe-to-shell, and
  writes to credential files (`.env`, `.ssh`, `*.pem`); deny reads of `.ssh/id_*`;
  allow writes inside the working directory; ask for writes outside it.
- "ask" prompts interactively; in non-interactive mode it blocks.

### Hooks (shell commands at lifecycle events)

`<project>/.pi/pi-kimi/hooks.json` and `~/.pi/agent/pi-kimi/hooks.json`:

```json
{
  "hooks": [
    { "event": "tool_call", "command": "./scripts/gate.sh", "timeoutMs": 10000 },
    { "event": "agent_end", "command": "notify-send 'pi turn done'" }
  ]
}
```

Events: `session_start`, `before_agent_start`, `turn_end`, `agent_end`, `tool_call`.
The event payload arrives as JSON on stdin; `PI_KIMI_EVENT` holds the event name.
For `tool_call`, a non-zero exit blocks the call with the hook output as the reason.

### Todos (`todo` tool, `/todos` command)

LLM-managed todo list (`list`/`add`/`toggle`/`clear`). State is reconstructed from
session tool results, so session branching restores the correct list automatically.

### Slash commands

Kimi Code-style commands (pi's own built-ins like `/model`, `/compact`, `/fork` already
cover the rest of Kimi's surface):

- `/goal <objective>` — autonomous goal mode: the agent works across auto-continuing
  turns and ends the goal with the `goal_update` tool (`complete`/`blocked`/`paused`).
  Subcommands: `status`, `pause`, `resume`, `cancel`, `replace <obj>`, `next <obj>`
  (queue a follow-up goal), `-- <obj>` for objectives starting with a reserved word.
  Goal state persists across session resume; an active goal keeps going.
  Interactive-only: in `pi -p` the command runs but pi's print mode does not process
  extension-queued follow-up messages, so the auto-continuation loop can't drive
  (Kimi's own `/goal` subcommands are likewise TUI controls).
- `/yolo [on|off]` — auto-approve permission "ask" prompts. Plan-mode exit still asks.
- `/auto [on|off]` — auto-approve prompts AND skip the plan-mode exit approval.
- `/tasks` — list background subagent tasks (user-facing view of the task registry).
- `/init` — analyze the codebase and generate `AGENTS.md`.

Deliberately not ported: `/mcp`, `/plugins`, `/web` (server/marketplace surface),
`/btw` (needs programmatic session fork — pi's built-in `/fork` covers the manual
flow), `/swarm` (covered conceptually by parallel subagents), `/add-dir` (engine-level
workspace feature).

## Prompt fidelity

Prompts, reminders, and tool descriptions are verbatim from
[MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) @ `main`:

| pi-kimi text | Kimi Code source |
| --- | --- |
| coder/explore/plan subagent prompts + descriptions | `agent-core/src/profile/default/{coder,explore,plan}.yaml` |
| `subagent` tool description | `agent-core-v2/src/session/subagent/tools/agent.md` + `agent-background-enabled.md` |
| `task_list` / `task_output` / `task_stop` descriptions | `agent-core-v2/src/agent/task/tools/task-{list,output,stop}.md` |
| `goal_update` description | `agent-core-v2/src/agent/goal/tools/update-goal.md` |
| goal turn prompt | `agent-core-v2/src/agent/goal/injection/goal-active-reminder.md` |
| goal paused/blocked injections | `agent-core-v2/src/agent/goal/injection/goal-{paused,blocked}-reminder.md` |
| plan mode reminder | `agent-core-v2/src/agent/plan/injection/plan-mode-full-reminder.md` |
| `/init` prompt | `agent-core/src/profile/default/init.md` |

Documented substitutions (the only deviations from verbatim):

- Tool names mapped to pi's: `Agent`→`subagent`, `Bash`→`bash`, `Read`→`read`,
  `Grep`→`grep`, `Glob`→`find`, `Write`/`Edit`→`write`/`edit`,
  `TaskOutput`/`TaskStop`/`TaskList`→`task_output`/`task_stop`/`task_list`,
  `UpdateGoal`→`goal_update`, `SetGoalBudget`→`set_goal_budget`.
- Dropped references to tools that don't exist in pi-kimi: `AskUserQuestion`,
  `ExitPlanMode`/`EnterPlanMode` (pi-kimi exits via the turn-end approval or `/plan`),
  `ReadMediaFile`, `CronCreate`/`CronDelete`.
- The `agent.md` "fixed 2-hour timeout" line was dropped — pi-kimi subagents have no
  timeout.
- `WebSearch`/`FetchURL` references reworded to "web search/fetch tools when available"
  (pi-kimi doesn't provide them; other extensions may).
- The plan subagent has no shell, matching Kimi's `plan.yaml` tool list.

## Known limitations

- Subagent model defaults to pi's configured default model; it does not inherit an
  in-session `/model` override (set `model:` in an agent's frontmatter to pin one).
- Background subagents are separate OS processes; if the parent pi exits, they keep
  running and their status reconciles on the next session start.
- `resume` uses pi's `--continue` against the task's private session dir, i.e. it
  resumes the latest session in that dir (which is exactly that subagent's run).
