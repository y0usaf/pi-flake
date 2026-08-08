import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { ToolCallCellComponent, ToolResultCellComponent, cellState, type ToolCellResultSummary } from "../../shared/tool-cell";
import { callHeaderLine } from "./format";
import { SPECS, TREE_SPECS } from "./specs";
import { renderTreeList } from "./tree";
import type { RenderDeps } from "./skin";

const renderDeps: RenderDeps = { keyHint, visibleWidth, truncateToWidth };

/** Read the result summary the result slot stashed into context.state. */
function resultSummary(state: any): ToolCellResultSummary | undefined {
	return state?.resultSummary;
}

/** Call slot: one status line — marker · label · call preview · stats ·
 * duration · expand hint. The line is identical collapsed or expanded;
 * expanding only attaches output below (result slot). Stats come from the
 * result summary stashed by the result slot on the previous render pass. */
export function renderCall(name: string, args: any, theme: Theme, context: any): Component {
	try {
		const state = context.state ?? (context.state = {});
		if (context.executionStarted && state.startedAt === undefined) state.startedAt = Date.now();
		const summary = resultSummary(state);
		const settled = !context.isPartial && !context.isError;
		const component =
			context.lastComponent instanceof ToolCallCellComponent ? context.lastComponent : new ToolCallCellComponent();
		component.update({
			label: SPECS[name]?.label ?? name,
			preview: callHeaderLine(name, args, theme, renderDeps),
			state: cellState(context),
			stats: summary && summary.lineCount > 0
				? [theme.fg("muted", "↓ " + summary.lineCount + " lines")]
				: [],
			durationMs: settled && summary ? summary.durationMs : undefined,
			errorName: context.isError && summary ? summary.errorName : undefined,
			hint: keyHint("app.tools.expand", context.expanded ? "to collapse" : "to expand"),
			theme,
			invalidate: context.invalidate,
		});
		return component;
	} catch {
		return new Text(name, 0, 0);
	}
}

/** Result slot: stash the summary for the call line, then render output
 * lines (expanded only). Full output for text tools; tree rows for find/ls. */
export function renderResult(name: string, result: any, options: any, theme: Theme, context: any): Component {
	try {
		const state = context.state ?? (context.state = {});
		if (!options?.isPartial || context.isError) state.endedAt ??= Date.now();
		const body = (result?.content ?? [])
			.filter((x: any) => x.type === "text")
			.map((x: any) => x.text ?? "")
			.join("\n");
		const bodyLines = body ? body.split("\n") : [];
		state.resultSummary = {
			lineCount: bodyLines.length,
			durationMs:
				state.startedAt !== undefined && state.endedAt !== undefined
					? state.endedAt - state.startedAt
					: undefined,
			errorName: context.isError ? (bodyLines[0] ?? "error").slice(0, 60) : undefined,
		};
		// The call line runs before this slot in the same mount pass, so it saw
		// the previous summary. One microtask refresh repaints it with the new
		// stats (same double-render guard pi-frames used).
		if (!state.invalidated) {
			state.invalidated = true;
			queueMicrotask(() => context.invalidate?.());
		}
		const expanded = context.expanded || options?.expanded;
		const component =
			context.lastComponent instanceof ToolResultCellComponent ? context.lastComponent : new ToolResultCellComponent();
		if (!expanded) {
			component.update([], theme, false);
			return component;
		}
		let lines: string[];
		const treeSpec = TREE_SPECS[name];
		if (treeSpec) {
			const items: string[] = [];
			const extras: string[] = [];
			for (const raw of bodyLines) {
				const line = raw.trim();
				if (!line) continue;
				if (/^\[[^\]]*\]$/.test(line)) extras.push(line);
				else items.push(line);
			}
			lines = [
				...renderTreeList(
					{
						items,
						expanded: true,
						itemType: treeSpec.itemType,
						renderItem: (line: string) => {
							if (treeSpec.isDir(line)) return theme.fg("accent", "[D]") + " " + theme.fg("muted", line);
							return line;
						},
					},
					theme,
					renderDeps,
				),
				...extras,
			];
		} else {
			lines = bodyLines.map((line: string) => theme.fg("toolOutput", line));
		}
		component.update(lines, theme, true);
		return component;
	} catch {
		return new Text(name, 0, 0);
	}
}