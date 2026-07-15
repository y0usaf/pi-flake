import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { state } from "./state.js";
import { patchAssistantMessageComponent } from "./thinking-rendering.js";
import { patchToolExecutionComponent } from "./tool-rendering.js";
import { patchUserMessageComponent } from "./user-rendering.js";
import { DEFAULT_THINKING_MODE, type ThinkingMode } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseConfiguredThinkingMode(value: unknown): ThinkingMode | undefined {
  if (typeof value !== "string") return undefined;

  switch (value.trim().toLowerCase()) {
    case "normal":
      return "normal";
    case "compact":
      return "compact";
    case "hidden":
    case "hide":
    case "off":
      return "hidden";
    default:
      return undefined;
  }
}

function readConfiguredThinkingMode(path: string): ThinkingMode | undefined {
  if (!existsSync(path)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.extensionSettings)) return undefined;

    const extensionSettings = parsed.extensionSettings["pi-compact"];
    if (!isRecord(extensionSettings) || !isRecord(extensionSettings.thinking)) return undefined;
    return parseConfiguredThinkingMode(extensionSettings.thinking.mode);
  } catch (error) {
    state.lastConfigError = error instanceof Error ? error.stack ?? error.message : String(error);
    return undefined;
  }
}

function resolveThinkingMode(cwd: string, projectTrusted: boolean): ThinkingMode {
  state.lastConfigError = undefined;

  const globalMode = readConfiguredThinkingMode(join(getAgentDir(), "settings.json"));
  const projectMode = projectTrusted
    ? readConfiguredThinkingMode(join(cwd, CONFIG_DIR_NAME, "settings.json"))
    : undefined;

  return projectMode ?? globalMode ?? DEFAULT_THINKING_MODE;
}

function patchComponents(): boolean {
  const toolOk = patchToolExecutionComponent();
  const userOk = patchUserMessageComponent();
  const assistantOk = patchAssistantMessageComponent();
  return toolOk && userOk && assistantOk;
}

function patchErrors(): string {
  const errors = [
    state.lastToolPatchError,
    state.lastUserPatchError,
    state.lastAssistantPatchError,
    state.lastConfigError,
  ].filter(Boolean);
  return errors.length > 0 ? `\n${errors.join("\n")}` : "";
}

function parseThinkingModeArg(args: string, current: ThinkingMode): ThinkingMode | undefined {
  const value = args.trim().toLowerCase();
  if (!value || value === "status") return current;

  switch (value) {
    case "normal":
      return "normal";
    case "compact":
      return "compact";
    case "hidden":
    case "hide":
    case "off":
      return "hidden";
    case "toggle":
      return current === "normal" ? "compact" : current === "compact" ? "hidden" : "compact";
    default:
      return undefined;
  }
}

function thinkingStatus(): string {
  return `pi-compact: thinking=${state.thinkingMode}`;
}

void patchComponents();

export default function (pi: ExtensionAPI) {
  pi.on("thinking_level_select", (event) => { state.thinkingLevel = event.level; });

  pi.registerCommand("compact-thinking", {
    description: "Set thinking rendering (normal|compact|hidden|toggle)",
    handler: async (args, ctx) => {
      const next = parseThinkingModeArg(args, state.thinkingMode);
      if (next === undefined) {
        ctx.ui.notify("Usage: /compact-thinking [normal|compact|hidden|toggle|status]", "error");
        return;
      }

      state.thinkingMode = next;
      ctx.ui.notify(thinkingStatus(), "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    state.theme = ctx.mode === "tui" ? ctx.ui.theme : undefined;
    state.thinkingLevel = pi.getThinkingLevel();
    state.thinkingMode = resolveThinkingMode(ctx.cwd, ctx.isProjectTrusted());
    if ((!patchComponents() || state.lastConfigError) && ctx.hasUI) {
      ctx.ui.notify(`pi-compact: renderer/config issue${patchErrors()}`, "error");
    }
  });
}
