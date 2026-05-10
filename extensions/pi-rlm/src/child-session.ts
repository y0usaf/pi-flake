import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import { MAX_INLINE_CHILD_CONTEXT_CHARS, REPL_TOOL_NAME } from "./constants.js";
import type { ContextMode, ContextStore, Details, RunState } from "./constants.js";
import {
  cleanupContextStore,
  contextMaterialized,
  contextSourceSummary,
  contextStorePromptBlock,
  prepareContextStore,
} from "./context-store.js";
import { runLlmQuery } from "./llm.js";
import {
  budgetDetails,
  checkRunLimits,
  clip,
  extractAnswer,
  hasReturn,
  leafPrompt,
  normalizeContextMode,
  normPaths,
  normSources,
  resolveModel,
  modelLabel,
  recordError,
  recordUsage,
  textOf,
  traceOf,
  usageFromMessages,
  withTimeoutSignal,
} from "./utils.js";

// ── Recursive child RLM: rlm_query ──────────────────────────────────

export function childSystemPrompt(depth: number, state: RunState, hasContextStore: boolean): string {
  const contextLine = hasContextStore
    ? "A file-backed context source set has been loaded into the REPL as context/context_0/context_N values. Use SHOW_VARS() and normal Python inspection; do not print huge values back into chat."
    : "Use the REPL context/history/state variables when present.";

  return `Recursive Pi child RLM. Depth ${depth}/${state.maxDepth}. Calls ${state.budget.calls}/${state.budget.maxCalls}. Queries ${state.budget.queries}/${state.budget.maxQueries}.

You are an upstream-style RLM sub-call. Your only tool is ${REPL_TOOL_NAME}, a Python REPL exposing exactly: llm_query, llm_query_batched, rlm_query, rlm_query_batched, FINAL_VAR, SHOW_VARS, state, history, context/context_N, and injected values.

${contextLine}

The RLM pattern:
1. Use ${REPL_TOOL_NAME} for all computation, inspection, batching, and synthesis.
2. Inspect context with SHOW_VARS(), Python slicing/searching, and normal Python modules such as json, os, pathlib, subprocess, and open().
3. Use llm_query/llm_query_batched for one-shot reasoning over already extracted text.
4. Use rlm_query/rlm_query_batched only when a subproblem needs another recursive RLM session.
5. Put the final answer in a variable or state key and call FINAL_VAR("name").

Rules:
- Do not dump large context values into chat; print compact observations only.
- Prefer batched calls for independent chunks/sub-calls.
- Do not modify project files unless explicitly asked.
- If turn budget runs low, call FINAL_VAR with a partial answer and remaining work.`;
}

export function childPrompt(prompt: string, context?: string, paths?: string[], store?: ContextStore, rootPrompt?: string): string {
  const pathBlock = paths?.length ? paths.map((p) => `- ${p}`).join("\n") : "(none)";
  const ctxBlock = context?.trim() && !contextMaterialized(store) ? `
Inline context:
${clip(context, MAX_INLINE_CHILD_CONTEXT_CHARS)}
` : "";
  const rootPromptBlock = rootPrompt?.trim() ? `
Root prompt / question:
${rootPrompt}
` : "";
  const storeBlock = store ? contextStorePromptBlock(store) : "";

  return `Prompt:
${prompt}
${rootPromptBlock}${ctxBlock}${storeBlock}
Paths to inspect with Python if relevant:
${pathBlock}

Use ${REPL_TOOL_NAME} only. Finalize by assigning the answer to a variable or state key and calling FINAL_VAR("name").`;
}

export function childToolList(): string[] {
  return [REPL_TOOL_NAME];
}

function childTranscript(messages: any[], maxChars = 120_000): string {
  const lines: string[] = [];
  for (const m of messages) {
    const role = typeof m?.role === "string" ? m.role : "?";
    const tool = typeof m?.toolName === "string" ? `:${m.toolName}` : "";
    const body = textOf(m?.content).trim();
    if (!body) continue;
    lines.push(`## ${role}${tool}\n${body}`);
  }
  return clip(lines.join("\n\n"), maxChars);
}

