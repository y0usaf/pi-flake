/**
 * pi-kimi subagents — Kimi Code-style subagent support for pi.
 *
 * - Built-in agents: coder (full tools), explore (read-only recon), plan (read-only planning).
 *   User (~/.pi/agent/agents/*.md) and project (.pi/agents/*.md) agents are discovered too
 *   and override built-ins by name.
 * - Modes: single {agent, task}, parallel {tasks: [...]}, chain {chain: [...] with {previous}}.
 * - runInBackground: spawn detached, poll with task_output, kill with task_stop.
 * - resume: every invocation gets a stable session dir; pass resume: "<id>" to continue it.
 *
 * Each subagent runs as a separate `pi` process with an isolated context window.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getAgentDir,
	parseFrontmatter,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const KILL_GRACE_MS = 5000;

type TextResult = AgentToolResult<undefined>;

function textResult(text: string, isError?: boolean): TextResult {
	return {
		content: [{ type: "text", text }],
		details: undefined,
		...(isError ? { isError: true } : {}),
	};
}

// ---------------------------------------------------------------------------
// Agent definitions and discovery
// ---------------------------------------------------------------------------

type AgentSource = "builtin" | "user" | "project";

interface AgentConfig {
	name: string;
	description: string;
	/** undefined = inherit full default toolset (like Kimi's coder). */
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
}

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"];
const PLAN_AGENT_TOOLS = ["read", "grep", "find", "ls"];

// Prompts and descriptions are verbatim from MoonshotAI/kimi-code
// (packages/agent-core/src/profile/default/{coder,explore,plan}.yaml), with tool
// names substituted for pi's (Glob→find, Grep→grep, Bash→bash, Agent→subagent)
// and unavailable tools dropped (ReadMediaFile, WebSearch/FetchURL when not installed).
const SUBAGENT_PREAMBLE = [
	"You are now running as a subagent. All the `user` messages are sent by the main agent. The main agent cannot see your context, it can only see your last message when you finish the task. You must treat the parent agent as your caller. Do not directly ask the end user questions. If something is unclear, explain the ambiguity in your final summary to the parent agent.",
];

const BUILTIN_AGENTS: AgentConfig[] = [
	{
		name: "coder",
		description:
			"Use this agent for non-trivial software engineering work that may require reading files, editing code, running commands, and returning a compact but technically complete summary to the parent agent.",
		tools: undefined,
		systemPrompt: [
			...SUBAGENT_PREAMBLE,
			"Your final message is the entire handoff — the parent sees nothing else from your run. Make it technically complete: what you changed and why, the path of every file you touched, how you verified the change (tests or commands run, with results), and anything left undone or worth follow-up. A final message of only a sentence or two is treated as too brief and sent back to you for expansion, costing an extra turn.",
		].join("\n\n"),
		source: "builtin",
	},
	{
		name: "explore",
		description:
			'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (e.g. "src/**/*.yaml"), search code for keywords (e.g. "database connection"), or answer questions about the codebase (e.g. "how does the auth module work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "thorough" for comprehensive analysis across multiple locations and naming conventions. Use this agent for any read-only exploration that will clearly require more than 3 search queries. Prefer launching multiple explore agents concurrently when investigating independent questions.',
		tools: READ_ONLY_TOOLS,
		systemPrompt: [
			...SUBAGENT_PREAMBLE,
			[
				"You are a codebase exploration specialist. Your role is EXCLUSIVELY to search, read, and analyze existing code and resources. You do NOT have access to file editing tools.",
				"",
				"Your strengths:",
				"- Rapidly finding files using glob patterns",
				"- Searching code and text with powerful regex patterns",
				"- Reading and analyzing file contents",
				"- Running read-only shell commands (git log, git diff, ls, find, etc.)",
				"",
				"Guidelines:",
				"- Use find for broad file pattern matching. Prefer patterns with a literal anchor (extension or subdirectory); pure wildcards like `*` or `**/*` are allowed but usually truncate at the match cap.",
				"- Use grep for searching file contents with regex",
				"- Use read when you know the specific file path",
				"- Use bash ONLY for read-only operations (ls, git status, git log, git diff, find)",
				"- NEVER use bash for any file creation or modification commands",
				"- Use web search/fetch tools when a question needs external context (library documentation, error messages, upstream APIs); the local codebase remains your primary domain",
				"- Adapt your search depth based on the thoroughness level specified by the caller",
				"- Wherever possible, spawn multiple parallel tool calls for grepping and reading files to maximize speed",
				"",
				"If the prompt includes a <git-context> block, use it to orient yourself about the repository state before starting your investigation.",
				"",
				"You are meant to be a fast agent. Complete the search request efficiently and report your findings clearly in a structured format.",
			].join("\n"),
		].join("\n\n"),
		source: "builtin",
	},
	{
		name: "plan",
		description:
			"Use this agent when the parent agent needs a step-by-step implementation plan, key file identification, and architectural trade-off analysis before code changes are made.",
		tools: PLAN_AGENT_TOOLS,
		systemPrompt: [
			...SUBAGENT_PREAMBLE,
			[
				'Before designing your implementation plan, consider whether you fully understand the codebase areas relevant to the task. If not, recommend the parent agent to use the explore agent (agent="explore") to investigate key questions first. In your response, clearly state:',
				"1. What you already know from the information provided",
				"2. What questions remain unanswered that would benefit from explore agent investigation",
				"3. Your implementation plan (either preliminary if questions remain, or final if sufficient context exists)",
				"",
				"You are a read-only planning agent: you can read and search files (read, find, grep) and consult the web when search/fetch tools are available, but you have no shell and no file-editing tools. Where the general instructions tell you to make changes with tools, that does not apply to you — do not attempt to run commands or modify files. Your deliverable is the plan itself, returned as your final message.",
			].join("\n"),
		].join("\n\n"),
		source: "builtin",
	},
];

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;
		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);
		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
		});
	}
	return agents;
}

