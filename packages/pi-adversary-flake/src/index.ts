import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import {
	type AssistantMessage,
	type ImageContent,
	type Model,
	StringEnum,
	type TextContent,
	type ThinkingLevel,
	type ToolResultMessage,
} from "@mariozechner/pi-ai";
import {
	createReadOnlyTools,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ReadonlyFooterDataProvider,
	type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const SETTINGS_FILE_NAME = "extension-settings.json";
const REVIEWER_APPROVE_TOOL = "adversary_approve";
const REVIEWER_RERUN_TOOL = "adversary_rerun";
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CONFIDENCE_VALUES = ["low", "medium", "high"] as const;
const reviewerApproveSchema = Type.Object({
	confidence: StringEnum(CONFIDENCE_VALUES, { description: "Confidence in the approval decision" }),
	message: Type.String({ description: "One concise paragraph explaining the approval decision" }),
});
const reviewerRerunSchema = Type.Object({
	confidence: StringEnum(CONFIDENCE_VALUES, { description: "Confidence in the retry decision" }),
	message: Type.String({ description: "One concise paragraph explaining the material issue" }),
	entryId: Type.String({ description: "Retry checkpoint entry id. Use one of the listed checkpoint ids." }),
	userMessage: Type.String({
		description:
			"Full user message to send after branching to entryId. If entryId is the original prompt checkpoint, provide the full rewritten prompt. If entryId is a later checkpoint, provide a concise corrective continuation that changes the next turn.",
	}),
});
const REVIEWER_SYSTEM_PROMPT = `You are an adversarial reviewer for another coding agent.

Your job:
- inspect the actor's most recent turn in the context of the current branch
- use read-only tools when needed: read, grep, find, ls
- catch material issues only: wrong intent, unsafe/risky action, overbroad edits, ignored failures, contradictions with evidence, likely broken code
- do not nitpick style, wording, or minor preferences
- if uncertain, approve
- prefer retrying from the latest safe checkpoint already in the session over rewriting the original user prompt
- only rewrite the original user prompt when the issue starts there and retrying from a later checkpoint would preserve the wrong trajectory
- preserve the user's intent, scope, formatting, and wording where possible
- do not invent new goals or extra work

Decision rules:
- Finish by calling exactly one final decision tool
- Use ${REVIEWER_APPROVE_TOOL} when the turn is acceptable or you are uncertain
- Use ${REVIEWER_RERUN_TOOL} only when there is a material issue and retrying from a listed checkpoint is more likely to succeed
- Always provide userMessage; it is the new user input that will be sent after branching to entryId
- If entryId is the original prompt checkpoint, userMessage must be the full rewritten prompt
- If entryId is a later checkpoint, userMessage should be a concise corrective continuation that changes the next turn
- Do not output a normal assistant response for the final decision`;

interface AdversarySettings {
	enabled?: boolean;
	reviewerModel?: string;
	reviewerThinkingLevel?: ThinkingLevel;
	minConfidence?: Confidence;
	maxReviewRounds?: number;
	showStatus?: boolean;
	maxRecentEntries?: number;
	maxContextChars?: number;
	maxToolChars?: number;
}

interface ExtensionSettingsFile {
	adversary?: boolean | AdversarySettings;
}

interface ResolvedAdversarySettings {
	enabled: boolean;
	reviewerModel?: string;
	reviewerThinkingLevel: ThinkingLevel;
	minConfidence: Confidence;
	maxReviewRounds: number;
	showStatus: boolean;
	maxRecentEntries: number;
	maxContextChars: number;
	maxToolChars: number;
}

type Confidence = (typeof CONFIDENCE_VALUES)[number];
type ReviewVerdict = "approve" | "retry";
type UserPromptContent = string | (TextContent | ImageContent)[];

interface ReviewDecision {
	verdict: ReviewVerdict;
	confidence: Confidence;
	message: string;
	retryEntryId?: string;
	userMessage?: string;
}

interface ToolCallSummary {
	toolCallId: string;
	toolName: string;
	input: unknown;
}

interface RunState {
	roundsUsed: number;
	turnIndex: number;
	promptEntryId?: string;
	promptContent?: UserPromptContent;
	promptText: string;
	toolCalls: ToolCallSummary[];
}

interface PromptCheckpoint {
	entryId: string;
	content: UserPromptContent;
	text: string;
	hasImages: boolean;
}

interface RetryCheckpoint {
	entryId: string;
	kind: "prompt" | "tool_result";
	description: string;
}

interface ReviewTask {
	ctx: ExtensionContext;
	settings: ResolvedAdversarySettings;
	reviewerModel: Model<any>;
	reviewerModelText: string;
	reviewPrompt: string;
	promptCheckpoint: PromptCheckpoint;
	latestToolResultCheckpoint?: RetryCheckpoint;
	inputVersion: number;
	lifecycleVersion: number;
	turnIndex: number;
}

interface ActiveReviewState {
	turnIndex: number;
	reviewerModel: string;
	toolCalls: number;
}

interface LastReviewState {
	turnIndex: number;
	verdict: ReviewVerdict | "error";
	confidence?: Confidence;
	reviewerModel: string;
	toolCalls: number;
	message?: string;
}

const DEFAULT_SETTINGS: ResolvedAdversarySettings = {
	enabled: false,
	reviewerThinkingLevel: "low",
	minConfidence: "medium",
	maxReviewRounds: 1,
	showStatus: true,
	maxRecentEntries: 10,
	maxContextChars: 1200,
	maxToolChars: 2000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function clampInteger(value: unknown, fallback: number, minimum: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= minimum ? value : fallback;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	);
}

function isConfidence(value: unknown): value is Confidence {
	return value === "low" || value === "medium" || value === "high";
}

function readAdversarySettings(path: string): AdversarySettings {
	if (!existsSync(path)) return {};

	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!isRecord(parsed)) return {};
		const file = parsed as ExtensionSettingsFile;
		const settings = file.adversary;
		if (typeof settings === "boolean") {
			return { enabled: settings };
		}
		if (!isRecord(settings)) return {};

		return {
			enabled: typeof settings.enabled === "boolean" ? settings.enabled : undefined,
			reviewerModel:
				typeof settings.reviewerModel === "string" ? settings.reviewerModel.trim() || undefined : undefined,
			reviewerThinkingLevel: isThinkingLevel(settings.reviewerThinkingLevel)
				? settings.reviewerThinkingLevel
				: undefined,
			minConfidence: isConfidence(settings.minConfidence) ? settings.minConfidence : undefined,
			maxReviewRounds: typeof settings.maxReviewRounds === "number" ? settings.maxReviewRounds : undefined,
			showStatus: typeof settings.showStatus === "boolean" ? settings.showStatus : undefined,
			maxRecentEntries: typeof settings.maxRecentEntries === "number" ? settings.maxRecentEntries : undefined,
			maxContextChars: typeof settings.maxContextChars === "number" ? settings.maxContextChars : undefined,
			maxToolChars: typeof settings.maxToolChars === "number" ? settings.maxToolChars : undefined,
		};
	} catch (error) {
		console.error(`[adversary] Failed to load ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
}

function mergeSettings(base: ResolvedAdversarySettings, overrides: AdversarySettings): ResolvedAdversarySettings {
	return {
		enabled: overrides.enabled ?? base.enabled,
		reviewerModel: overrides.reviewerModel ?? base.reviewerModel,
		reviewerThinkingLevel: overrides.reviewerThinkingLevel ?? base.reviewerThinkingLevel,
		minConfidence: overrides.minConfidence ?? base.minConfidence,
		maxReviewRounds: clampInteger(overrides.maxReviewRounds, base.maxReviewRounds, 0),
		showStatus: overrides.showStatus ?? base.showStatus,
		maxRecentEntries: clampInteger(overrides.maxRecentEntries, base.maxRecentEntries, 1),
		maxContextChars: clampInteger(overrides.maxContextChars, base.maxContextChars, 200),
		maxToolChars: clampInteger(overrides.maxToolChars, base.maxToolChars, 200),
	};
}

function loadSettings(cwd: string): ResolvedAdversarySettings {
	const globalSettings = readAdversarySettings(join(getAgentDir(), SETTINGS_FILE_NAME));
	const projectSettings = readAdversarySettings(join(cwd, ".pi", SETTINGS_FILE_NAME));
	return mergeSettings(mergeSettings(DEFAULT_SETTINGS, globalSettings), projectSettings);
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}…`;
}

function sanitizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function summarizeUserContent(content: string | (TextContent | ImageContent)[], maxChars: number): string {
	if (typeof content === "string") {
		return truncateText(sanitizeWhitespace(content), maxChars);
	}

	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") {
			parts.push(block.text);
		} else if (block.type === "image") {
			parts.push(`[image:${block.mimeType}]`);
		}
	}
	return truncateText(sanitizeWhitespace(parts.join(" ")), maxChars);
}

