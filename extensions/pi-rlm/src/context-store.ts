import { createReadStream, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

import {
  CTX_TOOL_NAME,
  DEFAULT_CTX_GREP_MATCHES,
  DEFAULT_CTX_PEEK_CHARS,
  HARD_CTX_GREP_MATCHES,
  HARD_CTX_PEEK_CHARS,
  MAX_CONTEXT_MANIFEST_CHARS,
  MAX_CONTEXT_TREE_DEPTH,
  MAX_CONTEXT_TREE_ENTRIES,
  MAX_CTX_GREP_FILES,
  MAX_CTX_OUTPUT_CHARS,
  MAX_INLINE_CHILD_CONTEXT_CHARS,
  RETURN_TOOL_NAME,
} from "./constants.js";
import type { ContextMode, ContextSource, ContextSourceKind, ContextStore } from "./constants.js";
import { clamp, clip, errorText, normalizeContextMode, normPaths, normSources } from "./utils.js";

const MAX_CTX_GREP_REGEX_LINE_CHARS = 2_000;
const MAX_CTX_LINE_COUNT = 400;
const MAX_CTX_GREP_CONTEXT_LINES = 10;
const NESTED_QUANTIFIER_PATTERN = /\([^)]*[+*][^)]*\)\s*(?:[+*?]|\{)/;

const MAX_CTX_GREP_FILE_BYTES = 5_000_000;
const BINARY_SNIFF_BYTES = 4_096;
function validateCtxRegex(query: string): RegExp {
  if (NESTED_QUANTIFIER_PATTERN.test(query)) {
    throw new Error("ctx grep rejected a potentially unsafe regex with nested quantifiers.");
  }
  try {
    return new RegExp(query);
  } catch (e) {
    throw new Error(`Invalid ctx grep regex: ${errorText(e)}`);
  }
}

// ── File-backed context store ───────────────────────────────────────

export function formatBytes(bytes?: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "? bytes";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

export function absPathFor(cwd: string, input: string): string {
  return path.isAbsolute(input) ? path.normalize(input) : path.resolve(cwd, input);
}

export function relPathFor(cwd: string, abs: string): string {
  const rel = path.relative(cwd, abs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : abs;
}

export function skipDirName(name: string): boolean {
  return new Set([".git", "node_modules", ".direnv", ".next", "dist", "build", "target", ".venv", "venv", "__pycache__"]).has(name);
}

export async function statContextSource(cwd: string, input: string, id: string, name?: string): Promise<ContextSource> {
  const abs = absPathFor(cwd, input);
  const relPath = relPathFor(cwd, abs);
  try {
    const st = await fs.lstat(abs);
    const kind: ContextSourceKind = st.isFile() ? "file" : st.isDirectory() ? "dir" : "other";
    return {
      id,
      name,
      label: name || input,
      input,
      path: abs,
      relPath,
      kind,
      sizeBytes: st.isFile() ? st.size : undefined,
    };
  } catch (e) {
    return {
      id,
      name,
      label: name || input,
      input,
      path: abs,
      relPath,
      kind: "missing",
      error: errorText(e),
    };
  }
}

export async function collectTreeLines(cwd: string, abs: string, depth: number, state: { count: number; truncated: boolean }): Promise<string[]> {
  if (depth > MAX_CONTEXT_TREE_DEPTH || state.count >= MAX_CONTEXT_TREE_ENTRIES) {
    state.truncated = true;
    return [];
  }

  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch (e) {
    return [`${"  ".repeat(depth)}[cannot read ${relPathFor(cwd, abs)}: ${errorText(e)}]`];
  }

  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && skipDirName(entry.name)) continue;
    if (state.count >= MAX_CONTEXT_TREE_ENTRIES) {
      state.truncated = true;
      break;
    }
    state.count++;
    const child = path.join(abs, entry.name);
    const childRel = relPathFor(cwd, child);
    let size = "";
    try {
      const st = await fs.lstat(child);
      if (st.isFile()) size = ` ${formatBytes(st.size)}`;
    } catch {
      // ignore size failures in manifest preview
    }
    lines.push(`${"  ".repeat(depth)}- ${childRel}${entry.isDirectory() ? "/" : ""}${size}`);
    if (entry.isDirectory()) {
      if (depth + 1 <= MAX_CONTEXT_TREE_DEPTH) {
        lines.push(...await collectTreeLines(cwd, child, depth + 1, state));
      } else {
        state.truncated = true;
      }
    }
  }
  return lines;
}

export function contextSourceSummary(source: ContextSource): string {
  const name = source.name ? ` (${source.name})` : "";
  const size = source.sizeBytes !== undefined ? `, ${formatBytes(source.sizeBytes)}` : "";
  const error = source.error ? `, error=${source.error}` : "";
  return `${source.id}${name}: ${source.kind} ${source.label} -> ${source.relPath}${size}${error}`;
}

export async function buildContextManifest(cwd: string, store: Omit<ContextStore, "manifestText">): Promise<string> {
  const lines: string[] = [
    "# RLM file-backed context manifest",
    "",
    `Context store: ${store.dir}`,
    `Scratch workspace: ${store.scratchDir}`,
    `Notes dir: ${store.notesDir}`,
    `Artifacts dir: ${store.artifactsDir}`,
    "",
    "Sources:",
    ...store.sources.map((s) => `- ${contextSourceSummary(s)}`),
    "",
    "Tree preview / file inventory (capped):",
  ];

  for (const source of store.sources) {
    lines.push("", `## ${source.id}: ${source.label}`);
    if (source.kind === "dir") {
      const state = { count: 0, truncated: false };
      lines.push(...await collectTreeLines(cwd, source.path, 0, state));
      if (state.truncated) lines.push(`[truncated tree after ${state.count} entries]`);
      source.entries = state.count;
    } else {
      lines.push(contextSourceSummary(source));
    }
  }

  return clip(lines.join("\n"), MAX_CONTEXT_MANIFEST_CHARS);
}

export function contextStoreReadme(store: Omit<ContextStore, "manifestText">): string {
  return `# Pi RLM temporary context store

This directory is ephemeral and deleted after the child RLM returns.

- manifest.txt: capped source manifest / tree preview
- manifest.json: machine-readable source metadata
- scratch/: write intermediate artifacts here
- notes/: ctx note outputs
- artifacts/: ctx artifact outputs

Use compact observations only. Do not dump whole context files into chat.
Prefer ctx({ action:"manifest" }), ctx({ action:"grep", query:"..." }), ctx({ action:"peek", source:"s0", chars:4000 }), and ctx({ action:"extract", ... }) before raw bash/read on large sources.

Sources:
${store.sources.map((s) => `- ${contextSourceSummary(s)}`).join("\n")}
`;
}

export async function prepareContextStore(cwd: string, params: { context?: string; contextMode?: ContextMode; paths?: string[]; sources?: Array<{ name?: string; path: string }>; contextName?: string }): Promise<ContextStore | undefined> {
  const mode = normalizeContextMode(params.contextMode);
  const paths = normPaths(params.paths);
  const namedSources = normSources(params.sources);
  const context = typeof params.context === "string" ? params.context : "";
  const materializeContext = context.trim().length > 0 && (
    mode === "file_backed" || (mode === "auto" && context.length > MAX_INLINE_CHILD_CONTEXT_CHARS)
  );
  const needsStore = paths.length > 0 || namedSources.length > 0 || materializeContext;
  if (!needsStore) return undefined;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-rlm-"));
  try {
    const scratchDir = path.join(dir, "scratch");
    const notesDir = path.join(dir, "notes");
    const artifactsDir = path.join(dir, "artifacts");
    await fs.mkdir(scratchDir, { recursive: true });
    await fs.mkdir(notesDir, { recursive: true });
    await fs.mkdir(artifactsDir, { recursive: true });

    const sources: ContextSource[] = [];
    if (materializeContext) {
      const contextPath = path.join(dir, "inline-context.txt");
      await fs.writeFile(contextPath, context, "utf8");
      sources.push({
        id: `s${sources.length}`,
        name: typeof params.contextName === "string" && params.contextName.trim() ? params.contextName.trim() : undefined,
        label: typeof params.contextName === "string" && params.contextName.trim() ? params.contextName.trim() : "inline context",
        path: contextPath,
        relPath: contextPath,
        kind: "inline",
        sizeBytes: Buffer.byteLength(context, "utf8"),
      });
    }

    for (const p of paths) {
      sources.push(await statContextSource(cwd, p, `s${sources.length}`));
    }
    for (const src of namedSources) {
      sources.push(await statContextSource(cwd, src.path, `s${sources.length}`, src.name));
    }

    const partial = {
      dir,
      scratchDir,
      notesDir,
      artifactsDir,
      manifestPath: path.join(dir, "manifest.txt"),
      manifestJsonPath: path.join(dir, "manifest.json"),
      readmePath: path.join(dir, "README.md"),
      sources,
    };
    const manifestText = await buildContextManifest(cwd, partial);
    const store: ContextStore = { ...partial, manifestText };

    await fs.writeFile(store.manifestPath, manifestText, "utf8");
    await fs.writeFile(store.manifestJsonPath, JSON.stringify({
      dir: store.dir,
      scratchDir: store.scratchDir,
      notesDir: store.notesDir,
      artifactsDir: store.artifactsDir,
      manifestPath: store.manifestPath,
      manifestJsonPath: store.manifestJsonPath,
      sources: store.sources,
    }, null, 2), "utf8");
    await fs.writeFile(store.readmePath, contextStoreReadme(store), "utf8");
    return store;
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}

export async function cleanupContextStore(store?: ContextStore): Promise<void> {
  if (!store) return;
  await fs.rm(store.dir, { recursive: true, force: true }).catch(() => undefined);
}

export function contextMaterialized(store?: ContextStore): boolean {
  return Boolean(store?.sources.some((s) => s.kind === "inline"));
}

export function contextStorePromptBlock(store: ContextStore): string {
  return `
File-backed context store (external to chat):
- ${CTX_TOOL_NAME} tool available for capped manifest/peek/grep/extract/note/artifact.
- Temp dir: ${store.dir}
- Scratch dir: ${store.scratchDir}
- Notes dir: ${store.notesDir}
- Artifacts dir: ${store.artifactsDir}
- Manifest: ${store.manifestPath}
- JSON manifest: ${store.manifestJsonPath}
- README: ${store.readmePath}

Sources:
${store.sources.map((s) => `- ${contextSourceSummary(s)}`).join("\n")}

Rules for this store:
- Treat these sources as the large context object. It is not copied into chat.
- Start with ${CTX_TOOL_NAME}({ action:"manifest" }) or compact bash commands (wc/find/head/rg/jq/python).
- Use ${CTX_TOOL_NAME}({ action:"grep", query:"..." }) to narrow before peeking.
- Use ${CTX_TOOL_NAME}({ action:"peek", source:"s0", chars:4000 }) for small slices only.
- Write intermediate artifacts only under the scratch/notes/artifacts dirs. The store is deleted after ${RETURN_TOOL_NAME}; include needed findings in your final answer.
- Never cat/read/print a whole large source.
`;
}

export function sourceMatches(source: ContextSource, selector: string): boolean {
  const s = selector.trim();
  return [source.id, source.name, source.label, source.input, source.path, source.relPath, path.basename(source.path)]
    .filter((v): v is string => Boolean(v))
    .some((v) => v === s || v.endsWith(s));
}

export function selectContextSources(store: ContextStore, selector?: string): ContextSource[] {
  const readable = store.sources.filter((s) => s.kind === "inline" || s.kind === "file" || s.kind === "dir");
  if (!selector?.trim()) return readable;
  const selected = readable.filter((s) => sourceMatches(s, selector));
  if (!selected.length) throw new Error(`No context source matched ${JSON.stringify(selector)}. Use ctx({action:"manifest"}) to list sources.`);
  return selected;
}

async function isProbablyBinary(file: string): Promise<boolean> {
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, BINARY_SNIFF_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } finally {
    await fh.close();
  }
}

async function shouldSkipGrepFile(file: string): Promise<boolean> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) return true;
    if (st.size > MAX_CTX_GREP_FILE_BYTES) return true;
    return await isProbablyBinary(file);
  } catch {
    return true;
  }
}

