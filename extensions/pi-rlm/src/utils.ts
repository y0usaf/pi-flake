import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
  CONTEXT_MODES,
  DEFAULT_MAX_CALLS,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_QUERIES,
  DEFAULT_MAX_TURNS,
  HARD_MAX_CALLS,
  HARD_MAX_DEPTH,
  HARD_MAX_QUERIES,
  HARD_MAX_TURNS,
  MAX_RESULT_CHARS,
  MAX_TRACE_TEXT_CHARS,
  RETURN_TOOL_NAME,
  RLM_CALLS,
} from "./constants.js";
import type { BatchItem, ContextMode, Details, RlmCall, RunState } from "./constants.js";
import { RLM_ITEM_KEYS, RLM_PARAM_KEYS } from "./params.js";

export interface NamedSourceInput { name?: string; path: string }

// ── Helpers ─────────────────────────────────────────────────────────

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function rejectUnknownKeys(label: string, value: unknown, allowed: Set<string>): void {
  if (!isRecord(value)) return;
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported field(s): ${unknown.join(", ")}. This tool intentionally has no compatibility aliases.`);
  }
}

export function rejectUnknownParams(params: unknown): void {
  rejectUnknownKeys("rlm params", params, RLM_PARAM_KEYS);
}

export function rejectUnknownItem(item: unknown, index: number): void {
  rejectUnknownKeys(`rlm batch item ${index}`, item, RLM_ITEM_KEYS);
}

export function clamp(v: unknown, fallback: number, lo: number, hi: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, Math.trunc(v)));
}

export function clip(text: string, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated: ${text.length - max} chars omitted]`;
}

export function normPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  return [...new Set(
    paths.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim()),
  )];
}

