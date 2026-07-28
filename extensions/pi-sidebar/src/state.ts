/**
 * Session-scoped snapshot the sidebar renders from.
 *
 * Events write into SidebarState; the component only ever reads an immutable
 * copy (buildSnapshot), so render() never touches live event state mid-frame.
 */

export interface ToolRun {
	toolCallId: string;
	toolName: string;
	/** Short display hint, e.g. the path being edited or the bash command. */
	hint?: string;
	/** Full path from args.path when this is a file-mutating tool. */
	filePath?: string;
	startedAt: number;
}

export interface FinishedTool {
	toolName: string;
	hint?: string;
	durationMs: number;
	isError: boolean;
}

export interface SidebarState {
	/** Pi agent activity: idle = no run, running = agent active, input = pi asked a question. */
	activity: "idle" | "running";
	turnIndex: number;
	sessionName?: string;
	cwd: string;
	branch?: string;
	modelName?: string;
	modelProvider?: string;
	thinkingLevel?: string;
	/** Cumulative token/cost totals across assistant messages this session. */
	totalInput: number;
	totalOutput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalCost: number;
	/** Files touched by edit/write-class tools, most recent first. */
	modifiedFiles: string[];
	runningTools: ToolRun[];
	recentTools: FinishedTool[];
	activeToolCount: number;
	availableToolCount: number;
}

export interface SidebarSnapshot extends SidebarState {
	projectName: string;
	/** Context usage fetched at snapshot time; tokens/percent may be null after compaction. */
	contextTokens: number | null;
	contextWindow: number;
	contextPercent: number | null;
}

export const MAX_MODIFIED_FILES = 40;
export const MAX_RECENT_TOOLS = 8;

/** Tool names whose args.path/args.filePath counts as "modified a file". */
const FILE_MUTATING_TOOLS = new Set(["edit", "write", "multi_edit", "multiedit", "patch"]);

export function createInitialState(cwd: string): SidebarState {
	return {
		activity: "idle",
		turnIndex: 0,
		cwd,
		totalInput: 0,
		totalOutput: 0,
		totalCacheRead: 0,
		totalCacheWrite: 0,
		totalCost: 0,
		modifiedFiles: [],
		runningTools: [],
		recentTools: [],
		activeToolCount: 0,
		availableToolCount: 0,
	};
}

/** Extract a short display hint from tool args: a path, a command, or a pattern. */
export function toolHint(toolName: string, args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	const path = record.path ?? record.filePath ?? record.file_path;
	if (typeof path === "string" && path.length > 0) return shortenPath(path);
	const command = record.command;
	if (typeof command === "string" && command.length > 0) {
		const firstLine = command.split("\n")[0] ?? command;
		return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
	}
	const pattern = record.pattern ?? record.query;
	if (typeof pattern === "string" && pattern.length > 0) return pattern;
	return toolName === "bash" ? undefined : undefined;
}

/** Strip the cwd prefix for display and collapse the home directory to ~. */
export function shortenPath(path: string, cwd?: string): string {
	let out = path;
	if (cwd && out.startsWith(cwd)) out = out.slice(cwd.length);
	const home = process.env.HOME;
	if (home && out.startsWith(home)) out = `~${out.slice(home.length)}`;
	return out.replace(/^\//, "");
}

export function noteModifiedFile(state: SidebarState, path: string): void {
	const short = shortenPath(path, state.cwd);
	const next = [short, ...state.modifiedFiles.filter((f) => f !== short)];
	state.modifiedFiles = next.slice(0, MAX_MODIFIED_FILES);
}

export function isFileMutatingTool(toolName: string): boolean {
	return FILE_MUTATING_TOOLS.has(toolName);
}
