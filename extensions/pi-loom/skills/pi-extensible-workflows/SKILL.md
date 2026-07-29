---
name: pi-extensible-workflows
description: Use when the user explicitly asks for a workflow, fan-out, or multi-agent orchestration, or when a task decomposes into several independent agent tasks whose results must be combined.
---

# pi-extensible-workflows

## When to use

- Use `workflow` only for genuinely multi-agent orchestration; a single agent uses ordinary tools or `Agent` directly.
- Do not launch a workflow for a single quick read, edit, or question, even if the user mentions agents.
- Give phases distinct responsibilities and keep result flow explicit.
- Inspect the `workflow_catalog` tool result at least once before creating the first workflow for a task; call it again when you need details about a global function.

## Default path

For most multi-agent tasks, start with a named inline workflow: provide a non-empty `name` and a `script` that marks a `phase(...)`, fans out independent work with `parallel(...)`, awaits the keyed results, passes them into one summarizing `agent(...)`, and returns.

```js
phase("Research");
const reports = await parallel("research", {
  first: () => agent("Research the first target.", { label: "first target" }),
  second: () => agent("Research the second target.", { label: "second target" }),
});

phase("Summarize");
return await agent(
  prompt("Summarize these reports:\n\n{reports}", { reports }),
  { label: "summary" },
);
```

- Await `parallel(...)` or `pipeline(...)` results before interpolation; interpolate with `prompt("...{value}", { value })`. Placeholders in plain strings stay literal.
- Runs are backgrounded by default; completion arrives as a follow-up message. Set the tool-call `foreground: true` when the caller must wait for the final value.
- A reviewed JavaScript file on disk can use `scriptPath` instead of `script`.
- A registered workflow launches by name with JSON args:

```json
{ "workflow": "workflowName", "args": { "issue": 42 } }
```

## Progress and observability

- Call `phase("Name")` when a new group of work starts; phases are persisted per run and drive status and live progress views.
- Give every `agent(...)` call a unique short `label` (2-5 words) such as `{ label: "repo inventory" }`; labels make live status and failure reports readable.
- Use `log(messageString)` for brief operator status lines, not for data flow.

## Runtime and safety rules

- Workflow JavaScript has no imports, filesystem, network, process, or timers; delegate that work to agents.
- Available globals: `agent`, `shell`, `prompt`, `parallel`, `pipeline`, `withWorktree`, `checkpoint`, `human`, `phase`, `log`, `args`, plus `Promise`, `JSON`, and a frozen deterministic `Math` subset.
- `shell(command, options)` is the trusted host RPC for deterministic gates: it inherits the workflow or active-worktree cwd, merges string `env` overrides, and returns `{ exitCode, stdout, stderr }`. Nonzero exits are results; launch failures and timeouts fail with `SHELL_FAILED`.
- Using `shell()` to perform mutations is usually an antipattern. Use it mainly for verifications or idempotent actions:

```js
const testRes = await shell("yarn test", { env: { CI: "1" } });
if (testRes.exitCode === 0) return { ok: true };
```

## Human in the loop

A human is a callable participant beside `agent(...)`. Each call parks the run as awaiting input until a person (or the parent assistant, via the matching tool) responds; each request has a unique `name` within the run.

- `await human.ask({ name, prompt, choices, context? })` returns the chosen string. Requires 2-12 unique non-empty choices; `prompt` up to 1024 bytes, JSON `context` up to 4096 bytes. Answered by `workflow_answer({ runId, name, answer })`.
- `await human.edit({ name, prompt, text, context? })` returns `{ text, changed, abandoned }`; `text` up to 64 KiB. Answered by `workflow_edit({ runId, name, text? })`; omitting `text` leaves the buffer unedited.
- `await human.review({ name, prompt, subject, context? })` returns `{ verdict, note }` with verdict exactly `approve`, `changes`, or `reject`; `subject` up to 64 KiB, so pass a file path instead of inlining a large diff. Answered by `workflow_review({ runId, name, verdict, note? })`.
- `await checkpoint(...)` returns a boolean approval, answered by `workflow_respond({ runId, approved, name?, proposalId? })`.
- Headless CLI runs cannot ask a human; keep human calls out of workflows meant for CLI export.

## Recovery

Recovery map:

- `workflow_status({ runId })` reads a compact authoritative summary for a run in the current project, across sessions. It returns run metadata, state, delivery, budget and usage when configured, and agent summaries, not transcripts.
- `agent(..., { retries })` reruns one agent call in the same run for transient failures.
- `workflow_retry({ runId, expectedState?, foreground? })` replays a persisted failed run into a linked child: completed agent, shell, function, and checkpoint operations replay; incomplete work executes.
- `workflow_resume({ runId, expectedState?, budget?, foreground? })` continues a `budget_exhausted` run.
- `parentRunId` on a new launch only borrows named worktrees; it never replays or resumes.

Rules:

