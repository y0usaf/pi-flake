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

Last touched: P2c (`human.review`) landed and is ticked. All three human
primitives are done; the next open item is P3 (declaration mechanism).

What landed. `human.review({ name, prompt, subject, context })` as a DSL
primitive, resolving to `{ verdict, note }` where verdict is one of the fixed
trio `approve` / `changes` / `reject` (`HUMAN_REVIEW_VERDICTS` in `types.ts`),
plus `checks.pi-loom-human-review` driven by the new
`nix/checks/loom-human-review.sh`. The call path mirrors `human.ask` and
`human.edit`: frozen `human.review` in the vm sandbox sends the RPC method
`human.review`, the host arm of `handleRpc` wraps the record in the same branded
work-result envelope, and `humanReviewBridge` in `host.ts` parks the request in
the run journal, presents the subject, opens the verdict picker, and resolves
the parked promise. `RunStore.awaitHumanReview` / `answerHumanReview` /
`awaitingHumanReviews` are new, in their own `journal.awaitingReview` map.

Gates actually run: `nix build .#checks.x86_64-linux.pi-loom-human-review`
(pass, prints `human-review: verdict picker offered the fixed trio, the note
reached the next stage, the run resumed with the verdict`),
`nix build .#checks.x86_64-linux.biome-lint` (pass, same 1 pre-existing warning
in the eval harness), `nix flake check -L` (pass, all 17 checks).

Design decisions worth not re-litigating:

- **The verdict vocabulary is closed, the note is open.** Workflow-supplied
  choices are what `human.ask` is for; a review is typed so a later stage can
  branch on `verdict` without knowing which review produced it. Unknown verdicts
  are rejected in `RunStore.answerHumanReview`, which leaves the review parked
  and still answerable rather than resuming on a decision nobody made.
- **The subject is presented, not titled.** A picker title is one line and a
  diff is not, so with a UI attached the subject goes into the session as a
  display-only custom message (`present()` in `host.ts`, `customType
  "workflow-review"`, `triggerTurn: false`) and the picker asks only for the
  verdict. `triggerTurn: false` is load-bearing: `deliver()` always costs a model
  turn, this does not when the session is idle.
- **Dismissal is asymmetric on purpose.** Dismissing the verdict picker re-routes
  to the main agent (same as `human.ask`); dismissing the note prompt settles the
  review with an empty note, because the verdict was already the decision.

Traps for the next step:

- **`head -1` truncates presented content.** The first run of the review harness
  failed on a false negative: `jq -r ... | head -1` cut the multi-line diff to
  its first line. The check now uses `jq -c` so the JSON-encoded string stays on
  one line. Any future assertion on multi-line message content needs the same.
- **No static analysis for any human primitive.** `workflowCallKind()` in
  `validation.ts` only recognises bare `Identifier` callees, and `human.review`
  is a `MemberExpression` like its two siblings. `validateHumanReview` enforces
  the stable-name rule at dispatch instead. Adding member-callee support to
  `workflowCalls()` is separate work and would cover all three at once.
- **`inputsSettled()` now gates on four parking lots** (checkpoints, questions,
  edits, reviews). Anything that parks a new kind of human input must add its lot
  there or a pending item will look like a running run.
- **`WorkflowHumanUi` now carries `input` as well as `select` and `editor`.** It
  is still the one shared UI-slice type for every bridge; widen it rather than
  adding a fifth structural type.
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
- **Two facts all three harnesses depend on.** Pi's agent dir defaults to
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
