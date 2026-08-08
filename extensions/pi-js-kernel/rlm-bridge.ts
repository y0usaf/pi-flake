/**
 * rlm-bridge — the "recursion" surface of the RLM (Recursive Language Model).
 *
 * Exposes the full pi-agents delegation surface as rlm.* bridge handlers —
 * `rlm.run` (async by default), `rlm.panel`, `rlm.loop`, `rlm.answer`,
 * `rlm.peek`, `rlm.list`, `rlm.kill` — that let the
 * calls `await kernel.rlm.run(task, opts)` inside the kernel; this module spawns
 * a literal `pi --mode rpc` child. Async by default: the call returns an
 * admission handle immediately and the child's fulfill-contract answers arrive
 * later as an injected follow-up message (the agent_message delivery).
 *
 * It reuses pi-agents' spawn machinery verbatim via relative imports. The factory
 * wires the same session-scoped composition as pi-agents' index.ts (registry,
 * session state, config loader, createSpawnTools with the inject callback bridged
 * to pi.sendMessage) but eschews the orchestrator, render, and the six
 * root-tool registrations; the loop machinery is reused for rlm.loop.
 *
 * v2 design decision: rlm.run is ASYNC by default. It spawns the child in the
 * background (pi-agents' spawnChild with background=true) and returns an
 * admission handle {childId, done:false, background:true, sessionFile}; the
 * answers arrive via the injected follow-up message (the agent_message
 * delivery), so the parent keeps prompting while children run. {background:false}
 * opts into the old blocking in-cell answers. The rest of the family is
 * blocking by design: rlm.panel (pi-agents hard-errors on panel+background),
 * rlm.loop (bounded by its workflow budget or timeoutSeconds), and
 * rlm.answer/rlm.peek (the ask_parent two-way half). Progress: rlm.list();
 * abort: rlm.kill(id).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { createSpawnTools, type SessionState } from "../pi-agents/spawn.js";
import { createRegistry } from "../pi-agents/registry.js";
import { loadPiAgentsConfig, resolveChildModel } from "../pi-agents/config.js";
import { createLoop, workflowSchema } from "../pi-agents/loop.js";
import { Check as ValueCheck, Errors as ValueErrors } from "@sinclair/typebox/value";
import type { Static } from "@sinclair/typebox";

import type { AgentToolDetails } from "../pi-agents/state.js";

// ---------------------------------------------------------------------------
// Bridge handler interface (the host composition agent depends on this shape)
// ---------------------------------------------------------------------------

export type BridgeHandler = (payload: unknown, ctx: BridgeCtx) => Promise<unknown>;

export interface BridgeCtx {
	cwd: string;
	model: string;
	signal: AbortSignal;
	onUpdate?: (update: { content: { type: "text"; text: string }[]; details?: unknown }) => void;
}

/** Default self-describing contract when the caller omits one. */
const DEFAULT_CONTRACT = [{ prompt: "What did you do and what is the result?" }];

/** Minimal, fixed executor system prompt. The task itself carries the instructions. */
const CHILD_SYSTEM_PROMPT =
	"You are a child agent spawned from a JavaScript kernel. Apply the task, then submit your answers.";

// ---------------------------------------------------------------------------
// Factory: wire the session-scoped machinery and return the rlm.* handlers.
// ---------------------------------------------------------------------------

