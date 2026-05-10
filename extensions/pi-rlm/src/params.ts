import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";

import {
  CTX_ACTIONS,
  CONTEXT_MODES,
  CHILD_MODES,
  DEFAULT_CHILD_MODE,
  DEFAULT_CTX_GREP_MATCHES,
  DEFAULT_CTX_PEEK_CHARS,
  DEFAULT_MAX_CALLS,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_QUERIES,
  DEFAULT_MAX_TURNS,
  HARD_CTX_GREP_MATCHES,
  HARD_CTX_PEEK_CHARS,
  DEFAULT_MAX_BUDGET,
  DEFAULT_MAX_ERRORS,
  DEFAULT_MAX_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
  HARD_MAX_BUDGET,
  HARD_MAX_ERRORS,
  HARD_MAX_TIMEOUT_MS,
  HARD_MAX_TOKENS,
  RLM_CALLS,
} from "./constants.js";

// ── Params ──────────────────────────────────────────────────────────

export const LimitParams = {
  maxDepth: Type.Optional(Type.Number({ description: `Recursive depth cap. Default ${DEFAULT_MAX_DEPTH}. At the cap, rlm_query falls back to a plain LM call.` })),
  maxTurns: Type.Optional(Type.Number({ description: `Recursive child turn cap. Default ${DEFAULT_MAX_TURNS}.` })),
  maxCalls: Type.Optional(Type.Number({ description: `Total recursive child RLM calls across this run. Default ${DEFAULT_MAX_CALLS}.` })),
  maxQueries: Type.Optional(Type.Number({ description: `Total llm_query calls across this run. Default ${DEFAULT_MAX_QUERIES}.` })),
  maxConcurrent: Type.Optional(Type.Number({ description: `Batch concurrency cap. Default ${DEFAULT_MAX_CONCURRENT}.` })),
  maxTimeoutMs: Type.Optional(Type.Number({ description: `Wall-clock timeout for the whole recursive RLM tree in milliseconds. Default ${DEFAULT_MAX_TIMEOUT_MS} (unlimited). Hard cap ${HARD_MAX_TIMEOUT_MS}.` })),
  maxTimeout: Type.Optional(Type.Number({ description: "Upstream-style wall-clock timeout in seconds. Alias for maxTimeoutMs." })),
  max_timeout: Type.Optional(Type.Number({ description: "Upstream-style wall-clock timeout in seconds. Alias for maxTimeoutMs." })),
  maxTokens: Type.Optional(Type.Number({ description: `Approximate total input+output token cap across tracked LM calls. Default ${DEFAULT_MAX_TOKENS} (unlimited). Hard cap ${HARD_MAX_TOKENS}.` })),
  max_tokens: Type.Optional(Type.Number({ description: "Upstream-style alias for maxTokens." })),
  maxBudget: Type.Optional(Type.Number({ description: `USD cost cap across tracked LM calls when providers report usage. Default ${DEFAULT_MAX_BUDGET} (unlimited). Hard cap ${HARD_MAX_BUDGET}.` })),
  max_budget: Type.Optional(Type.Number({ description: "Upstream-style alias for maxBudget." })),
  maxErrors: Type.Optional(Type.Number({ description: `Consecutive/aggregate RLM runtime error cap. Default ${DEFAULT_MAX_ERRORS} (unlimited). Hard cap ${HARD_MAX_ERRORS}.` })),
  max_errors: Type.Optional(Type.Number({ description: "Upstream-style alias for maxErrors." })),
  maxIterations: Type.Optional(Type.Number({ description: "Alias for maxTurns." })),
  max_iterations: Type.Optional(Type.Number({ description: "Upstream-style alias for maxTurns." })),
  max_depth: Type.Optional(Type.Number({ description: "Upstream-style alias for maxDepth." })),
  max_concurrent_subcalls: Type.Optional(Type.Number({ description: "Upstream-style alias for maxConcurrent." })),
};

export const ContextModeParam = Type.Optional(StringEnum(CONTEXT_MODES, {
  description:
    'Context handling for recursive RLM calls. "auto" keeps short inline context in chat but materializes large context into a temp file; paths are always file-backed. "inline" preserves old inline behavior for context. "file_backed" materializes context into the temp context store.',
}));

