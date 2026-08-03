/**
 * Multi-Agent Extension for pi
 *
 * Parent tools: agent, agent_answer, agent_kill, agent_list, agent_loop.
 * Children additionally get pi's built-in read/write/edit/bash tools, a
 * progress-only report tool, a submit_answers tool, and descendant-scoped
 * orchestration tools when maxDepth allows further nesting.
 *
 * Every spawn carries an AskUserQuestion-style contract (questions,
 * options, allowOther). The run completes only after the child calls
 * submit_answers; the tool result is those answers as data. Enforcement is a
 * re-prompt loop capped at MAX_CONTRACT_NUDGES.
 *
 * An agent's lifetime is its contract: agent blocks until the child
 * fulfills it, returns the answers as data, and removes the child — a typed
 * function call. If it calls ask_parent, this call returns its questions and
 * the agent stays alive until agent_answer or agent_kill. Multiple calls in one turn run concurrently.
 *
 * This file is the composition root: it owns the default-export multiAgent(),
 * the per-session state (registry, session, config loader), the wiring that
 * passes that state down to the registry/spawn/loop/orchestrator modules, the
 * five root-tool registrations, and the session_start/session_shutdown
 * handlers. All machinery lives in its own module (see DESIGN.md Architecture).
 *
 * Concurrency invariants (see DESIGN.md):
 * - Spawn capacity and ID uniqueness are reserved synchronously before any
 *   await, so parallel agent calls cannot both pass the checks.
 * - killSubtree marks states killed and aborts them, but only removes states
 *   with no active run. A running spawn removes its own state in its
 *   finally block once the prompt has settled, so no work continues against
 *   an unregistered agent.
 * - Teardown is identity-checked: callers only remove the exact ChildState
 *   they operated on, never a same-ID replacement.
 */