export async function collectFiles(source: ContextSource, state: { count: number; truncated: boolean; skipped?: number }, out: string[] = []): Promise<string[]> {
  if (state.count >= MAX_CTX_GREP_FILES) {
    state.truncated = true;
    return out;
  }
  if (source.kind === "inline" || source.kind === "file") {
    if (source.kind !== "inline" && await shouldSkipGrepFile(source.path)) {
      state.skipped = (state.skipped ?? 0) + 1;
      return out;
    }
    out.push(source.path);
    state.count++;
    return out;
  }

  if (source.kind !== "dir") return out;

  let entries;
  try {
    entries = await fs.readdir(source.path, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isDirectory() && skipDirName(entry.name)) continue;
    const child = path.join(source.path, entry.name);
    if (entry.isDirectory()) {
      await collectFiles({ ...source, path: child, kind: "dir" }, state, out);
    } else if (entry.isFile()) {
      if (state.count >= MAX_CTX_GREP_FILES) {
        state.truncated = true;
        break;
      }
      if (await shouldSkipGrepFile(child)) {
        state.skipped = (state.skipped ?? 0) + 1;
        continue;
      }
      out.push(child);
      state.count++;
    }
    if (state.truncated) break;
  }
  return out;
}

export async function readFileSlice(file: string, bytes: number, offset: number): Promise<string> {
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, offset);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await fh.close();
  }
}

