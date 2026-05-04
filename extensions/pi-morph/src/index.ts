import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Text } from "@mariozechner/pi-tui";
import {
  formatSize,
  getAgentDir,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const EXTENSION_SETTINGS_KEY = "morph";
const DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh/v1";
const DEFAULT_MODEL = "morph/morph-v3-large";
const DEFAULT_API_KEY_PROVIDER = "vercel-ai-gateway";
const EXISTING_CODE_MARKER = "// ... existing code ...";
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const FULL_REPLACEMENT_LINE_LIMIT = 10;
const REQUEST_TIMEOUT_MS = 60_000;

interface MorphSettings {
  enabled: boolean;
  model: string;
  baseUrl: string;
  apiKeyProvider: string;
  maxFileBytes: number;
  maxOutputBytes: number;
  allowFullReplacement: boolean;
  showStatus: boolean;
  provider?: unknown;
  providerOptions?: unknown;
}

const DEFAULT_SETTINGS: MorphSettings = {
  enabled: true,
  model: DEFAULT_MODEL,
  baseUrl: DEFAULT_BASE_URL,
  apiKeyProvider: DEFAULT_API_KEY_PROVIDER,
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  allowFullReplacement: false,
  showStatus: true,
};

const morphEditSchema = Type.Object(
  {
    target_filepath: Type.String({ description: "Path of the existing file to modify" }),
    instructions: Type.String({
      description:
        "Brief first-person description of the intended edit, e.g. 'I am adding request logging to the middleware setup.'",
    }),
    code_edit: Type.String({
      description:
        `Partial code edit using ${JSON.stringify(EXISTING_CODE_MARKER)} markers for unchanged sections. Include unique context around each changed region.`,
    }),
  },
  { additionalProperties: false },
);

type MorphEditParams = {
  target_filepath: string;
  instructions: string;
  code_edit: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : undefined;
}

function parseSettings(raw: unknown): Partial<MorphSettings> {
  if (typeof raw === "boolean") return { enabled: raw };
  if (!isRecord(raw)) return {};

  const out: Partial<MorphSettings> = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.model === "string" && raw.model.trim()) out.model = raw.model.trim();
  if (typeof raw.baseUrl === "string" && raw.baseUrl.trim()) out.baseUrl = raw.baseUrl.trim().replace(/\/+$/, "");
  if (typeof raw.apiKeyProvider === "string" && raw.apiKeyProvider.trim()) out.apiKeyProvider = raw.apiKeyProvider.trim();
  if (typeof raw.allowFullReplacement === "boolean") out.allowFullReplacement = raw.allowFullReplacement;
  if (typeof raw.showStatus === "boolean") out.showStatus = raw.showStatus;

  const maxFileBytes = parsePositiveInteger(raw.maxFileBytes);
  if (maxFileBytes !== undefined) out.maxFileBytes = maxFileBytes;
  const maxOutputBytes = parsePositiveInteger(raw.maxOutputBytes);
  if (maxOutputBytes !== undefined) out.maxOutputBytes = maxOutputBytes;

  if (isRecord(raw.provider)) out.provider = raw.provider;
  if (isRecord(raw.providerOptions)) out.providerOptions = raw.providerOptions;

  return out;
}

function pickSettings(parsed: Record<string, unknown>): unknown {
  const extensionSettings = parsed.extensionSettings;
  if (!isRecord(extensionSettings)) return undefined;
  return extensionSettings[EXTENSION_SETTINGS_KEY] ?? extensionSettings["pi-morph"];
}

function readSettingsFile(path: string): Partial<MorphSettings> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!isRecord(parsed)) return {};
    return parseSettings(pickSettings(parsed));
  } catch {
    return {};
  }
}

function loadSettings(cwd: string): MorphSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...readSettingsFile(join(getAgentDir(), "settings.json")),
    ...readSettingsFile(join(cwd, ".pi", "settings.json")),
  };
}

function expandPath(filePath: string): string {
  const normalized = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  if (normalized === "~") return process.env.HOME ?? normalized;
  if (normalized.startsWith("~/")) return `${process.env.HOME ?? "~"}${normalized.slice(1)}`;
  return normalized;
}

function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Aborted");
}

function normalizeCodeEditInput(codeEdit: string): string {
  const trimmed = codeEdit.trim();
  const lines = trimmed.split("\n");
  if (lines.length < 3) return codeEdit;

  const firstLine = lines[0] ?? "";
  const lastLine = lines[lines.length - 1] ?? "";
  if (/^```[\w-]*$/.test(firstLine) && /^```$/.test(lastLine)) {
    return lines.slice(1, -1).join("\n");
  }

  return codeEdit;
}

