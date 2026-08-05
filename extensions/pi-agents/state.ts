/**
 * pi-agents child machinery module: child state, activity/usage collection,
 * result collection, timeout and activity helpers, the ChildEngine RPC handle
 * interface (implemented by rpc-child.ts), the RPC event subscription that
 * feeds ChildState from a live child process, and the panel tally.
 * Per DESIGN.md: "child state, subscribeChild, collectResult — machinery";
 * "stripControlSequences, timeout helpers, activity formatting — machinery".
 *
 * The old in-process child tools (createChildTools/buildReportTool) and the
 * in-process `Agent` dependency were deleted in the stage-2 rpc-child
 * rewrite: children are literal `pi --mode rpc` subprocesses now.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	NO_ANSWER_VALUE,
	UNABLE_VALUE,
	renderQuestionLines,
	type ContractAnswer,
	type ContractBox,
	type ContractQuestion,
} from "./contract.js";
import { formatToolCall, stripControlSequences, termBudget, truncLine, type Usage } from "./render.js";

// ---------------------------------------------------------------------------
// Streaming details (shared between execute and renderers)
// ---------------------------------------------------------------------------

export interface ActivityItem {
	type: "tool_start" | "tool_end" | "report" | "text";
	label: string;
	timestamp: number;
}

export interface AgentToolDetails {
	childId: string;
	/** Background spawn handle / resumed ack results, plus the agent_list "(background)" marker. */
	background?: boolean;
	/** The background child's durable session JSONL path (background handles). */
	sessionFile?: string;
	/** agent_output status peek / mailbox pointer: the renderer shows the content text as-is. */
	peek?: boolean;
	nudges?: number;
	/** Child model as the TUI shows it: bare id, plus "[provider]" when it differs from the parent's. */
	model?: string;
	activity: ActivityItem[];
	reports: string[];
	/** Accumulated token/cost sums; undefined when everything is 0. */
	usage?: Usage;
	contract?: ContractQuestion[];
	answers?: ContractAnswer[];
	pendingAsk?: ContractQuestion[];
	error?: string;
	done: boolean;
	/** agent_loop interpreter state: status, generations, spawn budget, ledger. */
	loop?: unknown;
	panel?: { members: { id: string; model: string; answers: ContractAnswer[] | undefined; reports: string[]; usage?: Usage }[]; tally: PanelTally };
}

interface PanelTallyQuestion { questionId: string; prompt: string; freeText: boolean; unanimous: boolean; groups: { value: string; label: string; memberIds: string[]; count: number }[]; }
interface PanelTally { questions: PanelTallyQuestion[]; disagreementCount: number; }

/** Pure tally; free-text questions are never treated as consensus. */
export function tallyPanel(questions: ContractQuestion[], members: { id: string; model: string; answers: ContractAnswer[] | undefined }[]): PanelTally {
	let disagreementCount = 0;
	const result = questions.map((question) => {
		const freeText = question.options.filter((o) => o.value !== UNABLE_VALUE).length === 0 || members.some((member) => member.answers?.some((answer) => answer.id === question.id && answer.wasCustom === true));
		const groups = new Map<string, { value: string; label: string; memberIds: string[]; count: number }>();
		for (const member of members) {
			const answer = member.answers?.find((a) => a.id === question.id);
			const value = answer ? answer.value : NO_ANSWER_VALUE;
			const label = value === NO_ANSWER_VALUE ? "no answer" : value === UNABLE_VALUE ? "unable to determine" : (answer?.label ?? value);
			const group = groups.get(value) ?? { value, label, memberIds: [], count: 0 };
			group.memberIds.push(member.id); group.count++; groups.set(value, group);
		}
		const unanimous = groups.size === 1 && !groups.has(NO_ANSWER_VALUE);
		if (!freeText && !unanimous) disagreementCount++;
		return { questionId: question.id, prompt: question.prompt, freeText, unanimous, groups: [...groups.values()] };
	});
	return { questions: result, disagreementCount };
}