export const SourceParam = Type.Object({
  name: Type.Optional(Type.String({ description: "Optional stable source name/alias for ctx selection." })),
  path: Type.String({ description: "File or directory path for this file-backed context source." }),
});

export const ChildModeParam = Type.Optional(StringEnum(CHILD_MODES, {
  description:
    `Recursive child session profile. Default ${DEFAULT_CHILD_MODE}: exposes only rlm_repl plus pi_return; context access goes through REPL helpers. "pi-agent" preserves broader child bash/read/ctx/rlm (+ edit/write when allowed).`,
}));

export const RlmBatchItem = Type.Object({
  prompt: Type.String({ description: "Prompt for this batch item." }),
  rootPrompt: Type.Optional(Type.String({ description: "Small visible/root prompt or question for this item; analogous to upstream root_prompt. Appended separately from large context." })),

  context: Type.Optional(Type.String({ description: "Optional inline context for this item." })),
  contextMode: ContextModeParam,
  childMode: ChildModeParam,
  paths: Type.Optional(Type.Array(Type.String(), { description: "Paths for this child RLM to inspect. Used by rlm_query_batched only. Paths are file-backed context sources." })),
  sources: Type.Optional(Type.Array(SourceParam, { description: "Named file-backed sources for this child RLM. Not accepted for llm_query calls." })),
  contextName: Type.Optional(Type.String({ description: "Optional name/label for materialized inline context." })),
  allowWrites: Type.Optional(Type.Boolean({ description: "Also give this child edit/write tools. Used by rlm_query_batched only." })),
});

export const RlmParams = Type.Object({
  call: StringEnum(RLM_CALLS, {
    description:
      'RLM call to run: "llm_query", "llm_query_batched", "rlm_query", or "rlm_query_batched".',
  }),
  prompt: Type.Optional(Type.String({ description: "Prompt for llm_query or rlm_query." })),
  rootPrompt: Type.Optional(Type.String({ description: "Small visible/root prompt or question; analogous to upstream root_prompt. Appended separately from large context." })),

  context: Type.Optional(
    Type.String({ description: "Optional context. For llm_query this is inlined. For recursive RLM calls, large context is materialized into the file-backed context store when contextMode='auto' or 'file_backed'." }),
  ),
  contextMode: ContextModeParam,
  childMode: ChildModeParam,
  paths: Type.Optional(
    Type.Array(Type.String(), { description: "Paths for rlm_query/rlm_query_batched children to inspect via rlm_repl helpers by default (childMode='pure-rlm') or direct ctx/bash/read in childMode='pi-agent'. Not accepted for llm_query calls. Paths are kept outside chat as file-backed context." }),
  ),
  sources: Type.Optional(Type.Array(SourceParam, { description: "Named file-backed sources for rlm_query/rlm_query_batched children. Not accepted for llm_query calls." })),
  contextName: Type.Optional(Type.String({ description: "Optional source name/label for materialized inline context." })),
  prompts: Type.Optional(
    Type.Array(Type.String(), { description: "Prompts for batched calls. Shared context/paths apply to each item." }),
  ),
  items: Type.Optional(
    Type.Array(RlmBatchItem, { description: "Structured batch items with per-item prompt/context/contextMode/childMode/paths/sources/contextName." }),
  ),
  allowWrites: Type.Optional(
    Type.Boolean({ description: "Recursive child RLM calls: also give edit/write tools. Default false. Temporary scratch writes are always allowed inside the RLM context store." }),
  ),
  ...LimitParams,
  logPath: Type.Optional(Type.String({ description: "Optional JSONL trajectory log path for this RLM run." })),
  logDir: Type.Optional(Type.String({ description: "Optional directory for JSONL trajectory logs; creates one file per run." })),
});

export const ReplParams = Type.Object({
  code: Type.String({ description: "Python code to run inside the RLM-aware REPL. Use synchronous llm_query/rlm_query helpers, globals/state for persistence, and FINAL(value) when done." }),
  reset: Type.Optional(Type.Boolean({ description: "Clear persistent REPL state before running this code. Default false." })),
  timeoutMs: Type.Optional(Type.Number({ description: "Local Python execution timeout. Paused while synchronous bridge helpers (llm_query/rlm_query/bash/ctx/read_file) are running. Default 30000, hard cap 120000." })),
  data: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Optional JSON-serializable variables to inject into the Python REPL globals before running code." })),
  setup: Type.Optional(Type.String({ description: "Optional Python setup code to execute before the main code in this eval." })),
  resetHistory: Type.Optional(Type.Boolean({ description: "Clear REPL history variables before running this code. Default false." })),
});

