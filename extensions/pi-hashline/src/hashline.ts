import { createHash } from "node:crypto";
import { DEFAULT_MAX_BYTES } from "@mariozechner/pi-coding-agent";
import {
  DIFF_DELETE_PREFIX_RE,
  HASH_ALPHABET,
  HASH_LENGTH,
  HASH_RE,
  HASHLINE_PLUS_PREFIX_RE,
  HASHLINE_PREFIX_RE,
  SIGNIFICANT_RE,
} from "./constants";
import { normalizeToLF } from "./text-file";

export type Anchor = {
  line: number;
  hash: string;
};

export type RawEdit = {
  op: string;
  pos?: string;
  end?: string;
  lines?: string[] | string | null;
  oldText?: string;
  newText?: string;
};

export type EditRequest = {
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

export function computeLineHash(lineNumber: number, line: string): string {
  const normalized = line.replace(/\r/g, "").trimEnd();
  const seed = SIGNIFICANT_RE.test(normalized)
    ? normalized
    : `${lineNumber}\0${normalized}`;
  const digest = createHash("sha256").update(seed).digest();
  const value = digest[0]!;
  return [
    HASH_ALPHABET[(value >> 4) & 0xf],
    HASH_ALPHABET[value & 0xf],
  ].join("");
}

export function getVisibleLines(text: string): string[] {
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

export function formatHashlineRegion(lines: string[], startLine: number): string {
  return lines
    .map((line, index) => {
      const lineNumber = startLine + index;
      return `${lineNumber}#${computeLineHash(lineNumber, line)}:${line}`;
    })
    .join("\n");
}

function parseAnchor(ref: string): Anchor {
  const core = ref.replace(/^\s*[>+-]*\s*/, "").trimEnd();
  const match = core.match(/^([0-9]+)\s*#\s*([^\s:]+)(?:\s*:.*)?$/s);
  if (!match) {
    throw new Error(`[E_BAD_REF] Invalid line reference ${JSON.stringify(ref)}. Expected "LINE#HASH" from read output, e.g. "12#K7".`);
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

export function applyEditsToContent(original: string, edits: RawEdit[]): string {
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

export function buildChangedAnchorResponse(original: string, result: string): {
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
