/**
 * pi-quiet — minimalist chrome, emoticon soul.
 *
 * - Header (logo + keybinding hints): removed.
 * - Working indicator: a face that blinks while pi streams.
 * - Hidden-thinking label: random flavor per session.
 * - Footer: pi's default (model, tokens, cost — already minimal enough).
 * - Tool rows: each builtin tool call renders as `face name arg`; result
 *   rendering is inherited from the builtins (diffs, highlighting, ctrl+o).
 * - Editor: face embedded in the top border, colored by the live editor
 *   border color (which pi drives from the thinking level); bottom border
 *   removed.
 *
 * All personality lives in the data tables below. Swap a row, change the
 * character. No timers, no subscriptions: the host animates spinner frames
 * and re-renders everything else on state changes.
 */

import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	CustomEditor,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

const BLINK = ["(o_o)", "(o_o)", "(o_o)", "(o_o)", "(-_-)"];
const EDITOR_FACE = "(^-^)";
const LABELS = ["scheming...", "rummaging...", "conjuring...", "plotting...", "percolating..."];

const tilde = (path?: string) => {
	const p = path ?? ".";
	return p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p;
};

// face + how to summarize the call args, per builtin tool
const TOOL_ROWS: Array<[name: string, face: string, arg: (a: Record<string, any>) => string]> = [
	["read", "(o_o)", (a) => tilde(a.path)],
	["bash", "(>_o)", (a) => `$ ${a.command ?? "..."}`],
	["edit", "(._.)", (a) => tilde(a.path)],
	["write", "(^-^)", (a) => tilde(a.path)],
	["grep", "(o_O)", (a) => `/${a.pattern ?? ""}/ ${tilde(a.path)}`],
	["find", "(@_@)", (a) => `${a.pattern ?? ""} ${tilde(a.path)}`],
	["ls", "(-_-)", (a) => tilde(a.path)],
];

function makeTools(cwd: string) {
	return {
		read: createReadTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
	} as Record<string, any>;
}
const toolCache = new Map<string, Record<string, any>>();
const toolsFor = (cwd: string) => {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = makeTools(cwd);
		toolCache.set(cwd, tools);
	}
	return tools;
};

const ANSI = /\x1b\[[0-9;]*m/g;
const isPlainBorder = (line: string) => /^─+$/.test(line.replace(ANSI, ""));

class QuietEditor extends CustomEditor {
	render(width: number): string[] {
		const lines = super.render(width);
		// drop the bottom border (last plain-border line), keep scroll
		// indicators and autocomplete lines untouched
		for (let i = lines.length - 1; i > 0; i--) {
			if (isPlainBorder(lines[i])) {
				lines.splice(i, 1);
				break;
			}
		}
		// put a face in the top border; this.borderColor is live-updated by
		// pi to the thinking-level (or bash-mode) color, so the face follows
		if (lines.length > 0 && isPlainBorder(lines[0])) {
			const face = this.borderColor(EDITOR_FACE);
			const rule = this.borderColor("─".repeat(Math.max(0, width - visibleWidth(EDITOR_FACE) - 1)));
			lines[0] = `${face} ${rule}`;
		}
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	// Tool rows: same execution, face on the call line, builtin result
	// rendering inherited by spreading the builtin definition.
	for (const [name, face, arg] of TOOL_ROWS) {
		const base = toolsFor(process.cwd())[name];
		pi.registerTool({
			...base,
			async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
				return toolsFor(ctx.cwd)[name].execute(toolCallId, params, signal, onUpdate);
			},
			renderCall(args: any, theme: any) {
				const summary = theme.fg("dim", arg(args ?? {}));
				return new Text(`${theme.fg("accent", face)} ${theme.bold(name)} ${summary}`, 0, 0);
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setHeader(() => ({
			render: () => [],
			invalidate() {},
		}));

		ctx.ui.setWorkingIndicator({
			frames: BLINK.map((frame) => ctx.ui.theme.fg("accent", frame)),
			intervalMs: 240,
		});

		ctx.ui.setHiddenThinkingLabel(LABELS[Math.floor(Math.random() * LABELS.length)]);

		ctx.ui.setEditorComponent((tui, theme, keybindings) => new QuietEditor(tui, theme, keybindings));

	});
}
