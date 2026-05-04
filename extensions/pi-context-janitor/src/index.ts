import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { completeSimple, type Model, type ToolResultMessage, type Usage } from "@mariozechner/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

const SETTINGS_DIR = join(getAgentDir(), "context-janitor");
const SETTINGS_PATH = join(SETTINGS_DIR, "settings.json");

const INDEX_CUSTOM_TYPE = "context-janitor-index";
const SUMMARY_CUSTOM_TYPE = "context-janitor-summary";
const QUERY_TOOL_NAME = "context_janitor_query";
const STATUS_KEY = "context-janitor";
const SUMMARY_ID_PATTERN = /\[context-janitor\] background summary `([^`]+)`/g;

const DEFAULT_QUERY_MAX_CHARS = 12_000;
const MAX_QUERY_MAX_CHARS = 100_000;

const SUMMARY_SYSTEM_PROMPT = `You are Context Janitor, a background context compactor for a coding agent.

Summarize completed tool calls for future turns. Optimize for preserving useful working memory while removing raw noise.

Rules:
- Preserve exact toolCallIds, file paths, commands, test/build results, errors, decisions, and user-visible facts.
- Mention unresolved failures and follow-up actions.
- Do not invent. If the raw output is inconclusive, say so.
- Be concise but specific enough that a coding agent can continue without rereading raw logs.
- Prefer markdown bullets under these headings: Outcome, Key facts, Files/commands, Errors/open issues, Next.
- Do not include preamble or apology.`;

type Effort = "minimal" | "low" | "medium" | "high" | "xhigh";
type ThinkingSetting = "default" | "off" | Effort;

interface JanitorSettings {
	enabled: boolean;
	summarizerModel: string;
	summarizerThinking: ThinkingSetting;
	minRawChars: number;
	minToolCalls: number;
	contextUsagePercent: number;
	debounceMs: number;
	maxInputChars: number;
	maxSummaryTokens: number;
	maxSummaryRatio: number;
	showStatus: boolean;
}

interface ToolCallRecord {
	toolCallId: string;
	toolName: string;
	args: unknown;
	resultText: string;
	isError: boolean;
	turnIndex: number;
	timestamp: number;
	summaryId: string;
}

interface PendingToolCallRecord extends Omit<ToolCallRecord, "summaryId"> {}

interface CapturedBatch {
	turnIndex: number;
	toolCalls: PendingToolCallRecord[];
	rawChars: number;
	capturedAt: number;
}

interface SummaryIndexEntry {
	version: 1;
	summaryId: string;
	createdAt: string;
	reason: string;
	rawChars: number;
	summaryChars: number;
	summarizerModel: string;
	summarizerThinking: ThinkingSetting;
	usage?: Usage;
	toolCalls: ToolCallRecord[];
}

interface JanitorStats {
	summaries: number;
	indexedToolCalls: number;
	rawChars: number;
	summaryChars: number;
	skippedOversized: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}

const DEFAULT_SETTINGS: JanitorSettings = {
	enabled: true,
	summarizerModel: "auto",
	summarizerThinking: "off",
	minRawChars: 8_000,
	minToolCalls: 8,
	contextUsagePercent: 55,
	debounceMs: 900,
	maxInputChars: 60_000,
	maxSummaryTokens: 1_200,
	maxSummaryRatio: 0.7,
	showStatus: true,
};

const querySchema = Type.Object(
	{
		toolCallIds: Type.Array(Type.String({ description: "Tool-call IDs listed by a Context Janitor summary" }), {
			minItems: 1,
			description: "One or more pruned toolCallIds to retrieve",
		}),
		maxChars: Type.Optional(Type.Integer({
			minimum: 1_000,
			maximum: MAX_QUERY_MAX_CHARS,
			description: "Maximum characters of output to return across all requested records",
		})),
	},
	{ additionalProperties: false },
);

interface QueryParams {
	toolCallIds: string[];
	maxChars?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function parseString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parsePositiveInteger(value: unknown, min: number, max: number): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const rounded = Math.floor(value);
	if (rounded < min || rounded > max) return undefined;
	return rounded;
}

function parseRatio(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	if (value <= 0 || value >= 1) return undefined;
	return value;
}

function parseThinking(value: unknown): ThinkingSetting | undefined {
	if (typeof value !== "string") return undefined;
	switch (value.trim().toLowerCase()) {
		case "default":
		case "off":
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
			return value.trim().toLowerCase() as ThinkingSetting;
		default:
			return undefined;
	}
}

function parseSettings(raw: unknown): Partial<JanitorSettings> {
	if (typeof raw === "boolean") return { enabled: raw };
	if (!isRecord(raw)) return {};

	const out: Partial<JanitorSettings> = {};
	const enabled = parseBoolean(raw.enabled);
	const showStatus = parseBoolean(raw.showStatus);
	const summarizerModel = parseString(raw.summarizerModel);
	const summarizerThinking = parseThinking(raw.summarizerThinking);
	const minRawChars = parsePositiveInteger(raw.minRawChars, 0, 5_000_000);
	const minToolCalls = parsePositiveInteger(raw.minToolCalls, 1, 10_000);
	const contextUsagePercent = parsePositiveInteger(raw.contextUsagePercent, 0, 100);
	const debounceMs = parsePositiveInteger(raw.debounceMs, 0, 60_000);
	const maxInputChars = parsePositiveInteger(raw.maxInputChars, 2_000, 2_000_000);
	const maxSummaryTokens = parsePositiveInteger(raw.maxSummaryTokens, 128, 32_000);
	const maxSummaryRatio = parseRatio(raw.maxSummaryRatio);

	if (enabled !== undefined) out.enabled = enabled;
	if (showStatus !== undefined) out.showStatus = showStatus;
	if (summarizerModel !== undefined) out.summarizerModel = summarizerModel;
	if (summarizerThinking !== undefined) out.summarizerThinking = summarizerThinking;
	if (minRawChars !== undefined) out.minRawChars = minRawChars;
	if (minToolCalls !== undefined) out.minToolCalls = minToolCalls;
	if (contextUsagePercent !== undefined) out.contextUsagePercent = contextUsagePercent;
	if (debounceMs !== undefined) out.debounceMs = debounceMs;
	if (maxInputChars !== undefined) out.maxInputChars = maxInputChars;
	if (maxSummaryTokens !== undefined) out.maxSummaryTokens = maxSummaryTokens;
	if (maxSummaryRatio !== undefined) out.maxSummaryRatio = maxSummaryRatio;

	return out;
}

async function loadSettings(): Promise<{ settings: JanitorSettings; error?: string }> {
	try {
		const raw = await readFile(SETTINGS_PATH, "utf-8");
		try {
			return { settings: { ...DEFAULT_SETTINGS, ...parseSettings(JSON.parse(raw) as unknown) } };
		} catch (error) {
			return {
				settings: { ...DEFAULT_SETTINGS },
				error: `Failed to parse ${SETTINGS_PATH}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err?.code === "ENOENT") return { settings: { ...DEFAULT_SETTINGS } };
		return {
			settings: { ...DEFAULT_SETTINGS },
			error: `Failed to read ${SETTINGS_PATH}: ${err?.message ?? String(error)}`,
		};
	}
}