function extractUserTextContent(content: UserPromptContent): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n\n");
}

function formatUserPromptForReview(content: UserPromptContent): string {
	if (typeof content === "string") {
		return content;
	}

	return content.map((block) => (block.type === "text" ? block.text : `[image:${block.mimeType}]`)).join("\n");
}

function rewriteUserPromptContent(content: UserPromptContent, rewrittenPrompt: string): UserPromptContent {
	if (typeof content === "string") {
		return rewrittenPrompt;
	}

	const images = content.filter((block): block is ImageContent => block.type === "image");
	return images.length > 0
		? [{ type: "text", text: rewrittenPrompt }, ...images]
		: [{ type: "text", text: rewrittenPrompt }];
}

function findLatestUserPrompt(entries: SessionEntry[]): PromptCheckpoint | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		return {
			entryId: entry.id,
			content,
			text: extractUserTextContent(content),
			hasImages: Array.isArray(content) && content.some((block) => block.type === "image"),
		};
	}
	return undefined;
}

function summarizeAssistantMessage(message: AssistantMessage, maxChars: number): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			parts.push(block.text);
		} else if (block.type === "thinking") {
			parts.push(`[thinking:${truncateText(sanitizeWhitespace(block.thinking), Math.min(80, maxChars))}]`);
		} else if (block.type === "toolCall") {
			parts.push(`[tool:${block.name}]`);
		}
	}

	const text = parts.length > 0 ? parts.join(" ") : `(stopReason=${message.stopReason})`;
	return truncateText(sanitizeWhitespace(text), maxChars);
}

