import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;

class BorderlessEditor extends CustomEditor {
	render(width: number): string[] {
		if (width < 3) return super.render(width);
		const lines = super.render(width - 2).slice(1);
		const border = lines.findLastIndex((line) => /^─*(?: ↓ \d+ more )?─*$/.test(line.replace(ANSI, "").trim()));
		if (border >= 0) lines.splice(border, 1);
		return lines.map((line, index) => {
			const marker = index === 0 ? ">" : border < 0 || index < border ? "|" : " ";
			return `${this.borderColor(marker)} ${line}`;
		});
	}
}

export default function minimalEditor(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => ctx.ui.setEditorComponent((...args) => new BorderlessEditor(...args)));
	pi.on("session_shutdown", (_event, ctx) => ctx.ui.setEditorComponent(undefined));
}
