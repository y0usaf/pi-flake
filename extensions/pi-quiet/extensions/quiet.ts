/**
 * pi-quiet — minimalist chrome, emoticon soul.
 *
 * Header removed; working loader row removed; random hidden-thinking
 * label; faces on builtin tool rows; face embedded in the editor's top
 * border (colored by the live thinking-level border color). While an
 * agent run is active the whole top border pulses through PULSE — the
 * editor border IS the working indicator.
 *
 * Tool rows re-register the builtin *definitions* (not the wrapped
 * AgentTools) so promptSnippet/promptGuidelines survive the override, and
 * builtin renderResult (diffs, highlighting, ctrl+o) is inherited.
 * read/edit are absent on purpose: pi-hashline registers those names.
 *
 * All personality is in the tables below. One timer, started and stopped
 * by agent_start/agent_end, same pattern as pi's rainbow-editor example.
 */

import {
	createBashToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createWriteToolDefinition,
	CustomEditor,
	type ExtensionAPI,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

const PULSE_MS = 240;
const PULSE: ThemeColor[] = ["dim", "muted", "accent", "muted"];
const EDITOR_FACE = "(^-^)";
const ERROR_FACE = "(x_x)";
const LABELS = ["scheming...", "rummaging...", "conjuring...", "plotting...", "percolating..."];

const tilde = (path?: string) => {
	const p = path ?? ".";
	return p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p;
};

// name, face, builtin definition factory, call-line summary.
const TOOL_ROWS: Array<
	[name: string, face: string, make: (cwd: string) => any, arg: (a: Record<string, any>) => string]
> = [
	["bash", "(>_o)", createBashToolDefinition, (a) => `$ ${a.command ?? "..."}`],
	["write", "(^-^)", createWriteToolDefinition, (a) => tilde(a.path)],
	["grep", "(o_O)", createGrepToolDefinition, (a) => `/${a.pattern ?? ""}/ ${tilde(a.path)}`],
	["find", "(@_@)", createFindToolDefinition, (a) => `${a.pattern ?? ""} ${tilde(a.path)}`],
	["ls", "(-_-)", createLsToolDefinition, (a) => tilde(a.path)],
];

// builtin definitions are cwd-bound at construction; memoize per cwd so a
// subagent running elsewhere still resolves paths against its own cwd.
const defCache = new Map<string, any>();
const defFor = (name: string, make: (cwd: string) => any, cwd: string) => {
	const key = `${cwd}\0${name}`;
	let def = defCache.get(key);
	if (!def) defCache.set(key, (def = make(cwd)));
	return def;
};

const ANSI = /\x1b\[[0-9;]*m/g;
const isPlainBorder = (line: string) => /^─+$/.test(line.replace(ANSI, ""));

let editor: QuietEditor | undefined;
let agentActive = false;
let pulseTimer: ReturnType<typeof setInterval> | undefined;
let pulseFrame = 0;

const startPulse = () => {
	if (pulseTimer) return;
	pulseFrame = 0;
	const t = setInterval(() => {
		pulseFrame++;
		editor?.requestPulse();
	}, PULSE_MS);
	t.unref?.();
	pulseTimer = t;
};
const stopPulse = () => {
	agentActive = false;
	if (pulseTimer) clearInterval(pulseTimer);
	pulseTimer = undefined;
	editor?.requestPulse(); // one last static-color render
};

class QuietEditor extends CustomEditor {
	private colors: ThemeColor[] = PULSE;
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
		// face in the top border; idle: borderColor (live thinking level);
		// running: border+face pulse through the theme ramp, replacing the
		// removed working indicator
		if (lines.length > 0 && isPlainBorder(lines[0])) {
			const paint = agentActive
				? (s: string) => this.theme.fg(this.colors[pulseFrame % this.colors.length], s)
				: this.borderColor;
			const face = paint(EDITOR_FACE);
			const rule = paint("─".repeat(Math.max(0, width - visibleWidth(EDITOR_FACE) - 1)));
			lines[0] = `${face} ${rule}`;
		}
		return lines;
	}
	requestPulse() {
		this.tui.requestRender();
	}
}
export default function (pi: ExtensionAPI) {
	// Same execution and result rendering as the builtins; face on the call
	// line, swapped to ERROR_FACE once the row reports an error.
	for (const [name, face, make, arg] of TOOL_ROWS) {
		pi.registerTool({
			...defFor(name, make, process.cwd()),
			execute: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) =>
				defFor(name, make, ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx),
			renderCall(args: any, theme: any, ctx: any) {
				const failed = ctx?.isError === true;
				const summary = theme.fg("dim", arg(args ?? {}));
				const glyph = theme.fg(failed ? "error" : "accent", failed ? ERROR_FACE : face);
				return new Text(`${glyph} ${theme.bold(name)} ${summary}`, 0, 0);
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setHeader(() => ({
			render: () => [],
			invalidate() {},
		}));

		// loader row goes away entirely; the editor border takes its job
		ctx.ui.setWorkingVisible(false);

		ctx.ui.setHiddenThinkingLabel(LABELS[Math.floor(Math.random() * LABELS.length)]);

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			editor = new QuietEditor(tui, theme, keybindings);
			return editor;
		});
	});

	pi.on("agent_start", () => {
		agentActive = true;
		startPulse();
	});
	pi.on("agent_end", stopPulse);
	pi.on("agent_settled", stopPulse);
	pi.on("session_shutdown", stopPulse);
}
