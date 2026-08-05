/**
 * pi-agents spawn machinery module: spawnChild/spawnPanel, the run lifecycle
 * (finishExchange, answerAgent, killAgentResult), the background-spawn
detached drive (runDetached) plus the agent_wait / agent_output query
functions, and the tool schemas they own (spawnSchema, answerAgentSchema,
killSchema, listSchema, waitSchema, outputSchema). Per DESIGN.md:
 * "spawn/kill lifecycle (decision-making)".
 *
 * Since the stage-2 rpc-child rewrite, spawnChild no longer assembles an
 * in-process Agent (buildChildAgent/createChildManagementTools were deleted);
 * it spawns a literal `pi --mode rpc` subprocess via rpc-child.ts and drives
 * it until the contract is fulfilled, the child suspends via ask_parent, or
 * the run errors out.
 *
 * Since stage 3, `background: true` spawns return immediately with a session
 * handle and run detached: the drive loop runs on a promise stored on
 * ChildState.background (agent_wait awaits it / agent_output peeks it). On
 * fulfill/error the result is parked in the registry mailbox and announced by
 * an injected follow-up message; a background ask_parent keeps the child
 * alive and injects an urgent steer message. The inject callback is wired by
 * index.ts to pi.sendMessage; spawn.ts owns the policy (followUp for results,
 * steer for asks, bounded mailbox), index.ts owns the pi handle.
 *
 * createSpawnTools(deps) is invoked inside multiAgent() with the per-session
 * registry, session state, config loader, and inject callback; no
 * module-level state, so multiple sessions stay isolated.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry, Theme } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import {
	UNABLE_VALUE,
	contractAnswersSchema,
	contractSchema,
	normalizeContract,
	renderAnswersBlock,
	renderContractBlock,
	renderQuestionLines,
	validateContractAnswers,
	type ContractBox,
} from "./contract.js";
import { readChildEnv } from "./contract.js";
import {
	collectResult,
	modelDisplay,
	subscribeRpcChild,
	tallyPanel,
	usageToDetails,
	withOptionalTimeout,
	type AgentToolDetails,
	type ChildState,
} from "./state.js";
import { resolveChildModel, type PiAgentsConfig } from "./config.js";
import type { Registry } from "./registry.js";
import { stripControlSequences } from "./render.js";
import { DEFAULT_CHILD_SESSION_DIR, runContract, spawnRpcChild } from "./rpc-child.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const answerAgentSchema = Type.Object({
	id: Type.String({ description: "ID of the suspended child agent whose questions you are answering" }),
	answers: contractAnswersSchema,
	timeout_seconds: Type.Optional(Type.Number({ description: "Maximum wall-clock seconds to wait for the agent to finish (must be > 0). If the deadline expires the agent is aborted, removed from the registry, and an error is thrown." })),
});

const spawnSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for the child agent" }),
	system_prompt: Type.String({ description: "System prompt defining the child agent's role and behavior" }),
	task: Type.String({ description: "Initial task to assign to the child agent" }),
	contract: contractSchema,
	timeout_seconds: Type.Optional(Type.Number({ description: "Maximum wall-clock seconds to wait for the agent to finish (must be > 0). If the deadline expires the agent is aborted, removed from the registry, and an error is thrown. Background children enforce the same deadline (the timeout error is parked and injected as a follow-up message)." })),
	background: Type.Optional(Type.Boolean({ description: "Run this agent in the background: the tool returns immediately with a session handle while the child runs detached. When it fulfills its contract (or errors or times out) its result is parked in the mailbox and a follow-up message announces it; collect the result with agent_wait({ id }) and inspect progress with agent_output({ id }). A background agent that calls ask_parent suspends as usual and injects an urgent message; agent_answer resumes it detached again. Blocking remains the default — background is for runs you do not want to wait on." })),
	panel: Type.Optional(Type.Object({
		size: Type.Optional(Type.Number({ description: "Number of independent panel members (2-5)" })),
		models: Type.Optional(Type.Array(Type.String(), { description: "One model spec per panel member" })),
	}, { description: "Consult a panel: spawn N independent children on this same contract and return an agreement tally. Members get ids <id>-1..N and no ask_parent tool. `models` gives each member its own model spec (\"provider/modelId\" or a bare id); when omitted, the configured `panelModels` roster is used if present, and `panel: {}` is legal and uses the whole roster. Model diversity is the point; N clones of one model agree because they are the same function, not because the answer is right." })),
});

const killSchema = Type.Object({
	id: Type.String({ description: "ID of the child agent to kill" }),
});

const listSchema = Type.Object({});

const waitSchema = Type.Object({
	id: Type.String({ description: "ID of the background agent to wait for" }),
	timeout_seconds: Type.Optional(Type.Number({ description: "Maximum wall-clock seconds to wait for it to settle before failing. Bounds only this wait — the background agent keeps running if the wait expires; call agent_output for status or wait again." })),
});

const outputSchema = Type.Object({
	id: Type.String({ description: "ID of a background agent to inspect" }),
});

// ---------------------------------------------------------------------------
// Session deps
// ---------------------------------------------------------------------------

/**
 * Session-level state held on the composition root's session object so the
 * spawn machinery shares one per-session view of the model registry and theme.
 */
