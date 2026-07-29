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

Last touched: P2b (`human.edit`) landed and is ticked. P2c (`human.review`) is
the only human primitive left.

What landed. `human.edit({ name, prompt, text, context })` as a DSL primitive,
resolving to `{ text, changed, abandoned }`, plus `checks.pi-loom-human-edit`
driven by the new `nix/checks/loom-human-edit.sh`. The call path mirrors
`human.ask` exactly: frozen `human.edit` in the vm sandbox sends the RPC method
`human.edit`, the host arm of `handleRpc` wraps the record in the same branded
work-result envelope, and `humanEditBridge` in `host.ts` parks the buffer in the
run journal, calls `ctx.ui.editor(title, prefill)`, and resolves the parked
promise. `RunStore.awaitHumanEdit` / `answerHumanEdit` / `awaitingHumanEdits`
are new, in their own `journal.awaitingEdit` map.

Gates actually run: `nix build .#checks.x86_64-linux.pi-loom-human-edit` (pass,
prints `human-edit: editor opened prefilled, run resumed with the saved buffer,
unchanged and abandoned edits stayed distinct`),
`nix build .#checks.x86_64-linux.biome-lint` (pass, same 1 pre-existing warning
in the eval harness), `nix flake check -L` (pass, all 16 checks; the new one is
#16).

Design decisions worth not re-litigating:

- **The result is a record, not a string.** A buffer saved byte-identical and an
  abandoned editor both hand back the original text, so only
  `changed`/`abandoned` separate them. `changed` is computed inside
  `RunStore.answerHumanEdit` against the prefill it parked, never trusted from
  the caller, so the UI path and the `workflow_edit` tool path agree.
- **Abandonment settles the run; it does not re-route.** `human.ask` treats a
  dismissed picker as "not answering now" and hands the question to the main
  agent. A closed editor is a decision, so `humanEditBridge` resolves with
  `abandoned: true` instead. `workflow_edit` exists only for runs with no UI,
  and omitting its `text` argument means the same thing.

Traps for the next step:

- **P2c should reuse `nix/checks/loom-human-edit.sh`, not the ask harness.** It
  already answers three UI requests in one run through the FIFO on fd 3, with an
  `await_editor <n>` helper that picks the Nth request out of a file jq is still
  reading while it grows. A verdict probe needs the same multi-round shape.
  Note the harness must write the launch prompt line itself; forgetting it looks
  exactly like "the UI never rendered".
- **`human.edit` still has no static analysis**, same as `human.ask`:
  `workflowCallKind()` in `validation.ts` only recognises bare `Identifier`
  callees, and `human.edit` is a `MemberExpression`. `validateHumanEdit`
  enforces the stable-name rule at dispatch. P2c inherits the gap; adding
  member-callee support to `workflowCalls()` is separate work.
- **`inputsSettled()` is now the single gate on leaving awaiting-input.** It
  checks all three parking lots (checkpoints, questions, edits). P2c must add
  its own lot there or a pending review will look like a running run.
- **`WorkflowHumanUi` is the shared UI-slice type** for all three bridges, so
  the cold-resume path can hand one object to each. Widen that alias rather than
  adding a fourth ad-hoc structural type.
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
- **Two facts both harnesses depend on.** Pi's agent dir defaults to
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
- [ ] **P2c — `human.review`.** Structured verdict over a diff or artifact.
- [ ] **P3 — declaration mechanism.** JSON-Schema args in `command.json`,
      generated usage, `/workflows` listing, project-local `.pi/workflows/`
      scan root.
- [ ] **P4 — stage library + `/build` + `/quick`.**
- [ ] **P5 — router + picker.**
- [ ] **P6 — `/wf-new` meta-workflow.**
- [ ] **P7 — ecosystem fill.** `/explore`, `/debug`, `/review`; migrate the
      `ship` and `next` skills to workflows.
- [ ] **P8 — bare-core CI.** `checks.pi-loom-bare`.

Acceptance criteria for every phase above: see the Roadmap section of
`extensions/pi-loom/DESIGN.md`.
