/**
 * pi-hive: Multi-agent orchestration extension for pi.
 *
 * Root agents get one orchestration tool: agent.
 * Children additionally get read, write, edit, bash, report, and a
 * descendant-scoped agent tool subject to maxDepth/maxLiveAgents.
 *
 * Children are in-process Agent instances that persist across interactions.
 * Report streams intermediate results to the parent via onUpdate.
 */

import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { spawn as spawnProcess } from "node:child_process";
import { dirname, join, resolve, isAbsolute, sep, relative } from "node:path";
import { Agent, type AgentTool, type AgentToolResult, type AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Model, TextContent } from "@mariozechner/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, Container, Spacer } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Child process environment (strict allowlist)
// ---------------------------------------------------------------------------

const SAFE_ENV_KEYS: ReadonlySet<string> = new Set([
	// Core shell & paths
	"PATH",
	"HOME",
	"SHELL",
	"USER",
	"LOGNAME",
	// Locale & timezone
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	// Terminal
	"TERM",
	"COLORTERM",
	// Temp dirs
	"TMPDIR",
	"XDG_RUNTIME_DIR",
	// TLS / CA certificates (required on NixOS and custom-CA environments)
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"CURL_CA_BUNDLE",
	"REQUESTS_CA_BUNDLE",
	"NODE_EXTRA_CA_CERTS",
]);

function buildSafeEnv(): NodeJS.ProcessEnv {
	const safe: NodeJS.ProcessEnv = {};
	for (const key of SAFE_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) safe[key] = value;
	}
	return safe;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const chainStepSchema = Type.Object({
	id: Type.String({ description: "Child agent id to spawn or delegate to" }),
	system_prompt: Type.Optional(Type.String({ description: "System prompt for spawn steps. Required when the child does not already exist." })),
	task: Type.String({ description: "Task/message for this step. Supports {previous} and {all}." }),
	timeout_seconds: Type.Optional(Type.Number({ description: "Maximum wall-clock seconds for this step." })),
});

const parallelTaskSchema = Type.Object({
	id: Type.String({ description: "Unique child agent id to spawn" }),
	system_prompt: Type.String({ description: "System prompt defining the child agent's role and behavior" }),
	task: Type.String({ description: "Task to assign to the child agent" }),
	timeout_seconds: Type.Optional(Type.Number({ description: "Maximum wall-clock seconds for this task." })),
});

const agentActionSchema = Type.Union([
	Type.Literal("spawn"),
	Type.Literal("delegate"),
	Type.Literal("kill"),
	Type.Literal("list"),
	Type.Literal("chain"),
	Type.Literal("parallel"),
	Type.Literal("list_runs"),
	Type.Literal("result"),
	Type.Literal("wait"),
	Type.Literal("cancel"),
]);

const agentSchema = Type.Object({
	action: agentActionSchema,
	id: Type.Optional(Type.String({ description: "Child agent id for spawn/delegate/kill actions" })),
	run_id: Type.Optional(Type.String({ description: "Async run id for result/wait/cancel actions, or optional id when starting an async run" })),
	system_prompt: Type.Optional(Type.String({ description: "System prompt for spawn action" })),
	task: Type.Optional(Type.String({ description: "Task for spawn action" })),
	message: Type.Optional(Type.String({ description: "Follow-up message for delegate action" })),
	timeout_seconds: Type.Optional(Type.Number({ description: "Action timeout. For wait, this does not cancel the run." })),
	async: Type.Optional(Type.Boolean({ description: "For spawn/delegate/chain/parallel from root only: run in the background and return a run id immediately." })),
	steps: Type.Optional(Type.Array(chainStepSchema, { description: "Steps for chain action. Existing ids are delegated to; new ids require system_prompt." })),
	tasks: Type.Optional(Type.Array(parallelTaskSchema, { description: "Tasks for parallel action." })),
});

const reportSchema = Type.Object({
	message: Type.String({ description: "Report content to send to the parent agent" }),
});

// ---------------------------------------------------------------------------
// Extension config
// ---------------------------------------------------------------------------

const CONFIG_FILE_NAME = "pi-hive.json";

const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_MAX_LIVE_AGENTS = 6;

interface PiHiveConfig {
	maxDepth: number;
	maxLiveAgents: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNonNegativeInteger(value: unknown, key: string, path: string): number {
	if (!Number.isInteger(value) || (value as number) < 0) {
		throw new Error(`${path}: "${key}" must be an integer ≥ 0`);
	}
	return value as number;
}

function normalizePositiveInteger(value: unknown, key: string, path: string): number {
	if (!Number.isInteger(value) || (value as number) < 1) {
		throw new Error(`${path}: "${key}" must be an integer ≥ 1`);
	}
	return value as number;
}

async function readConfigFragment(path: string): Promise<Partial<PiHiveConfig>> {
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return {};
		throw new Error(`Failed to read ${path}: ${(err as Error).message}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
	}
	if (!isPlainObject(parsed)) {
		throw new Error(`${path}: expected a JSON object`);
	}

	const unknownKeys = Object.keys(parsed).filter((key) => key !== "maxDepth" && key !== "maxLiveAgents");
	if (unknownKeys.length > 0) {
		throw new Error(`${path}: unknown key(s): ${unknownKeys.join(", ")}`);
	}

	const config: Partial<PiHiveConfig> = {};
	if ("maxDepth" in parsed) {
		config.maxDepth = normalizeNonNegativeInteger(parsed.maxDepth, "maxDepth", path);
	}
	if ("maxLiveAgents" in parsed) {
		config.maxLiveAgents = normalizePositiveInteger(parsed.maxLiveAgents, "maxLiveAgents", path);
	}
	return config;
}

async function loadPiHiveConfig(cwd: string): Promise<PiHiveConfig> {
	const globalConfig = await readConfigFragment(join(getAgentDir(), CONFIG_FILE_NAME));
	const projectConfig = await readConfigFragment(resolve(cwd, ".pi", CONFIG_FILE_NAME));
	return {
		maxDepth: projectConfig.maxDepth ?? globalConfig.maxDepth ?? DEFAULT_MAX_DEPTH,
		maxLiveAgents: projectConfig.maxLiveAgents ?? globalConfig.maxLiveAgents ?? DEFAULT_MAX_LIVE_AGENTS,
	};
}

// ---------------------------------------------------------------------------
// Streaming details (shared between execute and renderers)
// ---------------------------------------------------------------------------

interface ActivityItem {
	type: "tool_start" | "tool_end" | "report" | "text";
	label: string;
	timestamp: number;
}

interface AgentToolDetails {
	childId: string;
	activity: ActivityItem[];
	reports: string[];
	error?: string;
	done: boolean;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// MAX_RENDERED_ACTIVITY: max items shown in collapsed/live views (E2)
const MAX_RENDERED_ACTIVITY = 8;
// MAX_ACTIVITY_STORAGE: cap on stored activity items to prevent unbounded growth (E1)
const MAX_ACTIVITY_STORAGE = 500;
const SHUTDOWN_GRACE_MS = 5000;

function isWithinDirectory(base: string, target: string): boolean {
	const rel = relative(base, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function normalizePositiveTimeout(value: number | undefined, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${label} must be a finite number greater than 0`);
	}
	return value;
}

