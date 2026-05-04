import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { completeSimple as complete, type Model, type ToolResultMessage, type Usage } from "@mariozechner/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";

const SETTINGS_DIR = join(getAgentDir(), "context-janitor");
const SETTINGS_PATH = join(SETTINGS_DIR, "settings.json");

const INDEX_CUSTOM_TYPE = "context-janitor-index";
const RESTORE_CUSTOM_TYPE = "context-janitor-restore";
const SUMMARY_CUSTOM_TYPE = "context-janitor-summary";
const STATUS_KEY = "context-janitor";
const JANITOR_CUSTOM_TYPES = new Set([INDEX_CUSTOM_TYPE, RESTORE_CUSTOM_TYPE, SUMMARY_CUSTOM_TYPE]);

const DEBOUNCE_MS = 900;
const MAX_DECIDER_INPUT_CHARS = 60_000;
const MAX_RECORDS_PER_PASS = 24;
const MAX_DECIDER_TOKENS = 1_000;

const DECIDER_SYSTEM_PROMPT = `You are Context Janitor, a conservative background context cleaner for a coding agent.

You receive JSON objects representing completed tool results. Each object has an id and a hash. Decide which tool-result outputs are safe to truncate from future model context.

Output JSON only:
{"actions":[{"target":{"id":"...","hash":"..."},"action":"truncate|keep","reason":"..."}]}

Policy:
- Truncate only operational clutter: duplicate/noisy output, progress logs, stale failed attempts that were corrected, typo commands, irrelevant exploration, or huge output with no durable fact.
- Keep unresolved errors, the latest test/build/lint result, file contents/snippets likely needed, command outputs with side effects, permission/network failures, and anything uncertain.
- Be conservative. If unsure, keep.
- Never invent ids or hashes. Use only the provided id/hash pairs.`;

interface JanitorSettings {
	enabled: boolean;
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
	hash?: string;
	janitorReason?: string;
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
	projectedChars: number;
	deciderModel: string;
	usage?: Usage;
	toolCalls: ToolCallRecord[];
}

interface RestoreIndexEntry {
	version: 1;
	restoreId: string;
	createdAt: string;
	reason: string;
	summaryIds: string[];
}

interface DeciderObject {
	id: string;
	hash: string;
	kind: "tool_result";
	toolName: string;
	status: "ok" | "error";
	turnIndex: number;
	rawChars: number;
	argsPreview: string;
	outputPreview: string;
}

interface DeciderAction {
	target: { id: string; hash: string };
	action: "truncate" | "keep";
	reason: string;
}

