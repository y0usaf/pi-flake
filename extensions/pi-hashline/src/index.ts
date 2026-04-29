import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access as fsAccess,
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import * as os from "node:os";
import { TextDecoder } from "node:util";
import { StringEnum } from "@mariozechner/pi-ai";
import {
  createReadTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const HASH_ALPHABET = "ZPMQVRWSNKTXJBYH";
const HASH_LENGTH = 3;
const HASH_RE = new RegExp(`^[${HASH_ALPHABET}]{${HASH_LENGTH}}$`);
const HASHLINE_PREFIX_RE = new RegExp(
  `^\\s*(?:>>>|>>)?\\s*\\d+\\s*#\\s*[${HASH_ALPHABET}]{${HASH_LENGTH}}:`,
);
const HASHLINE_PLUS_PREFIX_RE = new RegExp(
  `^\\+\\s*\\d+\\s*#\\s*[${HASH_ALPHABET}]{${HASH_LENGTH}}:`,
);
const DIFF_DELETE_PREFIX_RE = /^-\s*\d+\s{2,}/;
const SIGNIFICANT_RE = /[\p{L}\p{N}]/u;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

type Anchor = {
  line: number;
  hash: string;
};

type RawEdit = {
  op: string;
  pos?: string;
  end?: string;
  lines?: string[] | string | null;
  oldText?: string;
  newText?: string;
};

type EditRequest = {
  path: string;
  edits: RawEdit[];
};

type LineEdit = {
  requestIndex: number;
  label: string;
  start: number;
  end: number;
  lines: string[];
};

type StaleAnchor = {
  requested: Anchor;
  actual?: string;
  reason?: string;
};

type LoadedTextFile = {
  bom: string;
  text: string;
  lineEnding: "\n" | "\r\n";
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Aborted");
}

function expandPath(filePath: string): string {
  const normalized = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  if (normalized === "~") return os.homedir();
  if (normalized.startsWith("~/")) return os.homedir() + normalized.slice(1);
  return normalized;
}

function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  const crlf = text.indexOf("\r\n");
  const lf = text.indexOf("\n");
  if (crlf === -1 || lf === -1) return "\n";
  return crlf <= lf ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEnding(text: string, lineEnding: "\n" | "\r\n"): string {
  return lineEnding === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function stripBom(text: string): { bom: string; text: string } {
  return text.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: text.slice(1) }
    : { bom: "", text };
}

function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

function hasNullByte(buffer: Buffer): boolean {
  return buffer.includes(0);
}

function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throw new Error("File is not valid UTF-8 text.");
    }
    throw error;
  }
}

async function loadTextFile(path: string): Promise<LoadedTextFile> {
  const fileStat = await stat(path);
  if (fileStat.isDirectory()) {
    throw new Error("Path is a directory. Use ls to inspect directories.");
  }
  if (!fileStat.isFile()) {
    throw new Error("Path is not a regular file.");
  }

  const buffer = await readFile(path);
  if (hasNullByte(buffer)) {
    throw new Error("File appears to be binary (null bytes detected). Hashline tools only support UTF-8 text files.");
  }

  const decoded = decodeUtf8(buffer);
  const { bom, text } = stripBom(decoded);
  const lineEnding = detectLineEnding(text);
  return { bom, text: normalizeToLF(text), lineEnding };
}

async function getMutationTargetPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(path);
    throw error;
  }
}

async function writeTextFileAtomically(path: string, content: string): Promise<void> {
  const targetPath = await getMutationTargetPath(path);
  const currentStat = await stat(targetPath);

  if (currentStat.nlink > 1) {
    await writeFile(targetPath, content, "utf-8");
    return;
  }

  const dir = dirname(targetPath);
  const tempPath = join(dir, `.pi-hashline-${randomUUID()}.tmp`);
  await mkdir(dir, { recursive: true });
  await writeFile(tempPath, content, "utf-8");
  await chmod(tempPath, currentStat.mode & 0o7777);
  await rename(tempPath, targetPath);
}

