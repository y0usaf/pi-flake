/**
 * pi-workflow — /workflow command.
 *
 * Lists installed agent_loop workflows from ~/.pi/workflows/*.json, shows a
 * picker, and runs the chosen one.
 *
 * Goal input at run time:
 *   /workflow NAME GOAL...   everything after the name becomes the goal
 *   /workflow NAME           keep the file's goal, or prompt if it is missing
 *                            or a "PLACEHOLDER: ..." stub
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
const PLACEHOLDER_PREFIX = "placeholder";

async function listWorkflows(): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(WORKFLOW_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort();
}

/** True when the file goal is a "PLACEHOLDER: ..." stub, i.e. needs run-time input. */
function isPlaceholderGoal(goal: string): boolean {
  return goal.trim().toLowerCase().startsWith(PLACEHOLDER_PREFIX);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("workflow", {
    description:
      "Pick an installed workflow (~/.pi/workflows/*.json) and run it via agent_loop; pass the goal after the name",
    handler: async (args, ctx) => {
      const workflows = await listWorkflows();

      const [nameArg, ...goalWords] = (args ?? "").trim().split(/\s+/);
      const goalArg = goalWords.join(" ").trim();

      let chosen: string | undefined;
      if (nameArg) {
        chosen = workflows.find((w) => w === nameArg || w === `${nameArg}.json`);
        if (!chosen) {
          ctx.ui.notify(`No workflow named "${nameArg}" in ${WORKFLOW_DIR}`, "error");
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
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text);
      } catch {
        ctx.ui.notify(`${chosen} is not valid JSON`, "error");
        return;
      }

      // Goal precedence: args override > file goal > prompt (TUI) / error (non-TUI).
      const fileGoal = typeof parsed.goal === "string" ? parsed.goal.trim() : "";
      let goal = goalArg || fileGoal;
      if (!goalArg && (!fileGoal || isPlaceholderGoal(fileGoal))) {
        if (ctx.mode !== "tui") {
          ctx.ui.notify(
            `${chosen} has no usable goal; pass one: /workflow ${chosen.replace(/\.json$/, "")} <your goal>`,
            "error",
          );
          return;
        }
        const entered = await ctx.ui.input("Workflow goal:", isPlaceholderGoal(fileGoal) ? "" : fileGoal);
        if (!entered) return;
        goal = entered.trim();
      }
      if (goal && goal !== fileGoal) parsed.goal = goal;

      const pretty = JSON.stringify(parsed, null, 2);

      await ctx.waitForIdle();
      pi.sendUserMessage(
        `Run agent_loop with this workflow (from ${chosen}):\n\`\`\`json\n${pretty}\n\`\`\``,
      );
      ctx.ui.notify(`Workflow ${chosen} queued`, "info");
    },
  });
}