const DEFAULT_SETTINGS: JanitorSettings = {
	enabled: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettings(raw: unknown): Partial<JanitorSettings> {
	if (typeof raw === "boolean") return { enabled: raw };
	if (!isRecord(raw)) return {};
	return typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {};
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

function formatCount(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function formatChars(value: number): string {
	return `${formatCount(value)}ch`;
}

function truncateMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 1) return "…".slice(0, Math.max(0, maxChars));
	const marker = `\n...[truncated ${text.length - maxChars} chars]...\n`;
	if (marker.length >= maxChars) return `${text.slice(0, maxChars - 1)}…`;
	const head = Math.max(0, Math.floor((maxChars - marker.length) * 0.58));
	const tail = Math.max(0, maxChars - marker.length - head);
	return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}

function safeJson(value: unknown, maxChars = 4_000): string {
	try {
		const text = JSON.stringify(value, null, 2);
		return truncateMiddle(text === undefined ? "undefined" : text, maxChars);
	} catch {
		return truncateMiddle(String(value), maxChars);
	}
}


function stableJson(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function hashObject(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16);
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

function batchFromRecords(records: PendingToolCallRecord[]): CapturedBatch | undefined {
	if (records.length === 0) return undefined;
	return {
		turnIndex: Math.min(...records.map(record => record.turnIndex)),
		toolCalls: records,
		rawChars: records.reduce((sum, record) => sum + record.resultText.length, 0),
		capturedAt: Date.now(),
	};
}

function makeSummaryId(): string {
	return `cj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeRestoreId(): string {
	return `cj-restore-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

function resolveLightweightModel(ctx: ExtensionContext): Model<any> {
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
	throw new Error("No lightweight janitor model is available. Configure OpenAI, Anthropic, Vercel AI Gateway, or select an active Pi model.");
}

function deciderObject(record: PendingToolCallRecord, argsBudget: number, outputBudget: number): DeciderObject {
	const object = {
		id: record.toolCallId,
		kind: "tool_result" as const,
		toolName: record.toolName,
		status: record.isError ? "error" as const : "ok" as const,
		turnIndex: record.turnIndex,
		rawChars: record.resultText.length,
		argsPreview: safeJson(record.args, argsBudget),
		outputPreview: truncateMiddle(record.resultText, outputBudget),
	};
	return { ...object, hash: hashObject(object) };
}

function buildDeciderInput(records: PendingToolCallRecord[]): { input: string; candidates: Map<string, DeciderObject> } {
	let argsBudget = 1_200;
	let outputBudget = 2_000;
	let objects: DeciderObject[] = [];
	let input = "";

	for (let attempt = 0; attempt < 8; attempt += 1) {
		objects = records.map(record => deciderObject(record, argsBudget, outputBudget));
		input = JSON.stringify({
			instruction: "For each tool_result object, choose action=truncate only if its output is safe to replace with an archive marker in future context. Otherwise choose keep.",
			actions: ["truncate", "keep"],
			objects,
		}, null, 2);
		if (input.length <= MAX_DECIDER_INPUT_CHARS) break;
		argsBudget = Math.max(160, Math.floor(argsBudget * 0.55));
		outputBudget = Math.max(240, Math.floor(outputBudget * 0.55));
	}

	if (input.length > MAX_DECIDER_INPUT_CHARS) {
		throw new Error(`Janitor decider input is too large (${formatChars(input.length)}).`);
	}

	return { input, candidates: new Map(objects.map(object => [object.id, object] as const)) };
}

function extractJsonObject(text: string): unknown {
	const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
	try {
		return JSON.parse(cleaned) as unknown;
	} catch {
		const start = cleaned.indexOf("{");
		const end = cleaned.lastIndexOf("}");
		if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as unknown;
		throw new Error("Janitor decider returned non-JSON output.");
	}
}

function parseDeciderActions(raw: unknown, candidates: Map<string, DeciderObject>): DeciderAction[] {
	if (!isRecord(raw) || !Array.isArray(raw.actions)) throw new Error("Janitor decider JSON must contain an actions array.");
	const out: DeciderAction[] = [];
	for (const item of raw.actions) {
		if (!isRecord(item) || !isRecord(item.target)) continue;
		const id = typeof item.target.id === "string" ? item.target.id : undefined;
		const hash = typeof item.target.hash === "string" ? item.target.hash : undefined;
		const action = item.action === "truncate" || item.action === "hide" ? "truncate" : item.action === "keep" ? "keep" : undefined;
		if (!id || !hash || !action) continue;
		const candidate = candidates.get(id);
		if (!candidate || candidate.hash !== hash) continue;
		out.push({
			target: { id, hash },
			action,
			reason: typeof item.reason === "string" && item.reason.trim() ? item.reason.trim().slice(0, 160) : action,
		});
	}
	return out;
}

async function decideRecords(ctx: ExtensionContext, records: PendingToolCallRecord[], signal: AbortSignal): Promise<{ records: PendingToolCallRecord[]; usage?: Usage; modelLabel: string }> {
	const model = resolveLightweightModel(ctx);
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
	const { input, candidates } = buildDeciderInput(records);
	const response = await complete(
		model,
		{
			systemPrompt: DECIDER_SYSTEM_PROMPT,
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
			maxTokens: MAX_DECIDER_TOKENS,
			temperature: 0,
		},
	);

	const text = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map(part => part.text)
		.join("\n")
		.trim();
	if (!text) throw new Error("Janitor decider returned no text.");

	const actions = parseDeciderActions(extractJsonObject(text), candidates);
	const truncateById = new Map(actions.filter(action => action.action === "truncate").map(action => [action.target.id, action] as const));
	return {
		records: records
			.filter(record => truncateById.has(record.toolCallId))
			.map(record => {
				const action = truncateById.get(record.toolCallId)!;
				return { ...record, hash: action.target.hash, janitorReason: action.reason };
			}),
		usage: response.usage,
		modelLabel: `${model.provider}/${model.id}`,
	};
}

function summarizeToolNames(records: ReadonlyArray<{ toolName: string }>, maxNames = 5): string {
	const counts = new Map<string, number>();
	for (const record of records) counts.set(record.toolName, (counts.get(record.toolName) ?? 0) + 1);
	const parts = Array.from(counts.entries())
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([name, count]) => count > 1 ? `${name}×${count}` : name);
	if (parts.length <= maxNames) return parts.join(", ");
	return `${parts.slice(0, maxNames).join(", ")} +${parts.length - maxNames} more`;
}

function projectionText(record: ToolCallRecord): string {
	return [
		"[context-janitor] tool result truncated",
		`toolCallId: ${record.toolCallId}`,
		`tool: ${record.toolName}`,
		`hash: ${record.hash ?? "unknown"}`,
		`raw: ${formatChars(record.resultText.length)}`,
		record.janitorReason ? `reason: ${record.janitorReason}` : undefined,
		"restore: /janitor undo",
	].filter((line): line is string => typeof line === "string").join("\n");
}

function formatRunMessage(summaryId: string, records: PendingToolCallRecord[]): string {
	const rawChars = records.reduce((sum, record) => sum + record.resultText.length, 0);
	const reasons = records
		.map(record => record.janitorReason)
		.filter((reason): reason is string => typeof reason === "string" && reason.length > 0)
		.slice(0, 6);
	return [
		`[context-janitor] truncated tool outputs \`${summaryId}\``,
		"",
		`Truncated ${records.length} tool output(s), ${formatChars(rawChars)} raw.`,
		`Tools: ${summarizeToolNames(records)}`,
		"Restore with /janitor undo.",
		...(reasons.length > 0 ? ["", "Reasons:", ...reasons.map(reason => `- ${reason}`)] : []),
	].join("\n");
}

function entryFromRun(summaryId: string, reason: string, records: PendingToolCallRecord[], result: { usage?: Usage; modelLabel: string }): SummaryIndexEntry {
	const toolCalls = records.map(record => ({ ...record, summaryId }));
	return {
		version: 1,
		summaryId,
		createdAt: new Date().toISOString(),
		reason,
		rawChars: toolCalls.reduce((sum, record) => sum + record.resultText.length, 0),
		projectedChars: toolCalls.reduce((sum, record) => sum + projectionText(record).length, 0),
		deciderModel: result.modelLabel,
		usage: result.usage,
		toolCalls,
	};
}

function applyIndexEntry(entry: SummaryIndexEntry, index: Map<string, ToolCallRecord>, entries: Map<string, SummaryIndexEntry>): void {
	entries.set(entry.summaryId, entry);

	for (const record of entry.toolCalls) {
		if (!record.toolCallId || typeof record.resultText !== "string") continue;
		index.set(record.toolCallId, record);
	}
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
			hash: typeof item.hash === "string" ? item.hash : undefined,
			janitorReason: typeof item.janitorReason === "string" ? item.janitorReason : undefined,
		});
	}
	if (toolCalls.length === 0 || toolCalls.some(record => typeof record.hash !== "string")) return undefined;
	return {
		version: 1,
		summaryId: raw.summaryId,
		createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
		reason: typeof raw.reason === "string" ? raw.reason : "reconstruct",
		rawChars: typeof raw.rawChars === "number" ? raw.rawChars : toolCalls.reduce((sum, record) => sum + record.resultText.length, 0),
		projectedChars: typeof raw.projectedChars === "number" ? raw.projectedChars : toolCalls.reduce((sum, record) => sum + projectionText(record).length, 0),
		deciderModel: typeof raw.deciderModel === "string" ? raw.deciderModel : "unknown",
		usage: isRecord(raw.usage) ? raw.usage as unknown as Usage : undefined,
		toolCalls,
	};
}

