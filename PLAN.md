# PLAN

Active work queue for this repo. The `next` skill (`.pi/skills/next/`)
implements exactly one open item per run; `/loop-next` runs that skill in a
fresh sub-agent until this file has no unchecked boxes.

**Checkbox state lives only in this file.** `extensions/pi-loom/DESIGN.md`
owns the *why* and the per-phase acceptance criteria; its Roadmap section
must not carry unchecked-box markers, because two checklists drift within
one loop iteration. Read the matching DESIGN.md phase before starting an
item.

A checkbox marks a real open work item: a phase, or a phase split into
smaller items when one step cannot land it whole. Notes and already-landed
slices are plain dashes. The driver counts open items with a plain grep that
cannot tell a work item from one quoted in a sentence, so never write a box
marker into prose here — the count would lie.

## Handoff

Last touched: P4a landed and is ticked. P4 was split three ways first (P4a
library, P4b `exec` stage + `/build`, P4c `/quick`); the next open item is P4b.

What landed. A stage library: `stage(name, input)` is callable from any workflow
body with no import, because `runWorkflow` appends `src/stages.ts`'s source to
every body before instrumentation. Two stages ship, `plan` (task to numbered
plan items) and `review` (verdict plus note). A top-level `stage` or `__stage*`
declaration in an author's script is now rejected at launch by
`stageLibraryConflict` in `src/validation.ts`. The workflow slash-command handler
in `host.ts` now catches launch failures and notifies them as errors instead of
letting the rejection escape into Pi's command dispatcher.

Gates actually run: `nix build .#pi-loom-cli` (pass),
`nix build .#checks.x86_64-linux.pi-loom-stages -L` (pass, prints `stages: the
appended library reached the sandbox, an unknown stage named the available ones,
missing and out-of-range input were rejected before any agent launch, and a
colliding top-level declaration stopped the launch with a named error`),
`nix flake check -L` (pass, all 14 checks, biome unchanged at 1 pre-existing
warning + 5 infos).

Design decisions worth not re-litigating:

- **The library is appended, never prepended.** `instrumentWorkflow` turns each
  `agent(...)` call's start/end byte offsets into that agent's call-site
  identity, and retry/resume match on it. Prepending would renumber every user
  call site whenever the library changed. Verified: the same script instrumented
  with and without the library yields the identical call site.
- **Function declarations only, inside the library.** They hoist, so `stage(...)`
  works from line 1 even though the definitions sit after the author's `return`.
  A `const` or `var` there is in its temporal dead zone (or `undefined`) for the
  whole run. This is why the stage prompts are built inside each function rather
  than in a shared top-level constant.
- **The library is not preflighted against the caller's capabilities.** It is
  engine code, reviewed here. That is exactly why no stage hardcodes a model or
  role: those come from the caller, whose script *is* preflighted.
- **`stage("review")` returns `human.review`'s shape** (`{verdict, note}`, same
  approve/changes/reject vocabulary), so a workflow can switch on `.verdict`
  without knowing whether a model or a person judged the work.
- **Doctrine 01 is now `partial`, recorded in DESIGN.md.** Stage *content* is
  policy living in the engine because the registry only accepts host-side
  functions over RPC, with no surface for extension-supplied sandbox source. It
  closes when `pi-loom-builtins` exists.

Traps for the next step:

- **`extensions/pi-loom/skills/pi-extensible-workflows/SKILL.md` is still
  modified in the working tree and still deliberately uncommitted.** Same state
  as the previous three handoffs: `HEAD` content is byte-identical to the
  vendored upstream copy, the working-tree content is a rewrite by something
  outside these steps. Left untouched again; commits here stage explicit paths,
  never `-A`. Decide what it is before committing it. It also means the
  agent-facing docs for `stage(...)` were *not* written — that file is where
  they belong.
- **Stages are invisible to the model right now.** `workflow_catalog` lists
  registered functions, not stages, and nothing tells an agent that `stage(...)`
  exists. P4b should either extend the catalog or document it in the skill file
  above, once that file's ownership is settled.
- **The flake only sees git-tracked files.** A new source or check script that
  is not `git add`ed does not exist inside `nix build`. Stage before building.
- **`result` is a relative symlink.** The check harnesses `cd` into a temp
  project, so running one by hand needs `"$(readlink -f result)/bin/loom"`, not
  `./result/bin/loom`.
- **`PI_CODING_AGENT_DIR` leaks into hand-run harnesses.** Inside the nix
  sandbox the agent dir defaults to `$HOME/.pi/agent`, but running a check
  script from a Pi session inherits `PI_CODING_AGENT_DIR` and the user-scope
  scan finds the real agent dir instead of the throwaway one.
  `loom-workflow-args.sh`, `loom-project-workflows.sh` and `loom-stages.sh`
  export it explicitly; the three older harnesses do not.