function stripOuterCodeFence(text: string): string {
  const trimmed = text.trim();
  const lines = trimmed.split("\n");
  if (lines.length < 3) return text;

  const firstLine = lines[0] ?? "";
  const lastLine = lines[lines.length - 1] ?? "";
  if (/^```[\w-]*$/.test(firstLine) && /^```$/.test(lastLine)) {
    return lines.slice(1, -1).join("\n");
  }

  return text;
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "\r\n" : "\n";
}

function normalizeLineEndings(text: string, eol: "\n" | "\r\n"): string {
  const lf = text.replace(/\r\n/g, "\n");
  return eol === "\n" ? lf : lf.replace(/\n/g, "\r\n");
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

async function writeTextAtomically(path: string, content: string, mode: number): Promise<void> {
  const tempPath = join(dirname(path), `.pi-morph-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await writeFile(tempPath, content, { encoding: "utf8", mode: mode & 0o7777 });
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function resolveApiKey(ctx: ExtensionContext, settings: MorphSettings): Promise<string | undefined> {
  const registry = ctx.modelRegistry as unknown as {
    getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
  };
  const fromRegistry = registry.getApiKeyForProvider
    ? await registry.getApiKeyForProvider(settings.apiKeyProvider).catch(() => undefined)
    : undefined;
  if (fromRegistry) return fromRegistry;

  if (settings.apiKeyProvider === DEFAULT_API_KEY_PROVIDER) return process.env.AI_GATEWAY_API_KEY;
  return process.env[settings.apiKeyProvider];
}

function buildPrompt(filepath: string, originalCode: string, codeEdit: string, instructions: string): string {
  return [
    `<filepath>${filepath}</filepath>`,
    "",
    "<code>",
    originalCode,
    "</code>",
    "",
    "<update>",
    codeEdit,
    "</update>",
    "",
    "<instruction>",
    instructions,
    "",
    "Merge the update into the original file.",
    "Return only the complete merged file content.",
    "Do not return markdown fences, XML tags, explanations, or a diff.",
    "Preserve existing style and indentation.",
    "</instruction>",
  ].join("\n");
}

function extractAssistantText(payload: unknown): string {
  if (!isRecord(payload)) throw new Error("AI Gateway returned a non-object response.");
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new Error("AI Gateway returned no choices.");
  const first = choices[0];
  if (!isRecord(first)) throw new Error("AI Gateway returned a malformed choice.");
  const message = first.message;
  if (!isRecord(message)) throw new Error("AI Gateway returned a choice without a message.");
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  throw new Error("AI Gateway returned a message without text content.");
}

async function callAiGateway(settings: MorphSettings, apiKey: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signals = signal ? [signal, timeout] : [timeout];

  const body: Record<string, unknown> = {
    model: settings.model,
    messages: [{ role: "user", content: prompt }],
    stream: false,
  };
  if (settings.provider !== undefined) body.provider = settings.provider;
  if (settings.providerOptions !== undefined) body.providerOptions = settings.providerOptions;

  const response = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any(signals),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`AI Gateway request failed (${response.status} ${response.statusText}): ${text.slice(0, 1000)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`AI Gateway returned invalid JSON: ${text.slice(0, 500)}`);
  }

  return stripOuterCodeFence(extractAssistantText(json));
}

function summarizeChange(original: string, merged: string): { text: string; changed: boolean; oldLines: number; newLines: number } {
  if (original === merged) {
    const lineCount = original.split("\n").length;
    return { text: "No changes detected.", changed: false, oldLines: lineCount, newLines: lineCount };
  }

  const oldLines = original.split("\n");
  const newLines = merged.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;

  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix] === newLines[newSuffix]) {
    oldSuffix--;
    newSuffix--;
  }

  const removed = Math.max(0, oldSuffix - prefix + 1);
  const added = Math.max(0, newSuffix - prefix + 1);
  const startLine = prefix + 1;
  const oldPreview = oldLines.slice(prefix, Math.min(oldSuffix + 1, prefix + 12));
  const newPreview = newLines.slice(prefix, Math.min(newSuffix + 1, prefix + 12));

  const parts = [
    `Changed around line ${startLine}: +${added} -${removed} lines in changed window`,
    "",
    "```diff",
    ...oldPreview.map((line) => `-${line}`),
    ...(removed > oldPreview.length ? ["-... (removed preview truncated)"] : []),
    ...newPreview.map((line) => `+${line}`),
    ...(added > newPreview.length ? ["+... (added preview truncated)"] : []),
    "```",
  ];

  return { text: parts.join("\n"), changed: true, oldLines: oldLines.length, newLines: newLines.length };
}

