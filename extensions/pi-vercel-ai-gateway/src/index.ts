import { createGateway } from "@ai-sdk/gateway";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { jsonSchema, streamText, tool } from "ai";
import { discoverExplicitModels, splitExplicitModelId } from "./catalog.js";
import { toModelMessages } from "./messages.js";
import { applyActualGatewayCost, applyTokenUsage } from "./usage.js";

const PROVIDER_ID = "vercel-ai-gateway";

function piStopReason(reason: string | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls || reason === "tool-calls") return "toolUse";
  if (reason === "length") return "length";
  if (reason === "error") return "error";
  return "stop";
}

/** AI SDK AI_APICallError carries structured fields; its .message is the raw body. */
interface GatewayApiError {
  name?: string;
  message?: string;
  statusCode?: number;
  isRetryable?: boolean;
  responseBody?: string;
}

function firstLine(text: string | undefined, limit = 200): string {
  if (!text) return "";
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > limit ? line.slice(0, limit) + "…" : line;
}

/** Extract a short, retry-classifiable message from an AI SDK gateway error. */
function describeGatewayError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const api = error as Error & GatewayApiError;
  if (api.statusCode === undefined && api.responseBody === undefined) return error.message;
  let upstream = firstLine(api.responseBody) || firstLine(api.message);
  try {
    const parsed = JSON.parse(api.responseBody ?? "") as { error?: { message?: string }; message?: string };
    upstream = firstLine(parsed.error?.message ?? parsed.message) || upstream;
  } catch { /* body is not JSON */ }
  const status = api.statusCode !== undefined ? `HTTP ${api.statusCode}` : "request failed";
  return `AI gateway ${status}: ${upstream || error.name}`;
}

/** Retry transient gateway failures (429/5xx) with exponential backoff, capped. */
function isRetryableGatewayError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const api = error as Error & GatewayApiError;
  if (api.isRetryable === true) return true;
  const status = api.statusCode ?? 0;
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Request was aborted")); }, { once: true });
  });
}

const STREAM_MAX_ATTEMPTS = 4;
const STREAM_RETRY_BASE_MS = 500;

/**
 * Swallow rejected deferred promises on a failed StreamTextResult.
 * When the stream errors, totalUsage/providerMetadata/etc. reject; if nobody
 * awaits them Node raises an unhandled rejection and pi crashes with the raw
 * AI SDK error dump instead of the clean error event.
 */
