import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import { CTX_TOOL_NAME, MAX_INLINE_CHILD_CONTEXT_CHARS, REPL_TOOL_NAME, RETURN_TOOL_NAME, RLM_TOOL_NAME } from "./constants.js";
import type { ContextMode, ContextStore, Details, RunState } from "./constants.js";
import {
  cleanupContextStore,
  contextMaterialized,
  contextSourceSummary,
  contextStorePromptBlock,
  prepareContextStore,
} from "./context-store.js";
import { runLlmQuery } from "./llm.js";
import { createContextTool, createReturnTool, createRlmTool } from "./tools.js";
import {
  clip,
  extractAnswer,
  hasReturn,
  leafPrompt,
  normalizeContextMode,
  normPaths,
  normSources,
  resolveModel,
  textOf,
  traceOf,
} from "./utils.js";

// ── Recursive child RLM: rlm_query ──────────────────────────────────

export function childSystemPrompt(depth: number, state: RunState, hasContextStore: boolean): string {
  const ctxTool = hasContextStore
    ? `- ${CTX_TOOL_NAME}: inspect file-backed context with capped outputs. Actions: manifest, grep, peek, extract, note, artifact. Prefer this before raw bash/read on large sources.`
    : "";
  const inspectTools = hasContextStore ? `${CTX_TOOL_NAME}/bash/read` : "bash/read";
  const compactAccessRule = hasContextStore
    ? `- Prefer ${CTX_TOOL_NAME} grep/peek or bash pipelines (rg/head/tail/wc/jq/python) over full reads.`
    : `- Prefer compact bash pipelines (rg/head/tail/wc/jq/python) over full reads.`;

  return `Recursive Pi child RLM. Depth ${depth}/${state.maxDepth}. Calls ${state.budget.calls}/${state.budget.maxCalls}. Queries ${state.budget.queries}/${state.budget.maxQueries}.

You are a child RLM sub-call. Pi's ${REPL_TOOL_NAME} is your programmable control plane; bash/read are focused inspection tools. When a file-backed context store is provided, the large context is outside your chat; inspect it through ${inspectTools} or ${REPL_TOOL_NAME}'s ctx helper and only bring compact observations back.

Tools:
- ${REPL_TOOL_NAME}: Python REPL with persistent globals/state, bash/read helpers, ctx helper when available, llm_query/rlm_query functions, FINAL/FINAL_VAR.
- bash: run commands, search, transform. Prefer compact outputs.
- read: read file contents directly; avoid on large files unless reading a small anchored section.
${ctxTool}
- ${RLM_TOOL_NAME}({ call:"llm_query", prompt }): RLM's llm_query(). Single-shot LM completion, NO tools. Include all relevant context inline.
- ${RLM_TOOL_NAME}({ call:"llm_query_batched", prompts/items }): RLM's llm_query_batched(). Batched one-shot LM completions.
- ${RLM_TOOL_NAME}({ call:"rlm_query", prompt, paths?, sources?, contextName?, contextMode? }): recursive child RLM sub-call.
- ${RLM_TOOL_NAME}({ call:"rlm_query_batched", prompts/items, paths?, sources?, contextName?, contextMode? }): batched recursive child RLM sub-calls.
- ${RETURN_TOOL_NAME}: FINAL(). Call exactly once when done.

The Pi-native RLM pattern:
1. Use ${REPL_TOOL_NAME} when you need loops, batches, state, or synthesis.
2. Inspect context externally: use ${inspectTools}, ${REPL_TOOL_NAME}'s bash/read helpers, or ctx.grep/peek to extract only relevant text.
3. Store intermediate state in REPL state or under the provided scratch dir when available.
4. Use llm_query/llm_query_batched for one-shot reasoning over extracted text.
5. Use rlm_query/rlm_query_batched only when a sub-call needs its own bash/read/context-store session.
6. Synthesize results and call ${RETURN_TOOL_NAME} or FINAL(...) in ${REPL_TOOL_NAME}.

Rules:
- The context problem matters: do NOT dump large context into chat. Print compact observations only.
${compactAccessRule}
- Prefer llm_query over rlm_query when you already have relevant text.
- Prefer batched calls for independent chunks/sub-calls.
- Writing temporary files under scratch is allowed. Do not modify project files unless explicitly allowed.
- If turn budget runs low, call ${RETURN_TOOL_NAME} with partial answer + remaining work. If you do not, the parent harness will abort at the hard cap and synthesize a checkpoint from your transcript.
- If a child returns incomplete, recurse narrower on uncovered parts.`;
}

