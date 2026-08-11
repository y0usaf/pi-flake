/**
 * Row-script and patch parser — converts both formats into hashline's native
 * `{path, edits}` JSON format.
 *
 * LINEID anchors (@REPLACE 103heah) → hashline {loc:{range:{pos,end}}}
 * Non-anchored operations with content matching → rejected (use unified-edit)
 *
 * validateRowAnchors: reads files, validates all LINEIDs via computeLineHash,
 * returns stale anchors with retry info, or resolves them to line numbers.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { computeLineHash, getVisibleLines } from "./hashline";
import { normalizeToLF, stripBom } from "./text-file";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AnchorEdit = {
  path: string;
  loc: "append" | "prepend" | { append: string } | { prepend: string } | { range: { pos: string; end: string } };
  content: string[] | null;
};

export type ParsedResult = {
  edits: AnchorEdit[];
  hasUnsupported: boolean;
};

// ---------------------------------------------------------------------------
// Helper: parse a LINEID anchor string into {line, hash}
// ---------------------------------------------------------------------------

function parseAnchorReference(ref: string): { line: number; hash: string } | null {
  const clean = ref.trim().toLowerCase().replace(/^[>+\-*]*\s*/, "");
  const m = /^(\d{1,6})([a-z]{4})$/.exec(clean);
  if (!m) return null;
  return { line: Number(m[1]), hash: m[2] };
}

// ---------------------------------------------------------------------------
// Row-script parser
// ---------------------------------------------------------------------------

export function rowScriptToEdits(text: string): ParsedResult {
  const edits: AnchorEdit[] = [];
  let hasUnsupported = false;

  const norm = normalizeToLF(text);
  const lines = norm.split("\n");
  let curPath = "";
  let curOp: string | null = null;
  let hasAnchor = false;
  let anchorArg = "";
  let plusRows: string[] = [];
  let minusRows: string[] = [];
  let inContentMatcher = false;

  function flush() {
    if (!curPath || !curOp) return;

    // Handle based on operation and whether it has a LINEID anchor
    if (curOp === "@APPEND") {
      edits.push({ path: curPath, loc: "append", content: plusRows.length ? plusRows : null });
    } else if (curOp === "@PREPEND") {
      edits.push({ path: curPath, loc: "prepend", content: plusRows.length ? plusRows : null });
    } else if (hasAnchor && (curOp === "@INS.BEFORE" || curOp === "@INS.AFTER")) {
      const parts = anchorId.split("-");
      const id = parts[0];
      edits.push({
        path: curPath,
        loc: curOp === "@INS.BEFORE" ? { prepend: id } : { append: id },
        content: plusRows.length ? plusRows : null,
      });
    } else if (hasAnchor && curOp === "@REPLACE") {
      const parts = anchorId.split("-");
      const pos = parts[0];
      const end = parts.length > 1 ? parts[1] : pos;
      edits.push({
        path: curPath,
        loc: { range: { pos, end } },
        content: plusRows.length ? plusRows : null,
      });
    } else if (hasAnchor && curOp === "@DEL") {
      const parts = anchorId.split("-");
      const pos = parts[0];
      const end = parts.length > 1 ? parts[1] : pos;
      edits.push({
        path: curPath,
        loc: { range: { pos, end } },
        content: null, // delete
      });
    } else if (curOp && !hasAnchor) {
      hasUnsupported = true;
    }

    curOp = null;
    hasAnchor = false;
    anchorId = "";
    plusRows = [];
    minusRows = [];
    inContentMatcher = false;
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // [filename]
    const fileMatch = /^\[([^\]]+)\]\s*$/.exec(trimmed);
    if (fileMatch) {
      flush();
      curPath = fileMatch[1].trim().replace(/^@/, "");
      continue;
    }

    // @@ separator in replace hunks
    if (trimmed === "@@") continue;

    // Operation lines: @
    if (raw.startsWith("@")) {
      // @APPEND|@PREPEND (no anchor needed)
      const simpleOps = /^@(APPEND|PREPEND)\s*$/i.exec(trimmed);
      if (simpleOps) {
        flush();
        curOp = simpleOps[1].toUpperCase();
        continue;
      }

      // @INS.BEFORE|@INS.AFTER|@REPLACE|@DEL [LINEID]
      const opWithAnchor = /^@(INS\.(BEFORE|AFTER)|REPLACE|DEL)(?:\s+(\S+(?:\s*-\s*\S+)?))?\s*$/i.exec(trimmed);
      if (opWithAnchor) {
        flush();
        const rawVerb = opWithAnchor[1].toUpperCase();
        curOp = rawVerb === "INS.BEFORE" ? "@INS.BEFORE" 
               : rawVerb === "INS.AFTER" ? "@INS.AFTER"
               : rawVerb === "REPLACE" ? "@REPLACE"
               : rawVerb === "DEL" ? "@DEL"
               : rawVerb;

        const arg = opWithAnchor[3]?.replace(/\s+/g, "").toLowerCase();
        if (arg && (curOp === "@INS.BEFORE" || curOp === "@INS.AFTER" || curOp === "@REPLACE" || curOp === "@DEL")) {
          hasAnchor = true;
          anchorId = arg;
        }
        continue;
      }

      // Unknown @ — skip
      flush();
      continue;
    }

    // Content rows: + or -
    if (raw.startsWith("+")) {
      if (curOp) plusRows.push(raw.slice(1));
      continue;
    }
    if (raw.startsWith("-")) {
      if (curOp) minusRows.push(raw.slice(1));
      continue;
    }
    if (raw.startsWith(" ") && curOp) {
      // context line — for content matching
      inContentMatcher = true;
      continue;
    }
  }

  flush();

  return { edits, hasUnsupported };
}

