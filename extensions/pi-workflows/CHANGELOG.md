# Changelog
## Unreleased

### New capabilities

- Added `workflow_status({ runId })` summaries across current-project sessions and guarded retry/resume recovery with an optional `expectedState` ([#164](https://github.com/vekexasia/pi-extensible-workflows/issues/164)).

### Breaking changes

- Removed extension variables. Use registered functions for reusable host-side capabilities and return values ([#155](https://github.com/vekexasia/pi-extensible-workflows/issues/155)).
- Removed the exported Herdr pane `inspect`, `transcript`, and `fork` actions. Pane inspection was already non-functional after the CLI extraction, while attempt forking did work; `piewf inspect` and `piewf transcript` remain available as ordinary CLI commands.

### Packaging

- Reorganized the repository as an npm-workspaces monorepo while keeping `pi-extensible-workflows` as the published core package.
## [3.4.2] - 2026-07-27

### Recovery and navigation

- Local workflow session disposal now waits for all in-flight prompts before releasing native resources ([#147](https://github.com/vekexasia/pi-extensible-workflows/issues/147)).
- Agent system prompts are now opened through Agent actions instead of being rendered directly in the workflow TUI details ([#153](https://github.com/vekexasia/pi-extensible-workflows/issues/153)).

### Verification

- `npm run check` passes.
## [3.4.1] - 2026-07-26

### Recovery and reliability

- Preserve substantive agent reports when Pi auto-compaction emits an empty `aborted` assistant message instead of treating the empty message as a successful result.

### Verification

- Added regression coverage for aborted assistant turns; package tests, lint, and documentation checks pass.

## [3.4.0] - 2026-07-26

### New capabilities

- Added support for launching reviewed workflow JavaScript files with `scriptPath`; file contents are captured at launch for retry and resume ([#145](https://github.com/vekexasia/pi-extensible-workflows/issues/145)).
- Workflow progress now displays runtime and keeps runtime accounting accurate across pauses and resumes ([#150](https://github.com/vekexasia/pi-extensible-workflows/issues/150)).
- Added a `/workflow` action to open agent prompts in the configured external editor while agents are running or settled ([#151](https://github.com/vekexasia/pi-extensible-workflows/issues/151)).
- Registered function launches may use `name` as an optional run label; `workflow` remains the function identity for resume and replay.

### Recovery, reliability, and navigation

- Inline foreground workflow progress now refreshes persisted agent state so stalled-agent warnings remain visible ([#149](https://github.com/vekexasia/pi-extensible-workflows/issues/149)).
- `/workflow` agent actions can now be closed with `h` or the left arrow ([#152](https://github.com/vekexasia/pi-extensible-workflows/issues/152)).

### Verification

- Package check passed: 427 tests, 426 passed, 1 skipped; lint, documentation checks, and package dry-run passed.

## [3.3.0] - 2026-07-26

### New capabilities

- Added per-run summaries and non-TTY/headless run inspection, including best-effort summary projection and journal-derived timestamps ([#129](https://github.com/vekexasia/pi-extensible-workflows/issues/129); [1908ae5](https://github.com/vekexasia/pi-extensible-workflows/commit/1908ae5), [a911588](https://github.com/vekexasia/pi-extensible-workflows/commit/a911588), [d91d29a](https://github.com/vekexasia/pi-extensible-workflows/commit/d91d29a), [6800fdd](https://github.com/vekexasia/pi-extensible-workflows/commit/6800fdd)).
- Added per-agent token and spend accounting to workflow inspection ([#134](https://github.com/vekexasia/pi-extensible-workflows/issues/134); [4bce545](https://github.com/vekexasia/pi-extensible-workflows/commit/4bce545)).
- Added portable workflow bundles with dependency preflight, selected payload resources, skills, extension modules, and self-contained launchers ([#123](https://github.com/vekexasia/pi-extensible-workflows/issues/123); [76dbc40](https://github.com/vekexasia/pi-extensible-workflows/commit/76dbc40), [0d6c91b](https://github.com/vekexasia/pi-extensible-workflows/commit/0d6c91b), [cc81808](https://github.com/vekexasia/pi-extensible-workflows/commit/cc81808)).
- Added workflow-specific `SYSTEM.md` files and role-level system prompt replacement ([#137](https://github.com/vekexasia/pi-extensible-workflows/issues/137); [cc1082e](https://github.com/vekexasia/pi-extensible-workflows/commit/cc1082e), [0ada062](https://github.com/vekexasia/pi-extensible-workflows/commit/0ada062)).
- Added orange stalled-agent warnings after ten minutes without observable session events ([#138](https://github.com/vekexasia/pi-extensible-workflows/issues/138); [30ab4a1](https://github.com/vekexasia/pi-extensible-workflows/commit/30ab4a1), [5577f69](https://github.com/vekexasia/pi-extensible-workflows/commit/5577f69), [4f594ec](https://github.com/vekexasia/pi-extensible-workflows/commit/4f594ec)).
- Added concise human-readable background failure follow-ups and `inspect --failed` for persisted runs ([#130](https://github.com/vekexasia/pi-extensible-workflows/issues/130); [90acffe](https://github.com/vekexasia/pi-extensible-workflows/commit/90acffe), [387643f](https://github.com/vekexasia/pi-extensible-workflows/commit/387643f), [30e67b2](https://github.com/vekexasia/pi-extensible-workflows/commit/30e67b2)).
- Added active shell operations to workflow progress and cleared stale shell activity during recovery ([#141](https://github.com/vekexasia/pi-extensible-workflows/issues/141); [cf62485](https://github.com/vekexasia/pi-extensible-workflows/commit/cf62485), [a7e4386](https://github.com/vekexasia/pi-extensible-workflows/commit/a7e4386)).

### Recovery, reliability, and navigation

- Continued TUI provider retries in the same native session, preserved results, and recovered thrown provider errors before disposal ([#135](https://github.com/vekexasia/pi-extensible-workflows/issues/135); [d75cb5b](https://github.com/vekexasia/pi-extensible-workflows/commit/d75cb5b), [0b09509](https://github.com/vekexasia/pi-extensible-workflows/commit/0b09509), [d7ca8e7](https://github.com/vekexasia/pi-extensible-workflows/commit/d7ca8e7)).
- Preserved registered workflow role definitions across retries ([#136](https://github.com/vekexasia/pi-extensible-workflows/issues/136); [3fcbf76](https://github.com/vekexasia/pi-extensible-workflows/commit/3fcbf76), [1755c30](https://github.com/vekexasia/pi-extensible-workflows/commit/1755c30)).
- Preserved foreground/background launch mode across resume and retry, including detached interactive budget recovery ([#142](https://github.com/vekexasia/pi-extensible-workflows/issues/142); [326f6bc](https://github.com/vekexasia/pi-extensible-workflows/commit/326f6bc), [fa58b94](https://github.com/vekexasia/pi-extensible-workflows/commit/fa58b94), [bfbd909](https://github.com/vekexasia/pi-extensible-workflows/commit/bfbd909)).
- Delivered detached foreground workflow completion and failure follow-ups correctly ([#143](https://github.com/vekexasia/pi-extensible-workflows/issues/143); [3d2a190](https://github.com/vekexasia/pi-extensible-workflows/commit/3d2a190)).
- Improved workflow navigator hierarchy and Back behavior, and added vim key support ([#139](https://github.com/vekexasia/pi-extensible-workflows/issues/139); [0dec3df](https://github.com/vekexasia/pi-extensible-workflows/commit/0dec3df); [#144](https://github.com/vekexasia/pi-extensible-workflows/issues/144); [3b34e78](https://github.com/vekexasia/pi-extensible-workflows/commit/3b34e78)).
- Completed external-editor artifact cleanup ([#133](https://github.com/vekexasia/pi-extensible-workflows/issues/133); [897f8fd](https://github.com/vekexasia/pi-extensible-workflows/commit/897f8fd)).

### Validation and acceptance coverage

- Added trust-boundary adversarial regression coverage ([#128](https://github.com/vekexasia/pi-extensible-workflows/issues/128); [3e5e6a3](https://github.com/vekexasia/pi-extensible-workflows/commit/3e5e6a3)).
- Added targeted recovery-selection, evaluation-argument, and partial-shell retry acceptance coverage ([#132](https://github.com/vekexasia/pi-extensible-workflows/issues/132); [245a956](https://github.com/vekexasia/pi-extensible-workflows/commit/245a956), [458f564](https://github.com/vekexasia/pi-extensible-workflows/commit/458f564), [50581d5](https://github.com/vekexasia/pi-extensible-workflows/commit/50581d5), [63e6901](https://github.com/vekexasia/pi-extensible-workflows/commit/63e6901)).

### Verification

- Package check passed: 405 tests, 404 passed, 1 skipped; lint, documentation checks, package dry-run, and npm publication passed.

## [3.2.0] - 2026-07-25

### Highlights

- Added a phase-first workflow navigator with responsive layouts and external-editor actions for workflow scripts and completed top-level agent results.
- Published a discoverable workflow extension template with a working role, tests, and setup documentation.
- Rejected unsafe concurrent same-callsite `agent()` calls and obvious `Promise.all(...map(agent))` fan-out; use `parallel()` or `pipeline()` for stable identity.
- Hardened worker temporary-path handling, workflow recovery routing, control-error rendering, and artifact navigation.
- Updated the bundled workflow skill to make named inline parallel fan-out followed by a summarizing agent the default path.

## [3.1.0] - 2026-07-24

### Highlights

- Added explicit dry-run-first `doctor cleanup` with age-gated, lease-aware, dependency-safe deletion of old terminal workflow runs.
- Added dynamic workflow model aliases and phase-aware workflow navigator views.

## [3.0.0] - 2026-07-23

### Breaking changes

- Removed persistent workflow conversations. Use independent `agent()` calls and pass completed results explicitly to later prompts.
- Added explicit `workflow_retry({ runId })` for failed runs, with linked child runs, cumulative budgets, structural journal replay, and durable named-worktree lineage.
- Registered function launches now reject a separate `name`; `workflow` is their run name.

## [2.0.0] - 2026-07-23

### Highlights

- Added schema-validated registered functions. Register reusable workflows under `functions`, launch them directly with `{ workflow: "name", args: {...} }`, or compose them with `context.invoke()`.
- Added the headless CLI: `run` launches registered functions, `export` creates executable POSIX launchers, and `transcript` renders saved sessions. Schema-derived flags, JSON input, trust overrides, and `--` passthrough are supported.
- Added the host-mediated `shell(command, options)` primitive with deterministic workflow identity, timeout and environment options, worktree-aware execution, and structured results.
- Added reusable worktrees. `withWorktree` callbacks receive a frozen `{ path, branch }` reference, and `parentRunId` can borrow matching named worktrees from a terminal run.
- Added bounded structured failure diagnostics, provider-failure recovery in the TUI, and Herdr pane inspection and attempt forking.

### Breaking changes
- Inline `workflow` launches require an explicit non-empty `name`; registered function launches may omit `name` and use the registered function name as the run name.
- Registered function launches ignore any separately supplied run name so function identity remains stable.
- Removed registered workflow scripts: `WorkflowExtension.workflows`, `WorkflowScriptDefinition`, `registry.workflow()` / `workflows()`, and `registeredWorkflowDefinitions`.
  - Migrate each workflow to `functions.<name>` with `description`, `input`, `output`, and `run(input, context)`.
  - Launch it with `{ workflow: "name", args: {...} }`.
- Changed `workflow_catalog` to return a compact index by default and removed its `workflows` collection.
  - Use the default call for discovery and `{ "name": "entry" }` for full details.
  - Host integrations should use `workflowCatalogIndex()`, `workflowCatalogDetail()`, or `registeredWorkflowFunctions()`.
- Bumped launch snapshot identity to v5. Cold resume rejects older snapshots, including v4 snapshots using the previous worktree or registered-function naming contracts, with `RESUME_INCOMPATIBLE`.
  - Relaunch affected workflows after updating. Completed runs remain inspectable and deletable.
- Changed budget relaxation to an asynchronous proposal. `workflow_resume` now returns `{ state: "awaiting_approval", proposalId }`.
  - Answer with `workflow_respond` using the returned `proposalId`. Budget tightening still resumes directly.
- `withWorktree` now requires an explicit non-empty name and callback; unnamed scopes are rejected.
- Removed transcript browsing from the navigator.
  - Use `pi-extensible-workflows transcript <session-file>` or Herdr pane actions.

### Other improvements

- Structured `workflow_result` submissions are accepted immediately without an unnecessary repair turn.
- Workflow overlays gained borders and stable compact rendering; agent rows are denser and unused budget rows stay hidden.
- Fixed fullscreen flashing, shell process-tree cleanup, shell RPC size boundaries, running-attempt fork classification, and exported launchers without a global CLI installation.
- Borrowed worktree bindings are persisted, lineage-checked, and fail closed when invalid. Borrowed worktrees are never deleted with the borrowing run.
- Global and trusted-project roles now propagate consistently through CLI launches, nested agents, and cold resume.
- Updated the README, developer and agent documentation, and bundled workflow skill for the CLI, trust model, shell gates, worktree reuse, and v5 snapshot contract.

### Verification

- Full test suite: 270 tests passing.
- Runtime acceptance suite: 24 tests passing.
- Build, lint, documentation checks, and package dry-run passing.

[3.4.2]: https://github.com/vekexasia/pi-extensible-workflows/compare/v3.4.1...v3.4.2
[3.4.0]: https://github.com/vekexasia/pi-extensible-workflows/compare/v3.3.0...v3.4.0
[3.2.0]: https://github.com/vekexasia/pi-extensible-workflows/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/vekexasia/pi-extensible-workflows/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/vekexasia/pi-extensible-workflows/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/vekexasia/pi-extensible-workflows/compare/v1.0.1...v2.0.0
