import type { AssistantMessage } from "@mariozechner/pi-ai";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const UI_WIDTH_RATIO = 0.9;
const UI_MAX_WIDTH = 100;
const UI_MIN_WIDTH = 24;

const MIN_LOCATION_WIDTH = 8;
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;

function uiWidth(width: number): number {
	if (width <= UI_MIN_WIDTH) return Math.max(1, width);
	return Math.min(width, UI_MAX_WIDTH, Math.max(UI_MIN_WIDTH, Math.floor(width * UI_WIDTH_RATIO)));
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

function bracket(content: string, theme: ExtensionContext["ui"]["theme"]): string {
	return `${theme.fg("dim", "[")}${content}${theme.fg("dim", "]")}`;
}

function fitBracket(content: string, theme: ExtensionContext["ui"]["theme"], maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (maxWidth <= 2) return truncateToWidth(bracket(content, theme), maxWidth, "…");
	return bracket(truncateToWidth(content, maxWidth - 2, "…"), theme);
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
	const separator = theme.fg("dim", " · ");
	const separatorWidth = visibleWidth(" · ");
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

function renderExtensionStatuses(footerData: { getExtensionStatuses(): ReadonlyMap<string, string> }): string {
	return [...footerData.getExtensionStatuses().entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, value]) => sanitize(value))
		.filter(Boolean)
		.join(" ");
}

function renderModelInfo(pi: ExtensionAPI, ctx: ExtensionContext, theme: ExtensionContext["ui"]["theme"]): string {
	const separator = theme.fg("dim", " · ");
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no-model";
	const thinking = ctx.model?.reasoning ? pi.getThinkingLevel() : undefined;
	return joinStyled([theme.fg("dim", model), thinking ? theme.fg("accent", thinking) : undefined], separator);
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

function packGroups(groups: string[], width: number): string[] {
	const lines: string[] = [];
	let current = "";

	for (const rawGroup of groups) {
		const group = truncateToWidth(rawGroup, width, "…");
		if (!group) continue;

		if (!current) {
			current = group;
			continue;
		}

		const next = `${current} ${group}`;
		if (visibleWidth(next) <= width) {
			current = next;
		} else {
			lines.push(current);
			current = group;
		}
	}

	if (current) lines.push(current);
	return lines.length > 0 ? lines : [""];
}

function renderStatusGroups(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	footerData: { getGitBranch(): string | null; getExtensionStatuses(): ReadonlyMap<string, string> },
	theme: ExtensionContext["ui"]["theme"],
	width: number,
): string[] {
	const branch = footerData.getGitBranch();
	const statuses = renderExtensionStatuses(footerData);

	return [
		fitBracket(renderLocation(ctx, branch, theme, Math.max(1, width - 2)), theme, width),
		fitBracket(renderStats(ctx, theme), theme, width),
		fitBracket(renderModelInfo(pi, ctx, theme), theme, width),
		statuses ? fitBracket(statuses, theme, width) : undefined,
	].filter((group): group is string => Boolean(group));
}

function renderStatusline(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	footerData: { getGitBranch(): string | null; getExtensionStatuses(): ReadonlyMap<string, string> },
	theme: ExtensionContext["ui"]["theme"],
	width: number,
): string[] {
	const innerWidth = uiWidth(width);
	return packGroups(renderStatusGroups(pi, ctx, footerData, theme, innerWidth), innerWidth).map((line) =>
		centerLine(padLine(line, innerWidth), innerWidth, width),
	);
}

function isEditorBorder(line: string): boolean {
	const text = stripAnsi(line).trim();
	return /^─+$/.test(text) || /^─── [↑↓] \d+ more ─*$/.test(text);
}

function scrollLabel(line: string): string | undefined {
	return stripAnsi(line).match(/[↑↓] \d+ more/)?.[0];
}

class MinimalBoxEditor extends CustomEditor {
	render(width: number): string[] {
		if (width < 4) return super.render(width);

		const outerWidth = uiWidth(width);
		const innerWidth = Math.max(1, outerWidth - 2);
		const leftMargin = " ".repeat(Math.max(0, Math.floor((width - outerWidth) / 2)));
		const lines = super.render(innerWidth);
		if (lines.length === 0) return lines;

		const bottomIndex = lines.findIndex((line, index) => index > 0 && isEditorBorder(line));
		const topLabel = scrollLabel(lines[0] ?? "");
		const bottomLabel = bottomIndex >= 0 ? scrollLabel(lines[bottomIndex] ?? "") : undefined;
		const body = bottomIndex >= 0 ? [...lines.slice(1, bottomIndex), ...lines.slice(bottomIndex + 1)] : lines;

		return [
			leftMargin + this.renderBorder("┌", "┐", innerWidth, topLabel),
			...body.map((line) => leftMargin + this.renderBodyLine(line, innerWidth)),
			leftMargin + this.renderBorder("└", "┘", innerWidth, bottomLabel),
		];
	}

	private renderBorder(left: string, right: string, innerWidth: number, label?: string): string {
		const rawLabel = label ? ` ${label} ` : "";
		const visibleLabel = truncateToWidth(rawLabel, innerWidth, "");
		const fill = "─".repeat(Math.max(0, innerWidth - visibleWidth(visibleLabel)));
		return this.borderColor(`${left}${visibleLabel}${fill}${right}`);
	}

	private renderBodyLine(line: string, innerWidth: number): string {
		const clipped = truncateToWidth(line, innerWidth, "");
		const padded = `${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}`;
		return `${this.borderColor("│")}${padded}${this.borderColor("│")}`;
	}
}

export default function minimalUi(pi: ExtensionAPI) {
	let requestRender: (() => void) | undefined;
	const refresh = () => requestRender?.();

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new MinimalBoxEditor(tui, theme, keybindings, { paddingX: 1 }));

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
	});

	pi.on("model_select", refresh);
	pi.on("message_update", refresh);
	pi.on("message_end", refresh);
}
