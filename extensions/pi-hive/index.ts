/**
 * pi-hive: Multi-agent orchestration extension for pi.
 *
 * Root agents get simple orchestration tools: agent, send_message,
 * list_agents, kill_agent, workflows, and run management.
 * Children additionally get read, write, edit, bash, report, and descendant-scoped orchestration tools subject to maxDepth/maxLiveAgents.
 *
 * Children are in-process Agent instances that persist across interactions.
 * Report streams intermediate results to the parent via onUpdate.
 */

import { readFile, writeFile, mkdir, readdir, unlink, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { spawn as spawnProcess } from "node:child_process";
import { dirname, join, resolve, isAbsolute, sep, relative } from "node:path";
import { Agent, type AgentTool, type AgentToolResult, type AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Model, TextContent } from "@mariozechner/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, Container, Spacer } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	chainStepSchema,
	parallelTaskSchema,
	timeoutSecondsSchema,
	workflowSchema,
	loadWorkflow,
	listWorkflowsResult,
	showWorkflowResult,
	runWorkflow,
	substituteStepVars,
	workflowChildIds,
	type ChainStepParams,
	type ParallelTaskParams,
	type WorkflowParams,
} from "./workflows";

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

const agentActionSchema = Type.Union([
	Type.Literal("spawn"),
	Type.Literal("delegate"),
	Type.Literal("kill"),
	Type.Literal("list"),
	Type.Literal("chain"),
	Type.Literal("parallel"),
	Type.Literal("workflow"),
	Type.Literal("list_workflows"),
	Type.Literal("show_workflow"),
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
	timeout_seconds: Type.Optional(timeoutSecondsSchema),
	async: Type.Optional(Type.Boolean({ description: "For spawn/delegate/chain/parallel/workflow from root only: run in the background and return a run id immediately." })),
	steps: Type.Optional(Type.Array(chainStepSchema, { description: "Steps for chain action. Existing ids are delegated to; new ids require system_prompt." })),
	tasks: Type.Optional(Type.Array(parallelTaskSchema, { description: "Tasks for parallel action." })),
	workflow: Type.Optional(workflowSchema),
	workflow_path: Type.Optional(Type.String({ description: "Path to a workflow JSON file, relative to the workspace." })),
	workflow_name: Type.Optional(Type.String({ description: "Workflow name. Loads .pi/agent/workflows/<name>.json, falling back to ~/.pi/agent/workflows/<name>.json." })),
}, { additionalProperties: false });

const launchAgentSchema = Type.Object({
	description: Type.String({ description: "Short 3-7 word UI label for the delegated task" }),
	prompt: Type.String({ description: "Task for the agent to perform. Brief it like a smart colleague with no conversation context unless you include it here." }),
	subagent_type: Type.Optional(Type.String({ description: "Named agent type from list_agent_types. Defaults to general-purpose." })),
	name: Type.Optional(Type.String({ description: "Optional stable id/name for the agent, e.g. scout or review-1. Use this with send_message later." })),
	system_prompt: Type.Optional(Type.String({ description: "Optional one-off system prompt. If set, subagent_type is only used as metadata/id prefix." })),
	run_in_background: Type.Optional(Type.Boolean({ description: "Run in the background and return run_id/agent_id immediately. Root only." })),
	run_id: Type.Optional(Type.String({ description: "Optional run id when run_in_background=true." })),
	timeout_seconds: Type.Optional(timeoutSecondsSchema),
}, { additionalProperties: false });

const sendMessageSchema = Type.Object({
	to: Type.String({ description: "Agent id/name returned by agent or shown by list_agents" }),
	message: Type.String({ description: "Follow-up message for the agent" }),
	run_in_background: Type.Optional(Type.Boolean({ description: "Queue/run this follow-up in the background. Root only." })),
	run_id: Type.Optional(Type.String({ description: "Optional run id when run_in_background=true." })),
	timeout_seconds: Type.Optional(timeoutSecondsSchema),
}, { additionalProperties: false });

const killAgentSchema = Type.Object({
	id: Type.String({ description: "Agent id/name to kill" }),
}, { additionalProperties: false });

const runStatusSchema = Type.Object({
	run_id: Type.String({ description: "Run id returned by agent/send_message/run_workflow" }),
	wait: Type.Optional(Type.Boolean({ description: "Wait for the run to finish before returning" })),
	timeout_seconds: Type.Optional(timeoutSecondsSchema),
}, { additionalProperties: false });

const cancelRunSchema = Type.Object({
	run_id: Type.String({ description: "Run id to cancel" }),
}, { additionalProperties: false });

const runWorkflowSchema = Type.Object({
	workflow: Type.Optional(workflowSchema),
	workflow_path: Type.Optional(Type.String({ description: "Path to a workflow JSON file, relative to the workspace." })),
	workflow_name: Type.Optional(Type.String({ description: "Workflow name. Loads .pi/agent/workflows/<name>.json, falling back to ~/.pi/agent/workflows/<name>.json." })),
	run_in_background: Type.Optional(Type.Boolean({ description: "Run workflow in the background and return run_id immediately." })),
	run_id: Type.Optional(Type.String({ description: "Optional run id." })),
}, { additionalProperties: false });

const showWorkflowSchema = Type.Object({
	workflow_name: Type.String({ description: "Workflow name to show" }),
}, { additionalProperties: false });

const emptySchema = Type.Object({}, { additionalProperties: false });

const reportSchema = Type.Object({
	message: Type.String({ description: "Report content to send to the parent agent" }),
}, { additionalProperties: false });

// ---------------------------------------------------------------------------
// Extension config
// ---------------------------------------------------------------------------

const CONFIG_FILE_NAME = "pi-hive.json";

const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_MAX_LIVE_AGENTS = 20;

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
// Agent definitions
// ---------------------------------------------------------------------------

const DEFAULT_AGENT_TYPE = "general-purpose";
const AGENT_DEFINITION_DIRS = [
	{ scope: "project" as const, relativePath: [".pi", "agents"] },
	{ scope: "project" as const, relativePath: [".pi", "agent", "agents"] },
];

interface HiveAgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	source: "built-in" | "project" | "global";
	path?: string;
	tools?: string[];
}

const GENERAL_PURPOSE_SYSTEM_PROMPT = `You are a focused worker agent for pi. Complete the delegated task fully, but do not gold-plate.

Strengths:
- Search and inspect code/configuration across a workspace.
- Analyze multiple files and synthesize concise findings.
- Perform scoped edits when explicitly asked.

Guidelines:
- Briefly state assumptions when context is missing.
- Use tools directly; avoid asking the parent to do basic discovery.
- Prefer editing existing files over creating new files.
- Do not create documentation files unless explicitly requested.
- End with a concise report: what you did, key findings, and any blockers.`;

function builtInAgentDefinitions(): HiveAgentDefinition[] {
	return [{
		name: DEFAULT_AGENT_TYPE,
		description: "General-purpose worker for code research, analysis, and scoped implementation tasks.",
		systemPrompt: GENERAL_PURPOSE_SYSTEM_PROMPT,
		source: "built-in",
	}];
}

function stripQuotes(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseStringList(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
	const values = inner.split(",").map((part) => stripQuotes(part).trim()).filter(Boolean);
	return values.length > 0 ? values : undefined;
}

function parseMarkdownFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
	if (!raw.startsWith("---\n") && raw.trim() !== "---") return { frontmatter: {}, body: raw.trim() };
	const end = raw.indexOf("\n---", 4);
	if (end === -1) return { frontmatter: {}, body: raw.trim() };
	const block = raw.slice(4, end);
	const body = raw.slice(end + "\n---".length).replace(/^\r?\n/, "").trim();
	const frontmatter: Record<string, string> = {};
	for (const line of block.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const idx = trimmed.indexOf(":");
		if (idx === -1) continue;
		const key = trimmed.slice(0, idx).trim();
		const value = stripQuotes(trimmed.slice(idx + 1).trim());
		if (key) frontmatter[key] = value;
	}
	return { frontmatter, body };
}

function fileBaseName(path: string): string {
	return path.split(sep).pop()!.replace(/\.md$/, "");
}

async function loadMarkdownAgentDefinition(path: string, source: "project" | "global"): Promise<HiveAgentDefinition | undefined> {
	const raw = await readFile(path, "utf-8");
	const { frontmatter, body } = parseMarkdownFrontmatter(raw);
	const systemPrompt = body.trim();
	if (!systemPrompt) return undefined;
	const name = (frontmatter.name || fileBaseName(path)).trim();
	if (!name) return undefined;
	if (!/^[A-Za-z0-9_.:-]+$/.test(name)) throw new Error(`${path}: agent name may only contain letters, numbers, _, ., :, and -`);
	return {
		name,
		description: frontmatter.description || `Custom ${name} agent`,
		systemPrompt,
		source,
		path,
		tools: parseStringList(frontmatter.tools),
	};
}