export async function ctxManifest(store: ContextStore, params: any = {}): Promise<string> {
  if (params.format === "json") {
    return JSON.stringify({
      dir: store.dir,
      scratchDir: store.scratchDir,
      notesDir: store.notesDir,
      artifactsDir: store.artifactsDir,
      manifestPath: store.manifestPath,
      manifestJsonPath: store.manifestJsonPath,
      sources: store.sources,
    }, null, 2);
  }
  return `${store.manifestText}\n\nManifest file: ${store.manifestPath}\nScratch dir: ${store.scratchDir}\nNotes dir: ${store.notesDir}\nArtifacts dir: ${store.artifactsDir}`;
}

export async function resolveSourceFile(source: ContextSource, file?: string): Promise<string> {
  if (!file || !file.trim()) {
    if (source.kind === "dir") throw new Error("ctx file parameter is required for line-aware access to a directory source.");
    return source.path;
  }
  if (source.kind !== "dir") throw new Error("ctx file parameter is only valid with a directory source.");
  const root = path.resolve(source.path);
  const target = path.resolve(root, file);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("ctx file rejected: path escapes source directory.");
  const st = await fs.stat(target);
  if (!st.isFile()) throw new Error("ctx file must resolve to a regular file inside the source directory.");
  return target;
}

export async function readLineRange(cwd: string, file: string, line: number, endLine: number, numbers = true): Promise<string> {
  const startLine = clamp(line, 1, 1, Number.MAX_SAFE_INTEGER);
  const finalLine = Math.max(startLine, Math.min(endLine, startLine + MAX_CTX_LINE_COUNT - 1));
  const out: string[] = [];
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const text of rl) {
      n++;
      if (n < startLine) continue;
      if (n > finalLine) { rl.close(); stream.destroy(); break; }
      out.push(numbers ? `${relPathFor(cwd, file)}:${n}: ${text}` : text);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return out.join("\n");
}

