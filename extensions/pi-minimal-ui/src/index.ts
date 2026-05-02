import type { AssistantMessage } from "@mariozechner/pi-ai";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const UI_MIN_WIDTH = 24;
const PROMPT_MARKER = ":::";
const HEADER_DIAG = "╱";
const MIN_HEADER_DIAGS = 3;
const SECTION_SEPARATOR_TEXT = " /// ";
const STATUS_EDGE_TEXT = "///";

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;

const ANSI_FG_RESET = "\x1b[39m";
const ANSI_SGR_PATTERN = /\x1b\[([0-9;]*)m/g;

type Rgb = { r: number; g: number; b: number };
type Hsl = { h: number; s: number; l: number };
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type Theme = ExtensionContext["ui"]["theme"];

const THINKING_COLOR: Record<ThinkingLevel, Parameters<Theme["fg"]>[0]> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
};

const CUBE_VALUES = [0, 95, 135, 175, 215, 255];
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

function ansi256ToRgb(index: number): Rgb {
	if (index < 16) {
		const base: Rgb[] = [
			{ r: 0, g: 0, b: 0 },
			{ r: 128, g: 0, b: 0 },
			{ r: 0, g: 128, b: 0 },
			{ r: 128, g: 128, b: 0 },
			{ r: 0, g: 0, b: 128 },
			{ r: 128, g: 0, b: 128 },
			{ r: 0, g: 128, b: 128 },
			{ r: 192, g: 192, b: 192 },
			{ r: 128, g: 128, b: 128 },
			{ r: 255, g: 0, b: 0 },
			{ r: 0, g: 255, b: 0 },
			{ r: 255, g: 255, b: 0 },
			{ r: 0, g: 0, b: 255 },
			{ r: 255, g: 0, b: 255 },
			{ r: 0, g: 255, b: 255 },
			{ r: 255, g: 255, b: 255 },
		];
		return base[Math.max(0, Math.min(15, index))];
	}
	if (index >= 232) {
		const gray = GRAY_VALUES[Math.max(0, Math.min(GRAY_VALUES.length - 1, index - 232))];
		return { r: gray, g: gray, b: gray };
	}
	const offset = Math.max(0, Math.min(215, index - 16));
	return {
		r: CUBE_VALUES[Math.floor(offset / 36)],
		g: CUBE_VALUES[Math.floor(offset / 6) % 6],
		b: CUBE_VALUES[offset % 6],
	};
}