class AgentTimeoutError extends Error {
	constructor(childId: string, timeoutSeconds: number) {
		super(`Agent "${childId}" timed out after ${timeoutSeconds}s`);
		this.name = "AgentTimeoutError";
	}
}

async function waitForAgentSettlement(agent: Agent, work: Promise<unknown>, graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
	await Promise.race([
		Promise.allSettled([work, agent.waitForIdle()]).then(() => undefined),
		new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
	]);
}

async function withOptionalTimeout<T>(
	agent: Agent,
	childId: string,
	work: Promise<T>,
	timeoutSeconds: number | undefined,
): Promise<T> {
	const timeout = normalizePositiveTimeout(timeoutSeconds, "timeout_seconds");
	if (timeout === undefined) return await work;

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
			await waitForAgentSettlement(agent, work);
		}
		throw err;
	} finally {
		clearTimeout(handle);
	}
}

function shortenPath(p: string): string {
	const home = homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatToolActivity(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "bash": {
			const cmd = (args.command as string) || "...";
			return `$ ${cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd}`;
		}
		case "read": {
			const p = shortenPath((args.path as string) || "...");
			const off = args.offset as number | undefined;
			const lim = args.limit as number | undefined;
			let s = `read ${p}`;
			if (off || lim) s += `:${off ?? 1}${lim ? `-${(off ?? 1) + lim - 1}` : ""}`;
			return s;
		}
		case "write":
			return `write ${shortenPath((args.path as string) || "...")}`;
		case "edit":
			return `edit ${shortenPath((args.path as string) || "...")}`;
		case "report": {
			const msg = (args.message as string) || "";
			return `report "${msg.length > 50 ? msg.slice(0, 50) + "..." : msg}"`;
		}
		default: {
			const s = JSON.stringify(args);
			return `${name} ${s.length > 50 ? s.slice(0, 50) + "..." : s}`;
		}
	}
}

// ---------------------------------------------------------------------------
// Tool schemas (F4: moved above createChildTools)
// ---------------------------------------------------------------------------

