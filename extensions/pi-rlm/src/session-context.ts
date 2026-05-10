import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { MAX_INLINE_CHILD_CONTEXT_CHARS } from "./constants.js";
import type { ContextInlineInput, ContextSource, ContextStore } from "./constants.js";
import { buildContextManifest, contextSourceSummary, formatBytes, relPathFor } from "./context-store.js";
import { clip, isRecord } from "./utils.js";

const SESSION_CONTEXT_DIR = "rlm-context";
const SESSION_SOURCES_DIR = "sources";
const DEFAULT_EXTERNALIZE_CHARS = MAX_INLINE_CHILD_CONTEXT_CHARS;
const PREVIEW_CHARS = 2_000;
const MAX_SESSION_CONTEXT_PROMPT_CHARS = 8_000;
const DEFAULT_INLINE_REPL_INPUT_CHARS = MAX_INLINE_CHILD_CONTEXT_CHARS;
const MAX_INLINE_REPL_INPUTS = 5;

const stores = new Map<string, ContextStore>();

function safeName(raw: unknown, fallback: string): string {
  const s = typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
  const clean = s.replace(/[\\/]+/g, "-").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || fallback;
}

function sessionKey(ctx: ExtensionContext): string {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile) return path.resolve(sessionFile);
  return `${ctx.cwd}\0${ctx.sessionManager.getSessionId()}`;
}

function sessionStoreDir(ctx: ExtensionContext): string {
  const sessionDir = ctx.sessionManager.getSessionDir();
  const id = safeName(ctx.sessionManager.getSessionId(), "session");
  return path.join(sessionDir, SESSION_CONTEXT_DIR, id);
}

function sessionReadme(store: ContextStore): string {
  return `# Pi RLM session context store

This directory is managed by pi-rlm and persists with the Pi session.

- manifest.txt: capped source manifest / tree preview
- manifest.json: machine-readable source metadata
- ${SESSION_SOURCES_DIR}/: externalized user prompts or other session-local sources
- scratch/: temporary workspace for RLM exploration
- notes/: ctx note outputs
- artifacts/: ctx artifact outputs

Use compact observations only. Do not dump whole context files into chat.
Prefer ctx.manifest(), ctx.grep(...), ctx.peek(...), and ctx.extract(...) from REPL.
Recursive rlm_query calls made without explicit context inherit these sources.

Sources:
${store.sources.length ? store.sources.map((s) => `- ${contextSourceSummary(s)}`).join("\n") : "(none yet)"}
`;
}

