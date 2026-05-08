import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";

import {
  CTX_ACTIONS,
  CONTEXT_MODES,
  DEFAULT_CTX_GREP_MATCHES,
  DEFAULT_CTX_PEEK_CHARS,
  DEFAULT_MAX_CALLS,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_QUERIES,
  DEFAULT_MAX_TURNS,
  HARD_CTX_GREP_MATCHES,
  HARD_CTX_PEEK_CHARS,
  RLM_CALLS,
} from "./constants.js";

// ── Params ──────────────────────────────────────────────────────────

export const LimitParams = {
  maxDepth: Type.Optional(Type.Number({ description: `Recursive depth cap. Default ${DEFAULT_MAX_DEPTH}. At the cap, rlm_query falls back to a plain LM call.` })),
  maxTurns: Type.Optional(Type.Number({ description: `Recursive child turn cap. Default ${DEFAULT_MAX_TURNS}.` })),
  maxCalls: Type.Optional(Type.Number({ description: `Total recursive child RLM calls across this run. Default ${DEFAULT_MAX_CALLS}.` })),
  maxQueries: Type.Optional(Type.Number({ description: `Total llm_query calls across this run. Default ${DEFAULT_MAX_QUERIES}.` })),
  maxConcurrent: Type.Optional(Type.Number({ description: `Batch concurrency cap. Default ${DEFAULT_MAX_CONCURRENT}.` })),
};

export const ContextModeParam = Type.Optional(StringEnum(CONTEXT_MODES, {
  description:
    'Context handling for recursive RLM calls. "auto" keeps short inline context in chat but materializes large context into a temp file; paths are always file-backed. "inline" preserves old inline behavior for context. "file_backed" materializes context into the temp context store.',
}));

export const RlmBatchItem = Type.Object({
  prompt: Type.String({ description: "Prompt for this batch item." }),
  context: Type.Optional(Type.String({ description: "Optional inline context for this item." })),
  contextMode: ContextModeParam,
  paths: Type.Optional(Type.Array(Type.String(), { description: "Paths for this child RLM to inspect. Used by rlm_query_batched only. Paths are file-backed context sources." })),
  allowWrites: Type.Optional(Type.Boolean({ description: "Also give this child edit/write tools. Used by rlm_query_batched only." })),
});

export const RlmParams = Type.Object({
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

export const ReturnParams = Type.Object({
  answer: Type.String({ description: "Final answer for this recursive Pi child RLM." }),
});

export const CtxParams = Type.Object({
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

export const RLM_PARAM_KEYS = new Set([
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

export const RLM_ITEM_KEYS = new Set(["prompt", "context", "contextMode", "paths", "allowWrites"]);

