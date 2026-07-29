// Workflow runs rendered into the Pi transcript.
//
// Consumes the workflow:* events that pi-extensible-workflows publishes on
// Pi's shared EventBus. Writes nothing back; the engine does not know this
// extension exists, and its vendored tree is never patched. See DESIGN.md.
//
// Two surfaces, because Pi's two durable primitives have opposite capabilities:
//
//   - Finished phases become custom session entries (pi.appendEntry). Durable,
//     scrollable, survive /resume, invisible to the LLM. They cannot animate:
//     EntryRenderer receives (entry, { expanded }, theme) with no invalidate().
//   - The one in-flight phase lives in a widget (ctx.ui.setWidget). Animates,
//     but is ephemeral and vanishes on restart.
//
// A phase is committed from widget to entry exactly when it ends, so every
// agent appears in precisely one place at a time.
//
// Grouping comes from phaseHistory, not structuralPath: across every run on
// disk, phaseHistory is populated and structuralPath is empty in all but one.
// The engine's phaseBridge() writes the history entry and emits
// workflow:phase-changed after scheduler.flush(), so phases are hard barriers
// and no agent ever straddles one.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  WORKFLOW_AGENT_STATE_CHANGED_EVENT,
  WORKFLOW_BUDGET_EVENT,
  WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT,
  WORKFLOW_PHASE_CHANGED_EVENT,
  WORKFLOW_RUN_COMPLETED_EVENT,
  WORKFLOW_RUN_FAILED_EVENT,
  WORKFLOW_RUN_RESUMED_EVENT,
  WORKFLOW_RUN_STARTED_EVENT,
  WORKFLOW_RUN_STATE_CHANGED_EVENT,
  WORKFLOW_WORKTREE_CREATED_EVENT,
  type WorkflowAgentStateChangedEvent,
  type WorkflowBudgetEvent,
  type WorkflowCheckpointStateChangedEvent,
  type WorkflowEventBase,
  type WorkflowPhaseChangedEvent,
  type WorkflowRunFailedEvent,
  type WorkflowRunStateChangedEvent,
  type WorkflowWorktreeCreatedEvent,
} from "./types.js";

/** Every event name this renderer subscribes to, for the diagnostic command. */
const SUBSCRIBED_EVENTS = [
  WORKFLOW_RUN_STARTED_EVENT,
  WORKFLOW_RUN_RESUMED_EVENT,
  WORKFLOW_RUN_STATE_CHANGED_EVENT,
  WORKFLOW_RUN_COMPLETED_EVENT,
  WORKFLOW_RUN_FAILED_EVENT,
  WORKFLOW_AGENT_STATE_CHANGED_EVENT,
  WORKFLOW_PHASE_CHANGED_EVENT,
  WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT,
  WORKFLOW_BUDGET_EVENT,
  WORKFLOW_WORKTREE_CREATED_EVENT,
] as const;

/**
 * Runtime shape guard.
 *
 * Payloads cross the EventBus as `unknown`. The publisher is now in this same
 * package, so the types agree by construction, but the bus itself is untyped and
 * any extension may emit on any channel.
 */
function isWorkflowEvent(value: unknown): value is WorkflowEventBase {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<WorkflowEventBase>;
  return typeof event.runId === "string" && typeof event.workflowName === "string";
}

export const WORKFLOW_PHASE_ENTRY = "workflow-phase";
export const WORKFLOW_RUN_ENTRY = "workflow-run";

const WIDGET_KEY = "workflow-live";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;
const MAX_WIDGET_AGENTS = 12;

// ---------------------------------------------------------------------------
// Entry payloads. These land verbatim in the session JSONL, so they must stay
// JSON and self-contained: a renderer running after /resume has nothing else.
// ---------------------------------------------------------------------------

interface AgentRow {
  id: string;
  label: string;
  role?: string;
  state: string;
  depth: number;
  attempt: number;
  durationMs?: number;
}

export interface PhaseEntryData {
  runId: string;
  workflowName: string;
  phase: string;
  agents: AgentRow[];
  worktrees: string[];
  checkpoints: { name: string; state: string }[];
  budgetNotes: string[];
  startedAt: number;
  endedAt: number;
}

