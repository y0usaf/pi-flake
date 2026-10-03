import type { Context, JsonValue } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { AgentTool, AgentToolCallOutcome, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import {
	defineDoc,
	defineExtension,
	defineTool,
	type Extension,
	type JsonObject,
	type ToolExecutionApi,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { OutputBuffer } from "@earendil-works/pi-durable/harness/output.ts";
import type { ToolDiagnostic } from "@earendil-works/pi-durable/harness/types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-durable/truncate.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent/core/extensions/types.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent/core/model-runtime.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent/core/session-manager.ts";
import { executeCodemode } from "@earendil-works/pi-coding-agent/extensions/codemode/execute.ts";
import {
	CODEMODE_STORE_ENTRY_TYPE,
	CODEMODE_TOOL_NAME,
	type CodemodeModelRuntime,
	type CodemodeStoreEntryData,
	codemodeSchema,
	createCodemodeDescription,
} from "@earendil-works/pi-coding-agent/extensions/codemode/tool.ts";

const StoreDoc = defineDoc<{ values: JsonObject }>({
	kind: "durapi.codemode-store",
	version: 1,
	initial: () => ({ values: {} }),
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
});

type ScriptContext = Pick<ExtensionToolContext, "tools" | "executeTool"> & {
	readonly modelRegistry: CodemodeModelRuntime;
	readonly sessionManager: Pick<ExtensionToolContext["sessionManager"], "getBranch">;
};

export interface CodemodeOptions {
	readonly tools: () => readonly ToolRegistration[];
	readonly models: ModelRuntime;
	readonly inlineBudget?: number;
}

function json(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value ?? null));
}

function jsonObject(value: unknown): JsonObject {
	const parsed = json(value);
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
}

function asAgentTool(tool: ToolRegistration): AgentTool {
	return {
		name: tool.name,
		label: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		execute: () => Promise.reject(new Error(`${tool.name} runs through codemode`)),
	};
}

function textResult(toolCall: ToolCall, texts: readonly string[], isError: boolean): AgentToolCallOutcome {
	const text = texts.filter((part) => part !== "").join("\n");
	return { toolCall, result: { content: text === "" ? [] : [{ type: "text", text }], details: undefined }, isError };
}

function renderDiagnostics(diagnostics: readonly ToolDiagnostic[]): string {
	if (diagnostics.length === 0) return "";
	return `<harness>\n${diagnostics.map((item) => `[${item.severity}] ${item.message}`).join("\n")}\n</harness>`;
}

async function runTool(
	tool: ToolRegistration | undefined,
	toolCall: ToolCall,
	api: ToolExecutionApi,
	context: Context,
): Promise<AgentToolCallOutcome> {
	if (tool === undefined) return textResult(toolCall, [`Unknown tool: ${toolCall.name}`], true);
	const output = new OutputBuffer({
		maxBytes: tool.outputLimits?.maxBytes ?? DEFAULT_MAX_BYTES,
		maxLines: tool.outputLimits?.maxLines ?? DEFAULT_MAX_LINES,
		retain: tool.outputLimits?.retain ?? "head",
	});
	const diagnostics: ToolDiagnostic[] = [];
	const nested: ToolExecutionApi = {
		...api,
		output: (chunk) => {
			output.push(chunk);
		},
		diagnostic: (diagnostic) => {
			diagnostics.push(diagnostic);
		},
		details: async () => {},
	};
	const retained = () => {
		output.end();
		return output.snapshot().text;
	};
	try {
		const prepared = tool.prepareArguments ? tool.prepareArguments(toolCall.arguments) : toolCall.arguments;
		const args = validateToolArguments(tool, { ...toolCall, arguments: jsonObject(prepared) });
		const result = await tool.execute(args, nested, context);
		const all = [...diagnostics, ...(result.diagnostics ?? [])];
		const text = result.content === undefined ? retained() : "";
		const content = result.content ?? (text === "" ? [] : [{ type: "text" as const, text }]);
		const rendered = renderDiagnostics(all);
		const outcome: AgentToolResult = {
			content: rendered === "" ? content : [...content, { type: "text", text: rendered }],
			details: result.details,
		};
		return { toolCall, result: outcome, isError: result.isError === true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return textResult(toolCall, [retained(), message, renderDiagnostics(diagnostics)], true);
	}
}

export function createCodemode(options: CodemodeOptions): { readonly extension: Extension; readonly tool: ToolRegistration } {
	const scriptTools = () => options.tools().filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
	const tool = defineTool({
		name: CODEMODE_TOOL_NAME,
		description: createCodemodeDescription(scriptTools().map(asAgentTool), {
			models: true,
			...(options.inlineBudget === undefined ? {} : { inlineBudget: options.inlineBudget }),
		}),
		parameters: codemodeSchema,
		execute: async (args, api, context) => {
			const tools = scriptTools();
			let nested = 0;
			const values = await api.commit(async (tx) => json((await tx.doc(StoreDoc, api.conversationId)).values), context);
			const stored: SessionEntry = {
				type: "custom",
				customType: CODEMODE_STORE_ENTRY_TYPE,
				data: { set: values, delete: [] },
				id: "durapi-codemode-store",
				parentId: null,
				timestamp: new Date().toISOString(),
			};
			const scriptContext: ScriptContext = {
				tools: tools.map(asAgentTool),
				modelRegistry: options.models,
				sessionManager: { getBranch: () => [stored] },
				executeTool: (name, toolArgs, call) => {
					nested += 1;
					const toolCall: ToolCall = {
						type: "toolCall",
						id: `${api.callId}/${nested}`,
						name,
						arguments: jsonObject(toolArgs),
					};
					const signal = call?.signal;
					const nestedContext = signal === undefined ? context : withAbortSignal(signal, context);
					return runTool(
						tools.find((entry) => entry.name === name),
						toolCall,
						api,
						nestedContext,
					);
				},
			};
			let writes: CodemodeStoreEntryData | undefined;
			let published: Promise<void> = Promise.resolve();
			const result = await executeCodemode(
				api.callId,
				args,
				context.abortSignal,
				(update) => {
					published = published.then(() => api.details(json(update.details), context));
				},
				scriptContext as ExtensionToolContext,
				{
					models: true,
					appendEntry: (_type, data) => {
						writes = data;
					},
				},
			);
			await published;
			const pending = writes;
			if (pending !== undefined) {
				await api.commit(async (tx) => {
					const draft = await tx.doc(StoreDoc, api.conversationId);
					for (const key of pending.delete) delete draft.values[key];
					for (const [key, value] of Object.entries(pending.set)) draft.values[key] = json(value);
				}, context);
			}
			return {
				content: result.content,
				details: json(result.details),
				...(result.isError === true ? { isError: true } : {}),
			};
		},
	});
	return { extension: defineExtension({ name: "codemode", tools: [tool] }), tool };
}