export function normSources(sources: unknown): NamedSourceInput[] {
  if (!Array.isArray(sources)) return [];
  const out: NamedSourceInput[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    if (!isRecord(src) || typeof src.path !== "string" || !src.path.trim()) continue;
    const path = src.path.trim();
    const name = typeof src.name === "string" && src.name.trim() ? src.name.trim() : undefined;
    const key = `${name ?? ""}\0${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, path });
  }
  return out;
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (!isRecord(c)) continue;
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c.type === "thinking" && typeof c.thinking === "string") parts.push(c.thinking);
    else if (c.type === "image") parts.push("[image]");
    else if (c.type === "toolCall" && typeof c.name === "string") parts.push(`[toolCall:${c.name}]`);
  }
  return parts.join("\n");
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function hasReturn(messages: any[]): boolean {
  return messages.some(
    (m) => m?.role === "toolResult" && m.toolName === RETURN_TOOL_NAME && textOf(m.content).trim().length > 0,
  );
}

export function extractAnswer(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "toolResult" && m.toolName === RETURN_TOOL_NAME) {
      const t = textOf(m.content).trim();
      if (t) return t;
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") {
      const t = textOf(m.content).trim();
      if (t) return t;
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "toolResult") {
      const t = textOf(m.content).trim();
      if (t) return t;
    }
  }
  return "(no output)";
}

export function traceOf(messages: any[]) {
  return messages.map((m) => ({
    role: typeof m?.role === "string" ? m.role : "?",
    toolName: typeof m?.toolName === "string" ? m.toolName : undefined,
    text: clip(textOf(m?.content).replace(/\s+/g, " ").trim(), MAX_TRACE_TEXT_CHARS),
  }));
}

export function resolveModel(ctx: ExtensionContext, state: RunState) {
  if (!state.model) state.model = ctx.model;
  return state.model;
}

export function createRunState(params: any, model?: any): RunState {
  return {
    maxDepth: clamp(params?.maxDepth, DEFAULT_MAX_DEPTH, 1, HARD_MAX_DEPTH),
    maxTurns: clamp(params?.maxTurns, DEFAULT_MAX_TURNS, 1, HARD_MAX_TURNS),
    budget: {
      calls: 0,
      maxCalls: clamp(params?.maxCalls, DEFAULT_MAX_CALLS, 1, HARD_MAX_CALLS),
      queries: 0,
      maxQueries: clamp(params?.maxQueries, DEFAULT_MAX_QUERIES, 1, HARD_MAX_QUERIES),
    },
    model,
  };
}

export function stateFor(params: any, inherited?: RunState, model?: any): RunState {
  return inherited ?? createRunState(params, model);
}

export function currentDepth(parentDepth?: number): number {
  return parentDepth ?? 0;
}

export function childDepth(parentDepth?: number): number {
  return (parentDepth ?? 0) + 1;
}

export function requiredPrompt(params: any): string {
  if (typeof params?.prompt !== "string" || !params.prompt.trim()) {
    throw new Error("Missing required prompt.");
  }
  return params.prompt;
}

export function normalizeCall(raw: unknown): RlmCall {
  if (RLM_CALLS.includes(raw as RlmCall)) return raw as RlmCall;
  throw new Error(`Unknown RLM call: ${String(raw)}. Expected one of: ${RLM_CALLS.join(", ")}.`);
}

export function normalizeContextMode(raw: unknown): ContextMode {
  if (raw === undefined || raw === null || raw === "") return "auto";
  if (CONTEXT_MODES.includes(raw as ContextMode)) return raw as ContextMode;
  throw new Error(`Unknown contextMode: ${String(raw)}. Expected one of: ${CONTEXT_MODES.join(", ")}.`);
}

export function rejectPathsForLlm(call: RlmCall, paths: unknown, contextMode?: unknown, sources?: unknown): void {
  if (call !== "llm_query" && call !== "llm_query_batched") return;
  if (normPaths(paths).length > 0 || normSources(sources).length > 0) {
    throw new Error(`${call} has no bash/read/ctx access and cannot consume paths/sources. Extract text first, pass it as context/prompt, or use rlm_query.`);
  }
  if (normalizeContextMode(contextMode) === "file_backed") {
    throw new Error(`${call} has no environment and cannot use contextMode:"file_backed". Use inline context or rlm_query.`);
  }
}

export function singleItemFromParams(params: any): BatchItem {
  const call = normalizeCall(params?.call);
  const contextMode = normalizeContextMode(params?.contextMode);
  rejectPathsForLlm(call, params?.paths, contextMode, params?.sources);
  return {
    prompt: requiredPrompt(params),
    context: typeof params?.context === "string" ? params.context : undefined,
    contextMode,
    paths: normPaths(params?.paths),
    sources: normSources(params?.sources),
    contextName: typeof params?.contextName === "string" ? params.contextName : undefined,
    allowWrites: params?.allowWrites === true,
  };
}

export function batchItemsFromParams(params: any, call: RlmCall): BatchItem[] {
  const sharedContextMode = normalizeContextMode(params?.contextMode);
  rejectPathsForLlm(call, params?.paths, sharedContextMode, params?.sources);
  const shared = {
    context: typeof params?.context === "string" ? params.context : undefined,
    contextMode: sharedContextMode,
    paths: normPaths(params?.paths),
    sources: normSources(params?.sources),
    contextName: typeof params?.contextName === "string" ? params.contextName : undefined,
    allowWrites: params?.allowWrites === true,
  };

  if (Array.isArray(params?.items) && params.items.length > 0) {
    return params.items.map((item: any, index: number) => {
      rejectUnknownItem(item, index);
      if (typeof item?.prompt !== "string" || !item.prompt.trim()) {
        throw new Error(`Batch item ${index} missing required prompt.`);
      }
      const contextMode = normalizeContextMode(item?.contextMode ?? shared.contextMode);
      rejectPathsForLlm(call, item?.paths, contextMode, item?.sources);
      const itemPaths = normPaths(item?.paths);
      const itemSources = normSources(item?.sources);
      return {
        prompt: item.prompt,
        context: typeof item?.context === "string" ? item.context : shared.context,
        contextMode,
        paths: itemPaths.length ? itemPaths : shared.paths,
        sources: itemSources.length ? itemSources : shared.sources,
        contextName: typeof item?.contextName === "string" ? item.contextName : shared.contextName,
        allowWrites: typeof item?.allowWrites === "boolean" ? item.allowWrites : shared.allowWrites,
      };
    });
  }

  if (Array.isArray(params?.prompts) && params.prompts.length > 0) {
    return params.prompts.map((prompt: unknown, index: number) => {
      if (typeof prompt !== "string" || !prompt.trim()) throw new Error(`Prompt ${index} must be a non-empty string.`);
      return { prompt, ...shared };
    });
  }

  throw new Error(`${call} requires prompts or items.`);
}


export async function runLimited<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function modelNameFromDetails(details: Details[]): string {
  const names = [...new Set(details.map((d) => d.model).filter(Boolean))];
  if (names.length === 0) return "unknown";
  if (names.length === 1) return names[0];
  return `mixed(${names.length})`;
}

export function uniquePathsFromDetails(details: Details[]): string[] {
  return [...new Set(details.flatMap((d) => d.paths || []))];
}

export function uniqueSourcesFromDetails(details: Details[]): NamedSourceInput[] {
  return normSources(details.flatMap((d) => d.sources || []));
}

export function leafPrompt(prompt: string, paths?: string[], sources?: unknown): string {
  const ps = normPaths(paths);
  const ss = normSources(sources);
  if (!ps.length && !ss.length) return prompt;
  const lines = [
    `${prompt}\n`,
    "Note: max RLM depth reached; this is a plain llm_query leaf call with no bash/read/ctx access.",
  ];
  if (ps.length) lines.push("Paths requested by parent (not directly readable in this call):", ...ps.map((p) => `- ${p}`));
  if (ss.length) lines.push("Sources requested by parent (not directly readable in this call):", ...ss.map((s) => `- ${s.name ? `${s.name}: ` : ""}${s.path}`));
  return lines.join("\n");
}

