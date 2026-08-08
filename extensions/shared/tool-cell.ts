// Prime-agent-style tool cell, extension-level.
//
// One status line per tool call: marker · label · call preview · stats ·
// duration · expand hint, all on a single row (the ipython-cell pattern from
// prime-agent). The line is identical collapsed or expanded; expanding only
// attaches output below it. State lives in the marker color, not a box:
// queued (muted …/[*]), running (animated spinner), done (✓/[ok]),
// error (✗/[!!]). Glyphs come from the shared symbol preset, so
// PI_SYMBOLS=ascii swaps ✓/✗/spinner for [ok]/[!!]/-|/.
//
// The spinner is driven by a component-local interval (tools run
// sequentially, so one timer at a time suffices) that ticks
// context.invalidate() — the same self-refresh pattern the built-in bash
// renderer uses for its elapsed-time clock.
//
// Every emitted line is wrapped to the content width and padded to the full
// render width (the TUI's differential renderer contract, same as pi's Text
// component): a line that ends short of width leaves the previous frame's
// tail visible, and a line that exceeds width makes the terminal auto-wrap,
// breaking row alignment. Truncation (call line) and wrapping (result lines)
// both pad.
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { resolveSymbols } from "./symbols";

export const TOOL_CELL_PULSE_INTERVAL_MS = 250;

export type ToolCellState = "queued" | "running" | "done" | "error";

/** State from a tool render context. isPartial stays true until a non-partial
 * result lands, so "running" covers both "execution started, no result yet"
 * and "streaming partial result". */
export function cellState(ctx: {
	executionStarted: boolean;
	isPartial: boolean;
	isError: boolean;
}): ToolCellState {
	if (ctx.isError) return "error";
	if (!ctx.executionStarted) return "queued";
	if (ctx.isPartial) return "running";
	return "done";
}

function glyph(key: string): string {
	const S = resolveSymbols();
	return S[key] ?? "";
}

export function formatDuration(ms: number): string {
	return (ms / 1000).toFixed(1) + "s";
}

/** Status marker: colored glyph per state; the running marker animates. */
export function cellMarker(state: ToolCellState, frame: number, theme: Theme): string {
	switch (state) {
		case "error":
			return theme.fg("error", glyph("status.error") || "✗");
		case "done":
			return theme.fg("success", glyph("status.success") || "✓");
		case "running":
			return theme.fg("bashMode", glyph("spinner." + (((frame % 4) + 4) % 4 + 1)) || "◇");
		default:
			return theme.fg("muted", glyph("status.pending") || "…");
	}
}

/** Pad a styled line to the full render width so the differential renderer
 * clears the previous frame's tail. */
function padToWidth(line: string, width: number): string {
	return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

export interface ToolCallCellOptions {
	label: string;
	/** Styled single-line call preview (e.g. "$ cargo build"). */
	preview: string;
	state: ToolCellState;
	/** Stats appended after the preview, styled (e.g. "↓ 4 lines"). */
	stats?: string[];
	/** Settled duration in ms; omitted while running. */
	durationMs?: number;
	/** Short error summary shown in error color (e.g. first traceback line). */
	errorName?: string;
	/** Styled expand hint (keyHint output); omitted to suppress. */
	hint?: string;
	theme: Theme;
	invalidate: () => void;
}

/** Call slot: one status line. Reuse the previous component via
 * context.lastComponent so the timer and frame counter survive re-renders. */
export class ToolCallCellComponent implements Component {
	private opts?: ToolCallCellOptions;
	private frame = 0;
	private timer?: ReturnType<typeof setInterval>;
	private cache?: { width: number; line: string };

	update(opts: ToolCallCellOptions): void {
		if (opts.state === "running" && !this.timer) {
			this.timer = setInterval(() => {
				this.frame += 1;
				this.cache = undefined;
				this.opts?.invalidate();
			}, TOOL_CELL_PULSE_INTERVAL_MS);
			this.timer.unref?.();
		} else if (opts.state !== "running" && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.opts = opts;
		this.cache = undefined;
	}

	render(width: number): string[] {
		const opts = this.opts;
		if (!opts) return [];
		const cache = this.cache;
		if (cache && cache.width === width) return [cache.line];
		const parts = [cellMarker(opts.state, this.frame, opts.theme) + " " + opts.theme.fg("muted", opts.label)];
		if (opts.preview) parts.push(opts.preview);
		if (opts.stats) parts.push(...opts.stats);
		if (opts.durationMs !== undefined) parts.push(opts.theme.fg("muted", formatDuration(opts.durationMs)));
		if (opts.errorName) parts.push(opts.theme.fg("error", opts.errorName));
		if (opts.hint) parts.push(opts.hint);
		const joined = parts.join(opts.theme.fg("dim", " · "));
		const line = padToWidth(truncateToWidth(joined, width, ""), width);
		this.cache = { width, line };
		return [line];
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

/** Result slot: output lines below the call line, each wrapped to the
 * content width (2-col indent preserved on continuation rows) and padded to
 * the full render width. Collapsed (or empty) renders nothing — the call
 * line carries the summary. */
export class ToolResultCellComponent implements Component {
	private lines: string[] = [];
	private theme?: Theme;
	private expanded = false;
	private cache?: { width: number; lines: string[] };

	update(lines: string[], theme: Theme, expanded: boolean): void {
		this.lines = lines;
		this.theme = theme;
		this.expanded = expanded;
		this.cache = undefined;
	}

	render(width: number): string[] {
		const theme = this.theme;
		if (!theme) return [];
		if (!this.expanded) return [];
		const cache = this.cache;
		if (cache && cache.width === width) return cache.lines;
		const indent = "  ";
		const contentWidth = Math.max(1, width - indent.length);
		const lines: string[] = [];
		for (const line of this.lines) {
			const chunks = wrapTextWithAnsi(line, contentWidth);
			if (chunks.length === 0) chunks.push("");
			for (const chunk of chunks) {
				const full = indent + chunk;
				lines.push(padToWidth(full, width));
			}
		}
		this.cache = { width, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

/** Shared result summary stashed in context.state by the result slot and
 * read by the call slot line: output line count + settled duration. */
export interface ToolCellResultSummary {
	lineCount: number;
	durationMs?: number;
	errorName?: string;
}
