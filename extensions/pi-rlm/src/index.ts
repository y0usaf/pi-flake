/**
 * pi-rlm — Pi-native RLM (Recursive Language Model) extension.
 *
 * One recursion tool:
 *   rlm({ call, prompt?, prompts?, items?, context?, paths?, ... })
 *
 * Supported RLM calls:
 *   call:"llm_query"            → single-shot completeSimple(), no tools.
 *   call:"llm_query_batched"    → many llm_query calls, bounded concurrency.
 *   call:"rlm_query"            → child Pi session with bash/read as REPL/toolkit.
 *   call:"rlm_query_batched"    → many recursive child RLM sub-calls, bounded concurrency.
 *
 * One child-only finalization tool:
 *   pi_return({ answer })        → FINAL(). Terminates the child.
 *
 * Pi's filesystem + scratch workspace are the external context store; bash/read/edit/write
 * are the Pi-native REPL/toolkit.
 */

import { createReadStream, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { completeSimple, StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_CALLS = 32;
const DEFAULT_MAX_QUERIES = 64;
const DEFAULT_MAX_CONCURRENT = 4;

const HARD_MAX_DEPTH = 8;
const HARD_MAX_TURNS = 80;
const HARD_MAX_CALLS = 128;
const HARD_MAX_QUERIES = 256;
const HARD_MAX_CONCURRENT = 32;

const MAX_RESULT_CHARS = 50_000;
const MAX_QUERY_CONTEXT_CHARS = 500_000;
const MAX_TRACE_TEXT_CHARS = 800;
const MAX_INLINE_CHILD_CONTEXT_CHARS = 20_000;
const MAX_CONTEXT_MANIFEST_CHARS = 30_000;
const MAX_CONTEXT_TREE_ENTRIES = 500;
const MAX_CONTEXT_TREE_DEPTH = 4;
const MAX_CTX_OUTPUT_CHARS = 20_000;
const DEFAULT_CTX_PEEK_CHARS = 4_000;
const HARD_CTX_PEEK_CHARS = 20_000;
const DEFAULT_CTX_GREP_MATCHES = 50;
const HARD_CTX_GREP_MATCHES = 200;
const MAX_CTX_GREP_FILES = 5_000;

const RLM_TOOL_NAME = "rlm";
const RETURN_TOOL_NAME = "pi_return";
const CTX_TOOL_NAME = "ctx";

const RLM_CALLS = ["llm_query", "llm_query_batched", "rlm_query", "rlm_query_batched"] as const;
type RlmCall = typeof RLM_CALLS[number];
type ExecutionKind = "llm" | "rlm";

const CONTEXT_MODES = ["auto", "inline", "file_backed"] as const;
type ContextMode = typeof CONTEXT_MODES[number];

const CTX_ACTIONS = ["manifest", "peek", "grep"] as const;
type CtxAction = typeof CTX_ACTIONS[number];

type ContextSourceKind = "inline" | "file" | "dir" | "missing" | "other";

interface ContextSource {
  id: string;
  label: string;
  input?: string;
  path: string;
  relPath: string;
  kind: ContextSourceKind;
  sizeBytes?: number;
  entries?: number;
  error?: string;
}

interface ContextStore {
  dir: string;
  scratchDir: string;
  manifestPath: string;
  manifestJsonPath: string;
  readmePath: string;
  manifestText: string;
  sources: ContextSource[];
}

interface Budget {
  calls: number;
  maxCalls: number;
  queries: number;
  maxQueries: number;
}

interface RunState {
  maxDepth: number;
  maxTurns: number;
  budget: Budget;
  /** The model of the parent Pi session that started this RLM run. No overrides. */
  model?: any;
}

interface BatchItem {
  prompt: string;
  context?: string;
  contextMode?: ContextMode;
  paths?: string[];
  allowWrites?: boolean;
}

interface Details {
  call: RlmCall;
  kind: ExecutionKind;
  depth: number;
  maxDepth: number;
  callsUsed: number;
  maxCalls: number;
  queriesUsed: number;
  maxQueries: number;
  turns: number;
  maxTurns: number;
  model: string;
  prompt: string;
  paths: string[];
  contextMode?: ContextMode;
  scratchDir?: string;
  contextSources?: string[];
  answer?: string;
  trace?: Array<{ role: string; toolName?: string; text: string }>;
  completedWithReturn?: boolean;
  finalizationRequested?: boolean;
  abortedByTurnLimit?: boolean;
  incomplete?: boolean;
  error?: string;
  batch?: boolean;
  batchSize?: number;
  maxConcurrent?: number;
  results?: Details[];
}

// ── Params ──────────────────────────────────────────────────────────

const LimitParams = {
  maxDepth: Type.Optional(Type.Number({ description: `Recursive depth cap. Default ${DEFAULT_MAX_DEPTH}. At the cap, rlm_query falls back to a plain LM call.` })),
  maxTurns: Type.Optional(Type.Number({ description: `Recursive child turn cap. Default ${DEFAULT_MAX_TURNS}.` })),
  maxCalls: Type.Optional(Type.Number({ description: `Total recursive child RLM calls across this run. Default ${DEFAULT_MAX_CALLS}.` })),
  maxQueries: Type.Optional(Type.Number({ description: `Total llm_query calls across this run. Default ${DEFAULT_MAX_QUERIES}.` })),
  maxConcurrent: Type.Optional(Type.Number({ description: `Batch concurrency cap. Default ${DEFAULT_MAX_CONCURRENT}.` })),
};

const ContextModeParam = Type.Optional(StringEnum(CONTEXT_MODES, {
  description:
    'Context handling for recursive RLM calls. "auto" keeps short inline context in chat but materializes large context into a temp file; paths are always file-backed. "inline" preserves old inline behavior for context. "file_backed" materializes context into the temp context store.',
}));

const RlmBatchItem = Type.Object({
  prompt: Type.String({ description: "Prompt for this batch item." }),
  context: Type.Optional(Type.String({ description: "Optional inline context for this item." })),
  contextMode: ContextModeParam,
  paths: Type.Optional(Type.Array(Type.String(), { description: "Paths for this child RLM to inspect. Used by rlm_query_batched only. Paths are file-backed context sources." })),
  allowWrites: Type.Optional(Type.Boolean({ description: "Also give this child edit/write tools. Used by rlm_query_batched only." })),
});

const RlmParams = Type.Object({
  call: StringEnum(RLM_CALLS, {
    description:
      'RLM call to run: "llm_query", "llm_query_batched", "rlm_query", or "rlm_query_batched".',
  }),
  prompt: Type.Optional(Type.String({ description: "Prompt for llm_query or rlm_query." })),
  context: Type.Optional(
    Type.String({ description: "Optional context. For llm_query this is inlined. For recursive RLM calls, large context is materialized into the file-backed context store when contextMode='auto' or 'file_backed'." }),
  ),
  contextMode: ContextModeParam,
  paths: Type.Optional(
    Type.Array(Type.String(), { description: "Paths for rlm_query/rlm_query_batched children to inspect via ctx/bash/read. Not accepted for llm_query calls. Paths are kept outside chat as file-backed context." }),
  ),
  prompts: Type.Optional(
    Type.Array(Type.String(), { description: "Prompts for batched calls. Shared context/paths apply to each item." }),
  ),
  items: Type.Optional(
    Type.Array(RlmBatchItem, { description: "Structured batch items with per-item prompt/context/contextMode/paths." }),
  ),
  allowWrites: Type.Optional(
    Type.Boolean({ description: "Recursive child RLM calls: also give edit/write tools. Default false. Temporary scratch writes are always allowed inside the RLM context store." }),
  ),
  ...LimitParams,
});

const ReturnParams = Type.Object({
  answer: Type.String({ description: "Final answer for this recursive Pi child RLM." }),
});

const CtxParams = Type.Object({
  action: StringEnum(CTX_ACTIONS, {
    description: 'Context-store action: "manifest" returns source metadata, "peek" returns a capped slice, "grep" searches sources with capped matches.',
  }),
  source: Type.Optional(Type.String({ description: "Optional source id/name/path, e.g. s0, s1, docs/. Omit for all sources on grep or first source on peek." })),
  query: Type.Optional(Type.String({ description: "Search query for action='grep'. Plain substring by default; set regex=true for regular expressions." })),
  regex: Type.Optional(Type.Boolean({ description: "Treat query as a JavaScript regular expression for grep. Default false." })),
  caseSensitive: Type.Optional(Type.Boolean({ description: "Case-sensitive grep. Default false." })),
  chars: Type.Optional(Type.Number({ description: `Max bytes for peek output. Default ${DEFAULT_CTX_PEEK_CHARS}, hard cap ${HARD_CTX_PEEK_CHARS}.` })),
  offset: Type.Optional(Type.Number({ description: "Byte offset for peek. Default 0." })),
  maxMatches: Type.Optional(Type.Number({ description: `Max grep matches. Default ${DEFAULT_CTX_GREP_MATCHES}, hard cap ${HARD_CTX_GREP_MATCHES}.` })),
});

const RLM_PARAM_KEYS = new Set([
  "call",
  "prompt",
  "context",
  "contextMode",
  "paths",
  "prompts",
  "items",
  "allowWrites",
  "maxDepth",
  "maxTurns",
  "maxCalls",
  "maxQueries",
  "maxConcurrent",
]);

const RLM_ITEM_KEYS = new Set(["prompt", "context", "contextMode", "paths", "allowWrites"]);

// ── Helpers ─────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function rejectUnknownKeys(label: string, value: unknown, allowed: Set<string>): void {
  if (!isRecord(value)) return;
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported field(s): ${unknown.join(", ")}. This tool intentionally has no compatibility aliases.`);
  }
}

function rejectUnknownParams(params: unknown): void {
  rejectUnknownKeys("rlm params", params, RLM_PARAM_KEYS);
}

function rejectUnknownItem(item: unknown, index: number): void {
  rejectUnknownKeys(`rlm batch item ${index}`, item, RLM_ITEM_KEYS);
}

function clamp(v: unknown, fallback: number, lo: number, hi: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, Math.trunc(v)));
}

function clip(text: string, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated: ${text.length - max} chars omitted]`;
}

function normPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  return [...new Set(
    paths.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim()),
  )];
}

