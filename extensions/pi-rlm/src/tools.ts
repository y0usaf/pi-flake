import { defineTool } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { CTX_ACTIONS, CTX_TOOL_NAME, MAX_CTX_OUTPUT_CHARS, RETURN_TOOL_NAME, RLM_TOOL_NAME } from "./constants.js";
import type { ContextStore, CtxAction, Details, RunState } from "./constants.js";
import { CtxParams, ReturnParams, RlmParams } from "./params.js";
import { ctxGrep, ctxManifest, ctxPeek, contextSourceSummary } from "./context-store.js";
import { runBatch } from "./batch.js";
import { runLlmQuery } from "./llm.js";
import { runRlmQuery } from "./child-session.js";
import {
  childDepth,
  clip,
  currentDepth,
  normalizeCall,
  rejectUnknownParams,
  singleItemFromParams,
  stateFor,
  textOf,
} from "./utils.js";

// ── Tool definitions ────────────────────────────────────────────────

export function createContextTool(cwd: string, store: ContextStore) {
  return defineTool({
    name: CTX_TOOL_NAME,
    label: "RLM Context",
    description: "Inspect the file-backed RLM context store with capped outputs. Use manifest, grep, and peek to avoid dumping large context into chat.",
    promptSnippet: "Inspect file-backed RLM context with capped manifest/grep/peek",
    promptGuidelines: [
      `${CTX_TOOL_NAME}({ action:"manifest" }): list context sources, manifest path, and scratch dir.`,
      `${CTX_TOOL_NAME}({ action:"grep", query:"...", source?, maxMatches? }): search context with capped matches. Prefer before peeking.`,
      `${CTX_TOOL_NAME}({ action:"peek", source:"s0", chars?:4000, offset?:0 }): read a capped slice from one source.`,
      `Never use ${CTX_TOOL_NAME} to dump large context. Store intermediate artifacts under ${store.scratchDir}.`,
    ],
    parameters: CtxParams,
    async execute(_id, params) {
      const action = params.action as CtxAction;
      if (!CTX_ACTIONS.includes(action)) throw new Error(`Unknown ctx action: ${String(params.action)}.`);

      const text = action === "manifest"
        ? await ctxManifest(store)
        : action === "peek"
          ? await ctxPeek(cwd, store, params)
          : await ctxGrep(cwd, store, params);

      return {
        content: [{ type: "text", text: clip(text, MAX_CTX_OUTPUT_CHARS) }],
        details: {
          action,
          source: typeof params.source === "string" ? params.source : undefined,
          query: typeof params.query === "string" ? params.query : undefined,
          scratchDir: store.scratchDir,
          sources: store.sources.map(contextSourceSummary),
        },
      };
    },
    renderCall(args, theme) {
      const action = typeof args?.action === "string" ? args.action : "...";
      const extra = typeof args?.query === "string"
        ? ` ${JSON.stringify(args.query)}`
        : typeof args?.source === "string"
          ? ` ${args.source}`
          : "";
      return new Text(`${theme.fg("toolTitle", theme.bold(CTX_TOOL_NAME))} ${theme.fg("muted", action + extra)}`, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const text = textOf(result.content).trim();
      if (isPartial) return new Text(theme.fg("warning", text || "running..."), 0, 0);
      return new Text(theme.fg("success", "✓ ") + theme.fg("toolOutput", clip(text.replace(/\s+/g, " "), 700)), 0, 0);
    },
  });
}

export function createReturnTool() {
  return defineTool({
    name: RETURN_TOOL_NAME,
    label: "Pi Return",
    description: "Return the final answer from a recursive Pi child RLM. Equivalent to FINAL(...). Call exactly once as the last action.",
    promptSnippet: "Return final answer from recursive Pi child RLM (FINAL)",
    promptGuidelines: [
      `Use ${RETURN_TOOL_NAME} as the final action in recursive Pi child RLM sessions.`,
      `After calling ${RETURN_TOOL_NAME}, do not emit another response.`,
    ],
    parameters: ReturnParams,
    async execute(_id, params) {
      return {
        content: [{ type: "text", text: params.answer }],
        details: { answer: params.answer },
        terminate: true,
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold(RETURN_TOOL_NAME)), 0, 0);
    },
    renderResult(result, _opts, theme) {
      return new Text(theme.fg("success", "✓ ") + clip(textOf(result.content).trim(), 1_000), 0, 0);
    },
  });
}

export function renderRlmCall(args: any, theme: any) {
  const call = normalizeCall(args?.call);
  const prompt = typeof args.prompt === "string"
    ? args.prompt
    : Array.isArray(args.prompts)
      ? `${args.prompts.length} prompts`
      : Array.isArray(args.items)
        ? `${args.items.length} items`
        : "...";
  const clean = prompt.replace(/\s+/g, " ").trim();
  const tag = call.endsWith("batched") ? theme.fg("accent", `[${call}]`) : theme.fg("muted", `[${call}]`);
  return new Text(
    `${theme.fg("toolTitle", theme.bold(RLM_TOOL_NAME))} ${tag} ${theme.fg("dim", clip(clean, 100))}`,
    0,
    0,
  );
}