/**
 * Bare model id, with pi's muted "[provider]" badge (as /model renders it) only
 * when the child runs on a different provider than its parent.
 */
export const modelDisplay = (child: Model<any>, parent: Model<any>): string =>
	child.provider === parent.provider ? child.id : `${child.id} [${child.provider}]`;


// Cap on stored activity items to prevent unbounded growth during a run.
const MAX_ACTIVITY_STORAGE = 500;
const SHUTDOWN_GRACE_MS = 5000;

class AgentTimeoutError extends Error {
	constructor(childId: string, timeoutSeconds: number) {
		super(`Agent "${childId}" timed out after ${timeoutSeconds}s`);
		this.name = "AgentTimeoutError";
	}
}

/** Wait for all work to settle, but never longer than graceMs. */
export async function settleWithGrace(work: Array<Promise<unknown>>, graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
	await Promise.race([
		Promise.allSettled(work).then(() => undefined),
		new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
	]);
}

export async function withOptionalTimeout<T>(
	engine: { abort(): void; waitForIdle(): Promise<unknown> },
	childId: string,
	work: Promise<T>,
	timeout: number | undefined,
): Promise<T> {
	if (timeout === undefined) return await work;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("timeout_seconds must be a finite number greater than 0");
	}

	let handle: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;

	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				handle = setTimeout(() => {
					timedOut = true;
					engine.abort();
					reject(new AgentTimeoutError(childId, timeout));
				}, timeout * 1000);
			}),
		]);
	} catch (err) {
		if (timedOut) {
			await settleWithGrace([work, engine.waitForIdle()]);
		}
		throw err;
	} finally {
		clearTimeout(handle);
	}
}

function formatToolActivity(name: string, args: Record<string, unknown>, theme?: Theme): string {
	// Theme is always available via the module singleton in practice; fall back to a
	// plain label if a session ever schedules a child before a theme is captured.
	if (!theme) return `${name} ${JSON.stringify(args)}`.slice(0, 60);
	return formatToolCall(name, args, theme, false);
}

// ---------------------------------------------------------------------------
// ChildEngine / RPC event types (implemented by rpc-child.ts)
// ---------------------------------------------------------------------------

/** A JSONL line from a child `pi --mode rpc` process (event or response). */
export type ChildRpcEvent = { type: string } & Record<string, unknown>;

export interface ChildRpcResponse {
	type: string;
	success: boolean;
	id?: string;
	command?: string;
	data?: unknown;
	error?: string;
}

/**
 * Live handle to a child `pi --mode rpc` process. Implemented by rpc-child.ts;
 * owned by ChildState so the registry and abort paths can tear it down
 * identity-checked exactly like the old in-process Agent.
 */