export interface SessionState {
	cachedGetApiKey?: ((provider: string) => Promise<string | undefined>) | undefined;
	cachedRegistry?: ModelRegistry | undefined;
	configCache?: { cwd: string; promise: Promise<PiAgentsConfig> } | undefined;
	sessionTheme?: Theme | undefined;
}

export type SpawnChildFn = (
	callerId: string | undefined,
	params: { id: string; system_prompt: string; task: string; timeout_seconds?: number; contract: unknown },
	model: Model<any>,
	cwd: string,
	signal?: AbortSignal,
	onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void,
	modelOverride?: Model<any>,
	allowAsk?: boolean,
	background?: boolean,
) => Promise<AgentToolResult<AgentToolDetails>>;

export type SpawnPanelFn = (
	callerId: string | undefined,
	params: { id: string; system_prompt: string; task: string; timeout_seconds?: number; contract: unknown; panel?: { size?: number; models?: string[] } },
	model: Model<any>,
	cwd: string,
	signal?: AbortSignal,
	onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void,
) => Promise<AgentToolResult<AgentToolDetails>>;

export type AnswerAgentFn = (
	callerId: string | undefined,
	params: { id: string; answers: Array<{ id: string; value: string }>; timeout_seconds?: number },
	signal?: AbortSignal,
	onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void,
) => Promise<AgentToolResult<AgentToolDetails>>;

export type KillAgentResultFn = (callerId: string | undefined, targetId: string) => AgentToolResult<unknown>;

export type WaitAgentFn = (
	callerId: string | undefined,
	params: { id: string; timeout_seconds?: number },
	signal?: AbortSignal,
	onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void,
) => Promise<AgentToolResult<AgentToolDetails>>;

export type OutputAgentFn = (callerId: string | undefined, targetId: string) => AgentToolResult<AgentToolDetails>;

/** Session message injection (pi.sendMessage), wired from index.ts. */
export type InjectMessageFn = (delivery: { deliverAs: "steer" | "followUp"; triggerTurn: boolean; content: string }) => void;

export interface SpawnDeps {
	registry: Registry;
	session: SessionState;
	getConfig: (cwd: string) => Promise<PiAgentsConfig>;
	/** Injects a custom message into the parent session (pi.sendMessage); owns no pi handle. */
	inject: InjectMessageFn;
}

export interface SpawnTools {
	spawnChild: SpawnChildFn;
	spawnPanel: SpawnPanelFn;
	answerAgent: AnswerAgentFn;
	killAgentResult: KillAgentResultFn;
	waitAgent: WaitAgentFn;
	outputAgent: OutputAgentFn;
}

