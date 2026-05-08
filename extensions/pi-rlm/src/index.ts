/**
 * pi-rlm — Pi-native RLM (Recursive Language Model) extension.
 *
 * Public extension entry point. Implementation lives in cohesive modules under src/.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { RLM_TOOL_NAME } from "./constants.js";
import { ROOT_GUIDANCE } from "./guidance.js";
import { createRlmTool } from "./tools.js";

export default function piRlmExtension(pi: ExtensionAPI) {
  pi.registerTool(createRlmTool());

  pi.on("session_start", () => {
    pi.setActiveTools(["bash", "read", "edit", "write", RLM_TOOL_NAME]);
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + ROOT_GUIDANCE,
  }));
}