export async function ctxPeek(cwd: string, store: ContextStore, params: any): Promise<string> {
  const source = selectContextSources(store, typeof params.source === "string" ? params.source : undefined)[0];
  if (!source) throw new Error("No readable context sources.");

  if (typeof params.line === "number" || typeof params.endLine === "number" || typeof params.lines === "number" || typeof params.file === "string") {
    const startLine = clamp(params.line, 1, 1, Number.MAX_SAFE_INTEGER);
    const count = clamp(params.lines, 80, 1, MAX_CTX_LINE_COUNT);
    const endLine = typeof params.endLine === "number" ? clamp(params.endLine, startLine, startLine, startLine + MAX_CTX_LINE_COUNT - 1) : startLine + count - 1;
    const file = await resolveSourceFile(source, typeof params.file === "string" ? params.file : undefined);
    const text = await readLineRange(cwd, file, startLine, endLine, params.numbers !== false);
    return clip(`# ${contextSourceSummary(source)}\n# lines ${startLine}-${Math.min(endLine, startLine + MAX_CTX_LINE_COUNT - 1)}${params.file ? ` file ${params.file}` : ""}\n\n${text}`, MAX_CTX_OUTPUT_CHARS);
  }

  const chars = clamp(params.chars, DEFAULT_CTX_PEEK_CHARS, 1, HARD_CTX_PEEK_CHARS);
  const offset = clamp(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  if (source.kind === "dir") {
    const state = { count: 0, truncated: false };
    const lines = await collectTreeLines(cwd, source.path, 0, state);
    return clip(`# ${contextSourceSummary(source)}\n\n${lines.join("\n")}${state.truncated ? `\n[truncated tree after ${state.count} entries]` : ""}`, MAX_CTX_OUTPUT_CHARS);
  }

  const text = await readFileSlice(source.path, chars, offset);
  return `# ${contextSourceSummary(source)}\n# byte offset ${offset}, max bytes ${chars}\n\n${text}`;
}

export async function grepOneFile(cwd: string, file: string, query: string, opts: { regex: boolean; caseSensitive: boolean; before: number; after: number }, out: string[], max: number): Promise<void> {
  let re: RegExp | undefined;
  let needle = query;
  if (opts.regex) {
    validateCtxRegex(query);
    re = new RegExp(query, opts.caseSensitive ? "" : "i");
  } else if (!opts.caseSensitive) needle = query.toLowerCase();

  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  const beforeBuf: Array<{ n: number; text: string }> = [];
  let afterLeft = 0;
  try {
    for await (const line of rl) {
      lineNo++;
      const matchLine = re && line.length > MAX_CTX_GREP_REGEX_LINE_CHARS ? line.slice(0, MAX_CTX_GREP_REGEX_LINE_CHARS) : line;
      const matched = re ? re.test(matchLine) : (opts.caseSensitive ? line : line.toLowerCase()).includes(needle);
      if (re) re.lastIndex = 0;
      if (matched) {
        for (const b of beforeBuf) out.push(`${relPathFor(cwd, file)}-${b.n}- ${clip(b.text.replace(/\t/g, " "), 500)}`);
        beforeBuf.length = 0;
        out.push(`${relPathFor(cwd, file)}:${lineNo}: ${clip(line.replace(/\t/g, " "), 500)}`);
        afterLeft = opts.after;
        if (out.length >= max) { rl.close(); stream.destroy(); break; }
      } else if (afterLeft > 0) {
        out.push(`${relPathFor(cwd, file)}-${lineNo}- ${clip(line.replace(/\t/g, " "), 500)}`);
        afterLeft--;
      } else if (opts.before > 0) {
        beforeBuf.push({ n: lineNo, text: line });
        if (beforeBuf.length > opts.before) beforeBuf.shift();
      }
      if (out.length >= max) { rl.close(); stream.destroy(); break; }
    }
  } catch (e) {
    out.push(`[error reading ${relPathFor(cwd, file)}: ${errorText(e)}]`);
  }
}

export async function ctxGrep(cwd: string, store: ContextStore, params: any): Promise<string> {
  const query = typeof params.query === "string" ? params.query : "";
  if (!query) throw new Error("ctx grep requires query.");
  const maxMatches = clamp(params.maxMatches, DEFAULT_CTX_GREP_MATCHES, 1, HARD_CTX_GREP_MATCHES);
  const contextLines = clamp(params.contextLines, 0, 0, MAX_CTX_GREP_CONTEXT_LINES);
  const before = clamp(params.before, contextLines, 0, MAX_CTX_GREP_CONTEXT_LINES);
  const after = clamp(params.after, contextLines, 0, MAX_CTX_GREP_CONTEXT_LINES);
  const sources = selectContextSources(store, typeof params.source === "string" ? params.source : undefined);
  const fileState: { count: number; truncated: boolean; skipped?: number } = { count: 0, truncated: false };
  const files: string[] = [];
  for (const source of sources) await collectFiles(source, fileState, files);

  const matches: string[] = [];
  const cap = maxMatches * (1 + before + after);
  for (const file of files) {
    if (matches.length >= cap) break;
    await grepOneFile(cwd, file, query, {
      regex: params.regex === true && params.literal !== true,
      caseSensitive: params.caseSensitive === true,
      before,
      after,
    }, matches, cap);
  }

  const header = `# ctx grep ${JSON.stringify(query)} across ${files.length} file(s), max ${maxMatches} match(es), context ${before}/${after}`;
  const body = matches.slice(0, cap);
  const tail = `${fileState.truncated ? `\n[file listing truncated after ${fileState.count} files]` : ""}${fileState.skipped ? `\n[skipped ${fileState.skipped} large/binary/unreadable file(s)]` : ""}${matches.length >= cap ? `\n[output capped after ${cap} lines]` : ""}\nScratch dir: ${store.scratchDir}`;
  if (!body.length) return `${header}\nNo matches.${tail}`;
  return clip(`${header}\n${body.join("\n")}${tail}`, MAX_CTX_OUTPUT_CHARS);
}

export async function ctxExtract(cwd: string, store: ContextStore, params: any): Promise<string> {
  const ranges = Array.isArray(params.ranges) && params.ranges.length ? params.ranges : [params];
  const out: string[] = [];
  for (const r of ranges.slice(0, 20)) {
    const source = selectContextSources(store, typeof r.source === "string" ? r.source : typeof params.source === "string" ? params.source : undefined)[0];
    if (!source) throw new Error("No readable context sources.");
    const startLine = clamp(r.line ?? params.line, 1, 1, Number.MAX_SAFE_INTEGER);
    const count = clamp(r.lines ?? params.lines, 80, 1, MAX_CTX_LINE_COUNT);
    const endLine = typeof (r.endLine ?? params.endLine) === "number" ? clamp(r.endLine ?? params.endLine, startLine, startLine, startLine + MAX_CTX_LINE_COUNT - 1) : startLine + count - 1;
    const file = await resolveSourceFile(source, typeof (r.file ?? params.file) === "string" ? (r.file ?? params.file) : undefined);
    out.push(`# ${contextSourceSummary(source)} lines ${startLine}-${endLine}${r.file ?? params.file ? ` file ${r.file ?? params.file}` : ""}`);
    out.push(await readLineRange(cwd, file, startLine, endLine, params.numbers !== false));
  }
  return clip(out.join("\n\n"), MAX_CTX_OUTPUT_CHARS);
}

function safeStoreName(raw: unknown, fallback: string): string {
  const s = typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
  const clean = s.replace(/[\\/]+/g, "-").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || fallback;
}

export async function ctxWriteText(store: ContextStore, kind: "note" | "artifact", params: any): Promise<string> {
  const text = typeof params.text === "string" ? params.text : "";
  if (!text) throw new Error(`ctx ${kind} requires text.`);
  const root = kind === "note" ? store.notesDir : store.artifactsDir;
  const name = safeStoreName(params.name, `${kind}-${Date.now()}.txt`);
  const target = path.resolve(root, name);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`ctx ${kind} rejected unsafe name.`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text, "utf8");
  return JSON.stringify({ kind, path: target, relPath: path.relative(store.dir, target), bytes: Buffer.byteLength(text, "utf8") }, null, 2);
}
