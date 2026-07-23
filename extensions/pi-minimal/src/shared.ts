import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { state } from "./state.js";
import { ANSI_PATTERN, SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "./types.js";

const ANSI_BRIGHT_YELLOW = "\x1b[93m";
const ANSI_FOREGROUND_RESET = "\x1b[39m";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

export function paint(color: ThemeColor, value: string, emphasize = false): string {
	const theme = state.theme;
	if (!theme) return value;
	const text = theme.fg(color, value);
	return emphasize ? theme.bold(text) : text;
}

export function paintBrightYellow(value: string, emphasize = false): string {
	const theme = state.theme;
	if (!theme) return value;
	const text = `${ANSI_BRIGHT_YELLOW}${value}${ANSI_FOREGROUND_RESET}`;
	return emphasize ? theme.bold(text) : text;
}

export function squash(value: unknown): string {
	return typeof value === "string" ? stripAnsi(value).replace(/\s+/g, " ").trim() : "";
}

export function clip(value: string, max: number): string {
	return value.length > max ? value.slice(0, Math.max(1, max)) : value;
}

/** Middle-truncate a path, keeping the basename (and leading segments that fit). */
export function clipPath(path: string, max: number): string {
	if (path.length <= max) return path;
	const segments = path.split("/");
	const basename = segments.pop() ?? path;
	if (segments.length === 0 || basename.length + 2 >= max) return clip(basename, max);
	let lead = "";
	for (const segment of segments) {
		const candidate = lead ? `${lead}/${segment}` : segment;
		if (candidate.length + basename.length + 3 > max) break;
		lead = candidate;
	}
	return lead ? `${lead}/…/${basename}` : `…/${basename}`;
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(1, Math.round(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Current braille spinner frame; animates across renders while streaming. */
export function spinnerFrame(): string {
	return SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length] ?? "";
}

export function shortenPath(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function normalizePath(path: unknown, fallback = ".", cwd?: string): string {
	if (typeof path !== "string" || path.length === 0) return fallback;
	const clean = stripAnsi(path).replace(/^@/, "");
	if (cwd && (clean === cwd || clean.startsWith(`${cwd}/`))) return clean === cwd ? "." : clean.slice(cwd.length + 1);
	return shortenPath(clean);
}

export function lineCount(value: unknown): number {
	return typeof value === "string" && value.length > 0 ? value.split("\n").length : 0;
}

export function formatScalar(value: unknown): string {
	if (typeof value === "string") return squash(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null) return "null";
	if (Array.isArray(value)) return `[${value.length}]`;
	if (typeof value === "object") return "{}";
	return "";
}

export function firstTextLine(result: any): string {
	if (!Array.isArray(result?.content)) return "";
	for (const block of result.content) {
		if (block?.type !== "text" || typeof block.text !== "string") continue;
		const line = block.text
			.split("\n")
			.map((part: string) => squash(part))
			.find((part: string) => part.length > 0);
		if (line) return line;
	}
	return "";
}

export function textLineCount(result: any): number {
	if (!Array.isArray(result?.content)) return 0;
	let total = 0;
	for (const block of result.content) {
		if (block?.type !== "text" || typeof block.text !== "string") continue;
		total += block.text.split("\n").filter((line: string) => line.trim().length > 0).length;
	}
	return total;
}

export type LineDiffCounts = { added: number; removed: number };

function lineDiffCounts(value: unknown): LineDiffCounts | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	let added = 0;
	let removed = 0;
	for (const line of value.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return added > 0 || removed > 0 ? { added, removed } : undefined;
}

function metricCounts(value: unknown): LineDiffCounts | undefined {
	if (!isRecord(value)) return undefined;
	const added = value.added_lines ?? value.addedLines ?? value.added;
	const removed = value.removed_lines ?? value.removedLines ?? value.removed;
	if ((typeof added !== "number" || !Number.isFinite(added)) && (typeof removed !== "number" || !Number.isFinite(removed))) {
		return undefined;
	}
	const counts = {
		added: typeof added === "number" && Number.isFinite(added) ? Math.max(0, Math.trunc(added)) : 0,
		removed: typeof removed === "number" && Number.isFinite(removed) ? Math.max(0, Math.trunc(removed)) : 0,
	};
	return counts.added > 0 || counts.removed > 0 ? counts : undefined;
}

export function countDetailsLineDiff(details: unknown): LineDiffCounts | undefined {
	if (!isRecord(details)) return undefined;
	return metricCounts(details.metrics) ?? metricCounts(details) ?? lineDiffCounts(details.diff);
}

export function countLabel(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function renderOneLine(rawLine: string, width: number): string[] {
	if (!Number.isFinite(width) || width <= 0) return [];
	const line = truncateToWidth(rawLine, Math.max(1, width), "");
	return [`${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`];
}
