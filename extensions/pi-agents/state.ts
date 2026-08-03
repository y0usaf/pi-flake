/**
 * pi-agents child machinery module: child state, activity/usage collection,
 * result collection, timeout and activity helpers, the child's read/write/
 * edit/bash + report tools, and the panel tally. Per DESIGN.md: "child state,
 * subscribeChild, collectResult — machinery"; "createChildTools — thin
 * wrappers over pi built-ins — machinery"; "stripControlSequences, timeout
 * helpers, activity formatting — machinery".
 */
import type { Agent, AgentEvent, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import { createCodingTools, type Theme } from "@earendil-works/pi-coding-agent";
import {
	NO_ANSWER_VALUE,
	UNABLE_VALUE,
	renderQuestionLines,
	reportSchema,
	type ContractAnswer,
	type ContractBox,
	type ContractQuestion,
} from "./contract.js";
import { buildSafeEnv } from "./config.js";
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

export const modelLabel = (agent: Agent): string => `${agent.state.model.provider}/${agent.state.model.id}`;

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
	agent: Agent,
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
					agent.abort();
					reject(new AgentTimeoutError(childId, timeout));
				}, timeout * 1000);
			}),
		]);
	} catch (err) {
		if (timedOut) {
			await settleWithGrace([work, agent.waitForIdle()]);
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
// Contract machinery: normalization (ported from pi-interview protocol.ts),
// validation, prompt rendering, enforcement loop

// ---------------------------------------------------------------------------
// Child tools: pi built-ins + report
// ---------------------------------------------------------------------------

export function createChildTools(cwd: string): AgentTool<any>[] {
	return createCodingTools(cwd, {
		bash: { exposeSessionEnvironment: false, spawnHook: (context) => ({ ...context, env: buildSafeEnv() }) },
	}) as AgentTool<any>[];
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
	agent: Agent;
	/** Precomputed TUI label; the parent model is only in scope at spawn time. */
	modelDisplay: string;
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
}


function extractLastAssistantText(agent: Agent): string {
	const textParts = agent.state.messages
		.filter((msg): msg is AssistantMessage => msg.role === "assistant")
		.map((msg) => msg.content.filter((c): c is TextContent => c.type === "text").map((c) => c.text))
		.filter((parts) => parts.length > 0);
	return textParts.at(-1)?.join("") ?? "(no output)";
}

export function buildReportTool(childId: string, reports: string[]): AgentTool<typeof reportSchema> {
	return {
		name: "report",
		label: "Report",
		description:
			"Send a progress report to the parent agent. Use this for intermediate " +
			"findings; you may call it multiple times and every call is delivered. " +
			"Progress only — the run's result is your submit_answers contract submission.",
		parameters: reportSchema,
		execute: async (_toolCallId, params) => {
			reports.push(stripControlSequences(params.message));
			return {
				content: [{ type: "text", text: "Report delivered to parent." }],
				details: { childId, reportIndex: reports.length - 1 },
			};
		},
	};
}

/** Hide a zeroed usage bucket so the header only shows real usage. */
export function usageToDetails(usage: Usage): Usage | undefined {
	if (usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0 && usage.cost === 0) {
		return undefined;
	}
	return usage;
}


/** Subscribe to child events, push activity + reports to onUpdate. */
export function subscribeChild(
	child: Agent,
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

	const innerUnsub = child.subscribe((event: AgentEvent) => {
		if (event.type === "tool_execution_start") {
			push("tool_start", formatToolActivity(event.toolName, event.args, theme));
		} else if (event.type === "tool_execution_end") {
			if (event.toolName === "report" && !event.isError) {
				const latest = state.reports.at(-1);
				if (latest) push("report", `report "${truncLine(stripControlSequences(latest), termBudget(2))}"`);
			} else {
				push("tool_end", `${event.toolName} ${event.isError ? "failed" : "done"}`);
			}
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			const msg = event.message as AssistantMessage;
			if (msg.usage) {
				state.usage.input += msg.usage.input;
				state.usage.output += msg.usage.output;
				state.usage.cacheRead += msg.usage.cacheRead;
				state.usage.cacheWrite += msg.usage.cacheWrite;
				state.usage.cost += msg.usage.cost.total;
			}
			const textParts = msg.content.filter((c): c is TextContent => c.type === "text");
			if (textParts.length > 0) {
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
		text = newReports.length > 0 ? newReports.join("\n---\n") : extractLastAssistantText(state.agent);
	}
	const error = state.agent.state.errorMessage;
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