function computeLineHash(lineNumber: number, line: string): string {
  const normalized = line.replace(/\r/g, "").trimEnd();
  const seed = SIGNIFICANT_RE.test(normalized)
    ? normalized
    : `${lineNumber}\0${normalized}`;
  const digest = createHash("sha256").update(seed).digest();
  const value = ((digest[0]! << 4) | (digest[1]! >> 4)) & 0xfff;
  return [
    HASH_ALPHABET[(value >> 8) & 0xf],
    HASH_ALPHABET[(value >> 4) & 0xf],
    HASH_ALPHABET[value & 0xf],
  ].join("");
}

function getVisibleLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

function joinVisibleLines(lines: string[], preserveTerminalNewline: boolean): string {
  if (lines.length === 0) return "";
  const joined = lines.join("\n");
  return preserveTerminalNewline ? `${joined}\n` : joined;
}

function normalizePositiveInteger(value: number | undefined, name: "offset" | "limit"): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Read request field "${name}" must be a positive integer.`);
  }
  return value;
}

function formatHashlineRegion(lines: string[], startLine: number): string {
  return lines
    .map((line, index) => {
      const lineNumber = startLine + index;
      return `${lineNumber}#${computeLineHash(lineNumber, line)}:${line}`;
    })
    .join("\n");
}