function discoverAgents(cwd: string, scope: "user" | "project" | "both"): AgentConfig[] {
	const merged = new Map<string, AgentConfig>();
	for (const agent of BUILTIN_AGENTS) merged.set(agent.name, agent);
	if (scope !== "project") {
		for (const agent of loadAgentsFromDir(path.join(getAgentDir(), "agents"), "user")) merged.set(agent.name, agent);
	}
	if (scope !== "user") {
		let dir = cwd;
		while (true) {
			const candidate = path.join(dir, ".pi", "agents");
			try {
				if (fs.statSync(candidate).isDirectory()) {
					for (const agent of loadAgentsFromDir(candidate, "project")) merged.set(agent.name, agent);
					break;
				}
			} catch {
				// keep walking up
			}
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return Array.from(merged.values());
}

// ---------------------------------------------------------------------------
// Task registry (background execution + resume)
// ---------------------------------------------------------------------------

type TaskStatus = "running" | "completed" | "failed" | "stopped";

interface TaskRecord {
	id: string;
	agent: string;
	task: string;
	background: boolean;
	status: TaskStatus;
	pid?: number;
	exitCode?: number;
	startedAt: string;
	endedAt?: string;
	stopReason?: string;
	error?: string;
}

interface LiveTask {
	record: TaskRecord;
	kill: () => void;
}

function stateDir(): string {
	return path.join(getAgentDir(), "pi-kimi");
}

function taskDir(id: string): string {
	return path.join(stateDir(), "tasks", id);
}

function sessionDirFor(id: string): string {
	return path.join(stateDir(), "sessions", id);
}

function statusPath(id: string): string {
	return path.join(taskDir(id), "status.json");
}

function logPath(id: string): string {
	return path.join(taskDir(id), "events.jsonl");
}

function newTaskId(): string {
	return randomUUID().replaceAll("-", "").slice(0, 8);
}

function writeStatus(record: TaskRecord): void {
	fs.mkdirSync(taskDir(record.id), { recursive: true });
	const tmp = `${statusPath(record.id)}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
	fs.renameSync(tmp, statusPath(record.id));
}

function readStatus(id: string): TaskRecord | undefined {
	try {
		return JSON.parse(fs.readFileSync(statusPath(id), "utf-8")) as TaskRecord;
	} catch {
		return undefined;
	}
}

function listTaskIds(): string[] {
	try {
		return fs
			.readdirSync(path.join(stateDir(), "tasks"), { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return [];
	}
}

/** Reconstruct the final assistant text from a task's JSONL event log. */
function finalOutputFromLog(id: string): string {
	let lines: string[];
	try {
		lines = fs.readFileSync(logPath(id), "utf-8").split("\n");
	} catch {
		return "";
	}
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		try {
			const event = JSON.parse(line) as { type?: string; message?: Message };
			if (event.type === "message_end" && event.message?.role === "assistant") {
				for (const part of event.message.content) {
					if (part.type === "text" && part.text) return part.text;
				}
			}
		} catch {
			// skip malformed lines
		}
	}
	return "";
}

function pidAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Process spawning
// ---------------------------------------------------------------------------

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

interface SingleResult {
	id: string;
	agent: string;
	agentSource: AgentSource;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-kimi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

/** Build the pi CLI arguments for a subagent run. */
function buildArgs(
	agent: AgentConfig,
	task: string,
	id: string,
	resume: boolean,
	tmpPromptPath: string | null,
): string[] {
	const args: string[] = ["--mode", "json", "-p"];
	if (resume) args.push("--continue");
	args.push("--session-dir", sessionDirFor(id));
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	if (tmpPromptPath) args.push("--append-system-prompt", tmpPromptPath);
	args.push(resume ? task : `Task: ${task}`);
	return args;
}

function makeLineParser(result: SingleResult, onEvent?: () => void): (line: string) => void {
	return (line: string) => {
		if (!line.trim()) return;
		let event: { type?: string; message?: Message };
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (event.type === "message_end" && event.message) {
			const msg = event.message;
			result.messages.push(msg);
			if (msg.role === "assistant") {
				result.usage.turns++;
				const usage = msg.usage;
				if (usage) {
					result.usage.input += usage.input || 0;
					result.usage.output += usage.output || 0;
					result.usage.cacheRead += usage.cacheRead || 0;
					result.usage.cacheWrite += usage.cacheWrite || 0;
					result.usage.cost += usage.cost?.total || 0;
				}
				if (msg.stopReason) result.stopReason = msg.stopReason;
				if (msg.errorMessage) result.errorMessage = msg.errorMessage;
			}
			onEvent?.();
		}
		if (event.type === "tool_result_end" && event.message) {
			result.messages.push(event.message);
			onEvent?.();
		}
	};
}

/** Run a subagent in the foreground, streaming partial results via onUpdate. */
async function runForeground(
	defaultCwd: string,
	agent: AgentConfig,
	task: string,
	id: string,
	resume: boolean,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((result: SingleResult) => void) | undefined,
): Promise<SingleResult> {
	const result: SingleResult = {
		id,
		agent: agent.name,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		step,
	};
	const parseLine = makeLineParser(result, () => onUpdate?.(result));

	let tmp: { dir: string; filePath: string } | null = null;
	try {
		if (agent.systemPrompt.trim()) tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
		const args = buildArgs(agent, task, id, resume, tmp?.filePath ?? null);
		fs.mkdirSync(sessionDirFor(id), { recursive: true });

		// Foreground runs also get a task record so resume: "<id>" can find them.
		const record: TaskRecord = {
			id,
			agent: agent.name,
			task,
			background: false,
			status: "running",
			startedAt: new Date().toISOString(),
		};
		writeStatus(record);

		result.exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			fs.mkdirSync(taskDir(id), { recursive: true });
			const logStream = fs.createWriteStream(logPath(id), { flags: "a" });
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			record.pid = proc.pid;
			writeStatus(record);
			let buffer = "";
			proc.stdout.on("data", (data) => {
				logStream.write(data);
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) parseLine(line);
			});
			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});
			proc.on("close", (code) => {
				if (buffer.trim()) parseLine(buffer);
				logStream.end();
				resolve(code ?? 0);
			});
			proc.on("error", () => {
				logStream.end();
				resolve(1);
			});
			if (signal) {
				const killProc = () => {
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, KILL_GRACE_MS);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});
		record.status = result.exitCode === 0 ? "completed" : "failed";
		record.exitCode = result.exitCode;
		record.endedAt = new Date().toISOString();
		writeStatus(record);
		return result;
	} finally {
		if (tmp) {
			try {
				fs.unlinkSync(tmp.filePath);
				fs.rmdirSync(tmp.dir);
			} catch {
				// ignore cleanup errors
			}
		}
	}
}

/** Spawn a subagent detached, logging events to disk. Returns the live task handle. */
function spawnBackground(
	defaultCwd: string,
	agent: AgentConfig,
	task: string,
	id: string,
	resume: boolean,
	cwd: string | undefined,
	tmpPromptPath: string | null,
): LiveTask {
	const args = buildArgs(agent, task, id, resume, tmpPromptPath);
	fs.mkdirSync(taskDir(id), { recursive: true });
	fs.mkdirSync(sessionDirFor(id), { recursive: true });

	const logFd = fs.openSync(logPath(id), "a");
	const errFd = fs.openSync(path.join(taskDir(id), "stderr.log"), "a");
	const invocation = getPiInvocation(args);
	const proc = spawn(invocation.command, invocation.args, {
		cwd: cwd ?? defaultCwd,
		shell: false,
		detached: true,
		stdio: ["ignore", logFd, errFd],
	});
	fs.closeSync(logFd);
	fs.closeSync(errFd);
	proc.unref();

	const record: TaskRecord = {
		id,
		agent: agent.name,
		task,
		background: true,
		status: "running",
		pid: proc.pid,
		startedAt: new Date().toISOString(),
	};
	writeStatus(record);

	const live: LiveTask = {
		record,
		kill: () => {
			try {
				proc.kill("SIGTERM");
			} catch {
				// already dead
			}
			setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {
					// already dead
				}
			}, KILL_GRACE_MS);
		},
	};

	proc.on("close", (code) => {
		const current = readStatus(id) ?? record;
		if (current.status === "running") {
			current.status = code === 0 ? "completed" : "failed";
		}
		current.exitCode = code ?? undefined;
		current.endedAt = new Date().toISOString();
		writeStatus(current);
	});
	proc.on("error", (err) => {
		const current = readStatus(id) ?? record;
		current.status = "failed";
		current.error = err.message;
		current.endedAt = new Date().toISOString();
		writeStatus(current);
	});

	return live;
}

// ---------------------------------------------------------------------------
// Tool parameter schemas
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	resume: Type.Optional(
		Type.String({ description: "Task id of a previous subagent run to continue with `task` as a follow-up message" }),
	),
	runInBackground: Type.Optional(
		Type.Boolean({
			description:
				"Run detached and return a task id immediately (single/parallel mode). Poll with task_output, kill with task_stop.",
		}),
	),
	agentScope: Type.Optional(
		StringEnum(["user", "project", "both"] as const, {
			description: 'Which agents to use. Default: "user" (built-ins + ~/.pi/agent/agents). "both" adds .pi/agents.',
			default: "user",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

const TaskListParams = Type.Object({
	active_only: Type.Optional(
		Type.Boolean({
			description:
				"List only non-terminal tasks (default true). Pass false to also see finished tasks.",
			default: true,
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Max tasks to return (1-100, default 20)", default: 20 })),
});

const TaskOutputParams = Type.Object({
	id: Type.String({ description: "Task id returned by a background subagent run" }),
	block: Type.Optional(Type.Boolean({ description: "Wait for the task to finish before returning", default: false })),
	timeout: Type.Optional(
		Type.Number({ description: "Max seconds to wait when block=true (default 30, max 600)", default: 30 }),
	),
});

const TaskStopParams = Type.Object({
	id: Type.String({ description: "Task id to kill" }),
	reason: Type.Optional(Type.String({ description: "Reason recorded in the task status" })),
});

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

function formatTaskLine(record: TaskRecord): string {
	const preview = record.task.length > 60 ? `${record.task.slice(0, 60)}...` : record.task;
	const pid = record.pid ? ` pid=${record.pid}` : "";
	const exit = record.exitCode !== undefined ? ` exit=${record.exitCode}` : "";
	return `${record.id} [${record.status}] ${record.agent}${pid}${exit} — ${preview}`;
}

/** User-facing helper for the /tasks command: reconcile + format the task list. */
export function formatTaskList(): string {
	for (const id of listTaskIds()) {
		const record = readStatus(id);
		if (!record || record.status !== "running") continue;
		if (pidAlive(record.pid)) continue;
		record.status = finalOutputFromLog(id) ? "completed" : "failed";
		if (record.status === "failed") record.error = "process exited before status could be recorded";
		record.endedAt = new Date().toISOString();
		writeStatus(record);
	}
	const records = listTaskIds()
		.map(readStatus)
		.filter((r): r is TaskRecord => Boolean(r))
		.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	if (records.length === 0) return "No tasks.";
	return records.map(formatTaskLine).join("\n");
}

export default function (pi: ExtensionAPI) {
	const liveTasks = new Map<string, LiveTask>();

	// Rebuild the registry view of tasks after a restart: a task whose pid is
	// gone but whose status still says "running" is finished; treat it as
	// completed if it produced output, failed otherwise.
	const reconcileTasks = () => {
		for (const id of listTaskIds()) {
			const record = readStatus(id);
			if (!record || record.status !== "running") continue;
			if (pidAlive(record.pid)) continue;
			record.status = finalOutputFromLog(id) ? "completed" : "failed";
			if (record.status === "failed") record.error = "process exited before status could be recorded";
			record.endedAt = new Date().toISOString();
			writeStatus(record);
		}
	};
	pi.on("session_start", reconcileTasks);

	const resolveAgent = (
		cwd: string,
		scope: "user" | "project" | "both",
		name: string,
	): { agent?: AgentConfig; available: string } => {
		const agents = discoverAgents(cwd, scope);
		return {
			agent: agents.find((a) => a.name === name),
			available: agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none",
		};
	};

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			// Verbatim from kimi-code's agent.md, adapted for pi (Agent→subagent,
			// separate process, no fixed timeout, modes/runInBackground/resume added).
			"Launch a subagent to handle a task. The subagent runs as a separate pi process with its own isolated context window. Delegating also keeps the bulk of intermediate file contents out of your own context — you get a conclusion back instead of a pile of dumps.",
			"",
			"Writing the prompt:",
			"- The subagent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.",
			"- Lookups (read this file, run that test): put the exact path or command in the prompt. The subagent should not have to search for things you already know.",
			"- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.",
			"- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.",
			"",
			"Usage notes:",
			"- Built-in agents: coder (full tools, edits code), explore (read-only recon), plan (read-only planning). User and project agent files are discovered too.",
			"- Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"- When the task continues earlier work a subagent already did, prefer resuming that agent (pass its `resume` id) over spawning a fresh instance — the resumed agent keeps its prior context.",
			"- A subagent's result is only visible to you, not to the user. When the user needs to see what a subagent produced, summarize the relevant parts yourself in your own reply.",
			"",
			"When NOT to use subagent: skip delegation for trivial work you can do directly — reading a file whose path you already know, searching a small known set of files, or any task that takes only a step or two. Delegation has a context-handoff cost; it pays off only when the task is substantial enough to outweigh it.",
			"",
			"Once a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway and finish the job manually. Both undo the context savings the delegation was meant to buy.",
			"",
			"When runInBackground=true, the subagent runs detached. Poll with task_output, kill with task_stop, list with task_list.",
			"Default to a foreground subagent when your next step needs its result — foreground hands the result straight back. Reach for runInBackground=true only when you have other work to do while it runs and do not need its result to proceed. Never launch in the background and then immediately wait on it (with task_output block=true, sleeping, or otherwise): that just blocks the turn for no benefit — run it in the foreground instead.",
		].join("\n"),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<TextResult> {
			const scope = params.agentScope ?? "user";
			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const hasResume = Boolean(params.resume && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle) + Number(hasResume);
			if (modeCount !== 1) {
				const { available } = resolveAgent(ctx.cwd, scope, "");
				return textResult(
					`Invalid parameters: provide exactly one of (agent+task), (tasks), (chain), or (resume+task).\nAvailable agents: ${available}`,
					true,
				);
			}
			if (params.runInBackground && hasChain) {
				return textResult("runInBackground is not supported for chain mode.", true);
			}

			// --- resume mode -----------------------------------------------------
			if (hasResume && params.resume && params.task) {
				const id = params.resume;
				const prior = readStatus(id);
				if (!prior) {
					return textResult(`Unknown task id: ${id}`, true);
				}
				if (liveTasks.has(id) || (prior.status === "running" && pidAlive(prior.pid))) {
					return textResult(`Task ${id} is still running; stop it before resuming.`, true);
				}
				const { agent, available } = resolveAgent(ctx.cwd, scope, params.agent ?? prior.agent);
				if (!agent) {
					return textResult(`Unknown agent. Available: ${available}`, true);
				}
				const result = await runForeground(ctx.cwd, agent, params.task, id, true, params.cwd, undefined, signal, undefined);
				const output = getFinalOutput(result.messages);
				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				return textResult(
					isError ? `Agent failed: ${result.errorMessage || result.stderr || output}` : output || "(no output)",
					isError || undefined,
				);
			}

			// --- background mode ---------------------------------------------------
			if (params.runInBackground) {
				const items: { agent: string; task: string; cwd?: string }[] = hasTasks
					? (params.tasks ?? [])
					: [{ agent: params.agent ?? "", task: params.task ?? "", cwd: params.cwd }];
				if (items.length > MAX_PARALLEL_TASKS) {
					return textResult(`Too many tasks (${items.length}). Max is ${MAX_PARALLEL_TASKS}.`, true);
				}
				const started: TaskRecord[] = [];
				for (const item of items) {
					const { agent, available } = resolveAgent(ctx.cwd, scope, item.agent);
					if (!agent) {
						for (const s of started) liveTasks.get(s.id)?.kill();
						return textResult(`Unknown agent: "${item.agent}". Available: ${available}`, true);
					}
					const id = newTaskId();
					let tmpPromptPath: string | null = null;
					if (agent.systemPrompt.trim()) {
						const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
						tmpPromptPath = tmp.filePath;
						// The temp file must outlive the spawn; clean it up shortly after.
						setTimeout(() => {
							try {
								fs.unlinkSync(tmp.filePath);
								fs.rmdirSync(tmp.dir);
							} catch {
								// ignore
							}
						}, 30_000).unref();
					}
					const live = spawnBackground(ctx.cwd, agent, item.task, id, false, item.cwd, tmpPromptPath);
					liveTasks.set(id, live);
					started.push(live.record);
				}
				return textResult(
					`Started ${started.length} background task(s):\n${started.map((r) => `- ${r.id} (${r.agent}): ${r.task.slice(0, 80)}`).join("\n")}\n\nPoll with task_output, kill with task_stop.`,
				);
			}

			// --- chain mode --------------------------------------------------------
			if (hasChain && params.chain) {
				const results: SingleResult[] = [];
				let previousOutput = "";
				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const { agent, available } = resolveAgent(ctx.cwd, scope, step.agent);
					if (!agent) {
						return textResult(`Unknown agent: "${step.agent}". Available: ${available}`, true);
					}
					const result = await runForeground(
						ctx.cwd,
						agent,
						step.task.replace(/\{previous\}/g, previousOutput),
						newTaskId(),
						false,
						step.cwd,
						i + 1,
						signal,
						onUpdate
							? (r) =>
									onUpdate({
										content: [{ type: "text", text: getFinalOutput(r.messages) || "(running...)" }],
										details: undefined,
									})
							: undefined,
					);
					results.push(result);
					const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						return textResult(
							`Chain stopped at step ${i + 1} (${step.agent}): ${result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"}`,
							true,
						);
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return textResult(previousOutput || "(no output)");
			}

			// --- parallel mode -----------------------------------------------------
			if (hasTasks && params.tasks) {
				const taskList = params.tasks;
				if (taskList.length > MAX_PARALLEL_TASKS) {
					return textResult(`Too many parallel tasks (${taskList.length}). Max is ${MAX_PARALLEL_TASKS}.`, true);
				}
				let nextIndex = 0;
				const worker = async (): Promise<SingleResult[]> => {
					const out: SingleResult[] = [];
					for (;;) {
						const i = nextIndex++;
						if (i >= taskList.length) return out;
						const t = taskList[i];
						const { agent, available } = resolveAgent(ctx.cwd, scope, t.agent);
						if (!agent) {
							out.push({
								id: newTaskId(),
								agent: t.agent,
								agentSource: "builtin",
								task: t.task,
								exitCode: 1,
								messages: [],
								stderr: `Unknown agent. Available: ${available}`,
								usage: emptyUsage(),
							});
							continue;
						}
						out.push(await runForeground(ctx.cwd, agent, t.task, newTaskId(), false, t.cwd, undefined, signal, undefined));
					}
				};
				const results = (
					await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, taskList.length) }, worker))
				).flat();
				const successCount = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages);
					const preview = output.slice(0, 200) + (output.length > 200 ? "..." : "");
					return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || r.stderr || "(no output)"}`;
				});
				return textResult(
					`Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
					successCount === 0 || undefined,
				);
			}

			// --- single mode -------------------------------------------------------
			const { agent, available } = resolveAgent(ctx.cwd, scope, params.agent ?? "");
			if (!agent) {
				return textResult(`Unknown agent: "${params.agent}". Available: ${available}`, true);
			}
			const result = await runForeground(
				ctx.cwd,
				agent,
				params.task ?? "",
				newTaskId(),
				false,
				params.cwd,
				undefined,
				signal,
				onUpdate
					? (r) =>
							onUpdate({
								content: [{ type: "text", text: getFinalOutput(r.messages) || "(running...)" }],
								details: undefined,
							})
					: undefined,
			);
			const output = getFinalOutput(result.messages);
			const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
			return textResult(
				isError
					? `Agent ${result.stopReason || "failed"}: ${result.errorMessage || result.stderr || output || "(no output)"}`
					: `${output || "(no output)"}\n\n(task id: ${result.id} — pass as resume to continue this subagent)`,
				isError || undefined,
			);
		},

		renderCall(args, theme) {
			const mode = args.chain
				? `chain (${args.chain.length})`
				: args.tasks
					? `parallel (${args.tasks.length})`
					: args.resume
						? `resume ${args.resume}`
						: (args.agent ?? "...");
			const text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", mode) +
				(args.runInBackground ? theme.fg("warning", " [bg]") : "");
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "task_list",
		label: "Task List",
		description: [
			// Verbatim from kimi-code's task-list.md, adapted for pi (TaskOutput→task_output).
			"List background tasks and their current status.",
			"",
			"Use this tool to discover which background tasks exist and where each one stands. It is the entry point for inspecting background work: it returns a task ID, status, and description for every task it reports, plus the PID and (once finished) exit code, and a stop reason for any task that ended early.",
			"",
			"Guidelines:",
			"- After a context compaction, or whenever you are unsure which background tasks are running or what their task IDs are, call this tool to re-enumerate them instead of guessing a task ID.",
			"- Prefer the default active_only=true, which lists only non-terminal tasks. Pass active_only=false only when you specifically need to see tasks that have already finished.",
			"- limit caps how many tasks are returned. It accepts a value between 1 and 100 and defaults to 20 when omitted.",
			"- This tool only lists tasks; it does not return their output. Use it first to locate the task ID you need, then call task_output with that ID to read the task's output and details.",
			"- This tool is read-only and does not change any state, so it is always safe to call, including in plan mode.",
		].join("\n"),
		parameters: TaskListParams,
		async execute(_toolCallId, params): Promise<TextResult> {
			reconcileTasks();
			const activeOnly = params.active_only ?? true;
			const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
			const records = listTaskIds()
				.map(readStatus)
				.filter((r): r is TaskRecord => Boolean(r))
				.filter((r) => !activeOnly || r.status === "running")
				.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
				.slice(0, limit);
			if (records.length === 0) return textResult("No tasks.");
			return textResult(records.map(formatTaskLine).join("\n"));
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("task_list")), 0, 0);
		},
	});

	pi.registerTool({
		name: "task_output",
		label: "Task Output",
		description: [
			// Verbatim from kimi-code's task-output.md, adapted for pi (subagent background
			// runs, task_output/task_stop names, JSONL log path as output_path).
			"Retrieve a snapshot of a running or completed background task.",
			"",
			"Use this after subagent with runInBackground=true to check progress, or to read the output of a task that has already completed.",
			"",
			"Guidelines:",
			"- Prefer relying on the task_list status rather than polling. Use this tool only when you need task output before the task finishes.",
			"- By default this tool is non-blocking and returns a current status/output snapshot — that is the normal way to use it.",
			"- Do not use task_output to wait for a result you need before continuing — if your next step depends on the task's result, run that task in the foreground instead. task_output is for a deliberate progress check you will act on without blocking, not a way to sit and wait for a background task you just launched.",
			"- Use block=true only when the user explicitly asked you to wait for the task. Never block on a task you launched in the current turn — if you need its result right away, it should have been a foreground call.",
			"- If a block=true call returns still-running, do not block on the same task again. Continue with other work or hand back to the user.",
			"- The full, never-truncated log is always available at the output_path in the result; use the read tool with that path to page through it, whether or not the preview was truncated.",
		].join("\n"),
		parameters: TaskOutputParams,
		async execute(_toolCallId, params, signal): Promise<TextResult> {
			const deadline = Date.now() + Math.min(Math.max(params.timeout ?? 30, 1), 600) * 1000;
			for (;;) {
				const record = readStatus(params.id);
				if (!record) return textResult(`Unknown task id: ${params.id}`, true);
				const terminal = record.status !== "running" || (!liveTasks.has(params.id) && !pidAlive(record.pid));
				if (terminal || !params.block || Date.now() >= deadline || signal?.aborted) {
					const output = finalOutputFromLog(params.id);
					const status = terminal ? record.status : "running";
					const header = `task ${params.id} [${status}] ${record.agent}`;
					const tail = record.error ? `\nerror: ${record.error}` : "";
					return textResult(
						`${header}\n\n${output || "(no output yet)"}${tail}\n\noutput_path: ${logPath(params.id)}`,
						record.status === "failed" || undefined,
					);
				}
				await new Promise((r) => setTimeout(r, 500));
			}
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("task_output ")) + theme.fg("accent", args.id), 0, 0);
		},
	});

	pi.registerTool({
		name: "task_stop",
		label: "Task Stop",
		description: [
			// Verbatim from kimi-code's task-stop.md.
			"Stop a running background task.",
			"",
			"Only use this when a task must genuinely be cancelled — for a task that is finishing normally, wait for its completion or inspect it with task_output instead of stopping it.",
			"",
			"Guidelines:",
			"- This is a general-purpose stop capability for any background task. It is not a bash-specific kill.",
			"- Stopping a task is destructive: it may leave partial side effects behind. Use it with care.",
			"- If the task has already finished, this tool simply returns its current status.",
		].join("\n"),
		parameters: TaskStopParams,
		async execute(_toolCallId, params): Promise<TextResult> {
			const record = readStatus(params.id);
			if (!record) return textResult(`Unknown task id: ${params.id}`, true);
			const live = liveTasks.get(params.id);
			if (live) {
				live.kill();
			} else if (record.pid && pidAlive(record.pid)) {
				try {
					process.kill(record.pid, "SIGTERM");
				} catch (err) {
					return textResult(
						`Failed to kill ${params.id}: ${err instanceof Error ? err.message : String(err)}`,
						true,
					);
				}
			} else {
				return textResult(`Task ${params.id} is not running (status: ${record.status}).`);
			}
			record.status = "stopped";
			record.stopReason = params.reason ?? "stopped by task_stop";
			record.endedAt = new Date().toISOString();
			writeStatus(record);
			liveTasks.delete(params.id);
			return textResult(`Stopped task ${params.id}.`);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("task_stop ")) + theme.fg("accent", args.id), 0, 0);
		},
	});
}