export function childPrompt(prompt: string, context?: string, paths?: string[], store?: ContextStore): string {
  const ps = normPaths(paths);
  const pathBlock = store
    ? "(file-backed context store sources above; use ctx({action:\"manifest\"}) for inventory)"
    : ps.length ? ps.map((p) => `- ${p}`).join("\n") : "(none — use bash to discover if needed)";
  const ctxBlock = context?.trim() && !contextMaterialized(store) ? `\nInline context:\n${clip(context, MAX_INLINE_CHILD_CONTEXT_CHARS)}\n` : "";
  const storeBlock = store ? contextStorePromptBlock(store) : "";

  return `Prompt:\n${prompt}\n${ctxBlock}${storeBlock}\nPaths to inspect:\n${pathBlock}\n\nUse ${REPL_TOOL_NAME} for programmable orchestration (Python; call llm_query/rlm_query synchronously, persist state, FINAL when done). Use bash/read${store ? `/${CTX_TOOL_NAME}` : ""} for focused inspection, ${RLM_TOOL_NAME}(call:\"llm_query\"/\"llm_query_batched\") for one-shot sub-LM calls, ${RLM_TOOL_NAME}(call:\"rlm_query\"/\"rlm_query_batched\") for recursive child RLM sub-calls, and ${RETURN_TOOL_NAME} when done.`;
}

export function childToolList(allowWrites?: boolean, hasContextStore = false): string[] {
  const tools = ["bash", "read"];
  if (hasContextStore) tools.push(CTX_TOOL_NAME);
  tools.push(REPL_TOOL_NAME, RLM_TOOL_NAME, RETURN_TOOL_NAME);
  if (allowWrites) tools.push("edit", "write");
  return tools;
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
  params: { prompt: string; context?: string; contextMode?: ContextMode; paths?: string[]; sources?: Array<{ name?: string; path: string }>; contextName?: string; allowWrites?: boolean },
  depth: number,
  state: RunState,
  signal: AbortSignal | undefined,
  onUpdate: any,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Details }> {
  const contextMode = normalizeContextMode(params.contextMode);

  // RLM semantics: at max depth, rlm_query falls back to a plain LM leaf call.
  if (depth >= state.maxDepth) {
    return runLlmQuery(ctx, {
      prompt: leafPrompt(params.prompt, params.paths, params.sources),
      context: params.context,
      contextMode,
      paths: params.paths,
      sources: params.sources,
      contextName: params.contextName,
    }, state.budget, depth, state, signal, onUpdate, "rlm_query");
  }

  state.budget.calls++;
  if (state.budget.calls > state.budget.maxCalls) throw new Error(`Max recursive child RLM calls (${state.budget.maxCalls}).`);

  const model = resolveModel(ctx, state);
  if (!model) throw new Error("Cannot resolve current session model for RLM call.");

  const contextStore = await prepareContextStore(ctx.cwd, { ...params, contextMode });
  const hasContextStore = Boolean(contextStore);
  const tools = childToolList(params.allowWrites, hasContextStore);

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
        model: `${model.provider}/${model.id}`,
        prompt: params.prompt,
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
    const customTools: any[] = [createRlmTool(state, depth), createRlmReplTool(state, depth, contextStore), createReturnTool()];
    if (contextStore) customTools.splice(2, 0, createContextTool(ctx.cwd, contextStore));

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
        const ret = Array.isArray(ev.toolResults) && ev.toolResults.some((r: any) => r?.toolName === RETURN_TOOL_NAME);
        const more = ev.message?.stopReason === "toolUse" && !ret;
        if (turns >= state.maxTurns && more) {
          abortedByTurnLimit = true;
          emit(`depth ${depth}: turn budget reached; aborting child for deterministic parent-side finalization`);
          void session.abort();
        }
      }
    });

    if (signal?.aborted) kill();
    else signal?.addEventListener("abort", kill, { once: true });

    emit(`depth ${depth}: starting${contextStore ? ` with file-backed context (${contextStore.sources.length} source${contextStore.sources.length === 1 ? "" : "s"})` : ""}`);
    await session.prompt(childPrompt(params.prompt, params.context, params.paths, contextStore));

    let msgs = [...(session.messages as any[])];
    let completed = hasReturn(msgs);
    let deterministicFinalized = false;
    let deterministicFinalizationReason: string | undefined;
    let answer = "";

    if (completed) {
      answer = clip(extractAnswer(msgs));
    } else if (!signal?.aborted) {
      finalizationRequested = true;
      deterministicFinalized = true;
      deterministicFinalizationReason = abortedByTurnLimit ? `maxTurns=${state.maxTurns}` : `missing ${RETURN_TOOL_NAME}`;
      emit(`depth ${depth}: synthesizing deterministic final answer (${deterministicFinalizationReason})`);
      const synthesized = await runLlmQuery(ctx, {
        prompt: deterministicFinalPrompt(params.prompt, msgs, deterministicFinalizationReason),
        contextMode: "inline",
      }, state.budget, depth, state, signal, onUpdate, "rlm_query");
      answer = clip(textOf(synthesized.content).trim() || extractAnswer(msgs));
    } else {
      answer = clip(extractAnswer(msgs));
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
      model: `${model.provider}/${model.id}`,
      prompt: params.prompt,
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
          ? `\n\n[child ended without ${RETURN_TOOL_NAME}; synthesized checkpoint from transcript]`
          : `\n\n[child ended without ${RETURN_TOOL_NAME}; using last available text]`
        : "";
    return { content: [{ type: "text", text: `${answer}${note}` }], details };
  } finally {
    signal?.removeEventListener("abort", kill);
    unsub?.();
    session?.dispose();
    await cleanupContextStore(contextStore);
  }
}

