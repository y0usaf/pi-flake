import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AssistantMessage } from "@mariozechner/pi-ai";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const UI_MIN_WIDTH = 24;
const BORDER_FILL = "─";
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;
const ANSI_FG_RESET = "\x1b[39m";

const EXTENSION_KEY = "pi-minimal-editor";
const LEGACY_EXTENSION_KEY = "pi-minimal-ui";

type Theme = ExtensionContext["ui"]["theme"];
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type HexColor = string;
type ThinkingColorOverrides = Partial<Record<ThinkingLevel, HexColor>>;
type ColorOverrides = { pi?: HexColor; thinking?: ThinkingColorOverrides };
type MinimalEditorSettings = { colors?: ColorOverrides };
type FooterData = {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	onBranchChange(callback: () => void): () => void;
};

const THINKING_COLOR: Record<ThinkingLevel, Parameters<Theme["fg"]>[0]> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
};

let colorOverrides: ColorOverrides = {};

function loadJsonSafe(path: string): Record<string, unknown> | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function extractExtensionSettings(root: Record<string, unknown> | undefined, key: string): MinimalEditorSettings | undefined {
	const extSettings = root?.extensionSettings;
	if (!extSettings || typeof extSettings !== "object") return undefined;
	const entry = (extSettings as Record<string, unknown>)[key];
	return entry && typeof entry === "object" ? (entry as MinimalEditorSettings) : undefined;
}

function mergeColorOverrides(global: ColorOverrides | undefined, project: ColorOverrides | undefined): ColorOverrides {
	if (!global && !project) return {};
	const pi = project?.pi ?? global?.pi;
	const thinking: ThinkingColorOverrides = { ...global?.thinking, ...project?.thinking };
	return {
		...(pi ? { pi } : {}),
		...(Object.keys(thinking).length > 0 ? { thinking } : {}),
	};
}

function loadColorOverrides(cwd: string): ColorOverrides {
	const globalRoot = loadJsonSafe(join(homedir(), ".pi", "agent", "settings.json"));
	const projectRoot = loadJsonSafe(join(cwd, ".pi", "settings.json"));
	const globalCfg = extractExtensionSettings(globalRoot, EXTENSION_KEY)?.colors ?? extractExtensionSettings(globalRoot, LEGACY_EXTENSION_KEY)?.colors;
	const projectCfg = extractExtensionSettings(projectRoot, EXTENSION_KEY)?.colors ?? extractExtensionSettings(projectRoot, LEGACY_EXTENSION_KEY)?.colors;
	return mergeColorOverrides(globalCfg, projectCfg);
}

