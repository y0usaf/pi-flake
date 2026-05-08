// ── Defaults ────────────────────────────────────────────────────────

export const DEFAULT_MAX_DEPTH = 4;
export const DEFAULT_MAX_TURNS = 20;
export const DEFAULT_MAX_CALLS = 32;
export const DEFAULT_MAX_QUERIES = 64;
export const DEFAULT_MAX_CONCURRENT = 4;

export const HARD_MAX_DEPTH = 8;
export const HARD_MAX_TURNS = 80;
export const HARD_MAX_CALLS = 128;
export const HARD_MAX_QUERIES = 256;
export const HARD_MAX_CONCURRENT = 32;

export const MAX_RESULT_CHARS = 50_000;
export const MAX_QUERY_CONTEXT_CHARS = 500_000;
export const MAX_TRACE_TEXT_CHARS = 800;
export const MAX_INLINE_CHILD_CONTEXT_CHARS = 20_000;
export const MAX_CONTEXT_MANIFEST_CHARS = 30_000;
export const MAX_CONTEXT_TREE_ENTRIES = 500;
export const MAX_CONTEXT_TREE_DEPTH = 4;
export const MAX_CTX_OUTPUT_CHARS = 20_000;
export const DEFAULT_CTX_PEEK_CHARS = 4_000;
export const HARD_CTX_PEEK_CHARS = 20_000;
export const DEFAULT_CTX_GREP_MATCHES = 50;
export const HARD_CTX_GREP_MATCHES = 200;
export const MAX_CTX_GREP_FILES = 5_000;

export const RLM_TOOL_NAME = "rlm";
export const RETURN_TOOL_NAME = "pi_return";
export const CTX_TOOL_NAME = "ctx";

export const RLM_CALLS = ["llm_query", "llm_query_batched", "rlm_query", "rlm_query_batched"] as const;
export type RlmCall = typeof RLM_CALLS[number];
export type ExecutionKind = "llm" | "rlm";

export const CONTEXT_MODES = ["auto", "inline", "file_backed"] as const;
export type ContextMode = typeof CONTEXT_MODES[number];

export const CTX_ACTIONS = ["manifest", "peek", "grep"] as const;
export type CtxAction = typeof CTX_ACTIONS[number];

export type ContextSourceKind = "inline" | "file" | "dir" | "missing" | "other";

export interface ContextSource {
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

export interface ContextStore {
  dir: string;
  scratchDir: string;
  manifestPath: string;
  manifestJsonPath: string;
  readmePath: string;
  manifestText: string;
  sources: ContextSource[];
}

export interface Budget {
  calls: number;
  maxCalls: number;
  queries: number;
  maxQueries: number;
}

export interface RunState {
  maxDepth: number;
  maxTurns: number;
  budget: Budget;
  /** The model of the parent Pi session that started this RLM run. No overrides. */
  model?: any;
}

export interface BatchItem {
  prompt: string;
  context?: string;
  contextMode?: ContextMode;
  paths?: string[];
  allowWrites?: boolean;
}

export interface Details {
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

