/**
 * pi-minimal — removes chrome from pi's tool rows.
 *
 * Every feature is an ablation on lines pi already rendered. The extension may
 * delete rows and may emit blank rows; it may never emit a character. That rule
 * is what keeps it immune to pi's internals — see DESIGN.md.
 *
 * Colour is not handled here. Themes own colour and cannot touch spacing;
 * this owns spacing and never touches colour. See themes/quiet.json.
 */
import { type ExtensionAPI, type ExtensionContext, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------- predicates

/** CSI, OSC and APC escape sequences, stripped before inspecting a line's shape. */
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;

const bare = (line: string): string => line.replace(ANSI, "").trim();

/** True for pi's `Spacer` rows and for `Box` padding rows, which are blank but background-painted. */
const isBlank = (line: string): boolean => bare(line) === "";

/** Drop matching lines from both ends only. Interior lines are never touched. */
function trimEdges(lines: string[], drop: (line: string) => boolean): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && drop(lines[start] as string)) start++;
	while (end > start && drop(lines[end - 1] as string)) end--;
	return start === 0 && end === lines.length ? lines : lines.slice(start, end);
}

/**
 * Keep the first contiguous run of non-blank lines.
 *
 * Every built-in tool builds its result text starting with a newline, so a tool
 * block is always `call lines`, blank, `result lines`. Cutting at the first
 * blank keeps the whole call however many lines it grows to, and drops the
 * entire result. Nothing is parsed and no line count is recomputed.
 */
function leadingRun(lines: string[]): string[] {
	const end = lines.findIndex(isBlank);
	return end === -1 ? lines : lines.slice(0, end);
}

// ---------------------------------------------------------------- layout

/** What the layout rule is told about the tool row it is trimming. */
type Row = { toolName: string; expanded: boolean };

/**
 * Tools whose collapsed result is a text dump with nothing to skim. `read`
 * already hides its own collapsed result upstream; `edit` and `write` are
 * absent on purpose, because their previews are diffs and highlighted content
 * that are worth reading without expanding.
 */
const DUMP_TOOLS = new Set(["grep", "ls", "find", "bash"]);

/**
 * The layout invariant: every tool block renders as exactly one blank row
 * followed by its body, and a collapsed dump tool has no body past its call.
 *
 * Order matters and is the reason this is one function rather than a pipeline.
 * `leadingRun` cuts at the first blank line, so the padding rows pi wraps the
 * block in must be gone before it runs, or it would cut at row zero and delete
 * the whole block.
 */
function toolRows(lines: string[], row: Row): string[] {
	const body = trimEdges(lines, isBlank);
	const kept = !row.expanded && DUMP_TOOLS.has(row.toolName) ? leadingRun(body) : body;
	return kept.length === 0 ? [] : ["", ...kept];
}

// ---------------------------------------------------------------- mechanism

const ORIGINAL_TOOL_RENDER = "__piMinimalOriginalToolRender";

/** Read the row's own expansion flag, falling back to pi's global toggle if that field ever moves. */
function readRow(component: unknown, ctx: ExtensionContext): Row {
	const self = component as { toolName?: unknown; expanded?: unknown };
	return {
		toolName: typeof self.toolName === "string" ? self.toolName.trim().toLowerCase() : "",
		expanded: typeof self.expanded === "boolean" ? self.expanded : ctx.ui.getToolsExpanded(),
	};
}

/**
 * Wrap `ToolExecutionComponent.render` so `toolRows` runs over the lines it
 * returned. The wrapper writes no component state and reads only `toolName` and
 * `expanded`. Idempotent: the original is stashed on the prototype.
 */
function filterToolRows(ctx: ExtensionContext): () => void {
	const proto = (ToolExecutionComponent as unknown as { prototype: Record<string, unknown> }).prototype;
	if (typeof proto?.render !== "function") throw new Error("ToolExecutionComponent.render is not a function");

	const original = (
		typeof proto[ORIGINAL_TOOL_RENDER] === "function" ? proto[ORIGINAL_TOOL_RENDER] : proto.render
	) as (this: unknown, width: number) => string[];

	proto[ORIGINAL_TOOL_RENDER] = original;
	proto.render = function piMinimalToolRender(this: unknown, width: number): string[] {
		return toolRows(original.call(this, width), readRow(this, ctx));
	};

	return () => {
		proto.render = original;
		delete proto[ORIGINAL_TOOL_RENDER];
	};
}

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
	let undo: Array<() => void> = [];

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		try {
			undo.push(filterToolRows(ctx));
		} catch (error) {
			ctx.ui.notify(`pi-minimal: tool rows unchanged — ${error instanceof Error ? error.message : error}`, "error");
		}
	});

	pi.on("session_shutdown", () => {
		for (const revert of undo.reverse()) revert();
		undo = [];
	});
}