function reloadColorOverrides(cwd: string): void {
	colorOverrides = loadColorOverrides(cwd);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | undefined {
	const match = hex.trim().match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
	if (!match) return undefined;
	const value = match[1]!;
	if (value.length === 3) {
		return {
			r: Number.parseInt(value[0]! + value[0]!, 16),
			g: Number.parseInt(value[1]! + value[1]!, 16),
			b: Number.parseInt(value[2]! + value[2]!, 16),
		};
	}
	return {
		r: Number.parseInt(value.slice(0, 2), 16),
		g: Number.parseInt(value.slice(2, 4), 16),
		b: Number.parseInt(value.slice(4, 6), 16),
	};
}

function overrideFgAnsi(hex: HexColor | undefined): string | undefined {
	const rgb = hex ? hexToRgb(hex) : undefined;
	return rgb ? `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m` : undefined;
}

function wrapFg(text: string, ansi: string): string {
	return `${ansi}${text}${ANSI_FG_RESET}`;
}

function piColored(theme: Theme, text: string): string {
	const ansi = overrideFgAnsi(colorOverrides.pi);
	return ansi ? wrapFg(text, ansi) : theme.fg("accent", text);
}

function thinkingAnsi(theme: Theme, level: ThinkingLevel): string {
	return overrideFgAnsi(colorOverrides.thinking?.[level]) ?? theme.getFgAnsi(THINKING_COLOR[level]);
}

function thinkingColored(theme: Theme, level: ThinkingLevel, text: string): string {
	const ansi = overrideFgAnsi(colorOverrides.thinking?.[level]);
	return ansi ? wrapFg(text, ansi) : theme.fg(THINKING_COLOR[level], text);
}

function currentThinkingLevel(pi: ExtensionAPI, ctx: ExtensionContext): ThinkingLevel | undefined {
	if (!ctx.model?.reasoning) return undefined;
	const level = pi.getThinkingLevel();
	return level && level in THINKING_COLOR ? (level as ThinkingLevel) : undefined;
}

function borderChrome(theme: Theme, thinking: ThinkingLevel | undefined, text: string): string {
	return wrapFg(text, thinkingAnsi(theme, thinking ?? "off"));
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
	return visibleWidth(candidate) <= maxWidth ? candidate : truncateToWidth(`…${tail}`, maxWidth, "");
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

function locationParts(ctx: ExtensionContext, branch: string | null, theme: Theme, maxPathWidth: number): string[] {
	const sessionName = ctx.sessionManager.getSessionName();
	return [
		piColored(theme, tailPath(shortPath(ctx.sessionManager.getCwd()), maxPathWidth)),
		branch ? theme.fg("dim", ` ${branch}`) : undefined,
		sessionName ? theme.fg("dim", sessionName) : undefined,
	].filter((part): part is string => Boolean(part));
}

function stats(ctx: ExtensionContext, theme: Theme): string {
	const usage = usageFromSession(ctx);
	const context = ctx.getContextUsage();
	const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const contextPercentValue = context?.percent ?? 0;
	const contextPercent = context?.percent == null ? "?" : context.percent.toFixed(1);
	const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
	const contextStyle = contextPercentValue > 90 ? "error" : contextPercentValue > 70 ? "warning" : "dim";

	return joinStyled(
		[
			usage.input ? theme.fg("dim", `↑${compactNumber(usage.input)}`) : undefined,
			usage.output ? theme.fg("dim", `↓${compactNumber(usage.output)}`) : undefined,
			usage.cacheRead ? theme.fg("dim", `R${compactNumber(usage.cacheRead)}`) : undefined,
			usage.cacheWrite ? theme.fg("dim", `W${compactNumber(usage.cacheWrite)}`) : undefined,
			usage.cost || usingSubscription ? theme.fg("dim", `$${usage.cost.toFixed(3)}${usingSubscription ? " sub" : ""}`) : undefined,
			theme.fg(contextStyle, `${contextPercent}%/${compactNumber(contextWindow)}`),
		],
		" ",
	);
}

function extensionStatuses(footerData: FooterData): string[] {
	return [...footerData.getExtensionStatuses().entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, value]) => sanitize(value))
		.filter(Boolean);
}

function boxed(theme: Theme, thinking: ThinkingLevel | undefined, parts: Array<string | undefined>): string | undefined {
	const content = parts.filter((part): part is string => Boolean(part));
	if (content.length === 0) return undefined;
	const separator = borderChrome(theme, thinking, "][");
	return `${borderChrome(theme, thinking, "[")}${content.join(separator)}${borderChrome(theme, thinking, "]")}`;
}

function borderBoxes(pi: ExtensionAPI, ctx: ExtensionContext, footerData: FooterData, theme: Theme, width: number): { top: string[]; bottom: string[] } {
	const thinking = currentThinkingLevel(pi, ctx);
	const model = ctx.model ? theme.fg("dim", `${ctx.model.provider}/${ctx.model.id}`) : theme.fg("dim", "no-model");
	return {
		top: [
			boxed(theme, thinking, [piColored(theme, "pi"), ...locationParts(ctx, footerData.getGitBranch(), theme, Math.max(4, Math.floor(width * 0.35)))]),
			boxed(theme, thinking, [stats(ctx, theme)]),
		].filter((box): box is string => Boolean(box)),
		bottom: [
			boxed(theme, thinking, [model, thinking ? thinkingColored(theme, thinking, thinking) : undefined]),
			...extensionStatuses(footerData).map((status) => boxed(theme, thinking, [theme.fg("dim", status)])).filter((box): box is string => Boolean(box)),
		],
	};
}

