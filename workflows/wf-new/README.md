# /wf-new

Writes a new pi-loom workflow — `command.json`, its script and a `README.md` —
after interviewing you about the three things that cannot be inferred from a
task sentence.

```
/wf-new "audit flake inputs for staleness"
/wf-new '{"task": "audit flake inputs for staleness", "name": "audit-inputs"}'
```

## What it asks

Three questions, through `human.ask`. Every answer becomes one input of
`stage("scaffold", ...)`:

| question | answer becomes | effect |
| --- | --- | --- |
| `name` | the stage's `name` | the command the new workflow registers |
| `scope` | the stage's `directory` | which workflows root it is written into |
| `shape` | the stage's `context` | which stages its script is built from |

`human.ask` offers choices, never a text field, so the name candidates are
derived from the task's own words — `"audit flake inputs for staleness"` offers
`audit-flake`, `audit-flake-inputs`, `wf-audit`. Derivation is deterministic:
the same task always offers the same list. If none of them fit, cancel and pass
`name` in the launch arguments, which skips the naming question.

Scope choices are `.pi/workflows` (project scope, committed with the repository
it was written for) and `workflows` (this repo's shipped set, installed by the
flake). Shape choices are the four backbones the stage library supports: one
agent, plan → exec → review, plan only, or no stages at all.

## What it does not do

**Nothing is guessed.** A run launched with no answers parks in the `interview`
phase and stays there: the question sits in the run journal, the run state is
`awaiting_input`, and no directory has been created. Answer it — from the picker
or with `workflow_answer` — and the run resumes into the `scaffold` phase.

## Arguments

| argument | required | meaning |
| --- | --- | --- |
| `task` | yes | what the new workflow must do, in one sentence |
| `name` | no | kebab-case command name; skips the naming question |
| `context` | no | repository background handed to the scaffolding agent |
| `model` | no | model for the scaffolding agent; defaults to the session model |

## What it returns

The scaffold stage's artifact — `name`, `directory`, `script`, `files`,
the parsed `command` manifest, plus the agent's `summary` and `notes` — with an
`interview` record of the answers that produced it. The engine reads
`command.json` back off disk before returning: a scaffold whose manifest does
not parse, disagrees about the name, or names a script that was never written
fails the run instead of being reported as a success.

Gated by `checks.pi-loom-wf-new-workflow`.
