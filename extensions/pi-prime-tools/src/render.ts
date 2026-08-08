// Rail renderers for the skinned builtin tools (and js, via pi-js-kernel).
//
// Every tool row renders as a minimalist left rail: a bare `+` corner, a `|`
// rail per content row, content indented two spaces, no horizontal strokes,
// no right rail, no background. Glyphs come from the shared symbol preset
// (PI_SYMBOLS=ascii gives +/|, unicode gives ┌/│). State colors the rail via
// the frame's fg wash: pending=accent, success=dim, error=error.
//
// The call slot owns the top corner, the result slot the bottom, joined into
// one continuous rail by the hashline invalidate microtask (pi issue #3830).
// Collapsed non-error rows render nothing; the call keeps its own bottom
// corner so a collapsed row is still a closed rail.
import { type Component, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { frameComponent, type FrameDeps, type OutputBlockOptions } from "../../shared/frame";
import { callHeaderLine } from "./format";
import { SPECS, TREE_SPECS } from "./specs";
import { renderTreeList } from "./tree";
import type { RenderDeps } from "./skin";

const frameDeps: FrameDeps = { visibleWidth, truncateToWidth, wrapTextWithAnsi };
const renderDeps: RenderDeps = { keyHint, visibleWidth, truncateToWidth };

/** Call slot: one rail row — the SPECS call line (bold label + colored
 * primary + dim extras). Pending calls show a thin closed rail; once the
 * result frame exists and renders expanded, the bottom corner moves to it. */
export function renderCall(name: string, args: any, theme: Theme, context: any): Component {
	try {
		const spec = SPECS[name];
		const line = spec?.prefix
			? `${theme.fg("toolTitle", theme.bold(spec.label ?? name))} ${callHeaderLine(name, args, theme, renderDeps)}`
			: callHeaderLine(name, args, theme, renderDeps);
		const build = (width: number): OutputBlockOptions => ({
			style: "rail",
			state: context.isError
				? "error"
				: context.isPartial || !context.executionStarted
					? "pending"
					: "success",
			sections: [{ lines: [line] }],
			width,
			applyBg: false,
			contentPaddingLeft: 2,
			railIndent: 2,
			bottomBar: context.state?.hasResult !== true || (!context.expanded && !context.isError),
		});
		return frameComponent(build, theme, frameDeps);
	} catch {
		return new Text(name, 0, 0);
	}
}

/** Result slot: content rows plus the closing bottom corner (expanded or
 * error only; collapsed non-error rows render nothing). find/ls bodies render
 * as flat tree rows, everything else as plain lines. */
export function renderResult(name: string, result: any, _options: any, theme: Theme, context: any): Component {
	try {
		const state = context.state ?? (context.state = {});
		if (!state.hasResult) {
			state.hasResult = true;
			if (!state.invalidated) {
				state.invalidated = true;
				// Defer past the current updateDisplay pass: a synchronous
				// invalidate re-enters tool-execution's updateDisplay() from inside
				// resultRenderer() before this result component is added to the row
				// container (pi issue #3830). The microtask rebuilds the row
				// wholesale so the call slot re-renders without its bottom corner.
				queueMicrotask(() => context.invalidate?.());
			}
		}
		const body = (result?.content ?? [])
			.filter((x: any) => x.type === "text")
			.map((x: any) => x.text ?? "")
			.join("\n");
		const bodyLines = body ? body.split("\n") : [];
		if (!context.expanded && !context.isError) return new Text("", 0, 0);
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
			lines = bodyLines;
		}
		const build = (width: number): OutputBlockOptions => ({
			style: "rail",
			state: context.isError ? "error" : "success",
			sections: [{ lines }],
			width,
			applyBg: false,
			contentPaddingLeft: 2,
			railIndent: 2,
			// The call slot owns the top corner; this slot only emits the
			// content rows and the closing bottom corner for one continuous rail.
			topBar: false,
			bottomBar: true,
		});
		return frameComponent(build, theme, frameDeps);
	} catch {
		return new Text(name, 0, 0);
	}
}
