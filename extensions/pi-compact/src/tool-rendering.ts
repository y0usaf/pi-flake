import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { state } from "./state.js";
import {
  MAX_RESULT_LENGTH,
  MAX_SUMMARY_LENGTH,
  TOOL_ARROW,
  TOOL_ORIGINAL_RENDER_KEY,
  TOOL_ORIGINAL_SET_EXPANDED_KEY,
  TOOL_SEPARATOR,
} from "./types.js";
import {
  clip,
  countDetailsLineDiff,
  countLabel,
  firstTextLine,
  formatScalar,
  lineCount,
  normalizePath,
  paint,
  renderOneLine,
  squash,
  textLineCount,
} from "./shared.js";

// Icon vocabulary extracted from @pi-harness's compact tool renderer.
const TOOL_ICONS: Record<string, string> = {
  read: "◰",
  bash: "$",
  edit: "✎",
  write: "+",
  find: "⌕",
  grep: "⌕",
  ls: "▦",
};

const PREFERRED_ARG_KEYS = ["path", "url", "query", "id", "name", "command", "pattern", "glob", "prompt", "message", "action"];
const toolExpandedState = new WeakMap<object, boolean>();

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatLineRange(args: any): string {
  const offset = finiteNumber(args?.offset);
  const limit = finiteNumber(args?.limit);
  if (offset === undefined && limit === undefined) return "";
  const start = offset ?? 1;
  return limit === undefined ? `:${start}` : `:${start}-${start + limit - 1}`;
}

function formatGenericArgs(args: any, cwd?: string): string {
  if (args === undefined || args === null) return "";
  if (typeof args !== "object") return formatScalar(args);
  if (Array.isArray(args)) return `[${args.length}]`;

  const parts: string[] = [];
  for (const key of PREFERRED_ARG_KEYS) {
    if (!(key in args) || args[key] === undefined) continue;
    const value = key === "path" ? normalizePath(args[key], ".", cwd) : formatScalar(args[key]);
    if (!value) continue;
    parts.push(key === "path" ? value : `${key}=${value}`);
    if (parts.length === 2) break;
  }
  if (parts.length > 0) return parts.join(" · ");

  for (const [key, value] of Object.entries(args)) {
    const formatted = formatScalar(value);
    if (!formatted) continue;
    parts.push(`${key}=${formatted}`);
    if (parts.length === 2) break;
  }
  return parts.join(" · ");
}

const pathArg = (args: any, cwd?: string, fallback = "?"): string => normalizePath(args?.path, fallback, cwd);

const ARG_SUMMARIES: Record<string, (args: any, cwd?: string) => string> = {
  read: (args, cwd) => `${pathArg(args, cwd)}${formatLineRange(args)}`,
  bash: (args) => squash(args?.command) || "…",
  edit: (args, cwd) => pathArg(args, cwd),
  write: (args, cwd) => {
    const path = pathArg(args, cwd);
    const lines = lineCount(args?.content);
    return lines > 0 ? `${path} (${countLabel(lines, "line")})` : path;
  },
  find: (args, cwd) => `${squash(args?.pattern) || "*"} @ ${pathArg(args, cwd, ".")}`,
  grep: (args, cwd) => `/${squash(args?.pattern) || ".*"}/ @ ${pathArg(args, cwd, ".")}`,
  ls: (args, cwd) => pathArg(args, cwd, "."),
  agent_task: (args) => {
    const action = squash(args?.action) || "?";
    const id = squash(args?.id);
    const task = squash(args?.task);
    return action === "start" && task ? `${action} ${id ? `${id} ` : ""}${clip(task, 64)}` : `${action}${id ? ` ${id}` : ""}`;
  },
  report: (args) => clip(squash(args?.message) || "report", 80),
  web_fetch: (args) => {
    const url = squash(args?.url) || "?";
    const prompt = squash(args?.prompt);
    return prompt ? `${url} · ${clip(prompt, 48)}` : url;
  },
  web_search: (args) => {
    const query = squash(args?.query) || "?";
    const engine = squash(args?.engine);
    return engine ? `${query} · ${engine}` : query;
  },
  web_browse: (args) => `${squash(args?.url) || "?"}${args?.extract ? " · extract" : ""}`,
  repl: (args) => {
    const code = squash(args?.code);
    return code ? clip(code.split(";")[0] ?? code, 96) : "";
  },
};

export function summarizeArgs(toolName: string, args: any, cwd?: string): string {
  return ARG_SUMMARIES[toolName.trim().toLowerCase()]?.(args, cwd) ?? formatGenericArgs(args, cwd);
}

function resultCount(result: any, noun: string): string {
  const count = textLineCount(result);
  return count > 0 ? countLabel(count, noun) : "";
}

