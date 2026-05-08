import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import { CTX_TOOL_NAME, MAX_INLINE_CHILD_CONTEXT_CHARS, RETURN_TOOL_NAME, RLM_TOOL_NAME } from "./constants.js";
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
  resolveModel,
  textOf,
  traceOf,
} from "./utils.js";

// ── Recursive child RLM: rlm_query ──────────────────────────────────

export function childSystemPrompt(depth: number, state: RunState, hasContextStore: boolean): string {
  const ctxTool = hasContextStore
    ? `- ${CTX_TOOL_NAME}: inspect file-backed context with capped outputs. Actions: manifest, grep, peek. Prefer this before raw bash/read on large sources.`
    : "";
  const inspectTools = hasContextStore ? `${CTX_TOOL_NAME}/bash/read` : "bash/read";
  const compactAccessRule = hasContextStore
    ? `- Prefer ${CTX_TOOL_NAME} grep/peek or bash pipelines (rg/head/tail/wc/jq/python) over full reads.`
    : `- Prefer compact bash pipelines (rg/head/tail/wc/jq/python) over full reads.`;

  return `Recursive Pi child RLM. Depth ${depth}/${state.maxDepth}. Calls ${state.budget.calls}/${state.budget.maxCalls}. Queries ${state.budget.queries}/${state.budget.maxQueries}.

You are a child RLM sub-call. Pi's bash/read tools are your REPL/toolkit. When a file-backed context store is provided, the large context is outside your chat; inspect it through ${inspectTools} and only bring compact observations back.

Tools:
- bash: run commands, search, transform. Your primary REPL/toolkit.
- read: read file contents directly; avoid on large files unless reading a small anchored section.
${ctxTool}
- ${RLM_TOOL_NAME}({ call:"llm_query", prompt }): RLM's llm_query(). Single-shot LM completion, NO tools. Include all relevant context inline.
- ${RLM_TOOL_NAME}({ call:"llm_query_batched", prompts/items }): RLM's llm_query_batched(). Batched one-shot LM completions.
- ${RLM_TOOL_NAME}({ call:"rlm_query", prompt, paths?, contextMode? }): recursive child RLM sub-call.
- ${RLM_TOOL_NAME}({ call:"rlm_query_batched", prompts/items, paths?, contextMode? }): batched recursive child RLM sub-calls.
- ${RETURN_TOOL_NAME}: FINAL(). Call exactly once when done.

The Pi-native RLM pattern:
1. Inspect context externally: use ${inspectTools} to peek, grep, count, and extract only relevant text.
2. Store intermediate state under the provided scratch dir when available.
3. Use rlm(call:"llm_query"/"llm_query_batched") for one-shot reasoning over extracted text.
4. Use rlm(call:"rlm_query"/"rlm_query_batched") only when a sub-call needs its own bash/read/context-store session.
5. Synthesize results and call ${RETURN_TOOL_NAME}.

Rules:
- The context problem matters: do NOT dump large context into chat. Print compact observations only.
${compactAccessRule}
- Prefer llm_query over rlm_query when you already have relevant text.
- Prefer batched calls for independent chunks/sub-calls.
- Writing temporary files under scratch is allowed. Do not modify project files unless explicitly allowed.
- If turn budget runs low, call ${RETURN_TOOL_NAME} with partial answer + remaining work.
- If a child returns incomplete, recurse narrower on uncovered parts.`;
}

export function childPrompt(prompt: string, context?: string, paths?: string[], store?: ContextStore): string {
  const ps = normPaths(paths);
  const pathBlock = store
    ? "(file-backed context store sources above; use ctx({action:\"manifest\"}) for inventory)"
    : ps.length ? ps.map((p) => `- ${p}`).join("\n") : "(none — use bash to discover if needed)";
  const ctxBlock = context?.trim() && !contextMaterialized(store) ? `\nInline context:\n${clip(context, MAX_INLINE_CHILD_CONTEXT_CHARS)}\n` : "";
  const storeBlock = store ? contextStorePromptBlock(store) : "";

  return `Prompt:\n${prompt}\n${ctxBlock}${storeBlock}\nPaths to inspect:\n${pathBlock}\n\nUse bash/read${store ? `/${CTX_TOOL_NAME}` : ""} as the REPL/toolkit, rlm(call:\"llm_query\"/\"llm_query_batched\") for one-shot sub-LM calls, rlm(call:\"rlm_query\"/\"rlm_query_batched\") for recursive child RLM sub-calls, and ${RETURN_TOOL_NAME} when done.`;
}