function ansiToRgb(ansi: string): Rgb | undefined {
	const truecolor = ansi.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
	if (truecolor) return { r: Number(truecolor[1]), g: Number(truecolor[2]), b: Number(truecolor[3]) };
	const color256 = ansi.match(/\x1b\[38;5;(\d+)m/);
	return color256 ? ansi256ToRgb(Number(color256[1])) : undefined;
}

function rgbToHsl({ r, g, b }: Rgb): Hsl {
	r /= 255;
	g /= 255;
	b /= 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return { h: 0, s: 0, l };

	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h = 0;
	if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
	else if (max === g) h = (b - r) / d + 2;
	else h = (r - g) / d + 4;
	return { h: h * 60, s, l };
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const hp = (((h % 360) + 360) % 360) / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	const m = l - c / 2;
	let [r, g, b] = [0, 0, 0];
	if (hp < 1) [r, g, b] = [c, x, 0];
	else if (hp < 2) [r, g, b] = [x, c, 0];
	else if (hp < 3) [r, g, b] = [0, c, x];
	else if (hp < 4) [r, g, b] = [0, x, c];
	else if (hp < 5) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

function gradientAnsi(start: Rgb, end: Rgb, index: number, total: number): string {
	const t = Math.min(1, total <= 1 ? 0 : index / (total - 1));
	const a = rgbToHsl(start);
	const b = rgbToHsl(end);
	if (a.s < 0.05) a.h = b.h;
	if (b.s < 0.05) b.h = a.h;
	const hueDelta = ((((b.h - a.h) % 360) + 540) % 360) - 180;
	const saturation = a.s + (b.s - a.s) * t;
	const rgb = hslToRgb({
		h: a.h + hueDelta * t,
		s: Math.min(1, t === 0 || t === 1 ? saturation : Math.max(0.4, saturation * 1.25)),
		l: a.l + (b.l - a.l) * t,
	});
	return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`;
}

function currentFgFromSgr(params: string, currentFg: string | undefined): string | undefined {
	const codes = params ? params.split(";").map((part) => Number(part)) : [0];
	for (let i = 0; i < codes.length; i++) {
		const code = codes[i];
		if (code === 0 || code === 39) currentFg = undefined;
		else if (code === 38 && codes[i + 1] === 2 && i + 4 < codes.length) {
			currentFg = `\x1b[38;2;${codes[i + 2]};${codes[i + 3]};${codes[i + 4]}m`;
			i += 4;
		} else if (code === 38 && codes[i + 1] === 5 && i + 2 < codes.length) {
			currentFg = `\x1b[38;5;${codes[i + 2]}m`;
			i += 2;
		}
	}
	return currentFg;
}

function applyHeaderGradient(line: string, theme: Theme, thinking: ThinkingLevel | undefined, gradientWidth: number): string {
	if (!thinking) return line;
	const start = ansiToRgb(theme.getFgAnsi("accent"));
	const end = ansiToRgb(theme.getFgAnsi(THINKING_COLOR[thinking]));
	if (!start || !end) return line;

	const dimFg = new Set([theme.getFgAnsi("dim"), theme.getFgAnsi("muted")]);
	const width = Math.max(1, gradientWidth);
	let out = "";
	let last = 0;
	let visible = 0;
	let currentFg: string | undefined;
	ANSI_SGR_PATTERN.lastIndex = 0;

	for (const match of line.matchAll(ANSI_SGR_PATTERN)) {
		out += gradientChunk(line.slice(last, match.index), currentFg, dimFg, start, end, visible, width);
		visible += visibleWidth(line.slice(last, match.index));
		out += match[0];
		currentFg = currentFgFromSgr(match[1], currentFg);
		last = match.index + match[0].length;
	}
	out += gradientChunk(line.slice(last), currentFg, dimFg, start, end, visible, width);
	return `${out}${ANSI_FG_RESET}`;
}

function gradientChunk(
	chunk: string,
	currentFg: string | undefined,
	dimFg: Set<string>,
	start: Rgb,
	end: Rgb,
	visibleOffset: number,
	lineWidth: number,
): string {
	if (!chunk || (currentFg && dimFg.has(currentFg))) return chunk;
	let out = "";
	let visible = visibleOffset;
	for (const char of chunk) {
		const charWidth = visibleWidth(char);
		out += charWidth > 0 ? `${gradientAnsi(start, end, visible, lineWidth)}${char}` : char;
		visible += charWidth;
	}
	return out;
}

function uiWidth(width: number): number {
	return width <= UI_MIN_WIDTH ? Math.max(1, width) : width;
}

function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

function compactNumber(value: number): string {
	if (value < 1000) return `${value}`;
	if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1000000) return `${Math.round(value / 1000)}k`;
	return `${(value / 1000000).toFixed(1)}M`;
}

function sanitize(value: string): string {
	return value.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function joinStyled(parts: Array<string | undefined>, separator: string): string {
	return parts.filter((part): part is string => Boolean(part)).join(separator);
}

function shortPath(path: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function tailPath(path: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(path) <= maxWidth) return path;
	if (maxWidth <= 1) return "…";

	const normalized = path.replace(/\/+$/, "") || path;
	const prefix = normalized.startsWith("~/") ? "~/" : normalized.startsWith("/") ? "/" : "";
	const body = prefix === "~/" ? normalized.slice(2) : prefix === "/" ? normalized.slice(1) : normalized;
	const parts = body.split("/").filter(Boolean);
	let tail = parts.pop() ?? body;

	while (parts.length > 0) {
		const next = `${parts[parts.length - 1]}/${tail}`;
		const candidate = `${prefix}…/${next}`;
		if (visibleWidth(candidate) > maxWidth) break;
		tail = next;
		parts.pop();
	}

	const candidate = `${prefix}…/${tail}`;
	if (visibleWidth(candidate) <= maxWidth) return candidate;

	return truncateToWidth(`…${tail}`, maxWidth, "");
}

function usageFromSession(ctx: ExtensionContext): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		input += message.usage?.input ?? 0;
		output += message.usage?.output ?? 0;
		cacheRead += message.usage?.cacheRead ?? 0;
		cacheWrite += message.usage?.cacheWrite ?? 0;
		cost += message.usage?.cost?.total ?? 0;
	}

	return { input, output, cacheRead, cacheWrite, cost };
}

function renderLocation(ctx: ExtensionContext, branch: string | null, theme: ExtensionContext["ui"]["theme"], maxWidth: number): string {
	const cwd = shortPath(ctx.sessionManager.getCwd());
	const branchText = branch ? ` ${branch}` : undefined;
	const sessionName = ctx.sessionManager.getSessionName();
	const separator = SECTION_SEPARATOR_TEXT;
	const separatorWidth = visibleWidth(SECTION_SEPARATOR_TEXT);
	const variants = [
		[branchText, sessionName],
		[branchText],
		[],
	].map((items) => items.filter((item): item is string => Boolean(item)));

	for (const suffixes of variants) {
		const suffixWidth = suffixes.reduce((sum, suffix, index) => sum + visibleWidth(suffix) + (index > 0 ? separatorWidth : 0), 0);
		const pathWidth = maxWidth - suffixWidth - (suffixes.length > 0 ? separatorWidth : 0);
		if (pathWidth < 4) continue;

		const location = joinStyled(
			[theme.fg("accent", tailPath(cwd, pathWidth)), ...suffixes.map((suffix) => theme.fg("dim", suffix))],
			separator,
		);
		if (visibleWidth(location) <= maxWidth) return location;
	}

	return theme.fg("accent", tailPath(cwd, maxWidth));
}

function renderStats(ctx: ExtensionContext, theme: ExtensionContext["ui"]["theme"]): string {
	const usage = usageFromSession(ctx);
	const context = ctx.getContextUsage();
	const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const contextPercentValue = context?.percent ?? 0;
	const contextPercent = context?.percent == null ? "?" : context.percent.toFixed(1);
	const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
	const contextText = `${contextPercent}%/${compactNumber(contextWindow)}`;
	const contextStyle = contextPercentValue > 90 ? "error" : contextPercentValue > 70 ? "warning" : "dim";

	return joinStyled(
		[
			usage.input ? theme.fg("dim", `↑${compactNumber(usage.input)}`) : undefined,
			usage.output ? theme.fg("dim", `↓${compactNumber(usage.output)}`) : undefined,
			usage.cacheRead ? theme.fg("dim", `R${compactNumber(usage.cacheRead)}`) : undefined,
			usage.cacheWrite ? theme.fg("dim", `W${compactNumber(usage.cacheWrite)}`) : undefined,
			usage.cost || usingSubscription ? theme.fg("dim", `$${usage.cost.toFixed(3)}${usingSubscription ? " sub" : ""}`) : undefined,
			theme.fg(contextStyle, contextText),
		],
		" ",
	);
}

function renderExtensionStatusGroups(footerData: { getExtensionStatuses(): ReadonlyMap<string, string> }): string[] {
	return [...footerData.getExtensionStatuses().entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, value]) => sanitize(value))
		.filter(Boolean);
}

function currentThinkingLevel(pi: ExtensionAPI, ctx: ExtensionContext): ThinkingLevel | undefined {
	if (!ctx.model?.reasoning) return undefined;
	const level = pi.getThinkingLevel();
	return level && level in THINKING_COLOR ? (level as ThinkingLevel) : undefined;
}

function renderModelInfo(pi: ExtensionAPI, ctx: ExtensionContext, theme: ExtensionContext["ui"]["theme"]): string {
	const separator = SECTION_SEPARATOR_TEXT;
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no-model";
	const thinking = currentThinkingLevel(pi, ctx);
	return joinStyled([theme.fg("dim", model), thinking ? theme.fg(THINKING_COLOR[thinking], thinking) : undefined], separator);
}

function padLine(line: string, width: number): string {
	const clipped = truncateToWidth(line, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function centerLine(line: string, lineWidth: number, width: number): string {
	const left = Math.max(0, Math.floor((width - lineWidth) / 2));
	const right = Math.max(0, width - lineWidth - left);
	return `${" ".repeat(left)}${line}${" ".repeat(right)}`;
}

function renderStatusGroups(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	footerData: { getGitBranch(): string | null; getExtensionStatuses(): ReadonlyMap<string, string> },
	theme: ExtensionContext["ui"]["theme"],
	width: number,
): string[] {
	const branch = footerData.getGitBranch();
	const statuses = renderExtensionStatusGroups(footerData);

	return [
		renderLocation(ctx, branch, theme, Math.max(1, Math.floor(width * 0.45))),
		renderStats(ctx, theme),
		renderModelInfo(pi, ctx, theme),
		...statuses.map((status) => theme.fg("dim", status)),
	].filter((group): group is string => Boolean(group));
}

function headerContentRows(groups: string[], theme: ExtensionContext["ui"]["theme"], maxWidth: number): string[] {
	const separator = SECTION_SEPARATOR_TEXT;
	const separatorWidth = visibleWidth(SECTION_SEPARATOR_TEXT);
	const rows: string[] = [];
	let row: string[] = [];
	let rowWidth = 0;

	for (const group of groups) {
		const groupWidth = visibleWidth(group);
		const nextWidth = row.length === 0 ? groupWidth : rowWidth + separatorWidth + groupWidth;
		if (row.length > 0 && nextWidth > maxWidth) {
			rows.push(row.join(separator));
			row = [group];
			rowWidth = groupWidth;
		} else {
			row.push(group);
			rowWidth = nextWidth;
		}
	}

	if (row.length > 0) rows.push(row.join(separator));
	return rows.length > 0 ? rows : [""];
}

function renderHeaderLine(content: string, theme: ExtensionContext["ui"]["theme"], width: number, thinking: ThinkingLevel | undefined): string {
	const edge = theme.fg("accent", STATUS_EDGE_TEXT);
	const edgeWidth = visibleWidth(STATUS_EDGE_TEXT);
	const prefix = `${theme.fg("accent", "pi")} `;
	const prefixWidth = visibleWidth(prefix);
	const fixedWidth = edgeWidth * 2 + prefixWidth + MIN_HEADER_DIAGS + 3;
	const maxContentWidth = Math.max(0, width - fixedWidth);
	const fittedContent = truncateToWidth(content, maxContentWidth, "…");
	const fittedContentWidth = visibleWidth(fittedContent);
	const diagCount = Math.max(MIN_HEADER_DIAGS, width - edgeWidth * 2 - prefixWidth - fittedContentWidth - 3);
	const line = `${edge} ${prefix}${theme.fg("accent", HEADER_DIAG.repeat(diagCount))} ${fittedContent} ${edge}`;
	return applyHeaderGradient(padLine(line, width), theme, thinking, edgeWidth + 1 + prefixWidth + diagCount);
}


function renderStatusline(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	footerData: { getGitBranch(): string | null; getExtensionStatuses(): ReadonlyMap<string, string> },
	theme: ExtensionContext["ui"]["theme"],
	width: number,
): string[] {
	const innerWidth = uiWidth(width);
	const fixedWidth = visibleWidth(STATUS_EDGE_TEXT) * 2 + visibleWidth("pi ") + MIN_HEADER_DIAGS + 3;
	const maxContentWidth = Math.max(1, innerWidth - fixedWidth);
	const groups = renderStatusGroups(pi, ctx, footerData, theme, innerWidth);
	const thinking = currentThinkingLevel(pi, ctx);
	const lines = headerContentRows(groups, theme, maxContentWidth).map((row) => renderHeaderLine(row, theme, innerWidth, thinking));
	if (innerWidth === width) return lines;
	return lines.map((line) => centerLine(line, innerWidth, width));
}

function isEditorBorder(line: string): boolean {
	const text = stripAnsi(line).trim();
	return /^─+$/.test(text) || /^─── [↑↓] \d+ more ─*$/.test(text);
}

function scrollLabel(line: string): string | undefined {
	return stripAnsi(line).match(/[↑↓] \d+ more/)?.[0];
}

// Crush-inspired "Working..." animation. Generates pre-rendered indicator
// frames containing a gradient-colored cycling-character ribbon. Gradient
// matches the sidebar header: solid accent when thinking is off, accent →
// thinking-level color when on. No label / ellipsis. Pi loops frames at
// WORK_FRAME_MS; the staggered birth phase replays on each loop.
const WORK_FPS = 20;
const WORK_FRAME_MS = Math.round(1000 / WORK_FPS);
const WORK_CYCLING_WIDTH = 10;
const WORK_TOTAL_FRAMES = 40;
const WORK_BIRTH_FRAMES = 20;
const WORK_RUNES = "0123456789abcdefABCDEF~!@#$%^&*()+=_-";
const WORK_INITIAL_CHAR = ".";
const WORK_HIDDEN_MESSAGE = "\u200B"; // zero-width: bypass pi's `||` fallback to "Working..."

function pickRune(): string {
	return WORK_RUNES[Math.floor(Math.random() * WORK_RUNES.length)] ?? WORK_INITIAL_CHAR;
}

function buildWorkingFrames(theme: Theme, thinking: ThinkingLevel | undefined): string[] {
	const accentAnsi = theme.getFgAnsi("accent");
	const accentRgb = ansiToRgb(accentAnsi);
	const endRgb = thinking ? ansiToRgb(theme.getFgAnsi(THINKING_COLOR[thinking])) : undefined;
	const gradient = accentRgb && endRgb;

	const birthOffsets = Array.from({ length: WORK_CYCLING_WIDTH }, () =>
		Math.floor(Math.random() * WORK_BIRTH_FRAMES),
	);

	const frames: string[] = [];
	for (let f = 0; f < WORK_TOTAL_FRAMES; f++) {
		let cycling = "";
		for (let i = 0; i < WORK_CYCLING_WIDTH; i++) {
			const color = gradient
				? gradientAnsi(accentRgb, endRgb, i, WORK_CYCLING_WIDTH)
				: accentAnsi;
			const char = f < (birthOffsets[i] ?? 0) ? WORK_INITIAL_CHAR : pickRune();
			cycling += `${color}${char}`;
		}
		cycling += ANSI_FG_RESET;
		frames.push(cycling);
	}
	return frames;
}

function applyWorkingIndicator(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const thinking = currentThinkingLevel(pi, ctx);
	const frames = buildWorkingFrames(ctx.ui.theme, thinking);
	ctx.ui.setWorkingMessage(WORK_HIDDEN_MESSAGE);
	ctx.ui.setWorkingIndicator({ frames, intervalMs: WORK_FRAME_MS });
}


class MinimalRailEditor extends CustomEditor {
	render(width: number): string[] {
		if (width < 4) return super.render(width);

		const outerWidth = uiWidth(width);
		const markerWidth = visibleWidth(PROMPT_MARKER) + 1;
		const innerWidth = Math.max(1, outerWidth - markerWidth);
		const leftMargin = " ".repeat(Math.max(0, Math.floor((width - outerWidth) / 2)));
		const lines = super.render(innerWidth);
		if (lines.length === 0) return lines;

		const bottomIndex = lines.findIndex((line, index) => index > 0 && isEditorBorder(line));
		const topLabel = scrollLabel(lines[0] ?? "");
		const bottomLabel = bottomIndex >= 0 ? scrollLabel(lines[bottomIndex] ?? "") : undefined;
		const body = bottomIndex >= 0 ? [...lines.slice(1, bottomIndex), ...lines.slice(bottomIndex + 1)] : lines;
		const rendered = body.map((line, index) => leftMargin + this.renderPromptLine(line, innerWidth, index === 0));

		return [
			...(topLabel ? [leftMargin + this.renderScrollLabel(topLabel, outerWidth)] : []),
			...rendered,
			...(bottomLabel ? [leftMargin + this.renderScrollLabel(bottomLabel, outerWidth)] : []),
		];
	}

	private renderPromptLine(line: string, innerWidth: number, first: boolean): string {
		const clipped = truncateToWidth(line, innerWidth, "");
		const padded = `${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}`;
		const marker = first ? this.borderColor(PROMPT_MARKER) : this.borderColor("  │");
		return `${marker} ${padded}`;
	}

	private renderScrollLabel(label: string, outerWidth: number): string {
		const text = ` ${label} `;
		const fillWidth = Math.max(0, outerWidth - visibleWidth(text));
		return this.borderColor(`${text}${"─".repeat(fillWidth)}`);
	}
}

export default function minimalUi(pi: ExtensionAPI) {
	let requestRender: (() => void) | undefined;
	const refresh = () => requestRender?.();

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new MinimalRailEditor(tui, theme, keybindings, { paddingX: 0 }));
		applyWorkingIndicator(pi, ctx);

		ctx.ui.setFooter((tui, _theme, footerData) => {
			const unsubscribeBranch = footerData.onBranchChange(() => {
				tui.requestRender();
				refresh();
			});

			ctx.ui.setWidget(
				"minimal-ui-statusline",
				(widgetTui, theme) => {
					requestRender = () => widgetTui.requestRender();
					return {
						invalidate() {},
						render(width: number): string[] {
							return renderStatusline(pi, ctx, footerData, theme, width);
						},
					};
				},
				{ placement: "aboveEditor" },
			);

			return {
				dispose() {
					unsubscribeBranch();
					ctx.ui.setWidget("minimal-ui-statusline", undefined);
					requestRender = undefined;
				},
				invalidate() {},
				render(): string[] {
					return [];
				},
			};
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setWorkingIndicator();
		ctx.ui.setWorkingMessage();
	});

	// Pi has no dedicated thinking-level change event, but `before_agent_start`
	// fires before each user submission's agent loop and the loader is
	// reconstructed at `agent_start` using the current indicator options. By
	// regenerating here we pick up any thinking-level change the user made
	// between turns, so the spinner gradient stays in sync with the header.
	pi.on("before_agent_start", (_event, ctx) => {
		applyWorkingIndicator(pi, ctx);
		refresh();
	});

	pi.on("model_select", (_event, ctx) => {
		applyWorkingIndicator(pi, ctx);
		refresh();
	});
	pi.on("message_update", refresh);
	pi.on("message_end", refresh);
}