async function listAgentDefinitionFiles(cwd: string): Promise<Array<{ path: string; source: "project" | "global" }>> {
	const dirs = [
		{ dir: join(getAgentDir(), "agents"), source: "global" as const },
		...AGENT_DEFINITION_DIRS.map(({ relativePath, scope }) => ({ dir: resolve(cwd, ...relativePath), source: scope })),
	];
	const files: Array<{ path: string; source: "project" | "global" }> = [];
	for (const { dir, source } of dirs) {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw err;
		}
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith(".md")) files.push({ path: join(dir, entry.name), source });
		}
	}
	files.sort((a, b) => a.source === b.source ? a.path.localeCompare(b.path) : a.source === "global" ? -1 : 1);
	return files;
}

async function loadAgentDefinitions(cwd: string): Promise<HiveAgentDefinition[]> {
	const defs = new Map<string, HiveAgentDefinition>();
	for (const def of builtInAgentDefinitions()) defs.set(def.name, def);
	for (const file of await listAgentDefinitionFiles(cwd)) {
		const def = await loadMarkdownAgentDefinition(file.path, file.source);
		if (def) defs.set(def.name, def);
	}
	return [...defs.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function resolveAgentDefinition(cwd: string, type: string | undefined): Promise<HiveAgentDefinition> {
	const requested = type || DEFAULT_AGENT_TYPE;
	const definitions = await loadAgentDefinitions(cwd);
	const def = definitions.find((candidate) => candidate.name === requested);
	if (!def) {
		throw new Error(`Agent type "${requested}" not found. Available: ${definitions.map((candidate) => candidate.name).join(", ") || "(none)"}`);
	}
	return def;
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
const MAX_RENDERED_ACTIVITY = 8;
const MAX_ACTIVITY_STORAGE = 500;
const MAX_REPORTS_PER_AGENT = 100;
const MAX_REPORT_CHARS = 20_000;
const MAX_TOTAL_REPORT_CHARS = 100_000;
const MAX_READ_LINES = 10_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_SECONDS = 86_400;
const MAX_RUNS = 100;
const MAX_RUNNING_RUNS = 10;
const SHUTDOWN_GRACE_MS = 5000;

function isWithinDirectory(base: string, target: string): boolean {
	const rel = relative(base, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function normalizePositiveTimeout(value: number | undefined, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_SECONDS) {
		throw new Error(`${label} must be an integer number of seconds between 1 and ${MAX_TIMEOUT_SECONDS}`);
	}
	return value;
}

function normalizePositiveIntegerParam(value: number | undefined, label: string, max?: number): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value < 1 || (max !== undefined && value > max)) {
		throw new Error(`${label} must be an integer >= 1${max !== undefined ? ` and <= ${max}` : ""}`);
	}
	return value;
}

async function assertReadableRegularFile(path: string): Promise<void> {
	const info = await stat(path);
	if (!info.isFile()) throw new Error(`Cannot read non-regular file: ${path}`);
	if (info.size > MAX_FILE_BYTES) throw new Error(`File too large: ${path} is ${info.size} bytes; max ${MAX_FILE_BYTES}`);
}

function assertWriteSize(content: string): void {
	const bytes = Buffer.byteLength(content, "utf-8");
	if (bytes > MAX_WRITE_BYTES) throw new Error(`Write content too large: ${bytes} bytes; max ${MAX_WRITE_BYTES}`);
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
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start from (1-indexed)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LINES, description: `Maximum number of lines to read (1..${MAX_READ_LINES})` })),
}, { additionalProperties: false });

const writeToolSchema = Type.Object({
	path: Type.String({ description: "File path to write" }),
	content: Type.String({ maxLength: MAX_WRITE_BYTES, description: "Content to write" }),
}, { additionalProperties: false });

const editToolSchema = Type.Object({
	path: Type.String({ description: "File path to edit" }),
	edits: Type.Array(
		Type.Object({
			oldText: Type.String({ minLength: 1, maxLength: 20_000, description: "Exact text to find" }),
			newText: Type.String({ maxLength: MAX_WRITE_BYTES, description: "Replacement text" }),
		}, { additionalProperties: false }),
		{ minItems: 1, maxItems: 50 },
	),
}, { additionalProperties: false });

const bashToolSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(timeoutSecondsSchema),
}, { additionalProperties: false });

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

	const readTool: AgentTool<any> = {
		name: "read",
		label: "Read",
		description: "Read a file's contents. Use offset/limit for large files.",
		parameters: readToolSchema as any,
		execute: async (_id, params) => {
			const filePath = await resolvePath(params.path.replace(/^@/, ""));
			await assertReadableRegularFile(filePath);
			let content: string;
			try {
				content = await readFile(filePath, "utf-8");
			} catch (err) {
				throw new Error(`Cannot read ${params.path}: ${(err as Error).message}`);
			}
			const lines = content.split("\n");
			const offset = normalizePositiveIntegerParam(params.offset, "read offset") ?? 1;
			const limit = normalizePositiveIntegerParam(params.limit, "read limit", MAX_READ_LINES) ?? Math.min(lines.length, MAX_READ_LINES);
			const sliced = lines.slice(offset - 1, offset - 1 + limit);
			const result = sliced.join("\n");
			let truncated = result.length > 50000 ? result.slice(0, 50000) + "\n[truncated]" : result;
			if (params.limit === undefined && lines.length > MAX_READ_LINES) truncated += `\n[truncated to ${MAX_READ_LINES} lines; pass offset/limit to read more]`;
			return { content: [{ type: "text", text: truncated }], details: { path: filePath } };
		},
	};

	const writeTool: AgentTool<any> = {
		name: "write",
		label: "Write",
		description: "Write content to a file. Creates parent directories.",
		parameters: writeToolSchema as any,
		execute: async (_id, params) => {
			const filePath = await resolvePath(params.path.replace(/^@/, ""));
			assertWriteSize(params.content);
			await mkdir(dirname(filePath), { recursive: true });
			await writeFile(filePath, params.content, "utf-8");
			return {
				content: [{ type: "text", text: `Wrote ${params.content.split("\n").length} lines to ${params.path}` }],
				details: { path: filePath },
			};
		},
	};

	const editTool: AgentTool<any> = {
		name: "edit",
		label: "Edit",
		description: "Edit a file using exact text replacement.",
		parameters: editToolSchema as any,
		execute: async (_id, params) => {
			const filePath = await resolvePath(params.path.replace(/^@/, ""));
			await assertReadableRegularFile(filePath);
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
			assertWriteSize(content);
			await writeFile(filePath, content, "utf-8");
			return {
				content: [{ type: "text", text: `Applied ${params.edits.length} edit(s) to ${params.path}` }],
				details: { path: filePath },
			};
		},
	};

	const DEFAULT_BASH_TIMEOUT_S = 120;
	const BASH_KILL_GRACE_MS = 3000;
	const BASH_FORCE_SETTLE_GRACE_MS = 1000;

	const bashTool: AgentTool<any> = {
		name: "bash",
		label: "Bash",
		description: "Execute a bash command. Returns stdout followed by stderr (prefixed with STDERR:), truncated if large.",
		parameters: bashToolSchema as any,
		execute: async (_id, params, signal) => {
			// Default timeout + hard settlement prevents pipe-drain deadlock when commands fork background processes.
			const commandTimeout = normalizePositiveTimeout(params.timeout ?? DEFAULT_BASH_TIMEOUT_S, "bash timeout");
			if (commandTimeout === undefined) throw new Error("bash timeout is required");
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
					if (stdout.length < MAX_OUTPUT_CHARS) stdout += d.toString().slice(0, MAX_OUTPUT_CHARS - stdout.length);
				});
				proc.stderr!.on("data", (d: Buffer) => {
					if (stderr.length < MAX_OUTPUT_CHARS) stderr += d.toString().slice(0, MAX_OUTPUT_CHARS - stderr.length);
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
				let aborted = false;
				let settled = false;
				let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
				let escalationHandle: ReturnType<typeof setTimeout> | undefined;
				let forceSettleHandle: ReturnType<typeof setTimeout> | undefined;

				const buildOutput = (code: number | null) => {
					let output = stdout;
					if (stderr) output += (output ? "\n" : "") + `STDERR:\n${stderr}`;
					if (timedOut) {
						const partial = output || "(no output before timeout)";
						output = `[TIMEOUT after ${commandTimeout}s — process group killed; output may be incomplete]\n${partial}`;
					} else if (aborted) {
						const partial = output || "(no output before abort)";
						output = `[ABORTED — process group killed; output may be incomplete]\n${partial}`;
					} else if (!output) {
						output = `(exit code ${code ?? 0})`;
					}
					if (output.length > 50000) {
						output = "[output truncated — showing last 50000 chars]\n" + output.slice(-50000);
					}
					return output;
				};

				const cleanup = () => {
					clearTimeout(timeoutHandle);
					clearTimeout(escalationHandle);
					clearTimeout(forceSettleHandle);
					if (signal) signal.removeEventListener("abort", onAbort);
					proc.stdout?.destroy();
					proc.stderr?.destroy();
					proc.unref();
				};
				const settle = (code: number | null) => {
					if (settled) return;
					settled = true;
					cleanup();
					res({ content: [{ type: "text", text: buildOutput(code) }], details: { exitCode: code, timedOut, aborted } });
				};
				const terminate = (reason: "abort" | "timeout") => {
					if (settled) return;
					if (reason === "timeout") timedOut = true;
					if (reason === "abort") aborted = true;
					killGroup("SIGTERM");
					clearTimeout(escalationHandle);
					clearTimeout(forceSettleHandle);
					escalationHandle = setTimeout(() => killGroup("SIGKILL"), BASH_KILL_GRACE_MS);
					forceSettleHandle = setTimeout(() => settle(null), BASH_KILL_GRACE_MS + BASH_FORCE_SETTLE_GRACE_MS);
				};

				timeoutHandle = setTimeout(() => terminate("timeout"), commandTimeout * 1000);
				const onAbort = () => terminate("abort");

				proc.on("close", (code) => settle(code ?? 0));
				proc.on("error", (err) => {
					if (settled) return;
					settled = true;
					cleanup();
					res({ content: [{ type: "text", text: `Error: ${err.message}` }], details: { exitCode: 1, timedOut: false, aborted } });
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

function filterToolsByNames(tools: AgentTool<any>[], allowed: string[] | undefined): AgentTool<any>[] {
	if (!allowed || allowed.length === 0 || allowed.includes("*")) return tools;
	const allowedSet = new Set(allowed);
	return tools.filter((tool) => allowedSet.has(tool.name) || (tool.label !== undefined && allowedSet.has(tool.label)));
}

// ---------------------------------------------------------------------------
// Child state
// ---------------------------------------------------------------------------

interface ConfigCacheState {
	config?: PiHiveConfig;
	configCwd?: string;
	configError?: Error;
}

interface HiveState {
	workspaceKey: string;
	children: Map<string, ChildState>;
	runs: Map<string, RunState>;
	configCache: ConfigCacheState;
	getApiKey?: (provider: string) => Promise<string | undefined>;
}

interface ChildState {
	id: string;
	parentId?: string;
	rootId: string;
	depth: number;
	cwd: string;
	workspaceKey: string;
	createdAt: number;
	agentType?: string;
	description?: string;
	toolNames?: string[];
	agent: Agent;
	reports: string[];
	activity: ActivityItem[];
	locked: boolean;
	killed: boolean;
}



type AgentAction = "spawn" | "delegate" | "kill" | "list" | "chain" | "parallel" | "workflow" | "list_workflows" | "show_workflow" | "list_runs" | "result" | "wait" | "cancel";

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
	workflow?: WorkflowParams;
	workflow_path?: string;
	workflow_name?: string;
}

interface LaunchAgentParams {
	description: string;
	prompt: string;
	subagent_type?: string;
	name?: string;
	system_prompt?: string;
	run_in_background?: boolean;
	run_id?: string;
	timeout_seconds?: number;
}

interface SendMessageParams {
	to: string;
	message: string;
	run_in_background?: boolean;
	run_id?: string;
	timeout_seconds?: number;
}

interface RunStatusParams {
	run_id: string;
	wait?: boolean;
	timeout_seconds?: number;
}

interface RunWorkflowToolParams {
	workflow?: WorkflowParams;
	workflow_path?: string;
	workflow_name?: string;
	run_in_background?: boolean;
	run_id?: string;
}

type RunKind = "spawn" | "delegate" | "chain" | "parallel" | "workflow";
type RunStatus = "running" | "succeeded" | "failed" | "killed";

interface RunState {
	id: string;
	workspaceKey: string;
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

interface RunRecord {
	id: string;
	workspaceKey: string;
	kind: RunKind;
	status: RunStatus;
	startedAt: number;
	finishedAt?: number;
	children: string[];
	resultText?: string;
	error?: string;
}

function runResultText(result?: AgentToolResult<unknown>): string | undefined {
	if (!result) return undefined;
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function runRecordPath(workspaceKey: string, runId: string): string {
	return join(workspaceKey, ".pi", "agent", "runs", `${runId}.json`);
}

function toRunRecord(run: RunState): RunRecord {
	const resultText = runResultText(run.result);
	return {
		id: run.id,
		workspaceKey: run.workspaceKey,
		kind: run.kind,
		status: run.status,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		children: [...run.children],
		resultText: resultText && resultText.length > 50_000 ? resultText.slice(-50_000) : resultText,
		error: run.error,
	};
}

async function persistRunRecord(run: RunState): Promise<void> {
	const record = toRunRecord(run);
	const dir = join(run.workspaceKey, ".pi", "agent", "runs");
	await mkdir(dir, { recursive: true });
	await writeFile(runRecordPath(run.workspaceKey, run.id), `${JSON.stringify(record, null, 2)}\n`, "utf-8");
	await prunePersistedRuns(run.workspaceKey);
}

async function safePersistRunRecord(run: RunState): Promise<void> {
	try {
		await persistRunRecord(run);
	} catch (err) {
		console.warn(`pi-hive: failed to persist run ${run.id}: ${(err as Error).message}`);
	}
}

async function prunePersistedRuns(workspaceKey: string): Promise<void> {
	const dir = join(workspaceKey, ".pi", "agent", "runs");
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}

	const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => join(dir, entry.name));
	const records = await Promise.all(files.map(async (file) => {
		try {
			const parsed = JSON.parse(await readFile(file, "utf-8")) as Partial<RunRecord>;
			return { file, startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0, finishedAt: typeof parsed.finishedAt === "number" ? parsed.finishedAt : 0 };
		} catch {
			return { file, startedAt: 0, finishedAt: 0 };
		}
	}));

	records.sort((a, b) => a.startedAt - b.startedAt || a.finishedAt - b.finishedAt);
	while (records.length > MAX_RUNS) {
		const victim = records.shift()!;
		await unlink(victim.file).catch(() => undefined);
	}
}

async function readPersistedRunRecords(workspaceKey: string): Promise<RunRecord[]> {
	const dir = join(workspaceKey, ".pi", "agent", "runs");
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}

	const records: RunRecord[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const file = join(dir, entry.name);
		try {
			const parsed = JSON.parse(await readFile(file, "utf-8")) as Partial<RunRecord>;
			if (typeof parsed.id !== "string" || typeof parsed.kind !== "string" || typeof parsed.status !== "string" || typeof parsed.startedAt !== "number") continue;
			if (parsed.workspaceKey !== undefined && parsed.workspaceKey !== workspaceKey) continue;
			records.push({
				id: parsed.id,
				workspaceKey,
				kind: parsed.kind as RunKind,
				status: parsed.status as RunStatus,
				startedAt: parsed.startedAt,
				finishedAt: typeof parsed.finishedAt === "number" ? parsed.finishedAt : undefined,
				children: Array.isArray(parsed.children) ? parsed.children.filter((child): child is string => typeof child === "string") : [],
				resultText: typeof parsed.resultText === "string" ? parsed.resultText : undefined,
				error: typeof parsed.error === "string" ? parsed.error : undefined,
			});
		} catch {
			continue;
		}
	}
return records;
}

function formatRunRecord(run: RunRecord): AgentToolResult<unknown> {
	const lines = [
		`run_id: ${run.id}`,
		`kind: ${run.kind}`,
		`status: ${run.status}`,
		`children: ${run.children.length > 0 ? run.children.join(", ") : "(none)"}`,
	];
	if (run.error) lines.push(`error: ${run.error}`);
	if (run.resultText) lines.push("", run.resultText);
	return { content: [{ type: "text", text: lines.join("\n") }], details: { run } };
}

function formatRunState(run: RunState): AgentToolResult<unknown> {
	return formatRunRecord(toRunRecord(run));
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
function buildReportTool(childId: string, reports: string[]): AgentTool<any> {
	return {
		name: "report",
		label: "Report",
		description:
			"Send a report to the parent agent. Reports are bounded: " +
			`max ${MAX_REPORTS_PER_AGENT} reports, ${MAX_REPORT_CHARS} chars each, ${MAX_TOTAL_REPORT_CHARS} chars total per agent.`,
		parameters: reportSchema as any,
		execute: async (_toolCallId, params) => {
			if (params.message.length > MAX_REPORT_CHARS) {
				throw new Error(`Report exceeds ${MAX_REPORT_CHARS} chars.`);
			}
			if (reports.length >= MAX_REPORTS_PER_AGENT) {
				throw new Error(`Report limit exceeded: max ${MAX_REPORTS_PER_AGENT} reports per agent.`);
			}
			const totalChars = reports.reduce((sum, report) => sum + report.length, 0) + params.message.length;
			if (totalChars > MAX_TOTAL_REPORT_CHARS) {
				throw new Error(`Report storage limit exceeded: max ${MAX_TOTAL_REPORT_CHARS} chars per agent.`);
			}
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
	// Agent versions differ; errorMessage is best-effort diagnostic metadata.
	const error = (state.agent.state as { errorMessage?: string }).errorMessage;
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

function isAgentToolDetails(details: unknown): details is AgentToolDetails {
	return !!details
		&& typeof details === "object"
		&& "childId" in details
		&& typeof (details as { childId?: unknown }).childId === "string"
		&& Array.isArray((details as { activity?: unknown }).activity)
		&& Array.isArray((details as { reports?: unknown }).reports)
		&& typeof (details as { done?: unknown }).done === "boolean";
}

function renderAgentResult(
	result: { content: any[]; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: any,
	context: any,
) {
	// Runtime shape check before casting to AgentToolDetails. `kill` also has childId but not this shape.
	const details = isAgentToolDetails(result.details) ? result.details : undefined;

	if (!options.isPartial && context.state._spinnerInterval) {
		clearInterval(context.state._spinnerInterval);
		context.state._spinnerInterval = null;
	}

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

	// -- done: spinner was cleared above --

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
	const states = new Map<string, HiveState>();

	function workspaceKey(cwd: string): string {
		return resolve(cwd);
	}

	function getState(cwd: string): HiveState {
		const key = workspaceKey(cwd);
		let state = states.get(key);
		if (!state) {
			state = { workspaceKey: key, children: new Map(), runs: new Map(), configCache: {} };
			states.set(key, state);
		}
		return state;
	}

	async function getConfig(state: HiveState, cwd: string): Promise<PiHiveConfig> {
		const cache = state.configCache;
		if (cache.config && cache.configCwd === cwd) return cache.config;
		if (cache.configError && cache.configCwd === cwd) throw cache.configError;

		try {
			const config = await loadPiHiveConfig(cwd);
			cache.config = config;
			cache.configCwd = cwd;
			cache.configError = undefined;
			return config;
		} catch (err) {
			cache.config = undefined;
			cache.configCwd = cwd;
			cache.configError = err instanceof Error ? err : new Error(String(err));
			throw cache.configError;
		}
	}

	function clearConfigCache(state: HiveState): void {
		state.configCache = {};
	}

	function getCallerState(state: HiveState, callerId: string): ChildState {
		const caller = state.children.get(callerId);
		if (!caller) throw new Error(`Caller agent "${callerId}" is no longer active.`);
		return caller;
	}

	function isInSubtree(state: HiveState, targetId: string, ancestorId: string, allowSelf = true): boolean {
		let current: string | undefined = targetId;
		while (current) {
			if (current === ancestorId) return allowSelf || current !== targetId;
			current = state.children.get(current)?.parentId;
		}
		return false;
	}

	function getSubtreeIds(state: HiveState, rootId: string): string[] {
		const result: string[] = [];
		const queue = [rootId];
		while (queue.length > 0) {
			const current = queue.shift()!;
			if (!state.children.has(current)) continue;
			result.push(current);
			const childIds = [...state.children.entries()]
				.filter(([, child]) => child.parentId === current)
				.map(([id]) => id)
				.sort((a, b) => a.localeCompare(b));
			queue.push(...childIds);
		}
		return result;
	}

	function getScopedEntries(state: HiveState, callerId?: string): Array<[string, ChildState]> {
		const entries = [...state.children.entries()].filter(([id]) => !callerId || isInSubtree(state, id, callerId, true));
		entries.sort((a, b) => a[1].depth - b[1].depth || a[0].localeCompare(b[0]));
		return entries;
	}

	function formatScopedAgentIds(state: HiveState, callerId?: string): string {
		const ids = getScopedEntries(state, callerId).map(([id]) => id);
		return ids.length > 0 ? ids.join(", ") : "(none)";
	}

	function getAccessibleTarget(state: HiveState, callerId: string | undefined, targetId: string, action: string, allowSelf = false): ChildState {
		if (callerId) getCallerState(state, callerId);
		const target = state.children.get(targetId);
		if (!target) {
			throw new Error(
				`Child agent "${targetId}" not found. Visible agents: ${formatScopedAgentIds(state, callerId)}. ` +
				`Call agent({ action: "list" }) for full status.`,
			);
		}
		if (!callerId) return target;
		if (!isInSubtree(state, targetId, callerId, allowSelf)) {
			throw new Error(
				`Agent "${callerId}" may only ${action} descendant agents in its own subtree. ` +
				`"${targetId}" is outside that subtree.`,
			);
		}
		return target;
	}

	function killSubtree(state: HiveState, rootId: string): { killedIds: string[]; reportCount: number } {
		const ids = getSubtreeIds(state, rootId);
		let reportCount = 0;
		for (const id of ids) {
			const child = state.children.get(id);
			if (!child) continue;
			child.killed = true;
			reportCount += child.reports.length;
			child.agent.abort();
		}
		for (const id of ids) {
			state.children.delete(id);
		}
		return { killedIds: ids, reportCount };
	}

	function listAgentsResult(state: HiveState, callerId?: string): AgentToolResult<unknown> {
		if (callerId) getCallerState(state, callerId);
		const agents = getScopedEntries(state, callerId).map(([id, child]) => ({
			id,
			parentId: child.parentId,
			rootId: child.rootId,
			depth: child.depth,
			agentType: child.agentType,
			description: child.description,
			tools: child.toolNames,
			cwd: child.cwd,
			isRunning: child.agent.state.isStreaming || child.locked,
			reportCount: child.reports.length,
			activityCount: child.activity.length,
			createdAt: child.createdAt,
		}));
		const text = agents.length === 0
			? "No active child agents."
			: agents.map((agent) => {
				const type = agent.agentType ? `, type ${agent.agentType}` : "";
				const desc = agent.description ? ` — ${agent.description}` : "";
				return `• ${agent.id} — ${agent.isRunning ? "running" : "idle"}, depth ${agent.depth}${type}, ${agent.parentId ? `parent ${agent.parentId}` : "root child"}, ${agent.reportCount} reports${desc}`;
			}).join("\n");
		return { content: [{ type: "text", text }], details: { agents } };
	}

	async function listAgentTypesResult(cwd: string): Promise<AgentToolResult<unknown>> {
		const definitions = await loadAgentDefinitions(cwd);
		const text = definitions.length === 0
			? "No agent types found."
			: definitions.map((def) => {
				const tools = def.tools && def.tools.length > 0 ? `; tools: ${def.tools.join(", ")}` : "";
				const path = def.path ? `; ${shortenPath(def.path)}` : "";
				return `- ${def.name}: ${def.description} (${def.source}${tools}${path})`;
			}).join("\n");
		return { content: [{ type: "text", text }], details: { agents: definitions } };
	}

	function killAgentResult(state: HiveState, callerId: string | undefined, id: string): AgentToolResult<unknown> {
		const target = getAccessibleTarget(state, callerId, id, "kill", callerId === undefined);
		const { killedIds, reportCount } = killSubtree(state, target.id);
		return {
			content: [{ type: "text", text: `Killed ${killedIds.length} agent(s): ${killedIds.join(", ")}.` }],
			details: { childId: target.id, killedIds, reportCount },
		};
	}

	function normalizeAgentId(value: string, label: string): string {
		const trimmed = value.trim();
		if (!trimmed) throw new Error(`${label} must not be empty.`);
		if (!/^[A-Za-z0-9_.:-]+$/.test(trimmed)) throw new Error(`${label} may only contain letters, numbers, _, ., :, and -`);
		return trimmed;
	}

	function slugifyAgentId(value: string): string {
		const slug = value.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
		return slug || "agent";
	}

	function makeLaunchAgentId(state: HiveState, params: LaunchAgentParams, agentType: string): string {
		if (params.name !== undefined) return normalizeAgentId(params.name, "name");
		const base = `${slugifyAgentId(agentType)}-${slugifyAgentId(params.description)}`.slice(0, 64).replace(/-+$/g, "") || "agent";
		if (!state.children.has(base)) return base;
		for (let i = 2; i < 1000; i++) {
			const candidate = `${base}-${i}`;
			if (!state.children.has(candidate)) return candidate;
		}
		return `${base}-${Date.now().toString(36)}`;
	}

	function appendAgentTrailer(result: AgentToolResult<unknown>, id: string, agentType: string): AgentToolResult<unknown> {
		const text = runResultText(result) || "(no output)";
		return {
			...result,
			content: [{
				type: "text",
				text: `${text}\n\nagent_id: ${id}\nagent_type: ${agentType}\nContinue with send_message({ to: ${JSON.stringify(id)}, message: ... }) if follow-up work is needed.`,
			}],
		};
	}

	function formatStartedAgentRun(result: AgentToolResult<unknown>, id: string, agentType: string): AgentToolResult<unknown> {
		const details = result.details as { runId?: string; kind?: string; status?: string; children?: string[] } | undefined;
		const runId = details?.runId || "(unknown)";
		return {
			...result,
			content: [{
				type: "text",
				text: `Started agent "${id}" in the background.\nrun_id: ${runId}\nagent_id: ${id}\nagent_type: ${agentType}\nUse run_status({ run_id: ${JSON.stringify(runId)}, wait: true }) for the result, or send_message({ to: ${JSON.stringify(id)}, message: ... }) after it is idle.`,
			}],
		};
	}

	async function executeLaunchAgent(
		state: HiveState,
		callerId: string | undefined,
		params: LaunchAgentParams,
		model: Model<any> | undefined,
		cwd: string,
		signal?: AbortSignal,
		onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void,
		allowAsync = true,
	): Promise<AgentToolResult<unknown>> {
		const selectedModel = requireModel(model, "spawn");
		if (params.run_in_background && !allowAsync) throw new Error("run_in_background is only supported by root-level agent calls.");
		const definition = params.system_prompt !== undefined
			? { name: params.subagent_type || "custom", description: params.description, systemPrompt: params.system_prompt, source: "built-in" as const, tools: undefined }
			: await resolveAgentDefinition(cwd, params.subagent_type);
		const id = makeLaunchAgentId(state, params, definition.name);
		const spawnParams = {
			id,
			system_prompt: definition.systemPrompt,
			task: params.prompt,
			timeout_seconds: params.timeout_seconds,
			agent_type: definition.name,
			description: params.description,
			tools: definition.tools,
		};
		if (params.run_in_background) {
			const started = await startRun(state, "spawn", params.run_id, [id], (runSignal) => spawnChild(state, callerId, spawnParams, selectedModel, cwd, runSignal));
			return formatStartedAgentRun(started, id, definition.name);
		}
		const result = await spawnChild(state, callerId, spawnParams, selectedModel, cwd, signal, onUpdate);
		return appendAgentTrailer(result, id, definition.name);
	}

	async function executeSendMessage(
		state: HiveState,
		callerId: string | undefined,
		params: SendMessageParams,
		signal?: AbortSignal,
		onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void,
		allowAsync = true,
	): Promise<AgentToolResult<unknown>> {
		if (params.run_in_background && !allowAsync) throw new Error("run_in_background is only supported by root-level send_message calls.");
		const id = normalizeAgentId(params.to, "to");
		const target = getAccessibleTarget(state, callerId, id, "send a message to");
		const delegateParams = { id, message: params.message, timeout_seconds: params.timeout_seconds };
		if (params.run_in_background) {
			const started = await startRun(state, "delegate", params.run_id, [id], (runSignal) => delegateToChild(state, callerId, delegateParams, runSignal));
			return formatStartedAgentRun(started, id, target.agentType || "unknown");
		}
		const result = await delegateToChild(state, callerId, delegateParams, signal, onUpdate);
		return appendAgentTrailer(result, id, target.agentType || "unknown");
	}

	async function executeRunWorkflowTool(
		state: HiveState,
		callerId: string | undefined,
		params: RunWorkflowToolParams,
		model: Model<any> | undefined,
		cwd: string,
		signal?: AbortSignal,
	): Promise<AgentToolResult<unknown>> {
		return await executeAgentAction(state, callerId, {
			action: "workflow",
			workflow: params.workflow,
			workflow_path: params.workflow_path,
			workflow_name: params.workflow_name,
			async: params.run_in_background,
			run_id: params.run_id,
		}, model, cwd, signal, undefined, true);
	}

	async function executeRunStatus(state: HiveState, params: RunStatusParams): Promise<AgentToolResult<unknown>> {
		const run = await loadRunById(state, params.run_id);
		if (!run) throw new Error(`Run "${params.run_id}" not found in this workspace (it may have been evicted).`);
		if ("abortController" in run) {
			if (params.wait) await waitForRun(run, params.timeout_seconds);
			return formatRunStateResult(run);
		}
		return formatRunRecord(run);
	}

	async function executeCancelRun(state: HiveState, runId: string): Promise<AgentToolResult<unknown>> {
		const run = await loadRunById(state, runId);
		if (!run) throw new Error(`Run "${runId}" not found in this workspace (it may have been evicted).`);
		if (!("abortController" in run)) {
			if (run.status !== "running") return formatRunRecord(run);
			throw new Error(`Run "${runId}" is not active in this session and cannot be cancelled.`);
		}
		if (run.status !== "running") return formatRunStateResult(run);
		run.abortController.abort();
		let killed: string[] = [];
		for (const childId of run.children) {
			if (state.children.has(childId)) killed = killed.concat(killSubtree(state, childId).killedIds);
		}
		run.status = "killed";
		run.finishedAt = Date.now();
		await safePersistRunRecord(run);
		evictCompletedRuns(state);
		return { content: [{ type: "text", text: `Killed run "${run.id}" (${killed.length} agent(s): ${killed.join(", ") || "none"}).` }], details: { run: toRunDTO(run), killed } };
	}

	async function delegateToChild(
		state: HiveState,
		callerId: string | undefined,
		params: { id: string; message: string; timeout_seconds?: number },
		signal?: AbortSignal,
		onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void,
	): Promise<AgentToolResult<AgentToolDetails>> {
		if (signal?.aborted) throw new Error(`Agent "${params.id}" was aborted before start.`);
		const childState = getAccessibleTarget(state, callerId, params.id, "delegate to");
		if (childState.agent.state.isStreaming || childState.locked) {
			throw new Error(
				`Child agent "${params.id}" is still running. ` +
				`Wait for the current agent action to complete before sending more work.`,
			);
		}

		const reportStart = childState.reports.length;
		childState.activity = [];

		const onAbort = () => childState.agent.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();

		const unsub = subscribeChild(childState.agent, params.id, childState, onUpdate);
		childState.locked = true;
		try {
			const runPromise = childState.agent.prompt(params.message);
			await withOptionalTimeout(childState.agent, params.id, runPromise, params.timeout_seconds);
			if (childState.killed) {
				throw new Error(`Agent "${params.id}" was killed while running`);
			}
		} catch (err) {
			if (err instanceof AgentTimeoutError) {
				killSubtree(state, params.id);
			}
			throw err;
		} finally {
			childState.locked = false;
			unsub();
			signal?.removeEventListener("abort", onAbort);
		}

		return collectResult(params.id, childState, reportStart);
	}

	function createChildManagementTools(state: HiveState, callerId: string, cwd: string, model: Model<any>): AgentTool<any>[] {
		const launchTool: AgentTool<any> = {
			name: "agent",
			label: "Agent",
			description: "Launch a new descendant agent with description+prompt. Prefer this over the legacy hive action tool.",
			parameters: launchAgentSchema as any,
			execute: async (_toolCallId, params, signal, onUpdate) => {
				return await executeLaunchAgent(state, callerId, params as LaunchAgentParams, model, cwd, signal, onUpdate, false);
			},
		};
		const sendTool: AgentTool<any> = {
			name: "send_message",
			label: "Send Message",
			description: "Send follow-up work to one of your descendant agents.",
			parameters: sendMessageSchema as any,
			execute: async (_toolCallId, params, signal, onUpdate) => {
				return await executeSendMessage(state, callerId, params as SendMessageParams, signal, onUpdate, false);
			},
		};
		const listTool: AgentTool<any> = {
			name: "list_agents",
			label: "List Agents",
			description: "List active descendant agents visible to this agent.",
			parameters: emptySchema as any,
			execute: async () => listAgentsResult(state, callerId),
		};
		const killTool: AgentTool<any> = {
			name: "kill_agent",
			label: "Kill Agent",
			description: "Kill a descendant agent/subtree.",
			parameters: killAgentSchema as any,
			execute: async (_toolCallId, params) => killAgentResult(state, callerId, (params as { id: string }).id),
		};
		const listTypesTool: AgentTool<any> = {
			name: "list_agent_types",
			label: "List Agent Types",
			description: "List available subagent_type values and their descriptions.",
			parameters: emptySchema as any,
			execute: async () => listAgentTypesResult(cwd),
		};
		const legacyTool: AgentTool<any> = {
			name: "hive",
			label: "Hive Legacy",
			description: "Deprecated compatibility shim for action=spawn|delegate|kill|list|chain|parallel|workflow. Prefer agent/send_message/list_agents/kill_agent.",
			parameters: agentSchema as any,
			execute: async (_toolCallId, params, signal, onUpdate) => {
				return await executeAgentAction(state, callerId, params as AgentToolParams, model, cwd, signal, onUpdate, false);
			},
		};
		return [launchTool, sendTool, listTool, killTool, listTypesTool, legacyTool] as AgentTool<any>[];
	}

	function buildChildAgent(
		state: HiveState,
		childId: string,
		systemPrompt: string,
		model: Model<any>,
		cwd: string,
		reports: string[],
		toolNames?: string[],
	): Agent {
		const reportTool = buildReportTool(childId, reports);
		const childTools = filterToolsByNames([
			...createChildTools(cwd),
			...createChildManagementTools(state, childId, cwd, model),
			reportTool as AgentTool<any>,
		], toolNames);
		return new Agent({
			initialState: { systemPrompt, model, tools: childTools },
			getApiKey: state.getApiKey,
		});
	}

	async function spawnChild(
		state: HiveState,
		callerId: string | undefined,
		params: { id: string; system_prompt: string; task: string; timeout_seconds?: number; agent_type?: string; description?: string; tools?: string[] },
		model: Model<any>,
		cwd: string,
		signal?: AbortSignal,
		onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void,
	): Promise<AgentToolResult<AgentToolDetails>> {
		const config = await getConfig(state, cwd);
		if (signal?.aborted) throw new Error(`Agent "${params.id}" was aborted before start.`);
		if (state.children.has(params.id)) {
			throw new Error(
				`Agent "${params.id}" already exists in workspace "${state.workspaceKey}". ` +
				`Use send_message({ to: "${params.id}", message: ... }) for follow-up work, or list_agents to inspect active agents.`,
			);
		}

		const parentState = callerId ? getCallerState(state, callerId) : undefined;
		const childDepth = (parentState?.depth ?? 0) + 1;
		if (childDepth > config.maxDepth) {
			throw new Error(
				`Cannot spawn agent "${params.id}": depth ${childDepth} exceeds configured maxDepth ${config.maxDepth}.`,
			);
		}
		if (state.children.size >= config.maxLiveAgents) {
			throw new Error(
				`Cannot spawn agent "${params.id}": maxLiveAgents ${config.maxLiveAgents} reached. ` +
				`Kill or reuse an existing agent before spawning another one.`,
			);
		}

		const reports: string[] = [];
		const child = buildChildAgent(state, params.id, params.system_prompt, model, cwd, reports, params.tools);
		const childState: ChildState = {
			id: params.id,
			parentId: parentState?.id,
			rootId: parentState?.rootId ?? params.id,
			depth: childDepth,
			cwd,
			workspaceKey: state.workspaceKey,
			createdAt: Date.now(),
			agentType: params.agent_type,
			description: params.description,
			toolNames: params.tools,
			agent: child,
			reports,
			activity: [],
			locked: false,
			killed: false,
		};
		state.children.set(params.id, childState);

		const onAbort = () => child.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();

		const unsub = subscribeChild(child, params.id, childState, onUpdate);
		childState.locked = true;
		try {
			const runPromise = child.prompt(params.task);
			await withOptionalTimeout(child, params.id, runPromise, params.timeout_seconds);
			if (childState.killed) {
				throw new Error(`Agent "${params.id}" was killed while running`);
			}
		} catch (err) {
			killSubtree(state, params.id);
			throw err;
		} finally {
			childState.locked = false;
			unsub();
			signal?.removeEventListener("abort", onAbort);
		}

		return collectResult(params.id, childState, 0);
	}

	function makeRunId(kind: RunKind): string {
		return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}

	function textOf(result: AgentToolResult<unknown>): string {
		const first = result.content[0];
		return first?.type === "text" ? first.text : "";
	}

	function toRunDTO(run: RunState) {
		const resultText = run.result ? textOf(run.result) : undefined;
		return {
			id: run.id,
			workspaceKey: run.workspaceKey,
			kind: run.kind,
			status: run.status,
			startedAt: run.startedAt,
			finishedAt: run.finishedAt,
			children: [...run.children],
			error: run.error,
			resultText: resultText && resultText.length > 50_000 ? resultText.slice(-50_000) : resultText,
		};
	}

	function evictCompletedRuns(state: HiveState): void {
		const completed = [...state.runs.values()]
			.filter((run) => run.status !== "running")
			.sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt));
		while (state.runs.size > MAX_RUNS && completed.length > 0) {
			const run = completed.shift()!;
			state.runs.delete(run.id);
		}
	}

	async function loadRunById(state: HiveState, runId: string): Promise<RunState | RunRecord | undefined> {
		const live = state.runs.get(runId);
		if (live) return live;
		const persisted = await readPersistedRunRecords(state.workspaceKey);
		return persisted.find((run) => run.id === runId);
	}

	function formatRunStateResult(run: RunState): AgentToolResult<unknown> {
		return formatRunRecord(toRunRecord(run));
	}

	async function startRun(
		state: HiveState,
		kind: RunKind,
		runId: string | undefined,
		childrenForRun: string[],
		work: (signal: AbortSignal) => Promise<AgentToolResult<unknown>>,
	): Promise<AgentToolResult<unknown>> {
		evictCompletedRuns(state);
		const runningRuns = [...state.runs.values()].filter((run) => run.status === "running").length;
		if (runningRuns >= MAX_RUNNING_RUNS) throw new Error(`Cannot start ${kind} run: max running runs ${MAX_RUNNING_RUNS} reached.`);
		const id = runId || makeRunId(kind);
		if (state.runs.has(id)) throw new Error(`Run "${id}" already exists.`);
		const abortController = new AbortController();
		const run: RunState = { id, workspaceKey: state.workspaceKey, kind, status: "running", startedAt: Date.now(), children: childrenForRun, abortController, promise: Promise.resolve() };
		state.runs.set(id, run);
		await safePersistRunRecord(run);
		run.promise = (async () => {
			try {
				run.result = await work(abortController.signal);
				run.status = run.status === "killed" ? "killed" : "succeeded";
			} catch (err) {
				run.error = err instanceof Error ? err.message : String(err);
				run.status = run.status === "killed" ? "killed" : "failed";
			} finally {
				run.finishedAt = Date.now();
				await safePersistRunRecord(run);
				evictCompletedRuns(state);
			}
		})();
		return { content: [{ type: "text", text: `Started ${kind} run "${id}".` }], details: { runId: id, kind, status: "running", children: childrenForRun } };
	}

	async function executeLoggedRun(
		state: HiveState,
		kind: RunKind,
		runId: string | undefined,
		childrenForRun: string[],
		work: (signal: AbortSignal) => Promise<AgentToolResult<unknown>>,
		signal?: AbortSignal,
	): Promise<AgentToolResult<unknown>> {
		evictCompletedRuns(state);
		const runningRuns = [...state.runs.values()].filter((run) => run.status === "running").length;
		if (runningRuns >= MAX_RUNNING_RUNS) throw new Error(`Cannot start ${kind} run: max running runs ${MAX_RUNNING_RUNS} reached.`);
		const id = runId || makeRunId(kind);
		if (state.runs.has(id)) throw new Error(`Run "${id}" already exists.`);
		const abortController = new AbortController();
		const onAbort = () => abortController.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		const run: RunState = { id, workspaceKey: state.workspaceKey, kind, status: "running", startedAt: Date.now(), children: childrenForRun, abortController, promise: Promise.resolve() };
		state.runs.set(id, run);
		await safePersistRunRecord(run);
		try {
			run.result = await work(abortController.signal);
			run.status = run.status === "killed" || abortController.signal.aborted ? "killed" : "succeeded";
			return run.result;
		} catch (err) {
			run.error = err instanceof Error ? err.message : String(err);
			run.status = run.status === "killed" || abortController.signal.aborted ? "killed" : "failed";
			throw err;
		} finally {
			run.finishedAt = Date.now();
			await safePersistRunRecord(run);
			signal?.removeEventListener("abort", onAbort);

		}
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

	async function listRunsResult(state: HiveState): Promise<AgentToolResult<unknown>> {
		evictCompletedRuns(state);
		const live = [...state.runs.values()].map(toRunDTO);
		const persisted = await readPersistedRunRecords(state.workspaceKey);
		const listedMap = new Map<string, RunRecord>();
		for (const run of persisted) listedMap.set(run.id, run);
		for (const run of live) listedMap.set(run.id, run);
		const listed = [...listedMap.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-MAX_RUNS);
		const text = listed.length === 0
			? "No runs."
			: listed.map((run) => `• ${run.id} — ${run.kind}, ${run.status}, children: ${run.children.length > 0 ? run.children.join(", ") : "(none)"}`).join("\n");
		return { content: [{ type: "text", text }], details: { runs: listed } };
	}




	async function runChainSteps(state: HiveState, callerId: string | undefined, steps: ChainStepParams[], model: Model<any>, cwd: string, signal?: AbortSignal, onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void): Promise<AgentToolResult<unknown>> {
		let previous = "";
		const outputs: Array<{ id: string; output: string }> = [];
		for (const step of steps) {
			if (signal?.aborted) throw new Error("Chain run was aborted.");
			const task = substituteStepVars(step.task, previous, outputs);
			const existing = state.children.has(step.id);
			if (!existing && (typeof step.system_prompt !== "string" || step.system_prompt.trim().length === 0)) {
				throw new Error(`chain step "${step.id}" creates a new agent and requires system_prompt.`);
			}
			const result = existing
				? await delegateToChild(state, callerId, { id: step.id, message: task, timeout_seconds: step.timeout_seconds }, signal, onUpdate)
				: await spawnChild(state, callerId, { id: step.id, system_prompt: step.system_prompt!, task, timeout_seconds: step.timeout_seconds }, model, cwd, signal, onUpdate);
			previous = textOf(result);
			outputs.push({ id: step.id, output: previous });
		}
		const text = outputs.map((o) => `=== ${o.id} ===\n${o.output}`).join("\n\n");
		return { content: [{ type: "text", text }], details: { steps: outputs } };
	}

	async function runParallelTasks(state: HiveState, callerId: string | undefined, tasks: ParallelTaskParams[], model: Model<any>, cwd: string, signal?: AbortSignal, onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void): Promise<AgentToolResult<unknown>> {
		const ids = new Set<string>();
		for (const task of tasks) {
			if (ids.has(task.id)) throw new Error(`Duplicate parallel task id "${task.id}".`);
			ids.add(task.id);
		}
		const settled = await Promise.allSettled(tasks.map((task) => {
			const existing = state.children.has(task.id);
			return existing
				? delegateToChild(state, callerId, { id: task.id, message: task.task, timeout_seconds: task.timeout_seconds }, signal, onUpdate)
				: spawnChild(state, callerId, { id: task.id, system_prompt: task.system_prompt, task: task.task, timeout_seconds: task.timeout_seconds }, model, cwd, signal, onUpdate);
		}));
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
		if (typeof value !== "string" || value.trim().length === 0) {
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
		state: HiveState,
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
					return await startRun(state, "spawn", params.run_id, [id], (runSignal) => spawnChild(state, callerId, spawnParams, selectedModel, cwd, runSignal));
				}
				return await spawnChild(state, callerId, spawnParams, selectedModel, cwd, signal, onUpdate);
			}
			case "delegate": {
				const id = requireStringParam(params, "id");
				const delegateParams = { id, message: requireStringParam(params, "message"), timeout_seconds: params.timeout_seconds };
				if (params.async) {
					if (!allowAsync) throw new Error("async=true is only supported by root-level agent actions.");
					return await startRun(state, "delegate", params.run_id, [id], (runSignal) => delegateToChild(state, callerId, delegateParams, runSignal));
				}
				return await delegateToChild(state, callerId, delegateParams, signal, onUpdate);
			}
			case "kill": {
				rejectUnsupportedAsync(params);
				const id = requireStringParam(params, "id");
				const target = getAccessibleTarget(state, callerId, id, "kill", callerId === undefined);
				const { killedIds, reportCount } = killSubtree(state, target.id);
				return {
					content: [{ type: "text", text: `Killed ${killedIds.length} agent(s): ${killedIds.join(", ")}.` }],
					details: { childId: target.id, killedIds, reportCount },
				};
			}
			case "list": {
				rejectUnsupportedAsync(params);
				return listAgentsResult(state, callerId);
			}
			case "chain": {
				const selectedModel = requireModel(model, params.action);
				const steps = requireSteps(params);
				if (params.async) {
					if (!allowAsync) throw new Error("async=true is only supported by root-level agent actions.");
					return await startRun(state, "chain", params.run_id, steps.map((step) => step.id), (runSignal) => runChainSteps(state, callerId, steps, selectedModel, cwd, runSignal));
				}
				return await runChainSteps(state, callerId, steps, selectedModel, cwd, signal, onUpdate);
			}
			case "parallel": {
				const selectedModel = requireModel(model, params.action);
				const tasks = requireTasks(params);
				if (params.async) {
					if (!allowAsync) throw new Error("async=true is only supported by root-level agent actions.");
					return await startRun(state, "parallel", params.run_id, tasks.map((task) => task.id), (runSignal) => runParallelTasks(state, callerId, tasks, selectedModel, cwd, runSignal));
				}
				return await runParallelTasks(state, callerId, tasks, selectedModel, cwd, signal, onUpdate);
			}
			case "list_workflows": {
				rejectUnsupportedAsync(params);
				return await listWorkflowsResult(cwd);
			}
			case "show_workflow": {
				rejectUnsupportedAsync(params);
				return await showWorkflowResult(params, cwd);
			}
			case "workflow": {
				const selectedModel = requireModel(model, params.action);
				const workflow = await loadWorkflow(params, cwd);
				const children = workflowChildIds(workflow);
				const runtime = {
					hasChild: (id: string) => state.children.has(id),
					spawn: (spawnParams: { id: string; system_prompt: string; task: string; timeout_seconds?: number }, runSignal?: AbortSignal, runUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void) =>
						spawnChild(state, callerId, spawnParams, selectedModel, cwd, runSignal, runUpdate),
					delegate: (delegateParams: { id: string; message: string; timeout_seconds?: number }, runSignal?: AbortSignal, runUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void) =>
						delegateToChild(state, callerId, delegateParams, runSignal, runUpdate),
					runParallel: (tasks: ParallelTaskParams[], runSignal?: AbortSignal, runUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void) =>
						runParallelTasks(state, callerId, tasks, selectedModel, cwd, runSignal, runUpdate),
				};
				if (params.async) {
					if (!allowAsync) throw new Error("async=true is only supported by root-level agent actions.");
					return await startRun(state, "workflow", params.run_id, children, (runSignal) => runWorkflow(workflow, runtime, runSignal));
				}
				return await executeLoggedRun(state, "workflow", params.run_id, children, (runSignal) => runWorkflow(workflow, runtime, runSignal), signal);
			}
			case "list_runs": {
				rejectUnsupportedAsync(params);
				if (callerId) throw new Error("Run management actions are root-only.");
				return await listRunsResult(state);
			}
			case "result": {
				rejectUnsupportedAsync(params);
				if (callerId) throw new Error("Run management actions are root-only.");
				const runId = requireStringParam(params, "run_id");
				const run = await loadRunById(state, runId);
				if (!run) throw new Error(`Run "${runId}" not found in this workspace (it may have been evicted).`);
				return "abortController" in run ? formatRunStateResult(run) : formatRunRecord(run);
			}
			case "wait": {
				rejectUnsupportedAsync(params);
				if (callerId) throw new Error("Run management actions are root-only.");
				const runId = requireStringParam(params, "run_id");
				const run = await loadRunById(state, runId);
				if (!run) throw new Error(`Run "${runId}" not found in this workspace (it may have been evicted).`);
				if ("abortController" in run) {
					await waitForRun(run, params.timeout_seconds);
					return formatRunStateResult(run);
				}
				return formatRunRecord(run);
			}
			case "cancel": {
				rejectUnsupportedAsync(params);
				if (callerId) throw new Error("Run management actions are root-only.");
				const runId = requireStringParam(params, "run_id");
				const run = await loadRunById(state, runId);
				if (!run) throw new Error(`Run "${runId}" not found in this workspace (it may have been evicted).`);
				if (!("abortController" in run)) {
					if (run.status !== "running") return formatRunRecord(run);
					throw new Error(`Run "${runId}" is not active in this session and cannot be cancelled.`);
				}
				if (run.status !== "running") return formatRunStateResult(run);
				run.abortController.abort();
				let killed: string[] = [];
				for (const childId of run.children) {
					if (state.children.has(childId)) killed = killed.concat(killSubtree(state, childId).killedIds);
				}
				run.status = "killed";
				run.finishedAt = Date.now();
				await safePersistRunRecord(run);
				evictCompletedRuns(state);
				return { content: [{ type: "text", text: `Killed run "${run.id}" (${killed.length} agent(s): ${killed.join(", ") || "none"}).` }], details: { run: toRunDTO(run), killed } };
			}
			default:
				throw new Error(`Unknown agent action "${(params as { action?: string }).action}".`);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		const state = getState(ctx.cwd);
		clearConfigCache(state);
		try {
			await getConfig(state, ctx.cwd);
		} catch (err) {
			if (ctx.hasUI) {
				ctx.ui.notify(`pi-hive config error: ${(err as Error).message}`, "error");
			}
		}
	});

	pi.on("session_shutdown", async () => {
		const childStates = [...states.values()].flatMap((state) => [...state.children.values()]);
		for (const state of states.values()) {
			clearConfigCache(state);
			for (const run of state.runs.values()) {
				if (run.status === "running") {
					run.status = "killed";
					run.finishedAt = Date.now();
					run.abortController.abort();
					await safePersistRunRecord(run);
				}
			}
		}

		for (const child of childStates) {
			child.agent.abort();
		}
		await Promise.race([
			Promise.allSettled(childStates.map((child) => child.agent.waitForIdle())).then(() => undefined),
			new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
		]);
		states.clear();
	});

	function parseWorkflowCommandArgs(args: string): { subcommand: string; rest: string } {
		const trimmed = args.trim();
		if (!trimmed) return { subcommand: "list", rest: "" };
		const [first, ...rest] = trimmed.split(/\s+/);
		if (["list", "ls", "show", "run"].includes(first)) return { subcommand: first, rest: rest.join(" ").trim() };
		return { subcommand: "run", rest: trimmed };
	}

	pi.registerCommand("workflow", {
		description: "List, show, or run deterministic workflows",
		handler: async (args, ctx) => {
			const { subcommand, rest } = parseWorkflowCommandArgs(args);
			try {
				if (subcommand === "list" || subcommand === "ls") {
					const result = await listWorkflowsResult(ctx.cwd);
					const text = result.content[0]?.type === "text" ? result.content[0].text : "(no workflows)";
					ctx.ui.notify(text, "info");
					return;
				}
				if (subcommand === "show") {
					if (!rest) {
						ctx.ui.notify("Usage: /workflow show <name>", "warning");
						return;
					}
					const result = await showWorkflowResult({ workflow_name: rest }, ctx.cwd);
					const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";
					ctx.ui.notify(text.length > 4000 ? text.slice(0, 4000) + "\n…" : text, "info");
					return;
				}
				if (subcommand === "run") {
					if (!rest) {
						ctx.ui.notify("Usage: /workflow <name> or /workflow run <name>", "warning");
						return;
					}
					if (!ctx.isIdle()) {
						ctx.ui.notify("Agent is busy. Run the workflow when the current turn finishes.", "warning");
						return;
					}
					pi.sendUserMessage(`Run workflow ${JSON.stringify(rest)} now. Use run_workflow({ workflow_name: ${JSON.stringify(rest)} }). Do not list all workflows unless this workflow cannot be found.`);
					return;
				}
				ctx.ui.notify("Usage: /workflow [list|show <name>|run <name>|<name>]", "warning");
			} catch (err) {
				ctx.ui.notify(`workflow: ${(err as Error).message}`, "error");
			}
		},
	});

	// ── preferred, Claude-Code-style surface ─────────────────────────────────

	pi.registerTool({
		name: "agent",
		label: "Agent",
		description:
			"Launch a new worker agent with description+prompt. Use subagent_type from list_agent_types when useful; otherwise defaults to general-purpose. " +
			"For follow-up work, use send_message. For independent parallel work, call agent multiple times in one response.",
		promptSnippet: "Launch focused worker agents with description+prompt; no action enum.",
		promptGuidelines: [
			"Use agent for complex research, reviews, or scoped implementation that can run independently.",
			"Write the prompt like a handoff to a smart colleague who has not seen the conversation: include relevant files, constraints, and expected output.",
			"Use name when you will need to address the agent later with send_message.",
			"Use run_in_background for long work; check with run_status.",
		],
		parameters: launchAgentSchema as any,
		renderCall(args, theme, context) {
			const callArgs = (args ?? {}) as { description?: string; name?: string; subagent_type?: string; prompt?: string };
			return renderAgentCall("agent", { id: callArgs.name || callArgs.subagent_type || "", task: callArgs.description || callArgs.prompt || "" }, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderAgentResult(result, options, theme, context);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const state = getState(ctx.cwd);
			state.getApiKey ??= (provider: string) => ctx.modelRegistry.getApiKeyForProvider(provider);
			return await executeLaunchAgent(state, undefined, params as LaunchAgentParams, ctx.model, ctx.cwd, signal, onUpdate, true);
		},
	});

	pi.registerTool({
		name: "send_message",
		label: "Send Message",
		description: "Send follow-up work to an existing agent by id/name. Use list_agents to find active agents.",
		parameters: sendMessageSchema as any,
		renderCall(args, theme, context) {
			const callArgs = (args ?? {}) as { to?: string; message?: string };
			return renderAgentCall("send_message", { id: callArgs.to || "", task: callArgs.message || "" }, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderAgentResult(result, options, theme, context);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const state = getState(ctx.cwd);
			return await executeSendMessage(state, undefined, params as SendMessageParams, signal, onUpdate, true);
		},
	});

	pi.registerTool({
		name: "list_agents",
		label: "List Agents",
		description: "List active agents in this workspace.",
		parameters: emptySchema as any,
		renderCall(args, theme, context) {
			return renderAgentCall("list_agents", {}, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderAgentResult(result, options, theme, context);
		},
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return listAgentsResult(getState(ctx.cwd), undefined);
		},
	});

	pi.registerTool({
		name: "kill_agent",
		label: "Kill Agent",
		description: "Kill an agent/subtree by id/name.",
		parameters: killAgentSchema as any,
		renderCall(args, theme, context) {
			const callArgs = (args ?? {}) as { id?: string };
			return renderAgentCall("kill_agent", { id: callArgs.id || "" }, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderAgentResult(result, options, theme, context);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return killAgentResult(getState(ctx.cwd), undefined, (params as { id: string }).id);
		},
	});

	pi.registerTool({
		name: "list_agent_types",
		label: "List Agent Types",
		description: "List available subagent_type values. Custom agents live in .pi/agents/*.md, .pi/agent/agents/*.md, or ~/.pi/agent/agents/*.md.",
		parameters: emptySchema as any,
		renderCall(args, theme, context) {
			return renderAgentCall("list_agent_types", {}, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderAgentResult(result, options, theme, context);
		},
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return await listAgentTypesResult(ctx.cwd);
		},
	});

	pi.registerTool({
		name: "run_workflow",
		label: "Run Workflow",
		description: "Run a deterministic workflow by name/path/inline object. Workflows are separate from agent launching.",
		parameters: runWorkflowSchema as any,
		renderCall(args, theme, context) {
			const callArgs = (args ?? {}) as { workflow_name?: string; workflow_path?: string; run_id?: string };
			return renderAgentCall("run_workflow", { id: callArgs.workflow_name || callArgs.workflow_path || callArgs.run_id || "" }, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderAgentResult(result, options, theme, context);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const state = getState(ctx.cwd);
			state.getApiKey ??= (provider: string) => ctx.modelRegistry.getApiKeyForProvider(provider);
			return await executeRunWorkflowTool(state, undefined, params as RunWorkflowToolParams, ctx.model, ctx.cwd, signal);
		},
	});

	pi.registerTool({
		name: "list_workflows",
		label: "List Workflows",
		description: "List saved workflows without loading full workflow bodies.",
		parameters: emptySchema as any,
		renderCall(args, theme, context) {
			return renderAgentCall("list_workflows", {}, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderAgentResult(result, options, theme, context);
		},
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return await listWorkflowsResult(ctx.cwd);
		},
	});

	pi.registerTool({
		name: "show_workflow",
		label: "Show Workflow",
		description: "Show one saved workflow definition.",
		parameters: showWorkflowSchema as any,
		renderCall(args, theme, context) {
			const callArgs = (args ?? {}) as { workflow_name?: string };
			return renderAgentCall("show_workflow", { id: callArgs.workflow_name || "" }, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderAgentResult(result, options, theme, context);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await showWorkflowResult(params as { workflow_name: string }, ctx.cwd);
		},
	});

	pi.registerTool({
		name: "list_runs",
		label: "List Runs",
		description: "List background runs in this workspace.",
		parameters: emptySchema as any,
		renderCall(args, theme, context) {
			return renderAgentCall("list_runs", {}, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderAgentResult(result, options, theme, context);
		},
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return await listRunsResult(getState(ctx.cwd));
		},
	});

	pi.registerTool({
		name: "run_status",
		label: "Run Status",
		description: "Get or wait for a background run result.",
		parameters: runStatusSchema as any,
		renderCall(args, theme, context) {
			const callArgs = (args ?? {}) as { run_id?: string };
			return renderAgentCall("run_status", { id: callArgs.run_id || "" }, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderAgentResult(result, options, theme, context);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await executeRunStatus(getState(ctx.cwd), params as RunStatusParams);
		},
	});

	pi.registerTool({
		name: "cancel_run",
		label: "Cancel Run",
		description: "Cancel a background run and kill associated agents.",
		parameters: cancelRunSchema as any,
		renderCall(args, theme, context) {
			const callArgs = (args ?? {}) as { run_id?: string };
			return renderAgentCall("cancel_run", { id: callArgs.run_id || "" }, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderAgentResult(result, options, theme, context);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await executeCancelRun(getState(ctx.cwd), (params as { run_id: string }).run_id);
		},
	});

	// Deprecated compatibility shim for old action-based callers.
	pi.registerTool({
		name: "hive",
		label: "Hive Legacy",
		description:
			"Deprecated action-based compatibility tool. Prefer agent/send_message/list_agents/kill_agent/run_workflow/run_status. " +
			"Legacy actions: spawn|delegate|kill|list|chain|parallel|workflow|list_workflows|show_workflow|list_runs|result|wait|cancel.",
		parameters: agentSchema as any,
		renderCall(args, theme, context) {
			const callArgs = (args ?? {}) as { action?: string; id?: string; run_id?: string; task?: string; message?: string };
			const action = callArgs.action || "...";
			const id = callArgs.id || callArgs.run_id || "";
			const taskText = callArgs.task || callArgs.message || action;
			return renderAgentCall(`hive:${action}`, { id, task: taskText }, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderAgentResult(result, options, theme, context);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const state = getState(ctx.cwd);
			state.getApiKey ??= (provider: string) => ctx.modelRegistry.getApiKeyForProvider(provider);
			return await executeAgentAction(state, undefined, params as AgentToolParams, ctx.model, ctx.cwd, signal, onUpdate, true);
		},
	});
}