export function childToolList(allowWrites?: boolean, hasContextStore = false): string[] {
  const tools = ["bash", "read"];
  if (hasContextStore) tools.push(CTX_TOOL_NAME);
  tools.push(RLM_TOOL_NAME, RETURN_TOOL_NAME);
  if (allowWrites) tools.push("edit", "write");
  return tools;
}

export async function runRlmQuery(
  ctx: ExtensionContext,
  params: { prompt: string; context?: string; contextMode?: ContextMode; paths?: string[]; allowWrites?: boolean },
  depth: number,
  state: RunState,
  signal: AbortSignal | undefined,
  onUpdate: any,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Details }> {
  const contextMode = normalizeContextMode(params.contextMode);

  // RLM semantics: at max depth, rlm_query falls back to a plain LM leaf call.
  if (depth >= state.maxDepth) {
    return runLlmQuery(ctx, {
      prompt: leafPrompt(params.prompt, params.paths),
      context: params.context,
      contextMode,
      paths: params.paths,
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

    const customTools: any[] = [createRlmTool(state, depth), createReturnTool()];
    if (contextStore) customTools.splice(1, 0, createContextTool(ctx.cwd, contextStore));

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
          if (!finalizationRequested) {
            finalizationRequested = true;
            emit(`depth ${depth}: turn budget reached; requesting ${RETURN_TOOL_NAME}`);
            void session
              .steer(
                `Turn budget reached (${state.maxTurns}). Stop exploring. Call ${RETURN_TOOL_NAME} NOW with your best partial answer and list what remains unchecked.`,
              )
              .catch(() => {
                abortedByTurnLimit = true;
                void session.abort();
              });
          } else {
            abortedByTurnLimit = true;
            void session.abort();
          }
        }
      }
    });

    if (signal?.aborted) kill();
    else signal?.addEventListener("abort", kill, { once: true });

    emit(`depth ${depth}: starting${contextStore ? ` with file-backed context (${contextStore.sources.length} source${contextStore.sources.length === 1 ? "" : "s"})` : ""}`);
    await session.prompt(childPrompt(params.prompt, params.context, params.paths, contextStore));

    let msgs = [...(session.messages as any[])];
    let completed = hasReturn(msgs);

    if (!completed && !abortedByTurnLimit && !signal?.aborted) {
      finalizationRequested = true;
      emit(`depth ${depth}: forcing ${RETURN_TOOL_NAME}`);
      await session.prompt(
        `You ended without calling ${RETURN_TOOL_NAME}. Call ${RETURN_TOOL_NAME} now with your best answer.`,
      );
      msgs = [...(session.messages as any[])];
      completed = hasReturn(msgs);
    }

    const answer = clip(extractAnswer(msgs));
    const incomplete = abortedByTurnLimit || !completed;
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
      contextMode,
      scratchDir: contextStore?.scratchDir,
      contextSources: sourceSummaries,
      answer,
      trace: traceOf(msgs),
      completedWithReturn: completed,
      finalizationRequested,
      abortedByTurnLimit,
      incomplete,
    };

    const note = abortedByTurnLimit
      ? `\n\n[stopped after maxTurns=${state.maxTurns}; result may be partial]`
      : !completed
        ? `\n\n[child ended without ${RETURN_TOOL_NAME}; using last available text]`
        : "";
    return { content: [{ type: "text", text: `${answer}${note}` }], details };
  } finally {
    signal?.removeEventListener("abort", kill);
    unsub?.();
    session?.dispose();
    await cleanupContextStore(contextStore);
  }
}

