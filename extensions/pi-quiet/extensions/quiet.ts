/**
 * pi-quiet — minimalist chrome.
 *
 * Header removed; working loader row removed; hidden thinking collapses to
 * one blank line (empty label); face embedded in the editor's top border
 * (colored by the live thinking-level border color). While an agent run is
 * active the whole top border pulses through PULSE — the editor border IS
 * the working indicator.
 *
 * Tool rows are pi's own. Quiet does not register or re-render any tool:
 * builtin rows keep their diffs, syntax highlight, bash elapsed timer and
 * ctrl+o expansion, and rows owned by other extensions (pi-hashline's
 * read/edit, web_search, subagent, …) stay consistent with them.
 *
 * One timer, started and stopped by agent_start/agent_end, same pattern as
 * pi's rainbow-editor example.
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionUIContext,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const PULSE_MS = 240;
const PULSE: ThemeColor[] = ["dim", "muted", "accent", "muted"];
const EDITOR_FACE = "(^-^)";

const ANSI = /\x1b\[[0-9;]*m/g;
const isPlainBorder = (line: string) => /^─+$/.test(line.replace(ANSI, ""));

// this.theme on Editor is the narrow EditorTheme (borderColor + selectList
// only, no fg/bg); the full Theme lives on ctx.ui and is read lazily so a
// mid-session theme switch is picked up.
let uiCtx: ExtensionUIContext | undefined;
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
				? (s: string) => uiCtx?.theme.fg(this.colors[pulseFrame % this.colors.length], s) ?? s
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
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		uiCtx = ctx.ui;
		ctx.ui.setHeader(() => ({
			render: () => [],
			invalidate() {},
		}));

		// loader row goes away entirely; the editor border takes its job
		ctx.ui.setWorkingVisible(false);

		// empty label: the builtin Text renders zero visible text, so a hidden
		// thinking run costs one blank line instead of a word. ctrl+t unhides.
		ctx.ui.setHiddenThinkingLabel("");

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
