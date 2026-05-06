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
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
};
const compact = (n: number) => (n < 1000 ? `${n}` : n < 10000 ? `${(n / 1000).toFixed(1)}k` : n < 1000000 ? `${Math.round(n / 1000)}k` : `${(n / 1000000).toFixed(1)}M`);

function footerStats(ctx: ExtensionContext, theme: Theme): string {
	let input = 0, output = 0, read = 0, write = 0, cost = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		input += entry.message.usage?.input ?? 0;
		output += entry.message.usage?.output ?? 0;
		read += entry.message.usage?.cacheRead ?? 0;
		write += entry.message.usage?.cacheWrite ?? 0;
		cost += entry.message.usage?.cost?.total ?? 0;
	}
	const context = ctx.getContextUsage();
	const pct = context?.percent ?? 0;
	const sub = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
	return [
		input && `↑${compact(input)}`,
		output && `↓${compact(output)}`,
		read && `R${compact(read)}`,
		write && `W${compact(write)}`,
		(cost || sub) && `$${cost.toFixed(3)}${sub ? " sub" : ""}`,
		theme.fg(pct > 90 ? "error" : pct > 70 ? "warning" : "dim", `${context?.percent == null ? "?" : pct.toFixed(1)}%/${compact(context?.contextWindow ?? ctx.model?.contextWindow ?? 0)}`),
	].filter(Boolean).join(" ");
}

function borders(pi: ExtensionAPI, ctx: ExtensionContext, footer: Footer, theme: Theme, width: number) {
	const value = ctx.model?.reasoning ? pi.getThinkingLevel() : undefined;
	const level: Level = value && value in COLOR ? (value as Level) : "off";
	const fill = theme.fg(COLOR[level], "─");
	const box = (...parts: Array<string | undefined | false>) => {
		const text = parts.filter(Boolean).join(theme.fg(COLOR[level], "]["));
		return text ? `${theme.fg(COLOR[level], "[")}${text}${theme.fg(COLOR[level], "]")}` : undefined;
	};
	const line = (boxes: string[]) => {
		const fixed = boxes.reduce((sum, box) => sum + visibleWidth(box), 0);
		const gap = Math.max(0, boxes.length < 2 ? width - fixed : Math.floor((width - fixed) / (boxes.length - 1)));
		const text = boxes.length ? boxes.join(fill.repeat(Math.max(1, gap))) + (boxes.length === 1 ? fill.repeat(gap) : "") : fill.repeat(width);
		const clipped = truncateToWidth(text, width, "…");
		return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	};

	const home = process.env.HOME || process.env.USERPROFILE;
	let cwd = ctx.sessionManager.getCwd();
	if (home && cwd.startsWith(home)) cwd = `~${cwd.slice(home.length)}`;
	const branch = footer.getGitBranch();
	const session = ctx.sessionManager.getSessionName();
	if (branch) cwd += ` (${branch})`;
	if (session) cwd += ` • ${session}`;

	return {
		top: line([box(truncateToWidth(theme.fg("dim", cwd), Math.floor(width * 0.45), theme.fg("dim", "..."))), box(theme.fg("dim", footerStats(ctx, theme)))].filter((x): x is string => Boolean(x))),
		bottom: line([
			box(theme.fg("dim", ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no-model"), ctx.model?.reasoning && theme.fg(COLOR[level], level)),
			...[...footer.getExtensionStatuses().entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => box(theme.fg("dim", v.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim()))),
		].filter((x): x is string => Boolean(x))),
	};
}

class MinimalEditor extends CustomEditor {
	constructor(private readonly getBorders: (width: number) => { top: string; bottom: string }, ...args: ConstructorParameters<typeof CustomEditor>) { super(...args); }
	render(width: number): string[] {
		const lines = super.render(width);
		if (width < 4 || lines.length === 0) return lines;
		const bottom = lines.findIndex((text, index) => index > 0 && /^─+$/.test(text.replace(ANSI, "").trim()));
		const chrome = this.getBorders(width);
		return [chrome.top, ...(bottom >= 0 ? [...lines.slice(1, bottom), ...lines.slice(bottom + 1)] : lines.slice(1)), chrome.bottom];
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