function parseRestoreEntry(raw: unknown): RestoreIndexEntry | undefined {
	if (!isRecord(raw) || raw.version !== 1 || typeof raw.restoreId !== "string" || !Array.isArray(raw.summaryIds)) return undefined;
	const summaryIds = raw.summaryIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map(id => id.trim());
	if (summaryIds.length === 0) return undefined;
	return {
		version: 1,
		restoreId: raw.restoreId,
		createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
		reason: typeof raw.reason === "string" ? raw.reason : "restore",
		summaryIds: [...new Set(summaryIds)],
	};
}

function activeSavings(entries: Map<string, SummaryIndexEntry>, restoredSummaryIds: Set<string>): { activeRuns: number; restoredRuns: number; rawChars: number; projectedChars: number; savedChars: number } {
	let activeRuns = 0;
	let restoredRuns = 0;
	let rawChars = 0;
	let projectedChars = 0;
	for (const entry of entries.values()) {
		if (restoredSummaryIds.has(entry.summaryId)) {
			restoredRuns += 1;
			continue;
		}
		activeRuns += 1;
		rawChars += entry.rawChars;
		projectedChars += entry.projectedChars;
	}
	return { activeRuns, restoredRuns, rawChars, projectedChars, savedChars: Math.max(0, rawChars - projectedChars) };
}

function splitArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "    ");
}

type KeybindingsLike = { matches(data: string, action: string): boolean };
type ThemeLike = ExtensionContext["ui"]["theme"];

interface UndoRunItem {
	summaryId: string;
	label: string;
	description: string;
}

function themeFg(theme: ThemeLike, color: string, text: string): string {
	try {
		return theme.fg(color as never, text);
	} catch {
		return text;
	}
}

function themeBold(theme: ThemeLike, text: string): string {
	try {
		return theme.bold(text);
	} catch {
		return text;
	}
}

function shortTimestamp(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function undoRunItems(entries: Map<string, SummaryIndexEntry>, restoredSummaryIds: Set<string>): UndoRunItem[] {
	return Array.from(entries.values())
		.filter(entry => !restoredSummaryIds.has(entry.summaryId) && entry.rawChars > 0)
		.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
		.map(entry => {
			const saved = Math.max(0, entry.rawChars - entry.projectedChars);
			return {
				summaryId: entry.summaryId,
				label: `${shortTimestamp(entry.createdAt)}  truncated ${entry.toolCalls.length} tool output(s)`,
				description: `${entry.summaryId} · ${summarizeToolNames(entry.toolCalls)} · saved ≈${formatChars(saved)}`,
			};
		});
}

class JanitorUndoPicker implements Component {
	#selectedIndex = 0;
	#checked = new Set<string>();

	constructor(
		private readonly items: UndoRunItem[],
		private readonly theme: ThemeLike,
		private readonly keybindings: KeybindingsLike,
		private readonly done: (result: string[] | undefined) => void,
	) {}

	invalidate(): void {
		// No cached layout.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const lines: string[] = [themeBold(this.theme, "Restore janitor actions"), ""];
		if (this.items.length === 0) {
			lines.push("  Nothing to restore.", "", themeFg(this.theme, "muted", "  Esc = close"));
			return lines.map(line => truncateToWidth(replaceTabs(line), safeWidth));
		}

		const maxVisible = Math.min(10, Math.max(4, this.items.length));
		const startIndex = Math.max(0, Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), this.items.length - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, this.items.length);
		for (let i = startIndex; i < endIndex; i += 1) {
			const item = this.items[i];
			if (!item) continue;
			const selected = i === this.#selectedIndex;
			const checked = this.#checked.has(item.summaryId);
			const prefix = selected ? "›" : " ";
			const mark = checked ? "[x]" : "[ ]";
			const line = `${prefix} ${mark} ${item.label}`;
			lines.push(selected ? themeFg(this.theme, "accent", line) : line);
			if (selected) lines.push(themeFg(this.theme, "muted", `      ${item.description}`));
		}
		if (startIndex > 0 || endIndex < this.items.length) lines.push(themeFg(this.theme, "muted", `  (${this.#selectedIndex + 1}/${this.items.length})`));
		lines.push("", themeFg(this.theme, "muted", `  Space = toggle · a = all · Enter = restore ${this.#checked.size} selected · Esc = cancel`));
		return lines.map(line => truncateToWidth(replaceTabs(line), safeWidth));
	}

	handleInput(data: string): void {
		if (this.#matches(data, "tui.select.cancel") || this.#matches(data, "interrupt") || data === "\u001b" || data === "\u0003") {
			this.done(undefined);
			return;
		}
		if (this.items.length === 0) return;
		if (this.#matches(data, "tui.select.up") || data === "\u001b[A") {
			this.#selectedIndex = this.#selectedIndex === 0 ? this.items.length - 1 : this.#selectedIndex - 1;
			return;
		}
		if (this.#matches(data, "tui.select.down") || data === "\u001b[B") {
			this.#selectedIndex = this.#selectedIndex === this.items.length - 1 ? 0 : this.#selectedIndex + 1;
			return;
		}
		if (this.#matches(data, "tui.select.pageUp")) {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 10);
			return;
		}
		if (this.#matches(data, "tui.select.pageDown")) {
			this.#selectedIndex = Math.min(this.items.length - 1, this.#selectedIndex + 10);
			return;
		}
		if (data === " ") {
			this.#toggle(this.items[this.#selectedIndex]?.summaryId);
			return;
		}
		if (data.toLowerCase() === "a") {
			if (this.#checked.size === this.items.length) this.#checked.clear();
			else for (const item of this.items) this.#checked.add(item.summaryId);
			return;
		}
		if (this.#matches(data, "tui.select.confirm") || data === "\r" || data === "\n") {
			this.done([...this.#checked]);
		}
	}

	#toggle(summaryId: string | undefined): void {
		if (!summaryId) return;
		if (this.#checked.has(summaryId)) this.#checked.delete(summaryId);
		else this.#checked.add(summaryId);
	}

	#matches(data: string, action: string): boolean {
		try {
			return this.keybindings.matches(data, action);
		} catch {
			return false;
		}
	}
}

export default function contextJanitor(pi: ExtensionAPI) {
	let settings: JanitorSettings = { ...DEFAULT_SETTINGS };
	let settingsError: string | undefined;
	let index = new Map<string, ToolCallRecord>();
	let entries = new Map<string, SummaryIndexEntry>();
	let restoredSummaryIds = new Set<string>();

	let pendingBatches: CapturedBatch[] = [];

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
		const pending = pendingTotals(pendingBatches);
		const active = activeSavings(entries, restoredSummaryIds);
		let text = settings.enabled ? "janitor: ON" : "janitor: OFF";
		if (settings.enabled && flushPromise) text = "janitor: deciding…";
		else if (settings.enabled && pending.toolCalls > 0) text = `janitor: ${pending.toolCalls} pending`;
		else if (settings.enabled && active.savedChars > 0) text = `janitor: ON ↓${formatChars(active.savedChars)}`;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function reconstruct(ctx: ExtensionContext): void {
		index = new Map<string, ToolCallRecord>();
		entries = new Map<string, SummaryIndexEntry>();
		restoredSummaryIds = new Set<string>();

		const seenSummaries = new Set<string>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (!isRecord(entry) || entry.type !== "custom") continue;
			if (entry.customType === INDEX_CUSTOM_TYPE) {
				const parsed = parseIndexEntry(entry.data);
				if (!parsed || seenSummaries.has(parsed.summaryId)) continue;
				seenSummaries.add(parsed.summaryId);
				applyIndexEntry(parsed, index, entries);
			} else if (entry.customType === RESTORE_CUSTOM_TYPE) {
				const parsed = parseRestoreEntry(entry.data);
				if (!parsed) continue;
				for (const summaryId of parsed.summaryIds) restoredSummaryIds.add(summaryId);
			}
		}
	}

	function scheduleFlush(ctx: ExtensionContext, reason: string): void {
		lastCtx = ctx;
		if (!settings.enabled || pendingBatches.length === 0) return;
		if (scheduleTimer) clearTimeout(scheduleTimer);
		scheduleTimer = setTimeout(() => {
			scheduleTimer = undefined;
			void flushPending(ctx, reason).catch(error => {
				if (ctx.hasUI) ctx.ui.notify(`Context Janitor failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
				updateStatus(ctx);
			});
		}, DEBOUNCE_MS);
		scheduleTimer.unref?.();
	}

	async function flushPending(ctx: ExtensionContext, reason: string): Promise<void> {
		lastCtx = ctx;
		if (flushPromise) return flushPromise;
		const runGeneration = generation;
		let failed = false;
		const promise = (async () => {
			if (!settings.enabled || pendingBatches.length === 0) return;

			const batches = pendingBatches;
			pendingBatches = [];
			const allRecords = batches.flatMap(batch => batch.toolCalls).filter(record => !index.has(record.toolCallId));
			const passRecords = allRecords.slice(0, MAX_RECORDS_PER_PASS);
			const restRecords = allRecords.slice(MAX_RECORDS_PER_PASS);
			const restBatch = batchFromRecords(restRecords);
			if (restBatch) pendingBatches.push(restBatch);
			if (passRecords.length === 0) return;

			const controller = new AbortController();
			activeController = controller;
			updateStatus(ctx);

			try {
				const summaryId = makeSummaryId();
				const decided = await decideRecords(ctx, passRecords, controller.signal);
				const selectedRecords = decided.records;
				if (controller.signal.aborted) {
					failed = true;
					const retry = batchFromRecords(passRecords.concat(restRecords));
					if (runGeneration === generation && retry) pendingBatches = [retry, ...pendingBatches.filter(batch => batch !== restBatch)];
					return;
				}

				if (runGeneration !== generation) return;
				if (selectedRecords.length === 0) return;

				const entry = entryFromRun(summaryId, reason, selectedRecords, { usage: decided.usage, modelLabel: decided.modelLabel });
				const summaryContent = formatRunMessage(summaryId, selectedRecords);
				pi.appendEntry(INDEX_CUSTOM_TYPE, entry);
				pi.sendMessage({
					customType: SUMMARY_CUSTOM_TYPE,
					content: summaryContent,
					display: true,
					details: {
						summaryId,
						toolCallIds: selectedRecords.map(record => record.toolCallId),
						rawChars: entry.rawChars,
						projectedChars: entry.projectedChars,
						deciderModel: entry.deciderModel,
					},
				}, { deliverAs: "nextTurn" });
				if (!ctx.isIdle() && ctx.hasUI) ctx.ui.notify(summaryContent, "info");
				applyIndexEntry(entry, index, entries);

			} catch (error) {
				failed = true;
				const retry = batchFromRecords(passRecords.concat(restRecords));
				if (runGeneration === generation && retry) pendingBatches = [retry, ...pendingBatches.filter(batch => batch !== restBatch)];
				if (controller.signal.aborted || runGeneration !== generation) return;
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`Context Janitor failed: ${message}`, "warning");
			} finally {
				if (activeController === controller) activeController = undefined;
			}
		})().finally(() => {
			if (flushPromise === promise) flushPromise = undefined;
			if (runGeneration !== generation) return;
			updateStatus(ctx);
			if (!failed && settings.enabled && pendingBatches.length > 0) scheduleFlush(ctx, "follow-up");
		});
		flushPromise = promise;
		return promise;
	}

	function restoreSummaryIds(summaryIds: string[], reason: string, ctx?: ExtensionContext): number {
		const uniqueIds = [...new Set(summaryIds.map(id => id.trim()).filter(Boolean))];
		const restorable = uniqueIds.filter(summaryId => entries.has(summaryId) && !restoredSummaryIds.has(summaryId));
		if (restorable.length === 0) return 0;
		const restoreEntry: RestoreIndexEntry = {
			version: 1,
			restoreId: makeRestoreId(),
			createdAt: new Date().toISOString(),
			reason,
			summaryIds: restorable,
		};
		pi.appendEntry(RESTORE_CUSTOM_TYPE, restoreEntry);
		for (const summaryId of restorable) restoredSummaryIds.add(summaryId);
		updateStatus(ctx);
		return restorable.length;
	}

	function restoreListText(): string {
		const items = undoRunItems(entries, restoredSummaryIds);
		if (items.length === 0) return "No janitor runs are currently truncated.";
		return [
			"Restorable janitor runs:",
			...items.map(item => `- ${item.summaryId}: ${item.label} — ${item.description}`),
			"",
			"Run /janitor undo in the interactive TUI to restore selected runs.",
		].join("\n");
	}

	async function openUndoPicker(ctx: ExtensionContext): Promise<void> {
		lastCtx = ctx;
		const items = undoRunItems(entries, restoredSummaryIds);
		if (items.length === 0) {
			ctx.ui.notify("Context Janitor: nothing to restore.", "info");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(restoreListText(), "info");
			return;
		}

		let selected: string[] | undefined;
		try {
			selected = await ctx.ui.custom<string[] | undefined>((_tui, theme, keybindings, done) => {
				return new JanitorUndoPicker(items, theme, keybindings as unknown as KeybindingsLike, done);
			}, { overlay: true });
		} catch {
			ctx.ui.notify(restoreListText(), "info");
			return;
		}

		if (!selected || selected.length === 0) {
			ctx.ui.notify("Context Janitor: restore cancelled/no selection.", "info");
			return;
		}
		const count = restoreSummaryIds(selected, "user-undo", ctx);
		ctx.ui.notify(count > 0 ? `Context Janitor restored ${count} run(s). Future model context will include those raw tool outputs again.` : "Context Janitor: selected run(s) were already restored.", "info");
	}

	pi.registerCommand("janitor", {
		description: "Context janitor controls: on, off, undo",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const sub = splitArgs(args)[0]?.toLowerCase() ?? "";

			try {
				switch (sub) {
					case "on":
						settings = { enabled: true };
						await saveSettings(settings);
						settingsError = undefined;
						updateStatus(ctx);
						if (pendingBatches.length > 0) scheduleFlush(ctx, "manual-on");
						ctx.ui.notify("Context Janitor enabled.", "info");
						return;

					case "off":
						settings = { enabled: false };
						await saveSettings(settings);
						generation += 1;
						abortBackground();
						pendingBatches = [];
						settingsError = undefined;
						updateStatus(ctx);
						ctx.ui.notify("Context Janitor disabled. Raw tool outputs will remain in model context.", "info");
						return;

					case "undo":
						await openUndoPicker(ctx);
						return;

					case "":
						ctx.ui.notify("Usage: /janitor on | off | undo", settingsError ? "warning" : "info");
						return;

					default:
						ctx.ui.notify("Usage: /janitor on | off | undo", "warning");
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
		scheduleFlush(ctx, "turn_end");
	});

	pi.on("agent_end", async (_event, ctx) => {
		lastCtx = ctx;
		if (settings.enabled && pendingBatches.length > 0) scheduleFlush(ctx, "agent_end");
		updateStatus(ctx);
	});

	pi.on("context", async (event) => {
		let changed = false;
		const messages = event.messages.flatMap(message => {
			if (isRecord(message) && message.role === "custom" && typeof message.customType === "string" && JANITOR_CUSTOM_TYPES.has(message.customType)) {
				changed = true;
				return [];
			}

			if (!settings.enabled || !isRecord(message) || message.role !== "toolResult" || typeof message.toolCallId !== "string") return [message];
			const record = index.get(message.toolCallId);
			if (!record || restoredSummaryIds.has(record.summaryId) || !entries.has(record.summaryId)) return [message];

			changed = true;
			return [{ ...message, details: undefined, content: [{ type: "text" as const, text: projectionText(record) }] }];
		});

		if (!changed) return;
		return { messages };
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		generation += 1;
		abortBackground();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
