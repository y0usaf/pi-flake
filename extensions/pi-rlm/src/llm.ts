import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { completeSimple } from "@mariozechner/pi-ai";

import { MAX_QUERY_CONTEXT_CHARS } from "./constants.js";
import type { Budget, ContextMode, Details, RlmCall, RunState } from "./constants.js";
import { clip, normalizeContextMode, rejectPathsForLlm, resolveModel } from "./utils.js";

// ── Plain LM call: llm_query ────────────────────────────────────────

export async function runLlmQuery(
  ctx: ExtensionContext,
  params: { prompt: string; context?: string; contextMode?: ContextMode; paths?: string[] },
  budget: Budget,
  depth: number,
  state: RunState,
  signal: AbortSignal | undefined,
  onUpdate: any,
  call: RlmCall = "llm_query",
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Details }> {
  if (call === "llm_query") rejectPathsForLlm(call, params.paths, params.contextMode);

  budget.queries++;
  if (budget.queries > budget.maxQueries) throw new Error(`llm_query budget exhausted (${budget.maxQueries}).`);

  const model = resolveModel(ctx, state);
  if (!model) throw new Error("Cannot resolve current session model for RLM call.");

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`Auth failed: ${auth.error}`);

  let prompt = params.prompt;
  if (params.context?.trim()) {
    prompt += `\n\nContext:\n${params.context}`;
  }
  if (prompt.length > MAX_QUERY_CONTEXT_CHARS) {
    prompt = prompt.slice(0, MAX_QUERY_CONTEXT_CHARS) + `\n\n[truncated: ${prompt.length - MAX_QUERY_CONTEXT_CHARS} chars omitted]`;
  }

  onUpdate?.({ content: [{ type: "text", text: `rlm(${call}): calling ${model.provider}/${model.id}...` }] });

  const result = await completeSimple(
    model,
    { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal,
      reasoning: model.reasoning ? "low" : undefined,
    },
  );

  const text = result.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const details: Details = {
    call,
    kind: "llm",
    depth,
    maxDepth: state.maxDepth,
    callsUsed: budget.calls,
    maxCalls: budget.maxCalls,
    queriesUsed: budget.queries,
    maxQueries: budget.maxQueries,
    turns: 0,
    maxTurns: 0,
    model: `${model.provider}/${model.id}`,
    prompt: params.prompt,
    paths: [],
    contextMode: normalizeContextMode(params.contextMode),
    answer: clip(text),
  };

  return { content: [{ type: "text", text: clip(text) }], details };
}

