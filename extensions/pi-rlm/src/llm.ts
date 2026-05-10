import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { completeSimple } from "@mariozechner/pi-ai";

import { MAX_QUERY_CONTEXT_CHARS } from "./constants.js";
import type { Budget, ContextMode, Details, RlmCall, RunState } from "./constants.js";
import { budgetDetails, checkRunLimits, clip, modelLabel, normalizeContextMode, normPaths, normSources, recordError, recordUsage, rejectPathsForLlm, resolveModel, withTimeoutSignal } from "./utils.js";

const LEAF_SYSTEM_PROMPT = `You are a precise one-shot leaf LLM call inside a Recursive Language Model (RLM) run.
You do not have a REPL, filesystem, tools, or iteration in this call.
Answer only the requested subproblem using the supplied prompt/context.
If the evidence is insufficient, say so compactly instead of inventing details.`;

function leafSystemPrompt(rootPrompt?: string): string {
  const root = rootPrompt?.trim();
  return root
    ? `${LEAF_SYSTEM_PROMPT}

Root instruction / question from the parent RLM:
${root}`
    : LEAF_SYSTEM_PROMPT;
}

// ── Plain LM call: llm_query ────────────────────────────────────────

export async function runLlmQuery(
  ctx: ExtensionContext,
  params: { prompt: string; rootPrompt?: string; model?: string; context?: string; contextMode?: ContextMode; paths?: string[]; sources?: Array<{ name?: string; path: string }>; contextName?: string },
  budget: Budget,
  depth: number,
  state: RunState,
  signal: AbortSignal | undefined,
  onUpdate: any,
  call: RlmCall = "llm_query",
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Details }> {
  if (call === "llm_query" || call === "llm_query_batched") rejectPathsForLlm(call, params.paths, params.contextMode, params.sources);

  budget.queries++;
  if (budget.queries > budget.maxQueries) throw new Error(`llm_query budget exhausted (${budget.maxQueries}).`);

  checkRunLimits(state);
  const model = resolveModel(ctx, state, "llm", params.model);
  if (!model) throw new Error("Cannot resolve current session model for RLM call.");

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`Auth failed: ${auth.error}`);

  let prompt = params.prompt;
  if (params.rootPrompt?.trim()) {
    prompt += `

Root prompt / question:
${params.rootPrompt}`;
  }
  if (params.context?.trim()) {
    prompt += `

Context:
${params.context}`;
  }
  if (prompt.length > MAX_QUERY_CONTEXT_CHARS) {
    prompt = prompt.slice(0, MAX_QUERY_CONTEXT_CHARS) + `\n\n[truncated: ${prompt.length - MAX_QUERY_CONTEXT_CHARS} chars omitted]`;
  }

  onUpdate?.({ content: [{ type: "text", text: `${call}: calling ${modelLabel(model)}...` }] });

  const timed = withTimeoutSignal(signal, state);
  let result;
  try {
    result = await completeSimple(
      model,
      { systemPrompt: leafSystemPrompt(params.rootPrompt), messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: timed.signal,
        timeoutMs: state.budget.maxTimeoutMs ? Math.max(1, state.budget.maxTimeoutMs - (Date.now() - state.budget.startTimeMs)) : undefined,
        reasoning: model.reasoning ? "low" : undefined,
      },
    );
  } finally {
    timed.dispose();
  }

  const contentText = result.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const failed = result.stopReason === "error" || result.stopReason === "aborted";
  const truncated = result.stopReason === "length";
  const failureText = failed
    ? `${result.stopReason === "aborted" ? "Aborted" : "Error"}: ${result.errorMessage || `Provider returned ${result.stopReason}.`}`
    : "";
  const truncationText = truncated ? "[truncated: provider hit its output limit]" : "";
  const text = failed
    ? [contentText.trim(), failureText].filter(Boolean).join("\n")
    : truncated
      ? [truncationText, contentText.trim()].filter(Boolean).join("\n\n")
      : contentText;

  const usage = recordUsage(state, result.usage);
  if (failed) recordError(state);

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
    model: modelLabel(model),
    status: failed ? (result.stopReason === "aborted" ? "aborted" : "error") : result.stopReason === "length" ? "partial" : "completed",
    ...budgetDetails(state),
    prompt: params.prompt,
    rootPrompt: params.rootPrompt,

    paths: call === "llm_query" || call === "llm_query_batched" ? [] : normPaths(params.paths),
    sources: call === "llm_query" || call === "llm_query_batched" ? [] : normSources(params.sources),
    contextMode: normalizeContextMode(params.contextMode),
    usage,
    answer: clip(text),
  };
  if (failed || truncated) {
    if (failed) {
      details.error = result.errorMessage || `Provider returned ${result.stopReason}.`;
    }
    details.incomplete = true;
  }

  return { content: [{ type: "text", text: clip(text) }], details };
}

