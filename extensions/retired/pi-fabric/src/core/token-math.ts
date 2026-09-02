// Local mirror of the token heuristics in pi 0.84.2
// core/compaction/compaction.js. Kept identical so compaction projections
// match the host's without importing the host package during extension load.

const ESTIMATED_IMAGE_CHARS = 4800;

export const DEFAULT_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
} as const;

interface TokenContentPart {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
}

type TokenMessage = {
  role: string;
  content?: unknown;
  command?: unknown;
  output?: unknown;
  summary?: unknown;
};

const contentParts = (content: unknown): readonly TokenContentPart[] => {
  if (typeof content !== "string") return (content ?? []) as readonly TokenContentPart[];
  return [];
};

const estimateTextAndImageContentChars = (content: unknown): number => {
  if (typeof content === "string") {
    return content.length;
  }
  let chars = 0;
  for (const block of contentParts(content)) {
    if (block.type === "text" && block.text) {
      chars += block.text.length;
    } else if (block.type === "image") {
      chars += ESTIMATED_IMAGE_CHARS;
    }
  }
  return chars;
};

const textLength = (value: unknown): number => (typeof value === "string" ? value.length : 0);

export const estimateTokens = (message: TokenMessage): number => {
  let chars = 0;
  switch (message.role) {
    case "user": {
      chars = estimateTextAndImageContentChars(message.content);
      return Math.ceil(chars / 4);
    }
    case "assistant": {
      for (const block of contentParts(message.content)) {
        if (block.type === "text") {
          chars += textLength(block.text);
        } else if (block.type === "thinking") {
          chars += textLength(block.thinking);
        } else if (block.type === "toolCall") {
          chars += textLength(block.name) + JSON.stringify(block.arguments).length;
        }
      }
      return Math.ceil(chars / 4);
    }
    case "custom":
    case "toolResult": {
      chars = estimateTextAndImageContentChars(message.content);
      return Math.ceil(chars / 4);
    }
    case "bashExecution": {
      chars = textLength(message.command) + textLength(message.output);
      return Math.ceil(chars / 4);
    }
    case "branchSummary":
    case "compactionSummary": {
      chars = textLength(message.summary);
      return Math.ceil(chars / 4);
    }
  }
  return 0;
};

export const calculateContextTokens = (usage: unknown): number => {
  if (typeof usage !== "object" || usage === null) return 0;
  const record = usage as Record<string, unknown>;
  const totalTokens = record.totalTokens;
  // Host evaluates `usage.totalTokens || input + output + ...`; zero and
  // missing totals both fall through to the component sum.
  if (typeof totalTokens === "number" && totalTokens > 0) return totalTokens;
  const count = (value: unknown): number => (typeof value === "number" ? value : 0);
  return count(record.input) + count(record.output) + count(record.cacheRead) + count(record.cacheWrite);
};
