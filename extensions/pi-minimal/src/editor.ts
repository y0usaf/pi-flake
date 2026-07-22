import { CustomEditor, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { state } from "./state.js";
import { ANSI_PATTERN } from "./types.js";

class BorderlessEditor extends CustomEditor {
	render(width: number): string[] {
		if (width < 3) return super.render(width);
		const lines = super.render(width - 2).slice(1);
		const border = lines.findLastIndex((line) => /^─*(?: ↓ \d+ more )?─*$/.test(line.replace(ANSI_PATTERN, "").trim()));
		if (border >= 0) lines.splice(border, 1);
		return lines.map((line, index) => {
			const marker = index === 0 ? ">" : border < 0 || index < border ? "|" : " ";
			return `${this.borderColor(marker)} ${line}`;
		});
	}
}

const borderlessFactory = (...args: ConstructorParameters<typeof CustomEditor>) => new BorderlessEditor(...args);

type EditorUi = Pick<ExtensionCommandContext, "hasUI" | "ui">;

/**
 * Apply the current editor feature flag. setEditorComponent live-swaps the
 * editor (text preserved), so this is safe to call at any time in TUI mode.
 * Only touches the editor when a swap is actually needed, and never clears
 * another extension's editor component.
 */
export function applyEditorFeature(ctx: EditorUi): void {
	if (!ctx.hasUI) return;
	const ours = ctx.ui.getEditorComponent?.() === borderlessFactory;
	if (state.features.editor === ours) return;
	ctx.ui.setEditorComponent(state.features.editor ? borderlessFactory : undefined);
}

/** Session teardown: release the editor only if we still own it. */
export function releaseEditor(ctx: EditorUi): void {
	if (!ctx.hasUI) return;
	if (ctx.ui.getEditorComponent?.() === borderlessFactory) ctx.ui.setEditorComponent(undefined);
}