function summarizeToolResult(result: ToolResultMessage, maxChars: number): string {
	const text = result.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
	const path =
		isRecord(result.details) && typeof result.details.path === "string" ? ` path=${result.details.path}` : "";
	const body = text ? truncateText(sanitizeWhitespace(text), maxChars) : "(no text output)";
	return `${result.toolName}${result.isError ? " [error]" : ""}${path}: ${body}`;
}

function summarizeUnknown(value: unknown, maxChars: number): string {
	try {
		return truncateText(sanitizeWhitespace(JSON.stringify(value)), maxChars);
	} catch {
		return "[unserializable]";
	}
}

function summarizeToolInput(toolName: string, input: unknown, maxChars: number): string {
	if (!isRecord(input)) return `${toolName}: ${summarizeUnknown(input, maxChars)}`;

	if (toolName === "write") {
		const path = typeof input.path === "string" ? input.path : "?";
		const content = typeof input.content === "string" ? input.content : "";
		return `write path=${path} chars=${content.length} preview=${truncateText(sanitizeWhitespace(content), Math.min(120, maxChars))}`;
	}

	if (toolName === "edit") {
		const path = typeof input.path === "string" ? input.path : "?";
		const edits = Array.isArray(input.edits) ? input.edits.length : 0;
		return `edit path=${path} edits=${edits} payload=${summarizeUnknown(input, maxChars)}`;
	}

	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		return `bash command=${truncateText(sanitizeWhitespace(command), maxChars)}`;
	}

	if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") {
		return `${toolName} ${summarizeUnknown(input, maxChars)}`;
	}

	return `${toolName} ${summarizeUnknown(input, maxChars)}`;
}

function summarizeAgentMessage(message: AgentMessage, maxChars: number): string {
	switch (message.role) {
		case "user":
			return `user: ${summarizeUserContent(message.content, maxChars)}`;
		case "assistant":
			return `assistant: ${summarizeAssistantMessage(message, maxChars)}`;
		case "toolResult":
			return `toolResult: ${summarizeToolResult(message, maxChars)}`;
		case "bashExecution":
			return `bashExecution: ${truncateText(sanitizeWhitespace(message.command), maxChars)}`;
		case "custom":
			return `custom:${message.customType}: ${summarizeUserContent(message.content, maxChars)}`;
		case "branchSummary":
			return `branchSummary: ${truncateText(sanitizeWhitespace(message.summary), maxChars)}`;
		case "compactionSummary":
			return `compactionSummary: ${truncateText(sanitizeWhitespace(message.summary), maxChars)}`;
		default:
			return `${String((message as { role: string }).role)}: [unsupported]`;
	}
}

function summarizeSessionEntry(entry: SessionEntry, maxChars: number): string | undefined {
	switch (entry.type) {
		case "message":
			return summarizeAgentMessage(entry.message, maxChars);
		case "custom_message":
			return `custom:${entry.customType}: ${summarizeUserContent(entry.content, maxChars)}`;
		case "branch_summary":
			return `branch_summary: ${truncateText(sanitizeWhitespace(entry.summary), maxChars)}`;
		case "compaction":
			return `compaction: ${truncateText(sanitizeWhitespace(entry.summary), maxChars)}`;
		default:
			return undefined;
	}
}

function formatRecentEntries(entries: SessionEntry[], maxEntries: number, maxChars: number): string {
	const relevant = entries
		.map((entry) => summarizeSessionEntry(entry, maxChars))
		.filter((value): value is string => typeof value === "string");
	const recent = relevant.slice(-maxEntries);
	return recent.length > 0 ? recent.map((entry, index) => `${index + 1}. ${entry}`).join("\n") : "(none)";
}

function confidenceRank(confidence: Confidence): number {
	switch (confidence) {
		case "low":
			return 0;
		case "medium":
			return 1;
		case "high":
			return 2;
	}
}

function formatReviewerModel(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function getReviewerThinkingLabel(settings: ResolvedAdversarySettings, reviewerModel: Model<any> | undefined): string {
	if (!reviewerModel?.reasoning) return "off";
	return settings.reviewerThinkingLevel;
}

function findLatestToolResultCheckpoint(entries: SessionEntry[], maxChars: number): RetryCheckpoint | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		return {
			entryId: entry.id,
			kind: "tool_result",
			description: summarizeToolResult(entry.message, maxChars),
		};
	}
	return undefined;
}