export function renderRlmResult(result: any, { expanded, isPartial }: any, theme: any) {
  const d = result.details as Details | undefined;
  const text = textOf(result.content).trim();
  if (isPartial) return new Text(theme.fg("warning", text || "running..."), 0, 0);
  if (!d) return new Text(text, 0, 0);

  const tag = d.batch
    ? `${d.call} ${d.batchSize ?? 0}x`
    : d.kind === "llm"
      ? d.call
      : `${d.call} d${d.depth} ${d.turns}t`;
  const budget = d.kind === "llm"
    ? `q${d.queriesUsed}/${d.maxQueries}`
    : `calls ${d.callsUsed}/${d.maxCalls} q${d.queriesUsed}/${d.maxQueries}`;
  const incomplete = d.incomplete ? theme.fg("warning", " partial") : "";
  const header = `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold(tag))}${incomplete} ${theme.fg("muted", budget + " " + d.model)}`;

  if (!expanded) return new Text(`${header}\n${theme.fg("toolOutput", clip(text.replace(/\s+/g, " "), 500))}`, 0, 0);

  const trace = d.trace?.map((e) => {
    const label = e.toolName ? `${e.role}:${e.toolName}` : e.role;
    return `- ${label}: ${e.text}`;
  }).join("\n") || "";

  const batch = d.results?.length
    ? `\n\n${theme.fg("muted", "Batch:")}\n${d.results.map((r, i) => `- ${i + 1}. ${r.incomplete ? "partial " : ""}${r.call} ${r.model}: ${clip((r.answer || "").replace(/\s+/g, " "), 160)}`).join("\n")}`
    : "";
  const contextInfo = d.contextSources?.length
    ? `\n\n${theme.fg("muted", "Context store:")} ${d.contextMode ?? "auto"}${d.scratchDir ? ` scratch=${d.scratchDir}` : ""}\n${d.contextSources.map((s) => `- ${s}`).join("\n")}`
    : "";

  return new Text(
    `${header}\n\n${theme.fg("muted", "Prompt:")} ${d.prompt}\n\n${theme.fg("muted", "Answer:")}\n${text}${contextInfo}${batch}${trace ? `\n\n${theme.fg("muted", "Trace:")}\n${trace}` : ""}`,
    0,
    0,
  );
}

export function createRlmTool(inherited?: RunState, parentDepth?: number) {
  return defineTool({
    name: RLM_TOOL_NAME,
    label: "RLM",
    description:
      'One Pi-native RLM primitive. call:"llm_query" = one-shot LM, call:"llm_query_batched" = batched one-shot LMs, call:"rlm_query" = recursive child RLM with file-backed context, call:"rlm_query_batched" = batched recursive child RLMs.',
    promptSnippet: 'RLM call dispatcher: llm_query / llm_query_batched / rlm_query / rlm_query_batched',
    promptGuidelines: [
      `${RLM_TOOL_NAME}({ call:"llm_query", prompt }): one-shot completion. No tools. Include ALL context inline.`,
      `${RLM_TOOL_NAME}({ call:"llm_query_batched", prompts/items }): batched one-shot completions for independent chunks.`,
      `${RLM_TOOL_NAME}({ call:"rlm_query", prompt, paths?, context?, contextMode? }): child RLM with bash/read plus a ${CTX_TOOL_NAME} context tool when paths or large/file_backed context are supplied.`,
      `${RLM_TOOL_NAME}({ call:"rlm_query_batched", prompts/items, paths?, contextMode? }): batched child RLMs for independent sub-calls.`,
      `For large context, prefer paths or contextMode:"file_backed" so the child sees a manifest + ${CTX_TOOL_NAME}, not the whole text in chat.`,
      `Prefer llm_query over rlm_query when you already have small relevant text. Prefer batched calls for independent chunks/sub-calls.`,
    ],
    parameters: RlmParams,
    async execute(_id, params, signal, onUpdate, ctx) {
      rejectUnknownParams(params);
      const state = stateFor(params, inherited, ctx.model);
      const call = normalizeCall(params.call);

      if (call === "llm_query") {
        return runLlmQuery(ctx, singleItemFromParams(params), state.budget, currentDepth(parentDepth), state, signal, onUpdate, "llm_query");
      }
      if (call === "llm_query_batched") {
        return runBatch(ctx, params, "llm_query_batched", currentDepth(parentDepth), state, signal, onUpdate);
      }
      if (call === "rlm_query") {
        return runRlmQuery(ctx, singleItemFromParams(params), childDepth(parentDepth), state, signal, onUpdate);
      }
      return runBatch(ctx, params, "rlm_query_batched", childDepth(parentDepth), state, signal, onUpdate);
    },
    renderCall(args, theme) {
      return renderRlmCall(args, theme);
    },
    renderResult: renderRlmResult,
  });
}