export function createSpawnTools(deps: SpawnDeps): SpawnTools {
	const { registry, session, getConfig, inject } = deps;

	/** Number of recent activity lines agent_output shows. */
	const MAX_OUTPUT_ACTIVITY = 8;

	/** Deliver a background notification; a failed injection must never surface outside the extension. */
	function tryInject(delivery: Parameters<InjectMessageFn>[0]): void {
		try {
			inject(delivery);
		} catch (err) {
			console.error(`[pi-agents] failed to inject background message: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Handle-shaped result for a background spawn / agent_answer resume ack. */
	function backgroundHandle(state: ChildState, text: string): AgentToolResult<AgentToolDetails> {
		return {
			content: [{ type: "text", text }],
			details: { childId: state.id, model: state.modelDisplay, activity: [], reports: [], done: false, background: true, sessionFile: state.sessionFile },
		};
	}

	/** Park a background completion in the mailbox and announce it via an injected follow-up message. */
	function announceCompletion(state: ChildState, result: AgentToolResult<AgentToolDetails>, errorText?: string): void {
		registry.parkMailbox(state.id, result);
		const first = result.content[0];
		const body = first?.type === "text" ? first.text : "(no message)";
		const lead = errorText
			? `[pi-agents] background agent ${state.id} finished with error`
			: `[pi-agents] background agent ${state.id} finished`;
		tryInject({ deliverAs: "followUp", triggerTurn: true, content: errorText ? `${lead}:\n\n${errorText}` : `${lead}\n\n${body}` });
	}

	/**
	 * Drive a background (detached) child run to settlement and deliver the
	 * outcome. Fulfill/error → park the result in the mailbox + inject a
	 * follow-up message. ask_parent suspension → keep the child alive and inject
	 * an urgent steer message so the parent can reply with agent_answer. Never
	 * rejects: the promise on ChildState.background resolves with the
	 * AgentToolResult, so agent_wait can await it without an unhandled rejection
	 * ever surfacing outside the extension.
	 */
	async function runDetached(state: ChildState, prompt: string, opts: { timeoutSeconds?: number; allowAsk: boolean }): Promise<AgentToolResult<AgentToolDetails>> {
		try {
			const result = await finishExchange(state, prompt, { timeoutSeconds: opts.timeoutSeconds, allowAsk: opts.allowAsk });
			if (state.contract.pendingAsk && !state.errorMessage && !state.killed) {
				const questions = state.contract.pendingAsk;
				const lines = [
					`[pi-agents] background agent ${state.id} asks:`,
					"",
					...renderQuestionLines(questions),
					"",
					`Reply with agent_answer({ id: "${state.id}", answers: [{ id, value }, ...] }) to resume it (it stays detached), or agent_kill("${state.id}") to abandon it.`,
				];
				tryInject({ deliverAs: "steer", triggerTurn: true, content: lines.join("\n") });
				return result;
			}
			announceCompletion(state, result);
			return result;
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			state.errorMessage = errorText;
			const result: AgentToolResult<AgentToolDetails> = {
				content: [{ type: "text", text: `[Error]: ${errorText}` }],
				details: {
					childId: state.id,
					model: state.modelDisplay,
					activity: [...state.activity],
					reports: [...state.reports],
					usage: usageToDetails(state.usage),
					contract: [...state.contract.questions],
					answers: state.contract.answers ? [...state.contract.answers] : undefined,
					error: errorText,
					done: true,
					background: true,
				},
			};
			announceCompletion(state, result, errorText);
			return result;
		}
	}

	/** Combined id list (live children + parked mailbox) for unknown-id errors. */
	function knownAgentIds(): string {
		const ids = new Set<string>();
		for (const [id, state] of registry.children) if (!state.killed) ids.add(id);
		for (const id of registry.mailbox.keys()) ids.add(id);
		return [...ids].sort().join(", ") || "(none)";
	}
	/** The subtree is removed on any error; nothing outlives a failed run. */
	async function finishExchange(state: ChildState, prompt: string, opts: { signal?: AbortSignal; timeoutSeconds?: number; allowAsk: boolean; onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void }): Promise<AgentToolResult<AgentToolDetails>> {
		const engine = state.engine;
		if (!engine) throw new Error(`Agent "${state.id}" has no live RPC process`);
		const onAbort = () => engine.abort();
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		const unsub = subscribeRpcChild(engine, state.id, state, opts.onUpdate, session.sessionTheme);
		try {
			if (state.killed) throw new Error(`Agent "${state.id}" was killed while running`);
			if (opts.signal?.aborted) throw new Error(`Agent "${state.id}" aborted before start`);
			if (engine.exitError) throw engine.exitError;
			await withOptionalTimeout(engine, state.id, runContract(state, { prompt, allowAsk: opts.allowAsk, signal: opts.signal }), opts.timeoutSeconds);
			if (state.killed) throw new Error(`Agent "${state.id}" was killed while running`);
			if (opts.signal?.aborted) throw new Error(`Agent "${state.id}" aborted while running`);
			if (state.errorMessage) throw new Error(state.errorMessage);
			if (engine.exitError) throw engine.exitError;
		}
		catch (err) {
			state.errorMessage = err instanceof Error ? err.message : String(err);
			state.killed = true;
			await engine.stop().catch(() => {});
			registry.killSubtree(state.id);
			throw err;
		}
		finally {
			state.locked = false;
			unsub();
			opts.signal?.removeEventListener("abort", onAbort);
			if (state.killed) registry.removeStateIfCurrent(state);
		}
		const result = collectResult(state.id, state, state.reportCursor);
		state.reportCursor = state.reports.length;
		if (!(state.contract.pendingAsk && !state.errorMessage && !state.killed)) {
			registry.killSubtree(state.id);
			await engine.stop().catch(() => {});
		}
		return result;
	}

	async function spawnChild(
		callerId: string | undefined,
		params: { id: string; system_prompt: string; task: string; timeout_seconds?: number; contract: unknown },
		model: Model<any>,
		cwd: string,
		signal?: AbortSignal,
		onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void,
		modelOverride?: Model<any>,
		allowAsk = true,
		background = false,
	): Promise<AgentToolResult<AgentToolDetails>> {
		if (signal?.aborted) throw new Error(`spawn of "${params.id}" aborted before start`);

		// Reserve ID and capacity synchronously, before any await, so parallel
		// agent calls cannot both pass these checks.
		if (registry.children.has(params.id) || registry.reservedIds.has(params.id)) {
			throw new Error(
				`Child agent "${params.id}" already exists. ` +
				`Choose a different id, or call agent_list() to inspect active agents.`,
			);
		}
		const parentState = callerId ? registry.getCallerState(callerId) : undefined;
		const childDepth = (parentState?.depth ?? 0) + 1;
		const reservedLive = registry.children.size + registry.reservedIds.size;
		registry.reservedIds.add(params.id);

		try {
			const config = await getConfig(cwd);
			// config.model overrides the inherited parent model; unset means inherit.
			const childModel = modelOverride ?? (config.model && session.cachedRegistry ? resolveChildModel(config.model, session.cachedRegistry) : model);
			if (childDepth > config.maxDepth) {
				throw new Error(
					`Cannot spawn agent "${params.id}": depth ${childDepth} exceeds configured maxDepth ${config.maxDepth}.`,
				);
			}
			if (reservedLive >= config.maxLiveAgents) {
				throw new Error(
					`Cannot spawn agent "${params.id}": maxLiveAgents ${config.maxLiveAgents} reached. ` +
					`Answer or kill suspended agents, or kill others.`,
				);
			}

			const contract: ContractBox = { questions: normalizeContract(params.contract, `agent "${params.id}"`) };
			const reports: string[] = [];
			const parentDepth = readChildEnv()?.depth ?? 0;
			const sessionDir = resolve(cwd, config.sessionDir ?? DEFAULT_CHILD_SESSION_DIR);
			const engine = await spawnRpcChild({
				childId: params.id,
				cwd,
				systemPrompt: params.system_prompt,
				model: childModel,
				contract: contract.questions,
				parentDepth,
				sessionDir,
			});
			const state: ChildState = {
				id: params.id,
				parentId: parentState?.id,
				rootId: parentState?.rootId ?? params.id,
				depth: childDepth,
				cwd,
				createdAt: Date.now(),
				engine,
				modelDisplay: modelDisplay(childModel, model),
				modelKey: `${childModel.provider}/${childModel.id}`,
				reports,
				activity: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
				reportCursor: 0,
				askCount: 0,
				nudges: 0,
				contract,
				locked: true,
				killed: false,
				lastAssistantText: "",
				sessionFile: engine.sessionFile,
				panelMember: !allowAsk,
				timeoutSeconds: params.timeout_seconds,
			};
			registry.children.set(params.id, state);
			registry.reservedIds.delete(params.id);

			const prompt = `${params.task}\n\n${renderContractBlock(contract.questions, allowAsk)}`;
			if (background) {
				// Detached: the tool returned a handle already (below); the drive loop
				// runs on a promise that never rejects (an unhandled rejection must
				// never surface outside the extension). No tool signal is passed — the
				// agent tool already returned, so its abort must not kill the child.
				const promise = runDetached(state, prompt, { timeoutSeconds: params.timeout_seconds, allowAsk });
				state.background = { promise };
				promise.catch(() => {}); // belt-and-suspenders; runDetached never rejects.
				return backgroundHandle(state, `spawned in background — session ${state.sessionFile ?? "(not yet recorded)"}`);
			}

			return await finishExchange(state, prompt, { signal, timeoutSeconds: params.timeout_seconds, allowAsk, onUpdate });
		} finally {
			registry.reservedIds.delete(params.id);
		}
	}

	async function spawnPanel(callerId: string | undefined, params: { id: string; system_prompt: string; task: string; timeout_seconds?: number; contract: unknown; panel?: { size?: number; models?: string[] } }, model: Model<any>, cwd: string, signal?: AbortSignal, onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void): Promise<AgentToolResult<AgentToolDetails>> {
		const config = await getConfig(cwd);
		const questions = normalizeContract(params.contract, `panel "${params.id}"`);
		if (questions.every((question) => question.options.filter((option) => option.value !== UNABLE_VALUE).length === 0)) {
			throw new Error(`panel "${params.id}": no enumerated question, so a tally would be meaningless — give the panel at least one question with options, or spawn plain agents in one turn for independent free-text views.`);
		}
		const models = params.panel?.models;
		const size = params.panel?.size;
		if (models && size !== undefined && models.length !== size) throw new Error(`Panel models length ${models.length} does not match size ${size}`);
		let resolvedSpecs = models;
		if (!models && config.panelModels) {
			if (size !== undefined && size > config.panelModels.length) throw new Error(`Panel size ${size} exceeds configured panelModels length ${config.panelModels.length}`);
			resolvedSpecs = size === undefined ? config.panelModels : config.panelModels.slice(0, size);
		}
		const n = resolvedSpecs?.length ?? size;
		if (n === undefined) throw new Error("Panel requires size or models");
		if (!Number.isInteger(n) || n < 2 || n > 5) throw new Error(`Panel size ${n} must be between 2 and 5`);
		if (registry.children.size + registry.reservedIds.size + n > config.maxLiveAgents) throw new Error(`Panel of ${n} exceeds maxLiveAgents cap ${config.maxLiveAgents} (live count ${registry.children.size + registry.reservedIds.size})`);
		if (resolvedSpecs && !session.cachedRegistry) throw new Error("pi-agents: cannot resolve panel models because the model registry is not available");
		// Precedence: explicit per-member models, configured panelModels, configured child model, then inherited parent model.
		const memberModels = resolvedSpecs ? resolvedSpecs.map((spec) => resolveChildModel(spec, session.cachedRegistry as ModelRegistry)) : Array(n).fill(config.model && session.cachedRegistry ? resolveChildModel(config.model, session.cachedRegistry) : model);
		const memberParams = Array.from({ length: n }, (_, i) => ({ ...params, id: `${params.id}-${i + 1}`, panel: undefined }));
		let finished = 0;
		const memberActivity = new Map<string, { actions: number; latest: string; done: boolean }>();
		for (const p of memberParams) memberActivity.set(p.id, { actions: 0, latest: "", done: false });
		const emitActivity = () => {
			if (!onUpdate) return;
			const activity = memberParams.map((p, i) => {
				const state = memberActivity.get(p.id)!;
				const latest = state.latest ? ` — ${state.latest}` : "";
				return {
					type: state.done ? "tool_end" as const : "tool_start" as const,
					label: `${p.id} [${memberModels[i].id}] · ${state.actions} actions${latest}`,
					timestamp: Date.now(),
				};
			});
			onUpdate({ content: [{ type: "text", text: `Panel ${params.id}: ${finished}/${n} members finished` }], details: { childId: params.id, model: undefined, activity, reports: [], done: false } });
		};
		// Each member's spawnChild already aborts its agent on the shared signal.
		let firstFailure: unknown;
		let failureSeen = false;
		let teardownStarted = false;
		const promises = memberParams.map((p, i) => spawnChild(callerId, p, model, cwd, signal, onUpdate ? (partial) => {
			const state = memberActivity.get(p.id)!;
			const activity = partial.details?.activity ?? [];
			state.actions = activity.length;
			state.latest = activity.at(-1)?.label ?? "";
			emitActivity();
		} : undefined, memberModels[i], false).catch((reason: unknown) => {
			if (!teardownStarted) {
				teardownStarted = true;
				firstFailure = reason;
				failureSeen = true;
				for (const other of memberParams) if (other.id !== p.id) registry.killSubtree(other.id);
			}
			throw reason;
		}).finally(() => {
			finished++;
			memberActivity.get(p.id)!.done = true;
			emitActivity();
		}));
		const settled = await Promise.allSettled(promises);
		if (failureSeen) throw new Error(`Panel member failed: ${firstFailure instanceof Error ? firstFailure.message : String(firstFailure)}`);
		const results = settled.map((r) => (r as PromiseFulfilledResult<AgentToolResult<AgentToolDetails>>).value);
		const members = results.map((r, i) => ({ id: memberParams[i].id, model: `${memberModels[i].provider}/${memberModels[i].id}`, answers: r.details?.answers, reports: r.details?.reports ?? [], usage: r.details?.usage }));
		const tally = tallyPanel(questions, members);
		const lines = [`Panel "${params.id}": ${n} members, ${new Set(members.map((m) => m.model)).size} distinct models`];
		if (tally.disagreementCount) lines.unshift(`DISAGREEMENT on ${tally.disagreementCount}/${tally.questions.filter((q) => !q.freeText).length} tallyable question(s)`);
		for (const q of tally.questions) { lines.push(`${q.prompt} — ${q.freeText ? "[free-text — compare manually, not a consensus]" : q.unanimous ? "[unanimous]" : "[split]"}`); for (const g of q.groups) { if (q.freeText) { for (const id of g.memberIds) { const member = members.find((m) => m.id === id); const a = member?.answers?.find((a) => a.id === q.questionId); lines.push(`    ${id} [${member?.model}]: ${stripControlSequences(a ? (a.label ?? a.value) : "no answer")}`); } } else { lines.push(`  ${g.value} (${g.count}): ${g.memberIds.join(", ")} [${g.memberIds.map((id) => members.find((m) => m.id === id)?.model).join(", ")}]`); } } }
		for (const member of members) for (const report of member.reports) lines.push(`  ${member.id}: ${stripControlSequences(report)}`);
		return { content: [{ type: "text", text: lines.join("\n") }], details: { childId: params.id, activity: [], reports: [], contract: questions, done: true, panel: { members, tally } } };
	}

	async function answerAgent(callerId: string | undefined, params: { id: string; answers: Array<{ id: string; value: string }>; timeout_seconds?: number }, signal?: AbortSignal, onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void) {
		if (signal?.aborted) throw new Error(`agent_answer for "${params.id}" aborted before start`);
		const state = registry.getAccessibleTarget(callerId, params.id, "answer", false);
		if (state.locked) throw new Error(`Agent "${params.id}" is busy (a blocking call is in flight).`);
		if (!state.contract.pendingAsk) throw new Error(`Agent "${params.id}" has no pending questions.`);
		const questions = state.contract.pendingAsk;
		const answers = validateContractAnswers(questions, params.answers);
		state.contract.pendingAsk = undefined; state.awaitingSince = undefined; state.locked = true;
		const prompt = renderAnswersBlock(questions, answers, !state.panelMember);
		if (state.background) {
			// Background resume: the child goes detached again; its outcome lands in
			// the mailbox and an injected follow-up message, not in this tool result.
			const resumed = runDetached(state, prompt, { timeoutSeconds: state.timeoutSeconds, allowAsk: !state.panelMember });
			state.background = { promise: resumed };
			resumed.catch(() => {}); // belt-and-suspenders; runDetached never rejects.
			return backgroundHandle(state, `Resumed "${state.id}" in background — it will report back via agent_wait / agent_output when it fulfills its contract, errors, or asks again.`);
		}
		return finishExchange(state, prompt, { signal, timeoutSeconds: params.timeout_seconds, allowAsk: !state.panelMember, onUpdate });
	}

	/** Collect a background agent's result: parked in the mailbox → return immediately; still live → wait for it. */
	async function waitAgent(callerId: string | undefined, params: { id: string; timeout_seconds?: number }, signal?: AbortSignal): Promise<AgentToolResult<AgentToolDetails>> {
		if (signal?.aborted) throw new Error(`agent_wait for "${params.id}" aborted before start`);
		const parked = registry.consumeMailbox(params.id);
		if (parked) return parked;

		let state: ChildState;
		try {
			state = registry.getAccessibleTarget(callerId, params.id, "wait", false);
		} catch {
			throw new Error(`Background agent "${params.id}" not found. Known ids: ${knownAgentIds()}.`);
		}
		if (!state.background) {
			throw new Error(`Agent "${params.id}" is not a background agent — agent_wait waits only for background spawns (agent with background: true). Live agents: ${knownAgentIds()}.`);
		}
		const backgroundPromise = state.background.promise;

		const deadline = params.timeout_seconds;
		if (deadline !== undefined && (!Number.isFinite(deadline) || deadline <= 0)) {
			throw new Error("timeout_seconds must be a finite number greater than 0");
		}
		// Bound only this wait (and honor tool abort); never abort the background
		// child — its own spawn-time timeout is the only thing that kills it.
		const wait = new Promise<AgentToolResult<AgentToolDetails>>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let settled = false;

			function settle(fn: () => void): void {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", settleAbort);
				fn();
			}

			function settleAbort(): void {
				settle(() => reject(new Error(`agent_wait for "${state.id}" aborted while waiting (the background agent keeps running)`)));
			}

			signal?.addEventListener("abort", settleAbort, { once: true });
			if (deadline !== undefined) {
				timer = setTimeout(() => settle(() => reject(new Error(`Timed out waiting for background agent "${state.id}" after ${deadline}s (still running — call agent_output({ id: "${state.id}" }) for status)`))), deadline * 1000);
			}
			backgroundPromise.then((result) => settle(() => resolve(result)));
			if (signal?.aborted) settleAbort();
		});
		const result = await wait;
		// Fulfill/error runs park in the mailbox; the awaited value is authoritative either way.
		return registry.consumeMailbox(params.id) ?? result;
	}

	/** Non-blocking peek at a live background child (works for suspended children too). */
	function outputAgent(callerId: string | undefined, targetId: string): AgentToolResult<AgentToolDetails> {
		const parked = registry.mailbox.get(targetId);
		if (parked) {
			return {
				content: [{ type: "text", text: `Agent "${targetId}" has finished; its result is parked. Call agent_wait({ id: "${targetId}" }) to collect it.` }],
				details: { childId: targetId, activity: [], reports: [], done: false, background: true, peek: true },
			};
		}
		const dropped = registry.droppedMailbox.get(targetId);
		if (dropped) {
			return {
				content: [{ type: "text", text: dropped }],
				details: { childId: targetId, activity: [], reports: [], done: false, peek: true },
			};
		}

		let state: ChildState;
		try {
			state = registry.getAccessibleTarget(callerId, targetId, "inspect", false);
		} catch {
			throw new Error(`Background agent "${targetId}" not found. Known ids: ${knownAgentIds()}.`);
		}
		const background = state.background !== undefined;
		const status = state.locked
			? "running"
			: state.contract.pendingAsk
				? `awaiting answers (${state.contract.pendingAsk.length}q, ${Math.round((Date.now() - (state.awaitingSince ?? Date.now())) / 1000)}s)`
				: "idle";
		const lines = [
			`Agent "${targetId}" — ${status}${background ? " (background)" : ""}`,
			`model: ${state.modelKey}`,
			`depth ${state.depth} · ${state.activity.length} actions · ${state.reports.length} reports · ${state.nudges} nudges`,
			`suspended: ${state.awaitingSince ? "awaiting answers — reply with agent_answer" : "no"}`,
			`session: ${state.sessionFile ?? "(not yet recorded)"}`,
		];
		const recent = state.activity.slice(-MAX_OUTPUT_ACTIVITY);
		if (recent.length > 0) {
			lines.push(`recent activity (last ${recent.length}):`);
			for (const item of recent) lines.push(`  ${stripControlSequences(item.label)}`);
		}
		if (state.contract.pendingAsk && state.contract.pendingAsk.length > 0) {
			lines.push("pending questions:");
			for (const question of state.contract.pendingAsk) lines.push(`  - ${question.id}: ${stripControlSequences(question.prompt)}`);
		}
		if (state.reports.length > 0) {
			lines.push("reports so far:");
			for (const report of state.reports) lines.push(`  ${stripControlSequences(report)}`);
		}
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				childId: targetId,
				model: state.modelDisplay,
				activity: [...state.activity],
				reports: [...state.reports],
				usage: usageToDetails(state.usage),
				contract: [...state.contract.questions],
				pendingAsk: state.contract.pendingAsk ? [...state.contract.pendingAsk] : undefined,
				done: false,
				background,
				sessionFile: state.sessionFile,
				peek: true,
			},
		};
	}

	function killAgentResult(callerId: string | undefined, targetId: string): AgentToolResult<unknown> {
		const state = registry.getAccessibleTarget(callerId, targetId, "kill");
		const { killedIds, reportCount } = registry.killSubtree(state.id);
		return {
			content: [{ type: "text", text: `Killed ${killedIds.length} agent(s): ${killedIds.join(", ")}.` }],
			details: { childId: state.id, killedIds, reportCount },
		};
	}

	return {
		spawnChild,
		spawnPanel,
		answerAgent,
		killAgentResult,
		waitAgent,
		outputAgent,
	};
}

export { spawnSchema, answerAgentSchema, killSchema, listSchema, waitSchema, outputSchema };