export function createRlmBridge(pi: ExtensionAPI): {
	run: BridgeHandler;
	panel: BridgeHandler;
	loop: BridgeHandler;
	answer: BridgeHandler;
	peek: BridgeHandler;
	list: BridgeHandler;
	kill: BridgeHandler;
} {
	// Session-level state shared with the spawn machinery via the session object,
	// exactly as pi-agents' index.ts does.
	const session: SessionState = {
		cachedGetApiKey: undefined,
		cachedRegistry: undefined,
		configCache: undefined,
		sessionTheme: undefined,
	};

	const registry = createRegistry();

	/** Monotonic counter for generated child ids (rlm-N / rlm-panel-N). */
	let idCounter = 0;

	/** Memoized, cwd-keyed config promise (config.model overrides the child model). */
	function getConfig(cwd: string): Promise<Awaited<ReturnType<typeof loadPiAgentsConfig>>> {
		if (session.configCache?.cwd !== cwd) session.configCache = { cwd, promise: loadPiAgentsConfig(cwd) };
		return session.configCache.promise;
	}

	function adoptSessionContext(ctx: { modelRegistry: NonNullable<SessionState["cachedRegistry"]> }): void {
		session.cachedRegistry ??= ctx.modelRegistry;
		session.cachedGetApiKey ??= (provider: string) => ctx.modelRegistry.getApiKeyForProvider(provider);
	}

	// The host owns the pi handle: the spawn machinery's inject callback is wired
	// to pi.sendMessage so background completions use it as the delivery mechanism.
	const spawn = createSpawnTools({
		registry,
		session,
		getConfig,
		inject: (delivery) => {
			try {
				pi.sendMessage(
					{ customType: "pi-agents", content: delivery.content, display: true },
					{ deliverAs: delivery.deliverAs, triggerTurn: delivery.triggerTurn },
				);
			} catch (err) {
				console.error(`[pi-js-kernel:rlm] failed to inject background message: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	// rlm.loop reuses pi-agents' workflow interpreter (goal / doer / check /
	// strategy / converge / budget) — the same machinery pi-workflow's /workflow
	// command reaches only by instructing the main session to call agent_loop.
	const loopTools = createLoop({ spawn, registry, getConfig });

	// Adopt context at session start (model registry + api-key resolver) and tear
	// down the registry at shutdown, mirroring pi-agents' index.ts.
	pi.on("session_start", async (_event, ctx) => {
		session.configCache = undefined;
		session.sessionTheme = ctx.ui.theme;
		adoptSessionContext(ctx);
		try {
			const config = await getConfig(ctx.cwd);
			if (config.model) resolveChildModel(config.model, ctx.modelRegistry);
		} catch (err) {
			if (ctx.hasUI) ctx.ui.notify(`pi-agents config error: ${(err as Error).message}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		session.configCache = undefined;
		await registry.shutdown();
	});

	/** Resolve a model spec ("provider/modelId" or bare id) against the session registry. Throws on failure. */
	function resolveModel(spec: string): Model<any> {
		if (!session.cachedRegistry) {
			throw new Error(`rlm: model registry is not available (no session has started).`);
		}
		return resolveChildModel(spec, session.cachedRegistry);
	}

	const extractText = (result: AgentToolResult<unknown>): string => {
		const first = result.content[0];
		return first?.type === "text" ? first.text : "";
	};

	// -----------------------------------------------------------------------
	// rlm.run
	// -----------------------------------------------------------------------
	async function run(payload: unknown, ctx: BridgeCtx): Promise<unknown> {
		const p = (payload ?? {}) as Record<string, unknown>;
		const task = typeof p.task === "string" ? p.task.trim() : "";
		if (!task) throw new Error("rlm.run: `task` is required and must be a non-empty string");

		const name = typeof p.name === "string" && p.name.length > 0 ? p.name : undefined;
		const id = name ?? `rlm-${++idCounter}`;

		const rawContract = p.contract;
		const contract = Array.isArray(rawContract) && rawContract.length > 0 ? rawContract : DEFAULT_CONTRACT;

		const timeoutSeconds = typeof p.timeoutSeconds === "number" ? p.timeoutSeconds : undefined;

		// Async by default: spawn detached and return the admission handle; the
		// injected follow-up message (the agent_message delivery) carries the
		// contract answers later. Pass {background: false} to block in-cell.
		const background = p.background !== false;

		const spec = typeof p.model === "string" && p.model.length > 0 ? p.model : ctx.model;
		const model = resolveModel(spec);

		const params = {
			id,
			system_prompt: CHILD_SYSTEM_PROMPT,
			task,
			contract,
			timeout_seconds: timeoutSeconds,
		};

		// BridgeCtx.onUpdate is a looser structural type than the AgentToolResult
		// callback spawnChild expects; the runtime payload satisfies the tighter
		// one, so assert the cast once here.
		const onUpdate = ctx.onUpdate as ((partialResult: AgentToolResult<AgentToolDetails>) => void) | undefined;

		// spawnChild with background=true returns the admission handle immediately
		// (runDetached drives the child; completion is announced via the inject
		// callback → pi.sendMessage follow-up). background=false awaits the child
		// fulfilling its contract in-cell; the child's timeout_seconds is the bound.
		const result = await spawn.spawnChild(
			undefined,
			params,
			model,
			ctx.cwd,
			ctx.signal,
			onUpdate,
			undefined,
			undefined,
			background,
		);

		if (background) {
			// Admission handle: child runs detached. Poll rlm.list() for progress;
			// the answers arrive as an injected follow-up message.
			return {
				text: extractText(result),
				childId: result.details?.childId,
				done: false,
				background: true,
				sessionFile: result.details?.sessionFile,
			};
		}

		return {
			text: extractText(result),
			answers: result.details?.answers,
			details: result.details,
		};
	}

	// -----------------------------------------------------------------------
	// rlm.panel
	// -----------------------------------------------------------------------
	// Blocking multi-model delegation: N independent children (2-5) answer the
	// same contract on different models; the result is an agreement tally.
	// Model diversity is the point — N clones of one model agree because they
	// are the same function. pi-agents hard-errors on panel + background, so
	// there is no async mode here.
	async function panel(payload: unknown, ctx: BridgeCtx): Promise<unknown> {
		const p = (payload ?? {}) as Record<string, unknown>;
		const task = typeof p.task === "string" ? p.task.trim() : "";
		if (!task) throw new Error("rlm.panel: `task` is required and must be a non-empty string");

		const name = typeof p.name === "string" && p.name.length > 0 ? p.name : undefined;
		const id = name ?? `rlm-panel-${++idCounter}`;

		const rawContract = p.contract;
		const contract = Array.isArray(rawContract) && rawContract.length > 0 ? rawContract : DEFAULT_CONTRACT;

		const timeoutSeconds = typeof p.timeoutSeconds === "number" ? p.timeoutSeconds : undefined;
		const spec = typeof p.model === "string" && p.model.length > 0 ? p.model : ctx.model;
		const model = resolveModel(spec);

		const params = {
			id,
			system_prompt: CHILD_SYSTEM_PROMPT,
			task,
			contract,
			timeout_seconds: timeoutSeconds,
			panel: {
				...(typeof p.size === "number" ? { size: p.size } : {}),
				...(Array.isArray(p.models) && p.models.length > 0 ? { models: p.models as string[] } : {}),
			},
		};

		const onUpdate = ctx.onUpdate as ((partialResult: AgentToolResult<AgentToolDetails>) => void) | undefined;
		const result = await spawn.spawnPanel(undefined, params, model, ctx.cwd, ctx.signal, onUpdate);
		return {
			text: extractText(result),
			panel: result.details?.panel,
			details: result.details,
		};
	}

	// -----------------------------------------------------------------------
	// rlm.loop
	// -----------------------------------------------------------------------
	// Blocking declarative workflow: goal / doer / check / strategy / converge /
	// budget — the same workflow JSON pi-workflow reads from ~/.pi/workflows/.
	// Bounded by the workflow's own budget (maxGenerations / maxSpawns).
	// timeoutSeconds (optional) aborts the loop's children via an internal
	// AbortController — a divergence from pi-agents' agent_loop, which declares
	// timeout_seconds in its schema but never enforces it.
	async function loop(payload: unknown, ctx: BridgeCtx): Promise<unknown> {
		const p = (payload ?? {}) as Record<string, unknown>;
		const workflow = p.workflow;
		if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
			throw new Error("rlm.loop: `workflow` is required and must be an object (goal/doer/check/strategy/converge/budget)");
		}
		if (!ValueCheck(workflowSchema, workflow)) {
			const problems = [...ValueErrors(workflowSchema, workflow)]
				.slice(0, 3)
				.map((e) => `${e.path}: ${e.message}`)
				.join("; ");
			throw new Error(`rlm.loop: workflow does not match the agent_loop schema — ${problems}`);
		}

		const timeoutSeconds = typeof p.timeoutSeconds === "number" ? p.timeoutSeconds : undefined;
		const spec = typeof p.model === "string" && p.model.length > 0 ? p.model : ctx.model;
		const model = resolveModel(spec);
		const onUpdate = ctx.onUpdate as ((partialResult: AgentToolResult<AgentToolDetails>) => void) | undefined;

		// Own AbortController, not ctx.signal: the js execution's abort kills the
		// kernel, so a loop timeout must abort only the loop's children.
		const controller = new AbortController();
		const run = loopTools.runWorkflow(workflow as Static<typeof workflowSchema>, model, ctx.cwd, controller.signal, onUpdate);

		if (timeoutSeconds === undefined) {
			const result = await run;
			return { text: extractText(result), details: result.details };
		}
		if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
			throw new Error("rlm.loop: timeoutSeconds must be a finite number greater than 0");
		}
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutSeconds * 1000);
		try {
			const result = await run;
			return { text: extractText(result), details: result.details };
		} catch (err) {
			if (timedOut) throw new Error(`rlm.loop: timed out after ${timeoutSeconds}s — loop aborted (children killed)`);
			throw err;
		} finally {
			clearTimeout(timer);
		}
	}

	// -----------------------------------------------------------------------
	// rlm.answer / rlm.peek — the ask_parent half of the contract paradigm
	// -----------------------------------------------------------------------
	// A child that calls ask_parent suspends (background children inject an
	// urgent steer message). rlm.peek shows its pending questions; rlm.answer
	// validates answers against them and resumes the child — background children
	// go detached again and report via an injected follow-up, blocking ones
	// (background:false) resolve in-cell.
	async function answer(payload: unknown, ctx: BridgeCtx): Promise<unknown> {
		const p = (payload ?? {}) as Record<string, unknown>;
		const id = typeof p.id === "string" && p.id.length > 0 ? p.id : "";
		if (!id) throw new Error("rlm.answer: `id` is required and must be a non-empty string");
		const answers = (Array.isArray(p.answers) ? p.answers : []) as Array<{ id: string; value: string }>;
		if (answers.length === 0) throw new Error("rlm.answer: `answers` is required and must be a non-empty array of {id, value}");
		const timeoutSeconds = typeof p.timeoutSeconds === "number" ? p.timeoutSeconds : undefined;
		const onUpdate = ctx.onUpdate as ((partialResult: AgentToolResult<AgentToolDetails>) => void) | undefined;
		const result = await spawn.answerAgent(
			undefined,
			{ id, answers, ...(timeoutSeconds !== undefined ? { timeout_seconds: timeoutSeconds } : {}) },
			ctx.signal,
			onUpdate,
		);
		return { text: extractText(result), details: result.details };
	}

	async function peek(payload: unknown, _ctx: BridgeCtx): Promise<unknown> {
		const p = (payload ?? {}) as Record<string, unknown>;
		const id = typeof p.id === "string" && p.id.length > 0 ? p.id : "";
		if (!id) throw new Error("rlm.peek: `id` is required and must be a non-empty string");
		return { text: extractText(spawn.outputAgent(undefined, id)) };
	}

	// -----------------------------------------------------------------------
	// rlm.list
	// -----------------------------------------------------------------------

	async function list(payload: unknown, _ctx: BridgeCtx): Promise<unknown> {
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		void payload;
		return { text: extractText(registry.listAgentsResult()) };
	}

	// -----------------------------------------------------------------------
	// rlm.kill
	// -----------------------------------------------------------------------
	async function kill(payload: unknown, _ctx: BridgeCtx): Promise<unknown> {
		const p = (payload ?? {}) as Record<string, unknown>;
		const id = typeof p.id === "string" && p.id.length > 0 ? p.id : "";
		if (!id) throw new Error("rlm.kill: `id` is required and must be a non-empty string");
		return { text: extractText(spawn.killAgentResult(undefined, id)) };
	}

	return { run, panel, loop, answer, peek, list, kill };
}
