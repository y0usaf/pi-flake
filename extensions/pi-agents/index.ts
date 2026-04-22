/**
 * Multi-Agent Extension for pi
 *
 * Parent tools: spawn_agent, delegate, kill_agent, list_agents.
 * Children additionally get read, write, edit, bash, report, and
 * descendant-scoped orchestration tools subject to maxDepth/maxLiveAgents.
 *
 * Children are in-process Agent instances that persist across interactions.
 * Report streams intermediate results to the parent via onUpdate.
 *
 * spawn_agent and delegate block until the child finishes its current run.
 * Multiple spawn_agent calls in one turn run concurrently (parallel tool execution).
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

let _cachedSafeEnv: NodeJS.ProcessEnv | undefined;
function buildSafeEnv(): NodeJS.ProcessEnv {
	if (_cachedSafeEnv) return _cachedSafeEnv;
	const safe: NodeJS.ProcessEnv = {};
	for (const key of SAFE_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) safe[key] = value;
	}
	_cachedSafeEnv = safe;
	return safe;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const spawnSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for the child agent" }),
	system_prompt: Type.String({ description: "System prompt defining the child agent's role and behavior" }),
	task: Type.String({ description: "Initial task to assign to the child agent" }),
	timeout_seconds: Type.Optional(Type.Number({ description: "Maximum wall-clock seconds to wait for the agent to finish (must be > 0). If the deadline expires the agent is aborted, removed from the registry, and an error is thrown." })),
});

const delegateSchema = Type.Object({
	id: Type.String({ description: "ID of an existing child agent" }),
	message: Type.String({ description: "Follow-up task or message to send to the child" }),
	timeout_seconds: Type.Optional(Type.Number({ description: "Maximum wall-clock seconds to wait for the agent to finish (must be > 0). If the deadline expires the agent is aborted, removed from the registry, and an error is thrown." })),
});

const killSchema = Type.Object({
	id: Type.String({ description: "ID of the child agent to kill" }),
});

const reportSchema = Type.Object({
	message: Type.String({ description: "Report content to send to the parent agent" }),
});

const listSchema = Type.Object({});

// ---------------------------------------------------------------------------
// Extension config
// ---------------------------------------------------------------------------

const CONFIG_FILE_NAME = "pi-agents.json";
const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_MAX_LIVE_AGENTS = 6;

interface PiAgentsConfig {
	maxDepth: number;
	maxLiveAgents: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeInt(value: unknown, key: string, path: string, min: number): number {
	if (!Number.isInteger(value) || (value as number) < min) {
		throw new Error(`${path}: "${key}" must be an integer >= ${min}`);
	}
	return value as number;
}

async function readConfigFragment(path: string): Promise<Partial<PiAgentsConfig>> {
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

	const config: Partial<PiAgentsConfig> = {};
	if ("maxDepth" in parsed) {
		config.maxDepth = normalizeInt(parsed.maxDepth, "maxDepth", path, 0);
	}
	if ("maxLiveAgents" in parsed) {
		config.maxLiveAgents = normalizeInt(parsed.maxLiveAgents, "maxLiveAgents", path, 1);
	}
	return config;
}

async function loadPiAgentsConfig(cwd: string): Promise<PiAgentsConfig> {
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

	const resolvePath = async (raw: string): Promise<string> => {
		const p = raw.replace(/^@/, "");
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
			const filePath = await resolvePath(params.path);
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
			const filePath = await resolvePath(params.path);
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
			const filePath = await resolvePath(params.path);
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

	return [readTool, writeTool, editTool, bashTool] as AgentTool<any>[];
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

function pushActivity(state: ChildState, item: ActivityItem) {
	state.activity.push(item);
	if (state.activity.length > MAX_ACTIVITY_STORAGE) {
		state.activity = state.activity.slice(-MAX_ACTIVITY_STORAGE);
	}
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
			pushActivity(state, {
				type: "tool_start",
				label: formatToolActivity(event.toolName, event.args),
				timestamp: Date.now(),
			});
			emit();
		} else if (event.type === "tool_execution_end") {
			if (event.toolName === "report" && !event.isError) {
				const latest = state.reports[state.reports.length - 1];
				if (latest) {
					pushActivity(state, {
						type: "report",
						label: `report "${latest.length > 50 ? latest.slice(0, 50) + "..." : latest}"`,
						timestamp: Date.now(),
					});
				}
			} else {
				pushActivity(state, {
					type: "tool_end",
					label: `${event.toolName} ${event.isError ? "failed" : "done"}`,
					timestamp: Date.now(),
				});
			}
			emit();
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			const msg = event.message as AssistantMessage;
			const textParts = msg.content.filter((c): c is TextContent => c.type === "text");
			if (textParts.length > 0) {
				const preview = textParts[0].text.split("\n")[0];
				pushActivity(state, {
					type: "text",
					label: preview.length > 60 ? preview.slice(0, 60) + "..." : preview,
					timestamp: Date.now(),
				});
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
// Renderers (shared by spawn_agent and delegate)
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

function activityIcon(type: ActivityItem["type"], theme: any): string {
	return type === "report" ? theme.fg("warning", "↑")
		: type === "tool_start" ? theme.fg("accent", "→")
		: type === "text" ? theme.fg("dim", "·")
		: theme.fg("success", "✓");
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
			text += "\n  " + activityIcon(item.type, theme) + " " + theme.fg("dim", item.label);
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
				container.addChild(new Text(`  ${activityIcon(item.type, theme)} ${theme.fg("dim", item.label)}`, 0, 0));
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
			text += "\n  " + activityIcon(item.type, theme) + " " + theme.fg("dim", item.label);
		}
	}

	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function multiAgent(pi: ExtensionAPI) {
	const children = new Map<string, ChildState>();
	// cachedGetApiKey is initialized from the first spawn_agent ctx.
	// This assumes modelRegistry is stable for the session lifetime.
	let cachedGetApiKey: ((provider: string) => Promise<string | undefined>) | undefined;
	let cachedConfig: PiAgentsConfig | undefined;
	let cachedConfigCwd: string | undefined;
	let cachedConfigError: Error | undefined;

	async function getConfig(cwd: string): Promise<PiAgentsConfig> {
		if (cachedConfig && cachedConfigCwd === cwd) return cachedConfig;
		if (cachedConfigError && cachedConfigCwd === cwd) throw cachedConfigError;

		try {
			const config = await loadPiAgentsConfig(cwd);
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
				`Call list_agents() for full status.`,
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
		const state = getAccessibleTarget(callerId, params.id, "delegate to");
		if (state.agent.state.isStreaming || state.locked) {
			throw new Error(
				`Child agent "${params.id}" is still running. ` +
				`Wait for the current spawn_agent or delegate call to complete before sending more work.`,
			);
		}

		const reportStart = state.reports.length;
		state.activity = [];

		const onAbort = () => state.agent.abort();
		signal?.addEventListener("abort", onAbort, { once: true });

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
		const spawnTool: AgentTool<typeof spawnSchema> = {
			name: "spawn_agent",
			label: "Spawn Agent",
			description:
				"Spawn a descendant agent within your own subtree. " +
				"Subject to configured maxDepth and maxLiveAgents limits.",
			parameters: spawnSchema,
			execute: async (_toolCallId, params, signal, onUpdate) => {
				return await spawnChild(callerId, params, model, cwd, signal, onUpdate);
			},
		};

		const delegateTool: AgentTool<typeof delegateSchema> = {
			name: "delegate",
			label: "Delegate",
			description: "Send follow-up work to a descendant agent in your subtree.",
			parameters: delegateSchema,
			execute: async (_toolCallId, params, signal, onUpdate) => {
				return await delegateToChild(callerId, params, signal, onUpdate);
			},
		};

		const killTool: AgentTool<typeof killSchema> = {
			name: "kill_agent",
			label: "Kill Agent",
			description: "Kill a descendant agent in your subtree. Descendants are killed recursively.",
			parameters: killSchema,
			execute: async (_toolCallId, params) => {
				const state = getAccessibleTarget(callerId, params.id, "kill");
				const { killedIds, reportCount } = killSubtree(state.id);
				return {
					content: [{ type: "text", text: `Killed ${killedIds.length} agent(s): ${killedIds.join(", ")}.` }],
					details: { childId: state.id, killedIds, reportCount },
				};
			},
		};

		const listTool: AgentTool<typeof listSchema> = {
			name: "list_agents",
			label: "List Agents",
			description: "List agents in your subtree, including yourself.",
			parameters: listSchema,
			execute: async () => listAgentsResult(callerId),
		};

		return [spawnTool, delegateTool, killTool, listTool] as AgentTool<any>[];
	}

	function buildChildAgent(
		childId: string,
		systemPrompt: string,
		model: Model<any>,
		cwd: string,
		reports: string[],
	): Agent {
		const reportTool = buildReportTool(childId, reports);
		const childTools: AgentTool<any>[] = [
			...createChildTools(cwd),
			...createChildManagementTools(childId, cwd, model),
			reportTool,
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
		if (children.has(params.id)) {
			throw new Error(
				`Child agent "${params.id}" already exists. ` +
				`Use delegate("${params.id}", …) to send it more work, or call list_agents() to inspect active agents.`,
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

	pi.on("session_start", async (_event, ctx) => {
		clearConfigCache();
		try {
			await getConfig(ctx.cwd);
		} catch (err) {
			if (ctx.hasUI) {
				ctx.ui.notify(`pi-agents config error: ${(err as Error).message}`, "error");
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

	// ── spawn_agent ─────────────────────────────────────────────────────

	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		description:
			"Spawn a child agent with its own system prompt and task. " +
			"Children get read, write, edit, bash, report, and descendant-scoped orchestration tools. " +
			"Recursive spawning is bounded by pi-agents.json maxDepth/maxLiveAgents. " +
			"This call blocks until the child finishes. Multiple spawn_agent calls in the same turn run concurrently. " +
			"On success, use delegate to send it more work or kill_agent to free its resources. " +
			"On any error (including timeout) the agent subtree is removed from the registry automatically.",
		parameters: spawnSchema,

		renderCall(args, theme, context) {
			return renderAgentCall("spawn_agent", args, theme, context);
		},

		renderResult(result, options, theme, context) {
			return renderAgentResult(result, options, theme, context);
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const model = ctx.model;
			if (!model) throw new Error("No model selected");

			cachedGetApiKey ??= (provider: string) => ctx.modelRegistry.getApiKeyForProvider(provider);
			return await spawnChild(undefined, params, model, ctx.cwd, signal, onUpdate);
		},
	});

	// ── kill_agent ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "kill_agent",
		label: "Kill Agent",
		description:
			"Kill a child agent and free its resources. " +
			"If the child has descendants, they are killed recursively too.",
		parameters: killSchema,

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("kill_agent ")) + theme.fg("error", args.id || "..."), 0, 0);
		},

		renderResult(result) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "done";
			return new Text(text, 0, 0);
		},

		async execute(_toolCallId, params) {
			const state = getAccessibleTarget(undefined, params.id, "kill", true);
			const { killedIds, reportCount } = killSubtree(state.id);
			return {
				content: [{ type: "text", text: `Killed ${killedIds.length} agent(s): ${killedIds.join(", ")}.` }],
				details: { childId: state.id, killedIds, reportCount },
			};
		},
	});

	// ── delegate ────────────────────────────────────────────────────────

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"Send a follow-up task to an existing child agent (must have been previously spawned with spawn_agent). " +
			"The child resumes with its full conversation history and tools intact. " +
			"Blocks until the child finishes processing the new task.",
		parameters: delegateSchema,

		renderCall(args, theme, context) {
			return renderAgentCall("delegate", args, theme, context);
		},

		renderResult(result, options, theme, context) {
			return renderAgentResult(result, options, theme, context);
		},

		async execute(_toolCallId, params, signal, onUpdate) {
			return await delegateToChild(undefined, params, signal, onUpdate);
		},
	});

	// ── list_agents ─────────────────────────────────────────────────────

	pi.registerTool({
		name: "list_agents",
		label: "List Agents",
		description: "List all currently active child agent IDs and their status. Includes depth and parent metadata.",
		parameters: listSchema,
		async execute() {
			return listAgentsResult();
		},
	});
}
