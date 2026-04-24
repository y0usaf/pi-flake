import { Agent, type AgentEvent, type AgentTool, type AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Model, TextContent } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/**
 * pi-agents: minimal async, recursive, session-local sub-agents.
 *
 * One public tool: agent_task(action=start|check|wait|cancel|list).
 * Tasks are one-shot Agent runs. They start in the background, may start their
 * own descendant tasks with the same tool, and are cleaned up with the session.
 */

const MAX_DEPTH = 3;
const MAX_LIVE_TASKS = 16;
const MAX_ACTIVITY = 200;
const MAX_COMPLETED_TASKS = 64;
const DEFAULT_RUN_TIMEOUT_SECONDS = 10 * 60;

type TaskStatus = "running" | "completed" | "failed" | "cancelled" | "timed_out";
type TaskAction = "start" | "check" | "wait" | "cancel" | "list";

interface ActivityItem {
	type: "tool_start" | "tool_end" | "report" | "text";
	label: string;
	timestamp: number;
}

interface TaskDetails {
	id: string;
	status: TaskStatus;
	depth: number;
	parentId?: string;
	startedAt: number;
	finishedAt?: number;
	reports: string[];
	activity: ActivityItem[];
	result?: string;
	error?: string;
}

interface TaskState {
	id: string;
	parentId?: string;
	depth: number;
	cwd: string;
	systemPrompt: string;
	prompt: string;
	startedAt: number;
	finishedAt?: number;
	status: TaskStatus;
	agent: Agent;
	reports: string[];
	activity: ActivityItem[];
	result?: string;
	error?: string;
	done: Promise<void>;
	timeout?: ReturnType<typeof setTimeout>;
	unsubscribe?: () => void;
}

const reportSchema = Type.Object({
	message: Type.String({ description: "Progress, finding, or final note to report to the parent task." }),
});

const agentTaskSchema = Type.Object({
	action: StringEnum(["start", "check", "wait", "cancel", "list"] as const, {
		description: "start a background task, check it, wait for it, cancel it, or list visible tasks",
	}),
	id: Type.Optional(Type.String({ description: "Task id. Required for check/wait/cancel. Optional for start." })),
	task: Type.Optional(Type.String({ description: "Task prompt. Required for start." })),
	system_prompt: Type.Optional(Type.String({ description: "System prompt for the sub-agent. Optional for start." })),
	timeout_seconds: Type.Optional(Type.Number({ description: "For start: max runtime before cancellation. For wait: max time to wait in this call. check/list/cancel ignore this." })),
});

function textResult(text: string, details?: unknown): AgentToolResult<any> {
	return { content: [{ type: "text", text }], details };
}

function now() {
	return Date.now();
}

