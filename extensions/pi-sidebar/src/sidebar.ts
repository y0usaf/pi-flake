/**
 * Sidebar rendering: snapshot + theme → lines. Pure and theme-native — every
 * color comes from the active Pi theme, so dark/light/custom themes all work.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { SidebarSnapshot } from "./state.js";

export interface SidebarComponentOptions {
	getSnapshot(): SidebarSnapshot;
	getHeight(): number;
	theme: Theme;
}

export interface SidebarComponent {
	render(width: number): string[];
	invalidate(): void;
}

function padToWidth(text: string, width: number): string {
	const gap = width - visibleWidth(text);
	return gap > 0 ? text + " ".repeat(gap) : text;
}

/** "12.3k", "1.2M", or raw number for small values. */
export function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 10_000) return `${Math.round(count / 1_000)}k`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return `${count}`;
}

export function formatCost(cost: number): string {
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost > 0) return `$${cost.toFixed(3)}`;
	return "$0";
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${seconds % 60}s`;
}

interface Row {
	text: string;
	/** Lower priority rows are dropped first when height is tight. */
	priority: number;
	blank?: boolean;
}

const PRIORITY_IDENTITY = 0;
const PRIORITY_MODEL = 1;
const PRIORITY_CONTEXT = 2;
const PRIORITY_ACTIVITY = 3;
const PRIORITY_TOOLS = 4;
const PRIORITY_FILES = 5;

export function buildRows(snapshot: SidebarSnapshot, theme: Theme, now: number): Row[] {
	const rows: Row[] = [];
	const blank = (priority: number): void => {
		rows.push({ text: "", priority, blank: true });
	};
	const label = (text: string, priority: number): void => {
		rows.push({ text: theme.fg("muted", theme.bold(text)), priority });
	};
	const value = (text: string, priority: number, color: ThemeColor = "text"): void => {
		rows.push({ text: theme.fg(color, `  ${text}`), priority });
	};

	// --- Identity (crush: logo + title + cwd) ---
	rows.push({
		text: theme.fg("accent", theme.bold(snapshot.projectName)),
		priority: PRIORITY_IDENTITY,
	});
	if (snapshot.sessionName) {
		value(snapshot.sessionName, PRIORITY_IDENTITY, "dim");
	}
	value(snapshot.cwd, PRIORITY_IDENTITY, "dim");
	value(snapshot.branch ? `⎇ ${snapshot.branch}` : "no branch", PRIORITY_IDENTITY, "dim");
	blank(PRIORITY_IDENTITY);

	// --- Model ---
	label("Model", PRIORITY_MODEL);
	value(snapshot.modelName ?? "no model", PRIORITY_MODEL, "accent");
	if (snapshot.thinkingLevel) {
		value(`thinking ${snapshot.thinkingLevel}`, PRIORITY_MODEL, "muted");
	}
	if (snapshot.modelProvider) {
		value(snapshot.modelProvider, PRIORITY_MODEL, "muted");
	}
	blank(PRIORITY_MODEL);

	// --- Context ---
	label("Context", PRIORITY_CONTEXT);
	if (snapshot.contextTokens === null) {
		value("unknown", PRIORITY_CONTEXT, "muted");
	} else {
		const percent = snapshot.contextPercent === null ? "" : ` (${snapshot.contextPercent.toFixed(0)}%)`;
		const contextColor = (snapshot.contextPercent ?? 0) >= 80 ? "warning" : "text";
		value(`${formatTokens(snapshot.contextTokens)} / ${formatTokens(snapshot.contextWindow)}${percent}`, PRIORITY_CONTEXT, contextColor);
	}
	const usageParts = [
		formatCost(snapshot.totalCost),
		`in ${formatTokens(snapshot.totalInput)}`,
		`out ${formatTokens(snapshot.totalOutput)}`,
	];
	value(usageParts.join(" · "), PRIORITY_CONTEXT, "dim");
	if (snapshot.totalCacheRead > 0 || snapshot.totalCacheWrite > 0) {
		value(`cache r ${formatTokens(snapshot.totalCacheRead)} · w ${formatTokens(snapshot.totalCacheWrite)}`, PRIORITY_CONTEXT, "dim");
	}
	blank(PRIORITY_CONTEXT);

	// --- Files modified this session ---
	label(`Files (${snapshot.modifiedFiles.length})`, PRIORITY_FILES);
	if (snapshot.modifiedFiles.length === 0) {
		value("none yet", PRIORITY_FILES, "muted");
	} else {
		for (const file of snapshot.modifiedFiles) {
			value(file, PRIORITY_FILES, "dim");
		}
	}
	blank(PRIORITY_FILES);

	// --- Live tool activity ---
	const activityState = snapshot.activity === "running" ? "running" : "idle";
	label(`Activity (${activityState})`, PRIORITY_ACTIVITY);
	if (snapshot.runningTools.length === 0 && snapshot.recentTools.length === 0) {
		value("no tool activity yet", PRIORITY_ACTIVITY, "muted");
	} else {
		for (const tool of snapshot.runningTools) {
			const hint = tool.hint ? ` ${tool.hint}` : "";
			const elapsed = formatDuration(now - tool.startedAt);
			rows.push({
				text: theme.fg("accent", `  ● ${tool.toolName}${hint}`) + theme.fg("dim", `  ${elapsed}`),
				priority: PRIORITY_ACTIVITY,
			});
		}
		for (const tool of snapshot.recentTools) {
			const symbol = tool.isError ? "✗" : "✓";
			const color = tool.isError ? "error" : "success";
			const hint = tool.hint ? ` ${tool.hint}` : "";
			rows.push({
				text:
					theme.fg(color, `  ${symbol} ${tool.toolName}${hint}`) +
					theme.fg("dim", `  ${formatDuration(tool.durationMs)}`),
				priority: PRIORITY_ACTIVITY,
			});
		}
	}
	blank(PRIORITY_ACTIVITY);

	// --- Tools ---
	label("Tools", PRIORITY_TOOLS);
	value(`${snapshot.activeToolCount}/${snapshot.availableToolCount} active`, PRIORITY_TOOLS, "muted");
	rows.push({ text: theme.fg("dim", "  /sidebar to hide"), priority: PRIORITY_TOOLS });

	return rows;
}

/**
 * Fit rows into `height`: trim the file list first (crush-style dynamic
 * limits), then drop lowest-priority sections' extra rows, keeping blanks
 * attached to their section.
 */
export function fitRows(rows: Row[], height: number): Row[] {
	let fitted = rows;
	if (fitted.length <= height) return fitted;

	// 1. Trim file list to minimum 2 entries.
	const trimFiles = (keep: number): Row[] => {
		const out: Row[] = [];
		let filesSeen = 0;
		for (const row of fitted) {
			const isFileRow = row.priority === PRIORITY_FILES && !row.blank && !row.text.trimStart().startsWith("Files (");
			if (isFileRow) {
				filesSeen += 1;
				if (filesSeen > keep) continue;
			}
			out.push(row);
		}
		return out;
	};
	fitted = trimFiles(2);
	if (fitted.length <= height) return fitted;

	// 2. Drop whole sections, least important first, keeping header + min rows.
	const dropOrder = [PRIORITY_FILES, PRIORITY_TOOLS, PRIORITY_ACTIVITY, PRIORITY_CONTEXT];
	for (const section of dropOrder) {
		if (fitted.length <= height) break;
		const kept: Row[] = [];
		let sectionRowsSeen = 0;
		for (const row of fitted) {
			if (row.priority === section) {
				sectionRowsSeen += 1;
				// Keep the section header row only ("Files (n)" etc.).
				if (sectionRowsSeen > 1 && !row.blank) continue;
			}
			kept.push(row);
		}
		fitted = kept;
	}
	return fitted;
}

export function createSidebarComponent(options: SidebarComponentOptions): SidebarComponent {
	let cachedWidth: number | undefined;
	let cachedHeight: number | undefined;
	let cachedSnapshot: SidebarSnapshot | undefined;
	let cachedLines: string[] | undefined;
	let cachedSecond: number | undefined;

	return {
		render(width: number): string[] {
			const height = options.getHeight();
			const now = Date.now();
			const second = Math.floor(now / 1000);
			const snapshot = options.getSnapshot();
			if (
				cachedLines &&
				cachedWidth === width &&
				cachedHeight === height &&
				cachedSnapshot === snapshot &&
				cachedSecond === second
			) {
				return cachedLines;
			}
			const rows = fitRows(buildRows(snapshot, options.theme, now), height);
			cachedLines = rows.slice(0, height).map((row) => padToWidth(truncateToWidth(row.text, width), width));
			cachedWidth = width;
			cachedHeight = height;
			cachedSnapshot = snapshot;
			cachedSecond = second;
			return cachedLines;
		},
		invalidate(): void {
			cachedWidth = undefined;
			cachedHeight = undefined;
			cachedSnapshot = undefined;
			cachedLines = undefined;
			cachedSecond = undefined;
		},
	};
}
