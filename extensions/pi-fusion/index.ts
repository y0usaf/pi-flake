import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	convertToLlm,
	runAgentLoop,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type AgentToolResult,
} from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context as LlmContext,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
} from "@earendil-works/pi-ai";
import { streamSimple as streamModel } from "@earendil-works/pi-ai/compat";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const PROVIDER_ID = "fusion";
const FUSION_API = "fusion-orchestrated";
const FUSION_BASE_URL = "fusion://local";
const CONFIG_FILE = "pi-fusion.json";
const TOOL_NAME = "fusion_sidekick";
const DEFAULT_MAX_TURNS = 80;
const DEFAULT_TIMEOUT_SECONDS = 900;
const DEFAULT_MAX_SIDEKICKS = 4;
const STRIPPED_LEAD_TOOLS = new Set(["write", "edit", "bash"]);
const LEAD_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

interface FusionPair {
	id: string;
	name?: string;
	lead: string;
	sidekick: string;
	orchestrator?: boolean;
}

interface FusionConfig {
	pairs: FusionPair[];
	orchestrator: boolean;
	maxSidekickTurns: number;
	sidekickTimeoutSeconds: number;
	maxSidekicks: number;
}

interface ParsedConfig {
	config: FusionConfig;
	fields: Set<keyof FusionConfig>;
}

interface ModelRef {
	spec: string;
	provider: string;
	modelId: string;
}

interface ActivityItem {
	label: string;
	tool?: string;
	ok?: boolean;
}

interface SidekickDetails {
	id: string;
	model?: string;
	done: boolean;
	activity: ActivityItem[];
	answer?: string;
	truncated?: boolean;
	error?: string;
}

interface SidekickState {
	id: string;
	model: Model<Api>;
	cwd: string;
	messages: AgentMessage[];
	tools: AgentTool<any>[];
	activity: ActivityItem[];
	tail: Promise<unknown>;
	onUpdate?: (partial: AgentToolResult<SidekickDetails>) => void;
	abort?: AbortController;
	limits: {
		turns: number;
		truncated: boolean;
	};
}

const sidekickParams = Type.Object({
	task: Type.String({
		description:
			"Bounded implementation brief for the sidekick. Include exact paths, relevant context, expected result, and what to report back.",
	}),
	sidekick_id: Type.Optional(
		Type.String({
			description:
				"Persistent sidekick id. Reusing an id continues that sidekick's context. Defaults to 'main'.",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Optional working directory for the sidekick. Defaults to the session cwd.",
		}),
	),
	timeout_seconds: Type.Optional(
		Type.Number({
			description:
				"Optional wall-clock timeout for this delegation. Defaults to sidekickTimeoutSeconds from pi-fusion.json.",
		}),
	),
});

type SidekickParams = Static<typeof sidekickParams>;