function padLine(line: string, width: number): string {
	const clipped = truncateToWidth(line, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function renderBorderLine(boxes: string[], theme: Theme, thinking: ThinkingLevel | undefined, width: number): string {
	if (boxes.length === 0) return borderChrome(theme, thinking, BORDER_FILL.repeat(width));

	const fill = borderChrome(theme, thinking, BORDER_FILL);
	const fixedWidth = boxes.reduce((sum, box) => sum + visibleWidth(box), 0);
	const gapCount = Math.max(1, boxes.length - 1);
	const remaining = width - fixedWidth;

	if (remaining < gapCount) return padLine(boxes.join(fill), width);

	const baseGap = Math.floor(remaining / gapCount);
	let extra = remaining % gapCount;
	let line = boxes[0] ?? "";
	for (const box of boxes.slice(1)) {
		const gapWidth = baseGap + (extra > 0 ? 1 : 0);
		extra = Math.max(0, extra - 1);
		line += fill.repeat(gapWidth) + box;
	}
	if (boxes.length === 1) line += fill.repeat(remaining);
	return padLine(line, width);
}

function renderBorders(pi: ExtensionAPI, ctx: ExtensionContext, footerData: FooterData, theme: Theme, width: number): { top: string; bottom: string } {
	const boxes = borderBoxes(pi, ctx, footerData, theme, width);
	const thinking = currentThinkingLevel(pi, ctx);
	return {
		top: renderBorderLine(boxes.top, theme, thinking, width),
		bottom: renderBorderLine(boxes.bottom, theme, thinking, width),
	};
}

function isEditorBorder(line: string): boolean {
	const text = stripAnsi(line).trim();
	return /^─+$/.test(text) || /^─── [↑↓] \d+ more ─*$/.test(text);
}

class MinimalEditor extends CustomEditor {
	constructor(
		private readonly getBorders: (width: number) => { top: string; bottom: string },
		...args: ConstructorParameters<typeof CustomEditor>
	) {
		super(...args);
	}

	render(width: number): string[] {
		if (width < 4) return super.render(width);

		const outerWidth = width <= UI_MIN_WIDTH ? Math.max(1, width) : width;
		const leftMargin = " ".repeat(Math.max(0, Math.floor((width - outerWidth) / 2)));
		const lines = super.render(outerWidth);
		if (lines.length === 0) return lines;

		const bottomIndex = lines.findIndex((line, index) => index > 0 && isEditorBorder(line));
		const body = bottomIndex >= 0 ? [...lines.slice(1, bottomIndex), ...lines.slice(bottomIndex + 1)] : lines.slice(1);
		const borders = this.getBorders(outerWidth);
		return [borders.top, ...body, borders.bottom].map((line) => leftMargin + line);
	}
}

export default function minimalEditor(pi: ExtensionAPI) {
	let requestRender: (() => void) | undefined;
	const refresh = () => requestRender?.();

	pi.on("session_start", (_event, ctx) => {
		reloadColorOverrides(ctx.cwd);

		ctx.ui.setFooter((tui, theme, footerData: FooterData) => {
			requestRender = () => tui.requestRender();
			const unsubscribeBranch = footerData.onBranchChange(() => {
				tui.requestRender();
				refresh();
			});

			ctx.ui.setEditorComponent(
				(editorTui, editorTheme, keybindings) =>
					new MinimalEditor(
						(width) => renderBorders(pi, ctx, footerData, theme, width),
						editorTui,
						editorTheme,
						keybindings,
						{ paddingX: 0 },
					),
			);

			return {
				dispose() {
					unsubscribeBranch();
					ctx.ui.setEditorComponent(undefined);
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
		ctx.ui.setFooter(undefined);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		reloadColorOverrides(ctx.cwd);
		refresh();
	});
	pi.on("model_select", (_event, ctx) => {
		reloadColorOverrides(ctx.cwd);
		refresh();
	});
	pi.on("message_update", refresh);
	pi.on("message_end", refresh);
}