import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	formatAgentAnswerLines,
	renderAgentCall,
	renderAgentResult,
	termBudget,
} from "./render.js";
import { loadPiAgentsConfig, resolveChildModel, type PiAgentsConfig } from "./config.js";
import { createRegistry } from "./registry.js";
import {
	createSpawnTools,
	answerAgentSchema,
	killSchema,
	listSchema,
	spawnSchema,
	type SessionState,
} from "./spawn.js";
import { createLoop, agentLoopSchema } from "./loop.js";
import { createOrchestrator } from "./orchestrator.js";

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function multiAgent(pi: ExtensionAPI) {
	// Session-level state, shared with the spawn machinery via the session
	// object: cachedGetApiKey and cachedRegistry are initialized from the
	// first ctx we see. This assumes modelRegistry is stable for the session
	// lifetime. Loading the config promise (configCache) memoizes success and
	// failure alike: a rejected promise rethrows on every await. The theme at
	// the last session start / tool execute styles child activity labels
	// created in subscribeChild.
	const session: SessionState = {
		cachedGetApiKey: undefined,
		cachedRegistry: undefined,
		configCache: undefined,
		sessionTheme: undefined,
	};

	const registry = createRegistry();

	function getConfig(cwd: string): Promise<PiAgentsConfig> {
		if (session.configCache?.cwd !== cwd) session.configCache = { cwd, promise: loadPiAgentsConfig(cwd) };
		return session.configCache.promise;
	}

	function adoptSessionContext(ctx: { modelRegistry: ModelRegistry }): void {
		session.cachedRegistry ??= ctx.modelRegistry;
		session.cachedGetApiKey ??= (provider: string) => ctx.modelRegistry.getApiKeyForProvider(provider);
	}

	const spawn = createSpawnTools({ registry, session, getConfig });
	const loop = createLoop({ spawn, registry, getConfig });
	const { applyOrchestrator, resetOrchestrator } = createOrchestrator(pi);

	pi.on("session_start", async (_event, ctx) => {
		session.configCache = undefined;
		resetOrchestrator();
		session.sessionTheme = ctx.ui.theme;
		adoptSessionContext(ctx);
		try {
			const config = await getConfig(ctx.cwd);
			if (config.model) resolveChildModel(config.model, ctx.modelRegistry);
			for (const spec of config.panelModels ?? []) resolveChildModel(spec, ctx.modelRegistry);
			if (config.orchestrator) applyOrchestrator(true, ctx);
		} catch (err) {
			if (ctx.hasUI) {
				ctx.ui.notify(`pi-agents config error: ${(err as Error).message}`, "error");
			}
		}
	});

	pi.on("session_shutdown", async () => {
		session.configCache = undefined;
		await registry.shutdown();
	});

	const renderTextResult = (result: AgentToolResult<unknown>) => {
		const first = result.content[0];
		return new Text(first?.type === "text" ? first.text : "done", 0, 0);
	};

	// ── agent ───────────────────────────────────────────────────────────

	pi.registerTool({
		name: "agent",
		label: "Agent",
		description:
			"Spawn a child agent with its own system prompt, task, and contract. Pass `panel` to get a second opinion instead of judging alone: N independent children answer the same contract on different models and the result is an agreement tally. " +
			"The contract is the child's deliverable: AskUserQuestion-style questions the child must answer " +
			"via its submit_answers tool before its run can end; the tool result is those answers as data. " +
			"Children get read, write, edit, bash, report (progress only), and submit_answers; descendant-scoped orchestration tools are included only when maxDepth allows further nesting. " +
			"Recursive spawning is bounded by pi-agents.json maxDepth/maxLiveAgents, which also picks the child model. " +
			"This call blocks until the contract is fulfilled; an unfulfilled contract is nudged up to 10 times, then errors. " +
			"Multiple agent calls in the same turn run concurrently. " +
			"The agent is removed as soon as its contract is fulfilled — this is a typed function call: " +
			"If the child calls ask_parent instead, this call returns its questions and the agent stays alive (holding context and a maxLiveAgents slot) until agent_answer resumes it or agent_kill removes it. " +
			"contract in, answers out, agent gone. Follow-ups are new spawns with the prior answers folded into the task. " +
			"agent_kill aborts a running agent. " +
			"On any error (including timeout) the agent subtree is removed from the registry automatically. " +
			"Use proactively for parallel read-only scouting, and in orchestrator mode for every file mutation. When `panelModels` is configured, omit the panel model list and call `panel: {}`; otherwise pass an explicit `models` list.",
		parameters: spawnSchema,
		promptGuidelines: [
			"In orchestrator mode the main session has no write, edit, or bash: every file mutation, build, test, and git inspection goes through a spawned executor, and its contract answers are the only report you get. read/grep/find/ls are available — ground your contracts with them before spawning.",
			'Minimal executor spawn: agent({ id: "executor-1", system_prompt: "You are an executor. Apply the requested change, verify it, then submit your answers.", task: "<the change>", contract: [{ prompt: "What changed, and how was it verified?" }] }).',
			'Minimal scout spawn: agent({ id: "scout-1", system_prompt: "You are a read-only scout. Never modify files. Cite file:line evidence.", task: "<the question>", contract: [{ prompt: "Answer, with file:line evidence" }] }).',
			"Fan-out/join goes in ONE assistant turn: emit every independent agent call in the same message and they run concurrently; splitting them across turns serializes them. Give each a distinct id and a contract question that asks for a synthesis-ready answer, then join the answers yourself. Dependent work is the next turn — fold the prior contract's answers into the next spawn's task verbatim rather than re-deriving them.",
			'If a spawn returns questions, answer with agent_answer({ id, answers: [{ id: "<question id>", value: "<answer>" }] }); the call blocks until the contract is fulfilled.',
			"If a previous spawn was interrupted by a host crash or kill there is no resume: re-spawn it with the original task and add that the prior run was interrupted and the working tree may already hold partial work, so the child must check current file state before repeating any mutation.",
			'Do not self-judge a ship/block, safety, or correctness call — get a second opinion. When the decision is a judgment rather than a lookup, invoke a panel: use `panel: {}` when `panelModels` is configured; otherwise pass an explicit `models` list: agent({ id: "panel", system_prompt: "You are an independent reviewer. Judge only what the evidence supports; do not defer to the requester.", task: "<the plan or diff to judge>", contract: [{ prompt: "Ship or block?", options: [{ label: "Ship" }, { label: "Block" }] }, { prompt: "Strongest argument against your own verdict" }], panel: {} }). Consensus is only mechanical on questions with options, so always give the panel an enumerated verdict question. Different models disagree for different reasons; N members on one model mostly agree with each other.'
		],

		renderCall(args, theme) {
			return renderAgentCall("agent", args, theme);
		},

		renderResult(result, options, theme, context) {
			return renderAgentResult(result, options, theme, context);
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const model = ctx.model;
			if (!model) throw new Error("No model selected");

			session.sessionTheme = ctx.ui.theme;
			adoptSessionContext(ctx);
			return params.panel ? await spawn.spawnPanel(undefined, params, model, ctx.cwd, signal, onUpdate) : await spawn.spawnChild(undefined, params, model, ctx.cwd, signal, onUpdate);
		},
	});

	// ── agent_answer ────────────────────────────────────────────────────

	pi.registerTool({
		name: "agent_answer",
		label: "Answer Agent",
		description: "Answer a suspended child agent's questions. Validates answers against the questions it asked, resumes it, and blocks until its contract is fulfilled or it asks again.",
		parameters: answerAgentSchema,
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("agent_answer ")) + theme.fg("accent", args.id || "...") + formatAgentAnswerLines(args.answers, theme, termBudget(2)), 0, 0);
		},
		renderResult(result, options, theme, context) { return renderAgentResult(result, options, theme, context); },
		async execute(_toolCallId, params, signal, onUpdate, ctx) { session.sessionTheme = ctx.ui.theme; return spawn.answerAgent(undefined, params, signal, onUpdate); },
	});

	// ── agent_kill ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "agent_kill",
		label: "Kill Agent",
		description:
			"Kill a child agent and free its resources. " +
			"If the child has descendants, they are killed recursively too.",
		parameters: killSchema,

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("agent_kill ")) + theme.fg("error", args.id || "..."), 0, 0);
		},

		renderResult: renderTextResult,

		async execute(_toolCallId, params) {
			return spawn.killAgentResult(undefined, params.id);
		},
	});

	// ── agent_list ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "agent_list",
		label: "List Agents",
		description: "List all currently active child agent IDs and their status. Includes depth and parent metadata.",
		parameters: listSchema,

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("agent_list")), 0, 0);
		},

		renderResult: renderTextResult,

		async execute() {
			return registry.listAgentsResult();
		},
	});

	// ── agent_loop ─────────────────────────────────────────────────────

	pi.registerTool({
		name: "agent_loop",
		label: "Agent Loop",
		description:
			"Run a deterministic goal-loop: spawn doers toward a goal, validate each candidate against a checker contract, select the best, and iterate until convergence or the hard budget. " +
			"`workflow` is declarative data (goal, doer/checker prompts+contracts, population/survivors strategy, quorum, budget) — no control flow, no expressions. " +
			"population=1 is a plain refine loop; population>1 with survivors is genetic search. " +
			"All spawning reuses the agent/panel machinery: children get the same tools, caps (maxDepth/maxLiveAgents) apply, and agent_kill aborts an in-flight run. " +
			"The doers may run on the cheap configured model while checkers use a panel roster. Progress per generation streams via onUpdate.",
		parameters: agentLoopSchema,
		renderCall(args, theme) {
			const wf = (args as any).workflow ?? {};
			return new Text(theme.fg("toolTitle", theme.bold("agent_loop ")) + theme.fg("accent", (wf.goal ?? "...")) + (wf.strategy ? theme.fg("muted", ` · pop ${wf.strategy.population}`) : ""), 0, 0);
		},
		renderResult: renderTextResult,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			session.sessionTheme = ctx.ui.theme;
			const model = ctx.model;
			if (!model) throw new Error("No model selected");
			return await loop.runWorkflow(params.workflow as any, model, ctx.cwd, signal, onUpdate);
		},
	});
}
