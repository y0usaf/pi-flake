import { createGateway } from "@ai-sdk/gateway";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type RefreshModelsContext,
  type SimpleStreamOptions,
  type StopReason,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { jsonSchema, streamText, tool } from "ai";
import {
  cachedExplicitModels,
  discoverExplicitModels,
  splitExplicitModelId,
  type CatalogCache,
  usableCachedModels,
} from "./catalog.js";
import { toModelMessages } from "./messages.js";
import { applyActualGatewayCost, applyTokenUsage } from "./usage.js";

const PROVIDER_ID = "vercel-ai-gateway";
const GATEWAY_API = "vercel-ai-gateway-native";
const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1/ai";

const FALLBACK_MODEL = {
  id: "deepseek/deepseek-v4-flash-0731@runware",
  name: "DeepSeek V4 Flash 0731 via runware",
  reasoning: true,
  input: ["text" as const],
  cost: { input: 0.08, output: 0.15, cacheRead: 0.01, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 384_000,
};

type DiscoveredModel = Awaited<ReturnType<typeof discoverExplicitModels>>[number];

type CurrentRefreshContext = {
  stored?: CatalogCache;
  publish(publication: {
    persist?: { models: readonly Model<Api>[]; checkedAt?: number; lastModified?: number } | null;
  }): Promise<boolean>;
};

type RefreshControls = Pick<RefreshModelsContext, "allowNetwork" | "force" | "signal">;

function isCurrentRefreshContext(
  context: RefreshModelsContext,
): context is RefreshModelsContext & CurrentRefreshContext {
  return "publish" in context && typeof context.publish === "function";
}

function toStoredModels(models: readonly DiscoveredModel[]): Model<Api>[] {
  return models.map((model) => ({
    ...model,
    api: GATEWAY_API,
    baseUrl: GATEWAY_BASE_URL,
    provider: PROVIDER_ID,
  }));
}

async function refreshCatalog(
  context: RefreshControls,
  stored: CatalogCache | undefined,
  persist: (models: readonly DiscoveredModel[], checkedAt: number) => Promise<void>,
): Promise<DiscoveredModel[]> {
  const storedModels = cachedExplicitModels(stored);
  if (!context.allowNetwork) return storedModels ? [...storedModels] : [FALLBACK_MODEL];

  const cached = !context.force ? usableCachedModels(stored) : undefined;
  if (cached) return [...cached];

  try {
    const models = await discoverExplicitModels({ signal: context.signal });
    await persist(models, Date.now());
    return models;
  } catch (error) {
    if (storedModels) return [...storedModels];
    throw error;
  }
}

function piStopReason(reason: string | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls || reason === "tool-calls") return "toolUse";
  if (reason === "length") return "length";
  if (reason === "error") return "error";
  return "stop";
}

/** AI SDK AI_APICallError carries structured fields; its .message is the raw body. */
interface GatewayApiError {
  name?: string;
  statusCode?: number;
  responseBody?: string;
  message: string;
}

function firstLine(text: string | undefined, limit = 200): string {
  const line = (text ?? "").split("\n").find((part) => part.trim().length > 0) ?? "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/** Extract a short, retry-classifiable message from an AI SDK gateway error. */
function describeGatewayError(error: unknown): string {
  if (error instanceof Error) {
    const apiError = error as Error & Partial<GatewayApiError>;
    const status = apiError.statusCode !== undefined ? ` (HTTP ${apiError.statusCode})` : "";
    const body = firstLine(apiError.responseBody, 200);
    const detail = body ? `: ${body}` : "";
    return `${firstLine(error.message, 200)}${status}${detail}`;
  }
  return firstLine(String(error), 200);
}

/** Retry transient gateway failures (429/5xx) with exponential backoff, capped. */
function isRetryableGatewayError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const apiError = error as Error & Partial<GatewayApiError>;
  if (apiError.statusCode === undefined) return false;
  return apiError.statusCode === 429 || (apiError.statusCode >= 500 && apiError.statusCode <= 599);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error("Aborted"));
  }, { once: true });
  return promise;
}

const STREAM_MAX_ATTEMPTS = 4;
const STREAM_RETRY_BASE_MS = 500;


