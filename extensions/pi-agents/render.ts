/**
 * Rendering helpers adapted from nicobailon/pi-subagents (MIT) —
 * @extensions/nicobailon_pi-subagents/ — and pi coding-agent's own tool renderers.
 */
import { homedir } from "node:os";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

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