// ---------------------------------------------------------------------------
// Anchor validation
// ---------------------------------------------------------------------------

export async function validateRowAnchors(
  edits: AnchorEdit[],
  cwd: string,
): Promise<void> {
  // Collect unique LINEIDs from all edit locations
  const pathAnchors = new Map<string, Set<string>>();

  for (const e of edits) {
    if (typeof e.loc === "string") continue; // append/prepend have no anchor
    if ("append" in e.loc) addAnchor(pathAnchors, e.path, e.loc.append);
    else if ("prepend" in e.loc) addAnchor(pathAnchors, e.path, e.loc.prepend);
    else if ("range" in e.loc) {
      addAnchor(pathAnchors, e.path, e.loc.range.pos);
      addAnchor(pathAnchors, e.path, e.loc.range.end);
    }
  }

  if (pathAnchors.size === 0) return;

  for (const [path, anchors] of pathAnchors) {
    const abs = path.startsWith("@") ? resolve(path.slice(1)) : isAbsolute(path) ? resolve(path) : resolve(cwd, path);
    const raw = await readFile(abs, "utf-8").catch(() => null);
    if (raw == null) throw new Error(`Cannot read file for anchor validation: ${path}`);

    const { text } = stripBom(raw);
    const fileLines = normalizeToLF(text).split("\n");
    if (fileLines.length > 0 && fileLines[fileLines.length - 1] === "") fileLines.pop();

    const stale: Array<{ ref: string; has: string; actual?: string; reason?: string }> = [];

    for (const ref of anchors) {
      const parsed = parseAnchorReference(ref);
      if (!parsed) {
        stale.push({ ref, hash: "", reason: `invalid LINEID format: ${ref}` });
        continue;
      }
      if (parsed.line > fileLines.length) {
        stale.push({ ref, hash: ref, reason: `line ${parsed.line} outside file (${fileLines.length} lines)` });
        continue;
      }
      const current = fileLines[parsed.line - 1] ?? "";
      const currentHash = computeLineHash(current);
      if (currentHash !== parsed.hash) {
        stale.push({ ref, hash: parsed.hash, actual: currentHash });
      }
    }

    if (stale.length > 0) {
      // Build retry anchors
      const lines = stale.map(s => s.ref ? parseInt(s.ref) : -1).filter(n => n > 0 && n <= fileLines.length);
      const displaySet = new Set<number>();
      for (const ref of stale) {
        const p = parseAnchorReference(ref.ref);
        if (!p) continue;
        for (let d = -2; d <= 2; d++) {
          const ln = p.line + d;
          if (ln >= 1 && ln <= fileLines.length) displaySet.add(ln);
        }
      }

      const msg: string[] = [
        `[E_STALE_ANCHOR] ${stale.length} stale anchor(s). Read the file again:`,
        "",
      ];
      for (const s of stale) {
        if (s.reason) msg.push(`- ${s.ref}: ${s.reason}`);
        else msg.push(`- ${s.ref}: current hash is ${s.actual}`);
      }
      if (displaySet.size > 0) {
        msg.push("");
        const sorted = [...displaySet].sort((a, b) => a - b);
        let prev = -1;
        for (const ln of sorted) {
          if (prev !== -1 && ln > prev + 1) msg.push("    ...");
          prev = ln;
          const line = fileLines[ln - 1] ?? "";
          const hash = computeLineHash(line);
          msg.push(`${stale.some(s => { const p = parseAnchorReference(s.ref); return p && p.line === ln; }) ? ">>>" : "   "} ${ln}${hash}|${line}`);
        }
      }

      throw new Error(msg.join("\n"));
    }
  }
}

// ---------------------------------------------------------------------------
// Patch parser → hashline-compatible updates
// ---------------------------------------------------------------------------

export function isPatch(text: string): boolean {
  const t = normalizeToLF(text).trim();
  return t.startsWith("*** Begin Patch") && t.endsWith("*** End Patch");
}

export function parsePatchText(text: string): Array<{
  path: string;
  oldText: string;
  newText: string;
}> {
  const lines = normalizeToLF(text).trim().split("\n");
  if (lines.length < 2) return [];
  if (lines[0].trim() !== "*** Begin Patch" || lines[lines.length - 1].trim() !== "*** End Patch") return [];

  const results: Array<{ path: string; oldText: string; newText: string }> = [];
  let i = 1;
  const last = lines.length - 2;

  while (i <= last) {
    if (!lines[i].trim()) { i++; continue; }
    const line = lines[i].trim();

    if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length).trim();
      i++;
      let oldLines: string[] = [];
      let newLines: string[] = [];

      while (i <= last) {
        const n = lines[i];
        if (n.trim().startsWith("*** ") || n.trim() === "") { break; }
        const marker = n[0];
        const body = n.slice(1);
        if (marker === " ") { oldLines.push(body); newLines.push(body); }
        else if (marker === "-") oldLines.push(body);
        else if (marker === "+") newLines.push(body);
        else break;
        i++;
      }

      if (oldLines.length > 0) {
        results.push({ path, oldText: oldLines.join("\n"), newText: newLines.join("\n") });
      }
      continue;
    }

    i++;
  }

  return results;
}

// Stale ref + display line IDs

function addAnchor(map: Map<string, Set<string>>, path: string, ref: string) {
  if (!ref) return;
  const set = map.get(path) ?? new Set();
  set.add(ref);
  map.set(path, set);
}