function defaultConfig(): FusionConfig {
	return {
		pairs: [],
		orchestrator: false,
		maxSidekickTurns: DEFAULT_MAX_TURNS,
		sidekickTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
		maxSidekicks: DEFAULT_MAX_SIDEKICKS,
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asPositiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}

function normalizePairs(input: unknown, path: string): FusionPair[] {
	if (input === undefined) return [];
	const entries: Array<[string | undefined, unknown]> = Array.isArray(input)
		? input.map((entry) => [asRecord(entry)?.id as string | undefined, entry])
		: Object.entries(asRecord(input) ?? {});
	if (!Array.isArray(input) && asRecord(input) === undefined) {
		throw new Error(`${path}: "pairs" must be an array or object`);
	}
	return entries.map(([fallbackId, entry]) => {
		const raw = asRecord(entry);
		const id = asString(raw?.id) ?? fallbackId;
		const lead = asString(raw?.lead);
		const sidekick = asString(raw?.sidekick);
		if (!id || !lead || !sidekick) {
			throw new Error(`${path}: each pair needs id, lead, and sidekick`);
		}
		return {
			id,
			name: asString(raw?.name),
			lead,
			sidekick,
			orchestrator: typeof raw?.orchestrator === "boolean" ? raw.orchestrator : undefined,
		};
	});
}

function parseConfig(raw: unknown, path: string): ParsedConfig {
	const obj = asRecord(raw);
	if (!obj) throw new Error(`${path}: expected a JSON object`);
	const defaults = defaultConfig();
	let pairs = normalizePairs(obj.pairs, path);
	const lead = asString(obj.lead);
	const sidekick = asString(obj.sidekick);
	if (pairs.length === 0 && lead && sidekick) {
		pairs = [{ id: "default", name: "Fusion", lead, sidekick }];
	}
	const fields = new Set<keyof FusionConfig>();
	if (obj.pairs !== undefined || (lead && sidekick)) fields.add("pairs");
	if (typeof obj.orchestrator === "boolean") fields.add("orchestrator");
	if (obj.maxSidekickTurns !== undefined) fields.add("maxSidekickTurns");
	if (obj.sidekickTimeoutSeconds !== undefined) fields.add("sidekickTimeoutSeconds");
	if (obj.maxSidekicks !== undefined) fields.add("maxSidekicks");
	return {
		config: {
			pairs,
			orchestrator:
				typeof obj.orchestrator === "boolean" ? obj.orchestrator : defaults.orchestrator,
			maxSidekickTurns: asPositiveInt(obj.maxSidekickTurns, defaults.maxSidekickTurns),
			sidekickTimeoutSeconds: asPositiveInt(
				obj.sidekickTimeoutSeconds,
				defaults.sidekickTimeoutSeconds,
			),
			maxSidekicks: asPositiveInt(obj.maxSidekicks, defaults.maxSidekicks),
		},
		fields,
	};
}

function mergeConfig(base: FusionConfig, override: ParsedConfig): FusionConfig {
	const byId = new Map(base.pairs.map((pair) => [pair.id, pair]));
	for (const pair of override.config.pairs) byId.set(pair.id, pair);
	return {
		pairs: [...byId.values()],
		orchestrator: override.fields.has("orchestrator")
			? override.config.orchestrator
			: base.orchestrator,
		maxSidekickTurns: override.fields.has("maxSidekickTurns")
			? override.config.maxSidekickTurns
			: base.maxSidekickTurns,
		sidekickTimeoutSeconds: override.fields.has("sidekickTimeoutSeconds")
			? override.config.sidekickTimeoutSeconds
			: base.sidekickTimeoutSeconds,
		maxSidekicks: override.fields.has("maxSidekicks")
			? override.config.maxSidekicks
			: base.maxSidekicks,
	};
}

async function readConfig(path: string): Promise<ParsedConfig | undefined> {
	if (!existsSync(path)) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error(
			`${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parseConfig(raw, path);
}

async function loadConfig(cwd: string): Promise<FusionConfig> {
	let merged = defaultConfig();
	for (const path of [
		join(getAgentDir(), CONFIG_FILE),
		join(cwd, ".pi", CONFIG_FILE),
	]) {
		const config = await readConfig(path);
		if (config) merged = mergeConfig(merged, config);
	}
	return merged;
}

function parseModelRef(spec: string): ModelRef {
	const trimmed = spec.trim();
	const slash = trimmed.indexOf("/");
	if (slash < 0) return { spec: trimmed, provider: "", modelId: trimmed };
	return {
		spec: trimmed,
		provider: trimmed.slice(0, slash),
		modelId: trimmed.slice(slash + 1),
	};
}

function resolveModel(spec: string, registry: ModelRegistry): Model<Api> {
	const ref = parseModelRef(spec);
	if (ref.provider === PROVIDER_ID) {
		throw new Error(`Fusion model spec cannot reference another fusion model: ${spec}`);
	}
	if (ref.provider) {
		const model = registry.find(ref.provider, ref.modelId);
		if (!model) throw new Error(`model not found: ${spec}`);
		return model;
	}
	const matches = registry.getAll().filter((model) => model.id === ref.modelId);
	if (matches.length === 1) return matches[0];
	if (matches.length === 0) throw new Error(`model not found: ${spec}`);
	throw new Error(`model id "${spec}" is ambiguous; use provider/model-id`);
}

function tryResolveModel(
	spec: string,
	registry: ModelRegistry | undefined,
	warnings: string[],
): Model<Api> | undefined {
	if (!registry) return undefined;
	try {
		return resolveModel(spec, registry);
	} catch (error) {
		warnings.push(`${spec}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function emptyAssistant(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
		stopReason: "error",
		timestamp: Date.now(),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function fusionMessage(message: AssistantMessage, model: Model<Api>): AssistantMessage {
	return {
		...message,
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
}

function fusionEvent(
	event: AssistantMessageEvent,
	model: Model<Api>,
): AssistantMessageEvent {
	if (event.type === "done") {
		return { ...event, message: fusionMessage(event.message, model) };
	}
	if (event.type === "error") {
		return { ...event, error: fusionMessage(event.error, model) };
	}
	return { ...event, partial: fusionMessage(event.partial, model) };
}

function textContent(text: string): TextContent[] {
	return [{ type: "text", text }];
}

function result(
	details: SidekickDetails,
	text: string,
): AgentToolResult<SidekickDetails> {
	return { content: textContent(text), details };
}

function truncateMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const keep = Math.max(16, Math.floor((max - 5) / 2));
	return `${text.slice(0, keep)}\n…\n${text.slice(-keep)}`;
}

function preview(text: string, max = 80): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function buildSafeEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of [
		"HOME",
		"PATH",
		"TMPDIR",
		"USER",
		"SHELL",
		"LANG",
		"LC_ALL",
		"TERM",
		"COLORTERM",
		"EDITOR",
		"VISUAL",
		"PAGER",
		"NO_COLOR",
		"FORCE_COLOR",
		"CI",
		"XDG_CONFIG_HOME",
		"XDG_DATA_HOME",
		"XDG_CACHE_HOME",
		"XDG_STATE_HOME",
	]) {
		const value = process.env[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
}

function createSidekickTools(cwd: string): AgentTool<any>[] {
	const bashTool = createBashTool(cwd, {
		exposeSessionEnvironment: false,
		spawnHook: (context) => ({ ...context, env: buildSafeEnv() }),
	});
	return [
		createReadTool(cwd) as AgentTool<any>,
		createWriteTool(cwd) as AgentTool<any>,
		createEditTool(cwd) as AgentTool<any>,
		bashTool as AgentTool<any>,
	];
}

function sidekickSystemPrompt(): string {
	return [
		"You are the sidekick in a Fusion lead/sidekick pair.",
		"The lead owns the user-facing session and delegates bounded work to you.",
		"Execute the delegated task directly with read/write/edit/bash tools.",
		"Keep changes scoped. Do not refactor unrelated code or expand the task.",
		"Prefer verification commands that already exist in the project.",
		"If the task is ambiguous, unsafe, or needs a lead decision, finish with `ESCALATE:` and the exact decision needed.",
		"Your final response must be a concise report: what changed, files touched, commands run, verification result, and remaining risks.",
	].join("\n");
}

function lastAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") return message;
	}
	return undefined;
}

function lastAssistantText(messages: AgentMessage[]): string {
	const message = lastAssistant(messages);
	if (!message) return "";
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function lastAssistantError(messages: AgentMessage[]): string | undefined {
	const message = lastAssistant(messages);
	if (!message) return undefined;
	if (message.stopReason !== "error" && message.stopReason !== "aborted") return undefined;
	return message.errorMessage ?? message.stopReason;
}

function formatToolActivity(toolName: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
			return `${toolName} ${String(a.path ?? a.file_path ?? "")}`;
		case "bash":
			return `$ ${String(a.command ?? "")}`;
		default:
			return toolName;
	}
}

function sidekickPrompt(task: string, id: string): string {
	return [
		`<delegated_task id="${id}">`,
		task,
		"</delegated_task>",
		"",
		"Finish with a report containing:",
		"- Result",
		"- Files changed",
		"- Commands run and verification outcome",
		"- Escalation or remaining risks",
	].join("\n");
}

export default function register(pi: ExtensionAPI): void {
	let registry: ModelRegistry | undefined;
	let sessionCtx: ExtensionContext | undefined;
	let config = defaultConfig();
	let configError: string | undefined;
	let fusionOn = false;
	let orchestratorOn = false;
	let savedTools: string[] | undefined;
	const sidekicks = new Map<string, SidekickState>();

	function isFusionModel(model: Model<any> | undefined): boolean {
		return model?.provider === PROVIDER_ID;
	}

	function pairForModel(model: Model<any> | undefined): FusionPair | undefined {
		if (!isFusionModel(model)) return undefined;
		return config.pairs.find((pair) => pair.id === model?.id);
	}

	function activePair(): FusionPair | undefined {
		return pairForModel(sessionCtx?.model);
	}

	function resetSidekicks(): void {
		for (const state of sidekicks.values()) state.abort?.abort();
		sidekicks.clear();
	}

	function restoreTools(): void {
		if (!savedTools) return;
		const tools = savedTools;
		savedTools = undefined;
		pi.setActiveTools(tools);
	}

	function applyMode(
		on: boolean,
		ctx: ExtensionContext | undefined,
		model?: Model<any>,
	): void {
		fusionOn = on;
		const pair = pairForModel(model ?? ctx?.model ?? sessionCtx?.model);
		orchestratorOn = on && (pair?.orchestrator ?? config.orchestrator);
		if (!on) {
			restoreTools();
			ctx?.ui.setStatus("pi-fusion", undefined);
			return;
		}

		savedTools ??= pi.getActiveTools() ?? [];
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		let next = [...savedTools];
		if (!next.includes(TOOL_NAME)) next.push(TOOL_NAME);
		if (orchestratorOn) {
			next = next.filter((name) => !STRIPPED_LEAD_TOOLS.has(name));
			for (const name of LEAD_READ_ONLY_TOOLS) {
				if (available.has(name) && !next.includes(name)) next.push(name);
			}
		}
		pi.setActiveTools([...new Set(next)]);
		ctx?.ui.setStatus(
			"pi-fusion",
			`fusion ${pair?.id ?? "unconfigured"}${orchestratorOn ? " · orchestrator" : ""}`,
		);
	}

	function providerModels(warnings: string[]) {
		return config.pairs.flatMap((pair) => {
			const lead = tryResolveModel(pair.lead, registry, warnings);
			const sidekick = tryResolveModel(pair.sidekick, registry, warnings);
			if (!lead || !sidekick) return [];
			return [
				{
					id: pair.id,
					name: pair.name ?? `Fusion: ${pair.lead} + ${pair.sidekick}`,
					reasoning: lead.reasoning,
					input: lead.input,
					cost: lead.cost ?? ZERO_COST,
					contextWindow: lead.contextWindow ?? 200_000,
					maxTokens: lead.maxTokens ?? 64_000,
				},
			];
		});
	}

	function registerProvider(ctx: ExtensionContext): string[] {
		const warnings: string[] = [];
		pi.registerProvider(PROVIDER_ID, {
			name: "Fusion",
			baseUrl: FUSION_BASE_URL,
			apiKey: "fusion",
			api: FUSION_API,
			models: providerModels(warnings),
			streamSimple: (model, context, options) => streamFusion(model, context, options),
		});
		if (config.pairs.length === 0) {
			warnings.push(`no pairs configured; add ${CONFIG_FILE}`);
		}
		for (const warning of warnings) ctx.ui.notify(`pi-fusion: ${warning}`, "warning");
		return warnings;
	}

	function streamFusion(
		model: Model<Api>,
		context: LlmContext,
		options?: SimpleStreamOptions,
	) {
		const output = createAssistantMessageEventStream();
		void (async () => {
			try {
				const pair = pairForModel(model);
				if (!pair) throw new Error(`unknown Fusion pair "${model.id}"`);
				if (!registry) throw new Error("Pi model registry is unavailable");
				const lead = resolveModel(pair.lead, registry);
				const auth = await registry.getApiKeyAndHeaders(lead);
				if (!auth.ok) throw new Error(auth.error);
				const provider = registry.getProvider(lead.provider);
				if (!provider) throw new Error(`provider unavailable: ${lead.provider}`);
				const leadModel = auth.baseUrl ? { ...lead, baseUrl: auth.baseUrl } : lead;
				const upstream = provider.streamSimple(leadModel, context, {
					...options,
					apiKey: auth.apiKey,
					headers: { ...auth.headers, ...options?.headers },
					env: { ...auth.env, ...options?.env },
				});
				for await (const event of upstream) output.push(fusionEvent(event, model));
				output.end();
			} catch (error) {
				const aborted = options?.signal?.aborted;
				const message = emptyAssistant(model);
				message.stopReason = aborted ? "aborted" : "error";
				message.errorMessage = errorMessage(error);
				output.push({
					type: "error",
					reason: message.stopReason,
					error: message,
				});
				output.end();
			}
		})();
		return output;
	}

	function createGetApiKey() {
		const cache = new Map<string, Promise<string | undefined>>();
		return (provider: string) => {
			const current = registry;
			if (!current) return Promise.resolve(undefined);
			let pending = cache.get(provider);
			if (!pending) {
				pending = Promise.resolve(current.getApiKeyForProvider(provider));
				cache.set(provider, pending);
			}
			return pending;
		};
	}

	function getSidekick(
		id: string,
		cwd: string,
		model: Model<Api>,
		onUpdate: ((partial: AgentToolResult<SidekickDetails>) => void) | undefined,
	): SidekickState {
		const existing = sidekicks.get(id);
		if (
			existing &&
			existing.cwd === cwd &&
			existing.model.provider === model.provider &&
			existing.model.id === model.id
		) {
			existing.onUpdate = onUpdate;
			return existing;
		}
		if (existing) {
			existing.abort?.abort();
			sidekicks.delete(id);
		}
		if (sidekicks.size >= config.maxSidekicks) {
			throw new Error(`maximum live sidekicks reached (${config.maxSidekicks})`);
		}
		const state: SidekickState = {
			id,
			model,
			cwd,
			messages: [],
			tools: createSidekickTools(cwd),
			activity: [],
			tail: Promise.resolve(),
			onUpdate,
			limits: { turns: 0, truncated: false },
		};
		sidekicks.set(id, state);
		return state;
	}

	function emitSidekickEvent(state: SidekickState, event: AgentEvent): void {
		if (event.type === "tool_execution_start") {
			state.activity.push({
				label: formatToolActivity(event.toolName, event.args),
				tool: event.toolName,
			});
		} else if (event.type === "tool_execution_end") {
			const last = [...state.activity]
				.reverse()
				.find((item) => item.tool === event.toolName && item.ok === undefined);
			if (last) last.ok = !event.isError;
		} else if (event.type === "message_end") {
			state.messages.push(event.message);
			if (event.message.role === "assistant") {
				const text = lastAssistantText(state.messages);
				if (text) state.activity.push({ label: `↳ ${preview(text, 140)}` });
			}
		} else {
			return;
		}
		state.onUpdate?.(
			result(
				{
					id: state.id,
					model: `${state.model.provider}/${state.model.id}`,
					done: false,
					activity: [...state.activity],
				},
				`fusion sidekick ${state.id} running`,
			),
		);
	}

	async function runSidekick(
		state: SidekickState,
		params: SidekickParams,
		signal: AbortSignal | undefined,
	): Promise<SidekickDetails> {
		state.limits.turns = 0;
		state.limits.truncated = false;
		if (signal?.aborted) throw new Error("sidekick aborted");

		const controller = new AbortController();
		state.abort = controller;
		const abort = () => controller.abort();
		signal?.addEventListener("abort", abort, { once: true });

		const timeoutSeconds = params.timeout_seconds ?? config.sidekickTimeoutSeconds;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`sidekick timed out after ${timeoutSeconds}s`)),
				timeoutSeconds * 1000,
			);
		});
		const prompt: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: sidekickPrompt(params.task, state.id) }],
			timestamp: Date.now(),
		};
		try {
			await Promise.race([
				runAgentLoop(
					[prompt],
					{
						systemPrompt: sidekickSystemPrompt(),
						messages: state.messages.slice(),
						tools: state.tools,
					},
					{
						model: state.model,
						convertToLlm,
						getApiKey: createGetApiKey(),
						toolExecution: "parallel",
						shouldStopAfterTurn: () => {
							state.limits.turns += 1;
							if (state.limits.turns >= config.maxSidekickTurns) {
								state.limits.truncated = true;
								return true;
							}
							return false;
						},
					},
					(event) => emitSidekickEvent(state, event),
					controller.signal,
					streamModel,
				),
				timeout,
			]);
		} catch (error) {
			controller.abort();
			throw error;
		} finally {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			state.abort = undefined;
		}

		const answer = lastAssistantText(state.messages);
		const error = state.limits.truncated
			? undefined
			: lastAssistantError(state.messages);
		return {
			id: state.id,
			model: `${state.model.provider}/${state.model.id}`,
			done: true,
			activity: [...state.activity],
			answer,
			truncated: state.limits.truncated,
			error,
		};
	}

	function enqueueSidekick(
		state: SidekickState,
		work: () => Promise<SidekickDetails>,
	): Promise<SidekickDetails> {
		const run = state.tail.then(work);
		state.tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	function fusionGate(): string {
		return [
			"## Fusion mode",
			"You are the lead in a lead/sidekick pair. Stay responsible for planning, ambiguity, final review, and user-facing decisions.",
			`Use ${TOOL_NAME} for bounded implementation or investigation work that benefits from a separate context. Give each call a self-contained task and exact expected output.`,
			"Reuse a sidekick_id when follow-up work should retain prior sidekick context; use a new id for independent work.",
			"Review sidekick results before accepting them. If a sidekick reports ESCALATE or fails, take over or send a corrected follow-up.",
			orchestratorOn
				? "Orchestrator mode is active: your write/edit/bash tools are stripped. Route mutations through fusion_sidekick."
				: "You still have direct tools; use them for judgment, review, and small critical edits.",
		].join("\n");
	}

	pi.registerTool({
		name: TOOL_NAME,
		label: "Fusion Sidekick",
		description:
			"Delegate a bounded task to a persistent sidekick agent running the Fusion pair's sidekick model. Reuse sidekick_id for context continuity; use separate ids for independent parallel work.",
		promptSnippet:
			"fusion_sidekick: delegate bounded implementation or investigation work to a persistent sidekick model.",
		promptGuidelines: [
			"Use fusion_sidekick for self-contained mechanical or exploratory work; keep planning, ambiguity, and final review with the lead.",
			"Front-load each delegation with exact paths, constraints, and expected report contents.",
		],
		parameters: sidekickParams,
		execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
			const pair = pairForModel(ctx.model);
			if (!pair) {
				throw new Error("fusion_sidekick is only available while a fusion/* model is selected");
			}
			if (!ctx.modelRegistry) throw new Error("Pi model registry is unavailable");
			const sidekickModel = resolveModel(pair.sidekick, ctx.modelRegistry);
			const cwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
			const id = params.sidekick_id?.trim() || "main";
			const state = getSidekick(id, cwd, sidekickModel, onUpdate);
			const details = await enqueueSidekick(state, () => runSidekick(state, params, signal));
			const status = details.error
				? `failed: ${details.error}`
				: details.truncated
					? `stopped at ${config.maxSidekickTurns} turns`
					: "completed";
			const text = [
				`Fusion sidekick ${details.id} ${status}.`,
				details.answer || "(no assistant report)",
			].join("\n\n");
			return result(details, truncateMiddle(text, 60_000));
		},
		renderCall: (args, theme) =>
			new Text(
				`${theme.fg("accent", "fusion_sidekick")} ${theme.fg("toolOutput", args.sidekick_id ?? "main")}\n${theme.fg("muted", preview(args.task, 160))}`,
				0,
				0,
			),
		renderResult: (res, options, theme) => {
			const details = res.details;
			const title = details.done
				? `${details.error ? theme.fg("error", "✗") : theme.fg("success", "✓")} sidekick ${details.id}`
				: `… sidekick ${details.id}`;
			const lines = [theme.fg("accent", title)];
			for (const item of details.activity.slice(-8)) {
				const mark = item.ok === undefined ? "…" : item.ok ? "✓" : "✗";
				lines.push(theme.fg("muted", `  ${mark} ${preview(item.label, 120)}`));
			}
			if (details.done && details.answer) {
				lines.push(theme.fg("toolOutput", preview(details.answer, 300)));
			}
			if (options.isPartial) lines.push(theme.fg("muted", "running"));
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerCommand("fusion", {
		description: "Show or reset Fusion sidekick state",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "reset") {
				resetSidekicks();
				ctx.ui.notify("pi-fusion: sidekicks reset", "info");
				return;
			}
			if (arg.startsWith("orchestrator")) {
				const value = arg.split(/\s+/)[1];
				if (value !== "on" && value !== "off") {
					ctx.ui.notify(
						`orchestrator is ${orchestratorOn ? "on" : "off"} (usage: /fusion orchestrator on|off)`,
						"warning",
					);
					return;
				}
				config.orchestrator = value === "on";
				applyMode(fusionOn, ctx);
				ctx.ui.notify(
					`pi-fusion orchestrator ${config.orchestrator ? "on" : "off"}`,
					"info",
				);
				return;
			}
			const pair = activePair();
			const ids = [...sidekicks.keys()];
			ctx.ui.notify(
				[
					`fusion: ${fusionOn ? "on" : "off"}`,
					`model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`,
					`pair: ${pair ? `${pair.lead} + ${pair.sidekick}` : "none"}`,
					`orchestrator: ${orchestratorOn ? "on" : "off"}`,
					`sidekicks: ${ids.length ? ids.join(", ") : "none"}`,
					configError ? `config error: ${configError}` : undefined,
				]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		registry = ctx.modelRegistry;
		resetSidekicks();
		try {
			config = await loadConfig(ctx.cwd);
			configError = undefined;
		} catch (error) {
			config = defaultConfig();
			configError = errorMessage(error);
			ctx.ui.notify(`pi-fusion: ${configError}`, "error");
		}
		registerProvider(ctx);
		applyMode(isFusionModel(ctx.model), ctx);
	});

	pi.on("model_select", (event, ctx) => {
		sessionCtx = ctx;
		registry = ctx.modelRegistry;
		const on = isFusionModel(event.model);
		if (!on) resetSidekicks();
		applyMode(on, ctx, event.model);
	});

	pi.on("before_agent_start", (event) => {
		if (!fusionOn) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${fusionGate()}` };
	});

	pi.on("session_shutdown", () => {
		resetSidekicks();
		savedTools = undefined;
		sessionCtx = undefined;
		registry = undefined;
	});
}