function normalizePositiveSeconds(value: number | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a finite number > 0`);
	return value;
}

function normalizeWaitSeconds(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 0) throw new Error("timeout_seconds must be a finite number >= 0");
	return value;
}

function sleep(ms: number, signal?: AbortSignal): Promise<"timeout" | "aborted"> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve("aborted");
		const handle = setTimeout(() => {
			cleanup();
			resolve("timeout");
		}, ms);
		const onAbort = () => {
			clearTimeout(handle);
			cleanup();
			resolve("aborted");
		};
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function waitForAbort(signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (!signal) return;
		if (signal.aborted) return resolve();
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

function extractLastAssistantText(agent: Agent): string {
	const messages = agent.state.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const parts = (msg as AssistantMessage).content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text);
			if (parts.length > 0) return parts.join("");
		}
	}
	return "(no output)";
}

function formatToolActivity(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "bash": {
			const command = String(args.command ?? "...");
			return `$ ${command.length > 80 ? command.slice(0, 80) + "…" : command}`;
		}
		case "read":
		case "write":
		case "edit":
		case "ls":
			return `${name} ${String(args.path ?? "...")}`;
		case "grep":
			return `grep ${String(args.pattern ?? "...")} in ${String(args.path ?? ".")}`;
		case "find":
			return `find ${String(args.pattern ?? "*")} in ${String(args.path ?? ".")}`;
		case "report": {
			const message = String(args.message ?? "");
			return `report ${JSON.stringify(message.length > 80 ? message.slice(0, 80) + "…" : message)}`;
		}
		case "agent_task":
			return `agent_task ${String(args.action ?? "...")} ${String(args.id ?? "")}`.trim();
		default: {
			const raw = JSON.stringify(args);
			return `${name} ${raw.length > 80 ? raw.slice(0, 80) + "…" : raw}`;
		}
	}
}

function pushActivity(task: TaskState, item: ActivityItem) {
	task.activity.push(item);
	if (task.activity.length > MAX_ACTIVITY) task.activity.splice(0, task.activity.length - MAX_ACTIVITY);
}

function subscribeTask(task: TaskState): () => void {
	return task.agent.subscribe((event: AgentEvent) => {
		if (event.type === "tool_execution_start") {
			pushActivity(task, {
				type: "tool_start",
				label: formatToolActivity(event.toolName, event.args),
				timestamp: now(),
			});
		} else if (event.type === "tool_execution_end") {
			if (event.toolName === "report" && !event.isError) {
				const latest = task.reports[task.reports.length - 1];
				if (latest) {
					pushActivity(task, {
						type: "report",
						label: latest.length > 80 ? latest.slice(0, 80) + "…" : latest,
						timestamp: now(),
					});
				}
			} else {
				pushActivity(task, {
					type: "tool_end",
					label: `${event.toolName} ${event.isError ? "failed" : "done"}`,
					timestamp: now(),
				});
			}
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message as AssistantMessage;
			const text = message.content.find((c): c is TextContent => c.type === "text")?.text;
			if (text) {
				const firstLine = text.split("\n")[0];
				pushActivity(task, {
					type: "text",
					label: firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine,
					timestamp: now(),
				});
			}
		}
	});
}

function serializeTask(task: TaskState, includeFull = false): TaskDetails {
	return {
		id: task.id,
		status: task.status,
		depth: task.depth,
		parentId: task.parentId,
		startedAt: task.startedAt,
		finishedAt: task.finishedAt,
		reports: includeFull ? [...task.reports] : task.reports.slice(-5),
		activity: includeFull ? [...task.activity] : task.activity.slice(-12),
		result: task.result,
		error: task.error,
	};
}

function resultText(task: TaskState): string {
	const data = serializeTask(task, true);
	if (task.status === "running") return JSON.stringify(data, null, 2);
	if (task.status === "completed") return task.result ?? "(no output)";
	return JSON.stringify(data, null, 2);
}

function isDescendant(tasks: Map<string, TaskState>, targetId: string, ancestorId: string): boolean {
	let current = tasks.get(targetId)?.parentId;
	while (current) {
		if (current === ancestorId) return true;
		current = tasks.get(current)?.parentId;
	}
	return false;
}

function visibleTasks(tasks: Map<string, TaskState>, callerId?: string): TaskState[] {
	const all = [...tasks.values()].filter((task) => !callerId || isDescendant(tasks, task.id, callerId));
	all.sort((a, b) => a.depth - b.depth || a.startedAt - b.startedAt || a.id.localeCompare(b.id));
	return all;
}

function assertVisible(tasks: Map<string, TaskState>, id: string, callerId?: string): TaskState {
	const task = tasks.get(id);
	if (!task) throw new Error(`Unknown task "${id}"`);
	if (callerId && !isDescendant(tasks, id, callerId)) {
		throw new Error(`Task "${id}" is outside this agent's descendant subtree.`);
	}
	return task;
}

function makeId(tasks: Map<string, TaskState>, requested: string | undefined): string {
	if (requested) {
		const id = requested.trim();
		if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("id may contain only letters, numbers, '.', '_' and '-'");
		if (tasks.has(id)) throw new Error(`Task "${id}" already exists`);
		return id;
	}
	let i = tasks.size + 1;
	while (tasks.has(`task-${i}`)) i++;
	return `task-${i}`;
}