function formatHashlineReadPreview(
  text: string,
  options: { offset?: number; limit?: number },
): { text: string; truncation?: ReturnType<typeof truncateHead>; nextOffset?: number } {
  const allLines = getVisibleLines(text);
  const totalLines = allLines.length;
  const startLine = normalizePositiveInteger(options.offset, "offset") ?? 1;

  if (totalLines === 0) {
    return {
      text: startLine === 1
        ? "File is empty. Use edit with prepend or append and omit pos to insert content."
        : `Offset ${startLine} is beyond end of file (0 lines total). The file is empty.`,
    };
  }

  if (startLine > totalLines) {
    return {
      text: `Offset ${startLine} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`,
    };
  }

  const limit = normalizePositiveInteger(options.limit, "limit");
  const endIndex = limit ? Math.min(startLine - 1 + limit, totalLines) : totalLines;
  const selected = allLines.slice(startLine - 1, endIndex);
  const formatted = formatHashlineRegion(selected, startLine);
  const truncation = truncateHead(formatted);

  if (truncation.firstLineExceedsLimit) {
    return {
      text: `[Line ${startLine} exceeds ${formatSize(truncation.maxBytes)}. Hashline output requires full lines; cannot compute hashes for a truncated preview.]`,
      truncation,
    };
  }

  let preview = truncation.content;
  let nextOffset: number | undefined;

  if (truncation.truncated) {
    const endLineDisplay = startLine + truncation.outputLines - 1;
    nextOffset = endLineDisplay + 1;
    preview += truncation.truncatedBy === "lines"
      ? `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${totalLines}. Use offset=${nextOffset} to continue.]`
      : `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${totalLines} (${formatSize(truncation.maxBytes)} limit). Use offset=${nextOffset} to continue.]`;
  } else if (endIndex < totalLines) {
    nextOffset = endIndex + 1;
    preview += `\n\n[Showing lines ${startLine}-${endIndex} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
  }

  return {
    text: preview,
    ...(truncation.truncated ? { truncation } : {}),
    ...(nextOffset !== undefined ? { nextOffset } : {}),
  };
}

function parseAnchor(ref: string): Anchor {
  const core = ref.replace(/^\s*[>+-]*\s*/, "").trimEnd();
  const match = core.match(/^([0-9]+)\s*#\s*([^\s:]+)(?:\s*:.*)?$/s);
  if (!match) {
    throw new Error(`[E_BAD_REF] Invalid line reference ${JSON.stringify(ref)}. Expected "LINE#HASH" from read output, e.g. "12#K7Q".`);
  }

  const line = Number.parseInt(match[1]!, 10);
  if (!Number.isInteger(line) || line < 1) {
    throw new Error(`[E_BAD_REF] Line number must be >= 1 in ${JSON.stringify(ref)}.`);
  }

  const hash = match[2]!;
  if (hash.length !== HASH_LENGTH || !HASH_RE.test(hash)) {
    throw new Error(`[E_BAD_REF] Invalid hash in ${JSON.stringify(ref)}. Hashes are ${HASH_LENGTH} characters from ${HASH_ALPHABET}.`);
  }

  return { line, hash };
}

function stringifyAnchor(anchor: Anchor): string {
  return `${anchor.line}#${anchor.hash}`;
}

function parseEditLines(value: string[] | string | null | undefined, editIndex: number): string[] {
  if (value === undefined) {
    throw new Error(`Edit ${editIndex} requires a "lines" field.`);
  }
  if (value === null) return [];

  const lines = typeof value === "string"
    ? (value.endsWith("\n") ? value.slice(0, -1) : value).replaceAll("\r", "").split("\n")
    : value.map((line) => line.replaceAll("\r", ""));

  for (const line of lines) {
    if (
      HASHLINE_PREFIX_RE.test(line) ||
      HASHLINE_PLUS_PREFIX_RE.test(line) ||
      DIFF_DELETE_PREFIX_RE.test(line)
    ) {
      throw new Error(`[E_INVALID_PATCH] edits[${editIndex}].lines must contain literal file content, not rendered LINE#HASH or diff prefixes. Offending line: ${JSON.stringify(line)}`);
    }
  }

  return lines;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function prepareEditArguments(args: unknown): unknown {
  if (!isRecord(args) || Array.isArray(args.edits)) return args;
  const path = args.path;
  if (typeof path !== "string") return args;

  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    return {
      path,
      edits: [{ op: "replace_text", oldText: args.oldText, newText: args.newText }],
    };
  }

  if (typeof args.old_text === "string" && typeof args.new_text === "string") {
    return {
      path,
      edits: [{ op: "replace_text", oldText: args.old_text, newText: args.new_text }],
    };
  }

  return args;
}

function assertEditRequest(value: unknown): asserts value is EditRequest {
  if (!isRecord(value)) throw new Error("Edit request must be an object.");
  if (typeof value.path !== "string" || value.path.length === 0) {
    throw new Error('Edit request requires a non-empty "path" string.');
  }
  if (!Array.isArray(value.edits) || value.edits.length === 0) {
    throw new Error('Edit request requires a non-empty "edits" array.');
  }

  for (const [index, edit] of value.edits.entries()) {
    if (!isRecord(edit)) throw new Error(`Edit ${index} must be an object.`);
    const op = edit.op;
    if (op !== "replace" && op !== "append" && op !== "prepend" && op !== "replace_text") {
      throw new Error(`Edit ${index} uses unknown op ${JSON.stringify(op)}. Expected replace, append, prepend, or replace_text.`);
    }

    if ("pos" in edit && typeof edit.pos !== "string") {
      throw new Error(`Edit ${index} field "pos" must be a string when provided.`);
    }
    if ("end" in edit && typeof edit.end !== "string") {
      throw new Error(`Edit ${index} field "end" must be a string when provided.`);
    }

    if (op === "replace_text") {
      if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
        throw new Error(`Edit ${index} with op "replace_text" requires string oldText and newText.`);
      }
      if ("pos" in edit || "end" in edit || "lines" in edit) {
        throw new Error(`Edit ${index} with op "replace_text" only supports oldText and newText.`);
      }
      continue;
    }

    if (!("lines" in edit)) {
      throw new Error(`Edit ${index} requires a "lines" field.`);
    }
    if (
      edit.lines !== null &&
      typeof edit.lines !== "string" &&
      !(Array.isArray(edit.lines) && edit.lines.every((line) => typeof line === "string"))
    ) {
      throw new Error(`Edit ${index} field "lines" must be a string array, string, or null.`);
    }
    if ("oldText" in edit || "newText" in edit) {
      throw new Error(`Edit ${index} with op "${op}" does not support oldText/newText; use op "replace_text".`);
    }
    if (op === "replace" && typeof edit.pos !== "string") {
      throw new Error(`Edit ${index} with op "replace" requires a pos anchor.`);
    }
    if ((op === "append" || op === "prepend") && "end" in edit) {
      throw new Error(`Edit ${index} with op "${op}" does not support end.`);
    }
  }
}