function buildReviewPrompt(
	ctx: ExtensionContext,
	assistantMessage: AssistantMessage,
	toolCalls: ToolCallSummary[],
	toolResults: ToolResultMessage[],
	settings: ResolvedAdversarySettings,
	promptCheckpoint: PromptCheckpoint,
	latestToolResultCheckpoint: RetryCheckpoint | undefined,
): string {
	const branch = ctx.sessionManager.getBranch();
	const recentEntries = formatRecentEntries(branch, settings.maxRecentEntries, settings.maxContextChars);
	const toolCallText =
		toolCalls.length > 0
			? toolCalls
					.map(
						(call, index) =>
							`${index + 1}. ${summarizeToolInput(call.toolName, call.input, settings.maxToolChars)}`,
					)
					.join("\n")
			: "(none)";
	const toolResultText =
		toolResults.length > 0
			? toolResults
					.map((result, index) => `${index + 1}. ${summarizeToolResult(result, settings.maxToolChars)}`)
					.join("\n")
			: "(none)";
	const assistantText = summarizeAssistantMessage(assistantMessage, settings.maxContextChars);
	const originalPrompt = truncateText(
		formatUserPromptForReview(promptCheckpoint.content),
		Math.max(settings.maxContextChars, 4000),
	);
	const checkpointLines = [
		`1. ${promptCheckpoint.entryId} (original user prompt${promptCheckpoint.hasImages ? ", images stay attached automatically" : ""})`,
		latestToolResultCheckpoint
			? `2. ${latestToolResultCheckpoint.entryId} (latest completed tool-result checkpoint: ${latestToolResultCheckpoint.description})`
			: "2. none (no completed tool-result checkpoint available on the current branch)",
	];

	return [
		"Review the actor's latest turn.",
		"If there is a material problem, choose the best retry checkpoint and provide new user input that will change the next turn. Prefer the latest completed tool-result checkpoint when the original prompt and prior tool work are still good. Rewrite the original user prompt only when the problem starts there.",
		`cwd: ${ctx.cwd}`,
		`original prompt entry id: ${promptCheckpoint.entryId}`,
		`original prompt includes images: ${promptCheckpoint.hasImages ? "yes" : "no"}`,
		"If images were attached, they will remain attached automatically when retrying from the original user prompt. Rewrite only the textual instructions.",
		"",
		"Retry checkpoints:",
		...checkpointLines,
		"",
		"Original user prompt:",
		originalPrompt || "(empty)",
		"",
		"Recent branch context:",
		recentEntries,
		"",
		"Tool calls this turn:",
		toolCallText,
		"",
		"Tool results this turn:",
		toolResultText,
		"",
		"Assistant message this turn:",
		assistantText,
		"",
		`Approve with ${REVIEWER_APPROVE_TOOL} unless there is a material issue. Use ${REVIEWER_RERUN_TOOL} only for material issues. Set entryId to one of the listed retry checkpoints. Always provide userMessage as the new user input to send after branching to entryId.`,
	].join("\n");
}

function resolveReviewerModel(ctx: ExtensionContext, modelSpec: string | undefined): Model<any> | undefined {
	if (!modelSpec || modelSpec === "current") {
		return ctx.model;
	}

	const trimmed = modelSpec.trim();
	if (trimmed.length === 0) return ctx.model;

	const slash = trimmed.indexOf("/");
	if (slash >= 0) {
		const provider = trimmed.slice(0, slash);
		const modelId = trimmed.slice(slash + 1);
		return provider && modelId ? ctx.modelRegistry.find(provider, modelId) : undefined;
	}

	return ctx.model ? ctx.modelRegistry.find(ctx.model.provider, trimmed) : undefined;
}

async function runReviewer(
	ctx: ExtensionContext,
	settings: ResolvedAdversarySettings,
	reviewerModel: Model<any>,
	reviewPrompt: string,
	onToolCall?: () => void,
): Promise<{ decision: ReviewDecision; toolCallsUsed: number }> {
	let decision: ReviewDecision | undefined;
	let decisionFinalized = false;

	const setDecision = (nextDecision: ReviewDecision): void => {
		if (decision) {
			throw new Error(
				`Reviewer emitted multiple final decisions; use exactly one of ${REVIEWER_APPROVE_TOOL} or ${REVIEWER_RERUN_TOOL}`,
			);
		}
		decision = nextDecision;
		decisionFinalized = true;
	};

	const approveTool: AgentTool<typeof reviewerApproveSchema> = {
		name: REVIEWER_APPROVE_TOOL,
		label: "Approve Review",
		description: "Finalize review with approval when there is no material issue or you are uncertain.",
		parameters: reviewerApproveSchema,
		execute: async (_toolCallId, params) => {
			setDecision({
				verdict: "approve",
				confidence: params.confidence,
				message: sanitizeWhitespace(params.message) || "ok",
			});
			return {
				content: [{ type: "text", text: "Review approved." }],
				details: {},
			};
		},
	};

	const rerunTool: AgentTool<typeof reviewerRerunSchema> = {
		name: REVIEWER_RERUN_TOOL,
		label: "Retry Review",
		description: "Finalize review by requesting a retry from a listed checkpoint.",
		parameters: reviewerRerunSchema,
		execute: async (_toolCallId, params) => {
			const userMessage = params.userMessage.trim();
			const nextDecision: ReviewDecision = {
				verdict: "retry",
				confidence: params.confidence,
				message: sanitizeWhitespace(params.message) || "retry requested",
				retryEntryId: params.entryId.trim(),
				userMessage,
			};
			if (!nextDecision.retryEntryId) {
				throw new Error(`${REVIEWER_RERUN_TOOL} requires a non-empty entryId`);
			}
			if (!nextDecision.userMessage) {
				throw new Error(`${REVIEWER_RERUN_TOOL} requires a non-empty userMessage`);
			}
			setDecision(nextDecision);
			return {
				content: [{ type: "text", text: "Retry recorded." }],
				details: {},
			};
		},
	};

	const reviewer = new Agent({
		initialState: {
			systemPrompt: REVIEWER_SYSTEM_PROMPT,
			model: reviewerModel,
			thinkingLevel: settings.reviewerThinkingLevel,
			tools: [...createReadOnlyTools(ctx.cwd), approveTool, rerunTool],
		},
		getApiKey: async (provider) => ctx.modelRegistry.getApiKeyForProvider(provider),
	});

	let toolCallsUsed = 0;
	const unsubscribe = reviewer.subscribe((event) => {
		if (event.type !== "tool_execution_start") return;
		toolCallsUsed++;
		onToolCall?.();
	});

	const abortReviewer = () => {
		if (!decisionFinalized) {
			reviewer.abort();
		}
	};
	ctx.signal?.addEventListener("abort", abortReviewer, { once: true });
	try {
		await reviewer.prompt(reviewPrompt);
	} finally {
		unsubscribe();
		ctx.signal?.removeEventListener("abort", abortReviewer);
	}

	if (!decision) {
		throw new Error(`Reviewer did not call ${REVIEWER_APPROVE_TOOL} or ${REVIEWER_RERUN_TOOL}`);
	}

	return {
		decision,
		toolCallsUsed,
	};
}