function buildReportTool(task: TaskState): AgentTool<typeof reportSchema> {
	return {
		name: "report",
		label: "Report",
		description: "Send progress or findings to the parent. Final answer text is also captured automatically.",
		parameters: reportSchema,
		async execute(_toolCallId, params) {
			task.reports.push(params.message);
			return textResult("Report recorded.", { id: task.id, reportCount: task.reports.length });
		},
	};
}

function createStandardTools(cwd: string): AgentTool<any>[] {
	return [
		createReadTool(cwd),
		createWriteTool(cwd),
		createEditTool(cwd),
		createBashTool(cwd),
		createLsTool(cwd),
		createGrepTool(cwd),
		createFindTool(cwd),
	] as AgentTool<any>[];
}

export default function piAgents(pi: ExtensionAPI) {
	const tasks = new Map<string, TaskState>();
	let cachedGetApiKey: ((provider: string) => Promise<string | undefined>) | undefined;
	let cachedModel: Model<any> | undefined;
	let cachedCwd = process.cwd();

	function cleanupFinishedTasks() {
		const finished = [...tasks.values()]
			.filter((task) => task.status !== "running")
			.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
		while (finished.length > MAX_COMPLETED_TASKS) {
			const task = finished.shift()!;
			tasks.delete(task.id);
		}
	}

	function cancelSubtree(id: string, status: "cancelled" | "timed_out" = "cancelled", error?: string): string[] {
		const ids = [id, ...visibleTasks(tasks, id).map((task) => task.id)];
		for (const taskId of ids) {
			const task = tasks.get(taskId);
			if (!task || task.status !== "running") continue;
			task.status = status;
			task.error = error ?? status;
			task.finishedAt = now();
			clearTimeout(task.timeout);
			task.agent.abort();
		}
		return ids;
	}

	function createTaskTool(callerId?: string): AgentTool<typeof agentTaskSchema> {
		return {
			name: "agent_task",
			label: "Agent Task",
			description:
				"Start, check, wait for, cancel, or list async session-local sub-agent tasks. " +
				"Tasks are one-shot and may start descendant tasks with this same tool. " +
				`Visible tasks are scoped to your descendant subtree. Limits: maxDepth=${MAX_DEPTH}, maxLiveTasks=${MAX_LIVE_TASKS}.`,
			parameters: agentTaskSchema,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const action = params.action as TaskAction;
				cachedCwd = ctx?.cwd ?? cachedCwd;
				cachedModel = ctx?.model ?? cachedModel;

				if (action === "list") {
					const visible = visibleTasks(tasks, callerId).map((task) => serializeTask(task));
					return textResult(JSON.stringify({ ok: true, tasks: visible }, null, 2), { tasks: visible });
				}

				if (action === "check") {
					if (!params.id) throw new Error("id is required for check");
					const task = assertVisible(tasks, params.id, callerId);
					const details = serializeTask(task, true);
					return textResult(JSON.stringify({ ok: true, task: details }, null, 2), details);
				}

				if (action === "wait") {
					if (!params.id) throw new Error("id is required for wait");
					const task = assertVisible(tasks, params.id, callerId);
					const waitSeconds = normalizeWaitSeconds(params.timeout_seconds);
					if (task.status === "running") {
						if (waitSeconds === 0) {
							// Non-blocking check via wait timeout 0.
						} else if (waitSeconds === undefined) {
							await Promise.race([task.done, waitForAbort(signal)]);
						} else {
							await Promise.race([task.done, sleep(waitSeconds * 1000, signal)]);
						}
					}
					const details = serializeTask(task, true);
					return textResult(resultText(task), details);
				}

				if (action === "cancel") {
					if (!params.id) throw new Error("id is required for cancel");
					assertVisible(tasks, params.id, callerId);
					const cancelled = cancelSubtree(params.id, "cancelled", "cancelled by agent_task");
					return textResult(`Cancelled ${cancelled.length} task(s): ${cancelled.join(", ")}`, { cancelled });
				}

				if (action !== "start") throw new Error(`Unknown action: ${action}`);
				if (!params.task?.trim()) throw new Error("task is required for start");
				const liveCount = [...tasks.values()].filter((task) => task.status === "running").length;
				if (liveCount >= MAX_LIVE_TASKS) throw new Error(`maxLiveTasks ${MAX_LIVE_TASKS} reached`);

				if (!cachedModel) throw new Error("No model selected");
				if (!cachedGetApiKey) {
					if (!ctx) throw new Error("Cannot start task without extension context");
					cachedGetApiKey = (provider: string) => ctx.modelRegistry.getApiKeyForProvider(provider);
				}

				const parent = callerId ? tasks.get(callerId) : undefined;
				if (callerId && !parent) throw new Error(`Caller task "${callerId}" is no longer active`);
				const taskCwd = parent?.cwd ?? cachedCwd;
				const depth = (parent?.depth ?? 0) + 1;
				if (depth > MAX_DEPTH) throw new Error(`Cannot start task: depth ${depth} exceeds maxDepth ${MAX_DEPTH}`);

				const id = makeId(tasks, params.id);
				const runTimeout = normalizePositiveSeconds(params.timeout_seconds ?? DEFAULT_RUN_TIMEOUT_SECONDS, "timeout_seconds");
				const reports: string[] = [];
				const activity: ActivityItem[] = [];
				const systemPrompt = params.system_prompt?.trim() || "You are a concise, autonomous sub-agent. Complete the task, use report for important progress, and finish with a clear answer.";
				let task!: TaskState;

				const toolsFactory = () => [
					...createStandardTools(taskCwd),
					createTaskTool(id),
					buildReportTool(task),
				] as AgentTool<any>[];

				task = {
					id,
					parentId: callerId,
					depth,
					cwd: taskCwd,
					systemPrompt,
					prompt: params.task,
					startedAt: now(),
					status: "running",
					agent: undefined as unknown as Agent,
					reports,
					activity,
					done: Promise.resolve(),
				};

				task.agent = new Agent({
					initialState: { systemPrompt, model: cachedModel, tools: toolsFactory() },
					getApiKey: cachedGetApiKey,
				});
				tasks.set(id, task);
				task.unsubscribe = subscribeTask(task);

				if (runTimeout !== undefined) {
					task.timeout = setTimeout(() => {
						if (task.status !== "running") return;
						cancelSubtree(id, "timed_out", `timed out after ${runTimeout}s`);
					}, runTimeout * 1000);
				}

				const promptPromise = task.agent.prompt(params.task);
				task.done = promptPromise
					.then(() => {
						if (task.status !== "running") return;
						const agentError = task.agent.state.errorMessage;
						task.result = reports.length > 0 ? reports.join("\n---\n") : extractLastAssistantText(task.agent);
						task.error = agentError;
						task.status = agentError ? "failed" : "completed";
					})
					.catch((err) => {
						if (task.status === "timed_out" || task.status === "cancelled") return;
						task.status = "failed";
						task.error = err instanceof Error ? err.message : String(err);
					})
					.finally(() => {
						clearTimeout(task.timeout);
						task.finishedAt ??= now();
						task.unsubscribe?.();
						cleanupFinishedTasks();
					});
				// Ensure no unhandled background rejection can escape.
				task.done.catch(() => {});

				const details = serializeTask(task);
				return textResult(JSON.stringify({ ok: true, task: details }, null, 2), details);
			},
		};
	}

	pi.on("session_shutdown", async () => {
		for (const task of tasks.values()) {
			if (task.status === "running") {
				task.status = "cancelled";
				task.error = "session shutdown";
				task.finishedAt = now();
				task.agent.abort();
			}
			clearTimeout(task.timeout);
			task.unsubscribe?.();
		}
		await Promise.race([
			Promise.allSettled([...tasks.values()].map((task) => task.done)).then(() => undefined),
			new Promise<void>((resolve) => setTimeout(resolve, 2000)),
		]);
		tasks.clear();
	});

	pi.registerTool(createTaskTool(undefined));
}
