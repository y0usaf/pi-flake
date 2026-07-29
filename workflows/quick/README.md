# quick workflow

Make one small change with a single agent — via
[pi-loom](../../extensions/pi-loom/DESIGN.md), the workflow engine at
`@extensions/pi-loom/` (forked from pi-extensible-workflows 3.4.2).

`/quick "<task>"` runs exactly one stage from the engine's **stage library**
(`extensions/pi-loom/src/stages.ts`), which the engine appends to this script at
launch, so `stage(...)` needs no import and this file contains no prompt of its
own:

1. **quick** — one agent makes the change directly in your working tree.

No plan stage. No review stage. **No worktree.** That is the whole point:
plan → exec → review on a typo is ceremony, and ceremony is what makes people
route around the engine entirely. Reach for [`/build`](../build/README.md) when
the change needs more than one agent's attention.

## Where the change lands

In your checkout, unstaged, exactly as if you had made it yourself. Nothing is
isolated on a branch and nothing is committed for you — the opposite of
`/build`, which works on an engine-owned worktree and never touches your tree.

Read it the way you read your own work: `git diff`, then keep or `git restore`.

## What the report contains

`summary` and `notes` come from the agent. Everything else comes from git:
`changed`, `files`, `diff`, `diffChars`, `diffTruncated`, so an edit the agent
forgot to mention still shows up.

The diff is taken between two snapshots of the whole working tree — tracked
edits *and* new untracked files — written to a throwaway index before and after
the agent. Your own index is never touched. Because both sides are captured the
same way, changes that were already in your tree when you launched cancel out
instead of being attributed to the agent.

`trees.base` and `trees.result` are the two git tree objects, so
`git diff <base> <result>` replays exactly what the agent did. They are
unreferenced objects: `git gc --prune` eventually removes them.

Report diffs are clipped at 20 000 characters (`diffChars` holds the true size).
Nothing is lost — the change is in your working tree, so `git diff` shows all of
it.

## Prerequisites

- Extension enabled in the system flake: `programs.pi.extensions.loom = true;`
- The project is a git repository. Unlike `/build` it does not need a commit:
  the snapshot is taken from the index, so `/quick` works in a fresh `git init`.
- System flake places this directory into
  `~/.local/share/pi/agent/workflows/quick/` (`modules/dev/pi/workflows.nix`);
  the engine scans that root for `command.json` and registers `/quick`. Files
  here are the source of truth.

## Invoke

```
/quick "fix the typo in the usage string of src/cli.ts"
/quick '{ "task": "add a --version flag", "context": "flags live in src/cli.ts" }'
/quick '{ "task": "drop the unused import", "model": "claude-haiku-4-5" }'
```

Workflow tool launch (adds a token/cost backstop the slash command cannot pass):

```json
{
  "name": "quick",
  "scriptPath": "/home/y0usaf/dev/pi-flake/workflows/quick/quick.js",
  "args": { "task": "drop the unused import" },
  "budget": { "agentLaunches": { "hard": 2 }, "tokens": { "hard": 300000 } }
}
```

Runs are backgrounded; completion arrives as a follow-up message. Control a live
run with `/workflow` (pause / resume / stop / status).

## Failure modes

- **`changed: false`** — the agent judged the task too large for one pass and
  said so in `notes`, or it did nothing. Rerun with `/build`.
- **Nothing verified it.** No reviewer follows the agent. `/quick` trades that
  check for speed; for anything you would not merge unread, use `/build`.
- **An ignored file was edited and the diff is empty.** Both snapshots are built
  with `git add -A`, which honours `.gitignore`. A change to an ignored file is
  invisible to the report even though it happened.
- **A concurrent edit lands in the diff.** The snapshot covers the whole working
  tree, so anything you or another process changes while the run is live is
  attributed to the agent. Do not edit the same tree during a run.
