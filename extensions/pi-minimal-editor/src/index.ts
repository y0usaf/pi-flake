import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type Theme = ExtensionContext["ui"]["theme"];
type Level = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type Footer = {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	onBranchChange(callback: () => void): () => void;
};

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;
const COLOR: Record<Level, Parameters<Theme["fg"]>[0]> = {
	off: "thinkingOff", minimal: "thinkingMinimal", low: "thinkingLow", medium: "thinkingMedium", high: "thinkingHigh", xhigh: "thinkingXhigh",
};
const compact = (n: number) => n < 1e3 ? `${n}` : n < 1e4 ? `${(n / 1e3).toFixed(1)}K` : n < 1e6 ? `${Math.round(n / 1e3)}K` : n < 1e7 ? `${(n / 1e6).toFixed(1)}M` : n < 1e9 ? `${Math.round(n / 1e6)}M` : n < 1e10 ? `${(n / 1e9).toFixed(1)}B` : `${Math.round(n / 1e9)}B`;
const sanitize = (s: string) => s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x9d[^\x07\x9c]*(?:\x07|\x9c)/g, "").replace(/\x1b(?:P|_|\^)[\s\S]*?\x1b\\|[\x90\x9e\x9f][\s\S]*?\x9c/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[@-Z\\-_]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/ +/g, " ").trim();

function contextColor(pct: number, contextWindow: number): Parameters<Theme["fg"]>[0] | undefined {
	const reaches = (percent: number, tokens: number) => Number.isFinite(pct) && pct > 0 && (Number.isFinite(contextWindow) && contextWindow > 0 ? pct >= Math.min(percent, (tokens / contextWindow) * 100) : pct >= percent);
	return reaches(90, 500_000) ? "error" : reaches(70, 270_000) ? "thinkingHigh" : reaches(50, 150_000) ? "warning" : undefined;
}

function footerStats(ctx: ExtensionContext, theme: Theme): string {
	let input = 0, output = 0, read = 0, write = 0, cost = 0, premium = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		input += entry.message.usage?.input ?? 0;
		output += entry.message.usage?.output ?? 0;
		read += entry.message.usage?.cacheRead ?? 0;
		write += entry.message.usage?.cacheWrite ?? 0;
		cost += entry.message.usage?.cost?.total ?? 0;
		premium += (entry.message.usage as { premiumRequests?: number } | undefined)?.premiumRequests ?? 0;
	}
	const context = ctx.getContextUsage();
	const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const pct = context?.percent ?? 0;
	const pctText = context?.percent !== null ? `${pct.toFixed(1)}%/${compact(contextWindow)} (auto)` : `?/${compact(contextWindow)} (auto)`;
	const color = contextColor(pct, contextWindow);
	const sub = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
	const billing = [cost && `$${cost.toFixed(3)}`, Math.round((premium + Number.EPSILON) * 100) / 100 || undefined, sub && "(sub)"].filter(Boolean).map(x => typeof x === "number" ? `★ ${compact(x)}` : x).join(" ");
	return [input && `↑${compact(input)}`, output && `↓${compact(output)}`, read && `R${compact(read)}`, write && `W${compact(write)}`, billing, color ? theme.fg(color, pctText) : pctText].filter(Boolean).join(" ");
}


function borders(pi: ExtensionAPI, ctx: ExtensionContext, footer: Footer, theme: Theme, width: number) {
	const value = ctx.model?.reasoning ? pi.getThinkingLevel() : undefined;
	const level: Level = value && value in COLOR ? value as Level : "off";
	const color = COLOR[level], fill = theme.fg(color, "─");
	const box = (...parts: Array<string | undefined | false>) => parts.filter(Boolean).join(theme.fg("dim", " • ")) || undefined;
	const line = (boxes: string[]) => {
		const fixed = boxes.reduce((sum, part) => sum + visibleWidth(part), 0);
		const gap = Math.max(0, boxes.length < 2 ? width - fixed : Math.floor((width - fixed) / (boxes.length - 1)));
		const text = boxes.length ? boxes.join(fill.repeat(Math.max(1, gap))) + (boxes.length === 1 ? fill.repeat(gap) : "") : fill.repeat(width);
		const clipped = truncateToWidth(text, width, "…");
		return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	};

	const home = process.env.HOME || process.env.USERPROFILE;
	let cwd = ctx.sessionManager.getCwd();
	if (home && cwd.startsWith(home)) cwd = `~${cwd.slice(home.length)}`;
	const branch = footer.getGitBranch();
	if (branch) cwd += ` (${branch})`;
	if (cwd.length > width) {
		const half = Math.floor(width / 2) - 1;
		cwd = half > 1 ? `${cwd.slice(0, half)}…${cwd.slice(-(half - 1))}` : cwd.slice(0, Math.max(1, width));
	}

	return {
		top: line([box(theme.fg("dim", cwd)), box(theme.fg("dim", footerStats(ctx, theme)))].filter(Boolean) as string[]),
		bottom: line([
			box(theme.fg("dim", ctx.model?.id || "no-model"), ctx.model?.reasoning && level !== "off" && theme.fg(color, level)),
			...[...footer.getExtensionStatuses().entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => box(theme.fg("dim", sanitize(value)))),
		].filter(Boolean) as string[]),

	};
}

class MinimalEditor extends CustomEditor {
	constructor(private readonly getBorders: (width: number) => { top: string; bottom: string }, ...args: ConstructorParameters<typeof CustomEditor>) { super(...args); }
	render(width: number): string[] {
		const lines = super.render(width);
		if (width < 4 || !lines.length) return lines;
		const bottom = lines.findIndex((line, index) => index > 0 && /^─+$/.test(line.replace(ANSI, "").trim()));
		const chrome = this.getBorders(width);
		return [chrome.top, ...(bottom < 0 ? lines.slice(1) : [...lines.slice(1, bottom), ...lines.slice(bottom + 1)]), chrome.bottom];
	}
}

export default function minimalEditor(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => ctx.ui.setFooter((tui, theme, footer: Footer) => {
		const unsubscribe = footer.onBranchChange(() => tui.requestRender());
		ctx.ui.setEditorComponent((editorTui, editorTheme, keybindings) => new MinimalEditor((width) => borders(pi, ctx, footer, theme, width), editorTui, editorTheme, keybindings, { paddingX: 0 }));
		return { dispose: () => { unsubscribe(); ctx.ui.setEditorComponent(undefined); }, invalidate() {}, render: () => [] };
	}));
	pi.on("session_shutdown", (_event, ctx) => { ctx.ui.setEditorComponent(undefined); ctx.ui.setFooter(undefined); });
}