export default function adversaryExtension(pi: ExtensionAPI) {
	let sessionEnabledOverride: boolean | undefined;
	let runState: RunState | undefined;
	let lastError: string | undefined;
	let activeReview: ActiveReviewState | undefined;
	let lastReview: LastReviewState | undefined;
	let autoRewriteChainCount = 0;
	let inputVersion = 0;
	let lifecycleVersion = 0;
	let rewriteRequestedInputVersion: number | undefined;
	let footerSpinnerFrameIndex = 0;

	function getEffectiveSettings(ctx: ExtensionContext): ResolvedAdversarySettings {
		const settings = loadSettings(ctx.cwd);
		return { ...settings, enabled: sessionEnabledOverride ?? settings.enabled };
	}

	function buildActorRightSide(ctx: ExtensionContext, footerData: ReadonlyFooterDataProvider): string {
		const modelName = ctx.model?.id || "no-model";
		let rightSideWithoutProvider = modelName;
		if (ctx.model?.reasoning) {
			const thinkingLevel = pi.getThinkingLevel() || "off";
			rightSideWithoutProvider =
				thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
		}

		if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
			return `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
		}
		return rightSideWithoutProvider;
	}

	function buildAdversaryRightSide(ctx: ExtensionContext, settings: ResolvedAdversarySettings, theme: any): string {
		const reviewerModel = resolveReviewerModel(ctx, settings.reviewerModel);
		const reviewerModelText = reviewerModel
			? formatReviewerModel(reviewerModel)
			: (settings.reviewerModel ?? "current");
		const reviewerThinking = getReviewerThinkingLabel(settings, reviewerModel);
		const base = `${reviewerModelText} • ${reviewerThinking}`;

		if (activeReview) {
			const frame = BRAILLE_FRAMES[footerSpinnerFrameIndex % BRAILLE_FRAMES.length];
			return theme.fg("accent", `${frame} adv ${base}`);
		}
		if (lastReview?.verdict === "error") {
			return theme.fg("error", `✗ adv ${base}`);
		}
		if (lastReview?.verdict === "retry") {
			return theme.fg("warning", `! adv retry ${base}`);
		}
		if (lastReview?.verdict === "approve") {
			return theme.fg("success", `✓ adv ${base}`);
		}
		return theme.fg("accent", `adv ${base}`);
	}

	function renderFooter(
		ctx: ExtensionContext,
		footerData: ReadonlyFooterDataProvider,
		theme: any,
		width: number,
	): string[] {
		// cumulative usage from all assistant entries
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
			}
		}

		const contextUsage = ctx.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		let pwd = ctx.sessionManager.getCwd();
		const home = process.env.HOME || process.env.USERPROFILE;
		if (home && pwd.startsWith(home)) {
			pwd = `~${pwd.slice(home.length)}`;
		}
		const branch = footerData.getGitBranch();
		if (branch) pwd = `${pwd} (${branch})`;
		const sessionName = ctx.sessionManager.getSessionName();
		if (sessionName) pwd = `${pwd} • ${sessionName}`;

		const settings = getEffectiveSettings(ctx);
		const adversaryRight = buildAdversaryRightSide(ctx, settings, theme);
		const adversaryRightWidth = visibleWidth(adversaryRight);
		const maxPwdWidth = Math.max(0, width - (adversaryRightWidth > 0 ? adversaryRightWidth + 2 : 0));
		const pwdLeft = truncateToWidth(theme.fg("dim", pwd), maxPwdWidth || width, theme.fg("dim", "..."));
		const topLine =
			adversaryRightWidth > 0 && visibleWidth(pwdLeft) + adversaryRightWidth + 2 <= width
				? pwdLeft + " ".repeat(width - visibleWidth(pwdLeft) - adversaryRightWidth) + adversaryRight
				: truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

		const statsParts: string[] = [];
		if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
		if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
		if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
		if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
		const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
		if (totalCost || usingSubscription) {
			statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
		}
		const autoIndicator = " (auto)";
		const contextDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		statsParts.push(
			contextPercentValue > 90
				? theme.fg("error", contextDisplay)
				: contextPercentValue > 70
					? theme.fg("warning", contextDisplay)
					: contextDisplay,
		);

		let statsLeft = statsParts.join(" ");
		let statsLeftWidth = visibleWidth(statsLeft);
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		const actorRight = buildActorRightSide(ctx, footerData);
		const actorRightWidth = visibleWidth(actorRight);
		const minPadding = 2;
		let bottomLine: string;
		if (statsLeftWidth + minPadding + actorRightWidth <= width) {
			const padding = " ".repeat(width - statsLeftWidth - actorRightWidth);
			bottomLine = theme.fg("dim", statsLeft) + padding + theme.fg("dim", actorRight);
		} else {
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(actorRight, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				bottomLine = theme.fg("dim", statsLeft) + padding + theme.fg("dim", truncatedRight);
			} else {
				bottomLine = theme.fg("dim", statsLeft);
			}
		}

		const lines = [topLine, bottomLine];

		const extensionStatuses = footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}

	function syncFooter(ctx: ExtensionContext): void {
		const settings = getEffectiveSettings(ctx);
		if (!settings.enabled || !settings.showStatus || !ctx.hasUI) {
			ctx.ui.setFooter(undefined);
			return;
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
			const interval = setInterval(() => {
				if (!activeReview) return;
				footerSpinnerFrameIndex = (footerSpinnerFrameIndex + 1) % BRAILLE_FRAMES.length;
				tui.requestRender();
			}, 80);
			return {
				dispose() {
					unsubscribeBranch();
					clearInterval(interval);
				},
				invalidate() {},
				render(width: number): string[] {
					return renderFooter(ctx, footerData, theme, width);
				},
			};
		});
	}

	function noteError(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	function shouldReview(
		ctx: ExtensionContext,
		assistantMessage: AssistantMessage,
	): ResolvedAdversarySettings | undefined {
		const settings = getEffectiveSettings(ctx);
		if (!settings.enabled) return undefined;
		if (!runState) return undefined;
		if (runState.roundsUsed >= settings.maxReviewRounds) return undefined;
		if (!runState.promptEntryId || !runState.promptContent) return undefined;
		if (runState.promptText.trim().length === 0) return undefined;
		if (rewriteRequestedInputVersion === inputVersion) return undefined;
		if (autoRewriteChainCount >= settings.maxReviewRounds) return undefined;
		if (assistantMessage.stopReason === "aborted") return undefined;
		return settings;
	}

	function createReviewTask(
		ctx: ExtensionContext,
		settings: ResolvedAdversarySettings,
		reviewerModel: Model<any>,
		assistantMessage: AssistantMessage,
		toolCalls: ToolCallSummary[],
		toolResults: ToolResultMessage[],
		promptCheckpoint: PromptCheckpoint,
		latestToolResultCheckpoint: RetryCheckpoint | undefined,
		turnIndex: number,
	): ReviewTask {
		return {
			ctx,
			settings,
			reviewerModel,
			reviewerModelText: formatReviewerModel(reviewerModel),
			reviewPrompt: buildReviewPrompt(
				ctx,
				assistantMessage,
				toolCalls,
				toolResults,
				settings,
				promptCheckpoint,
				latestToolResultCheckpoint,
			),
			promptCheckpoint: {
				entryId: promptCheckpoint.entryId,
				content: structuredClone(promptCheckpoint.content),
				text: promptCheckpoint.text,
				hasImages: promptCheckpoint.hasImages,
			},
			latestToolResultCheckpoint,
			inputVersion,
			lifecycleVersion,
			turnIndex,
		};
	}

	function buildReviewTask(
		ctx: ExtensionContext,
		assistantMessage: AssistantMessage,
		toolCalls: ToolCallSummary[],
		toolResults: ToolResultMessage[],
		turnIndex: number,
	): ReviewTask | undefined {
		const settings = shouldReview(ctx, assistantMessage);
		if (!settings || !runState || !runState.promptEntryId || !runState.promptContent) return undefined;

		const promptCheckpoint: PromptCheckpoint = {
			entryId: runState.promptEntryId,
			content: structuredClone(runState.promptContent),
			text: runState.promptText,
			hasImages:
				Array.isArray(runState.promptContent) && runState.promptContent.some((block) => block.type === "image"),
		};
		const latestToolResultCheckpoint = findLatestToolResultCheckpoint(
			ctx.sessionManager.getBranch(),
			settings.maxToolChars,
		);

		const reviewerModel = resolveReviewerModel(ctx, settings.reviewerModel);
		if (!reviewerModel) {
			lastError = `Reviewer model not found: ${settings.reviewerModel ?? "current"}`;
			if (ctx.hasUI) {
				ctx.ui.notify(`adversary: ${lastError}`, "error");
			}
			return undefined;
		}

		return createReviewTask(
			ctx,
			settings,
			reviewerModel,
			structuredClone(assistantMessage),
			structuredClone(toolCalls),
			structuredClone(toolResults),
			promptCheckpoint,
			latestToolResultCheckpoint,
			turnIndex,
		);
	}

	function clearRewriteRequest(inputVersionToClear: number): void {
		if (rewriteRequestedInputVersion === inputVersionToClear) {
			rewriteRequestedInputVersion = undefined;
		}
	}

	function getRetryCheckpoint(task: ReviewTask, entryId: string): RetryCheckpoint | undefined {
		if (entryId === task.promptCheckpoint.entryId) {
			return {
				entryId: task.promptCheckpoint.entryId,
				kind: "prompt",
				description: "original user prompt",
			};
		}
		if (task.latestToolResultCheckpoint?.entryId === entryId) {
			return task.latestToolResultCheckpoint;
		}
		return undefined;
	}

	function isReviewTaskCurrent(task: ReviewTask, ctx: ExtensionContext): boolean {
		return (
			task.lifecycleVersion === lifecycleVersion &&
			task.inputVersion === inputVersion &&
			getEffectiveSettings(ctx).enabled
		);
	}

	async function applyRetry(task: ReviewTask, decision: ReviewDecision): Promise<void> {
		if (decision.verdict !== "retry" || !decision.retryEntryId) {
			clearRewriteRequest(task.inputVersion);
			return;
		}

		const checkpoint = getRetryCheckpoint(task, decision.retryEntryId);
		if (!checkpoint) {
			clearRewriteRequest(task.inputVersion);
			return;
		}

		const userMessage = decision.userMessage?.trim();
		if (!userMessage) {
			clearRewriteRequest(task.inputVersion);
			return;
		}
		const hasPromptRewrite =
			checkpoint.kind === "prompt" &&
			sanitizeWhitespace(userMessage) !== sanitizeWhitespace(task.promptCheckpoint.text);

		try {
			await task.ctx.abort();
			if (!isReviewTaskCurrent(task, task.ctx)) {
				clearRewriteRequest(task.inputVersion);
				return;
			}

			lastError = undefined;
			syncFooter(task.ctx);

			await pi.runSessionAction(async (ctx) => {
				if (!isReviewTaskCurrent(task, ctx)) {
					clearRewriteRequest(task.inputVersion);
					return;
				}

				const result = await ctx.navigateTree(checkpoint.entryId);
				if (result.cancelled) {
					clearRewriteRequest(task.inputVersion);
					if (ctx.hasUI) {
						ctx.ui.notify("adversary: retry cancelled", "info");
					}
					return;
				}
				if (!isReviewTaskCurrent(task, ctx)) {
					clearRewriteRequest(task.inputVersion);
					return;
				}

				autoRewriteChainCount += 1;
				if (ctx.hasUI) {
					ctx.ui.notify(
						hasPromptRewrite
							? `adversary: retrying from rewritten prompt (${decision.confidence})`
							: `adversary: interjecting from ${checkpoint.kind === "prompt" ? "prompt checkpoint" : "tool-result checkpoint"} (${decision.confidence})`,
						"warning",
					);
				}
				pi.sendUserMessage(
					checkpoint.kind === "prompt"
						? rewriteUserPromptContent(task.promptCheckpoint.content, userMessage)
						: userMessage,
				);
				clearRewriteRequest(task.inputVersion);
			});
		} catch (error) {
			clearRewriteRequest(task.inputVersion);
			lastError = noteError(error);
			syncFooter(task.ctx);
			if (task.ctx.hasUI) {
				task.ctx.ui.notify(`adversary: ${lastError}`, "error");
			}
		}
	}

	function scheduleRetry(task: ReviewTask, decision: ReviewDecision): boolean {
		if (decision.verdict !== "retry" || !decision.retryEntryId) return false;
		if (!isReviewTaskCurrent(task, task.ctx)) return false;
		if (confidenceRank(decision.confidence) < confidenceRank(task.settings.minConfidence)) return false;
		if (rewriteRequestedInputVersion === task.inputVersion) return false;
		if (autoRewriteChainCount >= task.settings.maxReviewRounds) return false;
		if (!getRetryCheckpoint(task, decision.retryEntryId)) return false;
		if (!decision.userMessage?.trim()) return false;
		if (
			decision.retryEntryId === task.promptCheckpoint.entryId &&
			sanitizeWhitespace(decision.userMessage) === sanitizeWhitespace(task.promptCheckpoint.text)
		) {
			return false;
		}

		rewriteRequestedInputVersion = task.inputVersion;
		if (runState) {
			runState.roundsUsed += 1;
		}
		queueMicrotask(() => {
			void applyRetry(task, decision);
		});
		return true;
	}

	pi.on("input", async (event, ctx) => {
		if (event.source !== "extension") {
			inputVersion += 1;
			autoRewriteChainCount = 0;
			rewriteRequestedInputVersion = undefined;
			activeReview = undefined;
			syncFooter(ctx);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		lifecycleVersion += 1;
		sessionEnabledOverride = undefined;
		runState = undefined;
		lastError = undefined;
		activeReview = undefined;
		lastReview = undefined;
		autoRewriteChainCount = 0;
		inputVersion = 0;
		rewriteRequestedInputVersion = undefined;
		footerSpinnerFrameIndex = 0;
		syncFooter(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		lifecycleVersion += 1;
		sessionEnabledOverride = undefined;
		runState = undefined;
		lastError = undefined;
		activeReview = undefined;
		lastReview = undefined;
		autoRewriteChainCount = 0;
		rewriteRequestedInputVersion = undefined;
		footerSpinnerFrameIndex = 0;
		ctx.ui.setFooter(undefined);
	});

	pi.on("model_select", async (_event, ctx) => {
		syncFooter(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		const promptCheckpoint = findLatestUserPrompt(ctx.sessionManager.getBranch());
		runState = {
			roundsUsed: 0,
			turnIndex: 0,
			promptEntryId: promptCheckpoint?.entryId,
			promptContent: promptCheckpoint?.content,
			promptText: promptCheckpoint?.text ?? "",
			toolCalls: [],
		};
		activeReview = undefined;
		footerSpinnerFrameIndex = 0;
		syncFooter(ctx);
	});

	pi.on("turn_start", async (event, ctx) => {
		const promptCheckpoint = findLatestUserPrompt(ctx.sessionManager.getBranch());
		if (!runState) {
			runState = {
				roundsUsed: 0,
				turnIndex: event.turnIndex,
				promptEntryId: promptCheckpoint?.entryId,
				promptContent: promptCheckpoint?.content,
				promptText: promptCheckpoint?.text ?? "",
				toolCalls: [],
			};
			return;
		}
		runState.turnIndex = event.turnIndex;
		if (promptCheckpoint) {
			runState.promptEntryId = promptCheckpoint.entryId;
			runState.promptContent = promptCheckpoint.content;
			runState.promptText = promptCheckpoint.text;
		}
		runState.toolCalls = [];
	});

	pi.on("tool_call", async (event) => {
		if (!runState) return;
		runState.toolCalls.push({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			input: structuredClone(event.input),
		});
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!runState || event.message.role !== "assistant") return;
		const assistantMessage = event.message as AssistantMessage;
		const task = buildReviewTask(ctx, assistantMessage, runState.toolCalls, event.toolResults, runState.turnIndex);
		if (!task) return;

		activeReview = {
			turnIndex: task.turnIndex,
			reviewerModel: task.reviewerModelText,
			toolCalls: 0,
		};
		footerSpinnerFrameIndex = 0;
		syncFooter(ctx);

		try {
			const { decision, toolCallsUsed } = await runReviewer(
				task.ctx,
				task.settings,
				task.reviewerModel,
				task.reviewPrompt,
				() => {
					if (activeReview) {
						activeReview.toolCalls++;
					}
				},
			);

			if (task.lifecycleVersion !== lifecycleVersion || task.inputVersion !== inputVersion) return;
			if (!getEffectiveSettings(task.ctx).enabled) return;

			lastError = undefined;
			lastReview = {
				turnIndex: task.turnIndex,
				verdict: decision.verdict,
				confidence: decision.confidence,
				reviewerModel: task.reviewerModelText,
				toolCalls: toolCallsUsed,
				message: decision.message,
			};
			scheduleRetry(task, decision);
		} catch (error) {
			if (task.lifecycleVersion === lifecycleVersion && task.inputVersion === inputVersion) {
				lastError = noteError(error);
				lastReview = {
					turnIndex: task.turnIndex,
					verdict: "error",
					reviewerModel: task.reviewerModelText,
					toolCalls: activeReview ? activeReview.toolCalls : 0,
					message: lastError,
				};
				if (task.ctx.hasUI) {
					task.ctx.ui.notify(`adversary: ${lastError}`, "error");
				}
			}
		} finally {
			activeReview = undefined;
			syncFooter(ctx);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		runState = undefined;
		activeReview = undefined;
		syncFooter(ctx);
	});

	pi.registerCommand("adversary", {
		description: "Show or override adversary reviewer status",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on") {
				sessionEnabledOverride = true;
				lastError = undefined;
				syncFooter(ctx);
				ctx.ui.notify("adversary: enabled for this session", "info");
				return;
			}

			if (action === "off") {
				sessionEnabledOverride = false;
				lastError = undefined;
				activeReview = undefined;
				rewriteRequestedInputVersion = undefined;
				syncFooter(ctx);
				ctx.ui.notify("adversary: disabled for this session", "info");
				return;
			}

			const settings = getEffectiveSettings(ctx);
			const reviewerModel = resolveReviewerModel(ctx, settings.reviewerModel);
			const lines = [
				`adversary: ${settings.enabled ? "on" : "off"}`,
				`sessionOverride: ${sessionEnabledOverride === undefined ? "none" : String(sessionEnabledOverride)}`,
				`reviewerModel: ${reviewerModel ? formatReviewerModel(reviewerModel) : (settings.reviewerModel ?? "current (unresolved)")}`,
				`reviewerThinkingLevel: ${getReviewerThinkingLabel(settings, reviewerModel)}`,
				`minConfidence: ${settings.minConfidence}`,
				`maxReviewRounds: ${settings.maxReviewRounds}`,
				`autoRetryChain: ${autoRewriteChainCount}/${settings.maxReviewRounds}`,
				`retryRequested: ${rewriteRequestedInputVersion === undefined ? 0 : 1}`,
				`activeReview: ${activeReview ? `turn ${activeReview.turnIndex}, model ${activeReview.reviewerModel}, tools ${activeReview.toolCalls}` : "none"}`,
				`lastReview: ${lastReview ? `${lastReview.verdict} turn ${lastReview.turnIndex}, model ${lastReview.reviewerModel}, tools ${lastReview.toolCalls}${lastReview.confidence ? `, confidence ${lastReview.confidence}` : ""}` : "none"}`,
				`lastError: ${lastError ?? "none"}`,
				"config: ~/.pi/agent/extension-settings.json, .pi/extension-settings.json",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
