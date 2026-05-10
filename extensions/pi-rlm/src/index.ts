/**
 * pi-rlm — Pi-native RLM (Recursive Language Model) extension.
 *
 * Public extension entry point. Implementation lives in cohesive modules under src/.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { REPL_TOOL_NAME } from "./constants.js";
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

const ROOT_MODE = "repl";

function rootTools(): string[] {
  return [REPL_TOOL_NAME];
}

function enforceRootTools(pi: ExtensionAPI): string {
  pi.setActiveTools(rootTools());
  return ROOT_MODE;
}

export default function piRlmExtension(pi: ExtensionAPI) {
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
