/**
 * Plan Mode — Kimi Code-style read-only planning mode.
 *
 * Kimi's plan mode is a permission guard, not a tool swap, and this mirrors it:
 * - All tools stay available. A guard blocks write/edit to anything except the
 *   current plan file, and blocks task_stop until plan mode is left.
 * - Bash is NOT allowlisted here; it follows the normal permission rules
 *   (pi-kimi permissions module), same as Kimi.
 * - The plan file is the central artifact: the agent writes its plan there, and
 *   the approval prompt on exit offers execute / keep planning / refine.
 * - Execution progress is tracked from the plan's numbered steps via [DONE:n].
 *
 * Toggle with /plan or Ctrl+Alt+P; start in plan mode with --plan.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { extractTodoItems, markCompletedSteps, type TodoItem } from "./plan-mode-utils.js";
import { getPermissionMode } from "./state.js";

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Extract the target path of a write/edit tool call, resolved against cwd. */
function toolPath(input: Record<string, unknown>, cwd: string): string | undefined {
	const p = input.path ?? input.file_path;
	if (typeof p !== "string") return undefined;
	return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
}

export function registerPlanMode(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let planFilePath: string | null = null;
	let executionMode = false;
	let todoItems: TodoItem[] = [];

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function newPlanFilePath(): string {
		const dir = path.join(getAgentDir(), "pi-kimi", "plans");
		fs.mkdirSync(dir, { recursive: true });
		return path.join(dir, `plan-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		executionMode = false;
		todoItems = [];

		if (planModeEnabled) {
			if (!planFilePath) planFilePath = newPlanFilePath();
			ctx.ui.notify(`Plan mode enabled. Only the plan file is writable:\n${planFilePath}`);
		} else {
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		updateStatus(ctx);
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			planFile: planFilePath,
			todos: todoItems,
			executing: executionMode,
		});
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Plan-mode guard: block writes outside the plan file and block task_stop.
	// Bash intentionally goes through the normal permission rules, same as Kimi.
	pi.on("tool_call", async (event, ctx) => {
		if (!planModeEnabled) return;

		if (event.toolName === "write" || event.toolName === "edit") {
			const target = toolPath(event.input as Record<string, unknown>, ctx.cwd);
			if (target && planFilePath && target === planFilePath) return;
			return {
				block: true,
				reason:
					`Plan mode is active. You may only write to the current plan file: ${planFilePath ?? "(no plan file selected yet)"}. ` +
					"Use /plan to leave plan mode before editing other files.",
			};
		}

		if (event.toolName === "task_stop") {
			return {
				block: true,
				reason: "task_stop is not available in plan mode. Use /plan to leave plan mode before stopping a background task.",
			};
		}
	});

	// Filter out stale plan mode context when not in plan mode
	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan/execution context before the agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			// Verbatim from kimi-code's plan-mode-full-reminder.md, with pi tool names
			// (grep/find/ls/read/write/edit, task_stop) and without AskUserQuestion /
			// ExitPlanMode (pi-kimi exits plan mode via the turn-end approval or /plan).
			return {
				message: {
					customType: "plan-mode-context",
					content: `Plan mode is active. You MUST NOT make any edits (with the exception of the current plan file) or otherwise make changes to the system unless a tool request is explicitly approved. Prefer read-only tools. Use bash only when needed; bash follows the normal permission mode and rules. This supersedes any other instructions you have received. task_stop is also blocked in plan mode — leave plan mode first if you need it.

Workflow:
  1. Understand — explore the codebase with grep, find, ls, read.
  2. Design — converge on the best approach; consider trade-offs but aim for a single recommendation.
  3. Review — re-read key files to verify understanding.
  4. Write Plan — modify the plan file with write or edit. Use write if the plan file does not exist yet:
     ${planFilePath ?? "(no plan file selected yet)"}
     Structure it as a numbered list under a "Plan:" header.
  5. Exit — end your turn; the user will be asked to approve the plan.

## Handling multiple approaches
Keep it focused: at most 2-3 meaningfully different approaches. Do NOT pad with minor variations — if one approach is clearly superior, just propose that one.

Do NOT attempt to make other changes — just describe what you would do. The user will
be asked to approve the plan before anything is executed.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
					display: false,
				},
			};
		}
	});

	// Track progress after each turn
	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
		}
		persistState();
	});

	// Handle plan completion and the approval prompt
	pi.on("agent_end", async (event, ctx) => {
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
				updateStatus(ctx);
				persistState();
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		// Steps come from the plan file when it exists, else from the last message.
		let planText = "";
		if (planFilePath) {
			try {
				planText = fs.readFileSync(planFilePath, "utf-8");
			} catch {
				// no plan file written yet
			}
		}
		let extracted = extractTodoItems(planText);
		if (extracted.length === 0) {
			const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
			if (lastAssistant) {
				extracted = extractTodoItems(getTextContent(lastAssistant));
			}
		}
		if (extracted.length > 0) {
			todoItems = extracted;
		}

		if (todoItems.length > 0) {
			const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
			pi.sendMessage(
				{
					customType: "plan-todo-list",
					content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}${planFilePath ? `\n\nPlan file: ${planFilePath}` : ""}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		}

		const choice =
			getPermissionMode() === "auto"
				? "Execute the plan (track progress)"
				: await ctx.ui.select("Plan mode - what next?", [
						todoItems.length > 0 ? "Execute the plan (track progress)" : "Execute the plan",
						"Stay in plan mode",
						"Refine the plan",
					]);

		if (choice?.startsWith("Execute")) {
			planModeEnabled = false;
			executionMode = todoItems.length > 0;
			updateStatus(ctx);

			const execMessage =
				todoItems.length > 0
					? `Execute the plan. Start with: ${todoItems[0].text}`
					: `Execute the plan you just created.${planFilePath ? ` The plan is in ${planFilePath}.` : ""}`;
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: execMessage, display: true },
				{ triggerTurn: true },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim());
			}
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();

		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as
			| { data?: { enabled: boolean; planFile?: string | null; todos?: TodoItem[]; executing?: boolean } }
			| undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			planFilePath = planModeEntry.data.planFile ?? planFilePath;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
		}

		if (planModeEnabled && !planFilePath) {
			planFilePath = newPlanFilePath();
		}

		// On resume: re-scan messages after the last execute marker to rebuild completion state
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
		}

		updateStatus(ctx);
	});
}