function validateAnchor(anchor: Anchor, fileLines: string[], staleAnchors: StaleAnchor[]): void {
  const current = fileLines[anchor.line - 1];
  if (current === undefined) {
    staleAnchors.push({
      requested: anchor,
      reason: `line ${anchor.line} is outside current file range (1-${fileLines.length})`,
    });
    return;
  }

  const actual = computeLineHash(anchor.line, current);
  if (actual !== anchor.hash) {
    staleAnchors.push({ requested: anchor, actual });
  }
}

function formatStaleAnchorError(staleAnchors: StaleAnchor[], fileLines: string[]): string {
  const retryLines = new Set<number>();
  for (const stale of staleAnchors) {
    const line = stale.requested.line;
    if (line >= 1 && line <= fileLines.length) retryLines.add(line);
  }

  const displayLines = new Set<number>();
  for (const stale of staleAnchors) {
    const line = Math.max(1, Math.min(stale.requested.line, fileLines.length));
    for (let i = Math.max(1, line - 2); i <= Math.min(fileLines.length, line + 2); i++) {
      displayLines.add(i);
    }
  }

  const out = [
    `[E_STALE_ANCHOR] ${staleAnchors.length} stale or invalid anchor${staleAnchors.length === 1 ? "" : "s"}. Retry with the >>> LINE#HASH lines below, or call read again.`,
    "",
  ];

  for (const stale of staleAnchors) {
    const requested = stringifyAnchor(stale.requested);
    if (stale.reason) {
      out.push(`- ${requested}: ${stale.reason}`);
    } else {
      out.push(`- ${requested}: current hash is ${stale.actual}`);
    }
  }

  const sorted = [...displayLines].sort((a, b) => a - b);
  if (sorted.length > 0) {
    out.push("");
    let previous = -1;
    for (const lineNumber of sorted) {
      if (previous !== -1 && lineNumber > previous + 1) out.push("    ...");
      previous = lineNumber;
      const line = fileLines[lineNumber - 1]!;
      const prefix = `${lineNumber}#${computeLineHash(lineNumber, line)}`;
      out.push(`${retryLines.has(lineNumber) ? ">>>" : "   "} ${prefix}:${line}`);
    }
  }

  if (fileLines.length === 0) {
    out.push("Current file is empty. Use prepend/append with no pos to insert content.");
  }

  return out.join("\n");
}

function describeLineEdit(edit: RawEdit): string {
  switch (edit.op) {
    case "replace":
      return edit.end ? `replace ${edit.pos}-${edit.end}` : `replace ${edit.pos}`;
    case "append":
      return edit.pos ? `append after ${edit.pos}` : "append at EOF";
    case "prepend":
      return edit.pos ? `prepend before ${edit.pos}` : "prepend at BOF";
    default:
      return edit.op;
  }
}

function resolveLineEdits(edits: RawEdit[], fileLines: string[]): LineEdit[] {
  const staleAnchors: StaleAnchor[] = [];
  const resolved: LineEdit[] = [];

  for (const [index, edit] of edits.entries()) {
    if (edit.op === "replace_text") continue;

    const lines = parseEditLines(edit.lines, index);
    const pos = edit.pos ? parseAnchor(edit.pos) : undefined;
    const end = edit.end ? parseAnchor(edit.end) : undefined;

    if (pos) validateAnchor(pos, fileLines, staleAnchors);
    if (end) validateAnchor(end, fileLines, staleAnchors);

    switch (edit.op) {
      case "replace": {
        if (!pos) throw new Error(`Edit ${index} with op "replace" requires a pos anchor.`);
        const endAnchor = end ?? pos;
        if (endAnchor.line < pos.line) {
          throw new Error(`[E_BAD_REF] Edit ${index} has end before pos (${stringifyAnchor(endAnchor)} < ${stringifyAnchor(pos)}).`);
        }
        resolved.push({
          requestIndex: index,
          label: describeLineEdit(edit),
          start: pos.line - 1,
          end: endAnchor.line,
          lines,
        });
        break;
      }
      case "append": {
        resolved.push({
          requestIndex: index,
          label: describeLineEdit(edit),
          start: pos ? pos.line : fileLines.length,
          end: pos ? pos.line : fileLines.length,
          lines,
        });
        break;
      }
      case "prepend": {
        resolved.push({
          requestIndex: index,
          label: describeLineEdit(edit),
          start: pos ? pos.line - 1 : 0,
          end: pos ? pos.line - 1 : 0,
          lines,
        });
        break;
      }
    }
  }

  if (staleAnchors.length > 0) {
    throw new Error(formatStaleAnchorError(staleAnchors, fileLines));
  }

  const sorted = [...resolved].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]!;
    const current = sorted[i]!;
    if (current.start <= previous.end) {
      throw new Error(
        `[E_EDIT_CONFLICT] Edits ${previous.requestIndex} (${previous.label}) and ${current.requestIndex} (${current.label}) overlap or are adjacent. Merge them into one edit or split the request.`,
      );
    }
  }

  return sorted;
}

