import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

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

function limitLabel(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? String(value) : "∞";
}

export function childSystemPrompt(depth: number, state: RunState, hasContextStore: boolean): string {
  const contextLine = hasContextStore
    ? "A file-backed context source set has been loaded into the REPL as context/context_0/context_N values. Use SHOW_VARS() and normal Python inspection; do not print huge values back into chat."
    : "Use the REPL context/history/state variables when present.";
  const turnRule = state.maxTurns === undefined
    ? "- There is no pi-rlm turn cap for this run; still finalize promptly once the answer is ready."
    : "- If turn budget runs low, call FINAL_VAR with a partial answer and remaining work.";

  return `Recursive Pi child RLM. Depth ${depth}/${limitLabel(state.maxDepth)}. Calls ${state.budget.calls}/${limitLabel(state.budget.maxCalls)}. Queries ${state.budget.queries}/${limitLabel(state.budget.maxQueries)}.

You are an upstream-style recursive RLM worker, not a normal chat assistant. Your only tool is ${REPL_TOOL_NAME}, a Python REPL exposing exactly: llm_query, llm_query_batched, rlm_query, rlm_query_batched, FINAL_VAR, SHOW_VARS, state, history, context/context_N, and injected values.

${contextLine}

Execution contract:
- You are queried iteratively by Pi until you finalize. Do not answer directly from chat when a REPL action is possible.
- Your first substantive action must be a ${REPL_TOOL_NAME} call to inspect context/state, run code, or launch subcalls.
- Put the final answer in a Python variable or state key and call FINAL_VAR("name") inside ${REPL_TOOL_NAME}.

Recursive default policy:
1. Break the task into digestible components.
2. Use ${REPL_TOOL_NAME} for all computation, inspection, batching, and synthesis.
3. Use rlm_query/rlm_query_batched for subtasks that need their own exploration, code execution, multi-step reasoning, repo/document inspection, verification, or uncertain synthesis.
4. Use llm_query/llm_query_batched only for narrow one-shot reasoning over already extracted self-contained text.
5. Prefer batched child calls for independent chunks/subtasks.
6. If child results are incomplete or contradictory, recurse narrower before finalizing.

Rules:
- Do not dump large context values into chat; print compact observations only.
- Do not modify project files unless explicitly asked.
${turnRule}`;
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

Use ${REPL_TOOL_NAME} only. Think step-by-step in the REPL environment, inspect the available context/files, decompose when useful, use rlm_query/rlm_query_batched for deeper subtasks, and finalize by assigning the answer to a variable or state key and calling FINAL_VAR("name"). Your next action should be a ${REPL_TOOL_NAME} call.`;
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

// ── Structural decomposition ─────────────────────────────────────────

const DECOMPOSE_SYSTEM = `You are a recursive task decomposition engine inside an RLM (Recursive Language Model).
Given a task, determine if it should be decomposed into independent subtasks that can be worked on in parallel, or handled as a single unit.

Rules:
- Decompose when the task involves multiple files, multiple independent questions, audit/review across sources, comparison, or naturally parallel work.
- Do NOT decompose simple questions, single-file edits, narrow lookups, or tasks that are already focused enough for one worker.
- Each subtask must be self-contained and independently answerable.
- Keep subtask count reasonable (2-8 subtasks).
- Respond with ONLY valid JSON, no markdown fences.`;

function decomposeUserPrompt(prompt: string, context?: string, paths?: string[]): string {
  const parts = [`Task:\n${prompt}`];
  if (paths?.length) parts.push("Paths available:\n" + paths.map((p) => "- " + p).join("\n"));
  if (context?.trim()) parts.push(`Context excerpt (first 2000 chars):\n${context.slice(0, 2000)}`);
  parts.push(`\nRespond with ONLY valid JSON:\n{"decompose": true, "subtasks": ["...", "..."]}\nor\n{"decompose": false, "reason": "..."}`);
  return parts.join("\n\n");
}

interface DecomposeResult {
  decompose: boolean;
  subtasks?: string[];
  reason?: string;
}

function parseDecomposeResponse(text: string): DecomposeResult | undefined {
  try {
    // Strip markdown fences if present
    const cleaned = text.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
    const parsed = JSON.parse(cleaned);
    if (typeof parsed?.decompose !== "boolean") return undefined;
    if (parsed.decompose && (!Array.isArray(parsed.subtasks) || parsed.subtasks.length < 2)) return undefined;
    if (parsed.decompose && parsed.subtasks.some((s: unknown) => typeof s !== "string" || !s)) return undefined;
    return parsed as DecomposeResult;
  } catch {
    return undefined;
  }
}

/**
 * Attempt structural decomposition: ask a leaf LLM whether this task should
 * be split, and if so, automatically fan out child rlm_query calls.
 *
 * Returns the synthesized result if decomposition was performed, or undefined
 * if the task should be handled as a single interactive session.
 */
async function tryStructuralDecompose(
  ctx: ExtensionContext,
  params: { prompt: string; rootPrompt?: string; model?: string; context?: string; contextMode?: ContextMode; paths?: string[]; sources?: Array<{ name?: string; path: string }>; contextName?: string },
  depth: number,
  state: RunState,
  signal: AbortSignal | undefined,
  onUpdate: any,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Details } | undefined> {
  // Don't decompose if we're already near limits
  if (state.maxDepth !== undefined && depth + 1 >= state.maxDepth) return undefined;
  if (state.budget.maxCalls !== undefined && state.budget.calls + 2 >= state.budget.maxCalls) return undefined;
  if (state.budget.maxQueries !== undefined && state.budget.queries + 2 >= state.budget.maxQueries) return undefined;

  onUpdate?.({ content: [{ type: "text", text: `depth ${depth}: checking structural decomposition...` }] });

  // Ask leaf LLM to decompose
  const decomposeResult = await runLlmQuery(ctx, {
    prompt: DECOMPOSE_SYSTEM + "\n\n" + decomposeUserPrompt(params.prompt, params.context, params.paths),
  }, state.budget, depth, state, signal, onUpdate, "llm_query");

  const decomposeText = textOf(decomposeResult.content).trim();
  const decision = parseDecomposeResponse(decomposeText);

  if (!decision?.decompose || !decision.subtasks?.length) {
    onUpdate?.({ content: [{ type: "text", text: `depth ${depth}: no decomposition needed${decision?.reason ? ` (${decision.reason})` : ""}` }] });
    return undefined;
  }

  // ── Fan out: spawn parallel child rlm_query calls ──
  const subtasks = decision.subtasks;
  onUpdate?.({ content: [{ type: "text", text: `depth ${depth}: structural decomposition into ${subtasks.length} subtasks` }] });

  const { runBatch } = await import("./batch.js");
  const batchParams = {
    call: "rlm_query_batched" as const,
    items: subtasks.map((subtask) => ({
      prompt: subtask,
      rootPrompt: params.rootPrompt ?? params.prompt,
      model: params.model,
      context: params.context,
      contextMode: params.contextMode,
      paths: params.paths,
      sources: params.sources,
      contextName: params.contextName,
    })),
  };

  const batchResult = await runBatch(ctx, batchParams, "rlm_query_batched", depth + 1, state, signal, onUpdate);

  // ── Synthesize: combine child results ──
  const childAnswers = textOf(batchResult.content).trim();
  onUpdate?.({ content: [{ type: "text", text: `depth ${depth}: synthesizing ${subtasks.length} child results...` }] });

  const synthesizePrompt = `You are synthesizing the results of ${subtasks.length} parallel subtask workers in a Recursive Language Model.

Original task:
${params.prompt}

Subtask results:
${childAnswers}

Produce a coherent, complete final answer that integrates all subtask findings. Note any gaps, contradictions, or incomplete areas. Be concise but thorough.`;

  const synthesized = await runLlmQuery(ctx, {
    prompt: synthesizePrompt,
    rootPrompt: params.rootPrompt,
  }, state.budget, depth, state, signal, onUpdate, "llm_query");

  const answer = clip(textOf(synthesized.content).trim());
  const details: Details = {
    call: "rlm_query",
    kind: "rlm",
    depth,
    maxDepth: state.maxDepth,
    callsUsed: state.budget.calls,
    maxCalls: state.budget.maxCalls,
    queriesUsed: state.budget.queries,
    maxQueries: state.budget.maxQueries,
    turns: (batchResult.details.turns || 0) + 2, // decompose + synthesize
    maxTurns: state.maxTurns,
    model: batchResult.details.model,
    status: batchResult.details.incomplete ? "partial" : "completed",
    ...budgetDetails(state),
    prompt: params.prompt,
    rootPrompt: params.rootPrompt,
    paths: normPaths(params.paths),
    sources: normSources(params.sources),
    answer,
    incomplete: batchResult.details.incomplete,
  };

  return { content: [{ type: "text", text: answer }], details };
}

// ── Main entry point ─────────────────────────────────────────────────

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
  if (state.maxDepth !== undefined && depth >= state.maxDepth) {
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

  // ── Structural decomposition: try auto-decompose before interactive session ──
  const structuralResult = await tryStructuralDecompose(ctx, { ...params, contextMode }, depth, state, signal, onUpdate);
  if (structuralResult) return structuralResult;

  // ── Interactive child session (single-unit tasks) ──

  state.budget.calls++;
  if (state.budget.maxCalls !== undefined && state.budget.calls > state.budget.maxCalls) throw new Error(`Max recursive child RLM calls (${state.budget.maxCalls}).`);

  const model = resolveModel(ctx, state, "rlm", params.model);
  if (!model) throw new Error("Cannot resolve current session model for RLM call.");


  const contextStore = await prepareContextStore(ctx.cwd, { ...params, contextMode });
  const timed = withTimeoutSignal(signal, state);
  const effectiveSignal = timed.signal;
  const hasContextStore = Boolean(contextStore);
  const tools = childToolList();
  const systemPrompt = childSystemPrompt(depth, state, hasContextStore);

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
      noContextFiles: true,
      // A recursive child must be a true RLM child, not a normal Pi agent with
      // the default Pi prompt plus an appended note. Pass the child prompt as
      // the actual system prompt/instructions payload and suppress appends so
      // providers such as OpenAI Codex Responses receive `instructions`.
      systemPrompt,
      appendSystemPrompt: [],
      systemPromptOverride: () => systemPrompt,
      appendSystemPromptOverride: () => [],
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
      noTools: "all",
      tools,
      customTools,
    });
    session = created.session;

    const activeTools = typeof session.getActiveToolNames === "function" ? session.getActiveToolNames() : tools;
    if (activeTools.length !== 1 || activeTools[0] !== REPL_TOOL_NAME) {
      throw new Error(`Child RLM session must be REPL-only; active tools were: ${activeTools.join(", ") || "(none)"}`);
    }

    unsub = session.subscribe((ev: any) => {
      if (ev.type === "tool_execution_start") {
        emit(`depth ${depth}: ${ev.toolName}...`);
      } else if (ev.type === "turn_end") {
        turns++;
        emit(`depth ${depth}: turn ${turns}${state.maxTurns === undefined ? "" : `/${state.maxTurns}`}`);
        const ret = Array.isArray(ev.toolResults) && ev.toolResults.some((r: any) => r?.toolName === REPL_TOOL_NAME && r?.details?.final === true);
        const more = ev.message?.stopReason === "toolUse" && !ret;
        if (state.maxTurns !== undefined && turns >= state.maxTurns && more) {
          abortedByTurnLimit = true;
          emit(`depth ${depth}: turn budget reached; aborting child for deterministic parent-side finalization`);
          void session.abort();
        }
      }
    });

    if (effectiveSignal?.aborted) kill();
    else effectiveSignal?.addEventListener("abort", kill, { once: true });

    emit(`depth ${depth}: starting${contextStore ? ` with context (${contextStore.sources.length} source${contextStore.sources.length === 1 ? "" : "s"})` : ""}`);
    await session.prompt(childPrompt(params.prompt, params.context, params.paths, contextStore, params.rootPrompt), { expandPromptTemplates: false, source: "extension" });

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
