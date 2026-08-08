/**
 * rlm-bridge — the "recursion" surface of the RLM (Recursive Language Model).
 *
 * Exposes three bridge handlers (`rlm.run`, `rlm.list`, `rlm.kill`) that let the
 * persistent JS kernel spawn child agents, list them, and kill them. The model
 * calls `await kernel.rlm.run(task, opts)` inside the kernel; this module spawns
 * a literal `pi --mode rpc` child. Async by default: the call returns an
 * admission handle immediately and the child's fulfill-contract answers arrive
 * later as an injected follow-up message (the agent_message delivery).
 *
 * It reuses pi-agents' spawn machinery verbatim via relative imports. The factory
 * wires the same session-scoped composition as pi-agents' index.ts (registry,
 * session state, config loader, createSpawnTools with the inject callback bridged
 * to pi.sendMessage) but eschews the orchestrator, loop, render, and the six
 * root-tool registrations — only the spawn machinery and registry are needed here.
 *
 * v2 design decision: rlm.run is ASYNC by default. It spawns the child in the
 * background (pi-agents' spawnChild with background=true) and returns an
 * admission handle {childId, done:false, background:true, sessionFile}; the
 * answers arrive via the injected follow-up message (the agent_message
 * delivery), so the parent keeps prompting while children run. {background:false}
 * opts into the old blocking in-cell answers. Progress: rlm.list(); abort: rlm.kill(id).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { createSpawnTools, type SessionState } from "../pi-agents/spawn.js";
import { createRegistry } from "../pi-agents/registry.js";
import { loadPiAgentsConfig, resolveChildModel } from "../pi-agents/config.js";
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
// Factory: wire the session-scoped machinery and return the three handlers.
// ---------------------------------------------------------------------------

export function createRlmBridge(pi: ExtensionAPI): {
	run: BridgeHandler;
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

	/** Monotonic counter for generated child ids (rlm-N). */
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
			throw new Error(`rlm.run: model registry is not available (no session has started).`);
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

	return { run, list, kill };
}