function emptyAssistant(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function streamNativeGateway(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output = emptyAssistant(model);

  void (async () => {
    try {
      if (!options?.apiKey) throw new Error("Vercel AI Gateway API key is missing");
      if (options.signal?.aborted) throw new Error("Request was aborted");

      const { upstreamModelId, provider } = splitExplicitModelId(model.id);
      const gateway = createGateway({ apiKey: options.apiKey });
      const tools = Object.fromEntries(
        (context.tools ?? []).map((definition) => [
          definition.name,
          tool({
            description: definition.description,
            inputSchema: jsonSchema(definition.parameters as never),
          }),
        ]),
      );

      const result = streamText({
        model: gateway(upstreamModelId),
        system: context.systemPrompt,
        messages: toModelMessages(context),
        tools: Object.keys(tools).length > 0 ? tools : undefined,
        maxOutputTokens: Math.min(options.maxTokens ?? model.maxTokens, model.maxTokens),
        abortSignal: options.signal,
        // fullStream already carries error parts; streamText's default onError
        // console.errors them, dumping raw AI SDK stacks into the pi UI.
        onError: () => {},
        providerOptions: {
          gateway: {
            only: [provider],
            caching: "auto",
            tags: ["client:pi", "route:explicit-provider", `provider:${provider}`],
          },
        },
      });

      stream.push({ type: "start", partial: output });
      const contentIndexes: Record<string, number> = {};
      const partialToolJson: Record<string, string> = {};
      let finishReason: string | undefined;

      for await (const part of result.fullStream) {
        if (part.type === "text-start") {
          output.content.push({ type: "text", text: "" });
          const contentIndex = output.content.length - 1;
          contentIndexes[`text:${part.id}`] = contentIndex;
          stream.push({ type: "text_start", contentIndex, partial: output });
        } else if (part.type === "text-delta") {
          const contentIndex = contentIndexes[`text:${part.id}`];
          if (contentIndex === undefined) continue;
          const block = output.content[contentIndex];
          if (block.type !== "text") continue;
          block.text += part.text;
          stream.push({ type: "text_delta", contentIndex, delta: part.text, partial: output });
        } else if (part.type === "text-end") {
          const contentIndex = contentIndexes[`text:${part.id}`];
          if (contentIndex === undefined) continue;
          const block = output.content[contentIndex];
          if (block.type === "text") {
            stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
          }
        } else if (part.type === "reasoning-start") {
          output.content.push({ type: "thinking", thinking: "" });
          const contentIndex = output.content.length - 1;
          contentIndexes[`reasoning:${part.id}`] = contentIndex;
          stream.push({ type: "thinking_start", contentIndex, partial: output });
        } else if (part.type === "reasoning-delta") {
          const contentIndex = contentIndexes[`reasoning:${part.id}`];
          if (contentIndex === undefined) continue;
          const block = output.content[contentIndex];
          if (block.type !== "thinking") continue;
          block.thinking += part.text;
          stream.push({ type: "thinking_delta", contentIndex, delta: part.text, partial: output });
        } else if (part.type === "reasoning-end") {
          const contentIndex = contentIndexes[`reasoning:${part.id}`];
          if (contentIndex === undefined) continue;
          const block = output.content[contentIndex];
          if (block.type === "thinking") {
            stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
          }
        } else if (part.type === "tool-input-start") {
          const block = {
            type: "toolCall" as const,
            id: part.id,
            name: part.toolName,
            arguments: {},
          };
          output.content.push(block);
          const contentIndex = output.content.length - 1;
          contentIndexes[`tool:${part.id}`] = contentIndex;
          partialToolJson[part.id] = "";
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
        } else if (part.type === "tool-input-delta") {
          const contentIndex = contentIndexes[`tool:${part.id}`];
          if (contentIndex === undefined) continue;
          const accumulated = (partialToolJson[part.id] ?? "") + part.delta;
          partialToolJson[part.id] = accumulated;
          const block = output.content[contentIndex];
          if (block.type === "toolCall") {
            try { block.arguments = JSON.parse(accumulated); } catch { /* partial JSON */ }
          }
          stream.push({ type: "toolcall_delta", contentIndex, delta: part.delta, partial: output });
        } else if (part.type === "tool-call") {
          let contentIndex = contentIndexes[`tool:${part.toolCallId}`];
          if (contentIndex === undefined) {
            output.content.push({
              type: "toolCall",
              id: part.toolCallId,
              name: part.toolName,
              arguments: part.input as Record<string, unknown>,
            });
            contentIndex = output.content.length - 1;
            stream.push({ type: "toolcall_start", contentIndex, partial: output });
          }
          const block = output.content[contentIndex];
          if (block.type !== "toolCall") continue;
          block.arguments = part.input as Record<string, unknown>;
          stream.push({ type: "toolcall_end", contentIndex, toolCall: block as ToolCall, partial: output });
        } else if (part.type === "finish") {
          finishReason = part.finishReason;
        } else if (part.type === "error") {
          throw part.error;
        } else if (part.type === "abort") {
          throw new Error("Request was aborted");
        }
      }

      const usage = await result.totalUsage;
      const providerMetadata = await result.providerMetadata;
      const generationId = providerMetadata?.gateway?.generationId;
      if (typeof generationId === "string") output.responseId = generationId;
      applyTokenUsage(output.usage, usage);
      calculateCost(model, output.usage);
      applyActualGatewayCost(output.usage, providerMetadata as never);
      const hasToolCalls = output.content.some((block) => block.type === "toolCall");
      output.stopReason = piStopReason(finishReason, hasToolCalls);

      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length" | "toolUse",
        message: output,
      });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

export default function register(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER_ID, {
    name: "Vercel AI Gateway",
    baseUrl: GATEWAY_BASE_URL,
    apiKey: "$AI_GATEWAY_API_KEY",
    api: GATEWAY_API,
    models: [FALLBACK_MODEL],
    async refreshModels(context) {
      if (isCurrentRefreshContext(context)) {
        return refreshCatalog(context, context.stored, async (models, checkedAt) => {
          await context.publish({
            persist: { models: toStoredModels(models), checkedAt, lastModified: checkedAt },
          });
        });
      }

      const stored = await context.store.read();
      return refreshCatalog(context, stored, async (models, checkedAt) => {
        await context.store.write({
          models: toStoredModels(models),
          checkedAt,
          lastModified: checkedAt,
        });
      });
    },
    streamSimple: streamNativeGateway,
  });
}
