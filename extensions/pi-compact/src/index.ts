import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { state } from "./state.js";
import { patchAssistantMessageComponent } from "./thinking-rendering.js";
import { patchToolExecutionComponent } from "./tool-rendering.js";
import { patchUserMessageComponent } from "./user-rendering.js";

function patchComponents(): boolean {
  const toolOk = patchToolExecutionComponent();
  const userOk = patchUserMessageComponent();
  const assistantOk = patchAssistantMessageComponent();
  return toolOk && userOk && assistantOk;
}

function patchErrors(): string {
  const errors = [state.lastToolPatchError, state.lastUserPatchError, state.lastAssistantPatchError].filter(Boolean);
  return errors.length > 0 ? `\n${errors.join("\n")}` : "";
}

void patchComponents();

export default function (pi: ExtensionAPI) {
  pi.on("thinking_level_select", (event) => { state.thinkingLevel = event.level; });

  pi.on("session_start", (_event, ctx) => {
    state.theme = ctx.mode === "tui" ? ctx.ui.theme : undefined;
    state.thinkingLevel = pi.getThinkingLevel();
    if (!patchComponents() && ctx.hasUI) ctx.ui.notify(`pi-compact: renderer patch failed${patchErrors()}`, "error");
  });
}
