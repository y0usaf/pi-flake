import type { SessionEntry } from "@earendil-works/pi-coding-agent";

// Local mirror of the context-projection helpers in pi 0.84.2
// core/session-manager.js and core/messages.js. Kept identical so Fabric's
// compaction projections match the host's without importing the host package
// during extension load.

export type ContextMessage = { role: string } & Record<string, unknown>;

type PathEntry = SessionEntry & { parentId?: string };

const buildEntryIndex = (
  entries: readonly SessionEntry[],
  byId?: Map<string, SessionEntry>,
): Map<string, SessionEntry> => {
  if (byId) return byId;
  const index = new Map<string, SessionEntry>();
  for (const entry of entries) {
    index.set(entry.id, entry);
  }
  return index;
};

const buildSessionPath = (
  entries: readonly SessionEntry[],
  leafId: string | undefined,
  byId?: Map<string, SessionEntry>,
): SessionEntry[] => {
  const index = buildEntryIndex(entries, byId);
  let leaf: SessionEntry | undefined = undefined;
  if (leafId !== undefined) {
    leaf = index.get(leafId);
  }
  leaf = leaf ?? entries[entries.length - 1];
  if (!leaf) {
    return [];
  }
  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    path.push(current);
    const parent = current as PathEntry;
    current = parent.parentId ? index.get(parent.parentId) : undefined;
  }
  path.reverse();
  return path;
};

const getSessionContextSettings = (path: readonly SessionEntry[]): {
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
} => {
  let thinkingLevel = "off";
  let model: { provider: string; modelId: string } | null = null;
  for (const entry of path) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      model = { provider: entry.message.provider, modelId: entry.message.model };
    }
  }
  return { thinkingLevel, model };
};

const createBranchSummaryMessage = (
  summary: string,
  fromId: string,
  timestamp: number | string,
): ContextMessage => ({
  role: "branchSummary",
  summary,
  fromId,
  timestamp: new Date(timestamp).getTime(),
});

const createCompactionSummaryMessage = (
  summary: string,
  tokensBefore: number,
  timestamp: number | string,
): ContextMessage => ({
  role: "compactionSummary",
  summary,
  tokensBefore,
  timestamp: new Date(timestamp).getTime(),
});

const createCustomMessage = (
  customType: string,
  content: unknown,
  display: unknown,
  details: unknown,
  timestamp: number | string,
): ContextMessage => ({
  role: "custom",
  customType,
  content,
  display,
  details,
  timestamp: new Date(timestamp).getTime(),
});

export const sessionEntryToContextMessages = (entry: SessionEntry): ContextMessage[] => {
  if (entry.type === "message") {
    const message = entry.message;
    if (
      (message.role === "user" || message.role === "assistant" || message.role === "toolResult")
      && message.content == null
    ) {
      return [{ ...message, content: [] }];
    }
    return [message] as unknown as ContextMessage[];
  }
  if (entry.type === "custom_message") {
    return [
      createCustomMessage(entry.customType, entry.content ?? [], entry.display, entry.details, entry.timestamp),
    ];
  }
  if (entry.type === "branch_summary" && entry.summary) {
    return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
  }
  if (entry.type === "compaction") {
    return [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp)];
  }
  return [];
};

const buildContextEntries = (
  entries: readonly SessionEntry[],
  leafId?: string,
  byId?: Map<string, SessionEntry>,
): SessionEntry[] => {
  const path = buildSessionPath(entries, leafId, byId);
  let compaction: SessionEntry | undefined = undefined;
  for (const entry of path) {
    if (entry.type === "compaction") {
      compaction = entry;
    }
  }
  if (!compaction) {
    return path;
  }
  const compactionIdx = [...path].findIndex(
    (entry) => entry.id === compaction?.id,
  );
  if (compactionIdx < 0) {
    return path;
  }
  const contextEntries: SessionEntry[] = [compaction];
  let foundFirstKept = false;
  for (let i = 0; i < compactionIdx; i++) {
    const entry = path[i];
    if (!entry) continue;
    if (entry.id === compaction.firstKeptEntryId) {
      foundFirstKept = true;
    }
    if (foundFirstKept) {
      contextEntries.push(entry);
    }
  }
  contextEntries.push(...path.slice(compactionIdx + 1));
  return contextEntries;
};

export const buildSessionContext = (
  entries: readonly SessionEntry[],
  leafId?: string,
  byId?: Map<string, SessionEntry>,
): {
  messages: ContextMessage[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
} => {
  const path = buildSessionPath(entries, leafId, byId);
  const { thinkingLevel, model } = getSessionContextSettings(path);
  const messages = buildContextEntries(entries, leafId, byId).flatMap(sessionEntryToContextMessages);
  return { messages, thinkingLevel, model };
};
