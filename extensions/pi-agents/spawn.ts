/**
 * pi-agents spawn machinery module: spawnChild/spawnPanel, the child agent
 * assembly (buildChildAgent + createChildManagementTools), the run lifecycle
 * (finishExchange, answerAgent, killAgentResult), and the tool schemas they
 * own (spawnSchema, answerAgentSchema, killSchema, listSchema). Per
 * DESIGN.md: "spawn/kill lifecycle (decision-making)".
 *
 * createSpawnTools(deps) is invoked inside multiAgent() with the per-session
 * registry, session state, and config loader; no module-level state, so
 * multiple sessions stay isolated.
 */
import { Agent, type AgentTool, type AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	UNABLE_VALUE,
	buildAskParentTool,
	buildSubmitAnswersTool,
	contractAnswersSchema,
	contractSchema,
	normalizeContract,
	renderAnswersBlock,
	renderContractBlock,
	runUntilContractFulfilled,
	validateContractAnswers,
	type ContractBox,
} from "./contract.js";
import {
	buildReportTool,
	collectResult,
	createChildTools,
	modelDisplay,
	subscribeChild,
	tallyPanel,
	withOptionalTimeout,
	type AgentToolDetails,
	type ChildState,
} from "./state.js";
import { resolveChildModel, type PiAgentsConfig } from "./config.js";
import type { Registry } from "./registry.js";
import { stripControlSequences } from "./render.js";

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
	timeout_seconds: Type.Optional(Type.Number({ description: "Maximum wall-clock seconds to wait for the agent to finish (must be > 0). If the deadline expires the agent is aborted, removed from the registry, and an error is thrown." })),
	panel: Type.Optional(Type.Object({
		size: Type.Optional(Type.Number({ description: "Number of independent panel members (2-5)" })),
		models: Type.Optional(Type.Array(Type.String(), { description: "One model spec per panel member" })),
	}, { description: "Consult a panel: spawn N independent children on this same contract and return an agreement tally. Members get ids <id>-1..N and no ask_parent tool. `models` gives each member its own model spec (\"provider/modelId\" or a bare id); when omitted, the configured `panelModels` roster is used if present, and `panel: {}` is legal and uses the whole roster. Model diversity is the point; N clones of one model agree because they are the same function, not because the answer is right." })),
});

const killSchema = Type.Object({
	id: Type.String({ description: "ID of the child agent to kill" }),
});

const listSchema = Type.Object({});

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

export interface SpawnDeps {
	registry: Registry;
	session: SessionState;
	getConfig: (cwd: string) => Promise<PiAgentsConfig>;
}

export interface SpawnTools {
	spawnChild: SpawnChildFn;
	spawnPanel: SpawnPanelFn;
	answerAgent: AnswerAgentFn;
	killAgentResult: KillAgentResultFn;
}