function textOf(content: unknown): string {
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

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function hasReturn(messages: any[]): boolean {
  return messages.some(
    (m) => m?.role === "toolResult" && m.toolName === RETURN_TOOL_NAME && textOf(m.content).trim().length > 0,
  );
}

function extractAnswer(messages: any[]): string {
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

function traceOf(messages: any[]) {
  return messages.map((m) => ({
    role: typeof m?.role === "string" ? m.role : "?",
    toolName: typeof m?.toolName === "string" ? m.toolName : undefined,
    text: clip(textOf(m?.content).replace(/\s+/g, " ").trim(), MAX_TRACE_TEXT_CHARS),
  }));
}

function resolveModel(ctx: ExtensionContext, state: RunState) {
  if (!state.model) state.model = ctx.model;
  return state.model;
}

function createRunState(params: any, model?: any): RunState {
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

function stateFor(params: any, inherited?: RunState, model?: any): RunState {
  return inherited ?? createRunState(params, model);
}

function currentDepth(parentDepth?: number): number {
  return parentDepth ?? 0;
}

function childDepth(parentDepth?: number): number {
  return (parentDepth ?? 0) + 1;
}

function requiredPrompt(params: any): string {
  if (typeof params?.prompt !== "string" || !params.prompt.trim()) {
    throw new Error("Missing required prompt.");
  }
  return params.prompt;
}

function normalizeCall(raw: unknown): RlmCall {
  if (RLM_CALLS.includes(raw as RlmCall)) return raw as RlmCall;
  throw new Error(`Unknown RLM call: ${String(raw)}. Expected one of: ${RLM_CALLS.join(", ")}.`);
}

function normalizeContextMode(raw: unknown): ContextMode {
  if (raw === undefined || raw === null || raw === "") return "auto";
  if (CONTEXT_MODES.includes(raw as ContextMode)) return raw as ContextMode;
  throw new Error(`Unknown contextMode: ${String(raw)}. Expected one of: ${CONTEXT_MODES.join(", ")}.`);
}

function rejectPathsForLlm(call: RlmCall, paths: unknown, contextMode?: unknown): void {
  if (call !== "llm_query" && call !== "llm_query_batched") return;
  if (normPaths(paths).length > 0) {
    throw new Error(`${call} has no bash/read/ctx access and cannot consume paths. Extract text first, pass it as context/prompt, or use rlm_query.`);
  }
  if (normalizeContextMode(contextMode) === "file_backed") {
    throw new Error(`${call} has no environment and cannot use contextMode:"file_backed". Use inline context or rlm_query.`);
  }
}

function singleItemFromParams(params: any): BatchItem {
  const call = normalizeCall(params?.call);
  const contextMode = normalizeContextMode(params?.contextMode);
  rejectPathsForLlm(call, params?.paths, contextMode);
  return {
    prompt: requiredPrompt(params),
    context: typeof params?.context === "string" ? params.context : undefined,
    contextMode,
    paths: normPaths(params?.paths),
    allowWrites: params?.allowWrites === true,
  };
}

function batchItemsFromParams(params: any, call: RlmCall): BatchItem[] {
  const sharedContextMode = normalizeContextMode(params?.contextMode);
  rejectPathsForLlm(call, params?.paths, sharedContextMode);
  const shared = {
    context: typeof params?.context === "string" ? params.context : undefined,
    contextMode: sharedContextMode,
    paths: normPaths(params?.paths),
    allowWrites: params?.allowWrites === true,
  };

  if (Array.isArray(params?.items) && params.items.length > 0) {
    return params.items.map((item: any, index: number) => {
      rejectUnknownItem(item, index);
      if (typeof item?.prompt !== "string" || !item.prompt.trim()) {
        throw new Error(`Batch item ${index} missing required prompt.`);
      }
      const contextMode = normalizeContextMode(item?.contextMode ?? shared.contextMode);
      rejectPathsForLlm(call, item?.paths, contextMode);
      const itemPaths = normPaths(item?.paths);
      return {
        prompt: item.prompt,
        context: typeof item?.context === "string" ? item.context : shared.context,
        contextMode,
        paths: itemPaths.length ? itemPaths : shared.paths,
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


async function runLimited<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
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

function modelNameFromDetails(details: Details[]): string {
  const names = [...new Set(details.map((d) => d.model).filter(Boolean))];
  if (names.length === 0) return "unknown";
  if (names.length === 1) return names[0];
  return `mixed(${names.length})`;
}

function uniquePathsFromDetails(details: Details[]): string[] {
  return [...new Set(details.flatMap((d) => d.paths || []))];
}

function leafPrompt(prompt: string, paths?: string[]): string {
  const ps = normPaths(paths);
  if (!ps.length) return prompt;
  return `${prompt}\n\nNote: max RLM depth reached; this is a plain llm_query leaf call with no bash/read access. Paths requested by parent (not directly readable in this call):\n${ps.map((p) => `- ${p}`).join("\n")}`;
}

// ── File-backed context store ───────────────────────────────────────

function formatBytes(bytes?: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "? bytes";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function absPathFor(cwd: string, input: string): string {
  return path.isAbsolute(input) ? path.normalize(input) : path.resolve(cwd, input);
}

function relPathFor(cwd: string, abs: string): string {
  const rel = path.relative(cwd, abs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : abs;
}

function skipDirName(name: string): boolean {
  return new Set([".git", "node_modules", ".direnv", ".next", "dist", "build", "target", ".venv", "venv", "__pycache__"]).has(name);
}

async function statContextSource(cwd: string, input: string, id: string): Promise<ContextSource> {
  const abs = absPathFor(cwd, input);
  const relPath = relPathFor(cwd, abs);
  try {
    const st = await fs.lstat(abs);
    const kind: ContextSourceKind = st.isFile() ? "file" : st.isDirectory() ? "dir" : "other";
    return {
      id,
      label: input,
      input,
      path: abs,
      relPath,
      kind,
      sizeBytes: st.isFile() ? st.size : undefined,
    };
  } catch (e) {
    return {
      id,
      label: input,
      input,
      path: abs,
      relPath,
      kind: "missing",
      error: errorText(e),
    };
  }
}

async function collectTreeLines(cwd: string, abs: string, depth: number, state: { count: number; truncated: boolean }): Promise<string[]> {
  if (depth > MAX_CONTEXT_TREE_DEPTH || state.count >= MAX_CONTEXT_TREE_ENTRIES) {
    state.truncated = true;
    return [];
  }

  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch (e) {
    return [`${"  ".repeat(depth)}[cannot read ${relPathFor(cwd, abs)}: ${errorText(e)}]`];
  }

  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && skipDirName(entry.name)) continue;
    if (state.count >= MAX_CONTEXT_TREE_ENTRIES) {
      state.truncated = true;
      break;
    }
    state.count++;
    const child = path.join(abs, entry.name);
    const childRel = relPathFor(cwd, child);
    let size = "";
    try {
      const st = await fs.lstat(child);
      if (st.isFile()) size = ` ${formatBytes(st.size)}`;
    } catch {
      // ignore size failures in manifest preview
    }
    lines.push(`${"  ".repeat(depth)}- ${childRel}${entry.isDirectory() ? "/" : ""}${size}`);
    if (entry.isDirectory()) {
      if (depth + 1 <= MAX_CONTEXT_TREE_DEPTH) {
        lines.push(...await collectTreeLines(cwd, child, depth + 1, state));
      } else {
        state.truncated = true;
      }
    }
  }
  return lines;
}

function contextSourceSummary(source: ContextSource): string {
  const size = source.sizeBytes !== undefined ? `, ${formatBytes(source.sizeBytes)}` : "";
  const error = source.error ? `, error=${source.error}` : "";
  return `${source.id}: ${source.kind} ${source.label} -> ${source.relPath}${size}${error}`;
}

async function buildContextManifest(cwd: string, store: Omit<ContextStore, "manifestText">): Promise<string> {
  const lines: string[] = [
    "# RLM file-backed context manifest",
    "",
    `Context store: ${store.dir}`,
    `Scratch workspace: ${store.scratchDir}`,
    "",
    "Sources:",
    ...store.sources.map((s) => `- ${contextSourceSummary(s)}`),
    "",
    "Tree preview / file inventory (capped):",
  ];

  for (const source of store.sources) {
    lines.push("", `## ${source.id}: ${source.label}`);
    if (source.kind === "dir") {
      const state = { count: 0, truncated: false };
      lines.push(...await collectTreeLines(cwd, source.path, 0, state));
      if (state.truncated) lines.push(`[truncated tree after ${state.count} entries]`);
      source.entries = state.count;
    } else {
      lines.push(contextSourceSummary(source));
    }
  }

  return clip(lines.join("\n"), MAX_CONTEXT_MANIFEST_CHARS);
}

function contextStoreReadme(store: Omit<ContextStore, "manifestText">): string {
  return `# Pi RLM temporary context store

This directory is ephemeral and deleted after the child RLM returns.

- manifest.txt: capped source manifest / tree preview
- manifest.json: machine-readable source metadata
- scratch/: write intermediate artifacts here

Use compact observations only. Do not dump whole context files into chat.
Prefer ctx({ action:"manifest" }), ctx({ action:"grep", query:"..." }), and ctx({ action:"peek", source:"s0", chars:4000 }) before raw bash/read on large sources.

Sources:
${store.sources.map((s) => `- ${contextSourceSummary(s)}`).join("\n")}
`;
}

async function prepareContextStore(cwd: string, params: { context?: string; contextMode?: ContextMode; paths?: string[] }): Promise<ContextStore | undefined> {
  const mode = normalizeContextMode(params.contextMode);
  const paths = normPaths(params.paths);
  const context = typeof params.context === "string" ? params.context : "";
  const materializeContext = context.trim().length > 0 && (
    mode === "file_backed" || (mode === "auto" && context.length > MAX_INLINE_CHILD_CONTEXT_CHARS)
  );
  const needsStore = paths.length > 0 || materializeContext;
  if (!needsStore) return undefined;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-rlm-"));
  try {
    const scratchDir = path.join(dir, "scratch");
    await fs.mkdir(scratchDir, { recursive: true });

    const sources: ContextSource[] = [];
    if (materializeContext) {
      const contextPath = path.join(dir, "inline-context.txt");
      await fs.writeFile(contextPath, context, "utf8");
      sources.push({
        id: `s${sources.length}`,
        label: "inline context",
        path: contextPath,
        relPath: contextPath,
        kind: "inline",
        sizeBytes: Buffer.byteLength(context, "utf8"),
      });
    }

    for (const p of paths) {
      sources.push(await statContextSource(cwd, p, `s${sources.length}`));
    }

    const partial = {
      dir,
      scratchDir,
      manifestPath: path.join(dir, "manifest.txt"),
      manifestJsonPath: path.join(dir, "manifest.json"),
      readmePath: path.join(dir, "README.md"),
      sources,
    };
    const manifestText = await buildContextManifest(cwd, partial);
    const store: ContextStore = { ...partial, manifestText };

    await fs.writeFile(store.manifestPath, manifestText, "utf8");
    await fs.writeFile(store.manifestJsonPath, JSON.stringify({
      dir: store.dir,
      scratchDir: store.scratchDir,
      sources: store.sources,
    }, null, 2), "utf8");
    await fs.writeFile(store.readmePath, contextStoreReadme(store), "utf8");
    return store;
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}

async function cleanupContextStore(store?: ContextStore): Promise<void> {
  if (!store) return;
  await fs.rm(store.dir, { recursive: true, force: true }).catch(() => undefined);
}

function contextMaterialized(store?: ContextStore): boolean {
  return Boolean(store?.sources.some((s) => s.kind === "inline"));
}

function contextStorePromptBlock(store: ContextStore): string {
  return `
File-backed context store (external to chat):
- ${CTX_TOOL_NAME} tool available for capped manifest/peek/grep.
- Temp dir: ${store.dir}
- Scratch dir: ${store.scratchDir}
- Manifest: ${store.manifestPath}
- JSON manifest: ${store.manifestJsonPath}
- README: ${store.readmePath}

Sources:
${store.sources.map((s) => `- ${contextSourceSummary(s)}`).join("\n")}

Rules for this store:
- Treat these sources as the large context object. It is not copied into chat.
- Start with ${CTX_TOOL_NAME}({ action:"manifest" }) or compact bash commands (wc/find/head/rg/jq/python).
- Use ${CTX_TOOL_NAME}({ action:"grep", query:"..." }) to narrow before peeking.
- Use ${CTX_TOOL_NAME}({ action:"peek", source:"s0", chars:4000 }) for small slices only.
- Write intermediate artifacts only under the scratch dir. Scratch is deleted after ${RETURN_TOOL_NAME}; include needed findings in your final answer.
- Never cat/read/print a whole large source.
`;
}

function sourceMatches(source: ContextSource, selector: string): boolean {
  const s = selector.trim();
  return [source.id, source.label, source.input, source.path, source.relPath, path.basename(source.path)]
    .filter((v): v is string => Boolean(v))
    .some((v) => v === s || v.endsWith(s));
}

function selectContextSources(store: ContextStore, selector?: string): ContextSource[] {
  const readable = store.sources.filter((s) => s.kind === "inline" || s.kind === "file" || s.kind === "dir");
  if (!selector?.trim()) return readable;
  const selected = readable.filter((s) => sourceMatches(s, selector));
  if (!selected.length) throw new Error(`No context source matched ${JSON.stringify(selector)}. Use ctx({action:"manifest"}) to list sources.`);
  return selected;
}

async function collectFiles(source: ContextSource, state: { count: number; truncated: boolean }, out: string[] = []): Promise<string[]> {
  if (state.count >= MAX_CTX_GREP_FILES) {
    state.truncated = true;
    return out;
  }
  if (source.kind === "inline" || source.kind === "file") {
    out.push(source.path);
    state.count++;
    return out;
  }
  if (source.kind !== "dir") return out;

  let entries;
  try {
    entries = await fs.readdir(source.path, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isDirectory() && skipDirName(entry.name)) continue;
    const child = path.join(source.path, entry.name);
    if (entry.isDirectory()) {
      await collectFiles({ ...source, path: child, kind: "dir" }, state, out);
    } else if (entry.isFile()) {
      if (state.count >= MAX_CTX_GREP_FILES) {
        state.truncated = true;
        break;
      }
      out.push(child);
      state.count++;
    }
    if (state.truncated) break;
  }
  return out;
}

async function readFileSlice(file: string, bytes: number, offset: number): Promise<string> {
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, offset);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function ctxManifest(store: ContextStore): Promise<string> {
  return `${store.manifestText}\n\nManifest file: ${store.manifestPath}\nScratch dir: ${store.scratchDir}`;
}

async function ctxPeek(cwd: string, store: ContextStore, params: any): Promise<string> {
  const source = selectContextSources(store, typeof params.source === "string" ? params.source : undefined)[0];
  if (!source) throw new Error("No readable context sources.");
  const chars = clamp(params.chars, DEFAULT_CTX_PEEK_CHARS, 1, HARD_CTX_PEEK_CHARS);
  const offset = clamp(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  if (source.kind === "dir") {
    const state = { count: 0, truncated: false };
    const lines = await collectTreeLines(cwd, source.path, 0, state);
    return clip(`# ${contextSourceSummary(source)}\n\n${lines.join("\n")}${state.truncated ? `\n[truncated tree after ${state.count} entries]` : ""}`, MAX_CTX_OUTPUT_CHARS);
  }

  const text = await readFileSlice(source.path, chars, offset);
  return `# ${contextSourceSummary(source)}\n# byte offset ${offset}, max bytes ${chars}\n\n${text}`;
}

async function grepOneFile(cwd: string, file: string, query: string, opts: { regex: boolean; caseSensitive: boolean }, out: string[], max: number): Promise<void> {
  let re: RegExp | undefined;
  let needle = query;
  if (opts.regex) re = new RegExp(query, opts.caseSensitive ? "" : "i");
  else if (!opts.caseSensitive) needle = query.toLowerCase();

  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const line of rl) {
      lineNo++;
      const matched = re ? re.test(line) : (opts.caseSensitive ? line : line.toLowerCase()).includes(needle);
      if (re) re.lastIndex = 0;
      if (!matched) continue;
      out.push(`${relPathFor(cwd, file)}:${lineNo}: ${clip(line.replace(/\t/g, " "), 500)}`);
      if (out.length >= max) {
        rl.close();
        stream.destroy();
        break;
      }
    }
  } catch (e) {
    out.push(`[error reading ${relPathFor(cwd, file)}: ${errorText(e)}]`);
  }
}

async function ctxGrep(cwd: string, store: ContextStore, params: any): Promise<string> {
  const query = typeof params.query === "string" ? params.query : "";
  if (!query) throw new Error("ctx grep requires query.");
  const maxMatches = clamp(params.maxMatches, DEFAULT_CTX_GREP_MATCHES, 1, HARD_CTX_GREP_MATCHES);
  const sources = selectContextSources(store, typeof params.source === "string" ? params.source : undefined);
  const fileState = { count: 0, truncated: false };
  const files: string[] = [];
  for (const source of sources) await collectFiles(source, fileState, files);

  const matches: string[] = [];
  for (const file of files) {
    if (matches.length >= maxMatches) break;
    await grepOneFile(cwd, file, query, {
      regex: params.regex === true,
      caseSensitive: params.caseSensitive === true,
    }, matches, maxMatches);
  }

  const header = `# ctx grep ${JSON.stringify(query)} across ${files.length} file(s), max ${maxMatches} match(es)`;
  const tail = `${fileState.truncated ? `\n[file listing truncated after ${fileState.count} files]` : ""}\nScratch dir: ${store.scratchDir}`;
  if (!matches.length) return `${header}\nNo matches.${tail}`;
  return `${header}\n${matches.join("\n")}${tail}`;
}
// ── Plain LM call: llm_query ────────────────────────────────────────

async function runLlmQuery(
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

// ── Recursive child RLM: rlm_query ──────────────────────────────────

function childSystemPrompt(depth: number, state: RunState, hasContextStore: boolean): string {
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

function childPrompt(prompt: string, context?: string, paths?: string[], store?: ContextStore): string {
  const ps = normPaths(paths);
  const pathBlock = store
    ? "(file-backed context store sources above; use ctx({action:\"manifest\"}) for inventory)"
    : ps.length ? ps.map((p) => `- ${p}`).join("\n") : "(none — use bash to discover if needed)";
  const ctxBlock = context?.trim() && !contextMaterialized(store) ? `\nInline context:\n${clip(context, MAX_INLINE_CHILD_CONTEXT_CHARS)}\n` : "";
  const storeBlock = store ? contextStorePromptBlock(store) : "";

  return `Prompt:\n${prompt}\n${ctxBlock}${storeBlock}\nPaths to inspect:\n${pathBlock}\n\nUse bash/read${store ? `/${CTX_TOOL_NAME}` : ""} as the REPL/toolkit, rlm(call:\"llm_query\"/\"llm_query_batched\") for one-shot sub-LM calls, rlm(call:\"rlm_query\"/\"rlm_query_batched\") for recursive child RLM sub-calls, and ${RETURN_TOOL_NAME} when done.`;
}

function childToolList(allowWrites?: boolean, hasContextStore = false): string[] {
  const tools = ["bash", "read"];
  if (hasContextStore) tools.push(CTX_TOOL_NAME);
  tools.push(RLM_TOOL_NAME, RETURN_TOOL_NAME);
  if (allowWrites) tools.push("edit", "write");
  return tools;
}

async function runRlmQuery(
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

// ── Batched calls ───────────────────────────────────────────────────

async function runBatch(
  ctx: ExtensionContext,
  params: any,
  call: "llm_query_batched" | "rlm_query_batched",
  depth: number,
  state: RunState,
  signal: AbortSignal | undefined,
  onUpdate: any,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Details }> {
  const primitiveCall = call === "llm_query_batched" ? "llm_query" : "rlm_query";
  const kind: ExecutionKind = call === "llm_query_batched" ? "llm" : "rlm";
  const items = batchItemsFromParams(params, call);
  const maxConcurrent = clamp(params?.maxConcurrent, DEFAULT_MAX_CONCURRENT, 1, HARD_MAX_CONCURRENT);

  onUpdate?.({ content: [{ type: "text", text: `rlm(${call}): ${items.length} item(s), concurrency=${maxConcurrent}` }] });

  const results = await runLimited(items, maxConcurrent, async (item, index) => {
    try {
      if (signal?.aborted) throw new Error("Aborted.");
      onUpdate?.({ content: [{ type: "text", text: `rlm(${call}): item ${index + 1}/${items.length}` }] });
      if (call === "llm_query_batched") {
        return await runLlmQuery(ctx, item, state.budget, depth, state, signal, onUpdate, "llm_query");
      }
      return await runRlmQuery(ctx, item, depth, state, signal, onUpdate);
    } catch (e) {
      const model = resolveModel(ctx, state);
      const msg = `Error: ${errorText(e)}`;
      const details: Details = {
        call: primitiveCall,
        kind,
        depth,
        maxDepth: state.maxDepth,
        callsUsed: state.budget.calls,
        maxCalls: state.budget.maxCalls,
        queriesUsed: state.budget.queries,
        maxQueries: state.budget.maxQueries,
        turns: 0,
        maxTurns: kind === "rlm" ? state.maxTurns : 0,
        model: model ? `${model.provider}/${model.id}` : "unknown",
        prompt: item.prompt,
        paths: normPaths(item.paths),
        answer: msg,
        error: errorText(e),
        incomplete: true,
      };
      return { content: [{ type: "text" as const, text: msg }], details };
    }
  });

  const childDetails = results.map((r) => r.details);
  const body = results
    .map((r, i) => {
      const text = textOf(r.content).trim();
      const prompt = clip(items[i].prompt.replace(/\s+/g, " ").trim(), 160);
      return `## ${i + 1}. ${prompt}\n\n${text}`;
    })
    .join("\n\n---\n\n");

  const answer = clip(body);
  const details: Details = {
    call,
    kind,
    depth,
    maxDepth: state.maxDepth,
    callsUsed: state.budget.calls,
    maxCalls: state.budget.maxCalls,
    queriesUsed: state.budget.queries,
    maxQueries: state.budget.maxQueries,
    turns: childDetails.reduce((sum, d) => sum + (d.turns || 0), 0),
    maxTurns: kind === "rlm" ? state.maxTurns : 0,
    model: modelNameFromDetails(childDetails),
    prompt: `rlm(${call}) (${items.length} item${items.length === 1 ? "" : "s"})`,
    paths: uniquePathsFromDetails(childDetails),
    answer,
    batch: true,
    batchSize: items.length,
    maxConcurrent,
    results: childDetails,
    incomplete: childDetails.some((d) => d.incomplete),
  };

  return { content: [{ type: "text", text: answer }], details };
}

// ── Tool definitions ────────────────────────────────────────────────

function createContextTool(cwd: string, store: ContextStore) {
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

function createReturnTool() {
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

function renderRlmCall(args: any, theme: any) {
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

function renderRlmResult(result: any, { expanded, isPartial }: any, theme: any) {
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

function createRlmTool(inherited?: RunState, parentDepth?: number) {
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

// ── System prompt guidance ──────────────────────────────────────────

const ROOT_GUIDANCE = `

You are running as a Recursive Language Model (RLM). Pi's bash/read/edit/write tools are your REPL/toolkit. Use ONE RLM tool:

${RLM_TOOL_NAME}({ call, ... })

Supported calls:
- call:"llm_query" — RLM's llm_query(). Single-shot LM completion. NO tools. The LM sees ONLY the prompt you provide. Include all relevant context inline. Use for reasoning over already-extracted small text: summarize, classify, compare, extract, answer questions.
- call:"llm_query_batched" — RLM's llm_query_batched(). Batched one-shot LM completions for independent chunks. Results preserve order.
- call:"rlm_query" — RLM's rlm_query(). Spawn a recursive child RLM sub-call. In Pi, the child gets bash/read plus this same ${RLM_TOOL_NAME}, ${RETURN_TOOL_NAME}, and when context is file-backed a ${CTX_TOOL_NAME} tool for capped manifest/grep/peek. Use when the child needs to inspect files, search, run commands, iterate, or keep large context outside chat.
- call:"rlm_query_batched" — RLM's rlm_query_batched(). Batched recursive child RLM sub-calls for independent sub-calls.

Context management:
- The RLM context trick is: keep large context outside model messages; pass paths or contextMode:"file_backed" so the child gets a temp context store + scratch dir.
- path sources are always file-backed; they are listed in a manifest, not copied into chat.
- contextMode:"auto" is default: short context is inline, large context is materialized into a temp file for recursive calls.
- contextMode:"file_backed" forces context into the temp store. Use it for pasted long text/corpora.
- The child should use ${CTX_TOOL_NAME}({action:"manifest"}), ${CTX_TOOL_NAME}({action:"grep", query:"..."}), ${CTX_TOOL_NAME}({action:"peek", source:"s0"}), compact bash pipelines, and scratch files instead of dumping context.

Do NOT call recursive children "agents" in user-facing reasoning unless discussing Pi internals. RLM vocabulary: child RLM, recursive sub-call, sub-LM call. Pi sessions are only the implementation detail.

You MUST use ${RLM_TOOL_NAME} for any task that involves:
- Analyzing more than a handful of files
- Broad search, audit, comparison, or summarization across a codebase or document set
- Finding a needle in a haystack
- Any task the user describes as "recursive", "deep scan", "RLM", or "audit"
- Any task where stuffing all tool output into your context would be wasteful
- Any task that naturally decomposes into independent sub-calls

The Pi-native RLM loop:
1. Keep context external: prefer paths or contextMode:"file_backed" for large inputs.
2. Use child ${CTX_TOOL_NAME}/bash/read to discover structure and extract only relevant text.
3. Decompose: identify independent chunks (by file, directory, topic, symbol, hypothesis, time range).
4. Fan out: call ${RLM_TOOL_NAME}({ call:"llm_query_batched", ... }) on independent extracted chunks when one-shot reasoning is enough.
5. Use ${RLM_TOOL_NAME}({ call:"rlm_query_batched", ... }) only for chunks/sub-calls needing their own bash/read/context-store exploration.
6. Synthesize child results. Resolve contradictions. Note uncertainty.
7. If child results reveal more uncovered ground, recurse again within budget.

Critical rules:
- NEVER dump large context into your own chat or a child chat. Use file-backed context + compact observations.
- ALWAYS prefer call:"llm_query"/"llm_query_batched" over reasoning in your own context when you have extracted small text to analyze.
- ALWAYS prefer call:"rlm_query"/"rlm_query_batched" over doing many sequential bash/read calls when child RLMs can inspect independent path subsets.
- Prefer batched calls for independent chunks/sub-calls. Parallel fan-out is the whole point.
- If an rlm_query/rlm_query_batched result says "stopped after maxTurns", "incomplete", or "partial": do NOT stop recursing. Extract what the child found, identify what was NOT covered, and recurse again with ONLY the uncovered parts as a narrower prompt.
- NEVER stop recursing just because one child hit its turn limit. The correct response is a more-focused child, not abandoning recursion.
- After all recursion, verify critical child claims with one or two direct bash/read calls if cheap. But verification is not a substitute for recursion.`;

// ── Extension entry ─────────────────────────────────────────────────

export default function piRlmExtension(pi: ExtensionAPI) {
  pi.registerTool(createRlmTool());

  pi.on("session_start", () => {
    pi.setActiveTools(["bash", "read", "edit", "write", RLM_TOOL_NAME]);
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + ROOT_GUIDANCE,
  }));
}