function applyLineEdits(originalLines: string[], edits: LineEdit[]): string[] {
  const next = [...originalLines];
  for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    next.splice(edit.start, edit.end - edit.start, ...edit.lines);
  }
  return next;
}

function applyExactUniqueReplace(content: string, oldText: string, newText: string): string {
  const normalizedOld = normalizeToLF(oldText);
  const normalizedNew = normalizeToLF(newText);
  if (normalizedOld.length === 0) {
    throw new Error("[E_BAD_OP] replace_text requires non-empty oldText.");
  }

  const matches: number[] = [];
  let from = 0;
  while (from <= content.length - normalizedOld.length) {
    const index = content.indexOf(normalizedOld, from);
    if (index === -1) break;
    matches.push(index);
    from = index + 1;
  }

  if (matches.length === 0) {
    throw new Error("[E_NO_MATCH] replace_text found no exact match in the current file. Re-read and use hashline anchors.");
  }
  if (matches.length > 1) {
    throw new Error("[E_MULTI_MATCH] replace_text found multiple matches in the current file. Re-read and use hashline anchors.");
  }

  const start = matches[0]!;
  return content.slice(0, start) + normalizedNew + content.slice(start + normalizedOld.length);
}

function applyEditsToContent(original: string, edits: RawEdit[]): string {
  const textEdits = edits.filter((edit) => edit.op === "replace_text");
  if (textEdits.length > 0) {
    if (edits.length !== 1) {
      throw new Error("[E_EDIT_CONFLICT] replace_text cannot be mixed with anchor edits in one call. Use anchors or split the request.");
    }
    const edit = textEdits[0]!;
    return applyExactUniqueReplace(original, edit.oldText!, edit.newText!);
  }

  const preserveTerminalNewline = original.endsWith("\n");
  const originalLines = getVisibleLines(original);
  const lineEdits = resolveLineEdits(edits, originalLines);
  const nextLines = applyLineEdits(originalLines, lineEdits);
  return joinVisibleLines(nextLines, preserveTerminalNewline);
}

function computeChangedLineRange(oldText: string, newText: string): {
  first: number;
  last: number;
  addedLines: number;
  removedLines: number;
} | undefined {
  const oldLines = getVisibleLines(oldText);
  const newLines = getVisibleLines(newText);

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }

  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (
    oldEnd >= prefix &&
    newEnd >= prefix &&
    oldLines[oldEnd] === newLines[newEnd]
  ) {
    oldEnd--;
    newEnd--;
  }

  if (prefix > oldEnd && prefix > newEnd) return undefined;

  if (newLines.length === 0) {
    return {
      first: 1,
      last: 1,
      addedLines: Math.max(0, newEnd - prefix + 1),
      removedLines: Math.max(0, oldEnd - prefix + 1),
    };
  }

  const first = Math.min(prefix + 1, newLines.length);
  const last = Math.max(first, Math.min(newEnd + 1, newLines.length));
  return {
    first,
    last,
    addedLines: Math.max(0, newEnd - prefix + 1),
    removedLines: Math.max(0, oldEnd - prefix + 1),
  };
}

