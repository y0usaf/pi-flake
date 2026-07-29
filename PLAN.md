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

Last touched: P3 was split into P3a (schema-declared args) and P3b (project
scope), and P3a landed and is ticked. The next open item is P3b.

What landed. `argsSchema` in `command.json`: a JSON Schema object that declares
a workflow command's arguments, validated per invocation before any run is
launched. New `extensions/pi-loom/src/workflow-commands.ts` owns the whole
input path — `validateWorkflowCommandSpec` (structural check of one spec file),
`workflowCommandSignature` / `workflowCommandUsage` (generated usage), and
`parseWorkflowCommandArgs` (text to launch args). `host.ts` now calls those
three instead of parsing inline; the registered command description is the
hand-written description plus the generated signature when a schema is present.
Both shipped workflows (`workflows/ideation`, `workflows/loop-next`) now declare
schemas and their descriptions no longer hand-write a usage tail.

Gates actually run: `nix build .#pi-loom-cli` (pass),
`nix build .#checks.x86_64-linux.pi-loom-workflow-args -L` (pass, prints
`workflow-args: generated usage reached the palette, three bad-arg shapes were
rejected without starting a run, defaults and coercion reached the child`),
`nix build .#checks.x86_64-linux.biome-lint -L` (pass, same 1 pre-existing
warning in the eval harness), `nix flake check -L` (pass, all checks).

Design decisions worth not re-litigating:

- **Schema-less specs are untouched.** `parseWorkflowCommandArgs` reproduces the
  pre-P3 branch exactly when `argsSchema` is absent, so declaring a schema is
  opt-in per workflow and no existing `command.json` needed migrating.
- **Defaults and coercion are hand-written, validation is not.** TypeBox's
  `Value.Default` and `Value.Convert` only act on TypeBox-constructed types (they
  key off an internal `Kind` symbol) and are silent no-ops on the plain JSON
  Schema a `command.json` carries — verified, not assumed. `Value.Check` and
  `Value.Errors` do read plain JSON Schema, so validation stays real JSON Schema
  semantics while defaults and string-to-number coercion are two small explicit
  passes over the schema's top-level properties.
- **Non-object JSON now goes under `argKey` when a schema exists.** `/loop-next 10`
  previously reached the script as the bare number `10`, so its `maxSteps` lookup
  missed and the cap silently stayed 30. With a schema the value is wrapped as
  `{ maxSteps: 10 }`.

Traps for the next step:

- **`extensions/pi-loom/skills/pi-extensible-workflows/SKILL.md` is modified in
  the working tree and deliberately not committed.** The tree was clean at the
  start of this step; that file was rewritten mid-step by something outside it
  (its `HEAD` content is byte-identical to the vendored upstream copy, the
  working-tree content is not). It was left alone rather than reverted or swept
  into the commit. Decide what it is before committing it.
- **The flake only sees git-tracked files.** A new source file that is not
  `git add`ed does not exist inside `nix build`: the first build of this step
  failed with `Cannot find module './workflow-commands.js'` while local `tsc`
  was clean. Stage new files before building.
- **`PI_CODING_AGENT_DIR` leaks into hand-run harnesses.** Inside the nix sandbox
  the agent dir defaults to `$HOME/.pi/agent`, but running a check script from a
  Pi session inherits `PI_CODING_AGENT_DIR` and the scan finds the real agent dir
  instead of the throwaway one. `loom-workflow-args.sh` now exports it
  explicitly; the three older harnesses do not and will mislead if run by hand.
- **Never `head -1` a presented message.** Still true, and now also applies to
  notifications: usage text is multi-line, so the harness serialises each
  notification with `jq -c` before decoding it.
- **`inputsSettled()` gates on four parking lots** (checkpoints, questions, edits,
  reviews). Anything that parks a new kind of human input must add its lot there
  or a pending item will look like a running run.
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
- **Two facts all four harnesses depend on.** Pi's agent dir defaults to
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
- [ ] **P3b — project scope.** Project-local `.pi/workflows/` scan root and a
      `/workflows` listing that names each command's scope.
- [ ] **P4 — stage library + `/build` + `/quick`.**
- [ ] **P5 — router + picker.**
- [ ] **P6 — `/wf-new` meta-workflow.**
- [ ] **P7 — ecosystem fill.** `/explore`, `/debug`, `/review`; migrate the
      `ship` and `next` skills to workflows.
- [ ] **P8 — bare-core CI.** `checks.pi-loom-bare`.

Acceptance criteria for every phase above: see the Roadmap section of
`extensions/pi-loom/DESIGN.md`.