function validateMergedOutput(
  original: string,
  merged: string,
  codeEdit: string,
  settings: MorphSettings,
): void {
  const hasMarkers = codeEdit.includes(EXISTING_CODE_MARKER);
  const originalHadMarker = original.includes(EXISTING_CODE_MARKER);

  if (hasMarkers && !originalHadMarker && merged.includes(EXISTING_CODE_MARKER)) {
    throw new Error(
      `Morph output still contains ${JSON.stringify(EXISTING_CODE_MARKER)}. No file changes were written. Retry with more concrete context or use edit.`,
    );
  }

  const outputBytes = byteLength(merged);
  if (outputBytes > settings.maxOutputBytes) {
    throw new Error(
      `Morph output is ${formatSize(outputBytes)}, over maxOutputBytes=${formatSize(settings.maxOutputBytes)}. No file changes were written.`,
    );
  }

  if (hasMarkers && original.length > 0) {
    const originalLineCount = original.split("\n").length;
    const mergedLineCount = merged.split("\n").length;
    const charLoss = (original.length - merged.length) / original.length;
    const lineLoss = (originalLineCount - mergedLineCount) / originalLineCount;

    if (charLoss > 0.6 && lineLoss > 0.5) {
      throw new Error(
        `Morph output looks destructively truncated (${Math.round(charLoss * 100)}% chars, ${Math.round(lineLoss * 100)}% lines lost). No file changes were written.`,
      );
    }
  }
}

async function applyMorphEdit(params: MorphEditParams, settings: MorphSettings, signal: AbortSignal | undefined, ctx: ExtensionContext) {
  const targetPath = resolveToCwd(params.target_filepath, ctx.cwd);
  const normalizedCodeEdit = normalizeCodeEditInput(params.code_edit);

  return withFileMutationQueue(targetPath, async () => {
    throwIfAborted(signal);

    let fileStat;
    try {
      fileStat = await stat(targetPath);
    } catch {
      throw new Error(`File not found: ${params.target_filepath}. Use write for new files; morph_edit edits existing files.`);
    }

    if (!fileStat.isFile()) throw new Error(`Not a regular file: ${params.target_filepath}`);
    if (fileStat.size > settings.maxFileBytes) {
      throw new Error(
        `Refusing to send ${params.target_filepath} (${formatSize(fileStat.size)}) to Morph; maxFileBytes=${formatSize(settings.maxFileBytes)}.`,
      );
    }

    const original = await readFile(targetPath, "utf8");
    const hasMarkers = normalizedCodeEdit.includes(EXISTING_CODE_MARKER);
    const originalLineCount = original.split("\n").length;
    if (!hasMarkers && !settings.allowFullReplacement && originalLineCount > FULL_REPLACEMENT_LINE_LIMIT) {
      throw new Error(
        `Missing ${JSON.stringify(EXISTING_CODE_MARKER)} markers. Without markers, Morph may replace the whole ${originalLineCount}-line file. Use markers or set allowFullReplacement=true.`,
      );
    }

    const apiKey = await resolveApiKey(ctx, settings);
    if (!apiKey) {
      throw new Error(
        `No Vercel AI Gateway API key found for provider ${JSON.stringify(settings.apiKeyProvider)}. Set AI_GATEWAY_API_KEY or store a key via Pi /login for Vercel AI Gateway.`,
      );
    }

    const prompt = buildPrompt(params.target_filepath, original, normalizedCodeEdit, params.instructions);
    const eol = detectLineEnding(original);
    const mergedRaw = await callAiGateway(settings, apiKey, prompt, signal);
    throwIfAborted(signal);

    const merged = normalizeLineEndings(mergedRaw, eol);
    validateMergedOutput(original, merged, normalizedCodeEdit, settings);

    const summary = summarizeChange(original, merged);
    if (summary.changed) {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeTextAtomically(targetPath, merged, fileStat.mode);
    }

    const originalBytes = byteLength(original);
    const mergedBytes = byteLength(merged);
    const text = [
      `${summary.changed ? "Applied" : "No-op"} Morph edit to ${params.target_filepath}`,
      `${summary.oldLines} → ${summary.newLines} lines, ${formatSize(originalBytes)} → ${formatSize(mergedBytes)}`,
      "",
      summary.text,
    ].join("\n");

    return {
      content: [{ type: "text" as const, text }],
      details: {
        path: targetPath,
        model: settings.model,
        changed: summary.changed,
        oldLines: summary.oldLines,
        newLines: summary.newLines,
        oldBytes: originalBytes,
        newBytes: mergedBytes,
      },
    };
  });
}