const readToolSchema = Type.Object({
	path: Type.String({ description: "File path to read" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

const writeToolSchema = Type.Object({
	path: Type.String({ description: "File path to write" }),
	content: Type.String({ description: "Content to write" }),
});

const editToolSchema = Type.Object({
	path: Type.String({ description: "File path to edit" }),
	edits: Type.Array(
		Type.Object({
			oldText: Type.String({ description: "Exact text to find" }),
			newText: Type.String({ description: "Replacement text" }),
		}),
	),
});

const bashToolSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Seconds before the command is terminated (must be > 0). The process group receives SIGTERM, then SIGKILL after 3 seconds if still running. Partial stdout/stderr is still returned." })),
});

// ---------------------------------------------------------------------------
// Child tool implementations
// ---------------------------------------------------------------------------

function createChildTools(cwd: string): AgentTool<any>[] {
	const findNearestExistingRealPath = async (candidate: string): Promise<string> => {
		let current = candidate;
		while (true) {
			try {
				return await realpath(current);
			} catch {
				const parent = dirname(current);
				if (parent === current) {
					throw new Error(`Cannot resolve path "${candidate}" against working directory "${cwd}"`);
				}
				current = parent;
			}
		}
	};

	const resolvePath = async (p: string): Promise<string> => {
		const lexical = isAbsolute(p) ? p : resolve(cwd, p);
		if (!isWithinDirectory(cwd, lexical)) {
			throw new Error(`Path traversal denied: "${p}" resolves outside the working directory "${cwd}". Use bash if you need files outside this tree.`);
		}

		const cwdReal = await realpath(cwd);
		const realTarget = await findNearestExistingRealPath(lexical);
		if (!isWithinDirectory(cwdReal, realTarget)) {
			throw new Error(`Path traversal denied: "${p}" resolves outside the working directory "${cwdReal}". Use bash if you need files outside this tree.`);
		}

		return lexical;
	};

	const readTool: AgentTool<typeof readToolSchema> = {
		name: "read",
		label: "Read",
		description: "Read a file's contents. Use offset/limit for large files.",
		parameters: readToolSchema,
		execute: async (_id, params) => {
			const filePath = await resolvePath(params.path.replace(/^@/, ""));
			let content: string;
			try {
				content = await readFile(filePath, "utf-8");
			} catch (err) {
				throw new Error(`Cannot read ${params.path}: ${(err as Error).message}`);
			}
			const lines = content.split("\n");
			const offset = params.offset ?? 1;
			const limit = params.limit ?? lines.length;
			const sliced = lines.slice(offset - 1, offset - 1 + limit);
			const result = sliced.join("\n");
			const truncated = result.length > 50000 ? result.slice(0, 50000) + "\n[truncated]" : result;
			return { content: [{ type: "text", text: truncated }], details: { path: filePath } };
		},
	};

	const writeTool: AgentTool<typeof writeToolSchema> = {
		name: "write",
		label: "Write",
		description: "Write content to a file. Creates parent directories.",
		parameters: writeToolSchema,
		execute: async (_id, params) => {
			const filePath = await resolvePath(params.path.replace(/^@/, ""));
			await mkdir(dirname(filePath), { recursive: true });
			await writeFile(filePath, params.content, "utf-8");
			return {
				content: [{ type: "text", text: `Wrote ${params.content.split("\n").length} lines to ${params.path}` }],
				details: { path: filePath },
			};
		},
	};

	const editTool: AgentTool<typeof editToolSchema> = {
		name: "edit",
		label: "Edit",
		description: "Edit a file using exact text replacement.",
		parameters: editToolSchema,
		execute: async (_id, params) => {
			const filePath = await resolvePath(params.path.replace(/^@/, ""));
			let content: string;
			try {
				content = await readFile(filePath, "utf-8");
			} catch (err) {
				throw new Error(`Cannot read ${params.path}: ${(err as Error).message}`);
			}
			for (const edit of params.edits) {
				const occurrences = content.split(edit.oldText).length - 1;
				if (occurrences === 0) {
					throw new Error(`oldText not found in ${params.path}:\n${edit.oldText.slice(0, 200)}`);
				}
				if (occurrences > 1) {
					throw new Error(`oldText appears ${occurrences} times in ${params.path} — be more specific:\n${edit.oldText.slice(0, 200)}`);
				}
				content = content.replace(edit.oldText, () => edit.newText);
			}
			await writeFile(filePath, content, "utf-8");
			return {
				content: [{ type: "text", text: `Applied ${params.edits.length} edit(s) to ${params.path}` }],
				details: { path: filePath },
			};
		},
	};

const DEFAULT_BASH_TIMEOUT_S = 120;

	const bashTool: AgentTool<typeof bashToolSchema> = {
		name: "bash",
		label: "Bash",
		description: "Execute a bash command. Returns stdout followed by stderr (prefixed with STDERR:), truncated if large.",
		parameters: bashToolSchema,
		execute: async (_id, params, signal) => {
			// Default timeout prevents pipe-drain deadlock when commands fork background processes.
			const commandTimeout = normalizePositiveTimeout(params.timeout ?? DEFAULT_BASH_TIMEOUT_S, "bash timeout");
			return new Promise<AgentToolResult<unknown>>((res) => {
				const proc = spawnProcess("bash", ["-c", params.command], {
					cwd,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
					env: buildSafeEnv(),
				});
				let stdout = "";
				let stderr = "";
				const MAX_OUTPUT_CHARS = 100_000;
				proc.stdout!.on("data", (d: Buffer) => {
					if (stdout.length < MAX_OUTPUT_CHARS) stdout += d.toString();
				});
				proc.stderr!.on("data", (d: Buffer) => {
					if (stderr.length < MAX_OUTPUT_CHARS) stderr += d.toString();
				});

				const killGroup = (sig: NodeJS.Signals) => {
					const pid = proc.pid;
					if (!pid) return;
					try {
						process.kill(-pid, sig);
					} catch (err) {
						const code = (err as NodeJS.ErrnoException).code;
						if (code === "ESRCH") return;
						try {
							proc.kill(sig);
						} catch {}
					}
				};

				let timedOut = false;
				let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
				let escalationHandle: ReturnType<typeof setTimeout> | undefined;
				const terminate = (reason: "abort" | "timeout") => {
					if (reason === "timeout") timedOut = true;
					killGroup("SIGTERM");
					clearTimeout(escalationHandle);
					escalationHandle = setTimeout(() => killGroup("SIGKILL"), 3000);
				};

				if (commandTimeout !== undefined) {
					timeoutHandle = setTimeout(() => terminate("timeout"), commandTimeout * 1000);
				}

				const onAbort = () => terminate("abort");
				const cleanup = () => {
					clearTimeout(timeoutHandle);
					clearTimeout(escalationHandle);
					if (signal) signal.removeEventListener("abort", onAbort);
				};

				proc.on("close", (code) => {
					cleanup();
					let output = stdout;
					if (stderr) output += (output ? "\n" : "") + `STDERR:\n${stderr}`;
					if (timedOut) {
						const partial = output || "(no output before timeout)";
						output = `[TIMEOUT after ${commandTimeout}s — output may be incomplete]\n${partial}`;
					} else if (!output) {
						output = `(exit code ${code ?? 0})`;
					}
					if (output.length > 50000) {
						output = "[output truncated — showing last 50000 chars]\n" + output.slice(-50000);
					}
					res({ content: [{ type: "text", text: output }], details: { exitCode: code ?? 0, timedOut } });
				});
				proc.on("error", (err) => {
					cleanup();
					res({ content: [{ type: "text", text: `Error: ${err.message}` }], details: { exitCode: 1, timedOut: false } });
				});

				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
			});
		},
	};

	return [
		readTool as AgentTool<any>,
		writeTool as AgentTool<any>,
		editTool as AgentTool<any>,
		bashTool as AgentTool<any>,
	];
}

// ---------------------------------------------------------------------------
// Child state
// ---------------------------------------------------------------------------

interface ChildState {
	id: string;
	parentId?: string;
	rootId: string;
	depth: number;
	cwd: string;
	createdAt: number;
	agent: Agent;
	reports: string[];
	activity: ActivityItem[];
	locked: boolean; // D4: concurrent delegate guard
	killed: boolean;
}

interface ChainStepParams {
	id: string;
	system_prompt?: string;
	task: string;
	timeout_seconds?: number;
}

interface ParallelTaskParams {
	id: string;
	system_prompt: string;
	task: string;
	timeout_seconds?: number;
}

type AgentAction = "spawn" | "delegate" | "kill" | "list" | "chain" | "parallel" | "list_runs" | "result" | "wait" | "cancel";

interface AgentToolParams {
	action: AgentAction;
	id?: string;
	run_id?: string;
	system_prompt?: string;
	task?: string;
	message?: string;
	timeout_seconds?: number;
	async?: boolean;
	steps?: ChainStepParams[];
	tasks?: ParallelTaskParams[];
}

type RunKind = "spawn" | "delegate" | "chain" | "parallel";
type RunStatus = "running" | "succeeded" | "failed" | "killed";

interface RunState {
	id: string;
	kind: RunKind;
	status: RunStatus;
	startedAt: number;
	finishedAt?: number;
	children: string[];
	result?: AgentToolResult<unknown>;
	error?: string;
	abortController: AbortController;
	promise: Promise<void>;
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

// D2: buildReportTool now accepts reports array directly instead of full state
function buildReportTool(childId: string, reports: string[]): AgentTool<typeof reportSchema> {
	return {
		name: "report",
		label: "Report",
		description:
			"Send a report to the parent agent. Use this to communicate " +
			"results, progress, or findings. You may call this multiple " +
			"times; every call is delivered.",
		parameters: reportSchema,
		execute: async (_toolCallId, params) => {
			reports.push(params.message);
			return {
				content: [{ type: "text", text: "Report delivered to parent." }],
				details: { childId, reportIndex: reports.length - 1 },
			};
		},
	};
}

/** Subscribe to child events, push activity + reports to onUpdate. */
function subscribeChild(
	child: Agent,
	childId: string,
	state: ChildState,
	onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void,
): () => void {
	let emitPending = false;
	let unsubscribed = false;
	const emit = () => {
		if (!emitPending && onUpdate && !unsubscribed) {
			emitPending = true;
			Promise.resolve().then(() => {
				emitPending = false;
				if (unsubscribed) return;
				onUpdate({
					content: [{ type: "text", text: `[${childId}] working...` }],
					details: {
						childId,
						activity: [...state.activity],
						reports: [...state.reports],
						done: false,
					},
				});
			});
		}
	};

	const innerUnsub = child.subscribe((event: AgentEvent) => {
		if (event.type === "tool_execution_start") {
			state.activity.push({
				type: "tool_start",
				label: formatToolActivity(event.toolName, event.args),
				timestamp: Date.now(),
			});
			if (state.activity.length > MAX_ACTIVITY_STORAGE) {
				state.activity = state.activity.slice(-MAX_ACTIVITY_STORAGE);
			}
			emit();
		} else if (event.type === "tool_execution_end") {
			if (event.toolName === "report" && !event.isError) {
				const latest = state.reports[state.reports.length - 1];
				if (latest) {
					state.activity.push({
						type: "report",
						label: `report "${latest.length > 50 ? latest.slice(0, 50) + "..." : latest}"`,
						timestamp: Date.now(),
					});
				}
			} else {
				state.activity.push({
					type: "tool_end",
					label: `${event.toolName} ${event.isError ? "failed" : "done"}`,
					timestamp: Date.now(),
				});
			}
			if (state.activity.length > MAX_ACTIVITY_STORAGE) {
				state.activity = state.activity.slice(-MAX_ACTIVITY_STORAGE);
			}
			emit();
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			const msg = event.message as AssistantMessage;
			const textParts = msg.content.filter((c): c is TextContent => c.type === "text");
			if (textParts.length > 0) {
				const preview = textParts[0].text.split("\n")[0];
				state.activity.push({
					type: "text",
					label: preview.length > 60 ? preview.slice(0, 60) + "..." : preview,
					timestamp: Date.now(),
				});
				if (state.activity.length > MAX_ACTIVITY_STORAGE) {
					state.activity = state.activity.slice(-MAX_ACTIVITY_STORAGE);
				}
				emit();
			}
		}
	});

	return () => {
		unsubscribed = true;
		innerUnsub();
	};
}

function collectResult(childId: string, state: ChildState, reportStartIdx: number): AgentToolResult<AgentToolDetails> {
	const newReports = state.reports.slice(reportStartIdx);
	const text = newReports.length > 0 ? newReports.join("\n---\n") : extractLastAssistantText(state.agent);
	// F5: Agent resets error on each prompt, so this reflects the most recent run's failure state
	const error = state.agent.state.errorMessage;
	return {
		content: [{ type: "text", text: error ? `[Error]: ${error}\n\n${text}` : text }],
		details: {
			childId,
			activity: [...state.activity],
			reports: [...newReports],
			error,
			done: true,
		},
	};
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderAgentCall(
	toolLabel: string,
	args: { id?: string; system_prompt?: string; task?: string; message?: string },
	theme: any,
	_context: any,
) {
	const id = args.id || "...";
	const taskText = args.task || args.message || "...";
	const preview = taskText.length > 70 ? taskText.slice(0, 70) + "..." : taskText;
	let text = theme.fg("toolTitle", theme.bold(`${toolLabel} `)) + theme.fg("accent", id);
	text += "\n  " + theme.fg("dim", preview);
	return new Text(text, 0, 0);
}

function renderAgentResult(
	result: { content: any[]; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: any,
	context: any,
) {
	// F1: runtime shape check before casting to AgentToolDetails
	const details = (result.details && typeof result.details === "object" && "childId" in result.details)
		? result.details as AgentToolDetails
		: undefined;

	if (!details) {
		const t = result.content[0];
		return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
	}

	const { expanded, isPartial } = options;

	// -- still running: spinner + live activity feed --
	if (isPartial && !details.done) {
		// Start spinner interval if not already running
		if (!context.state._spinnerInterval) {
			context.state._spinnerFrame = 0;
			context.state._spinnerInterval = setInterval(() => {
				context.state._spinnerFrame = ((context.state._spinnerFrame ?? 0) + 1) % SPINNER_FRAMES.length;
				context.invalidate();
			}, 80);
		}

		const frame = SPINNER_FRAMES[context.state._spinnerFrame ?? 0];
		const activity = details.activity;
		// E2/E3: use MAX_RENDERED_ACTIVITY
		const visible = activity.slice(-MAX_RENDERED_ACTIVITY);
		const skipped = activity.length - visible.length;

		let text = theme.fg("accent", frame) + " " + theme.fg("toolTitle", theme.bold(details.childId));
		text += theme.fg("muted", ` (${activity.length} actions)`);

		if (skipped > 0) text += "\n  " + theme.fg("muted", `... ${skipped} earlier`);
		for (const item of visible) {
			const icon =
				item.type === "report"
					? theme.fg("warning", "↑")
					: item.type === "tool_start"
						? theme.fg("accent", "→")
						: item.type === "text"
							? theme.fg("dim", "·")
							: theme.fg("success", "✓");
			text += "\n  " + icon + " " + theme.fg("dim", item.label);
		}

		// F2: use instanceof check instead of unsafe cast
		const prev = context.lastComponent;
		const component = (prev instanceof Text) ? prev : new Text("", 0, 0);
		component.setText(text);
		return component;
	}

	// -- done: clear spinner --
	if (context.state._spinnerInterval) {
		clearInterval(context.state._spinnerInterval);
		context.state._spinnerInterval = null;
	}

	const hasError = !!details.error;
	const icon = hasError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const reports = details.reports || [];
	const activity = details.activity || [];

	// Expanded view
	if (expanded) {
		const container = new Container();
		let header = `${icon} ${theme.fg("toolTitle", theme.bold(details.childId))}`;
		header += theme.fg("muted", ` (${activity.length} actions, ${reports.length} reports)`);
		if (hasError) header += " " + theme.fg("error", `[error]`);
		container.addChild(new Text(header, 0, 0));

		if (hasError && details.error) {
			container.addChild(new Text(theme.fg("error", `Error: ${details.error}`), 0, 0));
		}

		// Activity log
		if (activity.length > 0) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Activity ───"), 0, 0));
			for (const item of activity) {
				const itemIcon =
					item.type === "report"
						? theme.fg("warning", "↑")
						: item.type === "tool_start"
							? theme.fg("accent", "→")
							: item.type === "text"
								? theme.fg("dim", "·")
								: theme.fg("success", "✓");
				container.addChild(new Text(`  ${itemIcon} ${theme.fg("dim", item.label)}`, 0, 0));
			}
		}

		// Reports
		if (reports.length > 0) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Reports ───"), 0, 0));
			for (let i = 0; i < reports.length; i++) {
				container.addChild(new Text(
					theme.fg("warning", `  [${i + 1}] `) + theme.fg("toolOutput", reports[i]),
					0, 0,
				));
			}
		}

		// Final output
		const finalText = result.content[0];
		if (finalText?.type === "text" && reports.length === 0) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
			container.addChild(new Text(theme.fg("toolOutput", finalText.text), 0, 0));
		}

		return container;
	}

	// Collapsed view — E3: use MAX_RENDERED_ACTIVITY instead of hardcoded 5
	let text = `${icon} ${theme.fg("toolTitle", theme.bold(details.childId))}`;
	text += theme.fg("muted", ` (${activity.length} actions, ${reports.length} reports)`);
	if (hasError && details.error) {
		text += "\n  " + theme.fg("error", details.error);
	} else {
		const visible = activity.slice(-MAX_RENDERED_ACTIVITY);
		const skipped = activity.length - visible.length;
		if (skipped > 0) text += "\n  " + theme.fg("muted", `... ${skipped} earlier`);
		for (const item of visible) {
			const itemIcon =
				item.type === "report"
					? theme.fg("warning", "↑")
					: item.type === "tool_start"
						? theme.fg("accent", "→")
						: item.type === "text"
							? theme.fg("dim", "·")
							: theme.fg("success", "✓");
			text += "\n  " + itemIcon + " " + theme.fg("dim", item.label);
		}
	}

	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function piHive(pi: ExtensionAPI) {
	const children = new Map<string, ChildState>();
	const runs = new Map<string, RunState>();
	// cachedGetApiKey is initialized from the first agent action ctx.
	// This assumes modelRegistry is stable for the session lifetime.
	let cachedGetApiKey: ((provider: string) => Promise<string | undefined>) | undefined;
	let cachedConfig: PiHiveConfig | undefined;
	let cachedConfigCwd: string | undefined;
	let cachedConfigError: Error | undefined;

	async function getConfig(cwd: string): Promise<PiHiveConfig> {
		if (cachedConfig && cachedConfigCwd === cwd) return cachedConfig;
		if (cachedConfigError && cachedConfigCwd === cwd) throw cachedConfigError;

		try {
			const config = await loadPiHiveConfig(cwd);
			cachedConfig = config;
			cachedConfigCwd = cwd;
			cachedConfigError = undefined;
			return config;
		} catch (err) {
			cachedConfig = undefined;
			cachedConfigCwd = cwd;
			cachedConfigError = err instanceof Error ? err : new Error(String(err));
			throw cachedConfigError;
		}
	}

	function clearConfigCache(): void {
		cachedConfig = undefined;
		cachedConfigCwd = undefined;
		cachedConfigError = undefined;
	}

	function getCallerState(callerId: string): ChildState {
		const state = children.get(callerId);
		if (!state) throw new Error(`Caller agent "${callerId}" is no longer active.`);
		return state;
	}

	function isInSubtree(targetId: string, ancestorId: string, allowSelf = true): boolean {
		let current: string | undefined = targetId;
		while (current) {
			if (current === ancestorId) return allowSelf || current !== targetId;
			current = children.get(current)?.parentId;
		}
		return false;
	}

	function getSubtreeIds(rootId: string): string[] {
		const result: string[] = [];
		const queue = [rootId];
		while (queue.length > 0) {
			const current = queue.shift()!;
			if (!children.has(current)) continue;
			result.push(current);
			const childIds = [...children.entries()]
				.filter(([, state]) => state.parentId === current)
				.map(([id]) => id)
				.sort((a, b) => a.localeCompare(b));
			queue.push(...childIds);
		}
		return result;
	}

	function getScopedEntries(callerId?: string): Array<[string, ChildState]> {
		const entries = [...children.entries()].filter(([id]) => !callerId || isInSubtree(id, callerId, true));
		entries.sort((a, b) => a[1].depth - b[1].depth || a[0].localeCompare(b[0]));
		return entries;
	}

	function formatScopedAgentIds(callerId?: string): string {
		const ids = getScopedEntries(callerId).map(([id]) => id);
		return ids.length > 0 ? ids.join(", ") : "(none)";
	}

	function getAccessibleTarget(callerId: string | undefined, targetId: string, action: string, allowSelf = false): ChildState {
		if (callerId) getCallerState(callerId);
		const state = children.get(targetId);
		if (!state) {
			throw new Error(
				`Child agent "${targetId}" not found. Visible agents: ${formatScopedAgentIds(callerId)}. ` +
				`Call agent({ action: "list" }) for full status.`,
			);
		}
		if (!callerId) return state;
		if (!isInSubtree(targetId, callerId, allowSelf)) {
			throw new Error(
				`Agent "${callerId}" may only ${action} descendant agents in its own subtree. ` +
				`"${targetId}" is outside that subtree.`,
			);
		}
		return state;
	}

	function killSubtree(rootId: string): { killedIds: string[]; reportCount: number } {
		const ids = getSubtreeIds(rootId);
		let reportCount = 0;
		for (const id of ids) {
			const state = children.get(id);
			if (!state) continue;
			state.killed = true;
			reportCount += state.reports.length;
			state.agent.abort();
		}
		for (const id of ids) {
			children.delete(id);
		}
		return { killedIds: ids, reportCount };
	}

	function listAgentsResult(callerId?: string): AgentToolResult<unknown> {
		if (callerId) getCallerState(callerId);
		const agents = getScopedEntries(callerId).map(([id, state]) => ({
			id,
			parentId: state.parentId,
			rootId: state.rootId,
			depth: state.depth,
			cwd: state.cwd,
			isRunning: state.agent.state.isStreaming || state.locked,
			reportCount: state.reports.length,
			activityCount: state.activity.length,
			createdAt: state.createdAt,
		}));
		const text = agents.length === 0
			? "No active child agents."
			: agents.map((agent) =>
				`• ${agent.id} — ${agent.isRunning ? "running" : "idle"}, depth ${agent.depth}, ` +
				`${agent.parentId ? `parent ${agent.parentId}` : "root child"}, ${agent.reportCount} reports`,
			).join("\n");
		return { content: [{ type: "text", text }], details: { agents } };
	}

	async function delegateToChild(
		callerId: string | undefined,
		params: { id: string; message: string; timeout_seconds?: number },
		signal?: AbortSignal,
		onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void,
	): Promise<AgentToolResult<AgentToolDetails>> {
		if (signal?.aborted) throw new Error(`Agent "${params.id}" was aborted before start.`);
		const state = getAccessibleTarget(callerId, params.id, "delegate to");
		if (state.agent.state.isStreaming || state.locked) {
			throw new Error(
				`Child agent "${params.id}" is still running. ` +
				`Wait for the current agent action to complete before sending more work.`,
			);
		}

		const reportStart = state.reports.length;
		state.activity = [];

		const onAbort = () => state.agent.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();

		const unsub = subscribeChild(state.agent, params.id, state, onUpdate);
		state.locked = true;
		try {
			const runPromise = state.agent.prompt(params.message);
			await withOptionalTimeout(state.agent, params.id, runPromise, params.timeout_seconds);
			if (state.killed) {
				throw new Error(`Agent "${params.id}" was killed while running`);
			}
		} catch (err) {
			if (err instanceof AgentTimeoutError) {
				killSubtree(params.id);
			}
			throw err;
		} finally {
			state.locked = false;
			unsub();
			signal?.removeEventListener("abort", onAbort);
		}

		return collectResult(params.id, state, reportStart);
	}

	function createChildManagementTools(callerId: string, cwd: string, model: Model<any>): AgentTool<any>[] {
		const agentTool: AgentTool<typeof agentSchema> = {
			name: "agent",
			label: "Agent",
			description:
				"Manage descendant agents with action=spawn|delegate|kill|list|chain|parallel. " +
				"Async run actions are root-only.",
			parameters: agentSchema,
			execute: async (_toolCallId, params, signal, onUpdate) => {
				return await executeAgentAction(callerId, params as AgentToolParams, model, cwd, signal, onUpdate, false);
			},
		};
		return [agentTool as AgentTool<any>];
	}

	function buildChildAgent(
		childId: string,
		systemPrompt: string,
		model: Model<any>,
		cwd: string,
		reports: string[],
	): Agent {
		const reportTool = buildReportTool(childId, reports);
		const childTools = [
			...createChildTools(cwd),
			...createChildManagementTools(childId, cwd, model),
			reportTool as AgentTool<any>,
		];
		return new Agent({
			initialState: { systemPrompt, model, tools: childTools },
			getApiKey: cachedGetApiKey,
		});
	}

	async function spawnChild(
		callerId: string | undefined,
		params: { id: string; system_prompt: string; task: string; timeout_seconds?: number },
		model: Model<any>,
		cwd: string,
		signal?: AbortSignal,
		onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void,
	): Promise<AgentToolResult<AgentToolDetails>> {
		const config = await getConfig(cwd);
		if (signal?.aborted) throw new Error(`Agent "${params.id}" was aborted before start.`);
		if (children.has(params.id)) {
			throw new Error(
				`Child agent "${params.id}" already exists. ` +
				`Use agent({ action: "delegate", id: "${params.id}", message: ... }) to send it more work, or agent({ action: "list" }) to inspect active agents.`,
			);
		}

		const parentState = callerId ? getCallerState(callerId) : undefined;
		const childDepth = (parentState?.depth ?? 0) + 1;
		if (childDepth > config.maxDepth) {
			throw new Error(
				`Cannot spawn agent "${params.id}": depth ${childDepth} exceeds configured maxDepth ${config.maxDepth}.`,
			);
		}
		if (children.size >= config.maxLiveAgents) {
			throw new Error(
				`Cannot spawn agent "${params.id}": maxLiveAgents ${config.maxLiveAgents} reached. ` +
				`Kill or reuse an existing agent before spawning another one.`,
			);
		}

		const reports: string[] = [];
		const child = buildChildAgent(params.id, params.system_prompt, model, cwd, reports);
		const state: ChildState = {
			id: params.id,
			parentId: parentState?.id,
			rootId: parentState?.rootId ?? params.id,
			depth: childDepth,
			cwd,
			createdAt: Date.now(),
			agent: child,
			reports,
			activity: [],
			locked: false,
			killed: false,
		};
		children.set(params.id, state);

		const onAbort = () => child.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();

		const unsub = subscribeChild(child, params.id, state, onUpdate);
		state.locked = true;
		try {
			const runPromise = child.prompt(params.task);
			await withOptionalTimeout(child, params.id, runPromise, params.timeout_seconds);
			if (state.killed) {
				throw new Error(`Agent "${params.id}" was killed while running`);
			}
		} catch (err) {
			killSubtree(params.id);
			throw err;
		} finally {
			state.locked = false;
			unsub();
			signal?.removeEventListener("abort", onAbort);
		}

		return collectResult(params.id, state, 0);
	}

	function makeRunId(kind: RunKind): string {
		return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}

	function textOf(result: AgentToolResult<unknown>): string {
		const first = result.content[0];
		return first?.type === "text" ? first.text : "";
	}

	function formatRunResult(run: RunState): AgentToolResult<unknown> {
		const lines = [
			`run_id: ${run.id}`,
			`kind: ${run.kind}`,
			`status: ${run.status}`,
			`children: ${run.children.length > 0 ? run.children.join(", ") : "(none)"}`,
		];
		if (run.error) lines.push(`error: ${run.error}`);
		if (run.result) lines.push("", textOf(run.result));
		return { content: [{ type: "text", text: lines.join("\n") }], details: { run } };
	}

	function startRun(
		kind: RunKind,
		runId: string | undefined,
		childrenForRun: string[],
		work: (signal: AbortSignal) => Promise<AgentToolResult<unknown>>,
	): AgentToolResult<unknown> {
		const id = runId || makeRunId(kind);
		if (runs.has(id)) throw new Error(`Run "${id}" already exists.`);
		const abortController = new AbortController();
		const run: RunState = { id, kind, status: "running", startedAt: Date.now(), children: childrenForRun, abortController, promise: Promise.resolve() };
		run.promise = (async () => {
			try {
				run.result = await work(abortController.signal);
				run.status = run.status === "killed" ? "killed" : "succeeded";
			} catch (err) {
				run.error = err instanceof Error ? err.message : String(err);
				run.status = run.status === "killed" ? "killed" : "failed";
			} finally {
				run.finishedAt = Date.now();
			}
		})();
		runs.set(id, run);
		return { content: [{ type: "text", text: `Started ${kind} run "${id}".` }], details: { runId: id, kind, status: "running", children: childrenForRun } };
	}

	async function waitForRun(run: RunState, timeoutSeconds?: number): Promise<RunState> {
		const timeout = normalizePositiveTimeout(timeoutSeconds, "timeout_seconds");
		if (run.status !== "running") return run;
		if (timeout === undefined) {
			await run.promise;
			return run;
		}
		let handle: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<never>((_, reject) => {
			handle = setTimeout(() => reject(new Error(`Run "${run.id}" is still running after ${timeout}s`)), timeout * 1000);
		});
		try {
			await Promise.race([run.promise, timedOut]);
			return run;
		} finally {
			clearTimeout(handle);
		}
	}

	function listRunsResult(): AgentToolResult<unknown> {
		const listed = [...runs.values()].sort((a, b) => a.startedAt - b.startedAt);
		const text = listed.length === 0
			? "No runs."
			: listed.map((run) => `• ${run.id} — ${run.kind}, ${run.status}, children: ${run.children.length > 0 ? run.children.join(", ") : "(none)"}`).join("\n");
		return { content: [{ type: "text", text }], details: { runs: listed } };
	}

	function substituteStepVars(template: string, previous: string, all: string): string {
		return template.replaceAll("{previous}", previous).replaceAll("{all}", all);
	}

	async function runChainSteps(callerId: string | undefined, steps: ChainStepParams[], model: Model<any>, cwd: string, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
		let previous = "";
		const outputs: Array<{ id: string; output: string }> = [];
		for (const step of steps) {
			if (signal?.aborted) throw new Error("Chain run was aborted.");
			const task = substituteStepVars(step.task, previous, outputs.map((o) => `=== ${o.id} ===\n${o.output}`).join("\n\n"));
			const result = children.has(step.id)
				? await delegateToChild(callerId, { id: step.id, message: task, timeout_seconds: step.timeout_seconds }, signal)
				: await spawnChild(callerId, { id: step.id, system_prompt: step.system_prompt || "You are a focused child agent.", task, timeout_seconds: step.timeout_seconds }, model, cwd, signal);
			previous = textOf(result);
			outputs.push({ id: step.id, output: previous });
		}
		const text = outputs.map((o) => `=== ${o.id} ===\n${o.output}`).join("\n\n");
		return { content: [{ type: "text", text }], details: { steps: outputs } };
	}

	async function runParallelTasks(callerId: string | undefined, tasks: ParallelTaskParams[], model: Model<any>, cwd: string, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
		const ids = new Set<string>();
		for (const task of tasks) {
			if (ids.has(task.id)) throw new Error(`Duplicate parallel task id "${task.id}".`);
			ids.add(task.id);
			if (children.has(task.id)) throw new Error(`Child agent "${task.id}" already exists.`);
		}
		const settled = await Promise.allSettled(tasks.map((task) =>
			spawnChild(callerId, { id: task.id, system_prompt: task.system_prompt, task: task.task, timeout_seconds: task.timeout_seconds }, model, cwd, signal),
		));
		const outputs = settled.map((result, index) => {
			const id = tasks[index].id;
			return result.status === "fulfilled"
				? { id, status: "succeeded", output: textOf(result.value) }
				: { id, status: "failed", output: result.reason instanceof Error ? result.reason.message : String(result.reason) };
		});
		const text = outputs.map((o) => `=== ${o.id} (${o.status}) ===\n${o.output}`).join("\n\n");
		return { content: [{ type: "text", text }], details: { tasks: outputs } };
	}

	function requireStringParam(params: AgentToolParams, key: "id" | "run_id" | "system_prompt" | "task" | "message"): string {
		const value = params[key];
		if (typeof value !== "string" || value.length === 0) {
			throw new Error(`agent action "${params.action}" requires "${key}".`);
		}
		return value;
	}

	function requireModel(model: Model<any> | undefined, action: AgentAction): Model<any> {
		if (!model) throw new Error(`agent action "${action}" requires a selected model.`);
		return model;
	}

	function requireSteps(params: AgentToolParams): ChainStepParams[] {
		if (!Array.isArray(params.steps) || params.steps.length === 0) {
			throw new Error(`agent action "${params.action}" requires non-empty "steps".`);
		}
		return params.steps;
	}

	function requireTasks(params: AgentToolParams): ParallelTaskParams[] {
		if (!Array.isArray(params.tasks) || params.tasks.length === 0) {
			throw new Error(`agent action "${params.action}" requires non-empty "tasks".`);
		}
		return params.tasks;
	}

	function rejectUnsupportedAsync(params: AgentToolParams): void {
		if (params.async) throw new Error(`agent action "${params.action}" does not support async=true.`);
	}

	async function executeAgentAction(
		callerId: string | undefined,
		params: AgentToolParams,
		model: Model<any> | undefined,
		cwd: string,
		signal?: AbortSignal,
		onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void,
		allowAsync = true,
	): Promise<AgentToolResult<unknown>> {
		switch (params.action) {
			case "spawn": {
				const selectedModel = requireModel(model, params.action);
				const id = requireStringParam(params, "id");
				const spawnParams = {
					id,
					system_prompt: requireStringParam(params, "system_prompt"),
					task: requireStringParam(params, "task"),
					timeout_seconds: params.timeout_seconds,
				};
				if (params.async) {
					if (!allowAsync) throw new Error("async=true is only supported by root-level agent actions.");
					return startRun("spawn", params.run_id, [id], (runSignal) => spawnChild(callerId, spawnParams, selectedModel, cwd, runSignal));
				}
				return await spawnChild(callerId, spawnParams, selectedModel, cwd, signal, onUpdate);
			}
			case "delegate": {
				const id = requireStringParam(params, "id");
				const delegateParams = { id, message: requireStringParam(params, "message"), timeout_seconds: params.timeout_seconds };
				if (params.async) {
					if (!allowAsync) throw new Error("async=true is only supported by root-level agent actions.");
					return startRun("delegate", params.run_id, [id], (runSignal) => delegateToChild(callerId, delegateParams, runSignal));
				}
				return await delegateToChild(callerId, delegateParams, signal, onUpdate);
			}
			case "kill": {
				rejectUnsupportedAsync(params);
				const id = requireStringParam(params, "id");
				const state = getAccessibleTarget(callerId, id, "kill", callerId === undefined);
				const { killedIds, reportCount } = killSubtree(state.id);
				return {
					content: [{ type: "text", text: `Killed ${killedIds.length} agent(s): ${killedIds.join(", ")}.` }],
					details: { childId: state.id, killedIds, reportCount },
				};
			}
			case "list": {
				rejectUnsupportedAsync(params);
				return listAgentsResult(callerId);
			}
			case "chain": {
				const selectedModel = requireModel(model, params.action);
				const steps = requireSteps(params);
				if (params.async) {
					if (!allowAsync) throw new Error("async=true is only supported by root-level agent actions.");
					return startRun("chain", params.run_id, steps.map((step) => step.id), (runSignal) => runChainSteps(callerId, steps, selectedModel, cwd, runSignal));
				}
				return await runChainSteps(callerId, steps, selectedModel, cwd, signal);
			}
			case "parallel": {
				const selectedModel = requireModel(model, params.action);
				const tasks = requireTasks(params);
				if (params.async) {
					if (!allowAsync) throw new Error("async=true is only supported by root-level agent actions.");
					return startRun("parallel", params.run_id, tasks.map((task) => task.id), (runSignal) => runParallelTasks(callerId, tasks, selectedModel, cwd, runSignal));
				}
				return await runParallelTasks(callerId, tasks, selectedModel, cwd, signal);
			}
			case "list_runs": {
				rejectUnsupportedAsync(params);
				if (callerId) throw new Error("Run management actions are root-only.");
				return listRunsResult();
			}
			case "result": {
				rejectUnsupportedAsync(params);
				if (callerId) throw new Error("Run management actions are root-only.");
				const runId = requireStringParam(params, "run_id");
				const run = runs.get(runId);
				if (!run) throw new Error(`Run "${runId}" not found.`);
				return formatRunResult(run);
			}
			case "wait": {
				rejectUnsupportedAsync(params);
				if (callerId) throw new Error("Run management actions are root-only.");
				const runId = requireStringParam(params, "run_id");
				const run = runs.get(runId);
				if (!run) throw new Error(`Run "${runId}" not found.`);
				await waitForRun(run, params.timeout_seconds);
				return formatRunResult(run);
			}
			case "cancel": {
				rejectUnsupportedAsync(params);
				if (callerId) throw new Error("Run management actions are root-only.");
				const runId = requireStringParam(params, "run_id");
				const run = runs.get(runId);
				if (!run) throw new Error(`Run "${runId}" not found.`);
				run.abortController.abort();
				let killed: string[] = [];
				for (const childId of run.children) {
					if (children.has(childId)) killed = killed.concat(killSubtree(childId).killedIds);
				}
				run.status = "killed";
				run.finishedAt = Date.now();
				return { content: [{ type: "text", text: `Killed run "${run.id}" (${killed.length} agent(s): ${killed.join(", ") || "none"}).` }], details: { runId: run.id, killed } };
			}
			default:
				throw new Error(`Unknown agent action "${(params as { action?: string }).action}".`);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		clearConfigCache();
		try {
			await getConfig(ctx.cwd);
		} catch (err) {
			if (ctx.hasUI) {
				ctx.ui.notify(`pi-hive config error: ${(err as Error).message}`, "error");
			}
		}
	});

	pi.on("session_shutdown", async () => {
		clearConfigCache();
		const states = [...children.values()];
		for (const state of states) {
			state.agent.abort();
		}
		await Promise.race([
			Promise.allSettled(states.map((state) => state.agent.waitForIdle())).then(() => undefined),
			new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
		]);
		children.clear();
	});

	// ── agent ─────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "agent",
		label: "Agent",
		description:
			"Single multi-agent orchestration tool. " +
			"Use action=spawn|delegate|kill|list|chain|parallel|list_runs|result|wait|cancel. " +
			"spawn/delegate/chain/parallel support async=true from the root session. " +
			"Recursive spawning is bounded by pi-hive.json maxDepth/maxLiveAgents.",
		parameters: agentSchema,

		renderCall(args, theme, context) {
			const action = args.action || "...";
			const id = args.id || args.run_id || "";
			const taskText = args.task || args.message || action;
			return renderAgentCall(`agent:${action}`, { id, task: taskText }, theme, context);
		},

		renderResult(result, options, theme, context) {
			return renderAgentResult(result, options, theme, context);
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			cachedGetApiKey ??= (provider: string) => ctx.modelRegistry.getApiKeyForProvider(provider);
			return await executeAgentAction(undefined, params as AgentToolParams, ctx.model, ctx.cwd, signal, onUpdate, true);
		},
	});
}