- After a failure follow-up, especially `CANCELLED` or `interrupted`, call `workflow_status({ runId })` first and pass its returned `state` as `expectedState` to the recovery tool, so recovery cannot act on a state that changed.
- After `CANCELLED` or `interrupted`, confirm whether the user already accepted a recovery prompt before starting replacement work; a failure follow-up may have been queued before the original run resumed.
- Recovery inherits the source snapshot's foreground or background launch mode; legacy snapshots without `launchMode` recover in background. Set `foreground: true` or `false` to override.
- External side effects from before the failure are not guaranteed exactly once.
- `workflow_stop` requires the exact run ID. Foreground launches and foreground recovery return the terminal value with the completed `runId`; background launches return `runId` immediately and deliver completion or failure as a follow-up.

## `agent()` options

```typescript
export interface AgentOptions {
  label?: string;
  model?: string;
  role?: string;
  tools?: string[];
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  outputSchema?: JsonSchema;
  retries?: number;
  timeoutMs?: number | null;
  [key: string]: JsonValue;
}
```

- A role owns execution policy: with `role`, do not set `model`, `thinking`, or `tools`; only task options such as `label`, `outputSchema`, `retries`, `timeoutMs`, or a `withWorktree` scope may accompany it.
- Extensions may add JSON-compatible agent options such as `advisor: true`; core keys keep validation and role constraints. Extension options go to setup hooks and are not inherited by child agents.
- Agent calls have no user-visible aliases: `label` is display only. Replay identity comes from the source call site, so calls from one site must not race outside `parallel` or `pipeline`, whose structural keys make replay deterministic.

## Passing agent results

Use independent `agent(prompt, options)` calls and pass each completed result explicitly to the next prompt; this keeps replay state local to each call:

```js
const findings = await agent("Inspect the implementation.", { label: "inspect" });
const fix = await agent(
  prompt("Propose the smallest fix from these findings:\n\n{findings}", { findings }),
  { label: "propose fix" },
);
return { findings, fix };
```

Direct nested-agent results are one-shot: `get_subagent_result` releases the payload after successful delivery, and a repeated retrieval fails with `AGENT_RESULT_COLLECTED`. Retry only when the earlier tool call failed before delivering the result.

## Worktrees

Use `withWorktree(name, callback)` for top-level agents that collaborate in one explicitly named worktree scope:

```js
const result = await withWorktree("issue", async ({ path, branch }) => {
  const report = await agent("Implement the issue", { label: "implement issue" });
  return { path, branch, report };
});
```

- Entering the scope materializes its worktree before the callback; the callback receives a frozen `{ path, branch }` reference and its bare return value is preserved.
- Concurrent agents share mutable files, so assign non-conflicting work or use separate named scopes when parallel branches need isolation: `parallel("implementation", { api: () => withWorktree("api", () => agent("Implement the API", { label: "api" })), ui: () => withWorktree("ui", () => agent("Implement the UI", { label: "ui" })) })`.
- Registered extension functions receive `withWorktree` in context and can compose other registered functions with `context.invoke("reviewRepository", { focus: "security" })`; their public inputs and outputs stay JSON, and callbacks cannot cross the extension boundary.

## Rules

- Use `parallel()` for independent tasks with different flows and `pipeline()` when every keyed item follows the same ordered stages; do not duplicate identical chains in `parallel()`. Signatures are `parallel(operationName, tasksRecord)` and `pipeline(operationName, itemsRecord, stagesRecord)`; keys are stable task, item, and stage names.
- Preserve item metadata in workflow code between pipeline stages instead of making agents echo it through `outputSchema`.
- Use a JavaScript loop for repeated work; each direct `agent(...)` call gets deterministic call-site and occurrence identity.
- `parallel()` and `pipeline()` return keyed bare values; await them before use.
- Use `outputSchema` only when another phase compares, aggregates, or validates a result, never for final prose. Keep only consumer-needed fields. Agents with it must call `workflow_result`; one repair prompt is built in.
- Omit `retries` unless an extra retry is justified and the work is idempotent.
- Do not add persona specifications to agent prompts; define the task directly.
- Add `budget` only for aggregate limits the user asked for. Valid dimensions are exactly `tokens`, `costUsd`, `durationMs`, and `agentLaunches`; each is `{ soft?: number, hard?: number }` with `soft < hard`.
- `budget_exhausted` runs resume through `workflow_resume`: omitted patch values stay unchanged, `null` removes a limit, tightening resumes directly. Relaxation stores the proposal and returns `{ state: "awaiting_approval", proposalId }`; `workflow_respond` must answer that ID. Rejection leaves the run exhausted; approval applies the budget and cold-resumes. `workflow_retry` is only for persisted `failed` runs and inherits cumulative usage; replay itself consumes no budget.
- Advanced controls — registered functions, `outputSchema`, budgets, checkpoints, worktrees, retry and resume, CLI export, `pipeline(...)` — stay available but are not requirements for the default inline path.