function parseStoredSources(raw: unknown): ContextSource[] {
  if (!isRecord(raw) || !Array.isArray(raw.sources)) return [];
  const out: ContextSource[] = [];
  const seen = new Set<string>();
  for (const item of raw.sources) {
    if (!isRecord(item)) continue;
    if (typeof item.id !== "string" || typeof item.label !== "string" || typeof item.path !== "string" || typeof item.relPath !== "string") continue;
    const kind = typeof item.kind === "string" ? item.kind : "file";
    if (!["inline", "file", "dir", "missing", "other"].includes(kind)) continue;
    const key = `${item.id}\0${item.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: item.id,
      name: typeof item.name === "string" ? item.name : undefined,
      label: item.label,
      input: typeof item.input === "string" ? item.input : undefined,
      path: item.path,
      relPath: item.relPath,
      kind: kind as ContextSource["kind"],
      sizeBytes: typeof item.sizeBytes === "number" ? item.sizeBytes : undefined,
      entries: typeof item.entries === "number" ? item.entries : undefined,
      error: typeof item.error === "string" ? item.error : undefined,
    });
  }
  return out;
}

async function loadStoredSources(manifestJsonPath: string): Promise<ContextSource[]> {
  try {
    const raw = JSON.parse(await fs.readFile(manifestJsonPath, "utf8"));
    return parseStoredSources(raw);
  } catch {
    return [];
  }
}

async function hydrateInlineInputs(store: ContextStore): Promise<void> {
  const threshold = inlineReplInputThreshold();
  if (threshold <= 0) return;
  const candidates = store.sources
    .filter((source) => (source.kind === "inline" || source.kind === "file") && (source.sizeBytes ?? Number.MAX_SAFE_INTEGER) <= threshold)
    .slice(-MAX_INLINE_REPL_INPUTS);
  const inputs: ContextInlineInput[] = [];
  for (const source of candidates) {
    try {
      const text = await fs.readFile(source.path, "utf8");
      if (text.length > threshold) continue;
      inputs.push({
        id: source.id,
        name: source.name,
        label: source.label,
        path: source.path,
        chars: text.length,
        text,
      });
    } catch {
      // Ignore missing/old session files; manifest still reports the source status.
    }
  }
  store.inlineInputs = inputs;
  store.latestInput = inputs.at(-1);
}

export async function refreshSessionContextStore(cwd: string, store: ContextStore): Promise<ContextStore> {
  store.manifestText = await buildContextManifest(cwd, store);
  await fs.writeFile(store.manifestPath, store.manifestText, "utf8");
  await fs.writeFile(store.manifestJsonPath, JSON.stringify({
    persistent: true,
    dir: store.dir,
    scratchDir: store.scratchDir,
    notesDir: store.notesDir,
    artifactsDir: store.artifactsDir,
    manifestPath: store.manifestPath,
    manifestJsonPath: store.manifestJsonPath,
    sources: store.sources,
  }, null, 2), "utf8");
  await fs.writeFile(store.readmePath, sessionReadme(store), "utf8");
  return store;
}

export async function ensureSessionContextStore(ctx: ExtensionContext): Promise<ContextStore> {
  const key = sessionKey(ctx);
  const cached = stores.get(key);
  if (cached) return cached;

  const dir = sessionStoreDir(ctx);
  const scratchDir = path.join(dir, "scratch");
  const notesDir = path.join(dir, "notes");
  const artifactsDir = path.join(dir, "artifacts");
  const sourcesDir = path.join(dir, SESSION_SOURCES_DIR);
  await fs.mkdir(scratchDir, { recursive: true });
  await fs.mkdir(notesDir, { recursive: true });
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.mkdir(sourcesDir, { recursive: true });

  const manifestPath = path.join(dir, "manifest.txt");
  const manifestJsonPath = path.join(dir, "manifest.json");
  const readmePath = path.join(dir, "README.md");
  const sources = await loadStoredSources(manifestJsonPath);
  const store: ContextStore = {
    dir,
    scratchDir,
    notesDir,
    artifactsDir,
    manifestPath,
    manifestJsonPath,
    readmePath,
    manifestText: "",
    sources,
  };
  await hydrateInlineInputs(store);
  await refreshSessionContextStore(ctx.cwd, store);
  stores.set(key, store);
  return store;
}

export function releaseSessionContextStore(ctx: ExtensionContext): void {
  stores.delete(sessionKey(ctx));
}

function nextSourceId(store: ContextStore): string {
  const used = new Set(store.sources.map((s) => s.id));
  for (let i = store.sources.length; i < store.sources.length + 10_000; i++) {
    const id = `s${i}`;
    if (!used.has(id)) return id;
  }
  return `s${Date.now().toString(36)}`;
}

export async function addTextToSessionContext(ctx: ExtensionContext, text: string, options: { name?: string; label?: string } = {}): Promise<ContextSource> {
  const store = await ensureSessionContextStore(ctx);
  const id = nextSourceId(store);
  const ordinal = store.sources.length + 1;
  const name = safeName(options.name, `user-input-${String(ordinal).padStart(3, "0")}`);
  const target = path.join(store.dir, SESSION_SOURCES_DIR, `${name}.txt`);
  await fs.writeFile(target, text, "utf8");

  const source: ContextSource = {
    id,
    name,
    label: options.label || `externalized user input ${ordinal}`,
    input: name,
    path: target,
    relPath: relPathFor(ctx.cwd, target),
    kind: "inline",
    sizeBytes: Buffer.byteLength(text, "utf8"),
  };
  store.sources.push(source);
  rememberInlineInput(store, source, text);
  await refreshSessionContextStore(ctx.cwd, store);
  return source;
}

export function inlineReplInputThreshold(): number {
  const raw = process.env.PI_RLM_ROOT_INLINE_REPL_CHARS;
  if (raw === undefined || raw === "") return DEFAULT_INLINE_REPL_INPUT_CHARS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_INLINE_REPL_INPUT_CHARS;
  return Math.max(0, Math.trunc(n));
}

function rememberInlineInput(store: ContextStore, source: ContextSource, text: string): void {
  const threshold = inlineReplInputThreshold();
  if (threshold <= 0 || text.length > threshold) return;
  const entry: ContextInlineInput = {
    id: source.id,
    name: source.name,
    label: source.label,
    path: source.path,
    chars: text.length,
    text,
  };
  const existing = (store.inlineInputs ?? []).filter((input) => input.id !== source.id);
  store.inlineInputs = [...existing, entry].slice(-MAX_INLINE_REPL_INPUTS);
  store.latestInput = entry;
}

export function rootExternalizeThreshold(): number {
  const raw = process.env.PI_RLM_ROOT_EXTERNALIZE_CHARS;
  if (raw === undefined || raw === "") return DEFAULT_EXTERNALIZE_CHARS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_EXTERNALIZE_CHARS;
  return Math.max(0, Math.trunc(n));
}

export function shouldExternalizeInput(text: string, source?: string): boolean {
  if (source === "extension") return false;
  const threshold = rootExternalizeThreshold();
  return threshold > 0 && text.length > threshold;
}

function headTailPreview(text: string): string {
  if (text.length <= PREVIEW_CHARS * 2 + 200) return text;
  return `${text.slice(0, PREVIEW_CHARS)}\n\n...[${text.length - PREVIEW_CHARS * 2} chars externalized in the session context store]...\n\n${text.slice(-PREVIEW_CHARS)}`;
}

export async function recordUserInput(ctx: ExtensionContext, text: string): Promise<ContextSource> {
  return await addTextToSessionContext(ctx, text, {
    label: `user input (${new Date().toISOString()})`,
  });
}

export async function externalizeLargeInput(ctx: ExtensionContext, text: string): Promise<{ source: ContextSource; replacement: string }> {
  const source = await addTextToSessionContext(ctx, text, {
    label: `externalized user input (${new Date().toISOString()})`,
  });
  const preview = headTailPreview(text);
  const replacement = `[pi-rlm externalized large user input]

The user's full input was ${text.length.toLocaleString()} characters (${formatBytes(Buffer.byteLength(text, "utf8"))}) and has been stored outside the model context in the session RLM context store.

Source:
- id: ${source.id}
- name: ${source.name ?? "(none)"}
- path: ${source.path}

Use ${"`"}REPL${"`"} to inspect it:

${"```python"}
print(ctx.manifest())
print(ctx.peek(${JSON.stringify(source.id)}, chars=4000))
# ctx.grep("needle", source=${JSON.stringify(source.id)})
# ctx.extract(source=${JSON.stringify(source.id)}, line=1, lines=80)
${"```"}

Do not answer from this preview alone unless the task is fully captured by it. Treat the source as the authoritative user input; it may contain both instructions and data.

Preview only:
${"```text"}
${clip(preview, PREVIEW_CHARS * 2 + 500)}
${"```"}`;
  return { source, replacement };
}

export function contextStoreAsNamedSources(store?: ContextStore): Array<{ name?: string; path: string }> {
  if (!store) return [];
  return store.sources
    .filter((source) => source.kind === "inline" || source.kind === "file" || source.kind === "dir")
    .map((source) => ({ name: source.name || source.id, path: source.path }));
}

function hasExplicitContext(params: Record<string, unknown>): boolean {
  if (typeof params.context === "string" && params.context.trim()) return true;
  if (Array.isArray(params.paths) && params.paths.some((p) => typeof p === "string" && p.trim())) return true;
  if (Array.isArray(params.sources) && params.sources.some((s) => isRecord(s) && typeof s.path === "string" && s.path.trim())) return true;
  return false;
}

export function inheritSessionContextParams(params: unknown, store?: ContextStore): unknown {
  if (!isRecord(params)) return params;
  const call = params.call;
  if (call !== "rlm_query" && call !== "rlm_query_batched") return params;
  const sources = contextStoreAsNamedSources(store);
  if (!sources.length) return params;

  if (call === "rlm_query_batched" && Array.isArray(params.items) && params.items.length > 0) {
    if (hasExplicitContext(params)) return params;
    let changed = false;
    const items = params.items.map((item) => {
      if (!isRecord(item) || hasExplicitContext(item)) return item;
      changed = true;
      return { ...item, sources };
    });
    return changed ? { ...params, items } : params;
  }

  if (hasExplicitContext(params)) return params;
  return { ...params, sources };
}

export function sessionContextPromptBlock(store?: ContextStore): string {
  if (!store) return "";
  const sourceLines = store.sources.length
    ? store.sources.map((s) => `- ${contextSourceSummary(s)}`).join("\n")
    : "(no sources yet)";
  return clip(`Root/session RLM context store is attached to ${"`"}REPL${"`"} as ctx.*.
- Store dir: ${store.dir}
- Scratch dir: ${store.scratchDir}
- Manifest: ${store.manifestPath}
- Use ctx.manifest(), ctx.grep(...), ctx.peek(...), ctx.extract(...) from ${"`"}REPL${"`"}; do not dump whole sources into chat.
- If a user prompt was externalized, the transformed user message names the source id; inspect that source before answering.
- Recursive rlm_query / rlm_query_batched calls made from ${"`"}REPL${"`"} inherit these sources when no explicit context/paths/sources are provided.

Session context sources:
${sourceLines}`, MAX_SESSION_CONTEXT_PROMPT_CHARS);
}

export function sessionContextDetails(store?: ContextStore): { scratchDir?: string; contextSources?: string[] } {
  return {
    scratchDir: store?.scratchDir,
    contextSources: store?.sources.map(contextSourceSummary),
  };
}
