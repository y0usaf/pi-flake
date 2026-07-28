import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Api, type Model } from "@earendil-works/pi-ai";
import { copyToClipboard, getAgentDir, ModelSelectorComponent, SettingsManager, truncateToVisualLines, type ExtensionAPI, type ExtensionUIContext, type ModelRuntime, type Theme } from "@earendil-works/pi-coding-agent";
import { FairAgentScheduler, WorkflowAgentExecutor, localAgentTransport, type AgentActivity, type AgentAttempt, type AgentDefinition, type AgentProgress, type AgentProviderFailure, type AgentProviderRecovery } from "./agent-execution.js";
import { acquireSessionLease, listPersistedSessionIds, listRunIds, RunStore, SessionLease, structuralPath as operationPath } from "./persistence.js";
import type { AwaitingCheckpoint, PersistedRun, WorktreeReference } from "./persistence.js";
import { budgetRelaxed, budgetUsage, mergeBudget, resumeBudgetAllowed, validateBudget, validateBudgetPatch, WorkflowBudgetRuntime } from "./budget.js";
import { asWorkflowError, aliasDrift, createLaunchSnapshot, deepFreeze, errorCode, errorText, fail, isWorkflowAuthored, jsonValue, modelAliasErrorName, modelCapability, object, parseModelReference, parseThinking, positiveInteger, resolveModelReference, validateModelAliases } from "./utils.js";
import { launchScriptForSnapshot, loadAgentDefinitions, preflight, resolveAgentResourcePolicy, resolveWorkflowSettings, saveModelAliases, validateAgentOptions, validateCheckpoint, validateModelAliasAvailability, validateShellOptions, validateWorkflowLaunchWithRegistry, workflowProjectSettingsPath, workflowPrompt, workflowSettingsPath } from "./validation.js";
import { beginWorkflowExtensionLoading, loadingRegistry, resetWorkflowRegistry, type WorkflowRegistryApi } from "./registry.js";
import { agentIdentityPath, agentWorktree, encoded, executeShellCommand, persistActiveAgentAttempt, persistAgentAttempts, readShellResult, runWorkflow, shellIdentityPath } from "./execution.js";
import { openWorkflowArtifact, workflowPromptArtifact, workflowResultArtifact, workflowScriptArtifact, type WorkflowArtifact } from "./workflow-artifacts.js";
import { ERROR_CODES, LAUNCH_SNAPSHOT_IDENTITY_VERSION, WORKFLOW_AGENT_STALL_THRESHOLD_MS, WORKFLOW_AGENT_STATE_CHANGED_EVENT, WORKFLOW_BUDGET_EVENT, WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, WORKFLOW_PHASE_CHANGED_EVENT, WORKFLOW_RUN_COMPLETED_EVENT, WORKFLOW_RUN_FAILED_EVENT, WORKFLOW_RUN_RESUMED_EVENT, WORKFLOW_RUN_STARTED_EVENT, WORKFLOW_RUN_STATE_CHANGED_EVENT, WORKFLOW_WORKTREE_CREATED_EVENT, WorkflowError, type AgentAttemptActionContext, type AgentAttemptSummary, type AgentOptions, type AgentRecord, type AgentResourcePolicy, type AgentTransport, type BudgetApprovalRequest, type BudgetEvent, type JsonValue, type LaunchSnapshot, type ModelSpec, type RunState, type ShellIdentity, type ShellOptions, type ShellResult, type WorkflowBridge, type WorkflowCatalogFunction, type WorkflowCatalogIndex, type WorkflowCheckpointState, type WorkflowErrorCode, type WorkflowErrorShape, type WorkflowEventBase, type WorkflowFailureAgent, type WorkflowFailureDiagnostics, type WorkflowFunctionContext, type WorkflowExecution, type WorkflowMetadata, type WorkflowModelAliasResolverContext, type WorkflowRetryProvenance, type WorkflowRunContext, type WorkflowSettings, type WorkflowSettingsResolution, type WorkflowSiblingAgent, type WorkflowWorktreeReference } from "./types.js";
const SETTLED_AGENT_STATES: ReadonlySet<import("./types.js").AgentState> = new Set(["completed", "failed", "cancelled"]);
const INTERNAL_WORKFLOW_TOOLS: readonly string[] = ["workflow", "workflow_respond", "workflow_stop", "workflow_status", "workflow_resume", "workflow_retry", "workflow_catalog"];
const HARD_TERMINAL_RUN_STATES: ReadonlySet<string> = new Set(["completed", "failed", "stopped"]);
const SHUTDOWN_TERMINAL_RUN_STATES: ReadonlySet<string> = new Set(["completed", "failed", "stopped", "budget_exhausted"]);
const FAILURE_DELIVERY_STATES: ReadonlySet<RunState> = new Set(["failed", "stopped", "interrupted", "budget_exhausted"]);
export interface WorkflowProgressStyles {
  accent(text: string): string;
  success(text: string): string;
  error(text: string): string;
  warning(text: string): string;
  muted(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}
function snapshotResourcePolicy(snapshot: Readonly<LaunchSnapshot>, cwd: string, projectTrusted: boolean, globalSettingsPath: string): AgentResourcePolicy {
  const empty = { skills: [], extensions: [] };
  return { globalSettingsPath, projectSettingsPath: workflowProjectSettingsPath(cwd), projectTrusted, global: empty, project: empty, effective: snapshot.settings.disabledAgentResources ?? empty, unmatchedSkills: [], unmatchedExtensions: [] };
}
const PLAIN_WORKFLOW_PROGRESS_STYLES: WorkflowProgressStyles = { accent: (text) => text, success: (text) => text, error: (text) => text, warning: (text) => text, muted: (text) => text, dim: (text) => text, bold: (text) => text };
type WorkflowLaunchSettings = { settings: Readonly<WorkflowSettings>; resolution: WorkflowSettingsResolution; resourcePolicy: AgentResourcePolicy };
function workflowLaunchSettings(cwd: string, projectTrusted: boolean, globalSettingsPath: string, concurrency?: number): WorkflowLaunchSettings {
  const resolution = resolveWorkflowSettings(cwd, projectTrusted, globalSettingsPath);
  const settings = Object.freeze({ ...resolution.effective, ...(concurrency === undefined ? {} : { concurrency }) });
  return { settings, resolution, resourcePolicy: resolveAgentResourcePolicy(cwd, projectTrusted, globalSettingsPath) };
}
function frozenResourcePolicy(policy: AgentResourcePolicy): () => AgentResourcePolicy { return () => structuredClone(policy); }
function resumedSnapshotSettings(snapshot: Readonly<LaunchSnapshot>, resolution: WorkflowSettingsResolution, modelAliases: Readonly<Record<string, string>>): { settings: WorkflowSettings; settingsSources?: NonNullable<LaunchSnapshot["settingsSources"]> } {
  const settings: WorkflowSettings = { ...snapshot.settings, concurrency: snapshot.settingsSources === undefined || snapshot.settingsSources.concurrency === "per-run options" ? snapshot.settings.concurrency : resolution.effective.concurrency, modelAliases };
  if (resolution.effective.disabledAgentResources === undefined) delete settings.disabledAgentResources;
  else settings.disabledAgentResources = resolution.effective.disabledAgentResources;
  const settingsSources = snapshot.settingsSources === undefined ? undefined : { ...snapshot.settingsSources, modelAliases: resolution.sources.modelAliases, disabledAgentResources: resolution.sources.disabledAgentResources, concurrency: snapshot.settingsSources.concurrency === "per-run options" ? "per-run options" : resolution.sources.concurrency };
  return { settings, ...(settingsSources === undefined ? {} : { settingsSources }) };
}
const WORKFLOW_FAILURE_DIAGNOSTICS = Symbol("workflowFailureDiagnostics");

function workflowDetail(message: string): string {
  const detail = message.trim().replace(new RegExp(`\\b(?:${ERROR_CODES.join("|")})\\b:?\\s*`, "g"), "").replace(/^\s*[A-Z][A-Z0-9_]+:\s*/, "").split("\n").filter((line) => !/^\s*at\s/.test(line)).join("\n").replace(/^Run \S+(?=\s(?:exceeded|is))/i, "Run").replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "the workflow").replace(/^(?:Pi )session \S+(?=\s(?:is|has))/i, "session").replace(/^(Unknown scheduler run|Missing production ownership record|Persisted agent belongs to another run):\s*\S+/i, "$1").replace(/\b(?:runId|sessionId|callSite|occurrence|failedAt|id)[:=]\s*\S+/gi, "").replace(/\s{2,}/g, " ").trim();
  return detail || "No further details were provided";
}

const WORKFLOW_ERROR_PROSE: Record<WorkflowErrorCode, (detail: string) => string> = {
  CONFIG_ERROR: (detail) => `The workflow configuration is invalid: ${detail}.`,
  INVALID_SETTINGS: (detail) => `The workflow settings are invalid: ${detail}.`,
  INVALID_SYNTAX: (detail) => `The workflow source is invalid: ${detail}.`,
  INVALID_METADATA: (detail) => `The workflow metadata is invalid: ${detail}.`,
  DUPLICATE_NAME: (detail) => `The workflow contains a duplicate name: ${detail}.`,
  INVALID_SCHEMA: (detail) => `The workflow schema is invalid: ${detail}.`,
  REGISTRY_FROZEN: (detail) => `Workflow extension registration is closed: ${detail}.`,
  GLOBAL_COLLISION: (detail) => `The workflow global name is already in use: ${detail}.`,
  MISSING_WORKFLOW: (detail) => `The registered workflow function is unavailable: ${detail}.`,
  UNKNOWN_MODEL: (detail) => `The workflow requested the unavailable model ${detail.replace(/^(?:Unknown model(?: for role [^:]+)?|Invalid model spec):\s*/, "")}.`,
  UNKNOWN_TOOL: (detail) => `The workflow requested the unavailable tool ${detail.replace(/^Unknown tool:\s*/, "")}.`,
  UNKNOWN_AGENT_TYPE: (detail) => `The workflow requested the unavailable agent role ${detail.replace(/^Unknown agent role:\s*/, "")}.`,
  RUN_OWNED: (detail) => /already owned|active ownership/.test(detail) ? "The workflow session is already in use." : `The workflow session is already in use: ${detail}.`,
  RUN_NOT_FOUND: (detail) => /^Unknown workflow run\b/.test(detail) ? "The workflow run was not found." : `The workflow run was not found: ${detail}.`,
  RPC_LIMIT_EXCEEDED: (detail) => `The workflow communication data exceeded its size limit: ${detail}.`,
  SHELL_FAILED: (detail) => `The workflow shell command failed: ${detail}.`,
  AGENT_TIMEOUT: (detail) => `The workflow agent timed out: ${detail}.`,
  AGENT_FAILED: (detail) => `The workflow agent failed: ${detail}.`,
  AGENT_RESULT_COLLECTED: (detail) => `The nested agent result was already collected: ${detail}.`,
  RESULT_INVALID: (detail) => `The workflow produced an invalid result: ${detail}.`,
  CANCELLED: (detail) => `The workflow was cancelled: ${detail}.`,
  WORKER_UNRESPONSIVE: (detail) => `The workflow worker stopped responding: ${detail}.`,
  WORKTREE_FAILED: (detail) => `The workflow worktree operation failed: ${detail}.`,
  RESUME_INCOMPATIBLE: (detail) => `The workflow cannot resume this run: ${detail}.`,
  BUDGET_EXHAUSTED: (detail) => `The workflow budget was exhausted: ${detail}.`,
  INTERNAL_ERROR: (detail) => `The workflow encountered an internal error: ${detail}.`,
};
export function formatWorkflowFailure(error: unknown): string {
  if (isWorkflowAuthored(error)) return errorText(error);
  const code = errorCode(error);
  if (code) return WORKFLOW_ERROR_PROSE[code](workflowDetail(errorText(error)));
  if (error instanceof Error) return error.message || "The workflow failed without an error message.";
  return `The workflow failed with value ${String(error)}.`;
}
function mainAgentError(error: unknown): WorkflowError {
  const typed = asWorkflowError(error);
  const presented = new WorkflowError(typed.code, formatWorkflowFailure(typed));
  Object.assign(presented, typed);
  return presented;
}
function workflowFailedAt(error: unknown): string | undefined { return object(error) && typeof error.failedAt === "string" && error.failedAt ? error.failedAt : undefined; }
function persistedFailure(run: PersistedRun, error: WorkflowError): PersistedRun { const failedAt = workflowFailedAt(error); return { ...run, error: { code: error.code, message: error.message, ...(failedAt ? { failedAt } : {}) }, ...(failedAt ? { failedAt } : {}) }; }

export class RunLifecycle {
  #state: RunState;
  #active = 0;
  #waiters: Array<() => void> = [];