function buildChangedAnchorResponse(original: string, result: string): {
  text: string;
  firstChangedLine?: number;
  addedLines: number;
  removedLines: number;
} {
  const range = computeChangedLineRange(original, result);
  if (!range) {
    return {
      text: "No changes made. The requested edits produced identical content.",
      addedLines: 0,
      removedLines: 0,
    };
  }

  const resultLines = getVisibleLines(result);
  if (resultLines.length === 0) {
    return {
      text: "File is empty. Use edit with prepend or append and omit pos to insert content.",
      firstChangedLine: 1,
      addedLines: range.addedLines,
      removedLines: range.removedLines,
    };
  }

  const start = Math.max(1, range.first - 2);
  const end = Math.min(resultLines.length, range.last + 2);
  const region = resultLines.slice(start - 1, end);
  const anchors = `--- Anchors ${start}-${end} ---\n${formatHashlineRegion(region, start)}`;
  const text = Buffer.byteLength(anchors, "utf8") > DEFAULT_MAX_BYTES
    ? "Anchors omitted; changed region is too large. Use read for subsequent edits."
    : anchors;

  return {
    text,
    firstChangedLine: range.first,
    addedLines: range.addedLines,
    removedLines: range.removedLines,
  };
}

function registerReadTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read",
    label: "Read",
    description: `Read a UTF-8 text file. Every returned line is prefixed as LINE#HASH:content. Copy LINE#HASH anchors into edit. Output is capped at ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Supported images are delegated to Pi's built-in read tool.`,
    promptSnippet: "Read files with LINE#HASH anchors for hashline edit.",
    promptGuidelines: [
      "Use read before edit so you can copy LINE#HASH anchors exactly.",
      "When read output is truncated, continue with the suggested offset before editing unseen lines.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" })),
    }),

    renderCall(args, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const path = typeof args?.path === "string" ? args.path : "...";
      text.setText(`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", path)}`);
      return text;
    },

    renderResult(result, { isPartial }, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      if (isPartial) {
        text.setText(theme.fg("warning", "Reading..."));
        return text;
      }
      const body = result.content
        ?.map((entry) => entry.type === "text" ? entry.text ?? "" : "[attachment]")
        .join("\n") ?? "";
      text.setText(context.isError ? theme.fg("error", body) : body);
      return text;
    },

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const path = params.path;
      const absolutePath = resolveToCwd(path, ctx.cwd);
      throwIfAborted(signal);

      if (isImagePath(absolutePath)) {
        return createReadTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
      }

      try {
        await fsAccess(absolutePath, constants.R_OK);
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") throw new Error(`File not found: ${path}`);
        if (code === "EACCES" || code === "EPERM") throw new Error(`File is not readable: ${path}`);
        throw new Error(`Cannot access file: ${path}`);
      }

      throwIfAborted(signal);
      const file = await loadTextFile(absolutePath);
      const preview = formatHashlineReadPreview(file.text, {
        offset: params.offset,
        limit: params.limit,
      });

      return {
        content: [{ type: "text", text: preview.text }],
        details: {
          ...(preview.truncation ? { truncation: preview.truncation } : {}),
          ...(preview.nextOffset !== undefined ? { nextOffset: preview.nextOffset } : {}),
        },
      };
    },
  });
}