export function createSpawnTools(deps: SpawnDeps): SpawnTools {
	const { registry, session, getConfig } = deps;

	function createChildManagementTools(callerId: string, cwd: string, model: Model<any>): AgentTool<any>[] {
		const spawnTool: AgentTool<typeof spawnSchema> = {
			name: "agent",
			label: "Agent",
			description:
				"Spawn a descendant agent within your own subtree. Pass `panel` to get a second opinion instead of judging alone: N independent children answer the same contract on different models and the result is an agreement tally. Requires a contract; " +
				"the descendant's result is its structured contract answers, and it is removed once it answers. " +
				"Subject to configured maxDepth and maxLiveAgents limits. If the child calls ask_parent instead, this call returns its questions and the agent stays alive (holding context and a maxLiveAgents slot) until agent_answer resumes it or agent_kill removes it.",
			parameters: spawnSchema,
			execute: async (_toolCallId, params, signal, onUpdate) => {
				return params.panel ? await spawnPanel(callerId, params, model, cwd, signal, onUpdate) : await spawnChild(callerId, params, model, cwd, signal, onUpdate);
			},
		};

		const answerTool: AgentTool<typeof answerAgentSchema> = {
			name: "agent_answer", label: "Answer Agent",
			description: "Answer questions from a suspended descendant; the call blocks until its contract is fulfilled or it asks again.",
			parameters: answerAgentSchema,
			execute: async (_toolCallId, params, signal, onUpdate) => {
				return answerAgent(callerId, params, signal, onUpdate);
			},
		};


		const killTool: AgentTool<typeof killSchema> = {
			name: "agent_kill",
			label: "Kill Agent",
			description: "Kill a descendant agent in your subtree. Descendants are killed recursively.",
			parameters: killSchema,
			execute: async (_toolCallId, params) => killAgentResult(callerId, params.id),
		};

		const listTool: AgentTool<typeof listSchema> = {
			name: "agent_list",
			label: "List Agents",
			description: "List agents in your subtree, including yourself.",
			parameters: listSchema,
			execute: async () => registry.listAgentsResult(callerId),
		};

		return [spawnTool as AgentTool<any>, answerTool as AgentTool<any>, killTool as AgentTool<any>, listTool as AgentTool<any>];
	}

	function buildChildAgent(
		childId: string,
		systemPrompt: string,
		model: Model<any>,
		cwd: string,
		reports: string[],
		contract: ContractBox,
		holder: { state?: ChildState },
		allowAsk = true,
		canSpawn = true,
	): Agent {
		const reportTool = buildReportTool(childId, reports);
		const submitTool = buildSubmitAnswersTool(childId, contract);
		const askTool = allowAsk ? buildAskParentTool(childId, holder) : undefined;
		const childTools = [
			...createChildTools(cwd),
			...(canSpawn ? createChildManagementTools(childId, cwd, model) : []),
			reportTool as AgentTool<any>,
			submitTool as AgentTool<any>,
			...(askTool ? [askTool as AgentTool<any>] : []),
		];
		return new Agent({
			initialState: { systemPrompt, model, tools: childTools },
			streamFn: streamSimple,
			getApiKey: session.cachedGetApiKey,
		});
	}

	/** The subtree is removed on any error; nothing outlives a failed run. */
	async function finishExchange(state: ChildState, prompt: string, signal: AbortSignal | undefined, timeoutSeconds: number | undefined, onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void): Promise<AgentToolResult<AgentToolDetails>> {
		const onAbort = () => state.agent.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const unsub = subscribeChild(state.agent, state.id, state, onUpdate, session.sessionTheme);
		try {
			if (state.killed) throw new Error(`Agent "${state.id}" was killed while running`);
			if (signal?.aborted) throw new Error(`Agent "${state.id}" aborted before start`);
			if (state.agent.state.errorMessage) throw new Error(state.agent.state.errorMessage);
			await withOptionalTimeout(state.agent, state.id, runUntilContractFulfilled(state, prompt, signal, !state.panelMember), timeoutSeconds);
			if (state.killed) throw new Error(`Agent "${state.id}" was killed while running`);
			if (signal?.aborted) throw new Error(`Agent "${state.id}" aborted while running`);
			if (state.agent.state.errorMessage) throw new Error(state.agent.state.errorMessage);
		}
		catch (err) { state.killed = true; registry.killSubtree(state.id); throw err; }
		finally { state.locked = false; unsub(); signal?.removeEventListener("abort", onAbort); if (state.killed) registry.removeStateIfCurrent(state); }
		const result = collectResult(state.id, state, state.reportCursor);
		state.reportCursor = state.reports.length;
		if (!(state.contract.pendingAsk && !state.agent.state.errorMessage && !state.killed)) registry.killSubtree(state.id);
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
			const askHolder: { state?: ChildState } = {};
			const child = buildChildAgent(params.id, params.system_prompt, childModel, cwd, reports, contract, askHolder, allowAsk, childDepth < config.maxDepth);
			const state: ChildState = {
				id: params.id,
				parentId: parentState?.id,
				rootId: parentState?.rootId ?? params.id,
				depth: childDepth,
				cwd,
				createdAt: Date.now(),
				modelDisplay: modelDisplay(childModel, model),
				agent: child,
				reports,
				activity: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
				reportCursor: 0,
				askCount: 0,
				nudges: 0,
				contract,
				locked: true,
				killed: false,
			};
			registry.children.set(params.id, state);
			registry.reservedIds.delete(params.id);
			askHolder.state = state;

			return await finishExchange(state, `${params.task}\n\n${renderContractBlock(contract.questions, allowAsk)}`, signal, params.timeout_seconds, onUpdate);
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
		return finishExchange(state, renderAnswersBlock(questions, answers), signal, params.timeout_seconds, onUpdate);
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
	};
}

export { spawnSchema, answerAgentSchema, killSchema, listSchema };
