/**
 * pi-rlm — Pi-native RLM (Recursive Language Model) extension.
 *
 * Public extension entry point. Implementation lives in cohesive modules under src/.
 */

import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

import { REPL_TOOL_NAME, RLM_FINAL_OUTPUT_CUSTOM_TYPE } from "./constants.js";
import { rootSystemPrompt } from "./guidance.js";
import { createRlmReplTool } from "./repl.js";
import { loadRlmSettings, modelSelectorForRole } from "./settings.js";
import {
  ensureSessionContextStore,
  externalizeLargeInput,
  recordUserInput,
  releaseSessionContextStore,
  sessionContextPromptBlock,
  shouldExternalizeInput,
} from "./session-context.js";
import { isRlmReplToolName, resolveModelSelector, textOf } from "./utils.js";

const ROOT_MODE = "repl";

function rootTools(): string[] {
  return [REPL_TOOL_NAME];
}

function enforceRootTools(pi: ExtensionAPI): string {
  pi.setActiveTools(rootTools());
  return ROOT_MODE;
}

function sameModel(a: any, b: any): boolean {
  return Boolean(a && b && a.provider === b.provider && a.id === b.id);
}

function modelName(model: any): string {
  return model ? `${model.provider}/${model.id}` : "unknown";
}

async function enforceConfiguredRootModel(pi: ExtensionAPI, ctx: ExtensionContext, failClosed: boolean): Promise<void> {
  const settings = loadRlmSettings(ctx.cwd);
  if (settings.enforceRootModel === false) return;

  const selector = modelSelectorForRole(settings, "root");
  if (!selector) return;

  let model: any;
  try {
    model = resolveModelSelector(ctx, selector);
  } catch (error) {
    if (failClosed) {
      ctx.abort();
      throw error;
    }
    return;
  }

  if (sameModel(ctx.model, model)) return;

  const ok = await pi.setModel(model);
  if (!ok) {
    const message = `pi-rlm root model enforcement failed: no API key for ${modelName(model)} selected by ${JSON.stringify(selector)}.`;
    if (failClosed) {
      ctx.abort();
      throw new Error(message);
    }
  }
}

type PendingFinalOutput = {
  text: string;
  variableName?: string;
  toolCallId?: string;
  timestamp: number;
};

const pendingFinalOutputs: PendingFinalOutput[] = [];
let finalOutputFlushScheduled = false;

function textFromCustomContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => {
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      if (part?.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function formatStructuredFinalValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  try {
    return (JSON.stringify(value, null, 2) ?? String(value)).trim();
  } catch {
    return String(value).trim();
  }
}

function rlmFinalText(message: any): string {
  const details = message?.details;
  if (details && typeof details === "object") {
    if (typeof details.finalText === "string") return details.finalText.trim();
    if (hasOwn(details, "finalValue")) return formatStructuredFinalValue(details.finalValue);
  }

  // Legacy fallback for pre-variable-only pi-rlm tool results.
  const text = textOf(message?.content).trim();
  const match = text.match(/(?:^|\n)FINAL:\s*\n?([\s\S]*)$/);
  return (match?.[1] ?? text).trim();
}

function rlmFinalVariableName(message: any): string | undefined {
  const details = message?.details;
  if (!details || typeof details !== "object") return undefined;
  const name = typeof details.finalVar === "string" ? details.finalVar : typeof details.finalName === "string" ? details.finalName : undefined;
  return name?.trim() || undefined;
}

function collectRlmFinalOutputs(messages: any[]): PendingFinalOutput[] {
  const outputs: PendingFinalOutput[] = [];
  for (const message of messages) {
    if (message?.role !== "toolResult") continue;
    if (!isRlmReplToolName(message.toolName)) continue;
    if (message.details?.final !== true) continue;
    if (message.details?.finalMirrored === true) continue;
    const text = rlmFinalText(message);
    if (!text) continue;
    outputs.push({
      text,
      variableName: rlmFinalVariableName(message),
      toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
      timestamp: Date.now(),
    });
  }
  return outputs;
}

function emitRlmFinalOutput(pi: ExtensionAPI, output: PendingFinalOutput): void {
  pi.sendMessage({
    customType: RLM_FINAL_OUTPUT_CUSTOM_TYPE,
    content: output.text,
    display: true,
    details: {
      toolName: "rlm_final",
      variableName: output.variableName,
      toolCallId: output.toolCallId,
      emittedAt: output.timestamp,
    },
  }, { triggerTurn: false });
}

function registerRlmFinalOutputRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(RLM_FINAL_OUTPUT_CUSTOM_TYPE, (message, _options, theme) => {
    const text = textFromCustomContent(message.content).trim();
    if (!text) return undefined;

    const variableName = typeof (message.details as any)?.variableName === "string" && (message.details as any).variableName.trim()
      ? (message.details as any).variableName.trim()
      : undefined;
    const label = variableName ? `rlm_final:${variableName}` : "rlm_final";

    // Use the custom-message palette so the variable final output stands apart
    // from tool-success styling and matches VCC-style custom messages.
    const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
    box.addChild(new Text(
      `${theme.fg("customMessageLabel", "✓")} ${theme.fg("customMessageLabel", theme.bold(label))}`,
      0,
      0,
    ));
    box.addChild(new Spacer(1));
    box.addChild(new Markdown(text, 0, 0, getMarkdownTheme(), {
      color: (value) => theme.fg("customMessageText", value),
    }));
    return box;
  });
}

