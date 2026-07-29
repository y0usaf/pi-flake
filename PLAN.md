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

Last touched: P2a (`human.ask`) landed and is ticked. P2 was split into
P2a/P2b/P2c first, because each of the three human primitives has a different
backing mechanism and one step cannot land all three honestly.

What landed. `human.ask({ name, prompt, choices, context })` as a DSL
primitive, plus `checks.pi-loom-human-ask` driven by the new
`nix/checks/loom-human-ask.sh`. The call path, end to end: the vm sandbox in
`execution.ts` exposes a frozen `human` object whose `ask` sends the RPC method
`human.ask`; the host arm of `handleRpc` wraps the answer in the same branded
work-result envelope `checkpoint` uses; `humanBridge` in `host.ts` parks the
question in the run journal, calls `ctx.ui.select`, and resolves the parked
promise when an answer arrives. `RunStore.awaitHumanRequest` /
`answerHumanRequest` / `awaitingHumanRequests` are new, in their own
`journal.awaitingHuman` map, so a checkpoint answer stays a boolean and an ask
answer stays one of the question's own choice strings.

Gates actually run: `nix build .#checks.x86_64-linux.pi-loom-human-ask` (pass,
prints `human-ask: choice UI rendered with the workflow's own choices, run
resumed with the selection`), `biome lint .` (pass, the same 1 pre-existing
warning in the eval harness, nothing new), `nix flake check -L` (pass, all 15
checks; the new one is #15).

Design decisions worth not re-litigating:

- **`pi-interview` cannot back `human.ask`.** It exposes its questionnaire only
  as the `interview_user` *tool*, and pi's extension API has no cross-extension
  tool invocation (checked `dist/core/extensions/types.d.ts` in
  `node_modules/@earendil-works/pi-coding-agent`). `human.ask` therefore uses
  the core `ctx.ui.select`. DESIGN.md records this divergence under
  Architecture; the DESIGN.md Roadmap line was corrected to match.
- **Not gated on `foreground`.** `checkpointBridge` only renders UI for
  foreground runs. An ask is the run addressing the human directly, so it
  renders whenever `ctx.hasUI`. Dismissing the picker delivers the question to
  the main agent for the new `workflow_answer` tool instead of cancelling.

Traps for the next step:

- **`human.ask` has no static analysis.** `workflowCallKind()` in
  `validation.ts` only recognises bare `Identifier` callees, and `human.ask` is
  a `MemberExpression`. Nothing statically enforces the stable-name rule that
  `checkpoint` gets; `validateHumanAsk` enforces it at dispatch instead. P2b
  and P2c inherit that gap. Adding member-callee support to `workflowCalls()`
  is the real fix and is a separate piece of work.
- **Reuse the P2a harness for P2b/P2c.** `nix/checks/loom-human-ask.sh` already
  solves the awkward part: RPC mode needs stdin held open across two writes
  (launch, then answer), which the script does with a FIFO on fd 3, and jq is
  reading a file still being appended to, so parse errors on partial lines are
  expected and suppressed. RPC exposes an `editor` UI method, which is what
  P2b's `$EDITOR` round trip should ride on.
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
- [ ] **P2b — `human.edit`.** `$EDITOR` round trip on a text artifact.
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
