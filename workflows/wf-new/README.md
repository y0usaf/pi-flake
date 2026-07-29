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

## What happens after the files are written

Two phases, in this order and only in this order.

`verify` calls `dryRun({ directory })`, the engine capability that loads a
workflow directory through the code that registers slash commands — discovery,
spec validation, usage generation, argument parsing — and stops at the last gate
before a run would exist. If the freshly scaffolded directory would not
register, **the run fails with the reason and commits nothing**. The files stay
on disk exactly as they were written, because that is where their author fixes
them.

`commit` writes the directory into git, and only the directory:

```
git rev-parse --show-toplevel      # not a repository? report it, do not fail
git add -- <directory>             # a pathspec commit cannot name untracked files
git status --porcelain -- <dir>    # nothing staged? report it, do not fail
git commit -q -m "wf-new: add /<name> workflow" -- <directory>
```

`git commit -- <pathspec>` is a **partial commit**: it takes those paths from the
working tree and ignores the rest of the index, so unrelated work you had staged
when you launched `/wf-new` is still staged, and still uncommitted, afterwards.
Nothing the scaffolding agent produced reaches the shell — the pathspec and the
name are both validated against a regex first, which is why nothing is quoted.

Being unable to commit (not a repository, the path is git-ignored, no git
identity configured) is **reported in the artifact, not thrown**. The deliverable
is a directory that is already on disk and already known to register; failing the
run over a missing `user.email` would say the opposite of the truth.

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

The scaffold stage's artifact — `name`, `directory`, `script`, `files`, the
parsed `command` manifest, plus the agent's `summary` and `notes` — with three
records added:

| field | meaning |
| --- | --- |
| `registration` | what the dry run saw: `name`, `signature`, `usage`, `requiredArgs` — the usage a user would be shown |
| `commit` | `committed` (boolean), `sha`, and `reason` when nothing was committed |
| `interview` | which answers produced this scaffold |

The engine reads `command.json` back off disk before the stage returns: a
scaffold whose manifest does not parse, disagrees about the name, or names a
script that was never written fails the run instead of being reported as a
success.

Gated by `checks.pi-loom-wf-new-workflow` (registration, usage rejection, the
parked interview, answers reaching the stage) and
`checks.pi-loom-wf-new-commit` (verify-then-commit ordering, the commit
containing exactly the scaffold, and a failed dry run committing nothing).