function scheduleFinalOutputFlush(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (finalOutputFlushScheduled) return;
  finalOutputFlushScheduled = true;

  setTimeout(() => {
    finalOutputFlushScheduled = false;
    if (pendingFinalOutputs.length === 0) return;

    let idle = false;
    try {
      idle = ctx.isIdle();
    } catch {
      pendingFinalOutputs.length = 0;
      return;
    }

    if (!idle) {
      scheduleFinalOutputFlush(pi, ctx);
      return;
    }

    const outputs = pendingFinalOutputs.splice(0);
    for (const output of outputs) {
      try {
        pi.sendMessage({
          customType: RLM_FINAL_OUTPUT_CUSTOM_TYPE,
          content: output.text,
          display: true,
          details: {
            toolName: REPL_TOOL_NAME,
            variableName: output.variableName,
            toolCallId: output.toolCallId,
            emittedAt: output.timestamp,
          },
        }, { triggerTurn: false });
      } catch {
        // Session may have been replaced or shut down before the deferred UI mirror ran.
      }
    }
  }, 0);
}

function stripAssistantOutputText(message: any): any | undefined {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  let changed = false;
  const content = message.content.filter((part: any) => {
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
      changed = true;
      return false;
    }
    return true;
  });
  if (!changed) return undefined;

  // A direct assistant answer with no tool call is not a valid pi-rlm output.
  // Drop all remaining non-tool content so the message becomes empty and can be
  // filtered from future model context.
  const hasToolCall = content.some((part: any) => part?.type === "toolCall");
  return { ...message, content: hasToolCall ? content : [] };
}

function isEmptyAssistantMessage(message: any): boolean {
  return message?.role === "assistant" && Array.isArray(message.content) && message.content.length === 0;
}

export default function piRlmExtension(pi: ExtensionAPI) {
  registerRlmFinalOutputRenderer(pi);
  pi.registerTool(createRlmReplTool(undefined, undefined, ensureSessionContextStore, (output) => emitRlmFinalOutput(pi, output)));

  pi.on("session_start", async (_event, ctx) => {
    await enforceConfiguredRootModel(pi, ctx, false);
    enforceRootTools(pi);
    await ensureSessionContextStore(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    await enforceConfiguredRootModel(pi, ctx, false);
    enforceRootTools(pi);
    await ensureSessionContextStore(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await enforceConfiguredRootModel(pi, ctx, false);
    enforceRootTools(pi);
    await ensureSessionContextStore(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    releaseSessionContextStore(ctx);
  });

  pi.on("context", (event) => {
    const messages = event.messages
      .filter((message: any) => !(message?.role === "custom" && message.customType === RLM_FINAL_OUTPUT_CUSTOM_TYPE))
      .map((message: any) => stripAssistantOutputText(message) ?? message)
      .filter((message: any) => !isEmptyAssistantMessage(message));
    return { messages };
  });

  pi.on("message_end", (event) => {
    const message = stripAssistantOutputText((event as any).message);
    if (!message) return;
    return { message };
  });

  pi.on("agent_end", (event, ctx) => {
    if (!ctx.hasUI) return;
    const outputs = collectRlmFinalOutputs(event.messages as any[]);
    if (outputs.length === 0) return;
    pendingFinalOutputs.push(...outputs);
    scheduleFinalOutputFlush(pi, ctx);
  });

  pi.on("before_provider_request", async (_event, ctx) => {
    await enforceConfiguredRootModel(pi, ctx, true);
    enforceRootTools(pi);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };
    if (shouldExternalizeInput(event.text, event.source)) {
      const { replacement } = await externalizeLargeInput(ctx, event.text);
      return { action: "transform" as const, text: replacement, images: event.images };
    }
    await recordUserInput(ctx, event.text);
    return { action: "continue" as const };
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    await enforceConfiguredRootModel(pi, ctx, true);
    const mode = enforceRootTools(pi);
    const store = await ensureSessionContextStore(ctx);
    const systemPrompt = [
      rootSystemPrompt(ctx.cwd, undefined, mode, rootTools()),
      sessionContextPromptBlock(store),
    ].filter(Boolean).join("\n\n");
    return { systemPrompt };
  });
}
