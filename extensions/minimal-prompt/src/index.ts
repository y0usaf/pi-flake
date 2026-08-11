import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const THINK: Record<string, string> = {
  off: "thinkingOff", minimal: "thinkingMinimal", low: "thinkingLow",
  medium: "thinkingMedium", high: "thinkingHigh", xhigh: "thinkingXhigh",
  max: "thinkingMax",
};

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, kb) => {
      class MinimalPrompt extends CustomEditor {
        render(width: number): string[] {
          if (this.isShowingAutocomplete()) return super.render(width);

          const thm = ctx.ui.theme;
          const col = THINK[pi.getThinkingLevel()] ?? "thinkingOff";
          const bar = thm.fg(col, "│");
          const prefix = bar + " > ";
          const cw = width - 3; // content width for parent

          const lines = super.render(cw);
          if (lines.length < 2) return [];

          const content = lines.slice(1, -1); // strip borders
          const result: string[] = [];
          for (let i = 0; i < Math.min(3, content.length); i++) {
            const pad = " ".repeat(Math.max(0, cw - visibleWidth(content[i]!)));
            result.push(thm.bg("userMessageBg", prefix + content[i]! + pad));
          }
          while (result.length < 3)
            result.push(thm.bg("userMessageBg", bar + "  " + " ".repeat(cw)));
          return result;
        }
      }
      return new MinimalPrompt(tui, theme, kb, { paddingX: 0 });
    });
  });
}