export const ReturnParams = Type.Object({
  answer: Type.String({ description: "Final answer for this recursive Pi child RLM." }),
});

export const CtxParams = Type.Object({
  action: StringEnum(CTX_ACTIONS, {
    description: 'Context-store action: "manifest", "peek", "grep", "extract", "note", or "artifact".',
  }),
  source: Type.Optional(Type.String({ description: "Optional source id/name/path, e.g. s0, s1, docs/. Omit for all sources on grep or first source on peek." })),
  format: Type.Optional(Type.String({ description: "manifest format: text (default) or json." })),
  file: Type.Optional(Type.String({ description: "File inside a directory source for peek/extract. Must stay inside source dir." })),
  line: Type.Optional(Type.Number({ description: "1-based start line for line-aware peek/extract." })),
  endLine: Type.Optional(Type.Number({ description: "1-based end line for line-aware peek/extract." })),
  lines: Type.Optional(Type.Number({ description: "Number of lines for line-aware peek/extract." })),
  numbers: Type.Optional(Type.Boolean({ description: "Include line numbers for line-aware output. Default true." })),
  query: Type.Optional(Type.String({ description: "Search query for action='grep'. Plain substring by default; set regex=true for regular expressions." })),
  regex: Type.Optional(Type.Boolean({ description: "Treat query as a JavaScript regular expression for grep. Default false." })),
  literal: Type.Optional(Type.Boolean({ description: "Force literal grep. Default true unless regex=true." })),
  caseSensitive: Type.Optional(Type.Boolean({ description: "Case-sensitive grep. Default false." })),
  chars: Type.Optional(Type.Number({ description: `Max bytes for peek output. Default ${DEFAULT_CTX_PEEK_CHARS}, hard cap ${HARD_CTX_PEEK_CHARS}.` })),
  offset: Type.Optional(Type.Number({ description: "Byte offset for peek. Default 0." })),
  maxMatches: Type.Optional(Type.Number({ description: `Max grep matches. Default ${DEFAULT_CTX_GREP_MATCHES}, hard cap ${HARD_CTX_GREP_MATCHES}.` })),
  contextLines: Type.Optional(Type.Number({ description: "Grep context lines before and after each match." })),
  before: Type.Optional(Type.Number({ description: "Grep context lines before each match." })),
  after: Type.Optional(Type.Number({ description: "Grep context lines after each match." })),
  ranges: Type.Optional(Type.Array(Type.Object({
    source: Type.Optional(Type.String()),
    file: Type.Optional(Type.String()),
    line: Type.Number(),
    endLine: Type.Optional(Type.Number()),
    lines: Type.Optional(Type.Number()),
  }), { description: "Ranges for extract action." })),
  text: Type.Optional(Type.String({ description: "Text content for note/artifact action." })),
  name: Type.Optional(Type.String({ description: "Safe relative file name for note/artifact." })),
});

export const RLM_PARAM_KEYS = new Set([
  "call",
  "prompt",
  "rootPrompt",

  "context",
  "contextMode",
  "childMode",
  "paths",
  "sources",
  "contextName",
  "prompts",
  "items",
  "allowWrites",
  "maxDepth",
  "maxTurns",
  "maxCalls",
  "maxQueries",
  "maxConcurrent",
  "maxTimeoutMs",
  "maxTimeout",
  "max_timeout",
  "maxTokens",
  "max_tokens",
  "maxBudget",
  "max_budget",
  "maxErrors",
  "max_errors",
  "maxIterations",
  "max_iterations",
  "max_depth",
  "max_concurrent_subcalls",
  "logPath",
  "logDir",
]);

export const RLM_ITEM_KEYS = new Set(["prompt", "rootPrompt", "context", "contextMode", "childMode", "paths", "sources", "contextName", "allowWrites"]);
export const REPL_PARAM_KEYS = new Set(["code", "reset", "timeoutMs", "data", "setup", "resetHistory"]);

