import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { renderMessage, type RenderedEntry } from "../core/render-entries";
import { searchEntries } from "../core/search-entries";
import { formatRecallOutput } from "../core/format-recall";

const PAGE_SIZE = 5;
const DEFAULT_RECENT = 25;

const SCOPE_RE = /\bscope:(lineage|all)\b/i;

/** Strips a `scope:all` token from user args and returns the effective scope. */
const parseScopeToken = (raw: string): { scope: "lineage" | "all"; text: string } => {
  const match = raw.match(SCOPE_RE);
  const scope = match?.[1]?.toLowerCase() === "all" ? "all" as const : "lineage" as const;
  const text = raw.replace(SCOPE_RE, "").replace(/\s+/g, " ").trim();
  return { scope, text };
};

/** Load rendered messages from sessionManager (no file I/O). */
const loadMessages = (
  ctx: {
    sessionManager: {
      getBranch: () => { id?: string }[];
      getEntries: () => { type: string; id: string; message?: Message }[];
    };
  },
  scope: "lineage" | "all",
): { rendered: RenderedEntry[]; rawMessages: Message[] } => {
  let allowedIds: Set<string> | undefined;
  if (scope === "lineage") {
    try {
      const branch = ctx.sessionManager.getBranch() ?? [];
      const ids = branch.map((e) => e.id).filter((id): id is string => Boolean(id));
      if (ids.length > 0) allowedIds = new Set(ids);
    } catch { /* fall through — no ID filter */ }
  }

  const entries = ctx.sessionManager.getEntries();
  const rendered: RenderedEntry[] = [];
  const rawMessages: Message[] = [];

  let messageIndex = 0;
  for (const e of entries) {
    if (e.type !== "message" || !e.message) continue;
    if (allowedIds && !allowedIds.has(e.id)) {
      messageIndex++;
      continue;
    }
    rendered.push(renderMessage(e.message, messageIndex, false));
    rawMessages.push(e.message);
    messageIndex++;
  }

  return { rendered, rawMessages };
};

const sendRecall = (pi: ExtensionAPI, output: string) => {
  pi.sendMessage({ customType: "vcc-recall", content: output, display: true }, { triggerTurn: true });
};

export const registerVccRecallCommand = (pi: ExtensionAPI) => {
  pi.registerCommand("pi-vcc-recall", {
    description: "Search session history. Defaults to active lineage; add scope:all for off-lineage branches.",
    handler: async (args: string, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("No session file available.", "error");
        return;
      }

      const raw = args.trim();
      const { scope, text } = parseScopeToken(raw);

      // No query at all — show most recent messages
      if (!text) {
        const { rendered } = loadMessages(ctx, scope);
        const recent = rendered.slice(-DEFAULT_RECENT);
        const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(recent);
        sendRecall(pi, output);
        return;
      }

      // Parse page:N from args
      const pageMatch = text.match(/\bpage:(\d+)\b/i);
      const page = pageMatch ? Math.max(1, parseInt(pageMatch[1], 10)) : 1;
      const query = text.replace(/\bpage:\d+\b/i, "").trim();

      // Only a page token, no actual search query — show recent
      if (!query) {
        const { rendered } = loadMessages(ctx, scope);
        const recent = rendered.slice(-DEFAULT_RECENT);
        const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(recent);
        sendRecall(pi, output);
        return;
      }

      // Full search
      const { rendered, rawMessages } = loadMessages(ctx, scope);
      const allResults = searchEntries(rendered, rawMessages, query);

      const start = (page - 1) * PAGE_SIZE;
      const pageResults = allResults.slice(start, start + PAGE_SIZE);
      const totalPages = Math.ceil(allResults.length / PAGE_SIZE);
      const scopeSuffix = scope === "all" ? " (scope: all)" : "";
      const header = totalPages > 1
        ? `Page ${page}/${totalPages} (${allResults.length} total matches${scopeSuffix})`
        : `${allResults.length} matches${scopeSuffix}`;
      const footer = page < totalPages
        ? `\n--- /pi-vcc-recall ${query}${scope === "all" ? " scope:all" : ""} page:${page + 1} ---`
        : "";
      const output = formatRecallOutput(pageResults, query, header) + footer;
      sendRecall(pi, output);
    },
  });
};