function swallowStreamResult(result: unknown): void {
  if (typeof result !== "object" || result === null) return;
  const r = result as Record<string, unknown>;
  for (const key of ["totalUsage", "providerMetadata", "finishReason", "steps"]) {
    const value = r[key];
    if (value && typeof (value as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(value as PromiseLike<unknown>).then(undefined, () => {});
    }
  }
}
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
    // Latest streamText result; kept outside the try so the catch can swallow
    // its deferred promises (they reject when the stream errors).
    let activeResult: unknown;
    try {
      if (!options?.apiKey) throw new Error("Vercel AI Gateway API key is missing");
      if (options.signal?.aborted) throw new Error("Request was aborted");

      const { upstreamModelId, provider } = splitExplicitModelId(model.id);
      const gateway = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY ?? options.apiKey });
      const tools = Object.fromEntries(
        (context.tools ?? []).map((definition) => [
          definition.name,
          tool({
            description: definition.description,
            inputSchema: jsonSchema(definition.parameters as never),
          }),
        ]),
      );

      // Retry while nothing has streamed; a mid-stream retry would duplicate blocks.
      const buildStream = () => streamText({
        model: gateway(upstreamModelId),
        system: context.systemPrompt,
        messages: toModelMessages(context),
        tools: Object.keys(tools).length > 0 ? tools : undefined,
        maxOutputTokens: Math.min(options.maxTokens ?? model.maxTokens, model.maxTokens),
        abortSignal: options.signal,
        providerOptions: {
          gateway: {
            only: [provider],
            caching: "auto",
            tags: ["client:pi", "route:explicit-provider", `provider:${provider}`],
          },
        },
      });

      const contentIndexes = new Map<string, number>();
      const partialToolJson = new Map<string, string>();
      let finishReason: string | undefined;
      let started = false;

      let result = buildStream();
      activeResult = result;
      for (let attempt = 1; ; attempt++) {
        contentIndexes.clear();
        partialToolJson.clear();
        output.content = [];
        try {
          for await (const part of result.fullStream) {
            if (!started) {
              stream.push({ type: "start", partial: output });
              started = true;
            }
        if (part.type === "text-start") {
          output.content.push({ type: "text", text: "" });
          const contentIndex = output.content.length - 1;
          contentIndexes.set(`text:${part.id}`, contentIndex);
          stream.push({ type: "text_start", contentIndex, partial: output });
        } else if (part.type === "text-delta") {
          const contentIndex = contentIndexes.get(`text:${part.id}`);
          if (contentIndex === undefined) continue;
          const block = output.content[contentIndex];
          if (block.type !== "text") continue;
          block.text += part.text;
          stream.push({ type: "text_delta", contentIndex, delta: part.text, partial: output });
        } else if (part.type === "text-end") {
          const contentIndex = contentIndexes.get(`text:${part.id}`);
          if (contentIndex === undefined) continue;
          const block = output.content[contentIndex];
          if (block.type === "text") {
            stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
          }
        } else if (part.type === "reasoning-start") {
          output.content.push({ type: "thinking", thinking: "" });
          const contentIndex = output.content.length - 1;
          contentIndexes.set(`reasoning:${part.id}`, contentIndex);
          stream.push({ type: "thinking_start", contentIndex, partial: output });
        } else if (part.type === "reasoning-delta") {
          const contentIndex = contentIndexes.get(`reasoning:${part.id}`);
          if (contentIndex === undefined) continue;
          const block = output.content[contentIndex];
          if (block.type !== "thinking") continue;
          block.thinking += part.text;
          stream.push({ type: "thinking_delta", contentIndex, delta: part.text, partial: output });
        } else if (part.type === "reasoning-end") {
          const contentIndex = contentIndexes.get(`reasoning:${part.id}`);
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
          contentIndexes.set(`tool:${part.id}`, contentIndex);
          partialToolJson.set(part.id, "");
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
        } else if (part.type === "tool-input-delta") {
          const contentIndex = contentIndexes.get(`tool:${part.id}`);
          if (contentIndex === undefined) continue;
          const accumulated = (partialToolJson.get(part.id) ?? "") + part.delta;
          partialToolJson.set(part.id, accumulated);
          const block = output.content[contentIndex];
          if (block.type === "toolCall") {
            try { block.arguments = JSON.parse(accumulated); } catch { /* partial JSON */ }
          }
          stream.push({ type: "toolcall_delta", contentIndex, delta: part.delta, partial: output });
        } else if (part.type === "tool-call") {
          let contentIndex = contentIndexes.get(`tool:${part.toolCallId}`);
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
          break;
        } catch (error) {
          swallowStreamResult(result);
          if (started || attempt >= STREAM_MAX_ATTEMPTS || !isRetryableGatewayError(error)) throw error;
          await sleep(STREAM_RETRY_BASE_MS * 2 ** (attempt - 1), options.signal);
          result = buildStream();
          activeResult = result;
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
      swallowStreamResult(activeResult);
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = describeGatewayError(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

const GATEWAY_API = "vercel-ai-gateway-native";
const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1/ai";
type DiscoveredModel = Awaited<ReturnType<typeof discoverExplicitModels>>[number];
type GatewayModel = Model<Api>;

const FALLBACK_MODEL: GatewayModel = {
  id: "deepseek/deepseek-v4-flash-0731@runware",
  name: "DeepSeek V4 Flash 0731 via runware",
  api: GATEWAY_API,
  baseUrl: GATEWAY_BASE_URL,
  provider: PROVIDER_ID,
  reasoning: true,
  input: ["text"],
  cost: { input: 0.08, output: 0.15, cacheRead: 0.01, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 384_000,
};

let dynamicModels: readonly GatewayModel[] = [];

function toGatewayModel(model: DiscoveredModel): GatewayModel {
  return {
    ...model,
    api: GATEWAY_API,
    baseUrl: GATEWAY_BASE_URL,
    provider: PROVIDER_ID,
  };
}


async function discoverGatewayModels(): Promise<GatewayModel[]> {
  const discovered = await discoverExplicitModels({});
  return discovered.map(toGatewayModel);
}

function gatewayProviderConfig(models: readonly GatewayModel[]) {
  return {
    name: "Vercel AI Gateway",
    baseUrl: GATEWAY_BASE_URL,
    apiKey: process.env.AI_GATEWAY_API_KEY,
    api: GATEWAY_API,
    models: [...models],
    streamSimple: streamNativeGateway,
  };
}

export default function register(pi: ExtensionAPI): void {
  console.error(`[gw-ext] loaded, registering provider ${PROVIDER_ID}`);
  console.error(`[gw-ext] env key visible: ${Boolean(process.env.AI_GATEWAY_API_KEY)}`);
  try {
    pi.registerProvider(PROVIDER_ID, gatewayProviderConfig([FALLBACK_MODEL]));
    console.error(`[gw-ext] registerProvider succeeded`);
  } catch (error) {
    console.error(`[gw-ext] registerProvider FAILED: ${error}`);
  }

  // Live catalog: replace the fallback list once discovery lands.
  void discoverGatewayModels().then((models) => {
    if (models.length > 0) pi.registerProvider(PROVIDER_ID, gatewayProviderConfig(models));
  }).catch(() => {});
}
