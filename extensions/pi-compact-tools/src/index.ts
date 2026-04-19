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

function lineCount(value: unknown): number {
  return typeof value === "string" && value.length > 0 ? value.split("\n").length : 0;
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

function summarizeArgs(toolName: string, args: any): string {
  switch (toolName) {
    case "read": {
      const path = normalizePath(args?.path, "?");
      if (args?.offset === undefined && args?.limit === undefined) return path;
      const start = Number(args?.offset ?? 1);
      if (args?.limit === undefined) return `${path}:${start}`;
      return `${path}:${start}-${start + Number(args.limit) - 1}`;
    }
    case "bash": {
      const command = squash(args?.command) || "…";
      const timeout = args?.timeout !== undefined ? ` • timeout=${args.timeout}s` : "";
      return `${command}${timeout}`;
    }
    case "edit": {
      const path = normalizePath(args?.path, "?");
      const edits = Array.isArray(args?.edits)
        ? args.edits.length
        : args?.oldText !== undefined || args?.newText !== undefined
          ? 1
          : 0;
      return edits > 0 ? `${path} • ${edits} edit${edits === 1 ? "" : "s"}` : path;
    }
    case "write": {
      const path = normalizePath(args?.path, "?");
      const lines = lineCount(args?.content);
      return lines > 0 ? `${path} • ${lines} lines` : path;
    }
    case "find": {
      const pattern = squash(args?.pattern) || "*";
      const path = normalizePath(args?.path, ".");
      const limit = args?.limit !== undefined ? ` • limit=${args.limit}` : "";
      return `${pattern} @ ${path}${limit}`;
    }
    case "grep": {
      const pattern = squash(args?.pattern) || ".*";
      const path = normalizePath(args?.path, ".");
      const glob = squash(args?.glob);
      const limit = args?.limit !== undefined ? ` • limit=${args.limit}` : "";
      return `/${pattern}/ @ ${path}${glob ? ` • ${glob}` : ""}${limit}`;
    }
    case "ls": {
      const path = normalizePath(args?.path, ".");
      const limit = args?.limit !== undefined ? ` • limit=${args.limit}` : "";
      return `${path}${limit}`;
    }
    case "spawn_agent": {
      const id = squash(args?.id) || "?";
      const task = squash(args?.task);
      return task ? `${id} • ${clip(task, 64)}` : id;
    }
    case "delegate": {
      const id = squash(args?.id) || "?";
      const message = squash(args?.message);
      return message ? `${id} • ${clip(message, 64)}` : id;
    }
    case "kill_agent":
      return squash(args?.id) || "?";
    case "list_agents":
      return "active children";
    case "report":
      return clip(squash(args?.message) || "report", 80);
    case "web_fetch": {
      const url = squash(args?.url) || "?";
      const prompt = squash(args?.prompt);
      return prompt ? `${url} • ${clip(prompt, 48)}` : url;
    }
    case "web_search": {
      const query = squash(args?.query) || "?";
      const engine = squash(args?.engine);
      return engine ? `${query} • ${engine}` : query;
    }
    case "web_browse": {
      const url = squash(args?.url) || "?";
      return args?.extract ? `${url} • extract` : url;
    }
    default:
      break;
  }

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

function summarizeResult(toolName: string, result: any): string {
  if (!result) return "";

  if (result?.isError) {
    const line = firstTextLine(result);
    return line ? ` → ${clip(line, MAX_RESULT_LENGTH)}` : " → error";
  }

  const details = result?.details ?? {};

  switch (toolName) {
    case "bash":
      if (typeof details.exitCode === "number") return details.exitCode === 0 ? "" : ` → exit ${details.exitCode}`;
      break;
    case "find":
    case "grep":
    case "ls": {
      const count = textLineCount(result);
      if (count > 0) return ` → ${count}`;
      break;
    }
    case "list_agents": {
      if (Array.isArray(details?.agents)) return ` → ${details.agents.length}`;
      break;
    }
    case "kill_agent": {
      if (Array.isArray(details?.killedIds)) return ` → ${details.killedIds.length} killed`;
      break;
    }
    case "spawn_agent":
    case "delegate": {
      if (details?.childId) return ` → ${details.childId}`;
      break;
    }
    case "web_search": {
      if (typeof details?.resultCount === "number") return ` → ${details.resultCount} results`;
      break;
    }
    case "web_browse": {
      if (typeof details?.contentLength === "number") return ` → ${details.contentLength} chars`;
      break;
    }
    case "web_fetch": {
      if (details?.fromCache) return " → cache";
      break;
    }
    default:
      break;
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

        const line = buildLine(undefined, this).replace(/\x1b\[[0-9;]*m/g, "");
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
      const msg = ok ? "pi-compact-tools: active" : `pi-compact-tools: patch failed${lastPatchError ? `\n${lastPatchError}` : ""}`;
      ctx.ui.notify(msg, ok ? "info" : "error");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const ok = await patchToolExecutionComponent();
    if (!ctx.hasUI) return;
    if (!ok) ctx.ui.notify(`pi-compact-tools: patch failed${lastPatchError ? `\n${lastPatchError}` : ""}`, "error");
  });
}
