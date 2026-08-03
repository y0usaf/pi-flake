/**
 * Rendering helpers adapted from nicobailon/pi-subagents (MIT) —
 * @extensions/nicobailon_pi-subagents/ — and pi coding-agent's own tool renderers.
 */
import { homedir } from "node:os";
import { Container, Markdown, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import { getMarkdownTheme, keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { UNABLE_VALUE, type ContractAnswer } from "./contract.js";
import type { ActivityItem, AgentToolDetails } from "./state.js";

/**
 * Accumulated per-agent token/cost sums, shared by the backend usage
 * collector and the TUI header.
 */
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/**
 * Strip terminal control sequences from child-controlled text before it
 * reaches the TUI: OSC sequences (ESC ] ... ST), CSI sequences, and stray C0
 * controls except tab/newline. Child reports and tool args are untrusted.
 */
export function stripControlSequences(value: string): string {
	return value
		.replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C)/g, "")
		.replace(/[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ansiStylePattern = /\x1b\[[0-9;]*m/y;

/**
 * Truncate a line to maxWidth, preserving ANSI styling through the ellipsis.
 *
 * pi-tui's truncateToWidth adds \x1b[0m before ellipsis which resets all
 * styling, causing background color bleed in the TUI. This implementation
 * tracks active ANSI styles and re-applies them before the ellipsis, and never
 * emits a bare \x1b[0m on its own.
 *
 * Uses Intl.Segmenter for proper Unicode/emoji handling (not char-by-char).
 * A trailing newline is trimmed before truncation (multi-line previews are
 * sliced to their first line upstream, but a single hard newline must not
 * consume the budget).
 */
export function truncLine(text: string, maxWidth: number): string {
	if (text.endsWith("\n")) text = text.slice(0, -1);
	if (visibleWidth(text) <= maxWidth) return text;

	const targetWidth = maxWidth - 1;
	let result = "";
	let currentWidth = 0;
	let activeStyles: string[] = [];
	let i = 0;

	while (i < text.length) {
		ansiStylePattern.lastIndex = i;
		const ansiMatch = ansiStylePattern.exec(text);
		if (ansiMatch) {
			const code = ansiMatch[0];
			result += code;

			if (code === "\x1b[0m" || code === "\x1b[m") {
				activeStyles = [];
			} else {
				activeStyles.push(code);
			}
			i += code.length;
			continue;
		}

		let end = text.indexOf("\x1b[", i);
		if (end === i) end = text.indexOf("\x1b[", i + 2);
		if (end === -1) end = text.length;
		const textPortion = text.slice(i, end);
		for (const seg of segmenter.segment(textPortion)) {
			const grapheme = seg.segment;
			const graphemeWidth = visibleWidth(grapheme);

			if (currentWidth + graphemeWidth > targetWidth) {
				return result + activeStyles.join("") + "…";
			}

			result += grapheme;
			currentWidth += graphemeWidth;
		}
		i = end;
	}

	return result + activeStyles.join("") + "…";
}

/** Bold via the theme when it provides bold, plain fallback otherwise. */
export function themeBold(theme: Theme, text: string): string {
	return theme.bold?.(text) ?? text;
}

/** Join stat parts with dimmed middots, pi-subagents style. */
export function statJoin(theme: Theme, parts: string[]): string {
	return parts.filter(Boolean).map((part) => theme.fg("dim", part)).join(` ${theme.fg("dim", "·")} `);
}

const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATIC_RUNNING_GLYPH = "●";

/** Deterministic spinner seed from state counters; undefined when nothing to seed from. */
export function runningSeed(...values: Array<number | undefined>): number | undefined {
	let seed: number | undefined;
	for (const value of values) {
		if (value === undefined || !Number.isFinite(value)) continue;
		seed = (seed ?? 0) + Math.trunc(value);
	}
	return seed;
}

/** Braille spinner frame for a seed; a static ● when no seed is available. */
export function runningGlyph(seed?: number): string {
	if (seed === undefined) return STATIC_RUNNING_GLYPH;
	return RUNNING_FRAMES[Math.abs(seed) % RUNNING_FRAMES.length]!;
}

/** Compact human-readable token count: 456, 12.3k, 150k. */
export function formatTokens(n: number): string {
	return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

/** Compact human-readable duration: 250ms, 4.2s, 3m12s. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

/**
 * Single-string usage summary: `↑12.3k · ↓456 · R·W · $0.0042`.
 * Empty when there is no usage. The parts are statJoin-friendly, so a caller
 * can either splice them into a statJoin list or use the joined string as-is.
 */
export function formatUsage(usage: Usage | undefined): string {
	if (!usage) return "";
	const parts: string[] = [];
	if (usage.input > 0) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output > 0) parts.push(`↓${formatTokens(usage.output)}`);
	const cache = [usage.cacheRead > 0 ? "R" : "", usage.cacheWrite > 0 ? "W" : ""].filter(Boolean).join("·");
	if (cache) parts.push(cache);
	if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" · ");
}

/** Shorten a path by replacing the home directory with ~. */
export function shortenPath(p: string): string {
	const home = homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * Format a tool call for the TUI. Child-controlled args are sanitized with
 * stripControlSequences first. Styling follows pi-subagents: muted verb,
 * accent path, warning range, toolOutput payload.
 */
export function formatToolCall(name: string, args: Record<string, unknown>, theme: Theme, expanded: boolean): string {
	switch (name) {
		case "bash": {
			const command = typeof args.command === "string" ? stripControlSequences(args.command) : "";
			const maxLength = expanded ? 240 : 60;
			return theme.fg("muted", "$ ") + theme.fg("toolOutput", command.slice(0, maxLength) + (command.length > maxLength ? "..." : ""));
		}
		case "read": {
			const p = shortenPath(typeof args.path === "string" ? stripControlSequences(args.path) : "...");
			const off = args.offset as number | undefined;
			const lim = args.limit as number | undefined;
			let range = "";
			if (off || lim) range = theme.fg("warning", `:${off ?? 1}${lim ? `-${(off ?? 1) + lim - 1}` : ""}`);
			return theme.fg("muted", "read ") + theme.fg("accent", p) + range;
		}
		case "write": {
			const p = shortenPath(typeof args.path === "string" ? stripControlSequences(args.path) : "...");
			let s = theme.fg("muted", "write ") + theme.fg("accent", p);
			const content = typeof args.content === "string" ? args.content : "";
			const lines = content ? content.split("\n").length : 0;
			if (lines > 0) s += theme.fg("dim", ` (${lines} lines)`);
			return s;
		}
		case "edit": {
			const p = shortenPath(typeof args.path === "string" ? stripControlSequences(args.path) : "...");
			return theme.fg("muted", "edit ") + theme.fg("accent", p);
		}
		case "report": {
			const message = typeof args.message === "string" ? stripControlSequences(args.message) : "";
			return theme.fg("muted", "report ") + theme.fg("toolOutput", `"${message}"`);
		}
		case "ask_parent": {
			const count = Array.isArray(args.questions) ? args.questions.length : 0;
			return theme.fg("muted", "ask_parent ") + theme.fg("toolOutput", `(${count} question${count === 1 ? "" : "s"})`);
		}
		case "submit_answers": {
			const count = Array.isArray(args.answers) ? args.answers.length : 0;
			return theme.fg("muted", "submit_answers ") + theme.fg("toolOutput", `(${count} answer${count === 1 ? "" : "s"})`);
		}
		default: {
			const s = JSON.stringify(args);
			const maxLength = expanded ? 160 : 50;
			return theme.fg("muted", `${name} `) + theme.fg("toolOutput", s.slice(0, maxLength) + (s.length > maxLength ? "..." : ""));
		}
	}
}

// ---------------------------------------------------------------------------
// Agent renderers (TUI)
// ---------------------------------------------------------------------------

const MAX_RENDERED_ACTIVITY = 8;

/** Terminal-relative width budget for single-line renders; indent subtracts from it. */
export function termBudget(indent = 0): number {
	return Math.max(24, (process.stdout.columns || 120) - 6 - indent);
}

// ---------------------------------------------------------------------------
// Renderers (agent)
// ---------------------------------------------------------------------------

export function renderAgentCall(
	toolLabel: string,
	args: { id?: string; system_prompt?: string; task?: string; contract?: unknown; panel?: { size?: number; models?: string[] } },
	theme: Theme,
) {
	const id = args.id || "...";
	const taskText = stripControlSequences(args.task || "...");
	const preview = truncLine(taskText, termBudget(2));
	let text = theme.fg("toolTitle", theme.bold(`${toolLabel} `)) + theme.fg("accent", id);
	if (args.panel) text += theme.fg("muted", ` · panel ${args.panel.size ?? args.panel.models?.length ?? "?"}`);
	text += "\n  " + theme.fg("dim", preview);
	text += formatQuestionLines(args.contract, theme, termBudget(2));
	return new Text(text, 0, 0);
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * "N actions · N reports · model · usage" — pi-subagents statJoin composition.
 * Report count is omitted when undefined or zero; usage only when present.
 */
function agentStats(model: string | undefined, activityCount: number, reportCount: number | undefined, usage: Usage | undefined, theme: Theme): string {
	const parts = [plural(activityCount, "action")];
	if (reportCount !== undefined && reportCount > 0) parts.push(plural(reportCount, "report"));
	if (model) parts.push(model);
	if (usage) parts.push(formatUsage(usage));
	return statJoin(theme, parts);
}

function formatQuestionLines(questions: unknown, theme: Theme, limit?: number): string {
	if (!Array.isArray(questions)) return "";
	let text = "";
	for (const question of questions) {
		if (!question || typeof question !== "object" || typeof (question as { prompt?: unknown }).prompt !== "string") continue;
		const prompt = (question as { prompt: string }).prompt;
		if (prompt.length === 0) continue;
		const candidate = question as { id?: unknown; label?: unknown };
		const id = typeof candidate.id === "string" ? candidate.id : typeof candidate.label === "string" ? candidate.label : undefined;
		const shown = limit === undefined ? stripControlSequences(prompt) : truncLine(stripControlSequences(prompt), limit);
		text += "\n  " + theme.fg("warning", "?") + (id ? " " + theme.fg("accent", stripControlSequences(id)) : "") + " " + theme.fg("toolOutput", shown);
	}
	return text;
}

function formatAnswerLines(answers: ContractAnswer[], theme: Theme, limit?: number): string {
	let text = "";
	for (const answer of answers) {
		const punted = answer.value === UNABLE_VALUE;
		const shownRaw = stripControlSequences(punted ? "unable to determine" : answer.label);
		const shown = limit === undefined ? shownRaw : truncLine(shownRaw, limit);
		const mark = punted ? theme.fg("warning", "◌") : theme.fg("success", "•");
		text += "\n  " + mark + " " + theme.fg("accent", answer.id) + (answer.wasCustom ? theme.fg("dim", " ✎ ") : " ") + theme.fg("toolOutput", shown);
	}
	return text;
}

export function formatAgentAnswerLines(answers: unknown, theme: Theme, limit?: number): string {
	if (!Array.isArray(answers)) return "";
	const mapped: ContractAnswer[] = [];
	for (const answer of answers) {
		if (!answer || typeof answer !== "object" || typeof (answer as { id?: unknown }).id !== "string") continue;
		const item = answer as { id: string; value?: unknown };
		const value = typeof item.value === "string" ? item.value : "";
		mapped.push({ id: item.id, value, label: value, wasCustom: false });
	}
	return formatAnswerLines(mapped, theme, limit);
}
function activityIcon(item: ActivityItem, theme: Theme): string {
	if (item.type === "report") return theme.fg("warning", "↑");
	if (item.type === "tool_start") return theme.fg("accent", "→");
	if (item.type === "text") return theme.fg("dim", "·");
	return theme.fg("success", "✓");
}

function formatActivityTail(activity: ActivityItem[], theme: Theme): string {
	const visible = activity.slice(-MAX_RENDERED_ACTIVITY);
	const skipped = activity.length - visible.length;
	const budget = termBudget(2);
	let text = "";
	if (skipped > 0) text += "\n" + truncLine(`  ⎿  ${theme.fg("muted", `... ${skipped} earlier`)}`, budget);
	for (const item of visible) {
		text += "\n" + truncLine(`  ⎿  ${activityIcon(item, theme)} ${theme.fg("dim", item.label)}`, budget);
	}
	return text;
}

function clearSpinner(context: any): void {
	if (context.state._spinnerInterval) {
		clearInterval(context.state._spinnerInterval);
		context.state._spinnerInterval = null;
	}
}

export function renderAgentResult(
	result: { content: any[]; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: any,
) {
	const details = (result.details && typeof result.details === "object" && "childId" in result.details)
		? result.details as AgentToolDetails
		: undefined;

	if (!details) {
		clearSpinner(context);
		const t = result.content[0];
		return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
	}

	const { expanded, isPartial } = options;

	// -- panel summary --
	const panel = details.panel;
	const panelWellFormed = panel && Array.isArray(panel.members) && panel.members.every((member) =>
		member && typeof member.id === "string" && typeof member.model === "string" && Array.isArray(member.reports) && member.reports.every((report) => typeof report === "string") &&
		(member.answers === undefined || Array.isArray(member.answers) && member.answers.every((answer) => answer && typeof answer.id === "string" && typeof answer.value === "string" && (answer.label === undefined || typeof answer.label === "string"))),
	) && panel.tally && Array.isArray(panel.tally.questions) && panel.tally.questions.every((question) =>
		question && typeof question.questionId === "string" && typeof question.prompt === "string" && typeof question.freeText === "boolean" && typeof question.unanimous === "boolean" && Array.isArray(question.groups) && question.groups.every((group) =>
			group && typeof group.value === "string" && typeof group.label === "string" && typeof group.count === "number" && Array.isArray(group.memberIds) && group.memberIds.every((id) => typeof id === "string"),
		),
	) && typeof panel.tally.disagreementCount === "number";
	if (panelWellFormed) {
		const icon = theme.fg("success", "✓");
		const header = `${icon} ${theme.fg("toolTitle", theme.bold(stripControlSequences(details.childId)))} · panel ${panel.members.length} · ${panel.tally.disagreementCount} disagreement(s) · ${new Set(panel.members.map((m) => stripControlSequences(m.model))).size} models`;
		const lines = panel.tally.questions.map((q) => {
				const mark = q.freeText ? theme.fg("warning", "◌") : q.unanimous ? theme.fg("success", "•") : theme.fg("warning", "⚠");
				const summary = q.groups.map((g) => `${stripControlSequences(g.label)} (${g.count})`).join(" vs ");
				return `  ${mark} ${theme.fg("accent", truncLine(stripControlSequences(q.prompt), termBudget(2)))} — ${q.freeText ? "free-text — compare manually, not a consensus" : q.unanimous ? "unanimous" : "split"}: ${summary}`;
			});
		if (!expanded) return new Text([header, ...lines].join("\n"), 0, 0);
		const container = new Container();
		container.addChild(new Text(header, 0, 0));
		for (const q of panel.tally.questions) {
			const mark = q.freeText ? theme.fg("warning", "◌") : q.unanimous ? theme.fg("success", "•") : theme.fg("warning", "⚠");
			container.addChild(new Text(`  ${mark} ${theme.fg("accent", stripControlSequences(q.prompt))}`, 0, 0));
			for (const g of q.groups) for (const id of g.memberIds) {
				const member = panel.members.find((m) => m.id === id); const answer = member?.answers?.find((a) => a.id === q.questionId);
				container.addChild(new Text(`    ${stripControlSequences(id)} [${stripControlSequences(member?.model ?? "?")}]: ${stripControlSequences(answer ? (answer.label ?? answer.value) : "no answer")}`, 0, 0));
			}
		}
		for (const member of panel.members) for (const report of member.reports || []) container.addChild(new Text(`    ${stripControlSequences(member.id)}: ${stripControlSequences(report)}`, 0, 0));
		return container;
	}

	// -- still running: spinner + live activity feed --
	if (isPartial && !details.done) {
		if (!context.state._spinnerInterval) {
			context.state._spinnerFrame = 0;
			context.state._spinnerInterval = setInterval(() => {
				context.state._spinnerFrame = (context.state._spinnerFrame ?? 0) + 1;
				context.invalidate();
			}, 80);
		}

		const activity = details.activity;
		const seed = runningSeed(activity.length, details.reports?.length ?? 0, context.state._spinnerFrame ?? 0);
		const glyph = runningGlyph(seed);

		let text = theme.fg("accent", glyph) + " " + theme.fg("toolTitle", theme.bold(details.childId));
		text += " · " + agentStats(details.model, activity.length, undefined, details.usage, theme);
		text += formatActivityTail(activity, theme);
		if (!expanded) {
			text += "\n  " + theme.fg("accent", `Press ${keyText("app.tools.expand")} for live detail`);
		}

		const prev = context.lastComponent;
		const component = (prev instanceof Text) ? prev : new Text("", 0, 0);
		component.setText(text);
		return component;
	}

	clearSpinner(context);

	const hasError = !!details.error;
	const icon = hasError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const reports = details.reports || [];
	const activity = details.activity || [];
	const answers = details.answers ?? [];
	const contractTotal = details.contract?.length ?? 0;
	const pendingAsk = details.pendingAsk ?? [];
	const contractBadge = pendingAsk.length > 0
		? theme.fg("muted", ` · awaiting answers (${pendingAsk.length}q)`)
		: contractTotal > 0 ? theme.fg("muted", ` · ${answers.length}/${contractTotal} answered`) : "";

	// Expanded view
	if (expanded) {
		const container = new Container();
		let header = `${icon} ${theme.fg("toolTitle", theme.bold(details.childId))}`;
		header += " · " + agentStats(details.model, activity.length, reports.length, details.usage, theme);
		header += contractBadge;
		if (hasError) header += " " + theme.fg("error", `[error]`);
		container.addChild(new Text(header, 0, 0));

		if (hasError && details.error) {
			container.addChild(new Text(theme.fg("error", `Error: ${details.error}`), 0, 0));
		}

		if (activity.length > 0) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Activity ───"), 0, 0));
			for (const item of activity) {
				container.addChild(new Text(truncLine(`  ⎿  ${activityIcon(item, theme)} ${theme.fg("dim", item.label)}`, termBudget(2)), 0, 0));
			}
		}

		if (reports.length > 0) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Reports ───"), 0, 0));
			for (let i = 0; i < reports.length; i++) {
				container.addChild(new Text(
					theme.fg("warning", `  [${i + 1}] `) + theme.fg("toolOutput", reports[i]),
					0, 0,
				));
			}
		}

		if (pendingAsk.length > 0) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Questions ───"), 0, 0));
			for (const question of pendingAsk) container.addChild(new Text(formatQuestionLines([question], theme).slice(1), 0, 0));
		}

		if (answers.length > 0) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Contract ───") + formatAnswerLines(answers, theme), 0, 0));
		}

		const finalText = result.content[0];
		if (finalText?.type === "text" && reports.length === 0 && answers.length === 0) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
			container.addChild(new Markdown(finalText.text, 0, 0, getMarkdownTheme()));
		}

		return container;
	}

	// Collapsed view
	let text = `${icon} ${theme.fg("toolTitle", theme.bold(details.childId))}`;
	text += " · " + agentStats(details.model, activity.length, reports.length, details.usage, theme);
	text += contractBadge;
	if (hasError && details.error) {
		text += "\n  " + theme.fg("error", details.error);
	} else if (answers.length > 0) {
		text += formatAnswerLines(answers, theme, termBudget(2));
	} else if (pendingAsk.length > 0) {
		text += formatQuestionLines(pendingAsk, theme, termBudget(2));
	} else {
		text += formatActivityTail(activity, theme);
	}

	return new Text(text, 0, 0);
}
