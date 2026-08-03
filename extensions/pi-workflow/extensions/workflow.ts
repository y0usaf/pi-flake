/**
 * pi-workflow — /workflow command.
 *
 * Lists installed agent_loop workflows from ~/.pi/workflows/*.json, shows a
 * picker, and runs the chosen one.
 *
 * Mechanism: an extension cannot invoke the main-session agent_loop tool
 * directly (it lives in the main agent's toolset, not the extension API).
 * The sanctioned bridge (docs/extensions.md, the reload example) is
 * pi.sendUserMessage(): the command injects a user message instructing the
 * main agent to run the workflow with its own agent_loop tool.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const WORKFLOW_DIR = join(homedir(), ".pi", "workflows");

async function listWorkflows(): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(WORKFLOW_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort();
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("workflow", {
    description:
      "Pick an installed workflow (~/.pi/workflows/*.json) and run it via agent_loop",
    handler: async (args, ctx) => {
      const workflows = await listWorkflows();

      let chosen: string | undefined;
      if (args && args.trim()) {
        const want = args.trim();
        chosen = workflows.find((w) => w === want || w === `${want}.json`);
        if (!chosen) {
          ctx.ui.notify(`No workflow named "${want}" in ${WORKFLOW_DIR}`, "error");
          return;
        }
      } else {
        if (workflows.length === 0) {
          ctx.ui.notify(`No workflows installed in ${WORKFLOW_DIR}`, "info");
          return;
        }
        if (ctx.mode !== "tui") {
          ctx.ui.notify("Workflow picker needs TUI mode; pass a workflow name instead", "info");
          return;
        }
        chosen = await ctx.ui.select(
          "Pick a workflow:",
          workflows.map((w) => w.replace(/\.json$/, "")),
        );
        if (!chosen) return;
        chosen = `${chosen}.json`;
      }

      const text = await readFile(join(WORKFLOW_DIR, chosen), "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        ctx.ui.notify(`${chosen} is not valid JSON`, "error");
        return;
      }
      const pretty = JSON.stringify(parsed, null, 2);

      await ctx.waitForIdle();
      pi.sendUserMessage(
        `Run agent_loop with this workflow (from ${chosen}):\n\`\`\`json\n${pretty}\n\`\`\``,
      );
      ctx.ui.notify(`Workflow ${chosen} queued`, "info");
    },
  });
}