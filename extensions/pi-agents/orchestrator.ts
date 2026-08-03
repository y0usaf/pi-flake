/**
 * pi-agents orchestrator mode module: the ORCHESTRATOR_* constants,
 * applyOrchestrator, the /orchestrate command, and the before_agent_start gate
 * hook, assembled per session by createOrchestrator(pi). Per DESIGN.md:
 * "Orchestrator mode: the main session delegates mutations" (decision-making).
 *
 * The orchestratorOn / toolsBeforeOrchestrator state lives in the per-session
 * factory closure created inside multiAgent(); no module-level state, so
 * multiple sessions stay isolated.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ORCHESTRATOR_STRIPPED = new Set(["write", "edit", "bash"]);
/** pi registers these built-ins but leaves them inactive; orchestrator mode turns them on. */
const ORCHESTRATOR_ADDED = ["grep", "find", "ls"];

const ORCHESTRATOR_GATE =
	"ORCHESTRATOR MODE: write, edit, and bash are unavailable. You cannot mutate files, run builds or tests, " +
	"or inspect git — spawn an executor via agent for any of it. read, grep, find, and ls are yours: " +
	"use them to ground the contracts you write.";

export interface OrchestratorTools {
	applyOrchestrator: (on: boolean, ctx: { hasUI: boolean; ui: any }) => void;
	/** session_start reset: orchestrator off and no saved tool set. */
	resetOrchestrator: () => void;
}

export function createOrchestrator(pi: ExtensionAPI): OrchestratorTools {
	let orchestratorOn = false;
	let toolsBeforeOrchestrator: string[] | undefined;

	pi.on("before_agent_start", async (event) => {
		if (!orchestratorOn) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATOR_GATE}` };
	});

	function applyOrchestrator(on: boolean, ctx: { hasUI: boolean; ui: any }): void {
		if (on === orchestratorOn) return;
		orchestratorOn = on;
		if (on) {
			toolsBeforeOrchestrator ??= pi.getActiveTools();
			pi.setActiveTools([...toolsBeforeOrchestrator.filter((name) => !ORCHESTRATOR_STRIPPED.has(name)), ...ORCHESTRATOR_ADDED]);
		} else {
			if (toolsBeforeOrchestrator) pi.setActiveTools(toolsBeforeOrchestrator);
			toolsBeforeOrchestrator = undefined;
		}
		if (ctx.hasUI) ctx.ui.setStatus("pi-agents", on ? "orchestrator" : undefined);
	}

	function resetOrchestrator(): void {
		orchestratorOn = false;
		toolsBeforeOrchestrator = undefined;
	}

	pi.registerCommand("orchestrate", {
		description: "Toggle orchestrator mode (strip write/edit/bash, add grep/find/ls; delegate mutations via agent)",
		handler: async (_args, ctx) => {
			applyOrchestrator(!orchestratorOn, ctx);
			if (ctx.hasUI) {
				ctx.ui.notify(
					orchestratorOn
						? "Orchestrator mode on: write/edit/bash stripped, grep/find/ls added; delegate mutations, builds, and git via agent."
						: "Orchestrator mode off: write/edit/bash restored.",
					"info",
				);
			}
		},
	});

	return { applyOrchestrator, resetOrchestrator };
}
