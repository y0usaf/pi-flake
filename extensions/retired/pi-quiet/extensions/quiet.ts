/**
 * pi-quiet — OMP-style prompt chrome.
 *
 * Header removed; working loader row removed; hidden thinking collapses to
 * one blank line. The editor renders as a two-line OMP prompt: the top
 * border is a live status bar (+-- pi > [M] model - [thinking] > [T] cwd > ctx > $cost >---+) and
 * the face prefixes the input line. While an agent run is active the frame
 * pulses through PULSE — the bar IS the working indicator.
 *
 * Tool rows are pi's own; quiet registers nothing tool-related.
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PULSE_MS = 240;
const PULSE: ThemeColor[] = ["dim", "muted", "accent", "muted"];
const FACE = "(^-^)";
const PAD = " ".repeat(visibleWidth(FACE) + 1); // content indent under the bar

const ANSI = /\x1b\[[0-9;]*m/g;
const isPlainBorder = (line: string) => /^─+$/.test(line.replace(ANSI, ""));

const fmtTokens = (n: number) =>
	n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`;

// live session view, captured at session_start; model/usage/cost are read
// fresh on every render so the bar tracks model switches and spend.
let sessionCtx: ExtensionContext | undefined;
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

// OMP bar: colored segments joined by frame-painted " > ", padded with an
// ASCII rule so the whole line doubles as the editor's top border.

// omp status-line colors (can1357/oh-my-pi dark theme, statusLine* roles).
// Hardcoded — the pi fork's theme has no such roles and theme.fg throws on
// unknown ones; pi-powerline-footer does the same. Escalation bands stay
// theme roles, matching omp's own getContextUsageThemeColor.
const OMP = {
	model: "#d787af",
	path: "#00afaf",
	context: "#8787af",
	cost: 205, // 256-color index, as in omp's dark.json
} as const;

// paint a segment: hex/256 index directly, theme roles via the active theme
const fg = (c: string | number, s: string): string => {
	if (typeof c === "number") return `\x1b[38;5;${c}m${s}\x1b[39m`;
	if (c.startsWith("#")) {
		const r = parseInt(c.slice(1, 3), 16);
		const g = parseInt(c.slice(3, 5), 16);
		const b = parseInt(c.slice(5, 7), 16);
		return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
	}
	return uiCtx?.theme.fg(c as ThemeColor, s) ?? s;
};

const ompBar = (width: number, frame: (s: string) => string): string => {
	const m = sessionCtx?.model;
	const u = sessionCtx?.getContextUsage();
	let cost = 0;
	for (const e of sessionCtx?.sessionManager.getEntries() ?? []) {
		if (e.type === "message" && (e.message.role === "assistant" || e.message.role === "toolResult")) {
			cost += (e.message as { usage?: { cost: { total: number } } }).usage?.cost.total ?? 0;
		} else if ((e.type === "branch_summary" || e.type === "compaction") && e.usage) {
			cost += e.usage.cost.total;
		}
	}
	const home = process.env.HOME;
	const raw = sessionCtx?.sessionManager.getCwd() ?? "";
	const cwd = home && raw.startsWith(home) ? `~${raw.slice(home.length)}` : raw;
	const pct = u?.percent ?? 0;
	const segs: [string | number, string][] = [
		["accent", "pi"],
		[OMP.model, `[M] ${m?.name || m?.id || "no-model"}${m?.reasoning ? ` - [${sessionCtx?.thinkingLevel}]` : ""}`],
		[OMP.path, `[T] ${cwd}`],
		[pct > 90 ? "error" : pct > 70 ? "thinkingHigh" : pct > 50 ? "warning" : OMP.context,
			`ctx: ${u?.percent != null ? pct.toFixed(1) : "?"}%/${fmtTokens(u?.contextWindow ?? m?.contextWindow ?? 0)}`],
		[OMP.cost, `$${cost.toFixed(2)}`],
	];
	const plain = `+-- ${segs.map(([, s]) => s).join(" > ")} >`;
	const rule = "-".repeat(Math.max(0, width - visibleWidth(plain) - 1));
	const body = segs.map(([c, s]) => fg(c, s)).join(frame(" > "));
	return truncateToWidth(`${frame("+-- ")}${body}${frame(` >${rule}+`)}`, width);
};

class QuietEditor extends CustomEditor {
	render(width: number): string[] {
		// inner editor is narrower by the face column; cursor math stays
		// consistent because every render uses the same inner width
		const lines = super.render(Math.max(1, width - PAD.length));
		// drop the bottom border (last plain-border line), keep scroll
		// indicators and autocomplete lines untouched
		for (let i = lines.length - 1; i > 0; i--) {
			if (isPlainBorder(lines[i])) {
				lines.splice(i, 1);
				break;
			}
		}
		// idle: borderColor (live thinking level); running: pulse ramp
		const paint = agentActive
			? (s: string) => uiCtx?.theme.fg(PULSE[pulseFrame % PULSE.length], s) ?? s
			: this.borderColor;
		return lines.map((l, i) =>
			i === 0
				? isPlainBorder(l)
					? ompBar(width, paint)
					: PAD + l // scrolled: keep the ↑ indicator border
				: i === 1
					? `${paint(FACE)} ${l}`
					: PAD + l,
		);
	}
	requestPulse() {
		this.tui.requestRender();
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		sessionCtx = ctx;
		uiCtx = ctx.ui;
		ctx.ui.setHeader(() => ({
			render: () => [],
			invalidate() {},
		}));

		// loader row goes away entirely; the bar takes its job
		ctx.ui.setWorkingVisible(false);

		// empty label: a hidden thinking run costs one blank line. ctrl+t unhides.
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
