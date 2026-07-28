/**
 * pi-aphrodite — Pi extension that compresses oversized tool output into a
 * local SQLite CCR store before it reaches the model context. No server, no
 * proxy: hashing and storage happen in-process.
 *
 * The extension hooks the mutable `tool_result` event: raw output above the
 * byte threshold is written to the local store and replaced with a compact
 * preview plus a `<<<CCR:hash|type|size>>>` marker. The model can recover
 * the original text with the `aphrodite_retrieve` tool. Any failure
 * (database unwritable, etc.) falls back silently to uncompressed output.
 *
 * User `!<cmd>` shell output lands in model context, so it is compressed
 * too — on by default. BashOperations.exec streams via onData, so this
 * means buffering: no live output while the command runs. `!!<cmd>`
 * (excluded from context) is never intercepted, and `/aphrodite bash off`
 * restores raw streaming for `!<cmd>`.
 *
 * The compression pipeline is fully programmatic (regex classifier +
 * type-aware previews + sha256/SQLite store); no model call happens inside
 * the compress step.
 *
 * Configuration:
 * - APHRODITE_MIN_BYTES  minimum output size to compress (default 1024)
 * - APHRODITE_DB_PATH    SQLite file for the CCR store (default
 *                        $XDG_STATE_HOME/pi/aphrodite-ccr.db or
 *                        ~/.local/state/pi/aphrodite-ccr.db)
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Pi runs extensions on Node.js (jiti); tests and the Nix sandbox check run
// on Bun, which has no node:sqlite alias. Resolve whichever SQLite binding
// the current runtime provides.
type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
  };
  close(): void;
};
type SqliteConstructor = new (path: string) => SqliteDatabase;

function loadSqlite(): SqliteConstructor {
  const require = createRequire(import.meta.url);
  try {
    return (require("node:sqlite") as { DatabaseSync: SqliteConstructor })
      .DatabaseSync;
  } catch {
    return (require("bun:sqlite") as { Database: SqliteConstructor }).Database;
  }
}

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_MIN_BYTES = 1024;
const PREVIEW_FIRST_LINE_MAX = 120;
const RETRIEVE_LINE_CAP = 2000;
const HASH_HEX_LENGTH = 16;

export type AphroditeAvailability = "unknown" | "available" | "unavailable";
export type AphroditeFailureKind = "failed" | "unavailable";

export interface AphroditeStatus {
  availability: AphroditeAvailability;
  attempts: number;
  stored: number;
  originalBytes: number;
  markerBytes: number;
  retrieves: number;
  failures: number;
  unavailableSkips: number;
  lastFailure?: AphroditeFailureKind;
}

export interface AphroditeStored {
  hash: string;
  ratio: number;
  originalSize: number;
  compressedSize: number;
  markerSize: number;
}

export interface AphroditeRetrieveOptions {
  query?: string;
  offset?: number;
  limit?: number;
}

export interface AphroditeClient {
  store(
    content: string,
    type: string,
  ): Promise<AphroditeStored | undefined>;
  retrieve(
    hash: string,
    options: AphroditeRetrieveOptions,
  ): Promise<string>;
  probe(): Promise<AphroditeAvailability>;
  resetAvailability(): void;
  getStatus(): AphroditeStatus;
  close(): void;
}

export interface AphroditeClientOptions {
  dbPath?: string;
}

export function defaultDbPath(): string {
  const stateHome =
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "pi", "aphrodite-ccr.db");
}

function hashContent(content: string): string {
  return createHash("sha256")
    .update(content)
    .digest("hex")
    .slice(0, HASH_HEX_LENGTH);
}

function markerSizeFor(hash: string, type: string, originalSize: number): number {
  return Buffer.byteLength(`<<<CCR:${hash}|${type}|${originalSize}>>>`, "utf8");
}

export function createLocalAphroditeClient(
  options: AphroditeClientOptions = {},
): AphroditeClient {
  const dbPath = options.dbPath ?? process.env.APHRODITE_DB_PATH ?? defaultDbPath();

  const SqliteDb = loadSqlite();
  let db: SqliteDatabase | undefined;
  let availability: AphroditeAvailability = "unknown";
  const counters: Omit<AphroditeStatus, "availability"> = {
    attempts: 0,
    stored: 0,
    originalBytes: 0,
    markerBytes: 0,
    retrieves: 0,
    failures: 0,
    unavailableSkips: 0,
    lastFailure: undefined,
  };

  function recordFailure(failure: AphroditeFailureKind): void {
    counters.failures += 1;
    counters.lastFailure = failure;
    if (failure === "unavailable") {
      availability = "unavailable";
    }
  }

  function ensureDb(): SqliteDatabase | undefined {
    if (db) {
      return db;
    }

    try {
      mkdirSync(dirname(dbPath), { recursive: true });
      const opened = new SqliteDb(dbPath);
      opened.exec(
        "CREATE TABLE IF NOT EXISTS ccr (" +
          "hash TEXT PRIMARY KEY, " +
          "content TEXT NOT NULL, " +
          "original_size INTEGER NOT NULL, " +
          "created_at INTEGER NOT NULL DEFAULT (unixepoch())" +
          ")",
      );
      db = opened;
      availability = "available";
      return db;
    } catch {
      recordFailure("unavailable");
      return undefined;
    }
  }

  return {
    async store(content, type) {
      if (availability === "unavailable") {
        counters.unavailableSkips += 1;
        return undefined;
      }

      counters.attempts += 1;

      const handle = ensureDb();
      if (!handle) {
        return undefined;
      }

      try {
        const hash = hashContent(content);
        const originalSize = Buffer.byteLength(content, "utf8");
        handle
          .prepare(
            "INSERT OR IGNORE INTO ccr (hash, content, original_size) VALUES (?, ?, ?)",
          )
          .run(hash, content, originalSize);

        const markerSize = markerSizeFor(hash, type, originalSize);
        counters.stored += 1;
        counters.originalBytes += originalSize;
        counters.markerBytes += markerSize;

        return {
          hash,
          ratio: Math.round((originalSize / Math.max(markerSize, 1)) * 10) / 10,
          originalSize,
          compressedSize: originalSize,
          markerSize,
        };
      } catch {
        recordFailure("failed");
        return undefined;
      }
    },

    async retrieve(hash, retrieveOptions) {
      if (availability === "unavailable") {
        throw new Error("aphrodite store is unavailable");
      }

      const handle = ensureDb();
      if (!handle) {
        throw new Error("aphrodite store is unavailable");
      }

      const row = handle
        .prepare("SELECT content FROM ccr WHERE hash = ?")
        .get(hash) as { content?: string } | undefined;

      if (!row || typeof row.content !== "string") {
        throw new Error(`CCR entry not found: ${hash}`);
      }

      counters.retrieves += 1;

      let lines = row.content.split("\n");
      const query = retrieveOptions.query?.toLowerCase();
      if (query) {
        lines = lines.filter((line) => line.toLowerCase().includes(query));
      }

      const offset = Math.max(0, retrieveOptions.offset ?? 0);
      const limit =
        retrieveOptions.limit && retrieveOptions.limit > 0
          ? retrieveOptions.limit
          : RETRIEVE_LINE_CAP;
      return lines.slice(offset, offset + limit).join("\n");
    },

    async probe() {
      ensureDb();
      return availability;
    },

    resetAvailability() {
      if (availability === "unavailable") {
        availability = "unknown";
      }
    },

    getStatus() {
      return { ...counters, availability };
    },

    close() {
      db?.close();
      db = undefined;
    },
  };
}

export function detectType(text: string, toolName: string | undefined): string {
  const trimmed = text.trimStart();
  const firstLine = trimmed.split("\n", 1)[0] ?? "";

  if (
    /^(error|Error|ERROR|Traceback|panic)/.test(firstLine) ||
    firstLine.startsWith("thread '")
  ) {
    return "error";
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Not actually JSON — fall through.
    }
  }

  if (/^diff --git /m.test(text) || /^@@ -\d+/m.test(text)) {
    return "diff";
  }

  if (toolName === "bash") {
    return "terminal";
  }

  if (toolName === "read") {
    return "code";
  }

  return "text";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }

  return `${(bytes / 1024).toFixed(1)}KB`;
}

export function buildPreview(
  text: string,
  toolName: string | undefined,
  type: string,
): string {
  const lines = text.split("\n");
  const firstMeaningful = lines.find((line) => line.trim().length > 0) ?? "";
  const hint =
    firstMeaningful.length > PREVIEW_FIRST_LINE_MAX
      ? `${firstMeaningful.slice(0, PREVIEW_FIRST_LINE_MAX)}…`
      : firstMeaningful;
  const label = toolName ?? "tool";

  return `[${label}:${type} ${lines.length}L ${formatBytes(text.length)} | ${hint}]`;
}

export function renderCompressedResult(
  preview: string,
  type: string,
  stored: AphroditeStored,
): string {
  return [
    preview,
    `<<<CCR:${stored.hash}|${type}|${stored.originalSize}>>>`,
    `Full output (${formatBytes(stored.originalSize)}) stored by pi-aphrodite. Use the aphrodite_retrieve tool with hash "${stored.hash}" to fetch it.`,
  ].join("\n");
}

function extractText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  const texts: string[] = [];

  for (const item of content) {
    if (typeof item !== "object" || item === null) {
      return undefined;
    }

    const typed = item as { type?: unknown; text?: unknown };
    if (typed.type !== "text" || typeof typed.text !== "string") {
      return undefined;
    }

    texts.push(typed.text);
  }

  return texts.join("\n");
}

function readMinBytes(): number {
  const raw = process.env.APHRODITE_MIN_BYTES;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MIN_BYTES;
}

function formatStatus(
  enabled: boolean,
  bashEnabled: boolean,
  status: AphroditeStatus,
): string {
  return [
    `aphrodite — state: ${enabled ? "on" : "off"}`,
    `user-bash: ${bashEnabled ? "on" : "off"}`,
    `store: ${status.availability}`,
    `stored: ${status.stored}/${status.attempts}`,
    `retrieves: ${status.retrieves}`,
    `context: ${formatBytes(status.originalBytes)} → ${formatBytes(status.markerBytes)} markers`,
    `unavailable skips: ${status.unavailableSkips}`,
    `last failure: ${status.lastFailure ?? "none"}`,
  ].join(" · ");
}

function updateFooter(
  ctx: ExtensionContext,
  enabled: boolean,
  availability: AphroditeAvailability,
): void {
  if (!ctx.hasUI) {
    return;
  }

  const text = !enabled
    ? "aphrodite:off"
    : `aphrodite:on·${availability === "available" ? "up" : availability === "unavailable" ? "down" : "…"}`;
  const color = !enabled
    ? "warning"
    : availability === "available"
      ? "success"
      : availability === "unavailable"
        ? "error"
        : "accent";

  ctx.ui.setStatus("pi-aphrodite", ctx.ui.theme.fg(color, text));
}

export function registerPiAphrodite(
  pi: ExtensionAPI,
  client: AphroditeClient = createLocalAphroditeClient(),
  minBytes: number = readMinBytes(),
): void {

  const localBashOperations = createLocalBashOperations();
  let enabled = true;
  let bashEnabled = true;
  let lastPublished: string | undefined;

  function publishFooter(ctx: ExtensionContext): void {
    if (!ctx.hasUI) {
      return;
    }

    const availability = client.getStatus().availability;
    const key = `${enabled}:${availability}`;
    if (key === lastPublished) {
      return;
    }

    lastPublished = key;
    updateFooter(ctx, enabled, availability);
  }

  async function compressIfUseful(
    text: string,
    toolName: string | undefined,
  ): Promise<string | undefined> {
    // Never compress our own retrieve output — that would make stored
    // content unreachable above minBytes.
    if (toolName === "aphrodite_retrieve") {
      return undefined;
    }

    if (!enabled) {
      return undefined;
    }

    if (Buffer.byteLength(text, "utf8") < minBytes) {
      return undefined;
    }

    const type = detectType(text, toolName);
    const stored = await client.store(text, type);
    if (!stored) {
      return undefined;
    }

    const preview = buildPreview(text, toolName, type);
    return renderCompressedResult(preview, type, stored);
  }

  pi.registerCommand("aphrodite", {
    description: "Toggle or inspect Aphrodite tool output compression",
    getArgumentCompletions(prefix) {
      const items = ["on", "off", "status", "bash on", "bash off"].map((value) => ({
        value,
        label: value,
      }));
      const matches = items.filter((item) => item.value.startsWith(prefix));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();

      if (action === "status") {
        const availability = await client.probe();
        publishFooter(ctx);
        ctx.ui.notify(
          formatStatus(enabled, bashEnabled, { ...client.getStatus(), availability }),
          "info",
        );
        return;
      }

      if (action === "" || action === "on" || action === "off") {
        enabled = action === "" ? !enabled : action === "on";

        if (enabled) {
          client.resetAvailability();
        }

        publishFooter(ctx);
        ctx.ui.notify(
          `aphrodite ${enabled ? "on" : "off"}`,
          enabled ? "info" : "warning",
        );
        return;
      }

      if (action === "bash" || action === "bash on" || action === "bash off") {
        bashEnabled = action === "bash" ? !bashEnabled : action === "bash on";
        ctx.ui.notify(
          `aphrodite user-bash compression ${bashEnabled ? "on" : "off"}`,
          bashEnabled ? "info" : "warning",
        );
        return;
      }

      ctx.ui.notify(
        "Usage: /aphrodite [on|off|status|bash [on|off]]",
        "warning",
      );
    },
  });

  pi.registerTool({
    name: "aphrodite_retrieve",
    label: "Aphrodite Retrieve",
    description:
      "Retrieve the full original output behind a <<<CCR:hash|type|size>>> marker that pi-aphrodite substituted for oversized tool output. Supports case-insensitive per-line filtering and line-window pagination.",
    promptSnippet:
      "Fetch original tool output stored behind a CCR compression marker",
    promptGuidelines: [
      "Use aphrodite_retrieve when a tool result contains a <<<CCR:...>>> marker and its preview line is not enough to answer.",
      "Pass aphrodite_retrieve the full hash from the <<<CCR:hash|type|size>>> marker; the hash alone is sufficient.",
      "Use aphrodite_retrieve's query parameter to filter lines instead of pulling the whole document when the stored output is large.",
    ],
    parameters: Type.Object({
      hash: Type.String({
        description: "Hash from the <<<CCR:hash|type|size>>> marker.",
      }),
      query: Type.Optional(
        Type.String({
          description: "Case-insensitive substring filter applied per line.",
        }),
      ),
      offset: Type.Optional(
        Type.Number({ description: "0-based line offset for pagination." }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max lines to return (0 = default cap)." }),
      ),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        const content = await client.retrieve(params.hash, {
          query: params.query,
          offset: params.offset,
          limit: params.limit,
        });
        return {
          content: [{ type: "text", text: content }],
          details: { hash: params.hash } as { hash: string; error?: string },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: "text", text: `aphrodite_retrieve failed: ${message}` },
          ],
          details: { hash: params.hash, error: message },
        };
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    publishFooter(ctx);
    // Open the store once per session so the footer reflects store health
    // even before the first compressible tool result.
    void client.probe().then(() => publishFooter(ctx));
  });

  pi.on("tool_result", async (event, ctx) => {
    const text = extractText(event.content);
    if (text === undefined) {
      return;
    }

    const compressed = await compressIfUseful(text, event.toolName);
    publishFooter(ctx);
    if (!compressed) {
      return;
    }

    return { content: [{ type: "text", text: compressed }] };
  });

  // User `!<cmd>` output lands in model context, so it gets the same
  // compression path as tool results. BashOperations.exec streams via
  // onData, which means buffering: no live output while the command runs.
  // Users who want a live view use `!!<cmd>` (excluded from context,
  // never intercepted) or `/aphrodite bash off`.
  pi.on("user_bash", (event, ctx) => {
    if (event.excludeFromContext || !enabled || !bashEnabled) {
      return;
    }

    return {
      operations: {
        exec: async (command, cwd, options) => {
          const chunks: Buffer[] = [];
          const result = await localBashOperations.exec(command, cwd, {
            ...options,
            onData: (data: Buffer) => {
              chunks.push(data);
            },
          });

          const raw = Buffer.concat(chunks).toString("utf8");
          const compressed = await compressIfUseful(raw, "bash");
          const finalText = compressed ?? raw;
          if (finalText.length > 0) {
            options.onData(Buffer.from(finalText));
          }

          publishFooter(ctx);
          return result;
        },
      },
    };
  });
}

export default function (pi: ExtensionAPI) {
  registerPiAphrodite(pi);
}