  constructor(state: RunState = "running", private readonly changed?: (state: RunState, previousState: RunState, reason?: string) => void | Promise<void>) { this.#state = state; }
  get state(): RunState { return this.#state; }

  async enter(): Promise<void> {
    while (this.#state === "pausing" || this.#state === "paused" || this.#state === "awaiting_input") await new Promise<void>((resolve) => { this.#waiters.push(resolve); });
    if (this.#state !== "running") throw new WorkflowError("CANCELLED", `Run is ${this.#state}`);
    this.#active += 1;
  }

  async leave(): Promise<void> {
    if (this.#active > 0) this.#active -= 1;
    if (this.#state === "pausing" && this.#active === 0) await this.#set("paused", "pause");
  }

  async enterAwaitingInput(): Promise<void> {
    while (this.#state === "pausing" || this.#state === "paused") await new Promise<void>((resolve) => { this.#waiters.push(resolve); });
    if (this.#state === "awaiting_input") return;
    if (this.#state !== "running") throw new WorkflowError("RESUME_INCOMPATIBLE", `Cannot await input for ${this.#state} run`);
    await this.#set("awaiting_input", "awaiting_input");
  }

  async resolveAwaitingInput(): Promise<void> {
    if (this.#state !== "awaiting_input") return;
    await this.#set("running", "checkpoint_resolved");
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  async pause(): Promise<void> {
    if (this.#state !== "running") throw new WorkflowError("RESUME_INCOMPATIBLE", `Cannot pause ${this.#state} run`);
    await this.#set("pausing", "pause");
    if (this.#active === 0 && this.state === "pausing") await this.#set("paused", "pause");
  }

  async resume(): Promise<void> {
    if (this.#state !== "paused" && this.#state !== "interrupted" && this.#state !== "budget_exhausted") throw new WorkflowError("RESUME_INCOMPATIBLE", `Cannot resume ${this.#state} run`);
    await this.#set("running", "resume");
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  async providerPause(): Promise<void> {
    await this.leave();
    if (this.#state === "running") await this.pause();
    await this.enter();
  }

  async terminal(state: "completed" | "failed" | "stopped" | "interrupted" | "budget_exhausted", reason?: string): Promise<void> {
    if (HARD_TERMINAL_RUN_STATES.has(this.#state)) throw new WorkflowError("RESUME_INCOMPATIBLE", `${this.#state} runs are terminal`);
    await this.#set(state, reason ?? state);
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  async #set(state: RunState, reason?: string): Promise<void> {
    const previousState = this.#state;
    this.#state = state;
    await this.changed?.(state, previousState, reason);
  }
}

export function formatWorkflowPreview(args: { script?: unknown; workflow?: unknown; name?: unknown; description?: unknown }): string {
  const explicitName = typeof args.name === "string" && args.name.trim() ? args.name.trim() : undefined;
  const registeredName = typeof args.workflow === "string" && args.workflow.trim() ? args.workflow.trim() : undefined;
  const name = explicitName ?? registeredName ?? "workflow";
  if (typeof args.script !== "string" || !args.script.trim()) return `workflow ${name}${registeredName ? `\nRegistered function${explicitName ? `: ${registeredName}` : ""}` : ""}`;
  return [`workflow ${name}`, typeof args.description === "string" && args.description.trim() ? args.description.trim() : ""].filter(Boolean).join("\n");
}
export const WORKFLOW_TOOL_LABEL = "Workflow";
export const WORKFLOW_TOOL_DESCRIPTION = "Run a deterministic JavaScript workflow with a named inline or file-backed parallel-to-summary path by default"
export const WORKFLOW_TOOL_PROMPT_SNIPPET = "Run a deterministic, resumable JavaScript workflow. Prefer a named inline script that fans out independent work with parallel(...), awaits the keyed results before interpolating them into one summarizing agent(...), and returns. Inline and file-backed launches require a non-empty name; registered function launches may use name as an optional run label and otherwise use workflow as the run name. Advanced controls include registered functions, outputSchema, budgets, checkpoints, worktrees, retry/resume, CLI export, and pipelines. Use workflow_retry with an explicit failed run ID; parentRunId only reuses named worktrees. Runs are in the background by default; completion arrives as a follow-up message. Set foreground: true when the caller must wait for the final value. If a foreground call detaches before its result is accepted, its terminal success or failure is promoted to one follow-up message. Foreground results include the completed run ID. Recovery inherits the source launch mode; legacy snapshots without launchMode recover in the background. Set foreground: true or false on workflow_resume/workflow_retry to override it; foreground recovery waits for terminal value and run details, while background recovery returns immediately and delivers completion or failure as a follow-up. After failure follow-ups, especially CANCELLED or interrupted runs, call workflow_status({ runId }) before recovery or replacement work, then pass its state as expectedState to workflow_retry/workflow_resume so recovery cannot act on a state that changed. Recovery map: agent(..., { retries }) reruns one agent call in the same run for transient failures; workflow_retry({ runId, expectedState?, foreground? }) replays a failed run into a child; workflow_resume({ runId, expectedState?, budget?, foreground? }) continues a budget_exhausted run; parentRunId on a new launch only borrows named worktrees and never replays or resumes."
function workflowRecoveryGuidance(action: "resume" | "retry", state: RunState): string {
  if (action === "resume") {
    if (state === "failed") return "Failed workflow runs must use workflow_retry({ runId })";
    if (state === "completed") return "Completed workflow runs have no recovery action";
    if (state === "stopped") return "Stopped workflow runs have no recovery action; launch a new workflow";
    if (state === "interrupted") return "Interrupted workflow runs use /workflow resume, not workflow_resume";
    return `Only budget-exhausted runs can be resumed with workflow_resume; source is ${state}`;
  }
  if (state === "budget_exhausted") return "Budget-exhausted workflow runs must use workflow_resume({ runId, budget? })";
  if (state === "completed") return "Completed workflow runs have no recovery action";
  if (state === "stopped") return "Stopped workflow runs cannot be retried; launch a new workflow";
  if (state === "interrupted") return "Interrupted workflow runs use /workflow resume, not workflow_retry";
  return `Only failed workflow runs can be retried; source is ${state}`;
}
function assertExpectedWorkflowState(expectedState: string | undefined, actualState: RunState): void {
  if (expectedState !== undefined && expectedState !== actualState) throw new WorkflowError("RESUME_INCOMPATIBLE", `Workflow run state changed: expected state ${expectedState}, actual state ${actualState}`);
}
export const WORKFLOW_TOOL_PARAMETERS = Type.Object({
  name: Type.Optional(Type.String({ description: "Optional run label; required and non-empty for inline or file-backed launches, defaults to the registered function name when omitted" })),
  description: Type.Optional(Type.String({ description: "Optional human-readable workflow description" })),
  script: Type.Optional(Type.String({ description: "Immutable inline workflow source; default to a named script that fans out with parallel(...) and awaits results before passing them to a summarizing agent(...)" })),
  scriptPath: Type.Optional(Type.String({ description: "Path to a JavaScript workflow file, read once at launch and persisted as the inline source" })),
  workflow: Type.Optional(Type.String({ description: "Advanced: registered reusable function as an unqualified name; name may optionally label the run" })),
  args: Type.Optional(Type.Unknown({ description: "JSON-compatible workflow arguments" })),
  foreground: Type.Optional(Type.Boolean({ description: "Wait for completion instead of the default background launch" })),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 16, description: "Advanced: optional per-run active-agent limit" })),
  budget: Type.Optional(Type.Unknown({ description: "Advanced: optional aggregate soft and hard run budgets" })),
  parentRunId: Type.Optional(Type.String({ description: "Advanced: terminal run whose named worktrees may be reused" })),
});
export const WORKFLOW_STATUS_PARAMETERS = Type.Object({ runId: Type.String({ description: "Workflow run ID visible in the current project" }) }, { additionalProperties: false });
export const WORKFLOW_RETRY_PARAMETERS = Type.Object({ runId: Type.String({ description: "Explicit failed workflow run ID" }), expectedState: Type.Optional(Type.String({ description: "Persisted source state observed before recovery" })), foreground: Type.Optional(Type.Boolean({ description: "Override the source launch mode for this recovery" })) });

type WorkflowToolUpdate = { content: [{ type: "text"; text: string }]; details: { runId: string; run: PersistedRun } };
export type WorkflowPhaseState = "not started" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | "budget_exhausted";
export interface WorkflowPhaseAgentCounts { total: number; completed: number; running: number; failed: number; cancelled: number; pending: number }
export interface WorkflowPhaseView { id: string; name: string; occurrence: number; state: WorkflowPhaseState; observed: boolean; afterAgent?: number; agents: readonly AgentRecord[]; counts: WorkflowPhaseAgentCounts }
export interface WorkflowPhaseModel { declaredPhases: readonly string[]; phases: readonly WorkflowPhaseView[]; currentPhaseIndex?: number; currentPhaseId?: string; counts: Readonly<Partial<Record<WorkflowPhaseState, number>>>; unassignedAgents?: readonly AgentRecord[] }
type WorkflowPhaseSource = readonly string[] | Pick<LaunchSnapshot, "phases"> | undefined;
function phaseNames(source: WorkflowPhaseSource): string[] {
  const phases: readonly unknown[] = source === undefined ? [] : Array.isArray(source) ? source : (source as Pick<LaunchSnapshot, "phases">).phases ?? [];
  return phases.filter((phase): phase is string => typeof phase === "string" && phase.trim() !== "").map((phase) => phase.trim());
}
function phaseAgentCounts(agents: readonly AgentRecord[]): WorkflowPhaseAgentCounts {
  const counts: WorkflowPhaseAgentCounts = { total: agents.length, completed: 0, running: 0, failed: 0, cancelled: 0, pending: 0 };
  for (const agent of agents) {
    if (agent.state === "completed") counts.completed += 1;
    else if (agent.state === "running") counts.running += 1;
    else if (agent.state === "failed") counts.failed += 1;
    else if (agent.state === "cancelled") counts.cancelled += 1;
    else counts.pending += 1;
  }
  return counts;
}
function phaseState(runState: RunState, counts: WorkflowPhaseAgentCounts, isLatest: boolean): WorkflowPhaseState {
  if (!isLatest) return "completed";
  if (runState === "failed") return "failed";
  if (runState === "stopped") return "cancelled";
  if (runState === "interrupted") return "interrupted";
  if (runState === "budget_exhausted") return "budget_exhausted";
  if (counts.failed > 0) return "failed";
  if (counts.cancelled > 0) return "cancelled";
  if (counts.running > 0 || counts.pending > 0) return "running";
  return runState === "completed" ? "completed" : "running";
}
export function buildWorkflowPhaseModel(run: Pick<PersistedRun, "state" | "phase" | "phaseHistory" | "agents">, source?: WorkflowPhaseSource): WorkflowPhaseModel {
  const declaredPhases = phaseNames(source);
  const rawHistory: readonly unknown[] = Array.isArray(run.phaseHistory) ? run.phaseHistory : [];
  const observed: Array<{ name: string; afterAgent: number }> = [];
  let boundary = 0;
  for (const record of rawHistory) {
    if (!object(record) || typeof record.phase !== "string" || !record.phase.trim() || typeof record.afterAgent !== "number" || !Number.isSafeInteger(record.afterAgent)) continue;
    boundary = Math.max(boundary, Math.min(run.agents.length, Math.max(0, record.afterAgent)));
    observed.push({ name: record.phase.trim(), afterAgent: boundary });
  }
  if (!observed.length && typeof run.phase === "string" && run.phase.trim()) observed.push({ name: run.phase.trim(), afterAgent: 0 });
  const observedEntries = observed.map((entry, index) => ({ ...entry, index, agents: run.agents.slice(entry.afterAgent, observed[index + 1]?.afterAgent ?? run.agents.length) }));
  const matchedDeclarations = new Set<number>();
  const declarationIndices = observedEntries.map((entry) => {
    const index = declaredPhases.findIndex((name, candidate) => !matchedDeclarations.has(candidate) && name === entry.name);
    if (index >= 0) matchedDeclarations.add(index);
    return index >= 0 ? index : undefined;
  });
  const entries: Array<{ name: string; observedIndex?: number; declarationIndex?: number }> = observedEntries.map((entry, index) => ({ name: entry.name, observedIndex: index, ...(declarationIndices[index] === undefined ? {} : { declarationIndex: declarationIndices[index] }) }));
  for (const [declarationIndex, name] of declaredPhases.entries()) {
    if (matchedDeclarations.has(declarationIndex)) continue;
    const insertion = entries.findIndex((entry) => entry.declarationIndex !== undefined && entry.declarationIndex > declarationIndex);
    const pending = { name };
    if (insertion < 0) entries.push(pending); else entries.splice(insertion, 0, pending);
  }
  const occurrences = new Map<string, number>();
  const phases = entries.map((entry) => {
    const occurrence = (occurrences.get(entry.name) ?? 0) + 1;
    occurrences.set(entry.name, occurrence);
    const observation = entry.observedIndex === undefined ? undefined : observedEntries[entry.observedIndex];
    const agents = observation?.agents ?? [];
    const counts = phaseAgentCounts(agents);
    const state = observation ? phaseState(run.state, counts, entry.observedIndex === observedEntries.length - 1) : "not started";
    return { id: `${entry.name}#${String(occurrence)}`, name: entry.name, occurrence, state, observed: observation !== undefined, ...(observation ? { afterAgent: observation.afterAgent } : {}), agents, counts };
  });
  let currentPhaseIndex: number | undefined;
  for (let index = phases.length - 1; index >= 0; index -= 1) { if (phases[index]?.observed) { currentPhaseIndex = index; break; } }
  const counts: Partial<Record<WorkflowPhaseState, number>> = {};
  for (const phase of phases) counts[phase.state] = (counts[phase.state] ?? 0) + 1;
  const current = currentPhaseIndex === undefined ? undefined : phases[currentPhaseIndex];
  const assigned = new Set(observedEntries.flatMap(({ agents }) => agents.map((agent) => agent.id)));
  const unassignedAgents = run.agents.filter((agent) => !assigned.has(agent.id));
  const result: WorkflowPhaseModel = { declaredPhases, phases, counts };
  if (current !== undefined && currentPhaseIndex !== undefined) { result.currentPhaseIndex = currentPhaseIndex; result.currentPhaseId = current.id; }
  if (unassignedAgents.length) result.unassignedAgents = unassignedAgents;
  return result;
}
export interface WorkflowPhaseSelection { phaseId?: string | undefined; agentId?: string | undefined; nodeId?: string | undefined; expandedNodeIds?: readonly string[] | undefined; treeOnly?: boolean | undefined; detailsOnly?: boolean | undefined; actions?: { title: string; options: readonly string[]; index: number } | undefined }
export type WorkflowPhaseTreeNodeKind = "phase" | "operation" | "agent";
export interface WorkflowPhaseTreeNode { id: string; kind: WorkflowPhaseTreeNodeKind; label: string; depth: number; phaseId: string; operationPath: readonly string[]; parentId?: string; children: readonly string[]; state: WorkflowPhaseState | AgentRecord["state"]; agentId?: string; agent?: AgentRecord; phase?: WorkflowPhaseView }
export interface WorkflowPhaseTree { roots: readonly string[]; nodes: readonly WorkflowPhaseTreeNode[]; byId: ReadonlyMap<string, WorkflowPhaseTreeNode> }
export interface WorkflowPhaseTreeSelection { nodeId?: string | undefined }
export type WorkflowPhaseTreeDirection = "up" | "down" | "left" | "right";
function workflowPhaseTreePath(kind: WorkflowPhaseTreeNodeKind, phaseId: string, operationPath: readonly string[], agentId?: string): string {
  const root = `phase/${encodeURIComponent(phaseId)}`;
  if (kind === "phase") return root;
  const operation = operationPath.map((part) => encodeURIComponent(part)).join("/");
  if (kind === "operation") return `${root}/operation/${operation}`;
  return operation ? `${root}/operation/${operation}/agent/${encodeURIComponent(agentId ?? "")}` : `${root}/agent/${encodeURIComponent(agentId ?? "")}`;
}
function workflowPhaseTreeAggregateState(states: readonly AgentRecord["state"][]): AgentRecord["state"] {
  if (!states.length || states.every((state) => state === "completed")) return "completed";
  if (states.some((state) => state === "failed")) return "failed";
  if (states.some((state) => state === "cancelled")) return "cancelled";
  if (states.some((state) => state === "running")) return "running";
  return "queued";
}
export function buildWorkflowPhaseTree(model: WorkflowPhaseModel): WorkflowPhaseTree {
  type Draft = Omit<WorkflowPhaseTreeNode, "children"> & { children: string[] };
  type AgentEntry = { agent: AgentRecord; node: Draft; path: readonly string[]; defaultParentId: string };
  const drafts = new Map<string, Draft>();
  const roots: string[] = [];
  const add = (node: Omit<Draft, "children">, parentId?: string): Draft => {
    const existing = drafts.get(node.id);
    if (existing) return existing;
    const draft: Draft = { ...node, ...(parentId === undefined ? {} : { parentId }), children: [] };
    drafts.set(draft.id, draft);
    if (parentId === undefined) roots.push(draft.id); else drafts.get(parentId)?.children.push(draft.id);
    return draft;
  };
  const samePath = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((part, index) => part === right[index]);
  const addPhase = (phaseId: string, label: string, agents: readonly AgentRecord[], phase?: WorkflowPhaseView): void => {
    const phaseNode = add({ id: workflowPhaseTreePath("phase", phaseId, []), kind: "phase", label, depth: 0, phaseId, operationPath: [], state: phase?.state ?? workflowPhaseTreeAggregateState(agents.map((agent) => agent.state)), ...(phase ? { phase } : {}) });
    const operationNodes = new Map<string, Draft>();
    const entries: AgentEntry[] = agents.map((agent) => ({ agent, path: [...(agent.structuralPath ?? [])], node: undefined as unknown as Draft, defaultParentId: phaseNode.id }));
    const agentEntries = new Map(entries.map((entry) => [entry.agent.id, entry]));
    const acceptedParents = new Map<string, string>();
    const wouldCycle = (childId: string, parentId: string): boolean => {
      const seen = new Set<string>([childId]);
      let current: string | undefined = parentId;
      while (current) {
        if (seen.has(current)) return true;
        seen.add(current);
        current = acceptedParents.get(current);
      }
      return false;
    };
    for (const entry of entries) {
      const parent = entry.agent.parentId ? agentEntries.get(entry.agent.parentId) : undefined;
      if (parent && !wouldCycle(entry.agent.id, parent.agent.id)) acceptedParents.set(entry.agent.id, parent.agent.id);
    }
    const operationChain = (path: readonly string[], owner: Draft, startIndex = 0): Draft => {
      let parent = owner;
      for (let index = startIndex; index < path.length; index += 1) {
        const prefix = path.slice(0, index + 1);
        const key = `${owner.id}:${JSON.stringify(prefix)}`;
        const existing = operationNodes.get(key);
        if (existing) { parent = existing; continue; }
        const suffix = path.slice(startIndex, index + 1).map((part) => encodeURIComponent(part)).join("/");
        const id = owner.id === phaseNode.id ? workflowPhaseTreePath("operation", phaseId, prefix) : `${owner.id}/operation/${suffix}`;
        const operation = add({ id, kind: "operation", label: prefix.at(-1) ?? "", depth: 0, phaseId, operationPath: prefix, state: "queued", ...(phase ? { phase } : {}) }, parent.id);
        operationNodes.set(key, operation);
        parent = operation;
      }
      return parent;
    };
    for (const entry of entries) {
      if (!acceptedParents.has(entry.agent.id)) entry.defaultParentId = operationChain(entry.path, phaseNode).id;
    }
    for (const entry of entries) {
      entry.node = add({ id: workflowPhaseTreePath("agent", phaseId, entry.path, entry.agent.id), kind: "agent", label: entry.agent.label ?? entry.agent.name, depth: 0, phaseId, operationPath: entry.path, state: entry.agent.state, agentId: entry.agent.id, agent: entry.agent }, phaseNode.id);
    }
    const attach = (entry: AgentEntry, parentId: string): void => {
      const previous = entry.node.parentId ? drafts.get(entry.node.parentId) : undefined;
      if (previous) previous.children = previous.children.filter((childId) => childId !== entry.node.id);
      entry.node.parentId = parentId;
      const parent = drafts.get(parentId);
      if (parent && !parent.children.includes(entry.node.id)) parent.children.push(entry.node.id);
    };
    for (const entry of entries) {
      const parentId = acceptedParents.get(entry.agent.id);
      const parent = parentId ? agentEntries.get(parentId) : undefined;
      if (parent) {
        if (samePath(entry.path, parent.path)) entry.defaultParentId = parent.node.id;
        else {
          const commonLength = entry.path.findIndex((part, index) => parent.path[index] !== part);
          const startIndex = commonLength < 0 ? Math.min(entry.path.length, parent.path.length) : commonLength;
          entry.defaultParentId = operationChain(entry.path, parent.node, startIndex).id;
        }
      }
      attach(entry, entry.defaultParentId);
    }
    const setDepth = (node: Draft, depth: number, seen = new Set<string>()): void => {
      if (seen.has(node.id)) return;
      seen.add(node.id);
      node.depth = depth;
      for (const childId of node.children) { const child = drafts.get(childId); if (child) setDepth(child, depth + 1, seen); }
    };
    setDepth(phaseNode, 0);
    const statesFor = (node: Draft, seen = new Set<string>()): AgentRecord["state"][] => {
      if (seen.has(node.id)) return [];
      const nextSeen = new Set(seen).add(node.id);
      return node.children.flatMap((childId) => {
        const child = drafts.get(childId);
        return child?.kind === "agent" ? [child.agent?.state ?? "queued", ...statesFor(child, nextSeen)] : child ? statesFor(child, nextSeen) : [];
      });
    };
    for (const operation of operationNodes.values()) operation.state = workflowPhaseTreeAggregateState(statesFor(operation));
  };
  for (const phase of model.phases) addPhase(phase.id, `${phase.name}${phase.occurrence > 1 ? ` #${String(phase.occurrence)}` : ""}`, phase.agents, phase);
  if (model.unassignedAgents?.length) addPhase("unassigned", "Unassigned", model.unassignedAgents);
  const nodes = [...drafts.values()].map((node) => ({ ...node, children: [...node.children] }));
  return { roots, nodes, byId: new Map(nodes.map((node) => [node.id, node])) };
}
export function workflowPhaseTreeVisibleNodes(tree: WorkflowPhaseTree, expanded: ReadonlySet<string> = new Set()): readonly WorkflowPhaseTreeNode[] {
  const visible: WorkflowPhaseTreeNode[] = [];
  const visit = (id: string): void => {
    const node = tree.byId.get(id);
    if (!node) return;
    visible.push(node);
    if (expanded.has(node.id)) for (const childId of node.children) visit(childId);
  };
  for (const root of tree.roots) visit(root);
  return visible;
}
export function workflowPhaseTreeInitialExpanded(tree: WorkflowPhaseTree): ReadonlySet<string> {
  return new Set(tree.nodes.filter((node) => node.children.length > 0).map((node) => node.id));
}
export function preserveWorkflowPhaseTreeSelection(tree: WorkflowPhaseTree, selection: WorkflowPhaseTreeSelection): WorkflowPhaseTreeSelection {
  const node = (selection.nodeId ? tree.byId.get(selection.nodeId) : undefined) ?? tree.nodes[0];
  return node ? { nodeId: node.id } : {};
}
export function navigateWorkflowPhaseTree(tree: WorkflowPhaseTree, selectedNodeId: string | undefined, expandedNodeIds: ReadonlySet<string>, direction: WorkflowPhaseTreeDirection): { nodeId?: string; expandedNodeIds: ReadonlySet<string> } {
  const expanded = new Set(expandedNodeIds);
  const current = (selectedNodeId ? tree.byId.get(selectedNodeId) : undefined) ?? tree.nodes[0];
  if (!current) return { expandedNodeIds: expanded };
  if (direction === "left") {
    if (current.children.length && expanded.delete(current.id)) return { nodeId: current.id, expandedNodeIds: expanded };
    return { nodeId: current.parentId ?? current.id, expandedNodeIds: expanded };
  }
  if (direction === "right") {
    if (current.children.length && !expanded.has(current.id)) { expanded.add(current.id); return { nodeId: current.id, expandedNodeIds: expanded }; }
    return { nodeId: current.children[0] ?? current.id, expandedNodeIds: expanded };
  }
  const visible = workflowPhaseTreeVisibleNodes(tree, expanded);
  const index = Math.max(0, visible.findIndex((node) => node.id === current.id));
  const next = visible[(index + (direction === "up" ? visible.length - 1 : 1)) % visible.length];
  return { nodeId: next?.id ?? current.id, expandedNodeIds: expanded };
}
export function preserveWorkflowPhaseSelection(model: WorkflowPhaseModel, selection: WorkflowPhaseSelection): WorkflowPhaseSelection {
  const phase = model.phases.find((candidate) => candidate.id === selection.phaseId) ?? (model.currentPhaseIndex === undefined ? undefined : model.phases[model.currentPhaseIndex]) ?? model.phases[0];
  if (!phase) return model.unassignedAgents?.length ? { nodeId: workflowPhaseTreePath("phase", "unassigned", []) } : {};
  const tree = buildWorkflowPhaseTree(model);
  const selectedAgent = selection.agentId ? phase.agents.find((candidate) => candidate.id === selection.agentId) : undefined;
  const selectedCandidate = selection.nodeId ? tree.byId.get(selection.nodeId) : undefined;
  const selected = selectedCandidate?.phaseId === phase.id ? selectedCandidate : selectedAgent ? tree.byId.get(workflowPhaseTreePath("agent", phase.id, selectedAgent.structuralPath ?? [], selectedAgent.id)) : undefined;
  const nodeId = selected?.id ?? tree.byId.get(workflowPhaseTreePath("phase", phase.id, []))?.id;
  return { phaseId: phase.id, ...(selection.agentId && phase.agents.some((agent) => agent.id === selection.agentId) ? { agentId: selection.agentId } : phase.agents[0] ? { agentId: phase.agents[0].id } : {}), ...(nodeId ? { nodeId } : {}), ...(selection.expandedNodeIds ? { expandedNodeIds: selection.expandedNodeIds } : {}) };
}
type AgentGroup = { label: string; entries: readonly { agent: AgentRecord; index: number; depth: number }[] };
function agentGroupKey(agent: AgentRecord): string { return JSON.stringify([agent.structuralPath ?? [], agent.parentBreadcrumb ?? null]); }
function agentGroupLabel(agents: readonly AgentRecord[]): string {
  const structural = agents[0]?.structuralPath ?? [];
  const breadcrumbs = [...new Set(agents.map((agent) => agent.parentBreadcrumb).filter((value): value is string => Boolean(value)))];
  return [...(structural.length ? [structural.join(" > ")] : []), ...(breadcrumbs.length === 1 ? breadcrumbs : breadcrumbs.length ? [breadcrumbs.join(" | ")] : [])].join(" > ") || "Agents";
}
function agentGroups(agents: readonly AgentRecord[], allAgents: readonly AgentRecord[] = agents): AgentGroup[] {
  const byId = new Map(allAgents.map((agent) => [agent.id, agent]));
  const groups = new Map<string, { agents: Array<{ agent: AgentRecord; index: number; depth: number }> }>();
  for (const [index, agent] of agents.entries()) {
    let depth = 0;
    const seen = new Set<string>([agent.id]);
    for (let parent = agent.parentId; parent && byId.has(parent); parent = byId.get(parent)?.parentId) { if (seen.has(parent)) break; seen.add(parent); depth += 1; }
    const key = agentGroupKey(agent);
    const group = groups.get(key) ?? { agents: [] };
    group.agents.push({ agent, index, depth });
    groups.set(key, group);
  }
  return [...groups].map(([, group]) => ({ label: agentGroupLabel(group.agents.map(({ agent }) => agent)), entries: group.agents }));
}
function renderGroupedAgents(agents: readonly AgentRecord[], render: (entry: { agent: AgentRecord; index: number; depth: number }, grouped: boolean) => string, allAgents: readonly AgentRecord[] = agents, groupLabel: (label: string) => string = (label) => label): string[] {
  const groups = agentGroups(agents, allAgents);
  const grouped = groups.length > 1 || groups.some(({ label }) => label !== "Agents");
  return groups.flatMap((group) => [
    ...(grouped ? [`  ${groupLabel(group.label)}`] : []),
    ...group.entries.map((entry) => render(entry, grouped)),
  ]);
}
const RUN_STATE_GLYPH: Record<string, string> = { completed: "✓", failed: "✗", stopped: "✗", budget_exhausted: "!", awaiting_input: "●" };
const AGENT_STATE_GLYPH: Record<string, string> = { completed: "✓", failed: "✗", cancelled: "✗" };
function runStateGlyph(state: string, running: string): string { return state === "running" ? running : RUN_STATE_GLYPH[state] ?? "◆"; }
function agentStateGlyph(state: string, running: string): string { return state === "running" ? running : AGENT_STATE_GLYPH[state] ?? "○"; }
type ProgressStyleKey = "success" | "error" | "warning" | "accent" | "muted";
const PROGRESS_STATE_STYLE: Record<string, ProgressStyleKey> = { completed: "success", failed: "error", cancelled: "error", running: "accent" };
const WORKFLOW_ICON_STYLE: Record<string, ProgressStyleKey> = { completed: "success", failed: "error", stopped: "error", budget_exhausted: "warning", running: "accent" };
const PHASE_STATE_STYLE: Record<string, ProgressStyleKey> = { completed: "success", failed: "error", cancelled: "error", running: "accent", interrupted: "warning", budget_exhausted: "warning" };
function styleForState(map: Record<string, ProgressStyleKey>, state: string, styles: WorkflowProgressStyles): (text: string) => string {
  const key = map[state] ?? "muted";
  return (text) => styles[key](text);
}
function progressStyleForState(state: string, styles: WorkflowProgressStyles): (text: string) => string { return styleForState(PROGRESS_STATE_STYLE, state, styles); }
function workflowIconStyle(state: string, styles: WorkflowProgressStyles): (text: string) => string { return styleForState(WORKFLOW_ICON_STYLE, state, styles); }
function phaseStyleForState(state: string, styles: WorkflowProgressStyles): (text: string) => string { return styleForState(PHASE_STATE_STYLE, state, styles); }
function formatWorkflowRuntime(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${String(minutes)}m${remainingSeconds ? ` ${String(remainingSeconds)}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${String(hours)}h${remainingMinutes ? ` ${String(remainingMinutes)}m` : ""}`;
}
export function formatWorkflowProgress(run: PersistedRun, spinner = "◇", styles: WorkflowProgressStyles = PLAIN_WORKFLOW_PROGRESS_STYLES, now = Date.now()): string {
  const done = run.agents.filter((agent) => SETTLED_AGENT_STATES.has(agent.state)).length;
  const workflowIcon = runStateGlyph(run.state, spinner);
  const iconStyle = workflowIconStyle(run.state, styles);
  const header = styles.bold(styles.accent(`Workflow: ${run.workflowName} (${String(done)}/${String(run.agents.length)} done)`));
  const state = progressStyleForState(run.state, styles)(`[${run.state}]`);
  const runtime = run.usage ? ` runtime=${formatWorkflowRuntime(run.usage.durationMs)}` : "";
  const lines = [`${iconStyle(workflowIcon)} ${header} ${state}${runtime}`];
  const budgetWarning = run.state === "budget_exhausted" || (run.budgetEvents ?? []).some((event) => event.type === "hard_exhausted");
  lines.push(...formatCompactBudgetStatus(run).map((line) => `  ${budgetWarning ? styles.warning(line) : line}`));
  const activeShells = run.activeShells ?? 0;
  if (activeShells > 0) lines.push(`  ${styles.accent(spinner)} shell ${styles.accent("[running]")} ${styles.dim(`(${String(activeShells)} active)`)}`);
  const byId = new Map(run.agents.map((agent) => [agent.id, agent]));
  const renderAgents = (agents: readonly AgentRecord[], offset: number, nested: boolean) => renderGroupedAgents(agents, ({ agent, index, depth }, grouped) => {
    const icon = agentStateGlyph(agent.state, spinner);
    const indent = "  ".repeat((grouped ? 2 : 1) + depth);
    const activity = SETTLED_AGENT_STATES.has(agent.state) ? "" : formatAgentActivity(agent, spinner, styles, now);
    const name = grouped ? agent.label ?? agent.name : styledAgentBreadcrumb(agent, byId, styles);
    const state = progressStyleForState(agent.state, styles);
    return `${indent}#${String(offset + index + 1)} ${state(icon)} ${name} ${state(`[${agent.state}]`)}${activity ? ` ${activity}` : ""}`;
  }, run.agents, (label) => styles.muted(label)).map((line) => nested ? `  ${line}` : line);
  const phases = run.phaseHistory?.length ? run.phaseHistory : run.phase ? [{ phase: run.phase, afterAgent: 0 }] : [];
  let renderedAgents = 0;
  let nested = false;
  for (const phase of phases) {
    const boundary = Math.max(renderedAgents, Math.min(run.agents.length, phase.afterAgent));
    lines.push(...renderAgents(run.agents.slice(renderedAgents, boundary), renderedAgents, nested));
    lines.push(`  ${styles.muted(`[Phase: ${phase.phase}]`)}`);
    renderedAgents = boundary;
    nested = true;
  }
  lines.push(...renderAgents(run.agents.slice(renderedAgents), renderedAgents, nested));
  return lines.join("\n");
}

function workflowToolUpdate(run: PersistedRun): WorkflowToolUpdate {
  return { content: [{ type: "text", text: formatWorkflowProgress(run) }], details: { runId: run.id, run } };
}

const workflowSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WORKFLOW_PROGRESS_REFRESH_MS = 1_000;

function textBlock(text: string) {
  return {
    render(width: number) {
      return text.split("\n").map((line) => line.length <= width ? line : `${line.slice(0, Math.max(0, width - 1))}…`);
    },
    invalidate() {},
  };
}
function styledTextBlock(text: string) {
  return {
    render(width: number) {
      return truncateWorkflowProgress(text, width);
    },
    invalidate() {},
  };
}
function workflowCatalogBlock(text: string, expanded: boolean) {
  return {
    render(width: number) {
      const safeWidth = Math.max(1, width);
      if (!expanded) return truncateWorkflowProgress(text, safeWidth);
      return truncateToVisualLines(text, Number.MAX_SAFE_INTEGER, safeWidth, 0).visualLines.map((line) => line.trimEnd());
    },
    invalidate() {},
  };
}

type WorkflowControlResult = { details?: unknown; content?: readonly { type: string; text?: string }[] };
function controlString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function controlValue(value: unknown): string {
  if (value === null) return "removed";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  const json = JSON.stringify(value);
  return typeof json === "string" ? json : "unknown";
}
function controlTitle(name: string, theme: Theme): string { return theme.fg("toolTitle", theme.bold(name)); }
function controlState(state: string, theme: Theme): string {
  const color = state === "completed" || state === "running" || state === "stopped" ? "success" : state === "failed" || state === "unknown" ? "error" : state === "budget_exhausted" || state === "awaiting_approval" ? "warning" : "accent";
  return theme.fg(color, state);
}
function controlAction(action: string, theme: Theme): string {
  const color = /approved|completed|stopped|started|resumed/.test(action) ? "success" : /rejected|failed/.test(action) ? "error" : "warning";
  return theme.fg(color, action);
}
function budgetPatchEntries(value: unknown): string[] {
  if (!object(value)) return value === undefined ? [] : [controlValue(value)];
  return Object.entries(value).map(([dimension, limits]) => {
    if (limits === null) return `${dimension}=removed`;
    if (!object(limits)) return `${dimension}=${controlValue(limits)}`;
    const parts = ["soft", "hard"].filter((key) => Object.prototype.hasOwnProperty.call(limits, key)).map((key) => `${key}=${controlValue(limits[key])}`);
    return `${dimension} ${parts.join(" ")}`;
  });
}
function budgetPatchSummary(value: unknown): string {
  const entries = budgetPatchEntries(value);
  return entries.length ? entries.join(", ") : "unchanged";
}
function budgetPatchDetails(value: unknown, theme: Theme): string[] {
  const entries = budgetPatchEntries(value);
  return entries.length ? [theme.fg("accent", theme.bold("Budget patch")), ...entries.map((entry) => `  ${theme.fg("toolOutput", entry)}`)] : [];
}
function workflowControlValue(result: WorkflowControlResult): unknown { return catalogResultValue(result); }
function workflowControlCall(name: string, args: Record<string, unknown>, theme: Theme): string {
  const runId = controlString(args.runId) ?? "(missing run ID)";
  if (name === "workflow_respond") {
    const proposalId = controlString(args.proposalId);
    const target = proposalId ? `budget proposal ${proposalId}` : `checkpoint ${controlString(args.name) ?? "(missing name)"}`;
    const decision = args.approved === true ? "approve" : "reject";
    return [`${controlTitle(name, theme)} ${theme.fg("accent", runId)}`, `${theme.fg("muted", target)} · ${controlAction(decision, theme)}`].join("\n");
  }
  if (name === "workflow_status") return `${controlTitle(name, theme)} ${theme.fg("accent", runId)}`;
  if (name === "workflow_resume") return args.budget === undefined ? `${controlTitle(name, theme)} ${theme.fg("accent", runId)}` : [`${controlTitle(name, theme)} ${theme.fg("accent", runId)}`, `${theme.fg("muted", "Budget")} ${theme.fg("toolOutput", budgetPatchSummary(args.budget))}`].join("\n");
  if (name === "workflow_retry") return `${controlTitle(name, theme)} ${theme.fg("accent", runId)} ${theme.fg("muted", "failed run")}`;
  return `${controlTitle(name, theme)} ${theme.fg("accent", runId)}`;
}
function workflowControlResult(name: string, args: Record<string, unknown>, result: WorkflowControlResult, expanded: boolean, theme: Theme, isError: boolean): string {
  if (isError) {
    const text = result.content?.filter(({ type }) => type === "text").map(({ text }) => text ?? "").join("\n").trim();
    return theme.fg("error", text || `The ${name} tool failed.`);
  }
  const value = workflowControlValue(result);
  if (!object(value)) return theme.fg("error", `The ${name} tool returned an invalid result.`);
  const runId = controlString(args.runId) ?? controlString(value.runId) ?? "(unknown)";
  const title = controlTitle(name, theme);
  if (name === "workflow_stop") {
    const state = controlString(value.state) ?? "unknown";
    const action = value.stopped === true ? "stopped" : value.reason === "already_terminal" ? "already terminal" : value.reason === "unknown_run" ? "run not found" : "no change";
    if (!expanded) return `${title}\nRun ${theme.fg("accent", runId)} · ${controlState(state, theme)} · ${controlAction(action, theme)}`;
    return [title, `Run: ${theme.fg("accent", runId)}`, `State: ${controlState(state, theme)}`, `Action: ${controlAction(action, theme)}`, ...(controlString(value.reason) ? [`Reason: ${theme.fg("toolOutput", controlValue(value.reason))}`] : [])].join("\n");
  }
  if (name === "workflow_status") {
    const state = controlString(value.state) ?? "unknown";
    const workflowName = controlString(value.workflowName);
    const agents = Array.isArray(value.agents) ? value.agents.length : 0;
    if (!expanded) return [title, `Run ${theme.fg("accent", runId)} · ${controlState(state, theme)}`, ...(workflowName ? [workflowName] : [])].join("\n");
    return [title, `Run: ${theme.fg("accent", runId)}`, ...(workflowName ? [`Workflow: ${theme.fg("toolOutput", workflowName)}`] : []), `State: ${controlState(state, theme)}`, `Agents: ${String(agents)}`].join("\n");
  }
  if (name === "workflow_retry") {
    const childRunId = controlString(value.runId) ?? "(unknown)";
    const state = controlString(value.state) ?? "unknown";
    const action = state === "completed" ? "completed" : "started";
    if (!expanded) return [title, `Source ${theme.fg("accent", runId)}`, `Child ${theme.fg("accent", childRunId)} · ${controlState(state, theme)} · ${controlAction(action, theme)}`].join("\n");
    return [title, `Source run: ${theme.fg("accent", runId)}`, `Retry run: ${theme.fg("accent", childRunId)}`, `State: ${controlState(state, theme)}`, `Action: ${controlAction(action === "completed" ? "completed" : "started; completed work will be replayed", theme)}`].join("\n");
  }
  if (name === "workflow_resume") {
    const state = controlString(value.state) ?? "unknown";
    const proposalId = controlString(value.proposalId);
    const action = state === "awaiting_approval" ? "approval required" : state === "running" ? "resumed" : state === "completed" ? "completed" : "no change";
    if (!expanded) return [title, `Run ${theme.fg("accent", runId)} · ${controlState(state, theme)} · ${controlAction(action, theme)}`, ...(proposalId ? [`Proposal ${theme.fg("accent", proposalId)}`] : [])].join("\n");
    return [title, `Run: ${theme.fg("accent", runId)}`, `State: ${controlState(state, theme)}`, `Action: ${controlAction(action, theme)}`, ...(proposalId ? [`Proposal: ${theme.fg("accent", proposalId)}`] : []), ...budgetPatchDetails(args.budget, theme)].join("\n");
  }
  const proposalId = controlString(args.proposalId);
  const checkpointName = controlString(args.name);
  const target = proposalId ? `Budget proposal ${theme.fg("accent", proposalId)}` : `Checkpoint ${theme.fg("accent", checkpointName ?? "(missing)")}`;
  const accepted = value.accepted === true;
  const approved = value.approved === true;
  const reason = controlString(value.reason);
  const action = reason === "proposal_not_pending" ? "not pending" : reason === "checkpoint" && !accepted ? "not pending" : approved ? "approved" : "rejected";
  const state = controlString(value.state);
  if (!expanded) return [title, target, `Run ${theme.fg("accent", runId)} · ${controlAction(action, theme)}${state ? ` · ${controlState(state, theme)}` : ""}`].join("\n");
  return [title, `Run: ${theme.fg("accent", runId)}`, `Target: ${target}`, `Action: ${controlAction(action, theme)}`, ...(state ? [`State: ${controlState(state, theme)}`] : []), ...(reason ? [`Reason: ${theme.fg("toolOutput", reason)}`] : [])].join("\n");
}

function catalogText(value: string): string { return value.replace(/\s+/g, " ").trim(); }

type CatalogToolResult = { details?: unknown; content?: readonly { type: string; text?: string }[] };

function catalogResultValue(result: CatalogToolResult): unknown {
  if (result.details !== undefined) return result.details;
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  if (!text) return undefined;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

function isCatalogIndex(value: unknown): value is WorkflowCatalogIndex {
  return object(value) && Array.isArray(value.functions);
}

function isCatalogFunction(value: unknown): value is WorkflowCatalogFunction {
  return object(value) && typeof value.name === "string" && typeof value.description === "string" && object(value.input) && object(value.output);
}

function isCatalogError(value: unknown): value is { error: { message: string } } {
  return object(value) && object(value.error) && typeof value.error.message === "string";
}

function catalogSectionTitle(label: string, count: number, theme: Theme): string {
  return theme.fg("accent", theme.bold(`${label} (${String(count)})`));
}

function catalogIndexEntries(entries: readonly { name: string; description: string }[], theme: Theme): string[] {
  const width = Math.max(0, ...entries.map((entry) => entry.name.length));
  return entries.map((entry) => `  ${theme.fg("accent", entry.name.padEnd(width))}  ${theme.fg("toolOutput", catalogText(entry.description))}`);
}

function formatCatalogIndex(catalog: WorkflowCatalogIndex, theme: Theme): string {
  const aliases = Object.prototype.propertyIsEnumerable.call(catalog, "modelAliases") ? Object.keys(catalog.modelAliases ?? {}).sort().map((name) => ({ name, kind: "static" as const, provenance: "settings" })) : catalog.modelAliasEntries ?? Object.keys(catalog.modelAliases ?? {}).sort().map((name) => ({ name, kind: "static" as const, provenance: "settings" }));
  const aliasWidth = Math.max(0, ...aliases.map(({ name }) => name.length));
  const aliasLines = aliases.map(({ name, kind, provenance }) => `  ${theme.fg("accent", name.padEnd(aliasWidth))}  ${theme.fg("toolOutput", `${kind} · ${provenance}`)}`);
  return [
    catalogSectionTitle("Functions", catalog.functions.length, theme),
    ...catalogIndexEntries(catalog.functions, theme),
    "",
    catalogSectionTitle("Model aliases", aliases.length, theme),
    ...aliasLines,
  ].join("\n");
}

function catalogSchemaLines(schema: unknown, theme: Theme): string[] {
  const json = JSON.stringify(schema, null, 2);
  return json.split("\n").map((line) => `  ${theme.fg("toolOutput", line)}`);
}

function formatCatalogDetail(value: WorkflowCatalogFunction | import("./types.js").WorkflowCatalogModelAlias, expanded: boolean, theme: Theme): string {
  if ("kind" in value) return [theme.fg("accent", theme.bold("Model alias")), `  ${theme.fg("accent", value.name)}  ${theme.fg("toolOutput", `${value.kind} · ${value.provenance}`)}`].join("\n");
  const kind = "Function";
  if (!expanded) return [theme.fg("accent", theme.bold(kind)), `  ${theme.fg("accent", value.name)}  ${theme.fg("toolOutput", catalogText(value.description))}`, `  ${theme.fg("muted", "version")}: ${theme.fg("toolOutput", value.version)}  ${theme.fg("muted", "headline")}: ${theme.fg("toolOutput", catalogText(value.headline))}`].join("\n");
  const lines = [theme.fg("accent", theme.bold(`${kind}: ${value.name}`)), `${theme.fg("muted", "description")}: ${theme.fg("toolOutput", value.description)}`, "", theme.fg("accent", theme.bold("Extension")), `  ${theme.fg("muted", "version")}: ${theme.fg("toolOutput", value.version)}`, `  ${theme.fg("muted", "headline")}: ${theme.fg("toolOutput", catalogText(value.headline))}`, `  ${theme.fg("muted", "description")}: ${theme.fg("toolOutput", value.extensionDescription)}`, "", theme.fg("accent", theme.bold("Schema")), theme.fg("muted", "Input schema"), ...catalogSchemaLines(value.input, theme), "", theme.fg("muted", "Output schema"), ...catalogSchemaLines(value.output, theme)];
  return lines.join("\n");
}

function formatWorkflowCatalog(value: unknown, expanded: boolean, theme: Theme): string {
  if (isCatalogIndex(value)) return formatCatalogIndex(value, theme);
  if (isCatalogFunction(value)) return formatCatalogDetail(value, expanded, theme);
  if (object(value) && typeof value.name === "string" && (value.kind === "static" || value.kind === "dynamic")) return formatCatalogDetail(value as unknown as import("./types.js").WorkflowCatalogModelAlias, expanded, theme);
  if (isCatalogError(value)) return theme.fg("error", value.error.message);
  return theme.fg("error", "The workflow catalog returned an invalid result.");
}

const ANSI_SGR_SOURCE = `${String.fromCharCode(27)}\\[[0-9;]*m`;
const ANSI_SGR = new RegExp(ANSI_SGR_SOURCE);
export function truncateWorkflowProgress(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  return text.split("\n").flatMap((line) => {
    if (!line) return [""];
    const visualLines = truncateToVisualLines(line, Number.MAX_SAFE_INTEGER, safeWidth, 0).visualLines;
    if (visualLines.length <= 1) return [visualLines[0]?.trimEnd() ?? ""];
    if (safeWidth === 1) return [ANSI_SGR.test(line) ? "…\u001b[0m" : "…"];
    const prefix = (truncateToVisualLines(line, Number.MAX_SAFE_INTEGER, safeWidth - 1, 0).visualLines[0] ?? "").trimEnd();
    const truncated = `${prefix}…`;
    return [ANSI_SGR.test(line) ? `${truncated}\u001b[0m` : truncated];
  });
}
function themeWorkflowProgressStyles(theme: Theme): WorkflowProgressStyles {
  return {
    accent: (text) => theme.fg("accent", text),
    success: (text) => theme.fg("success", text),
    error: (text) => theme.fg("error", text),
    warning: (text) => theme.fg("warning", text),
    muted: (text) => theme.fg("muted", text),
    dim: (text) => theme.fg("dim", text),
    bold: (text) => typeof theme.bold === "function" ? theme.bold(text) : text,
  };
}
type WorkflowProgressRefreshState = { runId: string; inputRun: PersistedRun; run: PersistedRun; lastRefreshAt: number; runtimeStartedAt: number; runtimeBaseMs: number; refresh?: Promise<void> };
function workflowProgressBlock(run: PersistedRun, theme: Theme, progress?: WorkflowProgressRefreshState, refresh?: () => Promise<PersistedRun | undefined>, invalidate?: () => void) {
  const styles = themeWorkflowProgressStyles(theme);
  const currentRun = () => {
    const displayed = progress?.run ?? run;
    if (!progress || displayed.state !== "running") return displayed;
    const durationMs = Math.max(displayed.usage?.durationMs ?? 0, progress.runtimeBaseMs + Date.now() - progress.runtimeStartedAt);
    return { ...displayed, usage: { ...budgetUsage(displayed.usage), durationMs } };
  };
  return {
    render(width: number) {
      const frame = workflowSpinner[Math.floor(Date.now() / 80) % workflowSpinner.length] ?? "◇";
      return truncateWorkflowProgress(formatWorkflowProgress(currentRun(), frame, styles), width);
    },
    invalidate() {
      const displayed = currentRun();
      if (!progress || !refresh || displayed.state !== "running" || !displayed.agents.some((agent) => agent.state === "running")) return;
      const now = Date.now();
      if (progress.refresh || now - progress.lastRefreshAt < WORKFLOW_PROGRESS_REFRESH_MS) return;
      progress.lastRefreshAt = now;
      const inputRun = progress.inputRun;
      const pending = refresh().then((next) => {
        if (next && progress.inputRun === inputRun) {
          progress.run = next;
          invalidate?.();
        }
      }).catch(() => undefined);
      progress.refresh = pending;
      void pending.finally(() => {
        if (progress.refresh === pending) delete progress.refresh;
      });
    },
  };
}
export function formatBudgetStatus(run: Pick<PersistedRun, "budget" | "budgetVersion" | "usage" | "budgetEvents">): string[] {
  const usage = budgetUsage(run.usage);
  if (!run.budget || !Object.keys(run.budget).length) return ["Budget: unlimited"];
  const lines = [`Budget version ${String(run.budgetVersion ?? 1)}`];
  for (const dimension of ["tokens", "costUsd", "durationMs", "agentLaunches"] as const) {
    const limits = run.budget[dimension];
    if (!limits || (limits.soft === undefined && limits.hard === undefined)) continue;
    const limit = limits.hard ?? limits.soft;
    const percent = limit === undefined ? "" : ` ${limit === 0 ? "100.0" : ((usage[dimension] / limit) * 100).toFixed(1)}%`;
    const state = (run.budgetEvents ?? []).filter((event) => event.dimensions.includes(dimension)).at(-1)?.type;
    lines.push(`  ${dimension}: ${String(usage[dimension])}${limits.soft !== undefined ? ` soft=${String(limits.soft)}` : ""}${limits.hard !== undefined ? ` hard=${String(limits.hard)}` : ""}${percent}${state ? ` state=${state}` : ""}`);
  }
  const events = run.budgetEvents ?? [];
  if (events.length) lines.push(`  events: ${events.map((event) => `${event.type}@v${String(event.budgetVersion)}`).join(", ")}`);
  return lines;
}

function formatCompactBudgetStatus(run: Pick<PersistedRun, "budget" | "budgetVersion" | "usage" | "budgetEvents">): string[] {
  if (!Object.values(run.budget ?? {}).some((limits) => limits.soft !== undefined || limits.hard !== undefined)) return [];
  return formatBudgetStatus(run);
}

const ATTENTION_ORDER: Record<string, number> = { awaiting_input: 0, budget_exhausted: 1, running: 2, pausing: 3, paused: 4, interrupted: 5, failed: 6, queued: 7, stopped: 8, completed: 9 };

function navigatorAttentionSort<T extends { loaded: { run: PersistedRun } }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => (ATTENTION_ORDER[a.loaded.run.state] ?? 9) - (ATTENTION_ORDER[b.loaded.run.state] ?? 9));
}

function navigatorRunLabels(entries: readonly { store: RunStore; loaded: { run: PersistedRun } }[]): string[] {
  const nameCount = new Map<string, number>();
  for (const { loaded: { run } } of entries) nameCount.set(run.workflowName, (nameCount.get(run.workflowName) ?? 0) + 1);
  return entries.map(({ store, loaded: { run } }) => {
    const done = run.agents.filter((a) => SETTLED_AGENT_STATES.has(a.state)).length;
    const glyph = runStateGlyph(run.state, "⠦");
    const suffix = (nameCount.get(run.workflowName) ?? 0) > 1 ? ` ${store.runId.slice(0, 8)}` : "";
    const cost = run.agents.reduce((sum, a) => sum + (a.accounting?.cost ?? 0), 0);
    const costStr = cost > 0 ? ` $${cost.toFixed(2)}` : "";
    const runtime = run.usage ? ` runtime=${formatWorkflowRuntime(run.usage.durationMs)}` : "";
    return `${glyph} ${run.workflowName}${suffix}  ${run.state}  ${run.phase ?? ""}  ${String(done)}/${String(run.agents.length)} agents${costStr}${runtime}`;
  });
}

export function agentBreadcrumbParts(agent: AgentRecord, byId: Map<string, AgentRecord>, includeStructuralPath = false): string[] {
  const leaf = agent.label ?? agent.name;
  const parts: string[] = includeStructuralPath && agent.structuralPath?.length ? [agent.structuralPath.join(" > ")] : [];
  if (agent.parentBreadcrumb) parts.push(agent.parentBreadcrumb);
  const ancestors: string[] = [];
  const seen = new Set<string>([agent.id]);
  for (let parentId = agent.parentId; parentId; parentId = byId.get(parentId)?.parentId) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    ancestors.push(parent.label ?? parent.name);
  }
  parts.push(...ancestors.reverse(), leaf);
  return parts;
}
export function agentBreadcrumb(agent: AgentRecord, byId: Map<string, AgentRecord>, includeStructuralPath = false): string {
  return agentBreadcrumbParts(agent, byId, includeStructuralPath).join(" > ");
}
function styledAgentBreadcrumb(agent: AgentRecord, byId: Map<string, AgentRecord>, styles: WorkflowProgressStyles): string {
  const parts = agentBreadcrumbParts(agent, byId);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${styles.muted(parts.slice(0, -1).join(" > "))} > ${styles.bold(parts[parts.length - 1] ?? "")}`;
}

export function formatStalledDuration(durationMs: number): string {
  const minutes = Math.max(0, Math.floor(durationMs / 60_000));
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${String(hours)}h${remainingMinutes ? ` ${String(remainingMinutes)}m` : ""}`;
}
function stalledDuration(agent: AgentRecord, now: number): number | undefined {
  if (agent.state !== "running" || agent.lastEventAt === undefined || !Number.isFinite(agent.lastEventAt)) return undefined;
  const duration = now - agent.lastEventAt;
  return duration >= WORKFLOW_AGENT_STALL_THRESHOLD_MS ? duration : undefined;
}
function agentDuration(agent: AgentRecord, now: number): number | undefined {
  if (agent.durationMs !== undefined && Number.isFinite(agent.durationMs)) return Math.max(0, agent.durationMs);
  if (agent.startedAt === undefined || !Number.isFinite(agent.startedAt)) return undefined;
  return Math.max(0, now - agent.startedAt);
}
function formatAgentActivity(agent: AgentRecord, spinner: string, styles: WorkflowProgressStyles = PLAIN_WORKFLOW_PROGRESS_STYLES, now = Date.now()): string {
  const label = agent.activity?.kind === "reasoning" ? "reasoning" : agent.activity?.kind === "text" ? "responding" : agent.activity?.kind === "tool" ? agent.activity.text : [...(agent.toolCalls ?? [])].reverse().find(({ state }) => state === "running")?.name ?? "";
  const activity = label ? `${styles.accent(spinner)} ${styles.dim(label)}` : "";
  const stalled = stalledDuration(agent, now);
  if (stalled === undefined) return activity;
  const warning = `stalled? ${formatStalledDuration(stalled)}`;
  return activity ? `${activity} ${styles.warning(`- ${warning}`)}` : styles.warning(warning);
}

function formatAccountingValue(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value).toLowerCase();
}

function formatAccounting(accounting: NonNullable<AgentRecord["accounting"]>): string {
  const total = accounting.input + accounting.output + accounting.cacheRead + accounting.cacheWrite;
  return `${formatAccountingValue(total)} tok`;
}

function formatAgentAccounting(accounting: NonNullable<AgentRecord["accounting"]>): string[] {
  const total = accounting.input + accounting.output + accounting.cacheRead + accounting.cacheWrite;
  return [`Tokens: ∑${formatAccountingValue(total)} ↑${formatAccountingValue(accounting.input)} ↓${formatAccountingValue(accounting.output)} ⇢${formatAccountingValue(accounting.cacheRead)} ⇠${formatAccountingValue(accounting.cacheWrite)}`, `Cost: $${accounting.cost.toFixed(2)}`];
}

export function formatNavigatorDashboard(run: PersistedRun, checkpoints: readonly AwaitingCheckpoint[], worktrees: readonly WorktreeReference[], now = Date.now()): string {
  void worktrees;
  const done = run.agents.filter((a) => SETTLED_AGENT_STATES.has(a.state)).length;
  const totalAccounting = run.agents.reduce((sum, a) => ({ input: sum.input + (a.accounting?.input ?? 0), output: sum.output + (a.accounting?.output ?? 0), cacheRead: sum.cacheRead + (a.accounting?.cacheRead ?? 0), cacheWrite: sum.cacheWrite + (a.accounting?.cacheWrite ?? 0), cost: sum.cost + (a.accounting?.cost ?? 0) }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  const hasAccounting = run.agents.some((a) => a.accounting);
  const glyph = runStateGlyph(run.state, "⠦");
  const header = `${glyph} ${run.workflowName}`;
  const runtime = run.usage ? `runtime=${formatWorkflowRuntime(run.usage.durationMs)}` : "";
  const meta = [run.state, run.phase ? `phase: ${run.phase}` : "", `${String(done)}/${String(run.agents.length)} agents`, runtime, hasAccounting ? formatAccounting(totalAccounting) : "", totalAccounting.cost > 0 ? `$${totalAccounting.cost.toFixed(2)}` : ""].filter(Boolean).join(" · ");
  const lines = [header, meta, ...formatCompactBudgetStatus(run)];
  if (run.error) lines.push(`Error: ${run.error.code}: ${run.error.message}`);
  if (run.events?.length) lines.push(...run.events.map((event) => `Warning: ${event.message}`));
  lines.push("");
  const byId = new Map(run.agents.map((a) => [a.id, a]));
  const render = ({ agent, depth }: { agent: AgentRecord; index: number; depth: number }, grouped: boolean) => {
    const icon = agentStateGlyph(agent.state, "⠦");
    const breadcrumb = grouped ? agent.label ?? agent.name : agentBreadcrumb(agent, byId);
    const tokens = agent.accounting ? formatAccounting(agent.accounting) : "";
    const indent = "  ".repeat((grouped ? 2 : 1) + depth);
    const result = [`${indent}${icon} ${breadcrumb} · ${agent.state}${tokens ? ` · ${tokens}` : ""}`];
    if (agent.state === "failed" && agent.attemptDetails?.length) {
      const last = agent.attemptDetails[agent.attemptDetails.length - 1];
      if (last?.error) result.push(`${indent}  error: ${last.error.code}: ${last.error.message}`);
    }
    const activity = !SETTLED_AGENT_STATES.has(agent.state) ? formatAgentActivity(agent, "⠦", PLAIN_WORKFLOW_PROGRESS_STYLES, now) : "";
    if (activity) result.push(`${indent}  ${activity}`);
    return result.join("\n");
  };
  lines.push(...renderGroupedAgents(run.agents, render));
  if (checkpoints.length) { lines.push(""); for (const cp of checkpoints) lines.push(`● checkpoint ${cp.name}: ${cp.prompt}`); }
  return lines.join("\n");
}

export function formatNavigatorRun(loaded: { run: PersistedRun; snapshot: Readonly<LaunchSnapshot> }, checkpoints: readonly AwaitingCheckpoint[], worktrees: readonly WorktreeReference[], now = Date.now()): string {
  const { run, snapshot } = loaded;
  const lines = [
    `Workflow: ${run.workflowName}`,
    `Run: ${run.id}`,
    `Status: ${run.state}`,
    `Phase: ${run.phase ?? "(none)"}`,
    `Launch cwd: ${run.cwd}`,
    ...formatCompactBudgetStatus(run),
    `Launch models: ${snapshot.models.join(", ") || "(none)"}`,
    `Settings: concurrency=${String(snapshot.settings.concurrency)}`,
  ];
  if (run.error) lines.push(`Run error: ${run.error.code}: ${run.error.message}`);
  if (run.events?.length) lines.push(...run.events.map((event) => `Warning: ${event.message}`));
  const aliases = snapshot.modelAliases ?? snapshot.settings.modelAliases;
  if (aliases && Object.keys(aliases).length) lines.push(`Model aliases: ${Object.entries(aliases).map(([name, target]) => `${name}=${target}`).join(", ")}`);
  if (snapshot.settingsSources) lines.push(`Settings sources: concurrency=${snapshot.settingsSources.concurrency}, modelAliases=${snapshot.settingsSources.modelAliases}, disabledAgentResources=${snapshot.settingsSources.disabledAgentResources}`);
  lines.push("Agents / ownership:");
  if (!run.agents.length) lines.push("  (none)");
  const byId = new Map(run.agents.map((agent) => [agent.id, agent]));
  lines.push(...renderGroupedAgents(run.agents, ({ agent, index, depth }, grouped) => {
    const model = `${agent.model.provider}/${agent.model.model}${agent.model.thinking ? `:${agent.model.thinking}` : ""}`;
    const role = agent.role ? ` role=${agent.role}` : "";
    const tools = ` tools=${agent.tools.join(",") || "(none)"}`;
    const accounting = agent.accounting ? ` input=${String(agent.accounting.input)} output=${String(agent.accounting.output)} cache-read=${String(agent.accounting.cacheRead)} cache-write=${String(agent.accounting.cacheWrite)} cost=${String(agent.accounting.cost)}` : "";
    const indent = "  ".repeat((grouped ? 2 : 1) + depth);
    const result = [`${indent}#${String(index + 1)} ${grouped ? agent.label ?? agent.name : agentBreadcrumb(agent, byId)} state=${agent.state} model=${model}${agent.requestedModel ? ` requested=${agent.requestedModel}` : ""}${role}${tools} attempts=${String(agent.attempts)} retries=${String(Math.max(0, agent.attempts - 1))}${accounting}`];
    for (const attempt of agent.attemptDetails ?? []) result.push(`${indent}  attempt ${String(attempt.attempt)}${attempt.error ? ` error=${attempt.error.code}: ${attempt.error.message}` : ""}`);
    for (const call of agent.toolCalls ?? []) result.push(`${indent}  tool ${call.name} state=${call.state}`);
    const activity = !SETTLED_AGENT_STATES.has(agent.state) ? formatAgentActivity(agent, "⠦", PLAIN_WORKFLOW_PROGRESS_STYLES, now) : "";
    if (activity) result.push(`${indent}  ${activity}`);
    return result.join("\n");
  }));
  lines.push("Checkpoints:");
  if (!checkpoints.length) lines.push("  (none)");
  for (const checkpoint of checkpoints) lines.push(`  ${checkpoint.name}: ${checkpoint.prompt} context=${JSON.stringify(checkpoint.context)}`);
  lines.push(`Worktrees: ${String(worktrees.length)}`);
  lines.push(`Agent sessions: ${String(run.agentSessions.length)}`);
  return lines.join("\n");
}
export function formatWorkflowPhaseDashboard(run: PersistedRun, snapshot: Readonly<LaunchSnapshot>, width: number, selection: WorkflowPhaseSelection = {}, styles: WorkflowProgressStyles = PLAIN_WORKFLOW_PROGRESS_STYLES, now = Date.now()): string[] {
  const safeWidth = Math.max(1, width);
  const model = buildWorkflowPhaseModel(run, snapshot);
  const tree = buildWorkflowPhaseTree(model);
  const expanded = selection.expandedNodeIds === undefined ? workflowPhaseTreeInitialExpanded(tree) : new Set(selection.expandedNodeIds);
  const wrap = (text: string, limit = safeWidth): string[] => truncateToVisualLines(text, Number.MAX_SAFE_INTEGER, Math.max(1, limit), 0).visualLines.map((line) => line.trimEnd());
  // ponytail: ANSI-only width, good enough for the ASCII labels the tree renders
  const ansiPattern = new RegExp(ANSI_SGR_SOURCE, "g");
  const visibleLength = (text: string): number => text.replace(ansiPattern, "").length;
  const padTo = (text: string, limit: number): string => `${text}${" ".repeat(Math.max(0, limit - visibleLength(text)))}`;
  const phaseStyle = (state: WorkflowPhaseState | AgentRecord["state"]): ((text: string) => string) => phaseStyleForState(state, styles);
  const phase = selection.phaseId ? model.phases.find((candidate) => candidate.id === selection.phaseId) : undefined;
  const selectedByAgent = selection.agentId ? tree.nodes.find((node) => node.kind === "agent" && node.agentId === selection.agentId && (!selection.phaseId || node.phaseId === selection.phaseId)) : undefined;
  const selectedNode = (selection.nodeId ? tree.byId.get(selection.nodeId) : undefined) ?? selectedByAgent ?? (phase ? tree.byId.get(workflowPhaseTreePath("phase", phase.id, [])) : undefined) ?? (model.currentPhaseId ? tree.byId.get(workflowPhaseTreePath("phase", model.currentPhaseId, [])) : undefined) ?? tree.nodes[0];
  const selectedPhase = selectedNode?.phase ?? (selectedNode ? model.phases.find((candidate) => candidate.id === selectedNode.phaseId) : undefined);
  const visibleNodes = workflowPhaseTreeVisibleNodes(tree, expanded);
  const nodeAgents = (node: WorkflowPhaseTreeNode): AgentRecord[] => {
    const agents: AgentRecord[] = [];
    const visit = (id: string): void => {
      const child = tree.byId.get(id);
      if (!child) return;
      if (child.agent) agents.push(child.agent); else for (const childId of child.children) visit(childId);
    };
    if (node.agent) agents.push(node.agent); else for (const childId of node.children) visit(childId);
    return agents;
  };
  const nodeStatus = (node: WorkflowPhaseTreeNode): string => phaseStyle(node.state)(node.state);
  const nodeIcon = (node: WorkflowPhaseTreeNode): string => node.children.length ? expanded.has(node.id) ? "▾" : "▸" : node.kind === "agent" ? "•" : " ";
  const treeLine = (node: WorkflowPhaseTreeNode): string => {
    const selected = node.id === selectedNode?.id;
    const state = progressStyleForState(node.state, styles);
    const activity = node.agent && !SETTLED_AGENT_STATES.has(node.agent.state) ? formatAgentActivity(node.agent, "⠦", styles, now) : "";
    return `${selected ? "→" : " "} ${"  ".repeat(node.depth)}${nodeIcon(node)} ${node.label} · ${state(node.state)}${activity ? ` ${activity}` : ""}`;
  };
  const details = (node: WorkflowPhaseTreeNode | undefined): string[] => {
    if (!node) return [styles.muted("No workflow node is selected")];
    const agents = nodeAgents(node);
    if (node.kind === "phase") {
      const selected = node.phase;
      const counts = selected?.counts ?? phaseAgentCounts(agents);
      return [styles.bold(`Selected phase: ${node.label}`), `Status: ${nodeStatus(node)}`, `agents completed=${String(counts.completed)} running=${String(counts.running)} failed=${String(counts.failed)} cancelled=${String(counts.cancelled)} pending=${String(counts.pending)}`, `Agents: ${String(agents.length)}`];
    }
    if (node.kind === "operation") {
      const states = phaseAgentCounts(agents);
      return [styles.bold(`Selected operation: ${node.operationPath.join(" > ")}`), `Phase: ${node.phase?.name ?? node.phaseId}`, `Status: ${nodeStatus(node)}`, `agents completed=${String(states.completed)} running=${String(states.running)} failed=${String(states.failed)} cancelled=${String(states.cancelled)} pending=${String(states.pending)}`, `Agents: ${String(agents.length)}`];
    }
    const agent = node.agent;
    if (!agent) return [styles.muted("Agent details are unavailable")];
    const duration = agentDuration(agent, now);
    const stalled = stalledDuration(agent, now);
    const result = [...(agent.activity ? [`Activity: ${agent.activity.text}`] : []), ...(stalled === undefined ? [] : [styles.warning(`stalled? ${formatStalledDuration(stalled)}`)]), `State: ${phaseStyle(agent.state)(agent.state)}`, ...(agent.structuralPath?.length ? [`Structural path: ${agent.structuralPath.join(" > ")}`] : []), `Model: ${agent.model.provider}/${agent.model.model}${agent.model.thinking ? `:${agent.model.thinking}` : ""}`, `Role: ${agent.role ?? "(none)"}`, `Tools: ${agent.tools.join(", ") || "(none)"}`, ...(agent.attempts > 1 ? [`Attempts: ${String(agent.attempts)}`] : []), ...(duration === undefined ? [] : [`Duration: ${formatWorkflowRuntime(duration)}`]), ...(agent.accounting ? formatAgentAccounting(agent.accounting) : []), ...(selection.actions ? [] : [styles.muted("enter for agent actions")])];
    const error = agent.attemptDetails?.at(-1)?.error;
    if (error) result.push(styles.error(`Error: ${error.code}: ${error.message}`));
    return result;
  };
  const stateNames: readonly WorkflowPhaseState[] = ["not started", "running", "completed", "failed", "cancelled", "interrupted", "budget_exhausted"];
  const statusSummary = stateNames.filter((state) => (model.counts[state] ?? 0) > 0).map((state) => `${String(model.counts[state])} ${state}`).join(" · ") || "0 phases";
  const lines: string[] = [styles.bold(styles.accent(`Workflow: ${run.workflowName}`))];
  if (run.error) lines.push(styles.error(`ERROR ${run.error.code}: ${run.error.message}`));
  const runtime = run.usage ? ` runtime=${formatWorkflowRuntime(run.usage.durationMs)}` : "";
  lines.push(`phase: ${run.phase ?? selectedPhase?.name ?? "none"}`, `Run state: ${run.state}${runtime}`, `Phases: ${statusSummary}`);
  for (const event of run.events ?? []) lines.push(styles.warning(`Warning: ${event.message}`));
  lines.push(...formatCompactBudgetStatus(run));
  const renderTree = (limit: number): string[] => [styles.bold("Tree"), ...(visibleNodes.length ? visibleNodes.flatMap((node) => wrap(treeLine(node), limit)) : [styles.muted("(empty)")])];
  const actionRows = (): string[] => {
    const actions = selection.actions;
    if (!actions) return [];
    return ["", styles.bold(actions.title), ...actions.options.map((option, index) => `${index === actions.index ? "→ " : "  "}${index === actions.index ? styles.accent(option) : option}`)];
  };
  const detailRows = (): string[] => [...details(selectedNode), ...actionRows()];
  if (safeWidth >= 80) {
    const sidebarWidth = Math.min(42, Math.max(24, Math.floor((safeWidth - 3) * 0.38)));
    const detailWidth = Math.max(1, safeWidth - sidebarWidth - 3);
    const sidebar = renderTree(sidebarWidth).flatMap((line) => wrap(line, sidebarWidth));
    const detail = detailRows().flatMap((line) => wrap(line, detailWidth));
    const rows = Math.max(sidebar.length, detail.length);
    for (let index = 0; index < rows; index += 1) lines.push(`${padTo(sidebar[index] ?? "", sidebarWidth)} | ${detail[index] ?? ""}`);
  } else if (selection.detailsOnly) {
    lines.push(...detailRows().flatMap((line) => wrap(line)));
  } else {
    lines.push(...renderTree(safeWidth));
    if (!selection.treeOnly) lines.push("", ...detailRows().flatMap((line) => wrap(line)));
  }
  if (model.unassignedAgents?.length && !tree.nodes.some((node) => node.phaseId === "unassigned")) lines.push(...wrap(styles.muted(`Unassigned agents: ${String(model.unassignedAgents.length)}`)));
  return lines.flatMap((line) => wrap(line));
}
function formatCheckpointReview(checkpoint: AwaitingCheckpoint): string {
  const context = JSON.stringify(checkpoint.context, null, 2);
  return [`Name: ${checkpoint.name}`, "Prompt:", checkpoint.prompt, context === "null" ? "Context: null" : "Context:", ...(context === "null" ? [] : [context])].join("\n");
}

const DELIVERY_LIMIT_BYTES = 4 * 1024;
const WORKFLOW_LOG_ENTRY = "workflow-log";
interface WorkflowLogEntry { workflowName: string; message: string }

function completionDelivery(name: string, value: JsonValue, resultPath: string, worktrees: readonly { branch: string; path: string }[]): string {
  const locations = worktrees.length ? ` Changes: ${worktrees.map(({ branch, path }) => `${branch} (${path})`).join(", ")}.` : "";
  const message = `Workflow ${name} completed: ${JSON.stringify(value)}${locations}`;
  if (Buffer.byteLength(message) <= DELIVERY_LIMIT_BYTES) return message;
  const suffix = `... Full result: ${resultPath}${locations}`;
  const suffixBytes = Buffer.byteLength(suffix);
  if (suffixBytes >= DELIVERY_LIMIT_BYTES) return utf8Prefix(suffix, DELIVERY_LIMIT_BYTES);
  return utf8Prefix(message, DELIVERY_LIMIT_BYTES - suffixBytes) + suffix;
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  let end = Math.min(bytes.length, maxBytes);
  while (end < bytes.length && end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
const DIAGNOSTIC_LIMIT_BYTES = DELIVERY_LIMIT_BYTES - 512;
function failureDiagnosticsFrom(error: unknown): WorkflowFailureDiagnostics | undefined {
  if (!error || typeof error !== "object") return undefined;
  return (error as { [WORKFLOW_FAILURE_DIAGNOSTICS]?: WorkflowFailureDiagnostics })[WORKFLOW_FAILURE_DIAGNOSTICS];
}

function boundedWorkflowFailureDiagnostics(value: WorkflowFailureDiagnostics): WorkflowFailureDiagnostics {
  let bounded: WorkflowFailureDiagnostics = {
    runId: utf8Prefix(value.runId, 128),
    workflowName: utf8Prefix(value.workflowName, 256),
    state: value.state,
    failedAt: value.failedAt === null ? null : utf8Prefix(value.failedAt, 1024),
    error: { code: value.error.code, message: utf8Prefix(value.error.message, 1024) },
    ...(value.failedAgent ? { failedAgent: {
      id: utf8Prefix(value.failedAgent.id, 128),
      ...(value.failedAgent.label ? { label: utf8Prefix(value.failedAgent.label, 128) } : {}),
      ...(value.failedAgent.role ? { role: utf8Prefix(value.failedAgent.role, 128) } : {}),
      structuralPath: value.failedAgent.structuralPath.slice(0, 8).map((part) => utf8Prefix(part, 128)),
      attempt: value.failedAgent.attempt,
      ...(value.failedAgent.transport ? { transport: utf8Prefix(value.failedAgent.transport, 128) } : {}),
      ...(value.failedAgent.session ? { session: structuredClone(value.failedAgent.session) } : {}),
    } } : {}),
    completedSiblingAgents: (value.completedSiblingAgents ?? []).slice(0, 16).map((agent) => ({
      id: utf8Prefix(agent.id, 128),
      ...(agent.label ? { label: utf8Prefix(agent.label, 128) } : {}),
      ...(agent.role ? { role: utf8Prefix(agent.role, 128) } : {}),
      structuralPath: agent.structuralPath.slice(0, 8).map((part) => utf8Prefix(part, 128)),
    })),
    completedSiblingPaths: value.completedSiblingPaths.slice(0, 16).map((path) => path.slice(0, 8).map((part) => utf8Prefix(part, 128))),
    ...(value.retry ? { retry: { sourceRunId: utf8Prefix(value.retry.sourceRunId, 128), action: utf8Prefix(value.retry.action, 256), completedPaths: value.retry.completedPaths.slice(0, 16).map((path) => utf8Prefix(path, 256)), incompletePaths: value.retry.incompletePaths.slice(0, 16).map((path) => utf8Prefix(path, 256)), namedWorktrees: value.retry.namedWorktrees.slice(0, 16).map((name) => utf8Prefix(name, 128)), warning: utf8Prefix(value.retry.warning, 512) } } : {}),
    artifacts: { runDirectory: utf8Prefix(value.artifacts.runDirectory, 1024), statePath: utf8Prefix(value.artifacts.statePath, 1024), journalPath: utf8Prefix(value.artifacts.journalPath, 1024) },
  };
  const size = () => Buffer.byteLength(JSON.stringify(bounded));
  while (size() > DIAGNOSTIC_LIMIT_BYTES) {
    if (bounded.completedSiblingAgents?.length || bounded.completedSiblingPaths.length) {
      bounded = { ...bounded, completedSiblingAgents: bounded.completedSiblingAgents?.slice(0, -1) ?? [], completedSiblingPaths: bounded.completedSiblingPaths.slice(0, -1) };
      continue;
    }
    if (bounded.retry && (bounded.retry.completedPaths.length || bounded.retry.incompletePaths.length || bounded.retry.namedWorktrees.length)) {
      const retry = { ...bounded.retry };
      if (retry.completedPaths.length) retry.completedPaths = retry.completedPaths.slice(0, -1);
      else if (retry.incompletePaths.length) retry.incompletePaths = retry.incompletePaths.slice(0, -1);
      else retry.namedWorktrees = retry.namedWorktrees.slice(0, -1);
      bounded = { ...bounded, retry };
      continue;
    }
    if (Buffer.byteLength(bounded.artifacts.runDirectory) > 256) { bounded = { ...bounded, artifacts: { ...bounded.artifacts, runDirectory: utf8Prefix(bounded.artifacts.runDirectory, 256) } }; continue; }
    if (Buffer.byteLength(bounded.error.message) > 256) { bounded = { ...bounded, error: { ...bounded.error, message: utf8Prefix(bounded.error.message, 256) } }; continue; }
    if (bounded.failedAt !== null && Buffer.byteLength(bounded.failedAt) > 256) { bounded = { ...bounded, failedAt: utf8Prefix(bounded.failedAt, 256) }; continue; }
    if (bounded.failedAgent && bounded.failedAgent.structuralPath.length > 4) { bounded = { ...bounded, failedAgent: { ...bounded.failedAgent, structuralPath: bounded.failedAgent.structuralPath.slice(0, 4) } }; continue; }
    if (bounded.failedAgent?.structuralPath.some((part) => Buffer.byteLength(part) > 64)) { bounded = { ...bounded, failedAgent: { ...bounded.failedAgent, structuralPath: bounded.failedAgent.structuralPath.map((part) => utf8Prefix(part, 64)) } }; continue; }
    if (Buffer.byteLength(bounded.artifacts.statePath) > 512 || Buffer.byteLength(bounded.artifacts.journalPath) > 512) { bounded = { ...bounded, artifacts: { ...bounded.artifacts, statePath: utf8Prefix(bounded.artifacts.statePath, 512), journalPath: utf8Prefix(bounded.artifacts.journalPath, 512) } }; continue; }
    if (Buffer.byteLength(bounded.workflowName) > 128) { bounded = { ...bounded, workflowName: utf8Prefix(bounded.workflowName, 128) }; continue; }
    break;
  }
  return bounded;
}
async function diagnosticNamedWorktrees(store: RunStore, run: PersistedRun): Promise<readonly string[]> {
  const names = new Set<string>();
  try {
    for (const name of await store.validNamedWorktrees()) names.add(name);
  } catch { /* Do not block failure delivery on an invalid worktree record. */ }
  for (const name of run.retry?.namedWorktrees ?? []) {
    try { await store.resolveNamedWorktree(name); names.add(name); } catch { /* Do not advertise stale inherited worktrees. */ }
  }
  return [...names];
}
function incompleteRetryPaths(paths: readonly string[], completedPaths: readonly string[]): string[] {
  return [...new Set(paths)].filter((path) => !completedPaths.some((completedPath) => completedPath === path || completedPath.startsWith(`${path}/`)));
}
async function createWorkflowFailureDiagnostics(store: RunStore, metadata: WorkflowMetadata, error: unknown, run: PersistedRun): Promise<WorkflowFailureDiagnostics> {
  const rawFailedAt = error && typeof error === "object" ? (error as { failedAt?: unknown }).failedAt : undefined;
  const failedAt = typeof rawFailedAt === "string" && rawFailedAt ? rawFailedAt : null;
  const failedAgents = run.agents.filter((agent) => agent.state === "failed");
  const failedAgentRecord = failedAgents.find((agent) => {
    if (failedAt === null) return false;
    try { return failedAt.includes(`${operationPath("agent", ...(agent.structuralPath ?? []))}/`); } catch { return false; }
  }) ?? failedAgents.at(-1);
  const failedAttempt = failedAgentRecord ? [...(failedAgentRecord.attemptDetails ?? [])].reverse().find((attempt) => attempt.error) ?? failedAgentRecord.attemptDetails?.at(-1) : undefined;
  const failedAgent = failedAgentRecord ? {
    id: failedAgentRecord.id,
    ...(failedAgentRecord.label ?? failedAgentRecord.name ? { label: failedAgentRecord.label ?? failedAgentRecord.name } : {}),
    ...(failedAgentRecord.role ? { role: failedAgentRecord.role } : {}),
    structuralPath: [...(failedAgentRecord.structuralPath ?? [])],
    attempt: Math.max(1, failedAttempt?.attempt ?? failedAgentRecord.attempts),
    ...(failedAttempt?.transport ? { transport: failedAttempt.transport } : {}),
    ...(failedAttempt?.session ? { session: failedAttempt.session } : {}),
  } satisfies WorkflowFailureAgent : undefined;
  const completedSiblingAgents = run.agents.filter((agent) => {
    if (agent.state !== "completed" || agent.id === failedAgentRecord?.id) return false;
    return failedAgentRecord?.parentId === undefined ? agent.parentId === undefined : agent.parentId === failedAgentRecord.parentId;
  }).map((agent) => ({
    id: agent.id,
    ...(agent.label ?? agent.name ? { label: agent.label ?? agent.name } : {}),
    ...(agent.role ? { role: agent.role } : {}),
    structuralPath: [...(agent.structuralPath ?? [])],
  } satisfies WorkflowSiblingAgent));
  const completedSiblingPaths = completedSiblingAgents.map((agent) => [...agent.structuralPath]);
  let journalCompletedPaths: readonly string[] = [];
  try { journalCompletedPaths = (await store.replayableOperations()).map(({ path }) => path); } catch { /* Preserve failure diagnostics when retry history is unavailable. */ }
  const completedPaths = run.retry ? [...new Set([...run.retry.completedPaths, ...journalCompletedPaths])] : journalCompletedPaths.length ? journalCompletedPaths : run.agents.filter((agent) => agent.state === "completed").map((agent) => operationPath("agent", ...(agent.structuralPath ?? [])));
  const namedWorktrees = await diagnosticNamedWorktrees(store, run);
  const retry = run.state === "failed" ? {
    sourceRunId: run.id,
    action: `workflow_retry({ runId: ${JSON.stringify(run.id)} })`,
    completedPaths,
    incompletePaths: incompleteRetryPaths([...(run.retry?.incompletePaths ?? []), ...(failedAt ? [failedAt] : [])], completedPaths),
    namedWorktrees,
    warning: "Retry re-executes incomplete operations; external side effects before failure are not guaranteed exactly once.",
  } : undefined;
  return boundedWorkflowFailureDiagnostics({
    runId: run.id, workflowName: metadata.name, state: run.state, failedAt,
    error: { code: errorCode(error) ?? "INTERNAL_ERROR", message: errorText(error) || "The workflow failed without an error message." },
    ...(failedAgent ? { failedAgent } : {}), completedSiblingAgents, completedSiblingPaths,
    ...(retry ? { retry } : {}),
    artifacts: { runDirectory: store.directory, statePath: join(store.directory, "state.json"), journalPath: join(store.directory, "journal.json") },
  });
}

export function formatWorkflowFailureDiagnostics(diagnostic: WorkflowFailureDiagnostics): string {
  const failedAgent = diagnostic.failedAgent ? `${diagnostic.failedAgent.label ?? diagnostic.failedAgent.id}${diagnostic.failedAgent.role ? ` role=${diagnostic.failedAgent.role}` : ""} attempt=${String(diagnostic.failedAgent.attempt)} path=${diagnostic.failedAgent.structuralPath.join(" > ") || "(root)"}${diagnostic.failedAgent.session ? ` session=${diagnostic.failedAgent.session.transport}/${diagnostic.failedAgent.session.sessionId}` : ""}` : "(not persisted)";
  const siblingAgents = diagnostic.completedSiblingAgents;
  const siblings = siblingAgents ? siblingAgents.map((agent) => `${agent.label ?? agent.id}${agent.role ? ` role=${agent.role}` : ""} path=${agent.structuralPath.join(" > ") || "(root)"}`).join(", ") || "(none)" : diagnostic.completedSiblingPaths.map((path) => path.join(" > ") || "(root)").join(", ") || "(none)";
  const retry = diagnostic.retry ? [`  Retry: ${diagnostic.retry.action}`, `  Replayable completed paths: ${diagnostic.retry.completedPaths.join(", ") || "(none)"}`, `  Incomplete paths: ${diagnostic.retry.incompletePaths.join(", ") || "(unknown)"}`, `  Named worktrees: ${diagnostic.retry.namedWorktrees.join(", ") || "(none)"}`, `  Warning: ${diagnostic.retry.warning}`] : [];
  return [`✗ Workflow: ${diagnostic.workflowName}`, `  Run: ${diagnostic.runId}`, `  State: ${diagnostic.state}`, `  Error: ${diagnostic.error.code}: ${diagnostic.error.message}`, `  Failed at: ${diagnostic.failedAt ?? "(unknown)"}`, `  Failed agent: ${failedAgent}`, `  Completed sibling ${siblingAgents ? "agents" : "paths"}: ${siblings}`, ...retry, `  Artifacts: state=${diagnostic.artifacts.statePath} journal=${diagnostic.artifacts.journalPath}`].join("\n");
}
function deliveryPart(value: string, maxBytes: number): string { return utf8Prefix(value.replace(/\s+/g, " ").trim(), maxBytes) || "(unknown)"; }
export function formatWorkflowFailureDelivery(diagnostic: WorkflowFailureDiagnostics): string {
  const name = deliveryPart(diagnostic.workflowName, 128);
  const runId = deliveryPart(diagnostic.runId, 128);
  const error = `${diagnostic.error.code}: ${deliveryPart(diagnostic.error.message, 768)}`;
  const failedPath = diagnostic.failedAt ? `; failed path=${deliveryPart(diagnostic.failedAt, 512)}` : "";
  const nextAction = diagnostic.retry ? `; next action: ${deliveryPart(diagnostic.retry.action, 256)}` : "";
  const artifacts = `; artifacts: runDirectory=${deliveryPart(diagnostic.artifacts.runDirectory, 512)} statePath=${deliveryPart(diagnostic.artifacts.statePath, 512)} journalPath=${deliveryPart(diagnostic.artifacts.journalPath, 512)}`;
  const line = `Workflow ${name} failed (runId=${runId}): error=${error}${failedPath}${nextAction}${artifacts}`;
  return Buffer.byteLength(line) <= DELIVERY_LIMIT_BYTES ? line : utf8Prefix(line, DELIVERY_LIMIT_BYTES);
}
function formatWorkflowFailureDeliveryFallback(workflowName: string, runId: string, runDirectory: string, error: unknown): string {
  const code = errorCode(error) ?? "INTERNAL_ERROR";
  const failedPath = workflowFailedAt(error);
  const nextAction = code === "BUDGET_EXHAUSTED" || code === "CANCELLED" ? "" : `; next action: workflow_retry({ runId: ${JSON.stringify(runId)} })`;
  const line = `Workflow ${deliveryPart(workflowName, 128)} failed (runId=${deliveryPart(runId, 128)}): error=${code}: ${deliveryPart(formatWorkflowFailure(error), 768)}${failedPath ? `; failed path=${deliveryPart(failedPath, 512)}` : ""}${nextAction}; artifacts: runDirectory=${deliveryPart(runDirectory, 512)} statePath=${deliveryPart(join(runDirectory, "state.json"), 512)} journalPath=${deliveryPart(join(runDirectory, "journal.json"), 512)}`;
  return Buffer.byteLength(line) <= DELIVERY_LIMIT_BYTES ? line : utf8Prefix(line, DELIVERY_LIMIT_BYTES);
}

function serializeWorkflowFailureDiagnostics(diagnostic: WorkflowFailureDiagnostics): string { return JSON.stringify(diagnostic); }
function isWorkflowFailureDiagnostics(value: unknown): value is WorkflowFailureDiagnostics {
  return object(value) && typeof value.runId === "string" && typeof value.workflowName === "string" && typeof value.state === "string" && "failedAt" in value && object(value.error) && object(value.artifacts);
}
function deliver(pi: ExtensionAPI, content: string): void {
  if (typeof pi.sendMessage !== "function") return;
  pi.sendMessage({ customType: "workflow", content, display: true }, { deliverAs: "followUp", triggerTurn: true });
}

type WorkflowEventSink = { emit: (name: string, payload: unknown) => unknown };

function safeEventError(error: unknown): WorkflowErrorShape {
  const code = errorCode(error) ?? "INTERNAL_ERROR";
  return { code, message: `Workflow execution failed (${code})` };
}

class WorkflowEventPublisher {
  #queues = new Map<string, Promise<void>>();
  #budgetEvents = new Map<string, Set<string>>();
  #worktrees = new Map<string, Set<string>>();

  constructor(private readonly sink: WorkflowEventSink | undefined) {}

  removeRun(runId: string): void {
    this.#queues.delete(runId);
    this.#budgetEvents.delete(runId);
    this.#worktrees.delete(runId);
  }

  seedBudget(runId: string, events: readonly BudgetEvent[] | undefined): void {
    const seen = this.#budgetEvents.get(runId) ?? new Set<string>();
    for (const event of events ?? []) seen.add(this.budgetKey(event));
    this.#budgetEvents.set(runId, seen);
  }

  async runStarted(store: RunStore, metadata: WorkflowMetadata): Promise<void> { await this.#publish(store, metadata, WORKFLOW_RUN_STARTED_EVENT, {}); }
  async runResumed(store: RunStore, metadata: WorkflowMetadata): Promise<void> { await this.#publish(store, metadata, WORKFLOW_RUN_RESUMED_EVENT, {}); }

  async runState(store: RunStore, metadata: WorkflowMetadata, previousState: RunState, state: RunState, reason?: string): Promise<void> {
    await this.#publish(store, metadata, WORKFLOW_RUN_STATE_CHANGED_EVENT, { previousState, state, ...(reason ? { reason } : {}), ...(ERROR_CODES.includes(reason as WorkflowErrorCode) ? { errorCode: reason } : {}) });
    if ((previousState === "paused" || previousState === "interrupted" || previousState === "budget_exhausted") && state === "running") await this.runResumed(store, metadata);
  }

  async runCompleted(store: RunStore, metadata: WorkflowMetadata, resultPath: string): Promise<void> { await this.#publish(store, metadata, WORKFLOW_RUN_COMPLETED_EVENT, { resultPath }); }
  async runFailed(store: RunStore, metadata: WorkflowMetadata, error: unknown, state: "failed" | "stopped" | "interrupted" | "budget_exhausted"): Promise<void> {
    if (state === "failed") await this.#publish(store, metadata, WORKFLOW_RUN_FAILED_EVENT, { error: safeEventError(error) });
  }

  async agentState(store: RunStore, metadata: WorkflowMetadata, previous: AgentRecord | undefined, agent: AgentRecord): Promise<void> {
    await this.#publish(store, metadata, WORKFLOW_AGENT_STATE_CHANGED_EVENT, { agentId: agent.id, displayLabel: agent.label ?? agent.name, ...(agent.role ? { role: agent.role } : {}), structuralPath: [...(agent.structuralPath ?? [])], ...(agent.parentId ? { parentId: agent.parentId } : {}), ...(agent.parentBreadcrumb ? { parentBreadcrumb: agent.parentBreadcrumb } : {}), ...(agent.worktreeOwner ? { worktreeOwner: agent.worktreeOwner } : {}), ...(previous ? { previousState: previous.state } : {}), state: agent.state, attempt: agent.attempts });
  }

  async agentStates(store: RunStore, metadata: WorkflowMetadata, previous: readonly AgentRecord[], current: readonly AgentRecord[]): Promise<void> {
    const previousById = new Map(previous.map((agent) => [agent.id, agent]));
    for (const agent of current) {
      const old = previousById.get(agent.id);
      if (!old || old.state !== agent.state || old.attempts !== agent.attempts) await this.agentState(store, metadata, old, agent);
    }
  }

  async phase(store: RunStore, metadata: WorkflowMetadata, previousPhase: string | undefined, phase: string): Promise<void> {
    if (previousPhase !== phase) await this.#publish(store, metadata, WORKFLOW_PHASE_CHANGED_EVENT, { ...(previousPhase !== undefined ? { previousPhase } : {}), phase });
  }

  async checkpoint(store: RunStore, metadata: WorkflowMetadata, name: string, state: WorkflowCheckpointState): Promise<void> { await this.#publish(store, metadata, WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, { name, state }); }

  async budget(store: RunStore, metadata: WorkflowMetadata, run: Pick<PersistedRun, "budgetEvents">): Promise<void> {
    const seen = this.#budgetEvents.get(store.runId) ?? new Set<string>();
    this.#budgetEvents.set(store.runId, seen);
    for (const event of run.budgetEvents ?? []) {
      const key = this.budgetKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      await this.#publish(store, metadata, WORKFLOW_BUDGET_EVENT, { ...event, timestamp: event.at });
    }
  }

  async worktree(store: RunStore, metadata: WorkflowMetadata, worktree: WorktreeReference): Promise<void> {
    const seen = this.#worktrees.get(store.runId) ?? new Set<string>();
    this.#worktrees.set(store.runId, seen);
    if (seen.has(worktree.owner)) return;
    seen.add(worktree.owner);
    await this.#publish(store, metadata, WORKFLOW_WORKTREE_CREATED_EVENT, { owner: worktree.owner, branch: worktree.branch, path: worktree.path, base: worktree.base });
  }

  async #publish(store: RunStore, metadata: WorkflowMetadata, name: string, payload: Record<string, unknown>): Promise<void> {
    const base: WorkflowEventBase = { runId: store.runId, sessionId: store.sessionId, workflowName: metadata.name, cwd: store.cwd, runDirectory: store.directory, timestamp: Date.now() };
    const previous = this.#queues.get(store.runId) ?? Promise.resolve();
    const next = previous.then(() => {
      try { void Promise.resolve(this.sink?.emit(name, { ...base, ...payload })).catch(() => undefined); } catch { /* Best effort: listeners cannot affect a run. */ }
    });
    this.#queues.set(store.runId, next.catch(() => undefined));
    await next;
  }

  private budgetKey(event: BudgetEvent): string { return `${String(event.budgetVersion)}:${event.type}:${event.proposalId ?? ""}`; }
}

const inheritedHostAgentPath = new AsyncLocalStorage<readonly string[]>();
const inheritedHostWorktreeOwner = new AsyncLocalStorage<string>();


function namedRecord(value: unknown, kind: string): Array<[string, unknown]> {
  if (!object(value)) fail("INVALID_METADATA", `${kind} must be a record`);
  return Object.entries(value);
}
function publicWorktreeReference(reference: WorkflowWorktreeReference): Readonly<WorkflowWorktreeReference> {
  if (!object(reference) || typeof reference.path !== "string" || typeof reference.branch !== "string") fail("WORKTREE_FAILED", "Worktree reference is invalid");
  return Object.freeze({ path: reference.path, branch: reference.branch });
}
async function hostWithWorktree(args: readonly unknown[], resolveWorktree: ((owner: string, signal: AbortSignal) => Promise<Readonly<WorkflowWorktreeReference>>) | undefined, signal: AbortSignal): Promise<JsonValue> {
  if (args.length !== 2) fail("INVALID_METADATA", "withWorktree requires a name and callback");
  const name = args[0];
  const callback = args[1];
  if (typeof name !== "string" || !name.trim()) fail("INVALID_METADATA", "withWorktree name must be a non-empty string");
  if (typeof callback !== "function") fail("INVALID_METADATA", "withWorktree callback must be a function");
  if (!resolveWorktree) fail("WORKTREE_FAILED", "No worktree bridge is available");
  const owner = operationPath("worktree", "named", name.trim());
  const reference = publicWorktreeReference(await resolveWorktree(owner, signal));
  return inheritedHostWorktreeOwner.run(owner, async () => await (callback as (reference: Readonly<WorkflowWorktreeReference>) => unknown)(reference)) as Promise<JsonValue>;
}
function workflowRunContext(cwd: string, sessionId: string, runId: string, workflow: WorkflowMetadata, args: JsonValue, signal: AbortSignal): Readonly<WorkflowRunContext> {
  return Object.freeze({ cwd, sessionId, runId, workflow: deepFreeze(structuredClone(workflow)), args: deepFreeze(structuredClone(args)), signal });
}

async function hostParallel(rawOperation: unknown, rawTasks: unknown): Promise<JsonValue> {
  if (typeof rawOperation !== "string" || !rawOperation.trim()) fail("INVALID_METADATA", "parallel requires a stable explicit name");
  const tasks = namedRecord(rawTasks, "parallel tasks");
  for (const [name, run] of tasks) {
    if (!name.trim()) fail("INVALID_METADATA", "parallel task requires a stable explicit name");
    if (typeof run !== "function") fail("INVALID_METADATA", "parallel task values must be run functions");
  }
  const results = await Promise.all(tasks.map(async ([name, run]) => {
    try {
      const parent = inheritedHostAgentPath.getStore() ?? [];
      return { name, value: await inheritedHostAgentPath.run([...parent, rawOperation, name], run as () => unknown) as JsonValue };
    } catch (error) {
      const typed = error instanceof WorkflowError ? error : new WorkflowError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
      if (typed.code === "CANCELLED") throw typed;
      return { name, error: typed };
    }
  }));
  const failure = results.find((result) => result.error);
  if (failure?.error) throw failure.error;
  return Object.fromEntries(results.map((result) => [result.name, result.value as JsonValue]));
}

async function hostPipeline(rawOperation: unknown, rawItems: unknown, rawStages: unknown): Promise<JsonValue> {
  if (typeof rawOperation !== "string" || !rawOperation.trim()) fail("INVALID_METADATA", "pipeline requires a stable explicit name");
  const items = namedRecord(rawItems, "pipeline items");
  const stages = namedRecord(rawStages, "pipeline stages");
  if (!stages.length) fail("INVALID_METADATA", "pipeline requires at least one stage");
  for (const [name] of items) if (!name.trim()) fail("INVALID_METADATA", "pipeline item requires a stable explicit name");
  for (const [stageName, run] of stages) {
    if (!stageName.trim()) fail("INVALID_METADATA", "pipeline stage requires a stable explicit name");
    if (typeof run !== "function") fail("INVALID_METADATA", "pipeline stage values must be run functions");
  }
  const results = await Promise.all(items.map(async ([name, initial]) => {
    let current = initial;
    try {
      for (const [stageName, run] of stages) {
        const parent = inheritedHostAgentPath.getStore() ?? [];
        current = await inheritedHostAgentPath.run([...parent, rawOperation, name, stageName], () => (run as (value: unknown) => unknown)(current));
      }
      return { name, value: current as JsonValue };
    } catch (error) {
      const typed = error instanceof WorkflowError ? error : new WorkflowError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
      if (typed.code === "CANCELLED") throw typed;
      return { name, error: typed };
    }
  }));
  const failure = results.find((result) => result.error);
  if (failure?.error) throw failure.error;
  return Object.fromEntries(results.map((result) => [result.name, result.value as JsonValue]));
}

function nextNamedOccurrence(counters: Map<string, number>, label: string): string {
  const count = (counters.get(label) ?? 0) + 1;
  counters.set(label, count);
  return count === 1 ? label : `${label}#${String(count)}`;
}

function withWorkflowFunctions(bridge: WorkflowBridge, store: RunStore, runContext: Readonly<WorkflowRunContext>, registry: WorkflowRegistryApi): WorkflowBridge {
  const functionAgentOccurrences = new Map<string, number>();
  const functionShellOccurrences = new Map<string, number>();
  const functionInvokeOccurrences = new Map<string, number>();
  const invokeFunction = async (name: string, input: Readonly<Record<string, JsonValue>>, path: string, signal: AbortSignal, worktreeOwner?: string, structuralPath: readonly string[] = [], breadcrumb?: string): Promise<JsonValue> => {
    const replayed = await store.replay(path);
    let stored: JsonValue | undefined;
    const sideEffects: Promise<void>[] = [];
    const functionBreadcrumb = breadcrumb ?? name;
    const context: WorkflowFunctionContext = {
      run: runContext,
      invoke: async (targetName, targetInput) => {
        const inherited = inheritedHostAgentPath.getStore() ?? structuralPath;
        const scopedWorktreeOwner = inheritedHostWorktreeOwner.getStore() ?? worktreeOwner;
        const key = JSON.stringify([path, inherited, targetName]);
        const occurrence = (functionInvokeOccurrences.get(key) ?? 0) + 1;
        functionInvokeOccurrences.set(key, occurrence);
        const nestedPath = operationPath("function", "nested", path, ...inherited, targetName, `occurrence:${String(occurrence)}`);
        return invokeFunction(targetName, targetInput, nestedPath, signal, scopedWorktreeOwner, inherited, `${functionBreadcrumb} > ${targetName}`);
      },
      agent: async (prompt: string, options: Readonly<AgentOptions> = {}) => {
        if (!bridge.agent || typeof prompt !== "string") fail("AGENT_FAILED", "No agent bridge is available");
        const validatedOptions = validateAgentOptions(options);
        const scopedWorktreeOwner = inheritedHostWorktreeOwner.getStore() ?? worktreeOwner;
        const inherited = inheritedHostAgentPath.getStore() ?? [];
        const key = `${path}\0${JSON.stringify(inherited)}`;
        const occurrence = (functionAgentOccurrences.get(key) ?? 0) + 1;
        functionAgentOccurrences.set(key, occurrence);
        return bridge.agent(prompt, validatedOptions, signal, { structuralPath: [...inherited], callSite: `function:${path}`, occurrence, parentBreadcrumb: functionBreadcrumb, ...(scopedWorktreeOwner ? { worktreeOwner: scopedWorktreeOwner } : {}) });
      },
      shell: async (...args: readonly unknown[]) => {
        if (!bridge.shell) fail("SHELL_FAILED", "No shell bridge is available");
        if (typeof args[0] !== "string") fail("INVALID_METADATA", "shell command must be a string");
        const options = validateShellOptions(args[1] === undefined ? {} : args[1]);
        const scopedWorktreeOwner = inheritedHostWorktreeOwner.getStore() ?? worktreeOwner;
        const inherited = inheritedHostAgentPath.getStore() ?? [];
        const key = `${path}\0${JSON.stringify([inherited, scopedWorktreeOwner ?? null])}`;
        const occurrence = (functionShellOccurrences.get(key) ?? 0) + 1;
        functionShellOccurrences.set(key, occurrence);
        return bridge.shell(args[0], options, signal, { structuralPath: [...inherited], callSite: `function:${path}`, occurrence, ...(scopedWorktreeOwner ? { worktreeOwner: scopedWorktreeOwner } : {}) });
      },
      prompt: workflowPrompt,
      parallel: (...args: readonly unknown[]) => hostParallel(args[0], args[1]),
      pipeline: (...args: readonly unknown[]) => hostPipeline(args[0], args[1], args[2]),
      withWorktree: (...args: readonly unknown[]) => hostWithWorktree(args, bridge.worktree, signal),
      checkpoint: async (...args: readonly unknown[]) => {
        if (!bridge.checkpoint || !object(args[0]) || !jsonValue(args[0])) fail("INTERNAL_ERROR", "No checkpoint bridge is available");
        return bridge.checkpoint(args[0], signal);
      },
      phase: (name: string) => { sideEffects.push(Promise.resolve(bridge.phase?.(name))); },
      log: (message: string) => { sideEffects.push(Promise.resolve(bridge.log?.(message))); },
    };
    const result = await inheritedHostAgentPath.run([...structuralPath], async () => registry.invokeFunction(name, input, context, path, { get: () => replayed?.value, put: (_path, value) => { stored = value; } }));
    await Promise.all(sideEffects);
    if (!replayed) await store.complete(path, stored ?? result);
    return result;
  };
  return { ...bridge, functions: registry.globals(), function: invokeFunction };
}

function projectTrusted(ctx: unknown): boolean {
  const check = object(ctx) ? ctx.isProjectTrusted : undefined;
  return typeof check === "function" ? Boolean(Reflect.apply(check, ctx, [])) : true;
}
function asFn(value: unknown): ((...args: never[]) => unknown) | undefined { return typeof value === "function" ? value as (...args: never[]) => unknown : undefined; }
type PiHostCapabilities = { registerEntryRenderer?: ExtensionAPI["registerEntryRenderer"]; events?: WorkflowEventSink };
function isWorkflowEventSink(value: unknown): value is WorkflowEventSink { return object(value) && typeof value.emit === "function"; }
function piHostCapabilities(pi: unknown): PiHostCapabilities {
  if (!object(pi)) return {};
  const registerEntryRenderer = asFn(pi.registerEntryRenderer) as NonNullable<PiHostCapabilities["registerEntryRenderer"]> | undefined;
  const events = pi.events;
  return { ...(registerEntryRenderer ? { registerEntryRenderer } : {}), ...(isWorkflowEventSink(events) ? { events } : {}) };
}
type ContextHostCapabilities = { modelRegistry?: ModelRegistryCapability };
type ModelRegistryGetter = () => readonly Model<Api>[];
type ModelRegistryCapability = { getAll?: ModelRegistryGetter; getAvailable?: ModelRegistryGetter; find?: (provider: string, model: string) => Model<Api> | undefined; refresh?: () => Promise<void>; getError?: () => string | undefined };
function contextHostCapabilities(ctx: unknown): ContextHostCapabilities {
  if (!object(ctx) || !object(ctx.modelRegistry)) return {};
  const registry = ctx.modelRegistry;
  const getAll = asFn(registry.getAll) as ModelRegistryGetter | undefined;
  const getAvailable = asFn(registry.getAvailable) as ModelRegistryGetter | undefined;
  const find = asFn(registry.find) as ModelRegistryCapability["find"];
  const refresh = asFn(registry.refresh) as ModelRegistryCapability["refresh"];
  const getError = asFn(registry.getError) as ModelRegistryCapability["getError"];
  return { modelRegistry: { ...(getAll ? { getAll: () => getAll.call(registry) } : {}), ...(getAvailable ? { getAvailable: () => getAvailable.call(registry) } : {}), ...(find ? { find: (provider, model) => find.call(registry, provider, model) } : {}), ...(refresh ? { refresh: () => refresh.call(registry) } : {}), ...(getError ? { getError: () => getError.call(registry) } : {}) } };
}
function modelInventory(root: ModelSpec | undefined, registry: ModelRegistryCapability | undefined): { knownModels: ReadonlySet<string>; availableModels: ReadonlySet<string> } {
  const all = registry?.getAll?.() ?? registry?.getAvailable?.() ?? [];
  const available = registry?.getAvailable?.() ?? registry?.getAll?.() ?? [];
  const knownModels = new Set(all.map((model) => `${model.provider}/${model.id}`));
  const availableModels = new Set(available.map((model) => `${model.provider}/${model.id}`));
  const rootName = root?.provider && root.model ? `${root.provider}/${root.model}` : undefined;
  if (rootName) { knownModels.add(rootName); availableModels.add(rootName); }
  return { knownModels, availableModels };
}
function resumeHostContext(ctx: unknown): { model: { provider: string; id: string } | undefined; modelRegistry: ModelRegistryCapability | undefined } {
  const model = object(ctx) && object(ctx.model) && typeof ctx.model.provider === "string" && typeof ctx.model.id === "string" ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
  return { model, modelRegistry: contextHostCapabilities(ctx).modelRegistry };
}
async function resolveLaunchAliases(registry: WorkflowRegistryApi, staticAliases: Readonly<Record<string, string>>, context: Readonly<WorkflowModelAliasResolverContext>, availableModels: ReadonlySet<string>, knownModels: ReadonlySet<string>, settingsPath: string): Promise<{ aliases: Readonly<Record<string, string>>; dynamicNames: readonly string[] }> {
  const dynamic = typeof registry.resolveModelAliases === "function" ? await registry.resolveModelAliases(context, new Set(Object.keys(staticAliases))) : {};
  const dynamicNames = Object.keys(dynamic);
  try {
    const aliases = validateModelAliases({ ...dynamic, ...staticAliases }, settingsPath);
    validateModelAliasAvailability(aliases, dynamicNames, availableModels, knownModels, settingsPath);
    return { aliases, dynamicNames };
  } catch (error) {
    const name = modelAliasErrorName(error);
    const descriptor = name && typeof registry.modelAliases === "function" ? registry.modelAliases().find((candidate) => candidate.name === name) : undefined;
    if (descriptor && errorCode(error) !== "CANCELLED") throw new WorkflowError(errorCode(error) ?? "CONFIG_ERROR", `${errorText(error)} (extension: ${descriptor.headline})`);
    throw error;
  }
}
type UiSelect = (title: string, options: string[]) => Promise<string | undefined>;
type UiInput = (title: string, placeholder?: string) => Promise<string | undefined>;
type UiSetStatus = (key: string, text?: string) => void;
type UiHostCapabilities = { select?: UiSelect; input?: UiInput; setStatus?: UiSetStatus; custom?: ExtensionUIContext["custom"] };
function uiHostCapabilities(ui: unknown): UiHostCapabilities | undefined {
  if (!object(ui)) return undefined;
  const select = asFn(ui.select) as UiSelect | undefined;
  const input = asFn(ui.input) as UiInput | undefined;
  const setStatus = asFn(ui.setStatus) as UiSetStatus | undefined;
  const custom = asFn(ui.custom) as ExtensionUIContext["custom"] | undefined;
  return { ...(select ? { select } : {}), ...(input ? { input } : {}), ...(setStatus ? { setStatus } : {}), ...(custom ? { custom } : {}) };
}
function tuiRows(tui: unknown): number {
  const rows = object(tui) && object(tui.terminal) ? tui.terminal.rows : undefined;
  return typeof rows === "number" && Number.isFinite(rows) ? rows : 24;
}
const WORKFLOW_PANEL_FOOTER_ROWS = 2;
const WORKFLOW_OVERLAY_BORDER_ROWS = 2;
const WORKFLOW_OVERLAY_TOP_MARGIN = 1;
const WORKFLOW_OVERLAY_OPTIONS = { anchor: "top-left", width: "100%", maxHeight: "100%", margin: { top: WORKFLOW_OVERLAY_TOP_MARGIN } } as const;
type WorkflowOverlayComponent = { render(width: number): string[]; invalidate(): void; handleInput?(data: string): void; dispose?(): void };
function borderWorkflowOverlay(component: WorkflowOverlayComponent, theme: { fg(color: "border", text: string): string }): WorkflowOverlayComponent {
  return {
    ...component,
    render(width: number) {
      const border = theme.fg("border", "─".repeat(Math.max(1, width)));
      return [border, ...component.render(width), border];
    },
  };
}
type KeybindingsHostCapabilities = { getKeys?: (name: string) => readonly string[] };
function keybindingKeys(keybindings: unknown, name: string): readonly string[] | undefined {
  const getKeys = object(keybindings) ? asFn(keybindings.getKeys) as NonNullable<KeybindingsHostCapabilities["getKeys"]> | undefined : undefined;
  return getKeys ? getKeys.call(keybindings, name) : undefined;
}
type WorkflowKeybindings = { matches(data: string, binding: string): boolean };
const WORKFLOW_VIM_KEYS: Readonly<Record<string, string>> = { "tui.select.up": "k", "tui.select.down": "j", "tui.editor.cursorLeft": "h", "tui.editor.cursorRight": "l" };
function workflowKeyMatches(keybindings: WorkflowKeybindings, data: string, binding: string): boolean { return keybindings.matches(data, binding) || WORKFLOW_VIM_KEYS[binding] === data; }
function workflowKeyLabel(keybindings: unknown, binding: string, fallback: string, labels: Readonly<Record<string, string>>): string {
  const keys = keybindingKeys(keybindings, binding);
  const configured = keys?.length ? keys.map((key) => labels[key] ?? key) : [fallback];
  const vim = WORKFLOW_VIM_KEYS[binding];
  return [...new Set(vim ? [...configured, vim] : configured)].join("/");
}

export default function workflowExtension(pi: ExtensionAPI, home?: string, clipboard = copyToClipboard, transport: AgentTransport = localAgentTransport, agentDir?: string, additionalSkillPaths: readonly string[] = []) {
  beginWorkflowExtensionLoading();
  const registry = loadingRegistry();
  const extensionAgentDir = agentDir ?? getAgentDir();
  const registerEntryRenderer = piHostCapabilities(pi).registerEntryRenderer;
  registerEntryRenderer?.<WorkflowLogEntry>(WORKFLOW_LOG_ENTRY, (entry) => {
    const data = entry.data;
    return textBlock(data ? `Workflow ${data.workflowName}: ${data.message}` : "");
  });
  const logBridge = (lifecycle: RunLifecycle, workflowName: string) => async (message: string) => {
    await lifecycle.enter();
    try { pi.appendEntry<WorkflowLogEntry>(WORKFLOW_LOG_ENTRY, { workflowName, message: utf8Prefix(message, DELIVERY_LIMIT_BYTES) }); }
    finally { await lifecycle.leave(); }
  };
  const eventPublisher = new WorkflowEventPublisher(piHostCapabilities(pi).events);
  pi.on("resources_discover", () => {
    if (!pi.getActiveTools().includes("workflow")) return;
    const extensionDir = dirname(fileURLToPath(import.meta.url));
    const skillPath = [join(extensionDir, "../skills"), join(extensionDir, "../../skills")].find((path) => existsSync(path));
    return skillPath ? { skillPaths: [skillPath] } : undefined;
  });
  type BudgetDecisionResult = { state: "running" | "completed" | "budget_exhausted"; approved: boolean; value?: JsonValue; run?: PersistedRun };
  const runs = new Map<string, { executor: WorkflowAgentExecutor; store: RunStore; metadata: WorkflowMetadata; model: ModelSpec; lifecycle: RunLifecycle; budget: WorkflowBudgetRuntime; abortController: AbortController; projectTrusted: () => boolean; providerErrorRecovery?: (failure: AgentProviderFailure) => Promise<AgentProviderRecovery>; execution?: WorkflowExecution; completion?: Promise<unknown>; checkpointResolvers: Map<string, (value: boolean) => void>; update?: (result: WorkflowToolUpdate) => void }>();
  let providerRecoveryQueue = Promise.resolve();
  const enqueueProviderRecovery = <T>(task: () => Promise<T>): Promise<T> => { const next = providerRecoveryQueue.then(task, task); providerRecoveryQueue = next.then(() => undefined, () => undefined); return next; };
  const createProviderErrorRecovery = (host: unknown, fallbackModels: ReadonlySet<string>, abort: () => void) => {
    if (!object(host) || host.mode !== "tui" || host.hasUI !== true) return undefined;
    const ui = object(host.ui) ? host.ui : undefined;
    const uiCapabilities = uiHostCapabilities(ui);
    const select = uiCapabilities?.select;
    if (!select) return undefined;
    const hostModels = contextHostCapabilities(host).modelRegistry;
    const choose = (title: string, options: string[]) => select.call(ui, title, options);
    const chooseModel = async (failure: AgentProviderFailure): Promise<string | undefined> => {
      const custom = uiCapabilities.custom;
      const getAvailable = hostModels?.getAvailable;
      if (!custom || !getAvailable) {
        const available = getAvailable ? getAvailable().map((model) => `${model.provider}/${model.id}`) : [...fallbackModels];
        return choose(`Available models for subagent "${failure.label}"`, [...new Set(available)].sort());
      }
      const available = getAvailable();
      const current = hostModels.find?.(failure.provider, failure.model) ?? available.find((model) => model.provider === failure.provider && model.id === failure.model);
      const runtime = {
        getAvailableSnapshot: getAvailable,
        refresh: async ({ signal }: { signal?: AbortSignal } = {}) => {
          if (signal?.aborted) return { aborted: true, errors: new Map() };
          try { await hostModels.refresh?.(); return { aborted: false, errors: new Map() }; }
          catch (error) { return { aborted: false, errors: new Map([["models", error]]) }; }
        },
        getModel: (provider: string, model: string) => hostModels.find?.(provider, model) ?? getAvailable().find((candidate) => candidate.provider === provider && candidate.id === model),
        getError: () => hostModels.getError?.(),
      } as unknown as ModelRuntime;
      const settings = { setDefaultModelAndProvider() {} } as unknown as SettingsManager;
      return await custom.call(ui, (tui, _theme, _keybindings, done) => new ModelSelectorComponent(tui, current, settings, runtime, [], (model) => { done(`${model.provider}/${model.id}`); }, () => { done(undefined); })) as string | undefined;
    };
    return (failure: AgentProviderFailure): Promise<AgentProviderRecovery> => enqueueProviderRecovery(async () => {
      for (;;) {
        const action = await choose(`Subagent "${failure.label}" failed\nCurrent provider/model: ${failure.provider}/${failure.model}\nProvider error: ${failure.error}\nChoose what to do`, ["Retry", "Change model", "Abort workflow"]);
        if (action === "Retry") return "retry";
        if (action === "Change model") {
          const selected = await chooseModel(failure);
          if (selected) return { model: selected };
          continue;
        }
        abort();
        return "abort";
      }
    });
  };
  const pendingFailureDiagnostics = new Map<string, WorkflowFailureDiagnostics>();
  const foregroundDeliveries = new Map<string, { store: RunStore; inline: boolean; timer?: ReturnType<typeof setTimeout> }>();
  const terminalDeliveryQueues = new WeakMap<RunStore, Promise<void>>();
  const liveActivities = new Map<string, Map<string, AgentActivity>>();
  const liveEventTimes = new Map<string, Map<string, number>>();
  const liveAgentSessions = new Map<string, import("./types.js").WorkflowAgentSession>();
  const liveAgentPrepared = new Map<string, Readonly<import("./types.js").PreparedAgentSession>>();
  const liveAgentHandoffs = new Map<string, import("./types.js").LiveSessionHandoff>();
  const setLiveAgentSession = (runId: string, agentId: string, session?: import("./types.js").WorkflowAgentSession) => { const key = `${runId}:${agentId}`; if (session) liveAgentSessions.set(key, session); else liveAgentSessions.delete(key); };
  const setLiveAgentHandoff = (runId: string, agentId: string, attempt: AgentAttempt) => {
    const key = `${runId}:${agentId}`;
    if (attempt.liveSession && attempt.prepared && attempt.handoff) { liveAgentPrepared.set(key, attempt.prepared); liveAgentHandoffs.set(key, attempt.handoff); } else { liveAgentPrepared.delete(key); liveAgentHandoffs.delete(key); }
  };
  const setLiveActivity = (runId: string, agentId: string, activity?: AgentActivity) => {
    const activities = liveActivities.get(runId);
    if (activity) {
      if (activities) activities.set(agentId, activity);
      else liveActivities.set(runId, new Map([[agentId, activity]]));
    } else {
      activities?.delete(agentId);
      if (activities?.size === 0) liveActivities.delete(runId);
    }
  };
  const setLiveEventTime = (runId: string, agentId: string, timestamp?: number) => {
    if (timestamp === undefined) return;
    const timestamps = liveEventTimes.get(runId);
    if (timestamps) timestamps.set(agentId, timestamp);
    else liveEventTimes.set(runId, new Map([[agentId, timestamp]]));
  };
  const withLiveActivities = (run: PersistedRun): PersistedRun => {
    const activities = liveActivities.get(run.id);
    const timestamps = liveEventTimes.get(run.id);
    if (!activities?.size && !timestamps?.size) return run;
    return { ...run, agents: run.agents.map((agent) => {
      const activity = activities?.get(agent.id);
      const lastEventAt = timestamps?.get(agent.id);
      if (activity === undefined && lastEventAt === undefined) return agent;
      return { ...agent, ...(activity === undefined ? {} : { activity }), ...(lastEventAt === undefined ? {} : { lastEventAt }) };
    }) };
  };
  const terminalRunStates = new Map<string, "completed" | "failed" | "stopped">();
  let sessionLease: SessionLease | undefined;
  let sessionLeasePromise: Promise<SessionLease> | undefined;
  const ensureSessionLease = async (cwd: string, sessionId: string) => {
    if (sessionLease?.active) return;
    const pending = sessionLeasePromise ?? (sessionLeasePromise = acquireSessionLease(cwd, sessionId, home));
    try { sessionLease = await pending; }
    finally { if (sessionLeasePromise === pending) sessionLeasePromise = undefined; }
  };
  const releaseSessionLease = async () => {
    const lease = sessionLease ?? await sessionLeasePromise?.catch(() => undefined);
    sessionLease = undefined;
    sessionLeasePromise = undefined;
    await lease?.release();
  };
  const persistRunState = async (store: RunStore, metadata: WorkflowMetadata, update: (run: PersistedRun) => PersistedRun | Promise<PersistedRun>): Promise<PersistedRun> => {
    const persisted = await store.updateState(update);
    await eventPublisher.budget(store, metadata, persisted);
    return persisted;
  };
  pi.on("tool_result", async (event) => {
    const delivery = event.toolName === "workflow" ? foregroundDeliveries.get(event.toolCallId) : undefined;
    if (delivery) {
      if (delivery.timer) clearTimeout(delivery.timer);
      delivery.inline = true;
      await delivery.store.updateState((current) => {
        if (current.delivery?.toolCallId !== event.toolCallId || current.delivery.state === "delivered") return current;
        return { ...current, delivery: { ...current.delivery, state: "delivered" } };
      });
      foregroundDeliveries.delete(event.toolCallId);
    }
    if (event.toolName !== "workflow" || !event.isError) return;
    const diagnostic = pendingFailureDiagnostics.get(event.toolCallId);
    if (!diagnostic) return;
    pendingFailureDiagnostics.delete(event.toolCallId);
    return { content: [{ type: "text" as const, text: serializeWorkflowFailureDiagnostics(diagnostic) }], details: diagnostic, isError: true };
  });
  const deliverTerminal = (store: RunStore, content: string, failure = false): Promise<void> => {
    const previous = terminalDeliveryQueues.get(store) ?? Promise.resolve();
    const delivery = previous.then(async () => {
      let claimed: boolean | undefined;
      await store.updateState((current) => {
        if (failure && !FAILURE_DELIVERY_STATES.has(current.state)) return current;
        if (current.delivery?.state === "delivered") return current;
        if (!current.delivery) { claimed = true; return current; }
        claimed = true;
        return { ...current, delivery: { ...current.delivery, mode: "background", state: "delivered" } };
      });
      if (claimed !== true) return;
      if (failure && !FAILURE_DELIVERY_STATES.has((await store.load()).run.state)) {
        await store.updateState((current) => !FAILURE_DELIVERY_STATES.has(current.state) && current.delivery?.state === "delivered" ? { ...current, delivery: { ...current.delivery, state: "pending" } } : current);
        return;
      }
      deliver(pi, content);
    });
    terminalDeliveryQueues.set(store, delivery.catch(() => undefined));
    return delivery;
  };
  const scheduleForegroundDelivery = (toolCallId: string, send: () => Promise<void>): void => {
    const delivery = foregroundDeliveries.get(toolCallId);
    if (!delivery || delivery.inline || typeof (pi as unknown as { sendMessage?: unknown }).sendMessage !== "function") return;
    //NOTE: Give Pi one event-loop turn to deliver an uninterrupted tool result before promoting.
    delivery.timer = setTimeout(() => {
      delete delivery.timer;
      void send().finally(() => foregroundDeliveries.delete(toolCallId));
    }, 0);
  };
  const phaseBridge = (store: RunStore, metadata: WorkflowMetadata, lifecycle: RunLifecycle) => {
    let cursor = 0;
    return async (phase: string): Promise<void> => {
      await scheduler.flush();
      await lifecycle.enter();
      try {
        let previousPhase: string | undefined;
        const persisted = await persistRunState(store, metadata, (current) => {
          previousPhase = current.phase;
          const history = current.phaseHistory ?? [];
          if (history[cursor]?.phase === phase) { cursor += 1; return { ...current, phase }; }
          cursor = history.length + 1;
          return { ...current, phase, phaseHistory: [...history, { phase, afterAgent: current.agents.length }] };
        });
        await eventPublisher.phase(store, metadata, previousPhase, phase);
        runs.get(store.runId)?.update?.(workflowToolUpdate(persisted));
      } finally { await lifecycle.leave(); }
    };
  };
  const persistWorktree = async (store: RunStore, metadata: WorkflowMetadata, owner: string): Promise<WorktreeReference> => {
    const existing = (await store.worktrees()).some((worktree) => worktree.owner === owner);
    const worktree = await store.worktree(owner);
    if (!existing && await store.ownsWorktree(owner)) await eventPublisher.worktree(store, metadata, worktree);
    return worktree;
  };
  const resolveWorktree = async (store: RunStore, metadata: WorkflowMetadata, owner: string): Promise<Readonly<WorkflowWorktreeReference>> => {
    const run = runs.get(store.runId);
    if (!run) fail("INTERNAL_ERROR", `Unknown production run: ${store.runId}`);
    await run.lifecycle.enter();
    try {
      const worktree = await persistWorktree(store, metadata, owner);
      return { path: worktree.path, branch: worktree.branch };
    } finally { await run.lifecycle.leave(); }
  };
  const shellForRun = async (store: RunStore, metadata: WorkflowMetadata, lifecycle: RunLifecycle, command: string, options: ShellOptions, signal: AbortSignal, identity: ShellIdentity): Promise<ShellResult> => {
    await lifecycle.enter();
    try {
      const path = shellIdentityPath(identity);
      const replayed = await store.replay(path);
      if (replayed) return readShellResult(replayed.value);
      const started = await persistRunState(store, metadata, (current) => ({ ...current, activeShells: (current.activeShells ?? 0) + 1 }));
      runs.get(store.runId)?.update?.(workflowToolUpdate(withLiveActivities(started)));
      try {
        const cwd = identity.worktreeOwner ? (await persistWorktree(store, metadata, identity.worktreeOwner)).cwd : store.cwd;
        const result = await executeShellCommand(command, options, signal, cwd);
        await store.complete(path, result as unknown as JsonValue);
        return result;
      } finally {
        const stopped = await persistRunState(store, metadata, (current) => {
          const activeShells = Math.max(0, (current.activeShells ?? 0) - 1);
          if (activeShells > 0) return { ...current, activeShells };
          const next = { ...current };
          delete next.activeShells;
          return next;
        });
        runs.get(store.runId)?.update?.(workflowToolUpdate(withLiveActivities(stopped)));
      }
    } finally { await lifecycle.leave(); }
  };
  const lifecycleFor = (store: RunStore, state: RunState, budget: WorkflowBudgetRuntime, metadata: WorkflowMetadata) => new RunLifecycle(state, async (next, previous, reason) => {
    if (next !== "pausing") budget.transition(next);
    const persisted = await persistRunState(store, metadata, (current) => {
      const nextRun = { ...current, state: next, ...budget.snapshot() };
      if (next === "running" || next === "completed") { delete nextRun.error; delete nextRun.failedAt; }
      if (next === "running" && (previous === "paused" || previous === "interrupted" || previous === "budget_exhausted") && nextRun.delivery) nextRun.delivery = { ...nextRun.delivery, mode: "background", state: "pending" };
      return nextRun;
    });
    await eventPublisher.runState(store, metadata, previous, next, reason);
    runs.get(store.runId)?.update?.(workflowToolUpdate(withLiveActivities(persisted)));
  });
  const scheduler = new FairAgentScheduler(async ({ id, runId, parentId, prompt, options, signal, setSteer }) => {
    const run = runs.get(runId);
    if (!run) throw new WorkflowError("INTERNAL_ERROR", `Unknown production run: ${runId}`);
    try {
      const budget = run.budget.forAgent(id);
      const onProgress = async (progress: AgentProgress) => {
        let runState: PersistedRun;
        if (progress.persist) {
          runState = await persistRunState(run.store, run.metadata, (current) => current.agents.some((agent) => agent.id === id) ? { ...current, ...run.budget.snapshot(), agents: current.agents.map((agent) => agent.id === id ? { ...agent, accounting: progress.accounting, toolCalls: progress.toolCalls, ...(progress.state ? { model: progress.state.model, tools: progress.state.tools, ...(progress.state.systemPrompt === undefined ? {} : { systemPrompt: progress.state.systemPrompt }) } : {}), activity: progress.activity, ...(progress.lastEventAt === undefined ? {} : { lastEventAt: progress.lastEventAt }) } : agent) } : current);
        } else {
          const loaded = await run.store.load();
          if (!loaded.run.agents.some((agent) => agent.id === id)) return;
          runState = { ...loaded.run, ...run.budget.snapshot(), agents: loaded.run.agents.map((agent) => agent.id === id ? { ...agent, accounting: progress.accounting, toolCalls: progress.toolCalls, ...(progress.state ? { model: progress.state.model, tools: progress.state.tools, ...(progress.state.systemPrompt === undefined ? {} : { systemPrompt: progress.state.systemPrompt }) } : {}), activity: progress.activity, ...(progress.lastEventAt === undefined ? {} : { lastEventAt: progress.lastEventAt }) } : agent) };
        }
        if (!runState.agents.some((agent) => agent.id === id)) return;
        setLiveActivity(runId, id, progress.activity);
        setLiveEventTime(runId, id, progress.lastEventAt);
        run.update?.(workflowToolUpdate(withLiveActivities(runState)));
      };
      const onAttempt = async (attempt: AgentAttempt) => {
        setLiveAgentSession(runId, id, attempt.liveSession);
        setLiveAgentHandoff(runId, id, attempt);
        await scheduler.flush();
        scheduler.attemptStarted(id);
        const lastEventAt = Date.now();
        setLiveEventTime(runId, id, lastEventAt);
        await scheduler.flush();
        const before = (await run.store.load()).run;
        await persistActiveAgentAttempt(run.store, id, attempt);
        const active = (await run.store.load()).run;
        await eventPublisher.agentStates(run.store, run.metadata, before.agents, active.agents);
        const persisted = await persistRunState(run.store, run.metadata, (current) => ({ ...current, ...run.budget.snapshot(), agents: current.agents.map((agent) => agent.id === id ? { ...agent, lastEventAt } : agent) }));
        run.update?.(workflowToolUpdate(withLiveActivities(persisted)));
      };
      const result = await run.executor.execute(prompt, { label: options.label, workflowName: run.metadata.name, onProgress, onAttempt, budget, ...(run.providerErrorRecovery ? { providerErrorRecovery: run.providerErrorRecovery } : {}), ...(parentId ? { parent: parentId, cwd: options.cwd, ...(options.worktreeOwner ? { worktreeOwner: options.worktreeOwner } : {}) } : options.worktreeOwner ? { worktreeOwner: options.worktreeOwner } : {}), ...(options.model ? { model: options.model } : {}), ...(options.thinking ? { thinking: options.thinking } : {}), ...(options.role ? { role: options.role } : {}), ...(options.role ? {} : { tools: options.tools }), effectiveTools: options.tools, ...(options.schema ? { schema: options.schema } : {}), ...(options.retries === undefined ? {} : { retries: options.retries }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.agentOptions ? { agentOptions: options.agentOptions } : {}), ...(options.agentIdentity ? { agentIdentity: options.agentIdentity } : {}) }, signal, scheduler.toolsFor(id, (role, tools, model, inheritedTools, thinking) => run.executor.resolve({ label: "child", workflowName: run.metadata.name, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(role ? { role } : {}), ...(tools !== undefined ? { tools } : {}) }, inheritedTools).tools), setSteer, () => { scheduler.cancelChildren(id); scheduler.retry(id); });
      const before = (await run.store.load()).run;
      await persistAgentAttempts(run.store, id, result.attempts);
      const completed = (await run.store.load()).run;
      await eventPublisher.agentStates(run.store, run.metadata, before.agents, completed.agents);
      const persisted = await persistRunState(run.store, run.metadata, (current) => ({ ...current, ...run.budget.snapshot() }));
      setLiveActivity(runId, id);
      setLiveAgentSession(runId, id);
      run.update?.(workflowToolUpdate(withLiveActivities(persisted)));
      return result.value;
    } catch (error) {
      setLiveAgentSession(runId, id);
      const attempts = (error as WorkflowError & { attempts?: readonly AgentAttempt[] }).attempts;
      if (attempts?.length) {
        const before = (await run.store.load()).run;
        await persistAgentAttempts(run.store, id, attempts);
        const failed = (await run.store.load()).run;
        await eventPublisher.agentStates(run.store, run.metadata, before.agents, failed.agents);
      }
      const persisted = await persistRunState(run.store, run.metadata, (current) => ({ ...current, ...run.budget.snapshot() }));
      setLiveActivity(runId, id);
      run.update?.(workflowToolUpdate(withLiveActivities(persisted)));
      throw error;
    }
  }, 16, async (runId, ownership) => {
    const run = runs.get(runId);
    if (!run) return;
    await run.store.saveOwnership(ownership);
    let previousAgents: readonly AgentRecord[] = [];
    const runState = await persistRunState(run.store, run.metadata, (current) => {
      previousAgents = current.agents;
      const existing = new Map(current.agents.map((agent) => [agent.id, agent]));
      const agents = ownership.map((node) => {
        const previous = existing.get(node.id);
        const requested = { label: node.options.label, workflowName: run.metadata.name, ...(node.options.model ? { model: node.options.model } : {}), ...(node.options.thinking ? { thinking: node.options.thinking } : {}), ...(node.options.role ? { role: node.options.role } : {}), effectiveTools: node.options.tools };
        let effective: { model: ModelSpec; requestedModel?: string; tools: readonly string[] };
        try { effective = run.executor.resolve(requested); }
        catch { effective = previous ? { model: previous.model, ...(previous.requestedModel ? { requestedModel: previous.requestedModel } : {}), tools: previous.tools } : { model: node.options.model ? modelSpec(node.options.model, run.model) : { ...run.model, ...(node.options.thinking ? { thinking: node.options.thinking } : {}) }, ...(node.options.model ? { requestedModel: node.options.model } : {}), tools: node.options.tools }; }
        const resultPath = !node.parentId && node.options.agentIdentity ? agentIdentityPath(node.options.agentIdentity) : undefined;
        const now = Date.now();
        const lastEventAt = node.state === "running" ? previous?.state === "running" && previous.lastEventAt !== undefined ? previous.lastEventAt : now : previous?.lastEventAt;
        const startedAt = previous?.startedAt ?? (node.state === "running" ? now : undefined);
        const durationMs = previous?.durationMs ?? (SETTLED_AGENT_STATES.has(node.state) && startedAt !== undefined ? Math.max(0, now - startedAt) : undefined);
        return { ...(previous?.systemPrompt === undefined ? {} : { systemPrompt: previous.systemPrompt }), ...(node.prompt !== undefined ? { prompt: node.prompt } : previous?.prompt !== undefined ? { prompt: previous.prompt } : {}), id: node.id, name: node.label, ...(node.options.requestedLabel ? { label: node.options.requestedLabel } : {}), path: node.id, state: node.state, ...(node.parentId ? { parentId: node.parentId } : {}), structuralPath: [...(node.options.agentIdentity?.structuralPath ?? [])], ...(resultPath ? { resultPath } : {}), ...(node.options.parentBreadcrumb ? { parentBreadcrumb: node.options.parentBreadcrumb } : {}), ...(node.options.worktreeOwner ? { worktreeOwner: node.options.worktreeOwner } : {}), ...(node.options.role ? { role: node.options.role } : {}), ...(effective.requestedModel ? { requestedModel: effective.requestedModel } : {}), model: effective.model, tools: effective.tools, attempts: previous?.attempts ?? 0, ...(startedAt === undefined ? {} : { startedAt }), ...(durationMs === undefined ? {} : { durationMs }), ...(previous?.attemptDetails ? { attemptDetails: previous.attemptDetails } : {}), ...(previous?.accounting ? { accounting: previous.accounting } : {}), ...(previous?.toolCalls ? { toolCalls: previous.toolCalls } : {}), ...(previous?.activity ? { activity: previous.activity } : {}), ...(lastEventAt === undefined ? {} : { lastEventAt }) };
      });
      return { ...current, agents };
    });
    await eventPublisher.agentStates(run.store, run.metadata, previousAgents, runState.agents);
    run.update?.(workflowToolUpdate(withLiveActivities(runState)));
  });
  const cleanupTerminalRun = async (runId: string): Promise<void> => {
    const run = runs.get(runId);
    if (!run || !HARD_TERMINAL_RUN_STATES.has(run.lifecycle.state)) return;
    await scheduler.cancelRun(runId);
    await scheduler.flush();
    if (runs.get(runId) !== run) return;
    scheduler.removeRun(runId);
    terminalRunStates.set(runId, run.lifecycle.state as "completed" | "failed" | "stopped");
    run.checkpointResolvers.clear();
    liveActivities.delete(runId);
    liveEventTimes.delete(runId);
    for (const key of liveAgentSessions.keys()) if (key.startsWith(`${runId}:`)) liveAgentSessions.delete(key);
    for (const key of liveAgentPrepared.keys()) if (key.startsWith(`${runId}:`)) liveAgentPrepared.delete(key);
    for (const key of liveAgentHandoffs.keys()) if (key.startsWith(`${runId}:`)) liveAgentHandoffs.delete(key);
    eventPublisher.removeRun(runId);
    runs.delete(runId);
  };
  type WorkflowStopResult = { runId: string; state: RunState | "unknown"; stopped: boolean; reason?: "unknown_run" | "already_terminal" };
  const stopWorkflowRun = async (runId: string): Promise<WorkflowStopResult> => {
    const run = runs.get(runId);
    const terminalState = terminalRunStates.get(runId);
    if (!run) return terminalState ? { runId, state: terminalState, stopped: false, reason: "already_terminal" } : { runId, state: "unknown", stopped: false, reason: "unknown_run" };
    const state = run.lifecycle.state;
    if (state === "completed" || state === "failed" || state === "stopped") return { runId, state, stopped: false, reason: "already_terminal" };
    await run.lifecycle.terminal("stopped");
    run.abortController.abort();
    run.execution?.cancel();
    await scheduler.cancelRun(run.store.runId);
    await scheduler.flush();
    await cleanupTerminalRun(runId);
    return { runId, state: "stopped", stopped: true };
  };
  type WorkflowStatusAgent = { id: string; label?: string; path: string; state: AgentRecord["state"]; activity?: AgentActivity; lastEventAt?: number; accounting?: NonNullable<AgentRecord["accounting"]> };
  type WorkflowStatusResult = { runId: string; workflowName: string; state: RunState; error?: { code: WorkflowErrorCode; message: string }; failedAt?: string; budget?: NonNullable<PersistedRun["budget"]>; usage?: NonNullable<PersistedRun["usage"]>; phase?: string; delivery?: Pick<NonNullable<PersistedRun["delivery"]>, "mode" | "state">; agents: readonly WorkflowStatusAgent[] };
  const workflowStatusRun = async (runId: string, context: unknown): Promise<WorkflowStatusResult> => {
    const host = object(context) ? context : {};
    const cwd = typeof host.cwd === "string" ? host.cwd : undefined;
    if (!cwd || !runId.trim()) throw new WorkflowError("RUN_NOT_FOUND", `Unknown workflow run ${runId} in the current project`);
    for (const sessionId of await listPersistedSessionIds(cwd, home)) {
      if (!(await listRunIds(cwd, sessionId, home, false)).includes(runId)) continue;
      const store = new RunStore(cwd, sessionId, runId, home);
      try {
        const run = withLiveActivities(await store.loadStatus());
        const failedAt = run.failedAt ?? run.error?.failedAt;
        return {
          runId: run.id, workflowName: run.workflowName, state: run.state,
          ...(run.error ? { error: { code: run.error.code, message: run.error.message } } : {}),
          ...(failedAt ? { failedAt } : {}),
          ...(run.budget === undefined ? {} : { budget: run.budget, ...(run.usage === undefined ? {} : { usage: run.usage }) }),
          ...(run.phase ? { phase: run.phase } : {}),
          ...(run.delivery ? { delivery: { mode: run.delivery.mode, state: run.delivery.state } } : {}),
          agents: run.agents.map((agent) => ({ id: agent.id, ...(agent.label === undefined ? {} : { label: agent.label }), path: agent.path, state: agent.state, ...(agent.activity === undefined ? {} : { activity: agent.activity }), ...(agent.lastEventAt === undefined ? {} : { lastEventAt: agent.lastEventAt }), ...(agent.accounting === undefined ? {} : { accounting: agent.accounting }) })),
        };
      } catch {
        continue;
      }
    }
    throw new WorkflowError("RUN_NOT_FOUND", `Unknown workflow run ${runId} in the current project`);
  };
  const answerCheckpoint = async (runId: string, name: string, approved: boolean, silent = false) => {
    const run = runs.get(runId);
    if (!run) return false;
    const checkpoint = await run.store.answerCheckpoint(name, approved);
    if (!checkpoint) return false;
    await eventPublisher.checkpoint(run.store, run.metadata, checkpoint.name, approved ? "approved" : "rejected");
    if ((await run.store.awaitingCheckpoints()).length === 0) await run.lifecycle.resolveAwaitingInput();
    run.checkpointResolvers.get(checkpoint.path)?.(approved);
    run.checkpointResolvers.delete(checkpoint.path);
    if (!silent) deliver(pi, `Workflow ${run.metadata.name} checkpoint ${name}: ${approved ? "Approved" : "Rejected"}.`);
    return true;
  };
  const budgetDecisionDelivery = (metadata: WorkflowMetadata, request: BudgetApprovalRequest) => `Workflow ${metadata.name} budget adjustment ${request.proposalId} for run ${request.runId} requires approval. Consumed usage: ${JSON.stringify(request.consumed)}. Previous limits: ${JSON.stringify(request.previous)}. Proposed limits: ${JSON.stringify(request.proposed)}. Respond with workflow_respond using proposalId ${request.proposalId}.`;
  const appendBudgetDecisionEvent = async (run: NonNullable<ReturnType<typeof runs.get>>, request: BudgetApprovalRequest, type: "adjustment_requested" | "adjustment_approved" | "adjustment_rejected") => {
    run.budget.recordEvent({ type, budgetVersion: request.budgetVersion, dimensions: [], usage: structuredClone(request.consumed), limits: structuredClone(request.proposed), at: Date.now(), proposalId: request.proposalId, previous: structuredClone(request.previous), proposed: structuredClone(request.proposed) });
    await persistRunState(run.store, run.metadata, (current) => ({ ...current, ...run.budget.snapshot() }));
  };
  const answerBudgetDecision = async (runId: string, proposalId: string, approved: boolean, silent = false, context?: unknown, signal?: AbortSignal, waitForCompletion = true): Promise<BudgetDecisionResult | undefined> => {
    const run = runs.get(runId);
    if (!run) return undefined;
    const request = await run.store.answerWorkflowDecision(proposalId, approved);
    if (!request) return undefined;
    await appendBudgetDecisionEvent(run, request, approved ? "adjustment_approved" : "adjustment_rejected");
    const result = await applyBudgetDecision(request, approved, context, signal, waitForCompletion);
    if (!silent) deliver(pi, `Workflow ${run.metadata.name} budget adjustment ${proposalId}: ${approved ? "Approved" : "Rejected"}.`);
    return result;
  };
  const checkpointBridge = (runId: string, store: RunStore, metadata: WorkflowMetadata, foreground: boolean, ui?: { select?: (prompt: string, options: string[]) => Promise<string | undefined> }, headless = false) => {
    const checkpointCounters = new Map<string, number>();
    return async (raw: Readonly<Record<string, JsonValue>>, signal: AbortSignal): Promise<boolean> => {
      const input = validateCheckpoint(raw);
      const label = nextNamedOccurrence(checkpointCounters, input.name);
      const path = operationPath("checkpoint", label);
      if (headless) fail("RESUME_INCOMPATIBLE", "Headless CLI checkpoints are unsupported");
      if (foreground && !ui?.select) fail("RESUME_INCOMPATIBLE", "Foreground checkpoints require UI");
      const alreadyAwaiting = (await store.awaitingCheckpoints()).some((checkpoint) => checkpoint.path === path);
      const replayed = await store.awaitCheckpoint({ ...input, name: label, path });
      if (replayed !== undefined) return replayed;
      if (!alreadyAwaiting) await eventPublisher.checkpoint(store, metadata, label, "awaiting");
      const run = runs.get(runId);
      await run?.lifecycle.enterAwaitingInput();
      if (!alreadyAwaiting && !ui?.select) deliver(pi, `Workflow ${metadata.name} checkpoint ${label}: ${input.prompt}\nContext: ${JSON.stringify(input.context)}\nRespond with workflow_respond.`);
      const decision = new Promise<boolean>((resolve, reject) => {
        run?.checkpointResolvers.set(path, resolve);
        if (signal.aborted) reject(new WorkflowError("CANCELLED", "Workflow cancelled"));
        else signal.addEventListener("abort", () => { run?.checkpointResolvers.delete(path); reject(new WorkflowError("CANCELLED", "Workflow cancelled")); }, { once: true });
      });
      const answered = await store.awaitCheckpoint({ ...input, name: label, path });
      if (answered !== undefined) {
        if ((await store.awaitingCheckpoints()).length === 0) await run?.lifecycle.resolveAwaitingInput();
        run?.checkpointResolvers.get(path)?.(answered);
        run?.checkpointResolvers.delete(path);
      }
      if (ui?.select) void (async () => {
        while (!signal.aborted && run?.checkpointResolvers.has(path)) {
          const choice = await ui.select?.(input.prompt, ["Approve", "Reject"]);
          if (!choice) {
            if (foreground) continue; // foreground: retry until answered
            deliver(pi, `Workflow ${metadata.name} checkpoint ${label}: ${input.prompt}\nContext: ${JSON.stringify(input.context)}\nRespond with workflow_respond.`);
            return;
          }
          if (await answerCheckpoint(runId, label, choice === "Approve", true)) return;
        }
      })().catch(() => undefined);
      return decision;
    };
  };

  pi.registerTool({
    name: "workflow_respond",
    label: "Workflow Respond",
    description: "Approve or reject one pending workflow checkpoint or budget decision",
    parameters: Type.Object({ runId: Type.String(), name: Type.Optional(Type.String()), proposalId: Type.Optional(Type.String()), approved: Type.Boolean() }, { additionalProperties: false }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        if (params.proposalId) {
          const result = await answerBudgetDecision(params.runId, params.proposalId, params.approved, false, ctx, signal);
          if (!result) { const denied = { state: "budget_exhausted" as const, approved: false, reason: "proposal_not_pending" }; return { content: [{ type: "text" as const, text: JSON.stringify(denied) }], details: denied }; }
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { ...result, reason: params.approved ? "approved" : "rejected" } };
        }
        if (!params.name) throw new WorkflowError("INVALID_METADATA", "workflow_respond requires name or proposalId");
        const accepted = await answerCheckpoint(params.runId, params.name, params.approved);
        return { content: [{ type: "text" as const, text: accepted ? "Checkpoint response accepted." : "Checkpoint is not awaiting a response." }], details: { accepted, state: accepted ? "checkpoint_answered" : "not_pending", approved: params.approved, reason: "checkpoint" } };
      } catch (error) {
        throw mainAgentError(error);
      }
    },
    renderCall(args, theme) { return styledTextBlock(workflowControlCall("workflow_respond", args, theme)); },
    renderResult(result, options, theme, context) { return workflowCatalogBlock(workflowControlResult("workflow_respond", context.args, result, options.expanded, theme, context.isError), options.expanded); },
  });
  pi.registerTool({
    name: "workflow_stop",
    label: "Workflow Stop",
    description: "Stop an active workflow run by ID",
    parameters: Type.Object({ runId: Type.String() }, { additionalProperties: false }),
    async execute(_id, params) {
      try {
        const result = await stopWorkflowRun(params.runId);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      } catch (error) {
        throw mainAgentError(error);
      }
    },
    renderCall(args, theme) { return styledTextBlock(workflowControlCall("workflow_stop", args, theme)); },
    renderResult(result, options, theme, context) { return workflowCatalogBlock(workflowControlResult("workflow_stop", context.args, result, options.expanded, theme, context.isError), options.expanded); },
  });
  pi.registerTool({
    name: "workflow_status",
    label: "Workflow Status",
    description: "Read a compact summary of a workflow run in the current project",
    parameters: WORKFLOW_STATUS_PARAMETERS,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try { const result = await workflowStatusRun(params.runId, ctx); return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result }; }
      catch (error) { throw mainAgentError(error); }
    },
    renderCall(args, theme) { return styledTextBlock(workflowControlCall("workflow_status", args, theme)); },
    renderResult(result, options, theme, context) { return workflowCatalogBlock(workflowControlResult("workflow_status", context.args, result, options.expanded, theme, context.isError), options.expanded); },
  });
  let catalogRegistered = false;
  let sessionStarted = false;
  const registerCatalog = (cwd: string, trustedProject: boolean) => {
    if (catalogRegistered || !pi.getActiveTools().includes("workflow")) return;
    const catalog = registry.catalog({ cwd, projectTrusted: trustedProject, globalSettingsPath: workflowSettingsPath(extensionAgentDir) });
    const hasAliases = Object.keys(catalog.modelAliases ?? {}).length > 0 || Boolean(catalog.modelAliasEntries?.length);
    const hasSettings = catalog.settings !== undefined && [catalog.settings.globalSettingsPath, catalog.settings.projectSettingsPath].some((path) => existsSync(path));
    if (!catalog.functions.length && !hasAliases && !hasSettings) return;
    pi.registerTool({
      name: "workflow_catalog",
      label: "Workflow Catalog",
      description: "List reusable workflow functions and model aliases; pass `name` to load one entry in full",
      parameters: Type.Object({ name: Type.Optional(Type.String({ description: "Registered function or model alias name for full detail" })) }, { additionalProperties: false }),
      async execute(_id, params = {}) {
        const context = { cwd, projectTrusted: trustedProject, globalSettingsPath: workflowSettingsPath(extensionAgentDir) };
        const result = params.name === undefined ? registry.catalogIndex(context) : registry.catalogDetail(params.name, context);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      },
      renderCall(args, theme) {
        const title = theme.fg("toolTitle", theme.bold("workflow_catalog"));
        return styledTextBlock(args.name === undefined ? title : `${title} ${theme.fg("accent", args.name)}`);
      },
      renderResult(result, options, theme) {
        return workflowCatalogBlock(formatWorkflowCatalog(catalogResultValue(result), options.expanded, theme), options.expanded);
      },
    });
    catalogRegistered = true;
  };
  const createAgentExecutor = (root: Omit<import("./agent-execution.js").AgentExecutionRoot, "agentDir" | "agentSetupHooks">) => new WorkflowAgentExecutor({ ...root, agentDir: extensionAgentDir, ...(additionalSkillPaths.length ? { additionalSkillPaths } : {}), agentSetupHooks: registry.agentSetupHooks() }, transport);
  const activeSnapshotTools = (tools: readonly string[], active: ReadonlySet<string> | "session") => active === "session"
    ? new Set(tools.filter((tool) => pi.getActiveTools().includes(tool) && tool !== "workflow_catalog"))
    : new Set(tools.filter((tool) => active.has(tool) || tool === "workflow_catalog"));
  const resumeLaunchPrologue = async (input: {
    snapshot: Readonly<LaunchSnapshot>;
    cwd: string;
    trustedProject: boolean;
    rootModel: ModelSpec;
    modelRegistry?: ModelRegistryCapability | undefined;
    signal: AbortSignal;
    resolvedAliases?: Readonly<Record<string, string>>;
    blockedAliases?: ReadonlySet<string>;
    blockedAliasTargets?: Readonly<Record<string, string>>;
    withPreflight: boolean;
  }) => {
    const active = new Set(pi.getActiveTools().filter((tool) => !INTERNAL_WORKFLOW_TOOLS.includes(tool)));
    const missing = input.snapshot.tools.filter((tool) => tool !== "workflow_catalog").find((tool) => !active.has(tool));
    if (missing) throw new WorkflowError("RESUME_INCOMPATIBLE", `Required tool is unavailable: ${missing}`);
    const settingsPath = workflowSettingsPath(extensionAgentDir);
    const resolution = resolveWorkflowSettings(input.cwd, input.trustedProject, settingsPath);
    const currentPolicy = resolveAgentResourcePolicy(input.cwd, input.trustedProject, settingsPath);
    const staticAliases = resolution.effective.modelAliases ?? {};
    const previousAliases = input.snapshot.modelAliases ?? input.snapshot.settings.modelAliases ?? {};
    const inventory = modelInventory(input.rootModel, input.modelRegistry);
    const knownModels = input.modelRegistry ? inventory.knownModels : new Set([...input.snapshot.models, ...inventory.knownModels]);
    const availableModels = input.modelRegistry ? inventory.availableModels : new Set([...input.snapshot.models, ...inventory.availableModels]);
    const currentAliases = input.resolvedAliases ?? (await resolveLaunchAliases(registry, staticAliases, { cwd: input.cwd, projectTrusted: input.trustedProject, rootModel: input.rootModel, knownModels, availableModels, signal: input.signal }, availableModels, knownModels, settingsPath)).aliases;
    const blockedAliases = input.blockedAliases ?? new Set(Object.keys(previousAliases).filter((name) => !Object.prototype.hasOwnProperty.call(currentAliases, name)));
    const blockedAliasTargets = input.blockedAliasTargets ?? Object.fromEntries(Object.entries(previousAliases).filter(([name]) => !Object.prototype.hasOwnProperty.call(currentAliases, name)));
    let script: ReturnType<typeof launchScriptForSnapshot> | undefined;
    if (input.withPreflight) {
      const resumeAliases = { ...previousAliases, ...currentAliases };
      script = launchScriptForSnapshot(input.snapshot, registry);
      preflight(script, { models: availableModels, tools: active, agentTypes: new Set(input.snapshot.agentTypes), modelAliases: resumeAliases, knownModels, settingsPath, skipModelAvailability: true }, input.snapshot.schemas, input.snapshot.metadata, true);
    }
    const refreshed = resumedSnapshotSettings(input.snapshot, resolution, currentAliases);
    const snapshot = createLaunchSnapshot({ ...input.snapshot, settingsPath, ...refreshed, modelAliases: currentAliases });
    return { active, settingsPath, resolution, currentPolicy, previousAliases, knownModels, availableModels, currentAliases, blockedAliases, blockedAliasTargets, snapshot, script };
  };
  const workflowAgentHandler = (store: RunStore, metadata: WorkflowMetadata, lifecycle: RunLifecycle, executor: WorkflowAgentExecutor, cwd: string, runId: string, captureRole?: (role: string, model: ModelSpec) => Promise<void>) => async (prompt: string, options: Readonly<Record<string, JsonValue>>, agentSignal: AbortSignal, identity: import("./types.js").AgentIdentity) => {
    await lifecycle.enter();
    try {
      const path = agentIdentityPath(identity);
      const replayed = await store.replay(path);
      if (replayed) {
        return replayed.value;
      }
      const worktree = agentWorktree(identity);
      const agentCwd = worktree.worktreeOwner ? (await persistWorktree(store, metadata, worktree.worktreeOwner)).cwd : cwd;
      const role = typeof options.role === "string" ? options.role : undefined;
      const model = typeof options.model === "string" ? options.model : undefined;
      const thinking = parseThinking(options.thinking);
      const requestedLabel = typeof options.label === "string" ? options.label : undefined;
      const resolved = executor.resolve({ label: requestedLabel ?? role ?? "agent", workflowName: metadata.name, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(role ? { role } : {}), ...(Array.isArray(options.tools) ? { tools: options.tools as string[] } : {}) });
      if (role) await captureRole?.(role, resolved.model);
      const label = displayAgentName(requestedLabel, role, resolved.model);
      const tools = resolved.tools;
      const schema = object(options.outputSchema) ? options.outputSchema : undefined;
      const spawned = scheduler.spawn(runId, prompt, { label, ...(requestedLabel ? { requestedLabel } : {}), ...(identity.parentBreadcrumb ? { parentBreadcrumb: identity.parentBreadcrumb } : {}), cwd: agentCwd, tools, ...worktree, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(role ? { role } : {}), ...(schema ? { schema } : {}), ...(typeof options.retries === "number" ? { retries: options.retries } : {}), ...(positiveInteger(options.timeoutMs) || options.timeoutMs === null ? { timeoutMs: options.timeoutMs } : {}), agentOptions: options, agentIdentity: identity });
      const cancel = () => { scheduler.cancel(spawned.id); };
      if (agentSignal.aborted) cancel(); else agentSignal.addEventListener("abort", cancel, { once: true });
      const outcome = await spawned.result.finally(() => { agentSignal.removeEventListener("abort", cancel); });
      if (!outcome.ok) throw new WorkflowError(outcome.error.code as WorkflowErrorCode, outcome.error.message);
      await store.complete(path, outcome.value);
      scheduler.releaseResult(spawned.id);
      return outcome.value;
    } finally { await lifecycle.leave(); }
  };
  const refreshPausedRunAliases = async (run: NonNullable<ReturnType<typeof runs.get>>, context?: { model: { provider: string; id: string } | undefined; modelRegistry: ModelRegistryCapability | undefined; projectTrusted?: boolean }) => {
    const loaded = await run.store.load();
    const trustedProject = context?.projectTrusted ?? run.projectTrusted();
    const rootModel = context?.model ? { ...run.model, provider: context.model.provider, model: context.model.id } : run.model;
    const { settingsPath, currentPolicy, previousAliases, knownModels, availableModels, currentAliases, blockedAliases, blockedAliasTargets, snapshot } = await resumeLaunchPrologue({ snapshot: loaded.snapshot, cwd: run.store.cwd, trustedProject, rootModel, ...(context?.modelRegistry ? { modelRegistry: context.modelRegistry } : {}), signal: run.abortController.signal, withPreflight: false });
    await run.store.saveSnapshot(snapshot);
    scheduler.updateRunLimit(run.store.runId, snapshot.settings.concurrency);
    run.executor = createAgentExecutor({ cwd: run.store.cwd, model: run.model, tools: activeSnapshotTools(snapshot.tools, "session"), availableModels, knownModels, modelAliases: currentAliases, blockedAliases, blockedAliasTargets, settingsPath, agentDefinitions: snapshot.roles ?? {}, runStore: run.store, providerPause: async () => { deliver(pi, `Workflow ${snapshot.metadata.name} paused: provider limit.`); await run.lifecycle.providerPause(); }, agentResourcePolicy: frozenResourcePolicy(currentPolicy) });
    run.executor.setRunContext(workflowRunContext(run.store.cwd, run.store.sessionId, run.store.runId, loaded.snapshot.metadata, loaded.snapshot.args, run.abortController.signal));
    const drift = aliasDrift(previousAliases, currentAliases);
    if (drift.length) await run.store.appendEvent({ type: "warning", message: `Model alias mappings changed on resume: ${drift.join("; ")}` });
  };
  const recoveryUi = (context: unknown): { hasUI: boolean; ui: { select?: (prompt: string, options: string[]) => Promise<string | undefined> } } => {
    const host = object(context) ? context : undefined;
    const ui = host && object(host.ui) ? host.ui as { select?: (prompt: string, options: string[]) => Promise<string | undefined> } : {};
    return { hasUI: host?.hasUI === true, ui };
  };
  type ColdResumeResult = { value: JsonValue; resultPath: string };
  const coldResumeRun = async (run: NonNullable<ReturnType<typeof runs.get>>, hasUI: boolean, ui: { select?: (prompt: string, options: string[]) => Promise<string | undefined> }, trustedProject: boolean, context?: { model: { provider: string; id: string } | undefined; modelRegistry: ModelRegistryCapability | undefined; signal?: AbortSignal | undefined; resolvedAliases?: Readonly<Record<string, string>>; blockedAliases?: ReadonlySet<string>; blockedAliasTargets?: Readonly<Record<string, string>> }, modeOverride?: boolean, waitForCompletion = true): Promise<ColdResumeResult | undefined> => {
    const loaded = await run.store.load();
    const foreground = modeOverride ?? loaded.snapshot.launchMode === "foreground";
    if (loaded.run.activeShells !== undefined) {
      await persistRunState(run.store, run.metadata, (current) => {
        const next = { ...current };
        delete next.activeShells;
        return next;
      });
    }
    await run.store.validateRetrySource();
    await run.store.validateBorrowedWorktrees();
    if (loaded.snapshot.identityVersion !== LAUNCH_SNAPSHOT_IDENTITY_VERSION) throw new WorkflowError("RESUME_INCOMPATIBLE", "Workflow launch snapshot identity version is incompatible");
    if (loaded.snapshot.roles === undefined) throw new WorkflowError("RESUME_INCOMPATIBLE", "Workflow role definitions are missing from the launch snapshot");
    if ((loaded.snapshot.projectRoles?.length ?? 0) > 0 && !trustedProject) throw new WorkflowError("RESUME_INCOMPATIBLE", "Cannot restore project roles in an untrusted project");
    const missingRole = loaded.snapshot.agentTypes.find((role) => !loaded.snapshot.roles?.[role]);
    if (missingRole) throw new WorkflowError("RESUME_INCOMPATIBLE", `Role definition is missing from the launch snapshot: ${missingRole}`);
    const rootModel = context?.model ? { ...run.model, provider: context.model.provider, model: context.model.id } : run.model;
    const controller = new AbortController();
    if (context?.signal?.aborted) controller.abort(); else { context?.signal?.addEventListener("abort", () => { controller.abort(); }, { once: true }); }
    run.abortController = controller;
    const { settingsPath, currentPolicy, previousAliases, knownModels, availableModels, currentAliases, blockedAliases, blockedAliasTargets, snapshot, script } = await resumeLaunchPrologue({ snapshot: loaded.snapshot, cwd: run.store.cwd, trustedProject, rootModel, ...(context?.modelRegistry ? { modelRegistry: context.modelRegistry } : {}), signal: controller.signal, ...(context?.resolvedAliases ? { resolvedAliases: context.resolvedAliases } : {}), ...(context?.blockedAliases ? { blockedAliases: context.blockedAliases } : {}), ...(context?.blockedAliasTargets ? { blockedAliasTargets: context.blockedAliasTargets } : {}), withPreflight: true });
    if (!script) throw new WorkflowError("INTERNAL_ERROR", "Resume preflight did not produce a launch script");
    const persistedSnapshot = modeOverride === undefined ? snapshot : createLaunchSnapshot({ ...snapshot, launchMode: foreground ? "foreground" : "background" });
    await run.store.saveSnapshot(persistedSnapshot);
    scheduler.updateRunLimit(run.store.runId, snapshot.settings.concurrency);
    run.executor = createAgentExecutor({ cwd: run.store.cwd, model: rootModel, tools: activeSnapshotTools(snapshot.tools, "session"), availableModels, knownModels, modelAliases: currentAliases, blockedAliases, blockedAliasTargets, settingsPath, agentDefinitions: snapshot.roles ?? {}, runStore: run.store, providerPause: async () => { deliver(pi, `Workflow ${snapshot.metadata.name} paused: provider limit.`); await run.lifecycle.providerPause(); }, agentResourcePolicy: frozenResourcePolicy(currentPolicy) });
    const drift = aliasDrift(previousAliases, currentAliases);
    if (drift.length) await run.store.appendEvent({ type: "warning", message: `Model alias mappings changed on resume: ${drift.join("; ")}` });
    const runContext = workflowRunContext(run.store.cwd, run.store.sessionId, run.store.runId, loaded.snapshot.metadata, loaded.snapshot.args, controller.signal);
    run.executor.setRunContext(runContext);
    await scheduler.cancelRun(run.store.runId);
    await run.lifecycle.resume();
    const execution = runWorkflow(script, loaded.snapshot.args, withWorkflowFunctions({ shell: (command, options, signal, identity) => shellForRun(run.store, run.metadata, run.lifecycle, command, options, signal, identity), agent: workflowAgentHandler(run.store, run.metadata, run.lifecycle, run.executor, run.store.cwd, run.store.runId), worktree: async (owner) => resolveWorktree(run.store, run.metadata, owner), checkpoint: checkpointBridge(run.store.runId, run.store, run.metadata, foreground, hasUI ? ui : undefined), phase: phaseBridge(run.store, run.metadata, run.lifecycle), log: logBridge(run.lifecycle, run.metadata.name) }, run.store, runContext, registry), controller.signal);
    run.execution = execution;
    const completion = execution.result.then(async (value) => {
      await scheduler.flush();
      if (run.budget.hardExhausted) throw new WorkflowError("BUDGET_EXHAUSTED", "Budgeted work was attempted after hard exhaustion");
      const resultPath = await run.store.saveResult(value);
      await run.lifecycle.terminal("completed", "completed");
      await eventPublisher.runCompleted(run.store, run.metadata, resultPath);
      return { value, resultPath };
    }).catch(async (error: unknown) => {
      await scheduler.flush();
      const typed = error instanceof WorkflowError ? error : new WorkflowError(errorCode(error) ?? "INTERNAL_ERROR", errorText(error));
      if (!["stopped", "interrupted", "budget_exhausted"].includes(run.lifecycle.state)) await run.lifecycle.terminal(typed.code === "BUDGET_EXHAUSTED" ? "budget_exhausted" : "failed", typed.code);
      const persisted = await persistRunState(run.store, run.metadata, (current) => persistedFailure({ ...current, ...run.budget.snapshot() }, typed));
      const state = run.lifecycle.state === "stopped" || run.lifecycle.state === "interrupted" || run.lifecycle.state === "budget_exhausted" ? run.lifecycle.state : "failed";
      if (state === "failed") retryReservations.delete(persisted.retry?.lineageRootRunId ?? run.store.runId);
      await eventPublisher.runFailed(run.store, run.metadata, typed, state);
      run.update?.(workflowToolUpdate(persisted));
      if (!["stopped", "interrupted", "budget_exhausted"].includes(run.lifecycle.state)) { const diagnostic = await createWorkflowFailureDiagnostics(run.store, run.metadata, typed, persisted); Object.defineProperty(typed, WORKFLOW_FAILURE_DIAGNOSTICS, { value: diagnostic }); }
      throw typed;
    }).finally(() => cleanupTerminalRun(run.store.runId));
    run.completion = completion;
    if (!foreground || !waitForCompletion) {
      void completion.then(async ({ value, resultPath }) => {
        await deliverTerminal(run.store, completionDelivery(run.metadata.name, value, resultPath, await run.store.changedWorktrees()));
      }, async (error: unknown) => {
        const diagnostic = failureDiagnosticsFrom(error);
        await deliverTerminal(run.store, diagnostic ? formatWorkflowFailureDelivery(diagnostic) : formatWorkflowFailureDeliveryFallback(run.metadata.name, run.store.runId, run.store.directory, error), true);
      });
      return undefined;
    }
    return completion;
  };
  const applyBudgetDecision = async (request: BudgetApprovalRequest, approved: boolean, context?: unknown, signal?: AbortSignal, waitForCompletion = true): Promise<BudgetDecisionResult> => {
    const run = runs.get(request.runId);
    if (!run) throw new WorkflowError("RESUME_INCOMPATIBLE", `Unknown workflow run: ${request.runId}`);
    if (!approved) return { state: "budget_exhausted", approved: false };
    const nextBudget = validateBudget(request.proposed);
    const nextVersion = request.budgetVersion + 1;
    const runtime = new WorkflowBudgetRuntime(nextBudget, nextVersion, request.consumed, run.budget.events, { active: false });
    run.budget = runtime;
    await persistRunState(run.store, run.metadata, (current) => { const next = { ...current, ...runtime.snapshot(), budgetVersion: nextVersion }; if (nextBudget) next.budget = nextBudget; else delete next.budget; return next; });
    const { hasUI, ui } = recoveryUi(context);
    const completed = await coldResumeRun(run, hasUI, ui, projectTrusted(context), { ...resumeHostContext(context), ...(signal ? { signal } : {}) }, undefined, waitForCompletion);
    if (completed) return { state: "completed", approved: true, value: completed.value, run: (await run.store.load()).run };
    return { state: "running", approved: true };
  };
  const resumeWorkflowRun = async (runId: string, rawPatch?: unknown, context?: unknown, signal?: AbortSignal, modeOverride?: boolean, waitForCompletion = true, expectedState?: string): Promise<Record<string, JsonValue>> => {
    const run = runs.get(runId);
    if (!run) {
      const host = object(context) ? context : {};
      const cwd = typeof host.cwd === "string" ? host.cwd : undefined;
      const sessionManager = object(host.sessionManager) ? host.sessionManager : undefined;
      const sessionId = typeof sessionManager?.getSessionId === "function" ? String(Reflect.apply(sessionManager.getSessionId, sessionManager, [])) : undefined;
      if (cwd && sessionId) {
        try {
          const state = (await new RunStore(cwd, sessionId, runId, home).load()).run.state;
          assertExpectedWorkflowState(expectedState, state);
          throw new WorkflowError("RESUME_INCOMPATIBLE", workflowRecoveryGuidance("resume", state));
        } catch (error) {
          if (error instanceof WorkflowError) throw error;
        }
      }
      throw new WorkflowError("RESUME_INCOMPATIBLE", `Unknown workflow run ${runId} in the current project and Pi session`);
    }
    const loaded = await run.store.load();
    assertExpectedWorkflowState(expectedState, loaded.run.state);
    if (loaded.run.state !== "budget_exhausted") throw new WorkflowError("RESUME_INCOMPATIBLE", workflowRecoveryGuidance("resume", loaded.run.state));
    const currentBudget = validateBudget(loaded.run.budget ?? loaded.snapshot.budget);
    const patch = rawPatch === undefined ? {} : validateBudgetPatch(rawPatch);
    const nextBudget = mergeBudget(currentBudget, patch);
    const usage = budgetUsage(loaded.run.usage);
    if (!resumeBudgetAllowed(nextBudget, usage)) throw new WorkflowError("RESUME_INCOMPATIBLE", "Every exhausted hard budget must be raised above retained usage or removed");
    if (budgetRelaxed(currentBudget, nextBudget)) {
      const proposalId = randomUUID();
      const request: BudgetApprovalRequest = { kind: "budget", proposalId, runId, consumed: usage, previous: currentBudget ?? {}, proposed: nextBudget ?? {}, budgetVersion: loaded.run.budgetVersion ?? 1 };
      await run.store.requestWorkflowDecision(request);
      await appendBudgetDecisionEvent(run, request, "adjustment_requested");
      deliver(pi, budgetDecisionDelivery(run.metadata, request));
      return { state: "awaiting_approval", proposalId };
    }
    const changed = JSON.stringify(currentBudget ?? {}) !== JSON.stringify(nextBudget ?? {});
    if (changed) {
      const nextVersion = (loaded.run.budgetVersion ?? 1) + 1;
      const runtime = new WorkflowBudgetRuntime(nextBudget, nextVersion, usage, loaded.run.budgetEvents, { active: false });
      run.budget = runtime;
      await persistRunState(run.store, run.metadata, (current) => { const next = { ...current, ...runtime.snapshot(), budgetVersion: nextVersion }; if (nextBudget) next.budget = nextBudget; else delete next.budget; return next; });
    }
    const { hasUI, ui } = recoveryUi(context);
    const completed = await coldResumeRun(run, hasUI, ui, projectTrusted(context), { ...resumeHostContext(context), ...(signal ? { signal } : {}) }, modeOverride, waitForCompletion);
    if (completed) return { state: "completed", runId, value: completed.value, run: (await run.store.load()).run as unknown as JsonValue };
    return { state: "running" };
  };
  const retryReservations = new Set<string>();
  const retryWorkflowRun = async (runId: string, context: unknown, signal?: AbortSignal, modeOverride?: boolean, expectedState?: string): Promise<{ runId: string; parentRunId: string; state: "running" | "completed"; value?: JsonValue; run?: PersistedRun }> => {
    if (typeof runId !== "string" || !runId.trim()) throw new WorkflowError("RESUME_INCOMPATIBLE", "workflow_retry requires an explicit run ID");
    const host = object(context) ? context : {};
    const cwd = typeof host.cwd === "string" ? host.cwd : undefined;
    const sessionManager = object(host.sessionManager) ? host.sessionManager : undefined;
    const sessionId = typeof sessionManager?.getSessionId === "function" ? String(Reflect.apply(sessionManager.getSessionId, sessionManager, [])) : undefined;
    if (!cwd || !sessionId) throw new WorkflowError("RESUME_INCOMPATIBLE", "workflow_retry requires the current project and Pi session");
    await ensureSessionLease(cwd, sessionId);
    const sourceStore = new RunStore(cwd, sessionId, runId, home);
    let loaded: { run: PersistedRun; snapshot: Readonly<LaunchSnapshot> };
    try { loaded = await sourceStore.load(); } catch (error) { throw new WorkflowError("RESUME_INCOMPATIBLE", `Unknown workflow run ${runId} in the current project and Pi session: ${errorText(error)}`); }
    assertExpectedWorkflowState(expectedState, loaded.run.state);
    if (loaded.run.state !== "failed") throw new WorkflowError("RESUME_INCOMPATIBLE", workflowRecoveryGuidance("retry", loaded.run.state));
    if (loaded.run.retry && (typeof loaded.run.retry.sourceRunId !== "string" || !loaded.run.retry.sourceRunId || typeof loaded.run.retry.lineageRootRunId !== "string" || !loaded.run.retry.lineageRootRunId || !Array.isArray(loaded.run.retry.completedPaths) || loaded.run.retry.completedPaths.some((path) => typeof path !== "string") || !Array.isArray(loaded.run.retry.incompletePaths) || loaded.run.retry.incompletePaths.some((path) => typeof path !== "string") || !Array.isArray(loaded.run.retry.namedWorktrees) || loaded.run.retry.namedWorktrees.some((name) => typeof name !== "string"))) throw new WorkflowError("RESUME_INCOMPATIBLE", "The source retry provenance is incomplete");
    const lineageRootRunId = loaded.run.retry?.lineageRootRunId ?? loaded.run.id;
    if (retryReservations.has(lineageRootRunId)) throw new WorkflowError("RESUME_INCOMPATIBLE", `An active retry already owns lineage ${lineageRootRunId}`);
    const activeStates = new Set<RunState>(["queued", "running", "pausing", "paused", "awaiting_input", "interrupted", "budget_exhausted"]);
    for (const candidateId of await listRunIds(cwd, sessionId, home)) {
      if (candidateId === runId) continue;
      const candidate = new RunStore(cwd, sessionId, candidateId, home);
      try {
        const candidateRun = (await candidate.load()).run;
        if (activeStates.has(candidateRun.state) && candidateRun.retry?.lineageRootRunId === lineageRootRunId) throw new WorkflowError("RESUME_INCOMPATIBLE", `An active retry child already exists for source lineage ${lineageRootRunId}`);
      } catch (error) {
        if (error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE") throw error;
      }
    }
    retryReservations.add(lineageRootRunId);
    let childStarted = false;
    try {
      const trustedProject = projectTrusted(context);
      await sourceStore.validateRetrySource();
      await sourceStore.validateBorrowedWorktrees();
      if (loaded.snapshot.identityVersion !== LAUNCH_SNAPSHOT_IDENTITY_VERSION) throw new WorkflowError("RESUME_INCOMPATIBLE", "Workflow launch snapshot identity version is incompatible");
      if (loaded.snapshot.roles === undefined) throw new WorkflowError("RESUME_INCOMPATIBLE", "Workflow role definitions are missing from the launch snapshot");
      if ((loaded.snapshot.projectRoles?.length ?? 0) > 0 && !trustedProject) throw new WorkflowError("RESUME_INCOMPATIBLE", "Cannot restore project roles in an untrusted project");
      const missingRole = loaded.snapshot.agentTypes.find((role) => !loaded.snapshot.roles?.[role]);
      if (missingRole) throw new WorkflowError("RESUME_INCOMPATIBLE", `Role definition is missing from the launch snapshot: ${missingRole}`);
      const modelRegistry = contextHostCapabilities(context).modelRegistry;
      const hostModel = object(host.model) && typeof host.model.provider === "string" && typeof host.model.id === "string" ? { provider: host.model.provider, id: host.model.id } : { provider: "", id: "" };
      const rootModel: ModelSpec = { provider: hostModel.provider, model: hostModel.id, thinking: pi.getThinkingLevel() };
      const { active, settingsPath, currentPolicy, knownModels, availableModels, currentAliases, blockedAliases, blockedAliasTargets, snapshot: childBaseSnapshot } = await resumeLaunchPrologue({ snapshot: loaded.snapshot, cwd, trustedProject, rootModel, ...(modelRegistry ? { modelRegistry } : {}), signal: signal ?? new AbortController().signal, withPreflight: true });
      await sourceStore.validateNamedWorktrees();
      for (const name of loaded.run.retry?.namedWorktrees ?? []) await sourceStore.resolveNamedWorktree(name);
      const completedPaths = (await sourceStore.replayableOperations()).map(({ path }) => path);
      const incompletePaths = incompleteRetryPaths([...(loaded.run.retry?.incompletePaths ?? []), ...loaded.run.agents.filter((agent) => agent.state !== "completed").map((agent) => operationPath("agent", ...(agent.structuralPath ?? [])))], completedPaths);
      const namedWorktrees = [...new Set([...(loaded.run.retry?.namedWorktrees ?? []), ...(await sourceStore.worktrees()).filter(({ owner }) => owner.startsWith(`${operationPath("worktree", "named")}/`)).map(({ owner }) => decodeURIComponent(owner.split("/").at(-1) ?? owner))])];
      const budget = validateBudget(loaded.run.budget ?? loaded.snapshot.budget);
      const childRunId = randomUUID();
      const childStore = new RunStore(cwd, sessionId, childRunId, home);
      const childSnapshot = childBaseSnapshot;
      const childBudget = new WorkflowBudgetRuntime(budget, loaded.run.budgetVersion ?? 1, loaded.run.usage, loaded.run.budgetEvents);
      const childInitialBudget = childBudget.snapshot();
      const retry: WorkflowRetryProvenance = { sourceRunId: loaded.run.id, lineageRootRunId, completedPaths, incompletePaths, namedWorktrees };
      await childStore.create({ id: childRunId, workflowName: loaded.snapshot.metadata.name, cwd, sessionId, state: "interrupted", parentRunId: loaded.run.id, retry, agents: [], agentSessions: [], ...(budget ? { budget } : {}), budgetVersion: loaded.run.budgetVersion ?? 1, ...childInitialBudget }, childSnapshot);
      const fallbackModel: ModelSpec = { provider: hostModel.provider, model: hostModel.id, thinking: pi.getThinkingLevel() };
      const model = modelSpec(loaded.snapshot.models[0] ?? "", fallbackModel);
      const lifecycle = lifecycleFor(childStore, "interrupted", childBudget, loaded.snapshot.metadata);
      const abortController = new AbortController();
      const providerErrorRecovery = createProviderErrorRecovery(context, availableModels, () => { abortController.abort(); });
      const providerPause = async () => { deliver(pi, `Workflow ${loaded.snapshot.metadata.name} paused: provider limit.`); await lifecycle.providerPause(); };
      const childRun = { executor: createAgentExecutor({ cwd, model, tools: activeSnapshotTools(loaded.snapshot.tools, active), availableModels, knownModels, modelAliases: currentAliases, blockedAliases, blockedAliasTargets, settingsPath, agentDefinitions: loaded.snapshot.roles ?? {}, runStore: childStore, providerPause, agentResourcePolicy: frozenResourcePolicy(currentPolicy) }), store: childStore, metadata: loaded.snapshot.metadata, model, lifecycle, budget: childBudget, abortController, projectTrusted: () => projectTrusted(context), checkpointResolvers: new Map(), ...(providerErrorRecovery ? { providerErrorRecovery } : {}) };
      runs.set(childRunId, childRun);
      scheduler.addRun(childRunId, loaded.snapshot.settings.concurrency, () => { childBudget.checkAgentLaunch(); });
      await eventPublisher.runStarted(childStore, loaded.snapshot.metadata);
      const { hasUI, ui } = recoveryUi(context);
      const completed = await coldResumeRun(childRun, hasUI, ui, trustedProject, { model: hostModel, modelRegistry, resolvedAliases: currentAliases, blockedAliases, blockedAliasTargets, ...(signal ? { signal } : {}) }, modeOverride);
      const completion = runs.get(childRunId)?.completion;
      if (completion) {
        childStarted = true;
        void completion.then(() => { retryReservations.delete(lineageRootRunId); }, () => { retryReservations.delete(lineageRootRunId); });
      } else if (completed) {
        childStarted = true;
        retryReservations.delete(lineageRootRunId);
      }
      if (completed) return { runId: childRunId, parentRunId: loaded.run.id, state: "completed", value: completed.value, run: (await childStore.load()).run };
      return { runId: childRunId, parentRunId: loaded.run.id, state: "running" };
    } finally {
      if (!childStarted) retryReservations.delete(lineageRootRunId);
    }
  };
  pi.registerTool({
    name: "workflow_retry",
    label: "Workflow Retry",
    description: "Retry a failed workflow run by replaying its completed structural operations",
    parameters: WORKFLOW_RETRY_PARAMETERS,
    async execute(_id, params, signal, _onUpdate, ctx) {
      try { const result = await retryWorkflowRun(params.runId, ctx, signal, params.foreground, params.expectedState); return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result }; }
      catch (error) { throw mainAgentError(error); }
    },
    renderCall(args, theme) { return styledTextBlock(workflowControlCall("workflow_retry", args, theme)); },
    renderResult(result, options, theme, context) { return workflowCatalogBlock(workflowControlResult("workflow_retry", context.args, result, options.expanded, theme, context.isError), options.expanded); },
  });
  pi.registerTool({
    name: "workflow_resume",
    label: "Workflow Resume",
    description: "Resume an exhausted workflow with unchanged or patched aggregate budgets",
    parameters: Type.Object({ runId: Type.String(), expectedState: Type.Optional(Type.String({ description: "Persisted source state observed before recovery" })), budget: Type.Optional(Type.Unknown()), foreground: Type.Optional(Type.Boolean({ description: "Override the source launch mode for this recovery" })) }, { additionalProperties: false }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      try { const result = await resumeWorkflowRun(params.runId, params.budget, ctx, signal, params.foreground, true, params.expectedState); return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result }; }
      catch (error) { throw mainAgentError(error); }
    },
    renderCall(args, theme) { return styledTextBlock(workflowControlCall("workflow_resume", args, theme)); },
    renderResult(result, options, theme, context) { return workflowCatalogBlock(workflowControlResult("workflow_resume", context.args, result, options.expanded, theme, context.isError), options.expanded); },
  });
  pi.on("session_start", async (_event, ctx) => {
    if (sessionStarted) return;
    sessionStarted = true;
    registry.freeze();
    registerCatalog(ctx.cwd, projectTrusted(ctx));
    await ensureSessionLease(ctx.cwd, ctx.sessionManager.getSessionId());
    try {
    for (const runId of await listRunIds(ctx.cwd, ctx.sessionManager.getSessionId(), home)) {
      if (runs.has(runId)) continue;
      const store = new RunStore(ctx.cwd, ctx.sessionManager.getSessionId(), runId, home);
      let loaded: { run: PersistedRun; snapshot: Readonly<LaunchSnapshot> };
      try { loaded = await store.load(); } catch { if (!await store.isComplete()) await store.delete(true).catch(() => undefined); continue; }
      if (loaded.run.state === "completed" || loaded.run.state === "failed" || loaded.run.state === "stopped") { terminalRunStates.set(runId, loaded.run.state); continue; }
      if (loaded.run.state !== "interrupted" && loaded.run.state !== "budget_exhausted") {
        const previousState = loaded.run.state;
        await store.updateState((current) => {
          if (["completed", "failed", "stopped", "interrupted", "budget_exhausted"].includes(current.state)) return current;
          const next = { ...current, state: "interrupted" as const };
          delete next.activeShells;
          return next;
        });
        loaded = { ...loaded, run: (await store.load()).run };
        await eventPublisher.runState(store, loaded.snapshot.metadata, previousState, "interrupted", "session_shutdown");
        loaded = { ...loaded, run: (await store.load()).run };
      } else if (loaded.run.activeShells !== undefined) {
        await store.updateState((current) => {
          if (["completed", "failed", "stopped"].includes(current.state)) return current;
          const next = { ...current };
          delete next.activeShells;
          return next;
        });
        loaded = { ...loaded, run: (await store.load()).run };
      }
      const model = modelSpec(loaded.snapshot.models[0] ?? "", { provider: ctx.model?.provider ?? "", model: ctx.model?.id ?? "", thinking: pi.getThinkingLevel() });
      const budget = validateBudget(loaded.run.budget ?? loaded.snapshot.budget);
      eventPublisher.seedBudget(runId, loaded.run.budgetEvents);
      const budgetRuntime = new WorkflowBudgetRuntime(budget, loaded.run.budgetVersion ?? 1, loaded.run.usage, loaded.run.budgetEvents, { active: loaded.run.state === "running" });
      const lifecycle = lifecycleFor(store, loaded.run.state, budgetRuntime, loaded.snapshot.metadata);
      const providerPause = async () => { deliver(pi, `Workflow ${loaded.snapshot.metadata.name} paused: provider limit.`); await lifecycle.providerPause(); };
      const roleDefinitions = loaded.snapshot.roles ?? {};
      const abortController = new AbortController();
      const providerErrorRecovery = createProviderErrorRecovery(ctx, new Set(loaded.snapshot.models), () => { abortController.abort(); });
      runs.set(runId, { executor: createAgentExecutor({ cwd: ctx.cwd, model, tools: activeSnapshotTools(loaded.snapshot.tools, "session"), availableModels: new Set(loaded.snapshot.models), knownModels: new Set(loaded.snapshot.models), ...(loaded.snapshot.modelAliases ?? loaded.snapshot.settings.modelAliases ? { modelAliases: loaded.snapshot.modelAliases ?? loaded.snapshot.settings.modelAliases } : {}), ...(loaded.snapshot.settingsSources?.modelAliases ? { settingsPath: loaded.snapshot.settingsSources.modelAliases } : loaded.snapshot.settingsPath ? { settingsPath: loaded.snapshot.settingsPath } : {}), agentDefinitions: roleDefinitions, runStore: store, providerPause, agentResourcePolicy: frozenResourcePolicy(snapshotResourcePolicy(loaded.snapshot, store.cwd, projectTrusted(ctx), workflowSettingsPath(extensionAgentDir))) }), store, metadata: loaded.snapshot.metadata, model, lifecycle, budget: budgetRuntime, abortController, projectTrusted: () => projectTrusted(ctx), checkpointResolvers: new Map(), ...(providerErrorRecovery ? { providerErrorRecovery } : {}) });
      for (const checkpoint of await store.awaitingCheckpoints()) deliver(pi, `Workflow ${loaded.snapshot.metadata.name} checkpoint ${checkpoint.name}: ${checkpoint.prompt}\nContext: ${JSON.stringify(checkpoint.context)}\nRespond with workflow_respond.`);
      for (const decision of await store.pendingWorkflowDecisions()) deliver(pi, budgetDecisionDelivery(loaded.snapshot.metadata, decision));
      scheduler.restoreRun(runId, loaded.snapshot.settings.concurrency, loaded.snapshot.identityVersion === LAUNCH_SNAPSHOT_IDENTITY_VERSION ? await store.loadOwnership() : [], () => runs.get(runId)?.budget.checkAgentLaunch());
    }
    const resumeSelect = uiHostCapabilities(ctx.ui)?.select;
    if (ctx.hasUI && resumeSelect) {
      const interrupted = [...runs.values()].filter((r) => r.lifecycle.state === "interrupted");
      if (interrupted.length > 0) {
        const labels = interrupted.map((r) => `Resume: ${r.metadata.name} (${r.store.runId.slice(0, 8)})`);
        const options = [...labels, ...(interrupted.length > 1 ? ["Resume all"] : []), "Skip"];
        const choice = await resumeSelect(`${String(interrupted.length)} interrupted workflow${interrupted.length > 1 ? "s" : ""} found`, options);
        if (choice && choice !== "Skip") {
          const toResume = choice === "Resume all" ? interrupted : interrupted.filter((_, i) => labels[i] === choice);
          for (const run of toResume) {
            try { await coldResumeRun(run, true, ctx.ui, projectTrusted(ctx), ctx); ctx.ui.notify(`Resumed workflow ${run.metadata.name}.`, "info"); }
            catch (err) { ctx.ui.notify(`Cannot resume ${run.metadata.name}: ${err instanceof Error ? err.message : String(err)}`, "warning"); }
          }
        }
      }
    }
    } catch (error) { await releaseSessionLease(); throw error; }
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (!pi.getActiveTools().includes("workflow")) return;
    const roles = Object.entries(loadAgentDefinitions(ctx.cwd, extensionAgentDir, projectTrusted(ctx), typeof registry.roleDirectoryRegistrations === "function" ? registry.roleDirectoryRegistrations() : undefined)).filter(([, definition]) => definition.description);
    if (!roles.length) return;
    const content = `Workflow role descriptions:\n${roles.map(([name, definition]) => `- \`${name}\`: ${String(definition.description)}`).join("\n")}`;
    return { systemPrompt: `${event.systemPrompt}\n\n${content}` };
  });
  pi.registerTool({
    name: "workflow",
    label: WORKFLOW_TOOL_LABEL,
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_TOOL_PROMPT_SNIPPET,
    parameters: WORKFLOW_TOOL_PARAMETERS,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
      const headless = object(ctx) && ctx.headless === true;
      const settingsPath = workflowSettingsPath(extensionAgentDir);
      if (!ctx.model) throw new WorkflowError("UNKNOWN_MODEL", "A launching model is required");
      const budget = validateBudget(params.budget);
      const rootModel: ModelSpec = { provider: ctx.model.provider, model: ctx.model.id, thinking: pi.getThinkingLevel() };
      const rootModelName = `${rootModel.provider}/${rootModel.model}`;
      const modelRegistry = contextHostCapabilities(ctx).modelRegistry;
      const inventory = modelInventory(rootModel, modelRegistry);
      const knownModels = inventory.knownModels;
      const availableModels = inventory.availableModels;
      const rootTools = pi.getActiveTools().filter((name) => !INTERNAL_WORKFLOW_TOOLS.includes(name));
      const trustedProject = projectTrusted(ctx);
      const launchCwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
      const launch = workflowLaunchSettings(launchCwd, trustedProject, settingsPath, params.concurrency);
      const runController = new AbortController();
      if (signal?.aborted) runController.abort(); else signal?.addEventListener("abort", () => { runController.abort(); }, { once: true });
      const resolvedAliases = await resolveLaunchAliases(registry, launch.settings.modelAliases ?? {}, { cwd: launchCwd, projectTrusted: trustedProject, rootModel, knownModels, availableModels, signal: runController.signal }, availableModels, knownModels, settingsPath);
      const modelAliases = resolvedAliases.aliases;
      const settings = Object.freeze({ ...launch.settings, ...(Object.keys(modelAliases).length ? { modelAliases } : {}) });
      const validated = validateWorkflowLaunchWithRegistry({ ...params, args: params.args }, { cwd: ctx.cwd, agentDir: extensionAgentDir, projectTrusted: trustedProject, availableModels, rootTools: new Set(rootTools), modelAliases, knownModels, settingsPath }, registry);
      const { script, checked, agentDefinitions, projectAgentDefinitions, roleNames, functionName } = validated;
      await ensureSessionLease(ctx.cwd, ctx.sessionManager.getSessionId());
      const runId = randomUUID();
      const args = (params.args ?? null) as JsonValue;
      encoded(args);
      const runContext = workflowRunContext(ctx.cwd, ctx.sessionManager.getSessionId(), runId, checked.metadata, args, runController.signal);
      const store = new RunStore(ctx.cwd, ctx.sessionManager.getSessionId(), runId, home);
      const parentRunId = params.parentRunId;
      if (parentRunId !== undefined) await store.validateParentRun(parentRunId);
      const roles = Object.fromEntries(roleNames.map((role) => [role, agentDefinitions[role]])) as Record<string, AgentDefinition>;
      const projectRoles = roleNames.filter((role) => projectAgentDefinitions[role] !== undefined);
      const roleModels = roleNames.flatMap((role) => { const model = agentDefinitions[role]?.model; return model ? [modelCapability(model, modelAliases, knownModels, settingsPath)] : []; });
      const snapshotModels = [...new Set([rootModelName, ...checked.referenced.models, ...roleModels])];
      const snapshot = createLaunchSnapshot({ script, args, metadata: checked.metadata, launchMode: params.foreground ? "foreground" : "background", settings, settingsPath, settingsSources: { ...launch.resolution.sources, concurrency: params.concurrency === undefined ? launch.resolution.sources.concurrency : "per-run options" }, ...(functionName ? { launchKind: "function" as const, functionName } : {}), ...(Object.keys(modelAliases).length ? { modelAliases } : {}), ...(budget ? { budget } : {}), ...(checked.referenced.phases.length ? { phases: checked.referenced.phases } : {}), models: snapshotModels, tools: rootTools, agentTypes: checked.referenced.agentTypes, roles, projectRoles, schemas: checked.schemas });
      let persistedSnapshot = snapshot;
      const captureFunctionRole = functionName ? async (role: string, model: ModelSpec): Promise<void> => {
        const definition = agentDefinitions[role];
        if (!definition) return;
        const modelName = `${model.provider}/${model.model}`;
        const hasProjectRole = projectAgentDefinitions[role] !== undefined;
        if (persistedSnapshot.roles?.[role] !== undefined && (!hasProjectRole || persistedSnapshot.projectRoles?.includes(role)) && persistedSnapshot.models.includes(modelName)) return;
        const roles = { ...(persistedSnapshot.roles ?? {}), [role]: definition };
        const projectRoles = hasProjectRole ? [...new Set([...(persistedSnapshot.projectRoles ?? []), role])] : persistedSnapshot.projectRoles ?? [];
        const models = [...new Set([...persistedSnapshot.models, modelName])];
        persistedSnapshot = createLaunchSnapshot({ ...persistedSnapshot, models, roles, projectRoles });
        await store.saveSnapshot(persistedSnapshot);
      } : undefined;
      const budgetRuntime = new WorkflowBudgetRuntime(budget);
      const initialBudget = budgetRuntime.snapshot();
      await store.create({ id: runId, workflowName: checked.metadata.name, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), state: "running", ...(parentRunId !== undefined ? { parentRunId } : {}), agents: [], agentSessions: [], delivery: params.foreground ? { mode: "foreground", state: "attached", toolCallId } : { mode: "background", state: "pending" }, ...(budget ? { budget } : {}), budgetVersion: 1, ...initialBudget }, snapshot);
      if (params.foreground) foregroundDeliveries.set(toolCallId, { store, inline: false });
      const lifecycle = lifecycleFor(store, "running", budgetRuntime, checked.metadata);
      const background = !params.foreground;
      const providerPause = async () => { if (background) deliver(pi, `Workflow ${checked.metadata.name} paused: provider limit.`); await lifecycle.providerPause(); };
      const providerErrorRecovery = createProviderErrorRecovery(ctx, availableModels, () => { runController.abort(); });
      const executor = createAgentExecutor({ cwd: ctx.cwd, model: rootModel, tools: new Set(rootTools), availableModels, knownModels, modelAliases, settingsPath, agentDefinitions, runStore: store, providerPause, agentResourcePolicy: frozenResourcePolicy(launch.resourcePolicy), runContext });
      runs.set(runId, { executor, store, metadata: checked.metadata, model: rootModel, lifecycle, budget: budgetRuntime, abortController: runController, projectTrusted: () => projectTrusted(ctx), checkpointResolvers: new Map(), ...(providerErrorRecovery ? { providerErrorRecovery } : {}), ...(params.foreground && onUpdate ? { update: onUpdate } : {}) });
      if (params.foreground && onUpdate) onUpdate(workflowToolUpdate((await store.load()).run));
      scheduler.addRun(runId, settings.concurrency, () => runs.get(runId)?.budget.checkAgentLaunch());
      const execution = runWorkflow(script, args, withWorkflowFunctions({ shell: (command, options, signal, identity) => shellForRun(store, checked.metadata, lifecycle, command, options, signal, identity), agent: workflowAgentHandler(store, checked.metadata, lifecycle, executor, ctx.cwd, runId, captureFunctionRole), worktree: async (owner) => resolveWorktree(store, checked.metadata, owner), checkpoint: checkpointBridge(runId, store, checked.metadata, Boolean(params.foreground), params.foreground && ctx.hasUI ? ctx.ui : undefined, headless), phase: phaseBridge(store, checked.metadata, lifecycle), log: logBridge(lifecycle, checked.metadata.name) }, store, runContext, registry), runController.signal);
      (runs.get(runId) as NonNullable<ReturnType<typeof runs.get>>).execution = execution;
      await eventPublisher.runStarted(store, checked.metadata);
      const finish = execution.result.then(async (value) => {
        await scheduler.flush();
        if (budgetRuntime.hardExhausted) throw new WorkflowError("BUDGET_EXHAUSTED", "Budgeted work was attempted after hard exhaustion");
        const resultPath = await store.saveResult(value);
        await lifecycle.terminal("completed", "completed");
        await eventPublisher.runCompleted(store, checked.metadata, resultPath);
        return { value, resultPath };
      }).catch(async (error: unknown) => {
        await scheduler.flush();
        const typed = error instanceof WorkflowError ? error : new WorkflowError("INTERNAL_ERROR", String(error));
        if (!["stopped", "interrupted", "budget_exhausted"].includes(lifecycle.state)) await lifecycle.terminal(typed.code === "CANCELLED" ? "stopped" : typed.code === "BUDGET_EXHAUSTED" ? "budget_exhausted" : "failed", typed.code);
        const persisted = await persistRunState(store, checked.metadata, (current) => persistedFailure({ ...current, ...budgetRuntime.snapshot() }, typed));
        const state = lifecycle.state === "stopped" || lifecycle.state === "interrupted" || lifecycle.state === "budget_exhausted" ? lifecycle.state : "failed";
        await eventPublisher.runFailed(store, checked.metadata, typed, state);
        const diagnostic = await createWorkflowFailureDiagnostics(store, checked.metadata, typed, persisted);
        Object.defineProperty(typed, WORKFLOW_FAILURE_DIAGNOSTICS, { value: diagnostic });
        if (params.foreground) pendingFailureDiagnostics.set(toolCallId, diagnostic);
        throw typed;
      });
      const completion = finish.finally(() => cleanupTerminalRun(runId));
      (runs.get(runId) as NonNullable<ReturnType<typeof runs.get>>).completion = completion;
      const deliverFailureContent = (error: unknown): string => {
        const diagnostic = failureDiagnosticsFrom(error);
        return diagnostic ? formatWorkflowFailureDelivery(diagnostic) : formatWorkflowFailureDeliveryFallback(checked.metadata.name, runId, store.directory, error);
      };
      const queueForegroundDelivery = async (content: string, failure = false): Promise<void> => {
        const delivery = foregroundDeliveries.get(toolCallId);
        if (!delivery) return;
        await store.updateState((current) => {
          if (!current.delivery || current.delivery.state === "delivered") return current;
          return { ...current, delivery: { ...current.delivery, mode: "background", state: "pending" } };
        });
        if (delivery.inline) return;
        scheduleForegroundDelivery(toolCallId, async () => {
          if (delivery.inline) return;
          pendingFailureDiagnostics.delete(toolCallId);
          await deliverTerminal(store, content, failure);
        });
      };
      if (background) {
        void completion.then(async ({ value, resultPath }) => {
          await deliverTerminal(store, completionDelivery(checked.metadata.name, value, resultPath, await store.changedWorktrees()));
        }, async (error: unknown) => {
          await deliverTerminal(store, deliverFailureContent(error), true);
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ runId, state: "running" }) }], details: { runId, preview: `Started workflow ${runId}.` } };
      }
      void completion.then(async ({ value, resultPath }) => {
        await queueForegroundDelivery(completionDelivery(checked.metadata.name, value, resultPath, await store.changedWorktrees()));
      }, async (error: unknown) => {
        await queueForegroundDelivery(deliverFailureContent(error), true);
      });
      const { value } = await completion;
      const run = (await store.load()).run;
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }, { type: "text" as const, text: `Workflow run ID: ${runId}` }], details: { runId, value, run } };
      } catch (error) {
        throw mainAgentError(error);
      }
    },
    renderCall(args) {
      return textBlock(formatWorkflowPreview(args));
    },
    renderResult(result, { isPartial }, theme, context) {
      const details = result.details;
      if (isWorkflowFailureDiagnostics(details)) return textBlock(formatWorkflowFailureDiagnostics(details));
      const runDetails = details as { run?: PersistedRun; value?: JsonValue; preview?: string } | undefined;
      const state = context.state as { workflowSpinner?: ReturnType<typeof setInterval>; workflowProgress?: WorkflowProgressRefreshState };
      if (runDetails?.run && isPartial && runDetails.run.state === "running" && !state.workflowSpinner) {
        state.workflowSpinner = setInterval(context.invalidate, 80);
        state.workflowSpinner.unref();
      } else if ((!isPartial || runDetails?.run?.state !== "running") && state.workflowSpinner) {
        clearInterval(state.workflowSpinner);
        delete state.workflowSpinner;
      }
      if (runDetails?.run) {
        const incoming = runDetails.run;
        let progress = state.workflowProgress;
        if (!isPartial || !progress || progress.runId !== incoming.id) {
          progress = undefined;
          delete state.workflowProgress;
          if (isPartial) {
            progress = { runId: incoming.id, inputRun: incoming, run: incoming, lastRefreshAt: 0, runtimeStartedAt: Date.now(), runtimeBaseMs: incoming.usage?.durationMs ?? 0 };
            state.workflowProgress = progress;
          }
        } else if (progress.inputRun !== incoming) {
          if (progress.run.state !== "running" && incoming.state === "running") {
            progress.runtimeBaseMs = incoming.usage?.durationMs ?? 0;
            progress.runtimeStartedAt = Date.now();
          }
          progress.inputRun = incoming;
          progress.run = incoming;
        }
        return workflowProgressBlock(progress?.run ?? incoming, theme, progress, async () => {
          const active = runs.get(incoming.id);
          const store = active?.store ?? new RunStore(incoming.cwd, incoming.sessionId, incoming.id, home);
          const loaded = await store.load();
          return withLiveActivities(loaded.run);
        }, () => { if (state.workflowProgress === progress) context.invalidate(); });
      }
      const content = result.content[0];
      return textBlock(isPartial ? "Workflow starting..." : runDetails?.preview ?? (content?.type === "text" ? content.text : "Workflow finished"));
    },
  });
  pi.registerCommand("workflow", {
    description: "Inspect and control workflows for this Pi session",
    handler: async (args, ctx) => {
      const command = args.trim();
      await ensureSessionLease(ctx.cwd, ctx.sessionManager.getSessionId());
      const loadStores = async () => {
        const entries = await Promise.all((await listRunIds(ctx.cwd, ctx.sessionManager.getSessionId(), home)).map(async (runId) => {
          const store = new RunStore(ctx.cwd, ctx.sessionManager.getSessionId(), runId, home);
          try { const loaded = await store.load(); return { store, loaded: { ...loaded, run: withLiveActivities(loaded.run) } }; }
          catch { if (!await store.isComplete()) await store.delete(true).catch(() => undefined); return undefined; }
        }));
        return entries.filter((entry): entry is { store: RunStore; loaded: { run: PersistedRun; snapshot: Readonly<LaunchSnapshot> } } => entry !== undefined);
      };
      let stores = await loadStores();
      const usage = "Usage: /workflow [model-aliases], or /workflow pause|resume|stop|approve|reject|delete <run-id> [checkpoint-name]. Approve/reject are for checkpoints only; use workflow_respond with a proposalId or the navigator's budget controls for budget decisions. Use workflow_resume for budget patches."
      const setWorkflowStatus = (text: string | undefined) => {
        const setStatus = uiHostCapabilities(ctx.ui)?.setStatus;
        setStatus?.call(ctx.ui, "workflow-stop", text);
      };
      const runAction = async (actionCommand: string, keepContext: boolean, status: (text: string | undefined) => void = setWorkflowStatus): Promise<"dashboard" | "picker" | "done"> => {
        const [action, runId, ...rest] = actionCommand.split(/\s+/);
        try {
          const run = runId ? runs.get(runId) : undefined;
          const storedEntry = runId ? stores.find(({ store }) => store.runId === runId) : undefined;
          const stored = storedEntry ? { store: storedEntry.store, loaded: await storedEntry.store.load() } : undefined;
          if ((action === "approve" || action === "reject") && runId && rest.length) {
            const accepted = await answerCheckpoint(runId, rest.join(" "), action === "approve", true);
            ctx.ui.notify(accepted ? `${action === "approve" ? "Approved" : "Rejected"} checkpoint ${rest.join(" ")}.` : "Checkpoint is not awaiting a response.", accepted ? "info" : "warning");
            return keepContext ? "dashboard" : "done";
          }
          if ((action === "budget-approve" || action === "budget-reject") && runId && rest[0]) {
            const result = await answerBudgetDecision(runId, rest[0], action === "budget-approve", true, ctx, undefined, false);
            ctx.ui.notify(result ? `Budget adjustment ${rest[0]} ${result.approved ? "approved" : "rejected"}.` : "Budget proposal is not pending.", result ? "info" : "warning");
            return keepContext ? "dashboard" : "done";
          }
          if (action === "delete" && stored) {
            if (!HARD_TERMINAL_RUN_STATES.has(stored.loaded.run.state)) { ctx.ui.notify("Stop the workflow before deleting it.", "warning"); return keepContext ? "dashboard" : "done"; }
            if (!await ctx.ui.confirm("Delete workflow?", `Delete ${stored.loaded.run.workflowName} (${stored.store.runId}) and all owned artifacts? This cannot be undone.`)) return keepContext ? "dashboard" : "done";
            await stored.store.delete(true); runs.delete(stored.store.runId); terminalRunStates.delete(stored.store.runId); ctx.ui.notify(`Deleted workflow ${stored.store.runId}.`, "info"); return keepContext ? "picker" : "done";
          }
          if (action === "pause" && run) { await run.lifecycle.pause(); ctx.ui.notify(`Paused workflow ${run.store.runId}.`, "info"); return keepContext ? "dashboard" : "done"; }
          if (action === "resume" && run) {
            if (run.lifecycle.state === "budget_exhausted") {
              const patch: unknown = rest.length ? JSON.parse(rest.join(" ")) as unknown : undefined;
              const result = await resumeWorkflowRun(run.store.runId, patch, ctx, undefined, undefined, false);
              ctx.ui.notify(result.state === "completed" ? `Workflow ${run.store.runId} completed.` : result.state === "running" ? `Resumed workflow ${run.store.runId}.` : `Budget adjustment for ${run.store.runId} is awaiting approval.`, result.state === "awaiting_approval" ? "warning" : "info");
            } else {
              if (run.lifecycle.state === "interrupted") await coldResumeRun(run, ctx.hasUI, ctx.ui, projectTrusted(ctx), ctx, undefined, false);
              else {
                if (run.lifecycle.state === "paused") await refreshPausedRunAliases(run, { ...resumeHostContext(ctx), projectTrusted: projectTrusted(ctx) });
                await run.lifecycle.resume();
              }
              ctx.ui.notify(`Resumed workflow ${run.store.runId}.`, "info");
            }
            return keepContext ? "dashboard" : "done";
          }
          if (action === "adjust" && run?.lifecycle.state === "budget_exhausted") {
            const input = await uiHostCapabilities(ctx.ui)?.input?.call(ctx.ui, "Budget patch (JSON)", "{\"tokens\":{\"hard\":null}}" );
            if (input === undefined) return keepContext ? "dashboard" : "done";
            const result = await resumeWorkflowRun(run.store.runId, JSON.parse(input), ctx, undefined, undefined, false);
            ctx.ui.notify(result.state === "completed" ? `Workflow ${run.store.runId} completed.` : result.state === "running" ? `Resumed workflow ${run.store.runId}.` : `Budget adjustment for ${run.store.runId} is awaiting approval.`, result.state === "awaiting_approval" ? "warning" : "info");
            return keepContext ? "dashboard" : "done";
          }
          if (action === "stop" && run) {
            const workflowName = stored?.loaded.run.workflowName ?? run.metadata.name;
            if (keepContext && !await ctx.ui.confirm("Stop workflow?", `Stop workflow ${workflowName} (${run.store.runId})? This cannot be undone.`)) return "dashboard";
            if (keepContext) status(`Stopping workflow ${workflowName}...`);
            await stopWorkflowRun(run.store.runId);
            if (keepContext) status(`Workflow ${run.store.runId} stopped.`);
            ctx.ui.notify(`Stopped workflow ${run.store.runId}.`, "info"); return keepContext ? "dashboard" : "done";
          }
          if (keepContext && action && runId) { ctx.ui.notify(`Cannot ${action} workflow ${runId}: the run is no longer available.`, "warning"); return "dashboard"; }
          ctx.ui.notify(usage, "warning");
          return "done";
        } catch (error) {
          if (!keepContext) throw error;
          const message = error instanceof Error ? error.message : String(error);
          if (action === "stop") status(`Could not stop workflow ${runId ?? ""}: ${message}`);
          ctx.ui.notify(`Cannot ${action ?? "workflow action"}${runId ? ` for ${runId}` : ""}: ${message}`, "warning");
          return "dashboard";
        }
      };
      const manageAliases = async (): Promise<void> => {
        const settingsPath = workflowSettingsPath(extensionAgentDir);
        let aliasSettingsPath = settingsPath;
        const trustedProject = projectTrusted(ctx);
        const modelRegistry = contextHostCapabilities(ctx).modelRegistry;
        const available = () => [...new Set((modelRegistry?.getAvailable?.() ?? []).map((model) => `${model.provider}/${model.id}`))].sort();
        const selectTarget = async (aliases: Readonly<Record<string, string>>): Promise<string | undefined> => {
          const models = available();
          const choice = await ctx.ui.select("Model alias target", [...models, ...Object.keys(aliases).sort(), "Manual model ID", "Back"]);
          if (!choice || choice === "Back") return undefined;
          if (choice !== "Manual model ID") return choice;
          return (await ctx.ui.input("Manual model ID", "provider/model[:thinking] or alias[:thinking]"))?.trim() || undefined;
        };
        const save = (aliases: Readonly<Record<string, string>>): boolean => {
          try { saveModelAliases(aliasSettingsPath, aliases); ctx.ui.notify(`Saved model aliases to ${aliasSettingsPath}.`, "info"); return true; }
          catch (error) { ctx.ui.notify(`${aliasSettingsPath}: ${error instanceof Error ? error.message : String(error)}`, "error"); return false; }
        };
        for (;;) {
          let aliases: Readonly<Record<string, string>>;
          try { const resolution = resolveWorkflowSettings(ctx.cwd, trustedProject, settingsPath); aliases = resolution.effective.modelAliases ?? {}; aliasSettingsPath = resolution.sources.modelAliases; }
          catch (error) { ctx.ui.notify(`${trustedProject ? workflowProjectSettingsPath(ctx.cwd) : settingsPath}: ${error instanceof Error ? error.message : String(error)}`, "error"); return; }
          const names = Object.keys(aliases).sort();
          const listing = names.length ? names.map((name) => `${name} = ${aliases[name] ?? ""}`).join("\n") : "(none)";
          const options = ["Add alias", ...names.map((name) => `Edit ${name}`), ...names.map((name) => `Delete ${name}`), "Back"];
          const choice = await ctx.ui.select(`Model aliases\n${listing}`, options);
          if (!choice || choice === "Back") return;
          if (choice === "Add alias") {
            const name = (await ctx.ui.input("Alias name", "reviewer-model"))?.trim();
            if (!name) continue;
            if (Object.prototype.hasOwnProperty.call(aliases, name)) { ctx.ui.notify(`Alias ${name} already exists; choose Edit ${name}.`, "warning"); continue; }
            const target = await selectTarget(aliases);
            if (!target) continue;
            const next = { ...aliases, [name]: target };
            try { validateModelAliases(next, aliasSettingsPath); } catch (error) { ctx.ui.notify(`${aliasSettingsPath}: ${error instanceof Error ? error.message : String(error)}`, "error"); continue; }
            const parsed = resolveModelReference(target, next, new Set(available()), aliasSettingsPath);
            if (!available().includes(`${parsed.provider}/${parsed.model}`)) {
              ctx.ui.notify(`Warning: ${target} is not currently available in Pi.`, "warning");
              if (!await ctx.ui.confirm("Save unknown model?", "Save this target for cross-machine portability?")) continue;
            }
            save(next);
            continue;
          }
          const edit = /^Edit (.+)$/.exec(choice);
          if (edit?.[1]) {
            const target = await selectTarget(aliases);
            if (!target) continue;
            const next = { ...aliases, [edit[1]]: target };
            try { validateModelAliases(next, aliasSettingsPath); } catch (error) { ctx.ui.notify(`${aliasSettingsPath}: ${error instanceof Error ? error.message : String(error)}`, "error"); continue; }
            const parsed = resolveModelReference(target, next, new Set(available()), aliasSettingsPath);
            if (!available().includes(`${parsed.provider}/${parsed.model}`)) {
              ctx.ui.notify(`Warning: ${target} is not currently available in Pi.`, "warning");
              if (!await ctx.ui.confirm("Save unknown model?", "Save this target for cross-machine portability?")) continue;
            }
            save(next);
            continue;
          }
          const deletion = /^Delete (.+)$/.exec(choice);
          if (deletion?.[1] && await ctx.ui.confirm("Delete model alias?", `Delete ${deletion[1]}? Future workflow resumes using this alias may fail.`)) {
            const next = Object.fromEntries(Object.entries(aliases).filter(([name]) => name !== deletion[1]));
            save(next);
          }
        }
      };
      if (command === "model-aliases") {
        if (!ctx.hasUI) { ctx.ui.notify("Model alias management requires UI.", "warning"); return; }
        await manageAliases();
        return;
      }
      if (!command) {
        for (;;) {
          if (!ctx.hasUI) {
            if (!stores.length) { ctx.ui.notify("No workflow runs in this session.", "info"); return; }
            const details = await Promise.all(stores.map(async ({ store, loaded }) => formatNavigatorRun(loaded, await store.awaitingCheckpoints(), await store.worktrees())));
            ctx.ui.notify(details.join("\n\n"), "info"); return;
          }
          const sorted = navigatorAttentionSort(stores);
          const labels = navigatorRunLabels(sorted);
          const terminalStates = HARD_TERMINAL_RUN_STATES;
          const hasCompleted = sorted.some(({ loaded: { run } }) => run.state === "completed");
          const hasFailed = sorted.some(({ loaded: { run } }) => run.state === "failed");
          const pickerOptions = [...labels, "Model aliases", "Close", ...(hasCompleted ? ["Delete all completed"] : []), ...(hasFailed ? ["Delete all failed"] : [])];
          const runChoice = await ctx.ui.select("Workflows\n", pickerOptions);
          if (!runChoice || runChoice === "Close") return;
          if (runChoice === "Model aliases") { await manageAliases(); stores = await loadStores(); continue; }
          if (runChoice === "Delete all completed") {
            if (!await ctx.ui.confirm("Delete completed runs?", "Delete all completed workflow runs and their artifacts? This cannot be undone.")) continue;
            for (const entry of sorted) {
              if (entry.loaded.run.state === "completed") { await entry.store.delete(true); runs.delete(entry.store.runId); terminalRunStates.delete(entry.store.runId); }
            }
            ctx.ui.notify("Deleted all completed workflow runs.", "info"); stores = await loadStores(); continue;
          }
          if (runChoice === "Delete all failed") {
            if (!await ctx.ui.confirm("Delete failed runs?", "Delete all failed workflow runs and their artifacts? This cannot be undone.")) continue;
            for (const entry of sorted) {
              if (entry.loaded.run.state === "failed") { await entry.store.delete(true); runs.delete(entry.store.runId); terminalRunStates.delete(entry.store.runId); }
            }
            ctx.ui.notify("Deleted all failed workflow runs.", "info"); stores = await loadStores(); continue;
          }
          const runIndex = labels.indexOf(runChoice);
          if (runIndex < 0) return;
          const selected = sorted[runIndex];
          if (!selected) return;
          const { store } = selected;
          const copyArtifact = async (value: string, artifact: string) => {
            try {
              await clipboard(value);
              ctx.ui.notify(`Copied ${artifact}.`, "info");
            } catch (error) {
              ctx.ui.notify(`Failed to copy ${artifact}: ${error instanceof Error ? error.message : String(error)}`, "error");
            }
          };
          const loadDashboard = async () => {
            const loaded = await store.load();
            const activeRun = runs.get(store.runId);
            const liveRun = withLiveActivities({ ...loaded.run, ...(activeRun ? { usage: activeRun.budget.usage } : {}) });
            const checkpoints = await store.awaitingCheckpoints();
            const worktrees = await store.worktrees();
            const completedOperations = ctx.mode === "tui" ? await store.replayableOperations().catch(() => []) : [];
            const agentResults = new Map<string, JsonValue>();
            for (const agent of liveRun.agents) {
              if (agent.state !== "completed" || agent.parentId || !agent.resultPath) continue;
              const operation = completedOperations.find((candidate) => candidate.path === agent.resultPath);
              if (operation) agentResults.set(agent.id, operation.value);
            }
            const actions = new Map<string, string>();
            const copies = new Map<string, { value: string; artifact: string }>();
            const reviews = new Map<string, AwaitingCheckpoint>();
            const add = (label: string, value: string) => { actions.set(label, `${value} ${store.runId}`); };
            const addCopy = (label: string, value: string, artifact: string) => { actions.set(label, "copy"); copies.set(label, { value, artifact }); };
            if (liveRun.state === "running") add("Pause", "pause");
            if (["paused", "interrupted"].includes(liveRun.state)) add("Resume", "resume");
            if (liveRun.state === "budget_exhausted") { actions.set("Resume unchanged", `resume ${store.runId}`); actions.set("Adjust budget", `adjust ${store.runId}`); }
            for (const decision of await store.pendingWorkflowDecisions()) {
              const id = decision.proposalId.slice(0, 8);
              actions.set(`Approve budget ${id}`, `budget-approve ${store.runId} ${decision.proposalId}`);
              actions.set(`Reject budget ${id}`, `budget-reject ${store.runId} ${decision.proposalId}`);
            }
            if (!terminalStates.has(liveRun.state)) add("Stop", "stop");
            for (const cp of checkpoints) {
              if (ctx.mode === "tui") {
                const label = `Review ${cp.name}`;
                actions.set(label, "review");
                reviews.set(label, cp);
              } else {
                actions.set(`Approve ${cp.name}`, `approve ${store.runId} ${cp.name}`);
                actions.set(`Reject ${cp.name}`, `reject ${store.runId} ${cp.name}`);
              }
            }
            if (ctx.mode !== "tui") actions.set("Refresh", "refresh");
            else actions.set("Open script in editor", "open-script");
            if (ctx.mode !== "tui" && liveRun.agents.length) actions.set("Agents...", "agents");
            if (terminalStates.has(liveRun.state)) add("Delete", "delete");
            if (ctx.mode === "tui") {
              addCopy("Copy run path", store.directory, "run path");
              addCopy("Copy run ID", store.runId, "run ID");
            }
            return { dashboard: formatWorkflowPhaseDashboard(liveRun, loaded.snapshot, process.stdout.columns || 80).join("\n"), phaseModel: buildWorkflowPhaseModel(liveRun, loaded.snapshot), run: liveRun, snapshot: loaded.snapshot, actions, copies, reviews, agentResults, agents: liveRun.agents, worktrees, cwd: liveRun.cwd };
          };
          const agentWorktreeFor = (dashboard: Awaited<ReturnType<typeof loadDashboard>>, agent: AgentRecord): WorktreeReference | undefined => agent.worktreeOwner ? dashboard.worktrees.find((candidate) => candidate.owner === agent.worktreeOwner) : undefined;
          const agentAttemptActionContext = (dashboard: Awaited<ReturnType<typeof loadDashboard>>, agent: AgentRecord): AgentAttemptActionContext | undefined => {
            const attempt = (agent.attemptDetails ?? []).reduce<AgentAttemptSummary | undefined>((latest, candidate) => !latest || candidate.attempt > latest.attempt ? candidate : latest, undefined);
            if (!attempt) return undefined;
            const liveCandidate = liveAgentSessions.get(`${dashboard.run.id}:${agent.id}`);
            const live = liveCandidate && attempt.session && liveCandidate.reference.transport === attempt.session.transport && liveCandidate.reference.sessionId === attempt.session.sessionId ? liveCandidate : undefined;
            const run = runs.get(dashboard.run.id);
            const ui = { notify: (message: string, level: "info" | "warning" | "error" = "info") => { ctx.ui.notify(message, level); }, confirm: (title: string, message: string) => ctx.ui.confirm(title, message), select: (title: string, options: readonly string[]) => { return ctx.ui.select(title, [...options]); }, input: (title: string, placeholder?: string) => ctx.ui.input(title, placeholder) };
            const attemptSnapshot = deepFreeze(structuredClone(attempt));
            const prepared = live ? liveAgentPrepared.get(`${dashboard.run.id}:${agent.id}`) : undefined;
            const handoff = live ? liveAgentHandoffs.get(`${dashboard.run.id}:${agent.id}`) : undefined;
            return { run: deepFreeze(structuredClone(dashboard.run)), agent: deepFreeze(structuredClone(agent)), attempt: attemptSnapshot, ...(attemptSnapshot.session ? { session: attemptSnapshot.session } : {}), ...(live ? { liveSession: live } : {}), ...(prepared ? { prepared } : {}), ...(handoff ? { handoff } : {}), signal: run?.abortController.signal ?? new AbortController().signal, ui: Object.freeze(ui) };
          };
          const visibleAgentAttemptActions = (dashboard: Awaited<ReturnType<typeof loadDashboard>>, agent: AgentRecord): readonly [string, import("./types.js").AgentAttemptAction][] => {
            const context = agentAttemptActionContext(dashboard, agent);
            if (!context) return [];
            return Object.entries(registry.agentAttemptActions()).filter(([, action]) => { try { return action.visible(context); } catch { return false; } });
          };
          const agentActionLabels = (dashboard: Awaited<ReturnType<typeof loadDashboard>>, agent: AgentRecord): string[] => {
            const worktree = agentWorktreeFor(dashboard, agent);
            return [
              ...visibleAgentAttemptActions(dashboard, agent).map(([, action]) => action.label),
              ...(worktree ? ["Copy branch", "Copy worktree path"] : []),
              ...(ctx.mode === "tui" && agent.prompt !== undefined ? ["Open prompt in editor"] : []),
              ...(ctx.mode === "tui" && agent.systemPrompt !== undefined ? ["Open system prompt in editor"] : []),
              ...(ctx.mode === "tui" && dashboard.agentResults.has(agent.id) ? ["Open result in editor"] : []),
              "Copy agent ID",
              "Back",
            ];
          };
          const selectAgent = async (dashboard: Awaited<ReturnType<typeof loadDashboard>>, requestedAgentId?: string): Promise<void> => {
            const byId = new Map(dashboard.agents.map((agent) => [agent.id, agent]));
            const title = (agent: AgentRecord): string => agentBreadcrumb(agent, byId, true);
            const labels = dashboard.agents.map((agent, index) => `#${String(index + 1)} ${title(agent)} [${agent.state}]`);
            let selected: AgentRecord | undefined;
            if (requestedAgentId) selected = dashboard.agents.find((agent) => agent.id === requestedAgentId);
            else {
              const selectedLabel = await ctx.ui.select("Agents", [...labels, "Back"]);
              const selectedIndex = selectedLabel ? labels.indexOf(selectedLabel) : -1;
              selected = selectedIndex >= 0 ? dashboard.agents[selectedIndex] : undefined;
            }
            if (!selected) return;
            const worktree = agentWorktreeFor(dashboard, selected);
            const actions = agentActionLabels(dashboard, selected);
            for (;;) {
              const action = await ctx.ui.select(title(selected), actions);
              if (!action || action === "Back") return;
              const extensionAction = visibleAgentAttemptActions(dashboard, selected).find(([, candidate]) => candidate.label === action);
              if (extensionAction) {
                const context = agentAttemptActionContext(dashboard, selected);
                if (context) { try { await extensionAction[1].run(context); } catch (error) { ctx.ui.notify(`Agent attempt action failed: ${error instanceof Error ? error.message : String(error)}`, "error"); } }
                return;
              }
              if (action === "Copy agent ID") { await copyArtifact(selected.id, "agent ID"); continue; }
              if (action === "Copy branch" && worktree) { await copyArtifact(worktree.branch, "branch"); continue; }
              if (action === "Copy worktree path" && worktree) { await copyArtifact(worktree.path, "worktree path"); continue; }
            }
          };
          for (;;) {
            let view = await loadDashboard();
            const actionChoice = ctx.mode === "tui"
              ? await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
                  let dashboardOffset = 0;
                  let refreshing = false;
                  let disposed = false;
                  let detailsMode = false;
                  let actionMode = false;
                  let actionIndex = 0;
                  let stopRequested = false;
                  let stopStatus: string | undefined;
                  let selectionNeedsScroll = true;
                  let renderedWidth = 80;
                  let refreshGeneration = 0;
                  const initialSelection = preserveWorkflowPhaseSelection(view.phaseModel, {});
                  let tree = buildWorkflowPhaseTree(view.phaseModel);
                  let selectedNodeId = initialSelection.nodeId ?? tree.nodes[0]?.id;
                  let expandedNodeIds = new Set(initialSelection.expandedNodeIds ?? workflowPhaseTreeInitialExpanded(tree));
                  const terminalRows = () => Math.max(1, tuiRows(tui) - WORKFLOW_PANEL_FOOTER_ROWS);
                  const keyLabels: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→", pageUp: "pgup", pageDown: "pgdn" };
                  const keyLabel = (binding: string, fallback: string) => workflowKeyLabel(keybindings, binding, fallback, keyLabels);
                  const selectedAgentRecord = (): AgentRecord | undefined => {
                    const node = selectedNodeId ? tree.byId.get(selectedNodeId) : tree.nodes[0];
                    return node?.kind === "agent" && node.agentId ? view.agents.find((agent) => agent.id === node.agentId) : undefined;
                  };
                  const actionOptions = () => {
                    const agent = selectedAgentRecord();
                    return agent ? agentActionLabels(view, agent) : [...view.actions.keys(), "Back"];
                  };
                  let editorRunning = false;
                  const openArtifact = async (artifact: Promise<WorkflowArtifact>, label: string): Promise<void> => {
                    if (editorRunning) return;
                    editorRunning = true;
                    try {
                      const command = SettingsManager.create(view.cwd, extensionAgentDir, { projectTrusted: projectTrusted(ctx) }).getExternalEditorCommand();
                      if (!command) { ctx.ui.notify(`Cannot open ${label}: no external editor is configured.`, "warning"); return; }
                      const exitCode = await openWorkflowArtifact(tui, command, await artifact);
                      if (exitCode !== 0) {
                        const detail = exitCode === null ? "could not be started" : `exited with code ${String(exitCode)}`;
                        ctx.ui.notify(`Cannot open ${label}: external editor ${detail}.`, "warning");
                      }
                    } catch (error) {
                      ctx.ui.notify(`Cannot open ${label}: ${error instanceof Error ? error.message : String(error)}`, "warning");
                    } finally {
                      editorRunning = false;
                    }
                  };
                  const updateDashboard = async () => {
                    const generation = ++refreshGeneration;
                    const hadExpandableNodes = tree.nodes.some((node) => node.children.length > 0);
                    const next = await loadDashboard();
                    if (disposed || generation !== refreshGeneration) return;
                    const previousNodeId = selectedNodeId;
                    const previousExpanded = expandedNodeIds;
                    const selectedAction = actionMode ? actionOptions()[actionIndex] : undefined;
                    view = next;
                    tree = buildWorkflowPhaseTree(view.phaseModel);
                    selectedNodeId = preserveWorkflowPhaseTreeSelection(tree, { nodeId: previousNodeId }).nodeId;
                    expandedNodeIds = new Set([...previousExpanded].filter((id) => tree.byId.has(id)));
                    if (!hadExpandableNodes && !expandedNodeIds.size && tree.nodes.some((node) => node.children.length > 0)) expandedNodeIds = new Set(workflowPhaseTreeInitialExpanded(tree));
                    const nextActions = actionOptions();
                    const preservedActionIndex = selectedAction ? nextActions.indexOf(selectedAction) : -1;
                    actionIndex = preservedActionIndex >= 0 ? preservedActionIndex : selectedAction ? nextActions.length - 1 : Math.min(actionIndex, Math.max(0, nextActions.length - 1));
                    selectionNeedsScroll = true;
                    tui.requestRender();
                  };
                  const requestStop = () => {
                    if (stopRequested) return;
                    stopRequested = true;
                    stopStatus = undefined;
                    setWorkflowStatus(undefined);
                    void runAction(`stop ${store.runId}`, true, (status) => {
                      stopStatus = status;
                      setWorkflowStatus(status);
                      if (!disposed) tui.requestRender();
                    }).then(() => updateDashboard()).catch((error: unknown) => {
                      if (disposed) return;
                      stopStatus = `Could not stop workflow ${store.runId}: ${error instanceof Error ? error.message : String(error)}`;
                      setWorkflowStatus(stopStatus);
                      tui.requestRender();
                    }).finally(() => {
                      stopRequested = false;
                      if (!disposed) tui.requestRender();
                    });
                  };
                  const timer = setInterval(() => {
                    if (refreshing || stopRequested) return;
                    refreshing = true;
                    void updateDashboard().catch(() => undefined).finally(() => { refreshing = false; });
                  }, 1000);
                  timer.unref();
                  return {
                    render(width: number) {
                      renderedWidth = width;
                      const narrow = width < 80;
                      const styles = themeWorkflowProgressStyles(theme);
                      const agent = selectedAgentRecord();
                      const actions = actionMode ? { title: agent ? "Agent actions" : "Run actions", options: actionOptions(), index: actionIndex } : undefined;
                      const phaseLines = formatWorkflowPhaseDashboard(view.run, view.snapshot, width, { nodeId: selectedNodeId, expandedNodeIds: [...expandedNodeIds], ...(narrow && !detailsMode ? { treeOnly: true } : {}), ...(narrow && detailsMode ? { detailsOnly: true } : {}), ...(actions ? { actions } : {}) }, styles);
                      const statusLines = stopStatus ? truncateToVisualLines(styles.error(stopStatus), Number.MAX_SAFE_INTEGER, width, 0).visualLines.map((line) => line.trimEnd()) : [];
                      const content = [...statusLines, ...phaseLines];
                      const rows = terminalRows();
                      const hintRows = rows >= 3 ? 1 : 0;
                      const viewport = Math.max(1, rows - hintRows);
                      const maxOffset = Math.max(0, content.length - viewport);
                      dashboardOffset = Math.max(0, Math.min(maxOffset, dashboardOffset));
                      if (actionMode) {
                        const label = actions?.options[actionIndex];
                        const actionRow = label ? content.findIndex((line) => line.includes(label)) : -1;
                        if (actionRow >= 0) {
                          if (actionRow < dashboardOffset) dashboardOffset = actionRow;
                          else if (actionRow >= dashboardOffset + viewport) dashboardOffset = actionRow - viewport + 1;
                        }
                      } else if (!detailsMode && selectionNeedsScroll) {
                        const selectedRow = content.findIndex((line) => line.startsWith("→"));
                        if (selectedRow >= 0) {
                          if (selectedRow < dashboardOffset) dashboardOffset = selectedRow;
                          else if (selectedRow >= dashboardOffset + viewport) dashboardOffset = selectedRow - viewport + 1;
                        }
                        selectionNeedsScroll = false;
                      }
                      dashboardOffset = Math.max(0, Math.min(maxOffset, dashboardOffset));
                      const hint = truncateToVisualLines(theme.fg("dim", actionMode ? `${keyLabel("tui.select.up", "↑")}/${keyLabel("tui.select.down", "↓")} actions · ${keyLabel("tui.select.confirm", "enter")} run · ${keyLabel("tui.editor.cursorLeft", "←")} tree · ${keyLabel("tui.select.cancel", "esc")} tree` : `${keyLabel("tui.select.up", "↑")}/${keyLabel("tui.select.down", "↓")} tree · ${keyLabel("tui.editor.cursorLeft", "←")}/${keyLabel("tui.editor.cursorRight", "→")} collapse/expand · ${keyLabel("tui.select.confirm", "enter")} inspect · a actions · ${keyLabel("tui.select.cancel", "esc")} ${narrow && detailsMode ? "tree" : "back"}${content.length > viewport ? ` · ${keyLabel("tui.select.pageUp", "pgup")}/${keyLabel("tui.select.pageDown", "pgdn")} scroll` : ""} · auto-refresh 1s`), Number.MAX_SAFE_INTEGER, width, 1).visualLines[0] ?? "";
                      return [...content.slice(dashboardOffset, dashboardOffset + viewport), ...(hintRows ? [hint] : [])];
                    },
                    invalidate() {},
                    handleInput(data: string) {
                      if (stopRequested || editorRunning) return;
                      const narrow = renderedWidth < 80;
                      if (!actionMode && (data === "a" || data === "A")) { actionMode = true; actionIndex = 0; dashboardOffset = 0; tui.requestRender(); return; }
                      if (actionMode) {
                        const options = actionOptions();
                        if (workflowKeyMatches(keybindings, data, "tui.select.cancel") || workflowKeyMatches(keybindings, data, "tui.editor.cursorLeft")) { actionMode = false; dashboardOffset = 0; tui.requestRender(); return; }
                        if (workflowKeyMatches(keybindings, data, "tui.select.up")) actionIndex = (actionIndex + options.length - 1) % options.length;
                        else if (workflowKeyMatches(keybindings, data, "tui.select.down")) actionIndex = (actionIndex + 1) % options.length;
                        else if (workflowKeyMatches(keybindings, data, "tui.select.pageUp")) dashboardOffset = Math.max(0, dashboardOffset - Math.max(1, terminalRows() - 1));
                        else if (workflowKeyMatches(keybindings, data, "tui.select.pageDown")) dashboardOffset += Math.max(1, terminalRows() - 1);
                        else if (workflowKeyMatches(keybindings, data, "tui.select.confirm")) {
                          const action = options[actionIndex];
                          const agent = selectedAgentRecord();
                          if (!action || action === "Back") { actionMode = false; dashboardOffset = 0; }
                          else if (agent) {
                            const worktree = agentWorktreeFor(view, agent);
                            if (action === "Open prompt in editor") {
                              if (agent.prompt !== undefined) void openArtifact(Promise.resolve(workflowPromptArtifact(agent.prompt)), "agent prompt");
                            }
                            else if (action === "Open system prompt in editor") {
                              if (agent.systemPrompt !== undefined) void openArtifact(Promise.resolve(workflowPromptArtifact(agent.systemPrompt)), "agent system prompt");
                            }
                            else if (action === "Open result in editor") {
                              const result = view.agentResults.get(agent.id);
                              if (result !== undefined) void openArtifact(Promise.resolve(workflowResultArtifact(result)), "agent result");
                            }
                            else if (action === "Copy agent ID") void copyArtifact(agent.id, "agent ID");
                            else if (action === "Copy branch" && worktree) void copyArtifact(worktree.branch, "branch");
                            else if (action === "Copy worktree path" && worktree) void copyArtifact(worktree.path, "worktree path");
                            else {
                              const extensionAction = visibleAgentAttemptActions(view, agent).find(([, candidate]) => candidate.label === action);
                              const actionContext = extensionAction ? agentAttemptActionContext(view, agent) : undefined;
                              if (extensionAction && actionContext) {
                                actionMode = false;
                                void Promise.resolve(extensionAction[1].run(actionContext)).catch((error: unknown) => { ctx.ui.notify(`Agent attempt action failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }).finally(() => { void updateDashboard(); });
                              }
                            }
                          }
                          else if (action === "Open script in editor") void openArtifact(readFile(join(store.directory, "workflow.js"), "utf8").then(workflowScriptArtifact), "workflow script");
                          else if (action === "Stop") requestStop();
                          else done(action);
                        }
                        tui.requestRender();
                        return;
                      }
                      const current = selectedNodeId ? tree.byId.get(selectedNodeId) : tree.nodes[0];
                      if (workflowKeyMatches(keybindings, data, "tui.select.cancel")) {
                        if (narrow && detailsMode) { detailsMode = false; selectionNeedsScroll = true; } else done("Back");
                      } else if (narrow && detailsMode) {
                        if (workflowKeyMatches(keybindings, data, "tui.select.pageUp")) dashboardOffset = Math.max(0, dashboardOffset - Math.max(1, terminalRows() - 1));
                        else if (workflowKeyMatches(keybindings, data, "tui.select.pageDown")) dashboardOffset += Math.max(1, terminalRows() - 1);
                        else if (workflowKeyMatches(keybindings, data, "tui.select.confirm")) {
                          if (current?.kind === "agent" && current.agentId) { actionMode = true; actionIndex = 0; }
                          else if (current?.children.length) { if (expandedNodeIds.has(current.id)) expandedNodeIds.delete(current.id); else expandedNodeIds.add(current.id); }
                        }
                      } else if (workflowKeyMatches(keybindings, data, "tui.editor.cursorLeft")) {
                        const next = navigateWorkflowPhaseTree(tree, selectedNodeId, expandedNodeIds, "left");
                        selectedNodeId = next.nodeId; expandedNodeIds = new Set(next.expandedNodeIds); selectionNeedsScroll = true;
                      } else if (workflowKeyMatches(keybindings, data, "tui.editor.cursorRight")) {
                        const next = navigateWorkflowPhaseTree(tree, selectedNodeId, expandedNodeIds, "right");
                        selectedNodeId = next.nodeId; expandedNodeIds = new Set(next.expandedNodeIds); selectionNeedsScroll = true;
                      } else if (workflowKeyMatches(keybindings, data, "tui.select.up")) {
                        const next = navigateWorkflowPhaseTree(tree, selectedNodeId, expandedNodeIds, "up");
                        selectedNodeId = next.nodeId; selectionNeedsScroll = true;
                      } else if (workflowKeyMatches(keybindings, data, "tui.select.down")) {
                        const next = navigateWorkflowPhaseTree(tree, selectedNodeId, expandedNodeIds, "down");
                        selectedNodeId = next.nodeId; selectionNeedsScroll = true;
                      } else if (workflowKeyMatches(keybindings, data, "tui.select.pageUp")) dashboardOffset = Math.max(0, dashboardOffset - Math.max(1, terminalRows() - 1));
                      else if (workflowKeyMatches(keybindings, data, "tui.select.pageDown")) dashboardOffset += Math.max(1, terminalRows() - 1);
                      else if (workflowKeyMatches(keybindings, data, "tui.select.confirm")) {
                        if (narrow) detailsMode = true;
                        else if (current?.kind === "agent" && current.agentId) { actionMode = true; actionIndex = 0; }
                        else if (current?.children.length) { if (expandedNodeIds.has(current.id)) expandedNodeIds.delete(current.id); else expandedNodeIds.add(current.id); }
                      }
                      tui.requestRender();
                    },
                    dispose() { disposed = true; clearInterval(timer); setWorkflowStatus(undefined); },
                  };
                })
              : await ctx.ui.select(view.dashboard, [...view.actions.keys(), "Back"]);
            if (!actionChoice || actionChoice === "Back") { stores = await loadStores(); break; }
            if (actionChoice === "Agents...") { await selectAgent(view); continue; }
            if (actionChoice.startsWith("__workflow_agent__:")) { await selectAgent(view, actionChoice.slice("__workflow_agent__:".length)); continue; }
            if (actionChoice === "Refresh") continue;
            const copy = view.copies.get(actionChoice);
            if (copy) { await copyArtifact(copy.value, copy.artifact); continue; }
            if (actionChoice.startsWith("Review ")) {
              const checkpoint = view.reviews.get(actionChoice);
              if (!checkpoint) continue;
              const decision = await ctx.ui.custom<"Approve" | "Reject" | undefined>((tui, theme, keybindings, done) => {
                const options = ["Approve", "Reject", "Cancel"];
                let selectedIndex = 0;
                let offset = 0;
                let renderedLines: string[] = [];
                const layout = () => {
                  const rows = Math.max(1, tuiRows(tui) - WORKFLOW_OVERLAY_BORDER_ROWS);
                  const compactControls = rows < 4;
                  const titleRows = rows >= 5 ? 1 : 0;
                  const hintRows = rows >= 8 ? 1 : 0;
                  const separatorRows = rows >= 8 ? 1 : 0;
                  const controlRows = compactControls ? 1 : options.length;
                  const contentViewport = Math.max(0, rows - titleRows - hintRows - separatorRows - controlRows);
                  return { rows, compactControls, titleRows, hintRows, separatorRows, contentViewport };
                };
                const move = (delta: number) => {
                  const maxOffset = Math.max(0, renderedLines.length - layout().contentViewport);
                  offset = Math.max(0, Math.min(maxOffset, offset + delta));
                };
                return borderWorkflowOverlay({
                  render(width: number) {
                    renderedLines = truncateToVisualLines(formatCheckpointReview(checkpoint), Number.MAX_SAFE_INTEGER, width, 0).visualLines;
                    const currentLayout = layout();
                    const maxOffset = Math.max(0, renderedLines.length - currentLayout.contentViewport);
                    offset = Math.min(offset, maxOffset);
                    const keyLabels: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→", pageUp: "pgup", pageDown: "pgdn" };
                    const keyLabel = (binding: string, fallback: string) => workflowKeyLabel(keybindings, binding, fallback, keyLabels);
                    const hint = truncateToVisualLines(theme.fg("dim", `${keyLabel("tui.select.up", "↑")}/${keyLabel("tui.select.down", "↓")}/pgup/pgdn scroll · enter select · esc cancel`), Number.MAX_SAFE_INTEGER, width, 1).visualLines[0] ?? "";
                    const controls = currentLayout.compactControls
                      ? [options.map((option, index) => `${index === selectedIndex ? "[" : " "}${option}${index === selectedIndex ? "]" : " "}`).join(" ")]
                      : options.map((option, index) => `${index === selectedIndex ? "→ " : "  "}${option}`);
                    return [
                      ...(currentLayout.titleRows ? [theme.fg("accent", "Checkpoint review")] : []),
                      ...renderedLines.slice(offset, offset + currentLayout.contentViewport),
                      ...(currentLayout.separatorRows ? [""] : []),
                      ...controls,
                      ...(currentLayout.hintRows ? [hint] : []),
                    ];
                  },
                  invalidate() {},
                  handleInput(data: string) {
                    if (workflowKeyMatches(keybindings, data, "tui.select.up")) selectedIndex = (selectedIndex + options.length - 1) % options.length;
                    else if (workflowKeyMatches(keybindings, data, "tui.select.down")) selectedIndex = (selectedIndex + 1) % options.length;
                    else if (workflowKeyMatches(keybindings, data, "tui.select.pageUp")) move(-layout().contentViewport);
                    else if (workflowKeyMatches(keybindings, data, "tui.select.pageDown")) move(layout().contentViewport);
                    else if (workflowKeyMatches(keybindings, data, "tui.select.confirm")) done(options[selectedIndex] === "Cancel" ? undefined : options[selectedIndex] as "Approve" | "Reject");
                    else if (workflowKeyMatches(keybindings, data, "tui.select.cancel")) done(undefined);
                    tui.requestRender();
                  },
                }, theme);
              }, { overlay: true, overlayOptions: WORKFLOW_OVERLAY_OPTIONS });
              if (decision) {
                const accepted = await answerCheckpoint(store.runId, checkpoint.name, decision === "Approve", true);
                if (!accepted) ctx.ui.notify("Checkpoint is not awaiting a response.", "warning");
              }
              continue;
            }
            const actionCommand = view.actions.get(actionChoice);
            if (!actionCommand) { ctx.ui.notify(`Cannot select workflow action: ${actionChoice}`, "warning"); continue; }
            const outcome = await runAction(actionCommand, true);
            if (outcome === "picker") { stores = await loadStores(); break; }
          }
        }
      }
      await runAction(command, false);
    },
  });
  pi.on("session_shutdown", async () => {
    try {
      await Promise.all([...runs.entries()].map(async ([runId, run]) => {
        const isTerminal = SHUTDOWN_TERMINAL_RUN_STATES.has(run.lifecycle.state);
        if (!isTerminal) {
          try { await run.lifecycle.terminal("interrupted"); } catch (error) { if (!SHUTDOWN_TERMINAL_RUN_STATES.has(run.lifecycle.state)) throw error; }
          run.abortController.abort();
          run.execution?.cancel();
          await scheduler.cancelRun(runId);
        }
        await run.completion?.catch(() => undefined);
      }));
      await scheduler.flush();
    } finally {
      await releaseSessionLease();
      resetWorkflowRegistry();
    }
  });
}

function displayAgentName(label: string | undefined, role: string | undefined, model: ModelSpec): string {
  return label ?? role ?? model.model;
}

function modelSpec(value: string, fallback: ModelSpec): ModelSpec {
  try {
    const parsed = parseModelReference(value);
    return { ...parsed, ...(parsed.thinking || !fallback.thinking ? {} : { thinking: fallback.thinking }) };
  } catch {
    return fallback;
  }
}



