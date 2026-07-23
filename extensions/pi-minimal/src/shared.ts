import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { state } from "./state.js";
import { ANSI_PATTERN } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

export function paint(color: ThemeColor, value: string, emphasize = false): string {
	const theme = state.theme;
	if (!theme) return value;
	const text = emphasize ? theme.bold(value) : value;
	return theme.fg(color, text);
}

export function squash(value: unknown): string {
	return typeof value === "string" ? stripAnsi(value).replace(/\s+/g, " ").trim() : "";
}

export function clip(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value;
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
	if (typeof value === "object") return "{…}";
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
	const line = truncateToWidth(rawLine, Math.max(1, width), "…");
	return [`${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`];
}