export interface RunEntryData {
  runId: string;
  workflowName: string;
  outcome: "completed" | "failed" | "stopped" | "interrupted" | "budget_exhausted";
  detail?: string;
  runDirectory: string;
  agentCount: number;
  phaseCount: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Glyphs and formatting. Kept pure so they are testable without a TUI.
// ---------------------------------------------------------------------------

export function agentGlyph(state: string, spinner: string): string {
  switch (state) {
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "cancelled":
      return "∅";
    case "running":
    case "waiting_for_child":
      return spinner;
    case "retrying":
      return "↻";
    case "paused":
      return "⏸";
    default:
      return "·";
  }
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return "";
  if (ms < 1000) return `${String(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

/**
 * Indentation for one agent row.
 *
 * Depth comes from structuralPath length when the engine recorded one, and is
 * 0 otherwise. Phase grouping already supplies one level, so this only adds
 * nesting for the rare parallel(...) run that populates paths.
 */
function indent(depth: number): string {
  return "  ".repeat(Math.max(0, depth) + 1);
}

function agentLine(agent: AgentRow, spinner: string): string {
  const parts = [`${indent(agent.depth)}${agentGlyph(agent.state, spinner)} ${agent.label}`];
  if (agent.role) parts.push(`(${agent.role})`);
  if (agent.attempt > 1) parts.push(`attempt ${String(agent.attempt)}`);
  const duration = formatDuration(agent.durationMs);
  if (duration) parts.push(duration);
  return parts.join("  ");
}

/**
 * Minimal structural Component: pi-tui is not a dependency of this package, so
 * blocks are built the same way host.ts builds them, by satisfying the
 * `{ render(width): string[]; invalidate(): void }` shape directly.
 */
function linesBlock(lines: readonly string[]) {
  return {
    render(width: number): string[] {
      const safeWidth = Math.max(1, width);
      return lines.flatMap((line) => line.split("\n")).map((line) =>
        line.length <= safeWidth ? line : `${line.slice(0, Math.max(0, safeWidth - 1))}…`,
      );
    },
    invalidate(): void {},
  };
}

// ---------------------------------------------------------------------------
// Live phase accumulator. One per active run.
// ---------------------------------------------------------------------------

class PhaseAccumulator {
  readonly agents = new Map<string, AgentRow>();
  readonly worktrees: string[] = [];
  readonly checkpoints: { name: string; state: string }[] = [];
  readonly budgetNotes: string[] = [];
  readonly startedAt = Date.now();

  constructor(readonly phase: string) {}

  get isEmpty(): boolean {
    return (
      this.agents.size === 0 &&
      this.worktrees.length === 0 &&
      this.checkpoints.length === 0 &&
      this.budgetNotes.length === 0
    );
  }

  freeze(runId: string, workflowName: string): PhaseEntryData {
    return {
      runId,
      workflowName,
      phase: this.phase,
      agents: [...this.agents.values()],
      worktrees: [...this.worktrees],
      checkpoints: [...this.checkpoints],
      budgetNotes: [...this.budgetNotes],
      startedAt: this.startedAt,
      endedAt: Date.now(),
    };
  }
}

class RunTracker {
  current: PhaseAccumulator;
  readonly startedAt = Date.now();
  totalAgents = 0;
  phaseCount = 0;
  state = "running";

  constructor(
    readonly runId: string,
    readonly workflowName: string,
    readonly runDirectory: string,
  ) {
    // Runs without an explicit phase() call still need one bucket to group under.
    this.current = new PhaseAccumulator(workflowName);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export default function registerWorkflowTranscript(pi: ExtensionAPI): void {
  const runs = new Map<string, RunTracker>();
  let context: ExtensionContext | undefined;
  let spinnerTimer: NodeJS.Timeout | undefined;
  let spinnerFrame = 0;
  let entriesWritten = 0;

  // -- widget ---------------------------------------------------------------

  const clearWidget = (): void => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
    context?.ui.setWidget(WIDGET_KEY, []);
  };

  const paintWidget = (): void => {
    if (!context?.hasUI) return;
    if (runs.size === 0) {
      clearWidget();
      return;
    }
    const spinner = SPINNER[spinnerFrame % SPINNER.length] ?? "·";
    const lines: string[] = [];
    for (const run of runs.values()) {
      const elapsed = formatDuration(Date.now() - run.startedAt);
      lines.push(`${spinner} ${run.workflowName} · ${run.current.phase} · ${run.state} · ${elapsed}`);
      const agents = [...run.current.agents.values()];
      for (const agent of agents.slice(0, MAX_WIDGET_AGENTS)) lines.push(agentLine(agent, spinner));
      if (agents.length > MAX_WIDGET_AGENTS) {
        lines.push(`${indent(0)}… ${String(agents.length - MAX_WIDGET_AGENTS)} more`);
      }
      for (const checkpoint of run.current.checkpoints) {
        if (checkpoint.state === "awaiting") lines.push(`${indent(0)}⏸ checkpoint ${checkpoint.name} awaiting approval`);
      }
    }
    context.ui.setWidget(WIDGET_KEY, lines);
  };

  const startSpinner = (): void => {
    if (spinnerTimer || !context?.hasUI) return;
    spinnerTimer = setInterval(() => {
      spinnerFrame += 1;
      paintWidget();
    }, SPINNER_INTERVAL_MS);
    spinnerTimer.unref();
  };

  // -- entry commits --------------------------------------------------------

  /** Move the accumulated phase out of the widget and into the session log. */
  const commitPhase = (run: RunTracker): void => {
    if (run.current.isEmpty) return;
    run.phaseCount += 1;
    pi.appendEntry<PhaseEntryData>(WORKFLOW_PHASE_ENTRY, run.current.freeze(run.runId, run.workflowName));
    entriesWritten += 1;
  };

  const finishRun = (
    event: WorkflowEventBase,
    outcome: RunEntryData["outcome"],
    detail?: string,
  ): void => {
    const run = runs.get(event.runId);
    if (!run) return;
    commitPhase(run);
    runs.delete(event.runId);
    pi.appendEntry<RunEntryData>(WORKFLOW_RUN_ENTRY, {
      runId: run.runId,
      workflowName: run.workflowName,
      outcome,
      ...(detail ? { detail } : {}),
      runDirectory: run.runDirectory,
      agentCount: run.totalAgents,
      phaseCount: run.phaseCount,
      durationMs: Date.now() - run.startedAt,
    });
    entriesWritten += 1;
    if (runs.size === 0) clearWidget();
    else paintWidget();
  };

  // -- event subscriptions (full coverage of the ten workflow:* events) -----

  const on = <T extends WorkflowEventBase>(name: string, handler: (event: T) => void): void => {
    pi.events.on(name, (payload) => {
      // The wire contract is declared, not imported, so a changed payload shape
      // is rejected here rather than becoming a TypeError inside a renderer.
      if (!isWorkflowEvent(payload)) return;
      handler(payload as T);
    });
  };

  on<WorkflowEventBase>(WORKFLOW_RUN_STARTED_EVENT, (event) => {
    runs.set(event.runId, new RunTracker(event.runId, event.workflowName, event.runDirectory));
    startSpinner();
    paintWidget();
  });

  on<WorkflowEventBase>(WORKFLOW_RUN_RESUMED_EVENT, (event) => {
    if (!runs.has(event.runId)) {
      runs.set(event.runId, new RunTracker(event.runId, event.workflowName, event.runDirectory));
    }
    startSpinner();
    paintWidget();
  });

  on<WorkflowPhaseChangedEvent>(WORKFLOW_PHASE_CHANGED_EVENT, (event) => {
    const run = runs.get(event.runId);
    if (!run) return;
    commitPhase(run);
    run.current = new PhaseAccumulator(event.phase);
    paintWidget();
  });

  on<WorkflowAgentStateChangedEvent>(WORKFLOW_AGENT_STATE_CHANGED_EVENT, (event) => {
    const run = runs.get(event.runId);
    if (!run) return;
    const existing = run.current.agents.get(event.agentId);
    if (!existing) run.totalAgents += 1;
    run.current.agents.set(event.agentId, {
      id: event.agentId,
      label: event.displayLabel,
      ...(event.role ? { role: event.role } : {}),
      state: event.state,
      depth: event.structuralPath.length,
      attempt: event.attempt,
      ...(existing?.durationMs !== undefined ? { durationMs: existing.durationMs } : {}),
    });
    paintWidget();
  });

  on<WorkflowCheckpointStateChangedEvent>(WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, (event) => {
    const run = runs.get(event.runId);
    if (!run) return;
    const existing = run.current.checkpoints.find((entry) => entry.name === event.name);
    if (existing) existing.state = event.state;
    else run.current.checkpoints.push({ name: event.name, state: event.state });
    paintWidget();
  });

  on<WorkflowWorktreeCreatedEvent>(WORKFLOW_WORKTREE_CREATED_EVENT, (event) => {
    const run = runs.get(event.runId);
    if (!run) return;
    run.current.worktrees.push(`${event.owner} → ${event.branch}`);
    paintWidget();
  });

  on<WorkflowBudgetEvent>(WORKFLOW_BUDGET_EVENT, (event) => {
    const run = runs.get(event.runId);
    if (!run) return;
    run.current.budgetNotes.push(`${event.type}: ${event.dimensions.join(", ")}`);
    paintWidget();
  });

  on<WorkflowRunStateChangedEvent>(WORKFLOW_RUN_STATE_CHANGED_EVENT, (event) => {
    const run = runs.get(event.runId);
    if (!run) return;
    run.state = event.state;
    paintWidget();
  });

  on<WorkflowEventBase>(WORKFLOW_RUN_COMPLETED_EVENT, (event) => {
    finishRun(event, "completed");
  });

  on<WorkflowRunFailedEvent>(WORKFLOW_RUN_FAILED_EVENT, (event) => {
    finishRun(event, "failed", `${event.error.code}: ${event.error.message}`);
  });

  // -- renderers ------------------------------------------------------------

  pi.registerEntryRenderer<PhaseEntryData>(WORKFLOW_PHASE_ENTRY, (entry, { expanded }, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    const failed = data.agents.some((agent) => agent.state === "failed");
    const header = `${failed ? "✗" : "▸"} ${theme.bold(data.phase)}`;
    const meta = `${String(data.agents.length)} agent${data.agents.length === 1 ? "" : "s"}  ${formatDuration(data.endedAt - data.startedAt)}`;
    const lines = [`${theme.fg(failed ? "error" : "accent", header)}  ${theme.fg("dim", meta)}`];

    for (const agent of data.agents) {
      const style = agent.state === "failed" ? "error" : agent.state === "completed" ? "success" : "muted";
      lines.push(theme.fg(style, agentLine(agent, "·")));
    }

    for (const checkpoint of data.checkpoints) {
      lines.push(theme.fg("warning", `${indent(0)}⏸ ${checkpoint.name}: ${checkpoint.state}`));
    }

    if (expanded) {
      for (const worktree of data.worktrees) lines.push(theme.fg("dim", `${indent(0)}⑂ ${worktree}`));
      for (const note of data.budgetNotes) lines.push(theme.fg("warning", `${indent(0)}$ ${note}`));
      lines.push(theme.fg("dim", `${indent(0)}run ${data.runId}`));
    }

    return linesBlock(lines);
  });

  pi.registerEntryRenderer<RunEntryData>(WORKFLOW_RUN_ENTRY, (entry, { expanded }, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    const ok = data.outcome === "completed";
    const summary = `${ok ? "✓" : "✗"} ${theme.bold(data.workflowName)} ${data.outcome}`;
    const meta = `${String(data.agentCount)} agents  ${String(data.phaseCount)} phases  ${formatDuration(data.durationMs)}`;
    const lines = [`${theme.fg(ok ? "success" : "error", summary)}  ${theme.fg("dim", meta)}`];
    if (data.detail) lines.push(theme.fg("error", `  ${data.detail}`));
    if (expanded) lines.push(theme.fg("dim", `  ${data.runDirectory}`));
    return linesBlock(lines);
  });


  // -- session lifecycle ----------------------------------------------------

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    if (runs.size > 0) {
      startSpinner();
      paintWidget();
    }
  });

  pi.on("session_shutdown", () => {
    clearWidget();
    runs.clear();
    context = undefined;
  });

  // -- diagnostics ----------------------------------------------------------

  // A renderer that has received nothing looks exactly like one that was never
  // loaded: both show an empty transcript. This reports its own wiring so the
  // two are distinguishable without a debugger. [[canon:unix]].
  //
  // It does not probe for the engine. The engine is the other entry point of
  // this same package, so if this command exists, the engine is loaded.
  pi.registerCommand("workflow-transcript", {
    description: "Report what the workflow transcript renderer is subscribed to and tracking",
    handler: async (_args, ctx) => {
      const workflowCommands = pi
        .getCommands()
        .map((command) => command.name)
        .filter((name) => name === "workflow" || name.startsWith("workflow:"));
      const lines = [
        `subscribed: ${SUBSCRIBED_EVENTS.length} events (${SUBSCRIBED_EVENTS.join(", ")})`,
        `engine commands registered: ${workflowCommands.length ? workflowCommands.join(", ") : "none"}`,
        `active runs: ${String(runs.size)}`,
        `entries written this session: ${String(entriesWritten)}`,
        `ui: ${ctx.hasUI ? "yes" : "no (widget disabled)"}`,
      ];
      for (const run of runs.values()) {
        lines.push(`  ${run.workflowName} ${run.runId} · phase ${run.current.phase} · ${String(run.current.agents.size)} agents`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
