import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { renderMessage, type RenderedEntry } from "../core/render-entries";
import { searchEntries } from "../core/search-entries";
import { formatRecallOutput } from "../core/format-recall";

const DEFAULT_RECENT = 25;
const PAGE_SIZE = 5;

export const invalidExpandIndices = (requested: number[], available: Set<number>): number[] =>
  requested.filter((i) => !Number.isInteger(i) || !available.has(i));

/** Collect entry IDs from the active branch via sessionManager. */
const getBranchMessageIds = (ctx: {
  sessionManager: { getBranch: () => { id?: string }[] };
}): Set<string> | undefined => {
  try {
    const branch = ctx.sessionManager.getBranch() ?? [];
    const ids = branch.map((e) => e.id).filter((id): id is string => Boolean(id));
    return ids.length > 0 ? new Set(ids) : undefined;
  } catch {
    return undefined;
  }
};

/** Load messages from ctx.sessionManager (no file I/O).
 *  Works like the old loadAllMessages but uses the in-memory entry tree. */
const loadMessages = (
  ctx: {
    sessionManager: { getEntries: () => { type: string; id: string; message?: Message }[] };
  },
  full: boolean,
  allowedIds?: Set<string>,
): { rendered: RenderedEntry[]; rawMessages: Message[]; entryIds: string[] } => {
  const entries = ctx.sessionManager.getEntries();
  const rendered: RenderedEntry[] = [];
  const rawMessages: Message[] = [];
  const entryIds: string[] = [];

  let messageIndex = 0;
  for (const e of entries) {
    if (e.type !== "message" || !e.message) continue;
    if (allowedIds && !allowedIds.has(e.id)) {
      messageIndex++;
      continue;
    }
    rendered.push(renderMessage(e.message, messageIndex, full));
    rawMessages.push(e.message);
    entryIds.push(e.id);
    messageIndex++;
  }

  return { rendered, rawMessages, entryIds };
};

export const registerRecallTool = (pi: ExtensionAPI) => {
  pi.registerTool({
    name: "vcc_recall",
    label: "VCC Recall",
    description:
      "Search session history. Defaults to active lineage; use scope:'all' to include off-lineage branches." +
      " Supports regex queries, paging, and expand indices.",
    promptSnippet:
      "vcc_recall: Search history; default scope is active lineage. Use scope:'all' for off-lineage branches.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Search terms or regex pattern (e.g. 'hook|inject', 'fail.*build'). Multi-word = OR ranked by relevance." }),
      ),
      expand: Type.Optional(
        Type.Array(Type.Number(), { description: "Entry indices to return full untruncated content for" }),
      ),
      page: Type.Optional(
        Type.Number({ description: "Page number (1-based) for paginated search results. Default: 1." }),
      ),
      scope: Type.Optional(
        Type.Union([
          Type.Literal("lineage"),
          Type.Literal("all"),
        ], { description: "Search scope. Default: lineage; includes off-lineage branches." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        return {
          content: [{ type: "text", text: "No session file available." }],
          details: undefined,
        };
      }

      // scope normalization (was normalizeRecallScope)
      const scope = typeof params.scope === "string" && params.scope.toLowerCase() === "all" ? "all" : "lineage";
      // lineage filtering via sessionManager API (was getActiveLineageEntryIds)
      const allowedIds = scope === "lineage" ? getBranchMessageIds(ctx) : undefined;

      const expandSet = new Set(params.expand ?? []);
      const hasExpand = expandSet.size > 0;

      if (hasExpand && !params.query) {
        const { rendered: fullMsgs } = loadMessages(ctx, true, allowedIds);
        const requested = [...expandSet];
        const byIndex = new Map(fullMsgs.map((m) => [m.index, m]));
        const invalid = invalidExpandIndices(requested, new Set(byIndex.keys()));
        if (invalid.length > 0) {
          return {
            content: [{ type: "text", text: `Cannot expand indices outside ${scope === "all" ? "session history" : "active lineage"}: ${invalid.join(", ")}` }],
            details: undefined,
          };
        }

        const expanded = requested.map((i) => byIndex.get(i)).filter((m): m is NonNullable<typeof m> => Boolean(m));
        const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(expanded);
        return {
          content: [{ type: "text", text: output }],
          details: undefined,
        };
      }

      const { rendered: msgs, rawMessages } = loadMessages(ctx, false, allowedIds);
      const allResults = params.query?.trim()
        ? searchEntries(msgs, rawMessages, params.query.trim())
        : msgs.slice(-DEFAULT_RECENT);

      if (params.query?.trim()) {
        const page = Math.max(1, params.page ?? 1);
        const start = (page - 1) * PAGE_SIZE;
        const pageResults = allResults.slice(start, start + PAGE_SIZE);
        const totalPages = Math.ceil(allResults.length / PAGE_SIZE);
        const scopeSuffix = scope === "all" ? " (scope: all)" : "";
        const header = totalPages > 1
          ? `Page ${page}/${totalPages} (${allResults.length} total matches${scopeSuffix})`
          : `${allResults.length} matches${scopeSuffix}`;
        const footer = page < totalPages
          ? `\n--- Use page:${page + 1}${scope === "all" ? " with scope:'all'" : ""} for more results ---`
          : "";
        const output = formatRecallOutput(pageResults, params.query, header) + footer;
        return {
          content: [{ type: "text", text: output }],
          details: undefined,
        };
      }

      const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(allResults, params.query);
      return {
        content: [{ type: "text", text: output }],
        details: undefined,
      };
    },
  });
};