async function saveSettings(settings: JanitorSettings): Promise<void> {
	await mkdir(SETTINGS_DIR, { recursive: true });
	await writeFile(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

function emptyStats(): JanitorStats {
	return {
		summaries: 0,
		indexedToolCalls: 0,
		rawChars: 0,
		summaryChars: 0,
		skippedOversized: 0,
		inputTokens: 0,
		outputTokens: 0,
		cost: 0,
	};
}

function addUsage(stats: JanitorStats, usage: Usage | undefined): void {
	if (!usage) return;
	stats.inputTokens += usage.input ?? 0;
	stats.outputTokens += usage.output ?? 0;
	stats.cost += usage.cost?.total ?? 0;
}

function formatCount(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function formatChars(value: number): string {
	return `${formatCount(value)}ch`;
}

function formatCost(value: number): string {
	if (value <= 0) return "$0";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

function safeJson(value: unknown, maxChars = 4_000): string {
	try {
		return truncateMiddle(JSON.stringify(value, null, 2), maxChars);
	} catch {
		return truncateMiddle(String(value), maxChars);
	}
}

function truncateMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const marker = `\n...[truncated ${text.length - maxChars} chars]...\n`;
	const head = Math.max(0, Math.floor((maxChars - marker.length) * 0.58));
	const tail = Math.max(0, maxChars - marker.length - head);
	return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
		else if (part.type === "image") parts.push("[image]");
		else if (part.type === "thinking" && typeof part.thinking === "string") parts.push(part.thinking);
		else if (part.type === "toolCall") parts.push(`[toolCall ${String(part.name ?? "")}]`);
	}
	return parts.join("\n");
}

function assistantToolArgs(message: unknown): Map<string, unknown> {
	const out = new Map<string, unknown>();
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return out;
	for (const part of message.content) {
		if (!isRecord(part) || part.type !== "toolCall" || typeof part.id !== "string") continue;
		out.set(part.id, part.arguments);
	}
	return out;
}

function captureBatch(turnIndex: number, message: unknown, toolResults: ToolResultMessage[] | undefined, indexed: Map<string, ToolCallRecord>): CapturedBatch | undefined {
	if (!Array.isArray(toolResults) || toolResults.length === 0) return undefined;
	const argsById = assistantToolArgs(message);
	const toolCalls: PendingToolCallRecord[] = [];

	for (const result of toolResults) {
		if (!result?.toolCallId || indexed.has(result.toolCallId)) continue;
		const resultText = textFromContent(result.content);
		if (resultText.trim().length === 0) continue;
		toolCalls.push({
			toolCallId: result.toolCallId,
			toolName: result.toolName,
			args: argsById.get(result.toolCallId),
			resultText,
			isError: result.isError,
			turnIndex,
			timestamp: result.timestamp ?? Date.now(),
		});
	}

	if (toolCalls.length === 0) return undefined;
	return {
		turnIndex,
		toolCalls,
		rawChars: toolCalls.reduce((sum, tool) => sum + tool.resultText.length, 0),
		capturedAt: Date.now(),
	};
}

function pendingTotals(pendingBatches: CapturedBatch[]): { toolCalls: number; rawChars: number } {
	let toolCalls = 0;
	let rawChars = 0;
	for (const batch of pendingBatches) {
		toolCalls += batch.toolCalls.length;
		rawChars += batch.rawChars;
	}
	return { toolCalls, rawChars };
}

function shouldAutoFlush(settings: JanitorSettings, pendingBatches: CapturedBatch[], ctx?: ExtensionContext): boolean {
	const totals = pendingTotals(pendingBatches);
	if (totals.rawChars <= 0 || totals.toolCalls <= 0) return false;
	if (totals.rawChars >= settings.minRawChars || totals.toolCalls >= settings.minToolCalls) return true;

	const usage = ctx?.getContextUsage();
	return (
		settings.contextUsagePercent > 0 &&
		usage?.percent !== null &&
		usage?.percent !== undefined &&
		usage.percent >= settings.contextUsagePercent
	);
}

function makeSummaryId(): string {
	return `cj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildSummarizerInput(records: PendingToolCallRecord[], settings: JanitorSettings): string {
	const perRecordOutputBudget = Math.max(800, Math.floor(settings.maxInputChars / Math.max(records.length, 1)) - 700);
	const chunks = records.map((record, index) => {
		const status = record.isError ? "error" : "ok";
		return [
			`<tool index="${index + 1}" id="${record.toolCallId}" name="${record.toolName}" status="${status}" turn="${record.turnIndex}">`,
			"<args>",
			safeJson(record.args, 3_000),
			"</args>",
			"<output>",
			truncateMiddle(record.resultText, perRecordOutputBudget),
			"</output>",
			"</tool>",
		].join("\n");
	});

	const body = [
		"Summarize these completed coding-agent tool calls for future context pruning.",
		"The original raw outputs are archived separately and can be retrieved by ID, so summarize the important working-memory facts.",
		"",
		chunks.join("\n\n"),
	].join("\n");

	return truncateMiddle(body, settings.maxInputChars);
}

const AUTO_MODEL_CANDIDATES = [
	{ provider: "openai", modelId: "gpt-5.4-mini" },
	{ provider: "anthropic", modelId: "claude-haiku-4-5" },
	{ provider: "vercel-ai-gateway", modelId: "openai/gpt-5-nano" },
] as const;

function modelKey(provider: string, modelId: string): string {
	return `${provider}/${modelId}`.toLowerCase();
}

function findAutoCandidate(ctx: ExtensionContext, provider: string, modelId: string): Model<any> | undefined {
	const model = ctx.modelRegistry.find(provider, modelId) as Model<any> | undefined;
	if (!model) return undefined;
	const available = ctx.modelRegistry.getAvailable() as Model<any>[];
	const availableKeys = new Set(available.map(item => modelKey(String(item.provider), String(item.id))));
	return availableKeys.has(modelKey(provider, modelId)) ? model : undefined;
}

function resolveAutoModel(ctx: ExtensionContext): Model<any> {
	const activeProvider = ctx.model?.provider;
	if (activeProvider) {
		const activeCandidate = AUTO_MODEL_CANDIDATES.find(candidate => candidate.provider === activeProvider);
		if (activeCandidate) {
			const model = findAutoCandidate(ctx, activeCandidate.provider, activeCandidate.modelId);
			if (model) return model;
		}
	}

	for (const candidate of AUTO_MODEL_CANDIDATES) {
		const model = findAutoCandidate(ctx, candidate.provider, candidate.modelId);
		if (model) return model;
	}

	if (ctx.model) return ctx.model as Model<any>;
	throw new Error("No configured auto summarizer model is available. Configure OpenAI, Anthropic, or Vercel AI Gateway auth, or run /janitor model <provider/model>.");
}

function resolveModel(ctx: ExtensionContext, settings: JanitorSettings): Model<any> {
	if (settings.summarizerModel === "auto") return resolveAutoModel(ctx);
	if (settings.summarizerModel === "default") {
		if (!ctx.model) throw new Error("No active model; set /janitor model auto, /janitor model <provider/model>, or select a Pi model first.");
		return ctx.model as Model<any>;
	}

	const slash = settings.summarizerModel.indexOf("/");
	if (slash <= 0 || slash === settings.summarizerModel.length - 1) {
		throw new Error(`Invalid summarizer model ${JSON.stringify(settings.summarizerModel)}. Use provider/model, auto, or default.`);
	}

	const provider = settings.summarizerModel.slice(0, slash);
	const modelId = settings.summarizerModel.slice(slash + 1);
	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) throw new Error(`Summarizer model not found: ${settings.summarizerModel}`);
	return model as Model<any>;
}

function reasoningFromSetting(value: ThinkingSetting): Effort | undefined {
	return value === "default" || value === "off" ? undefined : value;
}

async function summarizeRecords(ctx: ExtensionContext, records: PendingToolCallRecord[], settings: JanitorSettings, signal: AbortSignal): Promise<{ summary: string; usage?: Usage; modelLabel: string }> {
	const model = resolveModel(ctx, settings);
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
	const input = buildSummarizerInput(records, settings);
	const response = await completeSimple(
		model,
		{
			systemPrompt: SUMMARY_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: input,
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey,
			signal,
			reasoning: reasoningFromSetting(settings.summarizerThinking),
			maxTokens: settings.maxSummaryTokens,
			temperature: 0,
		},
	);

	const summary = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map(part => part.text)
		.join("\n")
		.trim();

	if (!summary) throw new Error("Summarizer returned no text.");
	return { summary, usage: response.usage, modelLabel: `${model.provider}/${model.id}` };
}

function formatSummaryMessage(summaryId: string, summary: string, records: PendingToolCallRecord[]): string {
	const ids = records.map(record => record.toolCallId);
	const idList = ids.map(id => `\`${id}\``).join(", ");
	return [
		`[context-janitor] background summary \`${summaryId}\``,
		"",
		summary.trim(),
		"",
		`Summarized toolCallIds: ${idList}`,
		`Use \`${QUERY_TOOL_NAME}\` with these IDs to retrieve original full outputs if exact details are needed.`,
	].join("\n");
}

function entryFromSummary(summaryId: string, reason: string, records: PendingToolCallRecord[], summaryContent: string, result: { usage?: Usage; modelLabel: string }, settings: JanitorSettings): SummaryIndexEntry {
	return {
		version: 1,
		summaryId,
		createdAt: new Date().toISOString(),
		reason,
		rawChars: records.reduce((sum, record) => sum + record.resultText.length, 0),
		summaryChars: summaryContent.length,
		summarizerModel: result.modelLabel,
		summarizerThinking: settings.summarizerThinking,
		usage: result.usage,
		toolCalls: records.map(record => ({ ...record, summaryId })),
	};
}

function applyIndexEntry(entry: SummaryIndexEntry, index: Map<string, ToolCallRecord>, stats: JanitorStats): void {
	stats.summaries += 1;
	stats.rawChars += entry.rawChars;
	stats.summaryChars += entry.summaryChars;
	addUsage(stats, entry.usage);

	for (const record of entry.toolCalls) {
		if (!record.toolCallId || typeof record.resultText !== "string") continue;
		index.set(record.toolCallId, record);
	}
	stats.indexedToolCalls = index.size;
}

function parseIndexEntry(raw: unknown): SummaryIndexEntry | undefined {
	if (!isRecord(raw) || raw.version !== 1 || typeof raw.summaryId !== "string" || !Array.isArray(raw.toolCalls)) return undefined;
	const toolCalls: ToolCallRecord[] = [];
	for (const item of raw.toolCalls) {
		if (!isRecord(item)) continue;
		if (typeof item.toolCallId !== "string" || typeof item.toolName !== "string" || typeof item.resultText !== "string") continue;
		toolCalls.push({
			toolCallId: item.toolCallId,
			toolName: item.toolName,
			args: item.args,
			resultText: item.resultText,
			isError: item.isError === true,
			turnIndex: typeof item.turnIndex === "number" ? item.turnIndex : 0,
			timestamp: typeof item.timestamp === "number" ? item.timestamp : Date.now(),
			summaryId: typeof item.summaryId === "string" ? item.summaryId : raw.summaryId,
		});
	}
	if (toolCalls.length === 0) return undefined;
	return {
		version: 1,
		summaryId: raw.summaryId,
		createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
		reason: typeof raw.reason === "string" ? raw.reason : "reconstruct",
		rawChars: typeof raw.rawChars === "number" ? raw.rawChars : toolCalls.reduce((sum, record) => sum + record.resultText.length, 0),
		summaryChars: typeof raw.summaryChars === "number" ? raw.summaryChars : 0,
		summarizerModel: typeof raw.summarizerModel === "string" ? raw.summarizerModel : "unknown",
		summarizerThinking: parseThinking(raw.summarizerThinking) ?? "default",
		usage: isRecord(raw.usage) ? raw.usage as unknown as Usage : undefined,
		toolCalls,
	};
}

function visibleSummaryIds(messages: unknown[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (!isRecord(message)) continue;
		if (isRecord(message.details) && typeof message.details.summaryId === "string") ids.add(message.details.summaryId);
		const text = textFromContent(message.content);
		for (const match of text.matchAll(SUMMARY_ID_PATTERN)) ids.add(match[1]);
	}
	return ids;
}

function queryIndex(index: Map<string, ToolCallRecord>, params: QueryParams): { text: string; found: string[]; missing: string[] } {
	const ids = params.toolCallIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map(id => id.trim());
	const maxChars = Math.min(Math.max(params.maxChars ?? DEFAULT_QUERY_MAX_CHARS, 1_000), MAX_QUERY_MAX_CHARS);
	const perRecord = Math.max(1_000, Math.floor(maxChars / Math.max(ids.length, 1)));
	const found: string[] = [];
	const missing: string[] = [];
	const sections: string[] = [];

	for (const id of ids) {
		const record = index.get(id);
		if (!record) {
			missing.push(id);
			sections.push(`## ${id}\n\nNot found in Context Janitor index.`);
			continue;
		}

		found.push(id);
		sections.push([
			`## ${record.toolCallId} · ${record.toolName} · ${record.isError ? "error" : "ok"}`,
			`summaryId: ${record.summaryId}`,
			`turnIndex: ${record.turnIndex}`,
			"",
			"### Args",
			safeJson(record.args, 3_000),
			"",
			"### Original output",
			truncateMiddle(record.resultText, perRecord),
		].join("\n"));
	}

	return {
		text: [`# Context Janitor query`, `requested: ${ids.join(", ")}`, "", sections.join("\n\n")].join("\n"),
		found,
		missing,
	};
}

function splitArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

function parseModelAndThinking(arg: string): { model: string; thinking?: ThinkingSetting } {
	const idx = arg.lastIndexOf(":");
	if (idx > 0) {
		const maybeThinking = parseThinking(arg.slice(idx + 1));
		if (maybeThinking) return { model: arg.slice(0, idx), thinking: maybeThinking };
	}
	return { model: arg };
}

function statusLines(settings: JanitorSettings, stats: JanitorStats, pendingBatches: CapturedBatch[], index: Map<string, ToolCallRecord>, lastError: string | undefined, summarizing: boolean): string[] {
	const pending = pendingTotals(pendingBatches);
	const saved = Math.max(0, stats.rawChars - stats.summaryChars);
	const ratio = stats.rawChars > 0 ? `${Math.round((saved / stats.rawChars) * 100)}%` : "0%";
	const lines = [
		`context-janitor: ${settings.enabled ? "ON" : "OFF"}${summarizing ? " (summarizing…)" : ""}`,
		`settings: ${SETTINGS_PATH}`,
		`model: ${settings.summarizerModel}`,
		`thinking: ${settings.summarizerThinking}`,
		`threshold: ${formatChars(settings.minRawChars)} or ${settings.minToolCalls} tool call(s) or context ≥${settings.contextUsagePercent}%, debounce ${settings.debounceMs}ms`,
		`pending: ${pending.toolCalls} tool call(s), ${formatChars(pending.rawChars)}`,
		`indexed: ${index.size} tool call(s) across ${stats.summaries} summary message(s)`,
		`saved: ${formatChars(stats.rawChars)} raw → ${formatChars(stats.summaryChars)} summaries (${ratio}, ${formatChars(saved)} saved)`,
		`summarizer usage: ↑${formatCount(stats.inputTokens)} ↓${formatCount(stats.outputTokens)} ${formatCost(stats.cost)}`,
	];
	if (stats.skippedOversized > 0) lines.push(`skipped oversized summaries: ${stats.skippedOversized}`);
	if (lastError) lines.push(`lastError: ${lastError}`);
	return lines;
}

function helpText(): string {
	return [
		"/janitor status",
		"/janitor on | off",
		"/janitor now",
		"/janitor model [auto|default|provider/model[:thinking]]",
		"/janitor auto  # enable + reset hands-off defaults",
		"/janitor thinking [default|off|minimal|low|medium|high|xhigh]",
		"/janitor threshold <minRawChars> [minToolCalls]",
		"/janitor usage <percent>  # 0 disables context-pressure trigger",
		"/janitor debounce <ms>",
		"",
		"Background behavior: completed tool turns are captured on turn_end, summarized with the configured lightweight model, then pruned only after the summary is visible in context.",
	].join("\n");
}

export default function contextJanitor(pi: ExtensionAPI) {
	let settings: JanitorSettings = { ...DEFAULT_SETTINGS };
	let settingsError: string | undefined;
	let index = new Map<string, ToolCallRecord>();
	let stats = emptyStats();
	let pendingBatches: CapturedBatch[] = [];
	let lastError: string | undefined;
	let scheduleTimer: ReturnType<typeof setTimeout> | undefined;
	let flushPromise: Promise<void> | undefined;
	let activeController: AbortController | undefined;
	let generation = 0;
	let lastCtx: ExtensionContext | undefined;

	function abortBackground(): void {
		if (scheduleTimer) clearTimeout(scheduleTimer);
		scheduleTimer = undefined;
		activeController?.abort();
	}

	function updateStatus(ctx: ExtensionContext | undefined = lastCtx): void {
		if (!ctx) return;
		lastCtx = ctx;
		if (!settings.showStatus) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const pending = pendingTotals(pendingBatches);
		const saved = Math.max(0, stats.rawChars - stats.summaryChars);
		let text = settings.enabled ? "janitor: ON" : "janitor: OFF";
		if (settings.enabled && flushPromise) text = "janitor: summarizing…";
		else if (settings.enabled && pending.toolCalls > 0) text = `janitor: ${pending.toolCalls} pending`;
		else if (settings.enabled && saved > 0) text = `janitor: ON ↓${formatChars(saved)}`;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function reconstruct(ctx: ExtensionContext): void {
		index = new Map<string, ToolCallRecord>();
		stats = emptyStats();
		const seenSummaries = new Set<string>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== INDEX_CUSTOM_TYPE) continue;
			const parsed = parseIndexEntry(entry.data);
			if (!parsed || seenSummaries.has(parsed.summaryId)) continue;
			seenSummaries.add(parsed.summaryId);
			applyIndexEntry(parsed, index, stats);
		}
		stats.indexedToolCalls = index.size;
	}

	function scheduleFlush(ctx: ExtensionContext, reason: string, force = false): void {
		lastCtx = ctx;
		if (scheduleTimer) clearTimeout(scheduleTimer);
		const delay = force ? 0 : settings.debounceMs;
		scheduleTimer = setTimeout(() => {
			scheduleTimer = undefined;
			void flushPending(ctx, force, reason).catch(error => {
				lastError = error instanceof Error ? error.message : String(error);
				updateStatus(ctx);
			});
		}, delay);
		scheduleTimer.unref?.();
	}

	async function flushPending(ctx: ExtensionContext, force: boolean, reason: string): Promise<void> {
		lastCtx = ctx;
		if (flushPromise) return flushPromise;
		const runGeneration = generation;
		let failed = false;
		const promise = (async () => {
			if ((!settings.enabled && !force) || pendingBatches.length === 0) return;
			if (!force && !shouldAutoFlush(settings, pendingBatches, ctx)) return;

			const batches = pendingBatches;
			pendingBatches = [];
			const records = batches.flatMap(batch => batch.toolCalls).filter(record => !index.has(record.toolCallId));
			if (records.length === 0) return;

			const rawChars = records.reduce((sum, record) => sum + record.resultText.length, 0);

			activeController = new AbortController();
			updateStatus(ctx);

			try {
				const summaryId = makeSummaryId();
				const result = await summarizeRecords(ctx, records, settings, activeController.signal);
				if (activeController.signal.aborted) {
					failed = true;
					if (runGeneration === generation) pendingBatches = batches.concat(pendingBatches);
					return;
				}

				if (runGeneration !== generation) return;

				const summaryContent = formatSummaryMessage(summaryId, result.summary, records);
				if (summaryContent.length >= rawChars * settings.maxSummaryRatio) {
					stats.skippedOversized += 1;
					lastError = `Skipped oversized summary (${formatChars(summaryContent.length)} for ${formatChars(rawChars)} raw).`;
					return;
				}

				const entry = entryFromSummary(summaryId, reason, records, summaryContent, result, settings);
				pi.appendEntry(INDEX_CUSTOM_TYPE, entry);
				pi.sendMessage(
					{
						customType: SUMMARY_CUSTOM_TYPE,
						content: summaryContent,
						display: true,
						details: {
							summaryId,
							toolCallIds: records.map(record => record.toolCallId),
							rawChars: entry.rawChars,
							summaryChars: entry.summaryChars,
							summarizerModel: entry.summarizerModel,
						},
					},
					{ deliverAs: "steer" },
				);
				applyIndexEntry(entry, index, stats);
				lastError = undefined;
			} catch (error) {
				failed = true;
				if (runGeneration === generation) pendingBatches = batches.concat(pendingBatches);
				if (activeController.signal.aborted || runGeneration !== generation) return;
				lastError = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`Context Janitor summarizer failed: ${lastError}`, "warning");
			} finally {
				activeController = undefined;
			}
		})().finally(() => {
			if (flushPromise === promise) flushPromise = undefined;
			if (runGeneration !== generation) return;
			updateStatus(ctx);
			if (!failed && settings.enabled && pendingBatches.length > 0 && shouldAutoFlush(settings, pendingBatches, ctx)) {
				scheduleFlush(ctx, "follow-up");
			}
		});
		flushPromise = promise;
		return promise;
	}


	pi.registerTool({
		name: QUERY_TOOL_NAME,
		label: "Context Janitor Query",
		description: "Retrieve exact original tool outputs that Context Janitor pruned, by toolCallId.",
		promptSnippet: "Retrieve original raw outputs for Context Janitor summaries by toolCallId",
		promptGuidelines: [
			"When a Context Janitor summary is insufficient, call context_janitor_query with the listed toolCallIds instead of guessing exact raw output.",
		],
		parameters: querySchema,
		async execute(_toolCallId, params) {
			const result = queryIndex(index, params as QueryParams);
			return {
				content: [{ type: "text", text: result.text }],
				details: { found: result.found, missing: result.missing },
			};
		},
	});

	pi.registerCommand("janitor", {
		description: "Background context pruning with a lightweight sidecar model",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const parts = splitArgs(args);
			const sub = parts[0] ?? "status";

			try {
				switch (sub) {
					case "status":
					case "stats":
						ctx.ui.notify(statusLines(settings, stats, pendingBatches, index, lastError ?? settingsError, !!flushPromise).join("\n"), lastError || settingsError ? "warning" : "info");
						return;

					case "help":
						ctx.ui.notify(helpText(), "info");
						return;

					case "on":
						settings = { ...settings, enabled: true };
						await saveSettings(settings);
						settingsError = undefined;
						updateStatus(ctx);
						ctx.ui.notify("Context Janitor enabled.", "info");
						return;

					case "off":
						settings = { ...settings, enabled: false };
						await saveSettings(settings);
						abortBackground();
						settingsError = undefined;
						updateStatus(ctx);
						ctx.ui.notify("Context Janitor disabled.", "info");
						return;

					case "auto":
						settings = { ...settings, enabled: true, summarizerModel: "auto", summarizerThinking: "off", minRawChars: 8_000, minToolCalls: 8, contextUsagePercent: 55, debounceMs: 900 };
						await saveSettings(settings);
						settingsError = undefined;
						updateStatus(ctx);
						ctx.ui.notify("Context Janitor auto mode enabled: model=auto, thinking=off, threshold=8k chars/8 tools/context≥55%.", "info");
						return;

					case "now":
						if (!settings.enabled) {
							ctx.ui.notify("Context Janitor is off. Run /janitor on first.", "warning");
							return;
						}
						await flushPending(ctx, true, "manual");
						ctx.ui.notify(statusLines(settings, stats, pendingBatches, index, lastError, !!flushPromise).join("\n"), lastError ? "warning" : "info");
						return;

					case "model": {
						if (!parts[1]) {
							ctx.ui.notify(`summarizerModel: ${settings.summarizerModel}`, "info");
							return;
						}
						const parsed = parseModelAndThinking(parts[1]);
						settings = {
							...settings,
							summarizerModel: parsed.model,
							summarizerThinking: parsed.thinking ?? settings.summarizerThinking,
						};
						await saveSettings(settings);
						settingsError = undefined;
						updateStatus(ctx);
						ctx.ui.notify(`Context Janitor model: ${settings.summarizerModel}, thinking: ${settings.summarizerThinking}`, "info");
						return;
					}

					case "thinking": {
						if (!parts[1]) {
							ctx.ui.notify(`summarizerThinking: ${settings.summarizerThinking}`, "info");
							return;
						}
						const thinking = parseThinking(parts[1]);
						if (!thinking) throw new Error("Thinking must be default, off, minimal, low, medium, high, or xhigh.");
						settings = { ...settings, summarizerThinking: thinking };
						await saveSettings(settings);
						settingsError = undefined;
						updateStatus(ctx);
						ctx.ui.notify(`Context Janitor thinking: ${settings.summarizerThinking}`, "info");
						return;
					}

					case "threshold": {
						const minRawChars = Number(parts[1]);
						if (!Number.isFinite(minRawChars) || minRawChars < 0) throw new Error("Usage: /janitor threshold <minRawChars> [minToolCalls]");
						const minToolCalls = parts[2] === undefined ? settings.minToolCalls : Number(parts[2]);
						if (!Number.isFinite(minToolCalls) || minToolCalls < 1) throw new Error("minToolCalls must be >= 1.");
						settings = { ...settings, minRawChars: Math.floor(minRawChars), minToolCalls: Math.floor(minToolCalls) };
						await saveSettings(settings);
						settingsError = undefined;
						updateStatus(ctx);
						ctx.ui.notify(`Context Janitor threshold: ${formatChars(settings.minRawChars)} or ${settings.minToolCalls} tool call(s).`, "info");
						return;
					}

					case "usage": {
						if (!parts[1]) {
							ctx.ui.notify(`contextUsagePercent: ${settings.contextUsagePercent}%`, "info");
							return;
						}
						const contextUsagePercent = Number(parts[1]);
						if (!Number.isFinite(contextUsagePercent) || contextUsagePercent < 0 || contextUsagePercent > 100) throw new Error("Usage: /janitor usage <0-100>");
						settings = { ...settings, contextUsagePercent: Math.floor(contextUsagePercent) };
						await saveSettings(settings);
						settingsError = undefined;
						updateStatus(ctx);
						ctx.ui.notify(`Context Janitor context-pressure threshold: ${settings.contextUsagePercent}%`, "info");
						return;
					}

					case "debounce": {
						const debounceMs = Number(parts[1]);
						if (!Number.isFinite(debounceMs) || debounceMs < 0) throw new Error("Usage: /janitor debounce <ms>");
						settings = { ...settings, debounceMs: Math.floor(debounceMs) };
						await saveSettings(settings);
						settingsError = undefined;
						updateStatus(ctx);
						ctx.ui.notify(`Context Janitor debounce: ${settings.debounceMs}ms`, "info");
						return;
					}

					default:
						ctx.ui.notify(`Unknown /janitor command: ${sub}\n\n${helpText()}`, "warning");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Context Janitor: ${message}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		generation += 1;
		abortBackground();
		pendingBatches = [];
		lastCtx = ctx;
		const loaded = await loadSettings();
		settings = loaded.settings;
		settingsError = loaded.error;
		reconstruct(ctx);
		updateStatus(ctx);
		if (settingsError && ctx.hasUI) ctx.ui.notify(settingsError, "warning");
	});

	pi.on("session_tree", async (_event, ctx) => {
		generation += 1;
		abortBackground();
		pendingBatches = [];
		lastCtx = ctx;
		reconstruct(ctx);
		updateStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		lastCtx = ctx;
		if (!settings.enabled) {
			updateStatus(ctx);
			return;
		}
		const batch = captureBatch(event.turnIndex, event.message, event.toolResults as ToolResultMessage[] | undefined, index);
		if (!batch) {
			updateStatus(ctx);
			return;
		}
		pendingBatches.push(batch);
		updateStatus(ctx);
		if (shouldAutoFlush(settings, pendingBatches, ctx)) scheduleFlush(ctx, "turn_end");
	});

	pi.on("agent_end", async (_event, ctx) => {
		lastCtx = ctx;
		if (settings.enabled && pendingBatches.length > 0 && shouldAutoFlush(settings, pendingBatches, ctx)) scheduleFlush(ctx, "agent_end");
		updateStatus(ctx);
	});

	pi.on("context", async (event) => {
		if (!settings.enabled || index.size === 0) return;
		const visible = visibleSummaryIds(event.messages);
		if (visible.size === 0) return;

		let removed = 0;
		const messages = event.messages.filter(message => {
			if (!isRecord(message) || message.role !== "toolResult" || typeof message.toolCallId !== "string") return true;
			const record = index.get(message.toolCallId);
			if (!record || !visible.has(record.summaryId)) return true;
			removed += 1;
			return false;
		});

		if (removed === 0) return;
		return { messages };
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		generation += 1;
		abortBackground();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
