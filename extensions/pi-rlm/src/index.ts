/**
 * pi-rlm — Pi-native RLM (Recursive Language Model) extension.
 *
 * Public extension entry point. Implementation lives in cohesive modules under src/.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";

import { REPL_TOOL_NAME, RLM_FINAL_OUTPUT_CUSTOM_TYPE } from "./constants.js";
import { rootSystemPrompt } from "./guidance.js";
import { createRlmReplTool } from "./repl.js";
import {
  ensureSessionContextStore,
  externalizeLargeInput,
  recordUserInput,
  releaseSessionContextStore,
  sessionContextPromptBlock,
  shouldExternalizeInput,
} from "./session-context.js";
import { textOf } from "./utils.js";

const ROOT_MODE = "repl";

function rootTools(): string[] {
  return [REPL_TOOL_NAME];
}

function enforceRootTools(pi: ExtensionAPI): string {
  pi.setActiveTools(rootTools());
  return ROOT_MODE;
}

type PendingFinalOutput = {
  text: string;
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

function rlmFinalText(message: any): string {
  const text = textOf(message?.content).trim();
  const match = text.match(/(?:^|\n)FINAL:\s*\n?([\s\S]*)$/);
  return (match?.[1] ?? text).trim();
}

function collectRlmFinalOutputs(messages: any[]): PendingFinalOutput[] {
  const outputs: PendingFinalOutput[] = [];
  for (const message of messages) {
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== REPL_TOOL_NAME) continue;
    if (message.details?.final !== true) continue;
    const text = rlmFinalText(message);
    if (!text) continue;
    outputs.push({
      text,
      toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
      timestamp: Date.now(),
    });
  }
  return outputs;
}

function registerRlmFinalOutputRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(RLM_FINAL_OUTPUT_CUSTOM_TYPE, (message, _options, theme) => {
    const text = textFromCustomContent(message.content).trim();
    if (!text) return undefined;

    // Use the custom-message palette so the mirrored final output stands apart
    // from tool-success styling and matches VCC-style custom messages.
    const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
    box.addChild(new Text(
      `${theme.fg("customMessageLabel", "✓")} ${theme.fg("customMessageLabel", theme.bold("RLM final output"))}`,
      0,
      0,
    ));
    box.addChild(new Spacer(1));
    box.addChild(new Text(theme.fg("customMessageText", text), 0, 0));
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

export default function piRlmExtension(pi: ExtensionAPI) {
  registerRlmFinalOutputRenderer(pi);
  pi.registerTool(createRlmReplTool(undefined, undefined, ensureSessionContextStore));

  pi.on("session_start", async (_event, ctx) => {
    enforceRootTools(pi);
    await ensureSessionContextStore(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    enforceRootTools(pi);
    await ensureSessionContextStore(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    releaseSessionContextStore(ctx);
  });

  pi.on("context", (event) => {
    return {
      messages: event.messages.filter((message: any) => {
        return !(message?.role === "custom" && message.customType === RLM_FINAL_OUTPUT_CUSTOM_TYPE);
      }),
    };
  });

  pi.on("agent_end", (event, ctx) => {
    if (!ctx.hasUI) return;
    const outputs = collectRlmFinalOutputs(event.messages as any[]);
    if (outputs.length === 0) return;
    pendingFinalOutputs.push(...outputs);
    scheduleFinalOutputFlush(pi, ctx);
  });

  pi.on("before_provider_request", () => {
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
    const mode = enforceRootTools(pi);
    const store = await ensureSessionContextStore(ctx);
    const systemPrompt = [
      rootSystemPrompt(ctx.cwd, undefined, mode, rootTools()),
      sessionContextPromptBlock(store),
    ].filter(Boolean).join("\n\n");
    return { systemPrompt };
  });
}
