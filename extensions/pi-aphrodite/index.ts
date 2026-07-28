/**
 * pi-aphrodite — Pi extension that compresses oversized tool output through
 * an Aphrodite proxy's CCR store before it reaches the model context.
 *
 * The extension hooks the mutable `tool_result` event: raw output above
 * the byte threshold is POSTed to the Aphrodite proxy's `/ccr/create`
 * endpoint and replaced with a compact preview plus a
 * `<<<CCR:hash|type|size>>>` marker. The model can recover the original
 * text with the `aphrodite_retrieve` tool, which proxies `/retrieve`. Any
 * failure (proxy down, CCR disabled, timeout, abort) falls back silently
 * to the uncompressed output.
 *
 * User `!<cmd>` shell output is deliberately NOT intercepted:
 * `BashOperations.exec` streams via `onData` and only returns an exit code,
 * so compressing that path would mean buffering the stream and hiding live
 * output from the user — a bad trade for an explicitly user-run command.
 *
 * Aphrodite's compression pipeline is fully programmatic (regex classifier
 * + type-aware previews + BLAKE3/SQLite store); no model call happens
 * inside the compress step.
 *
 * Configuration:
 * - APHRODITE_URL        proxy base URL (default http://127.0.0.1:9797)
 * - APHRODITE_MGMT_TOKEN bearer token for the management endpoints (optional)
 * - APHRODITE_MIN_BYTES  minimum output size to compress (default 1024)
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { Type } from "typebox";

const DEFAULT_BASE_URL = "http://127.0.0.1:9797";
const DEFAULT_MIN_BYTES = 1024;
const REQUEST_TIMEOUT_MS = 4000;
const PROBE_TIMEOUT_MS = 1000;
const PREVIEW_FIRST_LINE_MAX = 120;

export type AphroditeAvailability = "unknown" | "available" | "unavailable";
export type AphroditeFailureKind =
  | "aborted"
  | "failed"
  | "timeout"
  | "unavailable";

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
    signal?: AbortSignal,
  ): Promise<AphroditeStored | undefined>;
  retrieve(
    hash: string,
    options: AphroditeRetrieveOptions,
    signal?: AbortSignal,
  ): Promise<string>;
  probe(signal?: AbortSignal): Promise<AphroditeAvailability>;
  resetAvailability(): void;
  getStatus(): AphroditeStatus;
}

export interface AphroditeClientOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  probeTimeoutMs?: number;
}

function combineSignals(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function classifyError(error: unknown): AphroditeFailureKind {
  const err = error as { name?: unknown } | null;

  if (err?.name === "AbortError") {
    return "aborted";
  }

  if (err?.name === "TimeoutError") {
    return "timeout";
  }

  if (err?.name === "CcrDisabledError") {
    return "unavailable";
  }

  // fetch TypeError = connection refused / DNS / socket — the proxy is not
  // there; plain Error with an HTTP status means it answered, so it exists.
  if (err instanceof TypeError) {
    return "unavailable";
  }

  return "failed";
}

export function createAphroditeClient(
  options: AphroditeClientOptions = {},
): AphroditeClient {
  const baseUrl = (
    options.baseUrl ??
    process.env.APHRODITE_URL ??
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  const token = options.token ?? process.env.APHRODITE_MGMT_TOKEN;
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;

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

  function authHeaders(): Record<string, string> {
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  function recordFailure(failure: AphroditeFailureKind): void {
    counters.failures += 1;
    counters.lastFailure = failure;

    if (failure === "unavailable") {
      availability = "unavailable";
    } else if (failure !== "aborted") {
      // HTTP-level failures prove the proxy itself is reachable.
      availability = "available";
    }
  }

  async function post(
    path: string,
    body: string,
    contentType: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Response> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": contentType, ...authHeaders() },
      body,
      signal: combineSignals(signal, timeoutMs),
    });

    if (response.status === 503) {
      const error = new Error("CCR not enabled on Aphrodite proxy");
      error.name = "CcrDisabledError";
      throw error;
    }

    if (!response.ok) {
      throw new Error(`aphrodite ${path} failed: HTTP ${response.status}`);
    }

    return response;
  }

  return {
    async store(content, signal) {
      if (availability === "unavailable") {
        counters.unavailableSkips += 1;
        return undefined;
      }

      counters.attempts += 1;

      try {
        const response = await post(
          "/ccr/create",
          content,
          "application/octet-stream",
          signal,
          requestTimeoutMs,
        );
        const json = (await response.json()) as {
          hash?: unknown;
          token_savings_ratio?: unknown;
          original_size?: unknown;
          compressed_size?: unknown;
          marker_size?: unknown;
        };

        if (typeof json.hash !== "string" || json.hash.length === 0) {
          recordFailure("failed");
          return undefined;
        }

        availability = "available";
        counters.stored += 1;
        counters.originalBytes +=
          typeof json.original_size === "number"
            ? json.original_size
            : content.length;
        counters.markerBytes +=
          typeof json.marker_size === "number" ? json.marker_size : 0;

        return {
          hash: json.hash,
          ratio:
            typeof json.token_savings_ratio === "number"
              ? json.token_savings_ratio
              : 0,
          originalSize:
            typeof json.original_size === "number"
              ? json.original_size
              : content.length,
          compressedSize:
            typeof json.compressed_size === "number"
              ? json.compressed_size
              : 0,
          markerSize:
            typeof json.marker_size === "number" ? json.marker_size : 0,
        };
      } catch (error) {
        recordFailure(classifyError(error));
        return undefined;
      }
    },

    async retrieve(hash, retrieveOptions, signal) {
      if (availability === "unavailable") {
        throw new Error("aphrodite proxy is unavailable");
      }

      const response = await post(
        "/retrieve",
        JSON.stringify({
          hash,
          query: retrieveOptions.query,
          offset: retrieveOptions.offset ?? 0,
          limit: retrieveOptions.limit ?? 0,
        }),
        "application/json",
        signal,
        requestTimeoutMs,
      );
      const json = (await response.json()) as {
        found?: boolean;
        content?: string | null;
        error?: string | null;
      };

      counters.retrieves += 1;

      if (!json.found) {
        throw new Error(json.error ?? `CCR entry not found: ${hash}`);
      }

      return json.content ?? "";
    },

    async probe(signal) {
      try {
        const response = await fetchImpl(`${baseUrl}/ccr/list`, {
          headers: authHeaders(),
          signal: combineSignals(signal, probeTimeoutMs),
        });
        availability = response.ok ? "available" : "unavailable";
      } catch (error) {
        recordFailure(classifyError(error));
      }

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

function formatStatus(enabled: boolean, status: AphroditeStatus): string {
  return [
    `aphrodite — state: ${enabled ? "on" : "off"}`,
    `proxy: ${status.availability}`,
    `stored: ${status.stored}/${status.attempts}`,
    `retrieves: ${status.retrieves}`,
    `context: ${formatBytes(status.originalBytes)} → ${formatBytes(status.markerBytes)} markers`,
    `unavailable skips: ${status.unavailableSkips}`,
    `last failure: ${status.lastFailure ?? "none"}`,
  ].join(" · ");
}

function updateFooter(ctx: ExtensionContext, enabled: boolean): void {
  if (!ctx.hasUI) {
    return;
  }

  ctx.ui.setStatus(
    "pi-aphrodite",
    ctx.ui.theme.fg(
      enabled ? "success" : "warning",
      enabled ? "aphrodite:on" : "aphrodite:off",
    ),
  );
}

export function registerPiAphrodite(
  pi: ExtensionAPI,
  client: AphroditeClient = createAphroditeClient(),
  minBytes: number = readMinBytes(),
): void {

  let enabled = true;

  async function compressIfUseful(
    text: string,
    toolName: string | undefined,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (!enabled) {
      return undefined;
    }

    if (Buffer.byteLength(text, "utf8") < minBytes) {
      return undefined;
    }

    const stored = await client.store(text, signal);
    if (!stored) {
      return undefined;
    }

    const type = detectType(text, toolName);
    const preview = buildPreview(text, toolName, type);
    return renderCompressedResult(preview, type, stored);
  }

  pi.registerCommand("aphrodite", {
    description: "Toggle or inspect Aphrodite tool output compression",
    getArgumentCompletions(prefix) {
      const items = ["on", "off", "status"].map((value) => ({
        value,
        label: value,
      }));
      const matches = items.filter((item) => item.value.startsWith(prefix));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();

      if (action === "status") {
        const availability = await client.probe(ctx.signal);
        ctx.ui.notify(
          formatStatus(enabled, { ...client.getStatus(), availability }),
          "info",
        );
        return;
      }

      if (action === "" || action === "on" || action === "off") {
        enabled = action === "" ? !enabled : action === "on";

        if (enabled) {
          client.resetAvailability();
        }

        updateFooter(ctx, enabled);
        ctx.ui.notify(
          `aphrodite ${enabled ? "on" : "off"}`,
          enabled ? "info" : "warning",
        );
        return;
      }

      ctx.ui.notify("Usage: /aphrodite [on|off|status]", "warning");
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
        description: "BLAKE3 hash from the <<<CCR:hash|type|size>>> marker.",
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
        Type.Number({ description: "Max lines to return (0 = server cap)." }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const content = await client.retrieve(
          params.hash,
          { query: params.query, offset: params.offset, limit: params.limit },
          signal,
        );
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
    updateFooter(ctx, enabled);
  });

  pi.on("tool_result", async (event, ctx) => {
    const text = extractText(event.content);
    if (text === undefined) {
      return;
    }

    const compressed = await compressIfUseful(text, event.toolName, ctx.signal);
    if (!compressed) {
      return;
    }

    return { content: [{ type: "text", text: compressed }] };
  });




}
export default function (pi: ExtensionAPI) {
  registerPiAphrodite(pi);
}