export interface ChildEngine {
	readonly pid: number;
	/** The child's durable session JSONL path, from get_state. */
	readonly sessionFile?: string;
	/** Process alive and not yet torn down (schedule-wise; exit may be in flight). */
	readonly alive: boolean;
	readonly exitError: Error | undefined;
	/** Subscribe to the child's RPC event stream; returns an unsubscribe. */
	onEvent(listener: (event: ChildRpcEvent) => void): () => void;
	/** Subscribe to process exit; fires once (immediately if already exited). */
	onExit(listener: (info: { code: number | null; signal: string | null }) => void): () => void;
	/** Send an RPC command; resolves with the matching response record. */
	send(command: Record<string, unknown>): Promise<ChildRpcResponse>;
	/** Fire-and-forget graceful teardown (SIGTERM, then SIGKILL after the grace window). */
	abort(): void;
	/** Awaitable graceful teardown (SIGTERM, then SIGKILL after the grace window). */
	stop(): Promise<void>;
	/** Resolve once the child process has exited. */
	waitForIdle(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Child state
// ---------------------------------------------------------------------------

export interface ChildState {
	id: string;
	parentId?: string;
	rootId: string;
	depth: number;
	cwd: string;
	createdAt: number;
	/** Live RPC subprocess engine; null only for a state whose spawn produced no process. */
	engine: ChildEngine | null;
	/** Precomputed TUI label; the parent model is only in scope at spawn time. */
	modelDisplay: string;
	/** Full "provider/id" key for agent_list lines. */
	modelKey: string;
	/** Post-run error message surfaced by collectResult (undefined = success/suspend). */
	errorMessage?: string;
	reports: string[];
	activity: ActivityItem[];
	panelMember?: boolean;
	/** The deliverable for this agent's single run. */
	contract: ContractBox;
	/** Set while the spawn run is in flight; guards teardown ordering. */
	locked: boolean;
	/** Set by killSubtree. The owning run removes this state once its prompt settles. */
	killed: boolean;
	/** Cursor into reports already returned to the caller. */
	reportCursor: number;
	/** Number of upward asks made by this agent. */
	askCount: number;
	/** Number of contract nudges sent to this agent. */
	nudges: number;
	/** Timestamp when the current ask became pending. */
	awaitingSince?: number;
	/** Accumulated token/cost sums across the child's assistant messages. */
	usage: Usage;
	/** Last assistant text (for the report-only fallback in collectResult). */
	lastAssistantText: string;
	/** The child's durable session JSONL path from get_state; included in agent_list lines. */
	sessionFile?: string;
	/**
	 * Detached background run (background spawns). The promise never rejects —
	 * it resolves with the run's AgentToolResult (parked in the registry mailbox
	 * on fulfill/error, or the suspension result directly on ask_parent), so an
	 * unhandled rejection can never surface outside the extension. Replaced on
	 * agent_answer resume with the resumed run's promise.
	 */
	background?: { promise: Promise<AgentToolResult<AgentToolDetails>> };
	/** Spawn-time timeout_seconds; reused for detached resumes after ask_parent. */
	timeoutSeconds?: number;
}


/** Hide a zeroed usage bucket so the header only shows real usage. */
export function usageToDetails(usage: Usage): Usage | undefined {
	if (usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0 && usage.cost === 0) {
		return undefined;
	}
	return usage;
}

interface ChildRpcUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

const usageFromMessage = (message: { usage?: ChildRpcUsage }): Usage | undefined => {
	const msg = message.usage;
	if (!msg) return undefined;
	return {
		input: msg.input ?? 0,
		output: msg.output ?? 0,
		cacheRead: msg.cacheRead ?? 0,
		cacheWrite: msg.cacheWrite ?? 0,
		cost: msg.cost?.total ?? 0,
	};
};

/**
 * Subscribe to an RPC child's event stream, push activity + reports + usage
 * into ChildState, and schedule TUI partial updates. RPC events are the same
 * AgentSessionEvent family the in-process Agent emitted; tool args arrive on
 * tool_execution_start (absent on end), so the tool-start label is rendered
 * from the start args. Reports are appended by the drive loop's
 * tool_execution_start handler (state.reports); the end handler renders the
 * "report" activity line from the just-appended entry.
 */
export function subscribeRpcChild(
	child: ChildEngine,
	childId: string,
	state: ChildState,
	onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void,
	theme?: Theme,
): () => void {
	let emitPending = false;
	let unsubscribed = false;
	const emit = () => {
		if (!emitPending && onUpdate && !unsubscribed) {
			emitPending = true;
			queueMicrotask(() => {
				emitPending = false;
				if (unsubscribed) return;
				onUpdate({
					content: [{ type: "text", text: `[${childId}] working...` }],
					details: {
						childId,
						model: state.modelDisplay,
						activity: [...state.activity],
						reports: [...state.reports],
						usage: usageToDetails(state.usage),
						done: false,
					},
				});
			});
		}
	};

	/** Append one activity item, trim storage, and schedule a partial update. */
	const push = (type: ActivityItem["type"], label: string) => {
		state.activity.push({ type, label, timestamp: Date.now() });
		if (state.activity.length > MAX_ACTIVITY_STORAGE) {
			state.activity = state.activity.slice(-MAX_ACTIVITY_STORAGE);
		}
		emit();
	};

	const innerUnsub = child.onEvent((event) => {
		if (event.type === "tool_execution_start") {
			push("tool_start", formatToolActivity(String(event.toolName), (event.args as Record<string, unknown> | undefined) ?? {}, theme));
		} else if (event.type === "tool_execution_end") {
			if (event.toolName === "report" && !event.isError) {
				const latest = state.reports.at(-1);
				if (latest) push("report", `report "${truncLine(stripControlSequences(latest), termBudget(2))}"`);
			} else {
				push("tool_end", `${String(event.toolName)} ${event.isError ? "failed" : "done"}`);
			}
		} else if (event.type === "message_end" && (event.message as { role?: string } | undefined)?.role === "assistant") {
			const message = event.message as { content?: Array<{ type: string; text?: string }>; usage?: ChildRpcUsage };
			const usage = usageFromMessage(message);
			if (usage) {
				state.usage.input += usage.input;
				state.usage.output += usage.output;
				state.usage.cacheRead += usage.cacheRead;
				state.usage.cacheWrite += usage.cacheWrite;
				state.usage.cost += usage.cost;
			}
			const textParts = (message.content ?? []).filter((c): c is { type: string; text: string } => c.type === "text" && typeof c.text === "string");
			if (textParts.length > 0) {
				state.lastAssistantText = stripControlSequences(textParts[0].text);
				push("text", truncLine(stripControlSequences(textParts[0].text.split("\n")[0]), termBudget(2)));
			}
		}
	});

	return () => {
		unsubscribed = true;
		innerUnsub();
	};
}


export function collectResult(childId: string, state: ChildState, reportStartIdx: number): AgentToolResult<AgentToolDetails> {
	const newReports = state.reports.slice(reportStartIdx);
	const answers = state.contract.answers;
	let text: string;
	if (answers) {
		const lines = answers.map((answer) => {
			if (answer.value === UNABLE_VALUE) return `- ${answer.id}: (unable to determine)`;
			if (answer.wasCustom) return `- ${answer.id}: ${answer.value}`;
			return `- ${answer.id}: ${answer.value} — ${answer.label}`;
		});
		text = `Contract fulfilled (${answers.length}/${state.contract.questions.length}):\n${lines.join("\n")}`;
		if (newReports.length > 0) text += `\n\nProgress reports:\n${newReports.join("\n---\n")}`;
	} else if (state.contract.pendingAsk) {
		const questions = state.contract.pendingAsk;
		text = `Agent "${childId}" asks ${questions.length} question(s) and stays alive awaiting your answers:\n${renderQuestionLines(questions).join("\n")}\nAnswer with agent_answer({ id: "${childId}", answers: [{ id, value }, ...] }), or agent_kill("${childId}") to abandon.`;
		if (newReports.length > 0) text += `\n\nProgress reports:\n${newReports.join("\n---\n")}`;
	} else {
		text = newReports.length > 0 ? newReports.join("\n---\n") : state.lastAssistantText || "(no output)";
	}
	const error = state.errorMessage;
	return {
		content: [{ type: "text", text: error ? `[Error]: ${error}\n\n${text}` : text }],
		details: {
			childId,
			nudges: state.nudges,
			model: state.modelDisplay,
			activity: [...state.activity],
			reports: [...newReports],
			usage: usageToDetails(state.usage),
			contract: [...state.contract.questions],
			answers: answers ? [...answers] : undefined,
			pendingAsk: state.contract.pendingAsk ? [...state.contract.pendingAsk] : undefined,
			error,
			done: true,
		},
	};
}
