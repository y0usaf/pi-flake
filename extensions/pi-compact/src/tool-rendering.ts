import { ToolExecutionComponent } from "@mariozechner/pi-coding-agent";
import { state } from "./state.js";
import { MAX_RESULT_LENGTH, MAX_SUMMARY_LENGTH, TOOL_ORIGINAL_RENDER_KEY, TOOL_ORIGINAL_SET_EXPANDED_KEY, TOOL_RULE, TOOL_SPINNER_FRAME_KEY, TOOL_SPINNER_INTERVAL_KEY, type ToolBgToken } from "./types.js";
import { clip, colourDiffAdded, colourDiffRemoved, countDetailsLineDiff, firstTextLine, formatScalar, getThemeToolBgFn, isBlankRenderedLine, isRecord, lineCount, normalizePath, renderOneLine, replaceTabs, squash, textLineCount } from "./shared.js";

export function summarizeArgs(toolName: string, args: any): string {
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
    case "agent_task": {
      const action = squash(args?.action) || "?";
      const id = squash(args?.id);
      const task = squash(args?.task);
      if (action === "start") {
        const label = id ? `${id} • ` : "";
        return task ? `start ${label}${clip(task, 64)}` : `start${id ? ` ${id}` : ""}`;
      }
      return id ? `${action} ${id}` : action;
    }
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

export function summarizeResult(toolName: string, result: any): string {
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
    case "edit": {
      const counts = countDetailsLineDiff(details);
      if (counts) return ` ${colourDiffAdded(`+${counts.added}`)} ${colourDiffRemoved(`-${counts.removed}`)}`;
      break;
    }
    case "find":
    case "grep":
    case "ls": {
      const count = textLineCount(result);
      if (count > 0) return ` → ${count}`;
      break;
    }
    case "agent_task": {
      if (typeof details?.status === "string") return ` → ${details.status}`;
      if (Array.isArray(details?.tasks)) return ` → ${details.tasks.length}`;
      if (Array.isArray(details?.cancelled)) return ` → ${details.cancelled.length} cancelled`;
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

export function getToolSpinnerFrame(_state: any): string {
  // Keep pending compact tool rows static. An animated spinner repeatedly
  // requested renders while tools were collapsed, which made browser-side
  // scroll anchoring/observers loop when Ctrl+O expanded tool uses.
  return "⠋";
}

export function toolStatusPrefix(state: any): string {
  if (state?.isPartial) return getToolSpinnerFrame(state);
  return state?.result?.isError ? "✗" : "✓";
}

export function buildToolLine(state: any): string {
  const toolName = state?.toolName ?? "tool";
  const prefix = toolStatusPrefix(state);
  const summary = clip(summarizeArgs(toolName, state?.args), MAX_SUMMARY_LENGTH);
  const suffix = summarizeResult(toolName, state?.result);
  const detail = summary || suffix ? ` ${TOOL_RULE} ${summary || "…"}${suffix}` : "";
  return `${prefix} ${toolName}${detail}`;
}

export function getToolBgToken(state: any): ToolBgToken {
  if (state?.isPartial) return "toolPendingBg";
  return state?.result?.isError ? "toolErrorBg" : "toolSuccessBg";
}

export function getToolBgFn(state: any): ((text: string) => string) | undefined {
  const token = getToolBgToken(state);

  // Do not inherit from ToolExecutionComponent internals: self-shell tools keep
  // contentBox at the pending colour, which makes settled compact rows look grey.
  return getThemeToolBgFn(token);
}

export function renderCompactToolLine(state: any, width: number): string[] {
  return renderOneLine(buildToolLine(state), width, getToolBgFn(state), true);
}

export type UserMessageWithContentBox = {
  contentBox?: unknown;
};

export type BoxWithVerticalPadding = Record<string, unknown> & {
  paddingY: number;
  bgFn?: unknown;
  children?: unknown;
  cache?: unknown;
  cachedText?: unknown;
  cachedWidth?: unknown;
  cachedLines?: unknown;
};

export type ToolExecutionWithShells = {
  contentBox?: unknown;
  contentText?: unknown;
  /**
   * Older Pi builds exposed expansion as a public field. Current Pi stores it
   * in a private #expanded slot, so pi-compact must not rely on this existing.
   */
  expanded?: boolean;
  setExpanded?: (expanded: boolean) => void;
  isPartial?: boolean;
  ui?: { requestRender?: () => void };
  [TOOL_SPINNER_INTERVAL_KEY]?: ReturnType<typeof setInterval>;
  [TOOL_SPINNER_FRAME_KEY]?: number;
};

const toolExpandedState = new WeakMap<object, boolean>();

export function getToolExpanded(component: ToolExecutionWithShells): boolean {
  const tracked = toolExpandedState.get(component);
  if (tracked !== undefined) return tracked;
  return component.expanded === true;
}

export function setToolExpandedState(component: ToolExecutionWithShells, expanded: boolean): void {
  toolExpandedState.set(component, expanded);
}

export function requestToolRender(component: ToolExecutionWithShells): void {
  const requestRender = component.ui?.requestRender;
  if (typeof requestRender !== "function") {
    stopToolSpinner(component);
    return;
  }

  try {
    requestRender.call(component.ui);
  } catch {
    stopToolSpinner(component);
  }
}

export function startToolSpinner(component: ToolExecutionWithShells): void {
  // Historical cleanup/no-op: compact pending tools used to start a render
  // interval here. The interval could keep mutating output while expansion was
  // toggled, causing an infinite scrolling loop in the UI. Leave the exported
  // helper in place, but ensure any old interval is cleared and render static
  // pending indicators instead.
  stopToolSpinner(component);
}

export function stopToolSpinner(component: ToolExecutionWithShells): void {
  const interval = component[TOOL_SPINNER_INTERVAL_KEY];
  if (interval !== undefined) clearInterval(interval);
  component[TOOL_SPINNER_INTERVAL_KEY] = undefined;
  component[TOOL_SPINNER_FRAME_KEY] = 0;
}

export function shouldRenderCompactToolLine(component: ToolExecutionWithShells): boolean {
  return state.toolRendering.mode === "compact" && !getToolExpanded(component);
}

export function syncToolSpinner(component: ToolExecutionWithShells, _compactLine: boolean): void {
  stopToolSpinner(component);
}

export function syncToolSpinnerForCurrentExpansion(component: ToolExecutionWithShells): void {
  syncToolSpinner(component, shouldRenderCompactToolLine(component));
}

export function getVerticalPaddingShell(value: unknown): BoxWithVerticalPadding | undefined {
  return isRecord(value) && typeof value.paddingY === "number" ? (value as BoxWithVerticalPadding) : undefined;
}

export function clearShellCache(shell: BoxWithVerticalPadding): void {
  shell.cache = undefined;
  shell.cachedText = undefined;
  shell.cachedWidth = undefined;
  shell.cachedLines = undefined;
}

export function withPaddingY<T>(shells: BoxWithVerticalPadding[], paddingY: number, render: () => T): T {
  const previous = shells.map((shell) => shell.paddingY);
  for (const shell of shells) {
    shell.paddingY = paddingY;
    clearShellCache(shell);
  }

  try {
    return render();
  } finally {
    shells.forEach((shell, index) => {
      shell.paddingY = previous[index] ?? shell.paddingY;
      clearShellCache(shell);
    });
  }
}
export function withoutLeadingBlankLine(lines: string[]): string[] {
  return lines.length > 0 && isBlankRenderedLine(lines[0]) ? lines.slice(1) : lines;
}

export function withToolGap(lines: string[]): string[] {
  const content = withoutLeadingBlankLine(lines);
  return state.toolRendering.gap && content.length > 0 ? ["", ...content] : content;
}

export function renderBorderlessTool(
  component: ToolExecutionWithShells,
  width: number,
  originalRender: (width: number) => string[],
): string[] {
  const shells = [getVerticalPaddingShell(component.contentBox), getVerticalPaddingShell(component.contentText)].filter(
    (shell): shell is BoxWithVerticalPadding => shell !== undefined,
  );
  return withPaddingY(shells, 0, () => withToolGap(originalRender.call(component, width)));
}

export function renderConfiguredTool(component: ToolExecutionWithShells, width: number, originalRender: (width: number) => string[]): string[] {
  const compactLine = shouldRenderCompactToolLine(component);
  syncToolSpinner(component, compactLine);

  if (state.toolRendering.mode === "hidden" || !Number.isFinite(width) || width <= 0) return [];

  if (compactLine) return withToolGap(renderCompactToolLine(component, width));
  if (state.toolRendering.mode === "borderless") return renderBorderlessTool(component, width, originalRender);
  return withToolGap(originalRender.call(component, width));
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

    proto.render = function piCompactToolRender(this: ToolExecutionWithShells & { hideComponent?: boolean }, width: number) {
      if (this.hideComponent) {
        stopToolSpinner(this);
        return [];
      }
      return renderConfiguredTool(this, width, originalRender);
    };

    proto.setExpanded = function piCompactToolSetExpanded(this: ToolExecutionWithShells, expanded: boolean) {
      // Ctrl+O should still use Pi's native expansion implementation. We only
      // mirror the requested state because modern ToolExecutionComponent keeps
      // its actual expansion flag in a private #expanded field that patches
      // cannot read. Without this mirror, compact rendering always thinks the
      // tool is collapsed and fights the native expanded display.
      setToolExpandedState(this, expanded);
      const result = originalSetExpanded.call(this, expanded);
      syncToolSpinnerForCurrentExpansion(this);
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