function registerEditTool(pi: ExtensionAPI): void {
  const editLinesSchema = Type.Union([
    Type.Array(Type.String(), { description: "literal replacement content lines" }),
    Type.String({ description: "literal replacement content split on newlines" }),
    Type.Null({ description: "delete target range" }),
  ]);

  const editItemSchema = Type.Object(
    {
      op: StringEnum(["replace", "append", "prepend", "replace_text"] as const, {
        description: "edit operation",
      }),
      pos: Type.Optional(Type.String({ description: "LINE#HASH anchor" })),
      end: Type.Optional(Type.String({ description: "inclusive LINE#HASH end anchor for replace" })),
      lines: Type.Optional(editLinesSchema),
      oldText: Type.Optional(Type.String({ description: "exact text for replace_text" })),
      newText: Type.Optional(Type.String({ description: "replacement text for replace_text" })),
    },
    { additionalProperties: false },
  );

  const editSchema = Type.Object(
    {
      path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
      edits: Type.Array(editItemSchema, { minItems: 1, description: "Hashline edits for this file" }),
    },
    { additionalProperties: false },
  );

  pi.registerTool({
    name: "edit",
    label: "Edit",
    description: [
      "Patch a UTF-8 text file using LINE#HASH anchors copied from read output.",
      "Ops: replace(pos,end?,lines), append(pos?,lines), prepend(pos?,lines), replace_text(oldText,newText).",
      "Anchors are strict; stale hash mismatches are rejected with fresh retry anchors.",
      "lines must be literal file content: no LINE#HASH prefixes and no diff +/- prefixes.",
      "Multiple anchor edits validate against the same pre-edit snapshot and apply bottom-up. Merge overlapping or adjacent edits.",
    ].join("\n"),
    promptSnippet: "Patch files using LINE#HASH anchors from read output.",
    promptGuidelines: [
      "Use edit with LINE#HASH anchors copied from the latest read output for that file.",
      "Do not invent or adjust anchors; if an anchor is stale or missing, call read again.",
      "Use literal file content in edit lines, without LINE#HASH or diff prefixes.",
      "Merge overlapping or adjacent edits in the same file into one replace range.",
    ],
    parameters: editSchema,
    prepareArguments: prepareEditArguments,

    renderCall(args, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const path = isRecord(args) && typeof args.path === "string" ? args.path : "...";
      const count = isRecord(args) && Array.isArray(args.edits) ? args.edits.length : 0;
      const suffix = count > 0 ? theme.fg("muted", ` (${count} edit${count === 1 ? "" : "s"})`) : "";
      text.setText(`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path)}${suffix}`);
      return text;
    },

    renderResult(result, { isPartial }, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      if (isPartial) {
        text.setText(theme.fg("warning", "Editing..."));
        return text;
      }
      const body = result.content
        ?.map((entry) => entry.type === "text" ? entry.text ?? "" : "")
        .filter((entry) => entry.length > 0)
        .join("\n") ?? "";
      text.setText(context.isError ? theme.fg("error", body) : body);
      return text;
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      assertEditRequest(params);
      const path = params.path;
      const absolutePath = resolveToCwd(path, ctx.cwd);
      const mutationTargetPath = await getMutationTargetPath(absolutePath);

      return withFileMutationQueue(mutationTargetPath, async () => {
        throwIfAborted(signal);
        try {
          await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
        } catch (error: unknown) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") throw new Error(`File not found: ${path}`);
          if (code === "EACCES" || code === "EPERM") throw new Error(`File is not writable: ${path}`);
          throw new Error(`Cannot access file: ${path}`);
        }

        if (isImagePath(absolutePath)) {
          throw new Error(`Path is an image file: ${path}. Hashline edit only supports UTF-8 text files.`);
        }

        throwIfAborted(signal);
        const file = await loadTextFile(absolutePath);
        const original = file.text;
        const result = applyEditsToContent(original, params.edits);

        if (result === original) {
          return {
            content: [{ type: "text", text: "No changes made. The requested edits produced identical content." }],
            details: { classification: "noop" },
          };
        }

        throwIfAborted(signal);
        const persisted = file.bom + restoreLineEnding(result, file.lineEnding);
        await writeTextFileAtomically(absolutePath, persisted);

        const response = buildChangedAnchorResponse(original, result);
        return {
          content: [{ type: "text", text: response.text }],
          details: {
            firstChangedLine: response.firstChangedLine,
            metrics: {
              edits_attempted: params.edits.length,
              added_lines: response.addedLines,
              removed_lines: response.removedLines,
            },
          },
        };
      });
    },
  });
}

export default function (pi: ExtensionAPI): void {
  registerReadTool(pi);
  registerEditTool(pi);

  const debug = process.env.PI_HASHLINE_DEBUG;
  if (debug === "1" || debug === "true") {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify("pi-hashline active", "info");
    });
  }
}
