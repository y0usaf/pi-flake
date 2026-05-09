/**
 * pi-rlm — Pi-native RLM (Recursive Language Model) extension.
 *
 * Public extension entry point. Implementation lives in cohesive modules under src/.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { REPL_TOOL_NAME, RLM_TOOL_NAME } from "./constants.js";
import { rootSystemPrompt } from "./guidance.js";
import { createRlmReplTool } from "./repl.js";
import { createRlmTool } from "./tools.js";

type RootMode = "hybrid" | "repl" | "rlm" | "classic";

function rootMode(): RootMode {
  const raw = process.env.PI_RLM_ROOT_MODE?.toLowerCase().trim();
  if (raw === "classic" || raw === "tools" || raw === "default") return "classic";
  if (raw === "repl" || raw === "repl-only") return "repl";
  if (raw === "rlm" || raw === "rlm-only") return "rlm";
  return "hybrid";
}

function rootTools(mode: RootMode): string[] {
  if (mode === "classic") return ["bash", "read", "edit", "write", REPL_TOOL_NAME, RLM_TOOL_NAME];
  if (mode === "repl") return [REPL_TOOL_NAME];
  if (mode === "rlm") return [RLM_TOOL_NAME];
  return [REPL_TOOL_NAME, RLM_TOOL_NAME];
}

function enforceRootTools(pi: ExtensionAPI): RootMode {
  const mode = rootMode();
  pi.setActiveTools(rootTools(mode));
  return mode;
}

export default function piRlmExtension(pi: ExtensionAPI) {
  pi.registerTool(createRlmTool());
  pi.registerTool(createRlmReplTool());

  for (const event of ["session_start", "session_tree", "before_provider_request"] as const) {
    pi.on(event, () => {
      enforceRootTools(pi);
    });
  }

  pi.on("before_agent_start", (_event, ctx) => {
    const mode = enforceRootTools(pi);
    return { systemPrompt: rootSystemPrompt(ctx.cwd, undefined, mode, rootTools(mode)) };
  });
}
