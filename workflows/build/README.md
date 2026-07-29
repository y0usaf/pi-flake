# build workflow

Plan a change, implement it item by item, review every item — via
[pi-loom](../../extensions/pi-loom/DESIGN.md), the workflow engine at
`@extensions/pi-loom/` (forked from pi-extensible-workflows 3.4.2).

`/build "<task>"` runs three stages from the engine's **stage library**
(`extensions/pi-loom/src/stages.ts`), which the engine appends to this script at
launch, so `stage(...)` needs no import and this file contains no prompt of its
own:

1. **plan** — one agent turns the task into up to `maxItems` independently
   implementable items.
2. **exec** — per item, one agent writes code inside an isolated git worktree.
   All items share one worktree (named `build`), so item 2 sees item 1's code.
3. **review** — per item, one agent judges the result and returns
   `approve` / `changes` / `reject` plus a note.

A `changes` verdict triggers up to `maxFixes` repair passes (default 1): the
review note is handed to exec as context and the item is reviewed again. A
`reject` stops that item — another blind pass would entrench a wrong approach —
and the run continues with the next item.

## What the report contains

Nothing in the report is a model's claim about what it changed. `files` and
`diff` come from `git diff` against the commit the worktree sat on before the
implementing agent started, so an unreported edit still shows up.

Keyed per plan item: `id`, `title`, final `verdict` and `note`, exec `summary`
and `notes`, `files`, `diff`, `attempts`, and a `passes` array with one entry
per exec/review round. `verdicts` maps item id to verdict for a quick scan;
`counts` totals them.

Diffs in the report are clipped at 20 000 characters per item (`diffChars`
holds the true size, `diffTruncated` flags the clip). The exec stage clips its
own diff at 200 000 characters first. Full diffs stay reachable: every item is
committed on the engine-owned branch named in `worktree.branch`.

## Prerequisites

- Extension enabled in the system flake: `programs.pi.extensions.loom = true;`
- The project is a git repository with at least one commit — the worktree is a
  snapshot of `HEAD` plus the working tree.
- System flake places this directory into
  `~/.local/share/pi/agent/workflows/build/` (`modules/dev/pi/workflows.nix`);
  the engine scans that root for `command.json` and registers `/build`. Files
  here are the source of truth.

## Invoke

```
/build "add a --json flag to the status command"
/build '{ "task": "add a --json flag", "maxItems": 3, "maxFixes": 0 }'
/build '{ "task": "port the parser", "model": "claude-sonnet-4-5", "reviewModel": "gpt-5" }'
```

`model` covers plan and exec; `reviewModel` defaults to `model`, so set it
explicitly when the review should be a second opinion rather than the same
model grading its own work.

Workflow tool launch (adds a token/cost backstop the slash command cannot pass):

```json
{
  "name": "build",
  "scriptPath": "/home/y0usaf/dev/pi-flake/workflows/build/build.js",
  "args": { "task": "add a --json flag", "maxItems": 3 },
  "budget": { "agentLaunches": { "hard": 20 }, "tokens": { "hard": 5000000 } }
}
```

Runs are backgrounded; completion arrives as a follow-up message. Control a live
run with `/workflow` (pause / resume / stop / status).

## Failure modes

- **Nothing was implemented** — the plan stage returned zero items; the report
  says so and no worktree work happened.
- **All items `reject`** — usually a task the plan stage misread. Read
  `plan.summary`, restate the task, rerun.
- **`changes` after the repair passes** — `maxFixes` was exhausted. The note on
  the last pass says what is still wrong; rerun `/build` on that item alone or
  finish it by hand on the run branch.
- **Nothing lands in your working tree.** Every item is committed on the
  worktree's own branch (`worktree.branch`), never on yours. Merge, cherry-pick
  or diff it yourself.
