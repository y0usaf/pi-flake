import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const EDITOR_WIDTH_RATIO = 0.9;
const EDITOR_MAX_WIDTH = 100;
const EDITOR_MIN_WIDTH = 24;
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;

function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

function editorOuterWidth(width: number): number {
	if (width <= EDITOR_MIN_WIDTH) return Math.max(1, width);
	return Math.min(width, EDITOR_MAX_WIDTH, Math.max(EDITOR_MIN_WIDTH, Math.floor(width * EDITOR_WIDTH_RATIO)));
}

function isEditorBorder(line: string): boolean {
	const text = stripAnsi(line).trim();
	return /^─+$/.test(text) || /^─── [↑↓] \d+ more ─*$/.test(text);
}

function scrollLabel(line: string): string | undefined {
	return stripAnsi(line).match(/[↑↓] \d+ more/)?.[0];
}

class MinimalBoxEditor extends CustomEditor {
	render(width: number): string[] {
		if (width < 4) return super.render(width);

		const outerWidth = editorOuterWidth(width);
		const innerWidth = Math.max(1, outerWidth - 2);
		const leftMargin = " ".repeat(Math.max(0, Math.floor((width - outerWidth) / 2)));
		const lines = super.render(innerWidth);
		if (lines.length === 0) return lines;

		const bottomIndex = lines.findIndex((line, index) => index > 0 && isEditorBorder(line));
		const topLabel = scrollLabel(lines[0] ?? "");
		const bottomLabel = bottomIndex >= 0 ? scrollLabel(lines[bottomIndex] ?? "") : undefined;
		const body = bottomIndex >= 0 ? [...lines.slice(1, bottomIndex), ...lines.slice(bottomIndex + 1)] : lines;

		return [
			leftMargin + this.renderBorder("┌", "┐", innerWidth, topLabel),
			...body.map((line) => leftMargin + this.renderBodyLine(line, innerWidth)),
			leftMargin + this.renderBorder("└", "┘", innerWidth, bottomLabel),
		];
	}

	private renderBorder(left: string, right: string, innerWidth: number, label?: string): string {
		const rawLabel = label ? ` ${label} ` : "";
		const visibleLabel = truncateToWidth(rawLabel, innerWidth, "");
		const fill = "─".repeat(Math.max(0, innerWidth - visibleWidth(visibleLabel)));
		return this.borderColor(`${left}${visibleLabel}${fill}${right}`);
	}

	private renderBodyLine(line: string, innerWidth: number): string {
		const clipped = truncateToWidth(line, innerWidth, "");
		const padded = `${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}`;
		return `${this.borderColor("│")}${padded}${this.borderColor("│")}`;
	}
}

export default function inputBox(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new MinimalBoxEditor(tui, theme, keybindings, { paddingX: 1 }));
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setEditorComponent(undefined);
	});
}
