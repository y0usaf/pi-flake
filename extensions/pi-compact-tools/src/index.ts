import { ToolExecutionComponent, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { homedir } from "node:os";
const MAX_SUMMARY_LENGTH = 120;
const MAX_RESULT_LENGTH = 72;

let patchPromise: Promise<boolean> | undefined;
let lastPatchError: string | undefined;

function squash(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function shortenPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function normalizePath(path: unknown, fallback = "."): string {
  if (typeof path !== "string" || path.length === 0) return fallback;
  const clean = path.startsWith("@") ? path.slice(1) : path;
  return shortenPath(clean);
}

function formatScalar(value: unknown): string {
  if (typeof value === "string") return squash(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === "object") return "{…}";
  return "";
}

function firstTextLine(result: any): string {
  if (!result?.content || !Array.isArray(result.content)) return "";
  for (const block of result.content) {
    if (block?.type === "text" && typeof block.text === "string") {
      const line = squash(block.text.split("\n")[0] ?? "");
      if (line) return line;
    }
  }
  return "";
}

function textLineCount(result: any): number {
  if (!result?.content || !Array.isArray(result.content)) return 0;
  let total = 0;
  for (const block of result.content) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    total += block.text.split("\n").filter((line: string) => line.trim().length > 0).length;
  }
  return total;
}

function patchFailedMessage(): string {
  return `pi-compact-tools: patch failed${lastPatchError ? `\n${lastPatchError}` : ""}`;
}

const argFormatters: Record<string, (args: any) => string> = {
  read: (args) => { const p = normalizePath(args?.path, "?"); if (args?.offset === undefined && args?.limit === undefined) return p; const s = Number(args?.offset ?? 1); return args?.limit === undefined ? `${p}:${s}` : `${p}:${s}-${s + Number(args.limit) - 1}`; },
  bash: (args) => `${squash(args?.command) || "…"}${args?.timeout !== undefined ? ` • timeout=${args.timeout}s` : ""}`,
  edit: (args) => { const p = normalizePath(args?.path, "?"); const e = Array.isArray(args?.edits) ? args.edits.length : (args?.oldText !== undefined || args?.newText !== undefined ? 1 : 0); return e > 0 ? `${p} • ${e} edit${e === 1 ? "" : "s"}` : p; },
  write: (args) => { const p = normalizePath(args?.path, "?"); const l = typeof args?.content === "string" && args.content.length > 0 ? args.content.split("\n").length : 0; return l > 0 ? `${p} • ${l} lines` : p; },
  find: (args) => `${squash(args?.pattern) || "*"} @ ${normalizePath(args?.path, ".")}${args?.limit !== undefined ? ` • limit=${args.limit}` : ""}`,
  grep: (args) => `/${squash(args?.pattern) || ".*"}/ @ ${normalizePath(args?.path, ".")}${squash(args?.glob) ? ` • ${squash(args.glob)}` : ""}${args?.limit !== undefined ? ` • limit=${args.limit}` : ""}`,
  ls: (args) => `${normalizePath(args?.path, ".")}${args?.limit !== undefined ? ` • limit=${args.limit}` : ""}`,
  spawn_agent: (args) => { const id = squash(args?.id) || "?"; const t = squash(args?.task); return t ? `${id} • ${clip(t, 64)}` : id; },
  delegate: (args) => { const id = squash(args?.id) || "?"; const m = squash(args?.message); return m ? `${id} • ${clip(m, 64)}` : id; },
  kill_agent: (args) => squash(args?.id) || "?",
  list_agents: () => "active children",
  report: (args) => clip(squash(args?.message) || "report", 80),
  web_fetch: (args) => { const u = squash(args?.url) || "?"; const p = squash(args?.prompt); return p ? `${u} • ${clip(p, 48)}` : u; },
  web_search: (args) => { const q = squash(args?.query) || "?"; const e = squash(args?.engine); return e ? `${q} • ${e}` : q; },
  web_browse: (args) => { const u = squash(args?.url) || "?"; return args?.extract ? `${u} • extract` : u; },
};

function summarizeArgs(toolName: string, args: any): string {
  const formatter = argFormatters[toolName];
  if (formatter) return formatter(args);

  if (args === undefined || args === null) return "";
  if (typeof args !== "object") return formatScalar(args);
  if (Array.isArray(args)) return `[${args.length}]`;

  const preferredKeys = ["path", "url", "query", "id", "name", "command", "pattern", "glob", "prompt", "message"];
  const parts: string[] = [];

  for (const key of preferredKeys) {
    if (!(key in args) || args[key] === undefined) continue;
    const value = key === "path" ? normalizePath(args[key]) : formatScalar(args[key]);
    if (!value) continue;
    parts.push(key === "path" ? value : `${key}=${value}`);
    if (parts.length >= 3) break;
  }

  if (parts.length === 0) {
    for (const [key, value] of Object.entries(args)) {
      const formatted = formatScalar(value);
      if (!formatted) continue;
      parts.push(`${key}=${formatted}`);
      if (parts.length >= 3) break;
    }
  }

  return parts.join(" • ");
}

const resultFormatters: Record<string, (result: any, details: any) => string> = {
  bash: (_r, d) => typeof d.exitCode === "number" && d.exitCode !== 0 ? ` → exit ${d.exitCode}` : "",
  find: (r) => { const c = textLineCount(r); return c > 0 ? ` → ${c}` : ""; },
  grep: (r) => { const c = textLineCount(r); return c > 0 ? ` → ${c}` : ""; },
  ls: (r) => { const c = textLineCount(r); return c > 0 ? ` → ${c}` : ""; },
  list_agents: (_r, d) => Array.isArray(d?.agents) ? ` → ${d.agents.length}` : "",
  kill_agent: (_r, d) => Array.isArray(d?.killedIds) ? ` → ${d.killedIds.length} killed` : "",
  spawn_agent: (_r, d) => d?.childId ? ` → ${d.childId}` : "",
  delegate: (_r, d) => d?.childId ? ` → ${d.childId}` : "",
  web_search: (_r, d) => typeof d?.resultCount === "number" ? ` → ${d.resultCount} results` : "",
  web_browse: (_r, d) => typeof d?.contentLength === "number" ? ` → ${d.contentLength} chars` : "",
  web_fetch: (_r, d) => d?.fromCache ? " → cache" : "",
};

function summarizeResult(toolName: string, result: any): string {
  if (!result) return "";

  if (result?.isError) {
    const line = firstTextLine(result);
    return line ? ` → ${clip(line, MAX_RESULT_LENGTH)}` : " → error";
  }

  const details = result?.details ?? {};
  const formatter = resultFormatters[toolName];
  if (formatter) {
    const out = formatter(result, details);
    if (out) return out;
  }

  const line = firstTextLine(result);
  if (!line || line === "done") return "";
  return ` → ${clip(line, MAX_RESULT_LENGTH)}`;
}

function buildLine(_theme: any, state: any): string {
  const prefix = state?.isPartial ? "… " : state?.result?.isError ? "✗ " : "✓ ";
  const summary = clip(summarizeArgs(state?.toolName ?? "tool", state?.args), MAX_SUMMARY_LENGTH);
  const suffix = summarizeResult(state?.toolName ?? "tool", state?.result);
  return `${prefix}${state?.toolName ?? "tool"} ${summary || "…"}${suffix}`;
}

function clearImages(state: any): void {
  for (const image of state?.imageComponents ?? []) state.removeChild(image);
  state.imageComponents = [];
  for (const spacer of state?.imageSpacers ?? []) state.removeChild(spacer);
  state.imageSpacers = [];
}

async function patchToolExecutionComponent(): Promise<boolean> {
  if (patchPromise) return patchPromise;

  patchPromise = (async () => {
    try {
      const proto = (ToolExecutionComponent as any)?.prototype;
      if (!proto || typeof proto.updateDisplay !== "function") {
        throw new Error("ToolExecutionComponent unavailable");
      }
      if (proto.__compactToolsPatched) return true;

      const originalUpdateDisplay = proto.updateDisplay;

      proto.updateDisplay = function compactToolsUpdateDisplay(this: any) {
        if (this.expanded) return originalUpdateDisplay.call(this);

        originalUpdateDisplay.call(this);

        const line = buildLine(undefined, this);
        clearImages(this);
        this.hideComponent = false;

        const hasRendererDefinition =
          typeof this.hasRendererDefinition === "function"
            ? this.hasRendererDefinition()
            : this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;

        if (hasRendererDefinition) {
          const shell = typeof this.getRenderShell === "function" ? this.getRenderShell() : "default";
          const renderContainer = shell === "self" ? this.selfRenderContainer : this.contentBox;
          renderContainer?.clear?.();
          renderContainer?.addChild?.(new Text(line, 0, 0));
          return;
        }

        this.contentText?.setText?.(line);
      };

      proto.__compactToolsPatched = true;
      proto.__compactToolsPatchedOriginalUpdateDisplay = originalUpdateDisplay;
      lastPatchError = undefined;
      return true;
    } catch (error) {
      lastPatchError = error instanceof Error ? error.stack ?? error.message : String(error);
      return false;
    }
  })();

  return patchPromise;
}

void patchToolExecutionComponent();

export default function (pi: ExtensionAPI) {
  pi.registerCommand("compact-tools-status", {
    description: "Show pi-compact-tools patch status",
    handler: async (_args, ctx) => {
      const ok = await patchToolExecutionComponent();
      const msg = ok ? "pi-compact-tools: active" : patchFailedMessage();
      ctx.ui.notify(msg, ok ? "info" : "error");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const ok = await patchToolExecutionComponent();
    if (!ctx.hasUI) return;
    if (!ok) ctx.ui.notify(patchFailedMessage(), "error");
  });
}