async function updateStatus(ctx: ExtensionContext): Promise<void> {
  const settings = loadSettings(ctx.cwd);
  if (!settings.showStatus) {
    ctx.ui.setStatus("morph", undefined);
    return;
  }

  if (!settings.enabled) {
    ctx.ui.setStatus("morph", ctx.ui.theme.fg("dim", "morph:off"));
    return;
  }

  const key = await resolveApiKey(ctx, settings).catch(() => undefined);
  ctx.ui.setStatus("morph", key ? ctx.ui.theme.fg("accent", "morph") : ctx.ui.theme.fg("warning", "morph:no-key"));
}

export default function piMorph(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await updateStatus(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    await updateStatus(ctx);
  });

  pi.registerCommand("morph-status", {
    description: "Show pi-morph configuration and Vercel AI Gateway key status",
    handler: async (_args, ctx) => {
      const settings = loadSettings(ctx.cwd);
      const key = await resolveApiKey(ctx, settings).catch(() => undefined);
      const lines = [
        `pi-morph: ${settings.enabled ? "enabled" : "disabled"}`,
        `model: ${settings.model}`,
        `baseUrl: ${settings.baseUrl}`,
        `apiKeyProvider: ${settings.apiKeyProvider}`,
        `key: ${key ? "available" : "missing"}`,
        `maxFileBytes: ${formatSize(settings.maxFileBytes)}`,
        `maxOutputBytes: ${formatSize(settings.maxOutputBytes)}`,
        `allowFullReplacement: ${settings.allowFullReplacement}`,
        "config: ~/.pi/agent/settings.json#extensionSettings.morph, .pi/settings.json#extensionSettings.morph",
      ];
      ctx.ui.notify(lines.join("\n"), key && settings.enabled ? "info" : "warning");
      await updateStatus(ctx);
    },
  });

  pi.registerTool({
    name: "morph_edit",
    label: "Morph Edit",
    description: [
      `Edit an existing UTF-8 file using Morph via Vercel AI Gateway (${DEFAULT_MODEL} by default).`,
      `Provide a partial code_edit with ${JSON.stringify(EXISTING_CODE_MARKER)} markers for unchanged sections; Morph merges it into the full file.`,
      "Best for large files, multiple scattered changes, repetitive structures, or ambiguous exact replacements.",
      "Use Pi's regular edit for small exact changes and write for new files.",
      "The tool validates marker leakage, destructive truncation, and configured output size before writing.",
      "Credentials use Pi's normal Vercel AI Gateway provider lookup (AI_GATEWAY_API_KEY or auth.json provider vercel-ai-gateway).",
    ].join("\n"),
    promptSnippet: "Merge partial code edits into existing files via Morph on Vercel AI Gateway",
    promptGuidelines: [
      "Use morph_edit for large, scattered, whitespace-sensitive, repetitive, or ambiguous edits inside an existing file.",
      "Use morph_edit with code_edit wrapped by // ... existing code ... markers at both start and end so unchanged code is preserved.",
      "Use morph_edit with 1-2 unique context lines around each edited region to disambiguate repeated patterns.",
      "Use regular edit for small exact replacements and write for new files instead of morph_edit.",
      "If morph_edit fails, retry with more concrete context or fall back to regular edit.",
    ],
    parameters: morphEditSchema,

    renderCall(args: MorphEditParams, theme: any, context: any) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(`${theme.fg("toolTitle", theme.bold("morph_edit"))} ${theme.fg("accent", args.target_filepath ?? "...")}`);
      return text;
    },

    renderResult(result, { isPartial }: { isPartial: boolean }, theme: any, context: any) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      if (isPartial) {
        text.setText(theme.fg("warning", "Morph merging..."));
        return text;
      }
      const body =
        result.content
          ?.map((entry: { type: string; text?: string }) => (entry.type === "text" ? entry.text ?? "" : ""))
          .filter((entry: string) => entry.length > 0)
          .join("\n") ?? "";
      text.setText(context.isError ? theme.fg("error", body) : body);
      return text;
    },

    async execute(_toolCallId, params: MorphEditParams, signal, onUpdate, ctx) {
      const settings = loadSettings(ctx.cwd);
      if (!settings.enabled) throw new Error("pi-morph is disabled by extensionSettings.morph.enabled=false.");

      onUpdate?.({ content: [{ type: "text" as const, text: `Morph merging ${params.target_filepath}...` }] });
      return applyMorphEdit(params, settings, signal, ctx);
    },
  });
}
