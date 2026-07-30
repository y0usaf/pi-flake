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
 * - APHRODITE_TOOL_THRESHOLD       minimum byte size to compress generic
 *                                  tool output (default 16384)
 * - APHRODITE_TERMINAL_THRESHOLD   minimum byte size to compress shell
 *                                  output (default 8192); applies to the
 *                                  bash tool and user `!<cmd>` output alike
 * - APHRODITE_SKIP_TOOLS           comma-separated tool names whose output
 *                                  is never compressed (default "read");
 *                                  set to an empty string to compress all
 * - APHRODITE_MIN_BYTES            legacy fallback for both thresholds when
 *                                  the specific knob is unset
 * - APHRODITE_DB_PATH              SQLite file for the CCR store (default
 *                                  $XDG_STATE_HOME/pi/aphrodite-ccr.db or
 *                                  ~/.local/state/pi/aphrodite-ccr.db)
 * - APHRODITE_TTL_SECONDS          entry time-to-live (default 604800 = 7d;
 *                                  0 = never expire)
 *
 * Threshold and skip-list defaults are tuned from session telemetry rather
 * than copied from upstream Aphrodite: below roughly 16KB a compressed
 * result is retrieved in full about 90% of the time, so the extra request
 * needed to retrieve it costs more than the marker saves. `read` is skipped
 * for the same reason at any size — the model asks for a file because it
 * needs the file.
 *
 * Retention mirrors upstream Aphrodite's SqliteCcrStore: lazy TTL purge on
 * store/retrieve, debounced to one sweep per minute, no background thread.
 * Reads exclude expired rows even between sweeps; re-storing identical
 * content refreshes its TTL.
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
import { createLocalBashOperations, formatSize, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEFAULT_TOOL_THRESHOLD_BYTES = 16_384;
const DEFAULT_TERMINAL_THRESHOLD_BYTES = 8_192;
const DEFAULT_SKIP_TOOLS = "read";
const PREVIEW_FIRST_LINE_MAX = 120;
const RETRIEVE_LINE_CAP = 2000;
const HASH_HEX_LENGTH = 16;
const DEFAULT_TTL_SECONDS = 604_800;
const PURGE_DEBOUNCE_MS = 60_000;

// Context engine, ported from upstream Aphrodite's `[compression] engine_*`
// keys. Compression at insertion time forces a guess about future need and
// the model's cheapest safe guess is always "retrieve"; compressing turns
// that have already aged out needs no guess at all.
const DEFAULT_ENGINE_PERCENT = 45;
const DEFAULT_ENGINE_PROTECT_FIRST = 2;
const DEFAULT_ENGINE_PROTECT_LAST = 5;
const DEFAULT_ENGINE_MIN_MESSAGES = 8;
const DEFAULT_ENGINE_MIN_BYTES = 1024;
const CCR_MARKER_PATTERN = /<<<CCR:[0-9a-f]{16}\|/;

export type AphroditeAvailability = "unknown" | "available" | "unavailable";
export type AphroditeFailureKind = "failed" | "unavailable";

export interface AphroditeStatus {
  availability: AphroditeAvailability;
  attempts: number;
  stored: number;
  originalBytes: number;
  markerBytes: number;
  retrieves: number;
  purged: number;
  failures: number;
  unavailableSkips: number;
  ttlSeconds: number;
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
  ttlSeconds?: number;
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
  const ttlSeconds = options.ttlSeconds ?? readTtlSeconds();

  const SqliteDb = loadSqlite();
  let db: SqliteDatabase | undefined;
  let availability: AphroditeAvailability = "unknown";
  const counters: Omit<AphroditeStatus, "availability"> = {
    attempts: 0,
    stored: 0,
    originalBytes: 0,
    markerBytes: 0,
    retrieves: 0,
    purged: 0,
    failures: 0,
    unavailableSkips: 0,
    ttlSeconds,
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
          "created_at INTEGER NOT NULL DEFAULT (unixepoch()), " +
          "ttl_seconds INTEGER NOT NULL DEFAULT 0" +
          ")",
      );
      // Migrate pre-TTL databases: add the column, then stamp legacy rows
      // with the configured TTL so retention applies uniformly.
      try {
        opened.prepare("SELECT ttl_seconds FROM ccr LIMIT 0").get();
      } catch {
        opened.exec(
          "ALTER TABLE ccr ADD COLUMN ttl_seconds INTEGER NOT NULL DEFAULT 0",
        );
        opened.prepare("UPDATE ccr SET ttl_seconds = ?").run(ttlSeconds);
      }
      db = opened;
      availability = "available";
      return db;
    } catch {
      recordFailure("unavailable");
      return undefined;
    }
  }

  let lastPurgeMs = 0;

  // Lazy TTL purge, debounced to one sweep per minute — no background
  // thread, matching upstream Aphrodite's SqliteCcrStore. Reads also filter
  // expired rows, so a skipped sweep never resurrects them.
  function maybePurge(handle: SqliteDatabase): void {
    if (ttlSeconds <= 0) {
      return;
    }
    const now = Date.now();
    if (now - lastPurgeMs < PURGE_DEBOUNCE_MS) {
      return;
    }
    lastPurgeMs = now;
    try {
      const result = handle
        .prepare(
          "DELETE FROM ccr WHERE ttl_seconds > 0 AND created_at + ttl_seconds <= unixepoch()",
        )
        .run() as { changes?: number };
      counters.purged += result.changes ?? 0;
    } catch {
      // Best-effort: read-side filtering still hides expired rows.
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
        maybePurge(handle);

        const hash = hashContent(content);
        const originalSize = Buffer.byteLength(content, "utf8");
        // Upsert so re-storing identical content refreshes created_at and
        // ttl_seconds — same refresh semantics as upstream's SqliteCcrStore.
        handle
          .prepare(
            "INSERT INTO ccr (hash, content, original_size, ttl_seconds) VALUES (?, ?, ?, ?) " +
              "ON CONFLICT(hash) DO UPDATE SET " +
              "content = excluded.content, " +
              "original_size = excluded.original_size, " +
              "created_at = unixepoch(), " +
              "ttl_seconds = excluded.ttl_seconds",
          )
          .run(hash, content, originalSize, ttlSeconds);

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

      maybePurge(handle);

      const row = handle
        .prepare(
          "SELECT content FROM ccr WHERE hash = ? AND (ttl_seconds = 0 OR created_at + ttl_seconds > unixepoch())",
        )
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

  return `[${label}:${type} ${lines.length}L ${formatSize(text.length)} | ${hint}]`;
}

export function renderCompressedResult(
  preview: string,
  type: string,
  stored: AphroditeStored,
): string {
  return [
    preview,
    `<<<CCR:${stored.hash}|${type}|${stored.originalSize}>>>`,
    `Full output (${formatSize(stored.originalSize)}) stored by pi-aphrodite. Use the aphrodite_retrieve tool with hash "${stored.hash}" to fetch it.`,
  ].join("\n");
}

type ThemeLike = { fg(color: string, value: string): string };

/**
 * TUI body for an `aphrodite_retrieve` row. Pi's fallback result renderer
 * ignores `expanded` and prints every content line, so a retrieve of up to
 * RETRIEVE_LINE_CAP lines floods the transcript in collapsed rows too.
 * Collapsed rows get one summary line instead, matching the built-in `read`
 * tool; errors always render in full.
 */
export function formatRetrieveResult(
  text: string,
  options: { expanded: boolean; isError: boolean },
  theme: ThemeLike,
  expandHint: string,
): string {
  if (options.isError) {
    return theme.fg("error", text);
  }

  if (options.expanded) {
    return `\n${theme.fg("toolOutput", text)}`;
  }

  const lines = text.length === 0 ? 0 : text.split("\n").length;
  const summary = `${lines}L ${formatSize(Buffer.byteLength(text, "utf8"))} · `;
  return theme.fg("muted", summary) + expandHint;
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

export type AphroditeThresholds = {
  /** Minimum byte size to compress generic tool output. */
  tool: number;
  /** Minimum byte size to compress shell output (bash tool, user `!<cmd>`). */
  terminal: number;
};

function readByteEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readThresholds(): AphroditeThresholds {
  // APHRODITE_MIN_BYTES stays honored as a legacy fallback for both knobs.
  const legacy = readByteEnv("APHRODITE_MIN_BYTES", Number.NaN);
  const legacyOr = (def: number) =>
    Number.isFinite(legacy) ? legacy : def;
  return {
    tool: readByteEnv(
      "APHRODITE_TOOL_THRESHOLD",
      legacyOr(DEFAULT_TOOL_THRESHOLD_BYTES),
    ),
    terminal: readByteEnv(
      "APHRODITE_TERMINAL_THRESHOLD",
      legacyOr(DEFAULT_TERMINAL_THRESHOLD_BYTES),
    ),
  };
}

/**
 * Tool names whose output is never compressed, parsed from a comma-separated
 * list. Empty entries are dropped, so `""` means "compress every tool".
 */
export function parseSkipTools(raw: string): ReadonlySet<string> {
  return new Set(
    raw
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  );
}

function readSkipTools(): ReadonlySet<string> {
  const raw = process.env.APHRODITE_SKIP_TOOLS;
  return parseSkipTools(raw === undefined ? DEFAULT_SKIP_TOOLS : raw);
}

/**
 * Minimal shape the engine needs from a pi `AgentMessage`. Only tool results
 * are ever rewritten, and only their text content.
 */
type EngineMessage = {
  role: string;
  toolName?: string;
  content?: unknown;
};

export type AphroditeEngineConfig = {
  /** Context-window fill percentage that activates the engine; `0` disables it. */
  percent: number;
  /** Messages at the start of the conversation left untouched. */
  protectFirst: number;
  /** Messages at the end of the conversation left untouched. */
  protectLast: number;
  /** Minimum conversation length before the engine activates at all. */
  minMessages: number;
  /** Minimum byte size of an aged tool result before it is worth compressing. */
  minBytes: number;
};

function readCountEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readEngineConfig(): AphroditeEngineConfig {
  return {
    percent: readCountEnv("APHRODITE_ENGINE_PERCENT", DEFAULT_ENGINE_PERCENT),
    protectFirst: readCountEnv(
      "APHRODITE_ENGINE_PROTECT_FIRST",
      DEFAULT_ENGINE_PROTECT_FIRST,
    ),
    protectLast: readCountEnv(
      "APHRODITE_ENGINE_PROTECT_LAST",
      DEFAULT_ENGINE_PROTECT_LAST,
    ),
    minMessages: readCountEnv(
      "APHRODITE_ENGINE_MIN_MESSAGES",
      DEFAULT_ENGINE_MIN_MESSAGES,
    ),
    minBytes: readByteEnv(
      "APHRODITE_ENGINE_MIN_BYTES",
      DEFAULT_ENGINE_MIN_BYTES,
    ),
  };
}

/**
 * Half-open index range `[start, end)` of messages the engine may compress:
 * everything except the protected head and tail. Returns an empty range when
 * the conversation is too short or the protected windows overlap.
 */
export function engineCandidateRange(
  messageCount: number,
  config: AphroditeEngineConfig,
): { start: number; end: number } {
  if (messageCount < config.minMessages) {
    return { start: 0, end: 0 };
  }

  const start = config.protectFirst;
  const end = messageCount - config.protectLast;
  return end > start ? { start, end } : { start: 0, end: 0 };
}

function readTtlSeconds(): number {
  const raw = process.env.APHRODITE_TTL_SECONDS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TTL_SECONDS;
}

function formatTtl(seconds: number): string {
  if (seconds % 86400 === 0) {
    return `${seconds / 86400}d`;
  }
  if (seconds % 3600 === 0) {
    return `${seconds / 3600}h`;
  }
  return `${seconds}s`;
}

function formatStatus(
  enabled: boolean,
  bashEnabled: boolean,
  status: AphroditeStatus,
  skipTools: ReadonlySet<string>,
  engine: AphroditeEngineConfig,
  engineCompressed: number,
): string {
  return [
    `aphrodite — state: ${enabled ? "on" : "off"}`,
    `user-bash: ${bashEnabled ? "on" : "off"}`,
    `store: ${status.availability}`,
    `ttl: ${status.ttlSeconds === 0 ? "off" : formatTtl(status.ttlSeconds)}`,
    `skip: ${skipTools.size > 0 ? [...skipTools].join(",") : "none"}`,
    `engine: ${engine.percent > 0 ? `${engine.percent}%` : "off"}`,
    `engine compressed: ${engineCompressed}`,
    `stored: ${status.stored}/${status.attempts}`,
    `retrieves: ${status.retrieves}`,
    `purged: ${status.purged}`,
    `context: ${formatSize(status.originalBytes)} → ${formatSize(status.markerBytes)} markers`,
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

  const color = !enabled
    ? "muted"
    : availability === "available"
      ? "success"
      : availability === "unavailable"
        ? "error"
        : "accent";

  ctx.ui.setStatus("pi-aphrodite", ctx.ui.theme.fg(color, "aphrodite"));
}

export function registerPiAphrodite(
  pi: ExtensionAPI,
  client: AphroditeClient = createLocalAphroditeClient(),
  thresholds: AphroditeThresholds = readThresholds(),
  skipTools: ReadonlySet<string> = readSkipTools(),
  engine: AphroditeEngineConfig = readEngineConfig(),
): void {

  const localBashOperations = createLocalBashOperations();
  let enabled = true;
  let bashEnabled = true;
  let engineCompressed = 0;
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
    // content unreachable above the tool threshold.
    if (toolName === "aphrodite_retrieve") {
      return undefined;
    }

    // Tools on the skip list are always passed through. `read` is skipped by
    // default: session telemetry shows its markers are retrieved in full ~97%
    // of the time, so compressing it buys a wasted round trip.
    if (toolName !== undefined && skipTools.has(toolName)) {
      return undefined;
    }

    if (!enabled) {
      return undefined;
    }

    // Route by output kind: shell output (the bash tool and user `!<cmd>`
    // alike) compresses at the lower bar; other tools get the higher one
    // since their full output is more often needed.
    const minBytes = toolName === "bash" ? thresholds.terminal : thresholds.tool;
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
          formatStatus(
            enabled,
            bashEnabled,
            { ...client.getStatus(), availability },
            skipTools,
            engine,
            engineCompressed,
          ),
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

    // Without this, pi falls back to printing every content line regardless
    // of the row's expanded state — a 2000-line retrieve in a collapsed row.
    renderResult(result, options, theme, context) {
      const component =
        context.lastComponent instanceof Text
          ? context.lastComponent
          : new Text("", 0, 0);

      if (options.isPartial) {
        component.setText(theme.fg("muted", "retrieving…"));
        return component;
      }

      const details = result.details as { error?: string } | undefined;
      component.setText(
        formatRetrieveResult(
          extractText(result.content) ?? "",
          {
            expanded: options.expanded,
            isError: context.isError || details?.error !== undefined,
          },
          theme,
          keyHint("app.tools.expand", "to expand"),
        ),
      );
      return component;
    },
  });

  pi.on("session_start", (_event, ctx) => {
    publishFooter(ctx);
    // Open the store once per session so the footer reflects store health
    // even before the first compressible tool result.
    void client.probe().then(() => publishFooter(ctx));
  });

  // Context engine. Fires before each LLM call and compresses tool results
  // that have aged out of the protected window, which is the compression that
  // needs no guess: the model already read them, several turns ago.
  //
  // Deliberately ignores `skipTools`. That list exists to stop *fresh* output
  // being hidden from a model that is about to read it; an aged `read` result
  // has no such claim.
  //
  // Prompt-cache note: replacing a message body invalidates the provider's
  // cached prefix from that point on. The pass is idempotent — a message that
  // already carries a CCR marker is skipped — so the prefix re-stabilises on
  // the following turn instead of churning every call.
  pi.on("context", async (event, ctx) => {
    if (!enabled || engine.percent <= 0) {
      return;
    }

    const messages = event.messages as EngineMessage[];
    const { start, end } = engineCandidateRange(messages.length, engine);
    if (start >= end) {
      return;
    }

    // `percent` is null when the token count is unknown (e.g. immediately
    // after a compaction). Compressing on a guess is worse than idling.
    const usage = ctx.getContextUsage?.();
    if (!usage || usage.percent === null || usage.percent < engine.percent) {
      return;
    }

    let changed = false;
    for (let index = start; index < end; index += 1) {
      const message = messages[index];
      if (!message || message.role !== "toolResult") {
        continue;
      }

      const text = extractText(message.content);
      if (text === undefined || CCR_MARKER_PATTERN.test(text)) {
        continue;
      }

      if (Buffer.byteLength(text, "utf8") < engine.minBytes) {
        continue;
      }

      const type = detectType(text, message.toolName);
      const stored = await client.store(text, type);
      if (!stored) {
        continue;
      }

      const preview = buildPreview(text, message.toolName, type);
      message.content = [
        { type: "text", text: renderCompressedResult(preview, type, stored) },
      ];
      engineCompressed += 1;
      changed = true;
    }

    return changed ? { messages: event.messages } : undefined;
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