export function summarizeResult(toolName: string, result: any): string {
  if (!result) return "";
  const name = toolName.trim().toLowerCase();
  const details = result.details;
  const firstLine = firstTextLine(result);

  if (result.isError) return clip(firstLine || "error", MAX_RESULT_LENGTH);

  if (name === "edit") {
    const counts = countDetailsLineDiff(details);
    return counts ? `+${counts.added} -${counts.removed}` : "applied";
  }
  if (name === "write") return "written";
  if (name === "bash") {
    const exitCode = finiteNumber(details?.exitCode);
    if (exitCode !== undefined && exitCode !== 0) return `exit ${Math.trunc(exitCode)}`;
    return resultCount(result, "line");
  }
  if (name === "read") {
    if (result.content?.some((block: any) => block?.type === "image")) return "image";
    return resultCount(result, "line");
  }
  if (name === "find" || name === "ls") return resultCount(result, name === "find" ? "file" : "entry");
  if (name === "grep") return resultCount(result, "match");
  if (name === "agent_task") {
    if (typeof details?.status === "string") return details.status;
    if (Array.isArray(details?.tasks)) return countLabel(details.tasks.length, "task");
    if (Array.isArray(details?.cancelled)) return `${details.cancelled.length} cancelled`;
  }
  if (name === "web_fetch" && details?.fromCache) return "cache";
  if (name === "web_search" && finiteNumber(details?.resultCount) !== undefined) return countLabel(Math.trunc(details.resultCount), "result");
  if (name === "web_browse" && finiteNumber(details?.contentLength) !== undefined) return `${Math.trunc(details.contentLength)} chars`;

  if (!firstLine || firstLine === "done" || firstLine === "(no output)") return "";
  return clip(firstLine, MAX_RESULT_LENGTH);
}

export function toolIcon(toolName: string): string {
  return TOOL_ICONS[toolName.trim().toLowerCase()] ?? "•";
}

export function buildToolLine(component: any): string {
  const toolName = squash(component?.toolName) || "tool";
  const detail = clip(summarizeArgs(toolName, component?.args, component?.cwd), MAX_SUMMARY_LENGTH);
  const outcome = component?.isPartial ? "" : clip(summarizeResult(toolName, component?.result), MAX_RESULT_LENGTH);
  const status = component?.isPartial ? "…" : component?.result?.isError ? "✕" : "✓";
  const statusColor = component?.isPartial ? "warning" : component?.result?.isError ? "error" : "success";
  const outcomeColor = component?.result?.isError ? "error" : "muted";

  return [
    paint("muted", TOOL_ARROW),
    " ",
    paint("accent", toolIcon(toolName)),
    " ",
    paint("toolTitle", toolName, true),
    detail ? ` ${paint("dim", detail)}` : "",
    ` ${paint("borderMuted", TOOL_SEPARATOR)} ${paint(statusColor, status)}`,
    outcome ? ` ${paint(outcomeColor, outcome)}` : "",
  ].join("");
}

export function renderCompactToolLine(component: any, width: number): string[] {
  return renderOneLine(buildToolLine(component), width);
}

export function getToolExpanded(component: any): boolean {
  const tracked = toolExpandedState.get(component as object);
  return tracked ?? component.expanded === true;
}

export function patchToolExecutionComponent(): boolean {
  try {
    const proto = (ToolExecutionComponent as any)?.prototype;
    if (!proto || typeof proto.render !== "function" || typeof proto.setExpanded !== "function") {
      throw new Error("ToolExecutionComponent unavailable");
    }

    const originalRender = typeof proto[TOOL_ORIGINAL_RENDER_KEY] === "function" ? proto[TOOL_ORIGINAL_RENDER_KEY] : proto.render;
    const originalSetExpanded =
      typeof proto[TOOL_ORIGINAL_SET_EXPANDED_KEY] === "function" ? proto[TOOL_ORIGINAL_SET_EXPANDED_KEY] : proto.setExpanded;

    proto.render = function piCompactToolRender(this: any, width: number) {
      if (getToolExpanded(this)) return originalRender.call(this, width);
      return renderCompactToolLine(this, width);
    };

    proto.setExpanded = function piCompactToolSetExpanded(this: any, expanded: boolean) {
      const result = originalSetExpanded.call(this, expanded);
      toolExpandedState.set(this as object, expanded);
      if (!expanded) {
        try {
          this.ui?.requestRender?.(true);
        } catch {
          // Rendering remains correct on the next scheduled frame.
        }
      }
      return result;
    };

    proto[TOOL_ORIGINAL_RENDER_KEY] = originalRender;
    proto[TOOL_ORIGINAL_SET_EXPANDED_KEY] = originalSetExpanded;
    state.lastToolPatchError = undefined;
    return true;
  } catch (error) {
    state.lastToolPatchError = error instanceof Error ? error.stack ?? error.message : String(error);
    return false;
  }
}