- **Offline harnesses must never reach `agent()`.** There is no network and no
  real key in the sandbox, so `loom-stages.sh` only exercises the paths that
  fail *before* an agent launches. Any P4b check of `exec` needs the same
  discipline: assert the wiring, not a model's output.
- **Never `head -1` a presented message.** Usage text and the `/workflows`
  listing are multi-line, so harnesses serialise with `jq -c` before decoding.
- **`inputsSettled()` gates on four parking lots** (checkpoints, questions,
  edits, reviews). Anything that parks a new kind of human input must add its
  lot there or a pending item will look like a running run.
- **Downstream flag renamed.** `~/nixos/hosts/y0usaf-desktop/finix/materialized-packages.nix`
  sets `"extensible-workflows" = true;`. That key no longer exists; it is now
  `loom`. `lib.enabledExtensions` asserts on unknown flags, so the system flake
  fails to evaluate the moment it bumps this input. Flip the flag in the same
  change that bumps the input (the `ship` skill does both).
- **Fork identity is still upstream-named on purpose.** package.json is still
  `pi-extensible-workflows@3.4.2`, and the scan-root constants still resolve
  `<agentDir>/pi-extensible-workflows/{SYSTEM.md,roles}`. Renaming moves paths
  inside the user's agent dir, so it must land with the system flake, not
  before. Rationale is in DESIGN.md under Architecture.
- The ref tree is no longer a package and is excluded from `biome.jsonc`;
  keep it that way, it is only a diff base for upstream fixes.
- **Two facts all six harnesses depend on.** Pi's agent dir defaults to
  `$HOME/.pi/agent`, not the XDG data path the installed system uses; and an
  RPC `prompt` is refused before command dispatch unless a model resolves
  with a key, which is why the scripts pass throwaway
  `--provider/--model/--api-key` flags. Reuse them for P8 rather than
  rediscovering both.

## Current phase

- [x] **P0 — fork + ref reset.** Engine forked to `extensions/pi-loom/`, ref
      tree reset to the `a94500e` vendor import, `packages.pi-loom` builds.
- [x] **P1 — alias package.** `packages.pi-loom-cli` builds the `loom`
      wrapper; `checks.pi-loom-cli-smoke` boots it and proves `/workflow`
      registers, only the wrapper's own extensions load, and a workflow
      child process spawns.
- [x] **P2a — `human.ask`.** Frozen `human` object in the workflow sandbox,
      `humanBridge` + `journal.awaitingHuman` in the host, `workflow_answer`
      tool as the agent-facing fallback, `checks.pi-loom-human-ask` proving the
      round trip.
- [x] **P2b — `human.edit`.** `ctx.ui.editor` round trip on a text artifact,
      `humanEditBridge` + `journal.awaitingEdit` in the host, `workflow_edit`
      tool as the agent-facing fallback, `checks.pi-loom-human-edit` proving a
      saved edit, an unchanged buffer, and an abandoned editor stay distinct.
- [x] **P2c — `human.review`.** Fixed `approve`/`changes`/`reject` verdict plus
      a free-text note, `humanReviewBridge` + `journal.awaitingReview` in the
      host, `workflow_review` tool as the agent-facing fallback,
      `checks.pi-loom-human-review` proving the note crosses into the next
      stage.
- [x] **P3a — schema-declared args.** `argsSchema` in `command.json`,
      `src/workflow-commands.ts` generating usage and validating every
      invocation, both shipped workflows declaring schemas,
      `checks.pi-loom-workflow-args` proving rejection-with-usage, defaults and
      text-scalar coercion.
- [x] **P3b — project scope.** `<cwd>/.pi/workflows/` as a third scan root,
      scoped discovery in `src/workflow-commands.ts`, a `/workflows` listing
      naming every scope and root, `checks.pi-loom-project-workflows` proving a
      project spec runs, cannot shadow user scope, and cannot abort load.
- [x] **P4a — stage library.** `stage(name, input)` appended to every workflow
      body as hoisted function declarations (`src/stages.ts`), the `plan` and
      `review` stages, a launch-time guard on colliding top-level declarations,
      and `checks.pi-loom-stages` proving all three offline.
- [ ] **P4b — `exec` stage + `/build`.**
- [ ] **P4c — `/quick`.**
- [ ] **P5 — router + picker.**
- [ ] **P6 — `/wf-new` meta-workflow.**
- [ ] **P7 — ecosystem fill.** `/explore`, `/debug`, `/review`; migrate the
      `ship` and `next` skills to workflows.
- [ ] **P8 — bare-core CI.** `checks.pi-loom-bare`.

Acceptance criteria for every phase above: see the Roadmap section of
`extensions/pi-loom/DESIGN.md`.