function deterministicFinalPrompt(originalPrompt: string, messages: any[], reason: string): string {
  return `A recursive Pi child RLM did not complete normally (${reason}). Produce the best possible deterministic checkpoint/final answer from the transcript below. Do not claim work that is not evidenced. If incomplete, explicitly say what remains unchecked. Include changed files or artifacts if the transcript mentions any.\n\nOriginal child task:\n${originalPrompt}\n\nChild transcript:\n${childTranscript(messages)}`;
}

export async function runRlmQuery(
  ctx: ExtensionContext,
  params: { prompt: string; rootPrompt?: string; model?: string; context?: string; contextMode?: ContextMode; paths?: string[]; sources?: Array<{ name?: string; path: string }>; contextName?: string; allowWrites?: boolean },
  depth: number,
  state: RunState,
  signal: AbortSignal | undefined,
  onUpdate: any,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Details }> {
  const contextMode = normalizeContextMode(params.contextMode);
  checkRunLimits(state);

  // RLM semantics: at max depth, rlm_query falls back to a plain LM leaf call.
  if (depth >= state.maxDepth) {
    return runLlmQuery(ctx, {
      prompt: leafPrompt(params.prompt, params.paths, params.sources),
      rootPrompt: params.rootPrompt,

      model: params.model,
      context: params.context,
      contextMode,
      paths: params.paths,
      sources: params.sources,
      contextName: params.contextName,
    }, state.budget, depth, state, signal, onUpdate, "rlm_query");
  }

  state.budget.calls++;
  if (state.budget.calls > state.budget.maxCalls) throw new Error(`Max recursive child RLM calls (${state.budget.maxCalls}).`);

  const model = resolveModel(ctx, state, "rlm", params.model);
  if (!model) throw new Error("Cannot resolve current session model for RLM call.");


  const contextStore = await prepareContextStore(ctx.cwd, { ...params, contextMode });
  const timed = withTimeoutSignal(signal, state);
  const effectiveSignal = timed.signal;
  const hasContextStore = Boolean(contextStore);
  const tools = childToolList();

  let session: any | undefined;
  let unsub: (() => void) | undefined;
  let turns = 0;
  let abortedByTurnLimit = false;
  let finalizationRequested = false;

  const sourceSummaries = contextStore?.sources.map(contextSourceSummary) ?? [];
  const emit = (text: string) =>
    onUpdate?.({
      content: [{ type: "text", text }],
      details: {
        call: "rlm_query" as const,
        kind: "rlm" as const,
        depth,
        maxDepth: state.maxDepth,
        callsUsed: state.budget.calls,
        maxCalls: state.budget.maxCalls,
        queriesUsed: state.budget.queries,
        maxQueries: state.budget.maxQueries,
        turns,
        maxTurns: state.maxTurns,
        model: modelLabel(model),
        status: "partial" as const,
        ...budgetDetails(state),
        prompt: params.prompt,
        rootPrompt: params.rootPrompt,

        paths: normPaths(params.paths),
        sources: normSources(params.sources),
        contextMode,
        scratchDir: contextStore?.scratchDir,
        contextSources: sourceSummaries,
        finalizationRequested,
      },
    });

  const kill = () => {
    if (session) void session.abort();
  };

  try {
    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      appendSystemPrompt: [childSystemPrompt(depth, state, hasContextStore)],
    });
    await loader.reload();

    const { createRlmReplTool } = await import("./repl.js");
    const customTools: any[] = [createRlmReplTool(state, depth, contextStore)];

    const created = await createAgentSession({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      authStorage: ctx.modelRegistry.authStorage,
      modelRegistry: ctx.modelRegistry,
      model,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      tools,
      customTools,
    });
    session = created.session;

    unsub = session.subscribe((ev: any) => {
      if (ev.type === "tool_execution_start") {
        emit(`depth ${depth}: ${ev.toolName}...`);
      } else if (ev.type === "turn_end") {
        turns++;
        emit(`depth ${depth}: turn ${turns}/${state.maxTurns}`);
        const ret = Array.isArray(ev.toolResults) && ev.toolResults.some((r: any) => r?.toolName === REPL_TOOL_NAME && r?.details?.final === true);
        const more = ev.message?.stopReason === "toolUse" && !ret;
        if (turns >= state.maxTurns && more) {
          abortedByTurnLimit = true;
          emit(`depth ${depth}: turn budget reached; aborting child for deterministic parent-side finalization`);
          void session.abort();
        }
      }
    });

    if (effectiveSignal?.aborted) kill();
    else effectiveSignal?.addEventListener("abort", kill, { once: true });

    emit(`depth ${depth}: starting${contextStore ? ` with context (${contextStore.sources.length} source${contextStore.sources.length === 1 ? "" : "s"})` : ""}`);
    await session.prompt(childPrompt(params.prompt, params.context, params.paths, contextStore, params.rootPrompt));

    let msgs = [...(session.messages as any[])];
    let completed = hasReturn(msgs);
    let deterministicFinalized = false;
    let deterministicFinalizationReason: string | undefined;
    let answer = "";

    if (completed) {
      answer = clip(extractAnswer(msgs));
    } else if (!effectiveSignal?.aborted) {
      finalizationRequested = true;
      deterministicFinalized = true;
      deterministicFinalizationReason = abortedByTurnLimit ? `maxTurns=${state.maxTurns}` : `missing FINAL_VAR`;
      emit(`depth ${depth}: synthesizing deterministic final answer (${deterministicFinalizationReason})`);
      const synthesized = await runLlmQuery(ctx, {
        prompt: deterministicFinalPrompt(params.prompt, msgs, deterministicFinalizationReason),
        rootPrompt: params.rootPrompt,
        model: params.model,

        contextMode: "inline",
      }, state.budget, depth, state, effectiveSignal, onUpdate, "rlm_query");
      answer = clip(textOf(synthesized.content).trim() || extractAnswer(msgs));
    } else {
      answer = clip(extractAnswer(msgs));
    }

    const usage = recordUsage(state, usageFromMessages(msgs));
    if (!completed) {
      try { recordError(state); } catch { /* keep synthesized partial details */ }
    }
    const incomplete = !completed;
    const details: Details = {
      call: "rlm_query",
      kind: "rlm",
      depth,
      maxDepth: state.maxDepth,
      callsUsed: state.budget.calls,
      maxCalls: state.budget.maxCalls,
      queriesUsed: state.budget.queries,
      maxQueries: state.budget.maxQueries,
      turns,
      maxTurns: state.maxTurns,
      model: modelLabel(model),
      status: effectiveSignal?.aborted ? "aborted" : incomplete ? "partial" : "completed",
      ...budgetDetails(state),
      prompt: params.prompt,
      rootPrompt: params.rootPrompt,

      usage,
      paths: normPaths(params.paths),
      sources: normSources(params.sources),
      contextMode,
      scratchDir: contextStore?.scratchDir,
      contextSources: sourceSummaries,
      answer,
      trace: traceOf(msgs),
      completedWithReturn: completed,
      finalizationRequested,
      deterministicFinalized,
      deterministicFinalizationReason,
      abortedByTurnLimit,
      incomplete,
    };

    const note = abortedByTurnLimit
      ? `\n\n[stopped after maxTurns=${state.maxTurns}; synthesized checkpoint may be partial]`
      : !completed
        ? deterministicFinalized
          ? `\n\n[child ended without FINAL_VAR; synthesized checkpoint from transcript]`
          : `\n\n[child ended without FINAL_VAR; using last available text]`
        : "";
    return { content: [{ type: "text", text: `${answer}${note}` }], details };
  } finally {
    effectiveSignal?.removeEventListener("abort", kill);
    timed.dispose();
    unsub?.();
    session?.dispose();
    await cleanupContextStore(contextStore);
  }
}

