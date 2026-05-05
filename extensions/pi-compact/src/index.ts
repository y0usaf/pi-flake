import { AssistantMessageComponent, CustomMessageComponent, ToolExecutionComponent, UserMessageComponent, type ExtensionAPI, getAgentDir } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { truncateToWidth, visibleWidth, type Component } from "@mariozechner/pi-tui";
import { homedir } from "node:os";

const MAX_SUMMARY_LENGTH = 120;
const MAX_RESULT_LENGTH = 72;
const MAX_USER_MESSAGE_LENGTH = 512;
const TOOL_RULE = "╱";
const USER_PROMPT_MARKER = ":::";
const THINKING_MARKER = "🧠";
const JANITOR_MARKER = "🧹";

const JANITOR_INDEX_CUSTOM_TYPE = "context-janitor-index";
const JANITOR_RESTORE_CUSTOM_TYPE = "context-janitor-restore";
const JANITOR_SUMMARY_CUSTOM_TYPE = "context-janitor-summary";
const JANITOR_NOTICE_CUSTOM_TYPE = "context-janitor-notice";
const JANITOR_CUSTOM_TYPES = new Set([JANITOR_INDEX_CUSTOM_TYPE, JANITOR_RESTORE_CUSTOM_TYPE, JANITOR_SUMMARY_CUSTOM_TYPE, JANITOR_NOTICE_CUSTOM_TYPE]);
const PI_COMPACT_GLOBAL_KEY = "__piCompactEnabled";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

type GapRenderingMode = "normal" | "borderless" | "compact" | "hidden";
type ThinkingMode = "normal" | "compact" | "hidden";
type ToolBgToken = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";
type ThemeFgToken = "toolDiffAdded" | "toolDiffRemoved" | "muted";

interface GapRendering {
  mode: GapRenderingMode;
  gap: boolean;
}

type ToolsSettings = GapRendering;
type UserSettings = GapRendering;

interface ThinkingSettings {
  mode: ThinkingMode;
}

interface PiCompactSettings {
  tools?: Partial<ToolsSettings>;
  user?: Partial<UserSettings>;
  thinking?: Partial<ThinkingSettings>;
}

interface ResolvedPiCompactSettings {
  tools: ToolsSettings;
  user: UserSettings;
  thinking: ThinkingSettings;
}

interface CompactThinkingState {
  charCount: number;
  startedAtMs: number;
  completedAtMs?: number;
  stopReason?: string;
}

interface CompactThinkingTiming {
  startedAtMs?: number;
  completedAtMs?: number;
}

type ThemeWithCompactColours = {
  bg(color: ToolBgToken, text: string): string;
  fg(color: ThemeFgToken, text: string): string;
};

const DEFAULT_PI_COMPACT_SETTINGS: ResolvedPiCompactSettings = {
  tools: { mode: "compact", gap: false },
  user: { mode: "borderless", gap: true },
  thinking: { mode: "compact" },
};

let patchPromise: Promise<boolean> | undefined;
let lastToolPatchError: string | undefined;
let lastUserPatchError: string | undefined;
let lastAssistantPatchError: string | undefined;
let lastCustomPatchError: string | undefined;
let lastConfigError: string | undefined;
let toolRendering = cloneGapRendering(DEFAULT_PI_COMPACT_SETTINGS.tools);
let userRendering = cloneGapRendering(DEFAULT_PI_COMPACT_SETTINGS.user);
let thinkingMode: ThinkingMode = DEFAULT_PI_COMPACT_SETTINGS.thinking.mode;
let activeTheme: ThemeWithCompactColours | undefined;

const thinkingTimings = new Map<string, CompactThinkingTiming>();

const TOOL_ORIGINAL_RENDER_KEY = "__piCompactOriginalToolRender";
const TOOL_ORIGINAL_SET_EXPANDED_KEY = "__piCompactOriginalToolSetExpanded";
const USER_ORIGINAL_RENDER_KEY = "__piCompactOriginalUserRender";
const ASSISTANT_ORIGINAL_RENDER_KEY = "__piCompactOriginalAssistantRender";
const CUSTOM_ORIGINAL_RENDER_KEY = "__piCompactOriginalCustomRender";
const ASSISTANT_ORIGINAL_UPDATE_CONTENT_KEY = "__piCompactOriginalAssistantUpdateContent";
const ASSISTANT_THINKING_STATE_KEY = "__piCompactThinkingState";
const ASSISTANT_THINKING_APPLIED_MODE_KEY = "__piCompactThinkingAppliedMode";
const ASSISTANT_THINKING_TIMING_KEY = "__piCompactThinkingTiming";
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;
const FULL_SGR_RESET_PATTERN = /\x1b\[(?:0)?m/g;
const BG_MARKER = "__pi_compact_bg_marker__";
const BRAILLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TOOL_SPINNER_INTERVAL_MS = 80;
const TOOL_SPINNER_INTERVAL_KEY = "__piCompactToolSpinnerInterval";
const TOOL_SPINNER_FRAME_KEY = "__piCompactToolSpinnerFrame";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCompactThinkingTiming(value: unknown): value is CompactThinkingTiming {
  if (!isRecord(value)) return false;

  const started = value.startedAtMs;
  const completed = value.completedAtMs;
  return (
    (started === undefined || (typeof started === "number" && Number.isFinite(started))) &&
    (completed === undefined || (typeof completed === "number" && Number.isFinite(completed)))
  );
}

function cloneGapRendering(value: GapRendering): GapRendering {
  return { mode: value.mode, gap: value.gap };
}

function hasSettings(value: object): boolean {
  return Object.keys(value).length > 0;
}

function parseGapRenderingMode(value: unknown): GapRenderingMode | undefined {
  if (typeof value !== "string") return undefined;

  switch (value.trim().toLowerCase()) {
    case "normal":
      return "normal";
    case "borderless":
      return "borderless";
    case "compact":
      return "compact";
    case "hidden":
    case "hide":
    case "off":
      return "hidden";
    default:
      return undefined;
  }
}

function parseThinkingMode(value: unknown): ThinkingMode | undefined {
  if (typeof value !== "string") return undefined;

  switch (value.trim().toLowerCase()) {
    case "normal":
      return "normal";
    case "compact":
      return "compact";
    case "hidden":
    case "hide":
    case "off":
      return "hidden";
    default:
      return undefined;
  }
}

function parseToolsSettings(raw: unknown): Partial<ToolsSettings> | undefined {
  if (!isRecord(raw)) return undefined;

  const settings: Partial<ToolsSettings> = {};
  const mode = parseGapRenderingMode(raw.mode);
  if (mode) settings.mode = mode;
  if (typeof raw.gap === "boolean") settings.gap = raw.gap;
  return hasSettings(settings) ? settings : undefined;
}

function parseUserSettings(raw: unknown): Partial<UserSettings> | undefined {
  if (!isRecord(raw)) return undefined;

  const settings: Partial<UserSettings> = {};
  const mode = parseGapRenderingMode(raw.mode);
  if (mode) settings.mode = mode;
  if (typeof raw.gap === "boolean") settings.gap = raw.gap;
  return hasSettings(settings) ? settings : undefined;
}

function parseThinkingSettings(raw: unknown): Partial<ThinkingSettings> | undefined {
  if (!isRecord(raw)) return undefined;

  const settings: Partial<ThinkingSettings> = {};
  const mode = parseThinkingMode(raw.mode);
  if (mode) settings.mode = mode;
  return hasSettings(settings) ? settings : undefined;
}

function parseSettings(raw: unknown): Partial<PiCompactSettings> {
  if (!isRecord(raw)) return {};

  const settings: Partial<PiCompactSettings> = {};
  const tools = parseToolsSettings(raw.tools);
  const user = parseUserSettings(raw.user);
  const thinking = parseThinkingSettings(raw.thinking);

  if (tools) settings.tools = tools;
  if (user) settings.user = user;
  if (thinking) settings.thinking = thinking;
  return settings;
}

function pickSettings(parsed: Record<string, unknown>): unknown {
  const extensionSettings = parsed.extensionSettings;
  if (!isRecord(extensionSettings)) return undefined;
  return extensionSettings["pi-compact"];
}

function readSettingsFile(path: string): Partial<PiCompactSettings> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!isRecord(parsed)) return {};
    return parseSettings(pickSettings(parsed));
  } catch (error) {
    lastConfigError = error instanceof Error ? error.stack ?? error.message : String(error);
    return {};
  }
}

function mergePiCompactSettings(...items: Partial<PiCompactSettings>[]): Partial<PiCompactSettings> {
  const merged: Partial<PiCompactSettings> = {};

  for (const item of items) {
    if (item.tools) merged.tools = { ...merged.tools, ...item.tools };
    if (item.user) merged.user = { ...merged.user, ...item.user };
    if (item.thinking) merged.thinking = { ...merged.thinking, ...item.thinking };
  }

  return merged;
}

function readPiCompactSettings(cwd: string): Partial<PiCompactSettings> {
  try {
    lastConfigError = undefined;
    return mergePiCompactSettings(
      readSettingsFile(join(getAgentDir(), "settings.json")),
      readSettingsFile(join(cwd, ".pi", "settings.json")),
    );
  } catch (error) {
    lastConfigError = error instanceof Error ? error.stack ?? error.message : String(error);
    return {};
  }
}

function resolvePiCompactSettings(cwd: string): ResolvedPiCompactSettings {
  const settings = readPiCompactSettings(cwd);
  return {
    tools: { ...DEFAULT_PI_COMPACT_SETTINGS.tools, ...settings.tools },
    user: { ...DEFAULT_PI_COMPACT_SETTINGS.user, ...settings.user },
    thinking: { ...DEFAULT_PI_COMPACT_SETTINGS.thinking, ...settings.thinking },
  };
}

function squash(value: unknown): string {
  return typeof value === "string" ? stripAnsi(value).replace(/\s+/g, " ").trim() : "";
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

function replaceTabs(value: string): string {
  return value.replace(/\t/g, "    ");
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
  const raw = stripAnsi(path);
  const clean = raw.startsWith("@") ? raw.slice(1) : raw;
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

type LineDiffCounts = { added: number; removed: number };

function asLineCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}

function hasLineDiff(counts: LineDiffCounts): boolean {
  return counts.added > 0 || counts.removed > 0;
}

function countDiffLines(diff: unknown): LineDiffCounts | undefined {
  if (typeof diff !== "string" || diff.length === 0) return undefined;

  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (/^\+\s*\d+\s/.test(line)) added++;
    else if (/^-\s*\d+\s/.test(line)) removed++;
  }

  const counts = { added, removed };
  return hasLineDiff(counts) ? counts : undefined;
}

function countMetricLines(metrics: unknown): LineDiffCounts | undefined {
  if (!isRecord(metrics)) return undefined;

  const added = asLineCount(metrics.added_lines ?? metrics.addedLines ?? metrics.added);
  const removed = asLineCount(metrics.removed_lines ?? metrics.removedLines ?? metrics.removed);
  if (added === undefined && removed === undefined) return undefined;

  const counts = { added: added ?? 0, removed: removed ?? 0 };
  return hasLineDiff(counts) ? counts : undefined;
}

function countDetailsLineDiff(details: unknown): LineDiffCounts | undefined {
  if (!isRecord(details)) return undefined;
  return countMetricLines(details.metrics) ?? countMetricLines(details) ?? countDiffLines(details.diff);
}

function colourDiffAdded(text: string): string {
  return activeTheme?.fg("toolDiffAdded", text) ?? text;
}

function colourDiffRemoved(text: string): string {
  return activeTheme?.fg("toolDiffRemoved", text) ?? text;
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

function getToolSpinnerFrame(state: any): string {
  const rawFrame = typeof state?.[TOOL_SPINNER_FRAME_KEY] === "number" ? state[TOOL_SPINNER_FRAME_KEY] : 0;
  const frame = Number.isFinite(rawFrame) ? Math.trunc(rawFrame) : 0;
  const index = ((frame % BRAILLE_SPINNER_FRAMES.length) + BRAILLE_SPINNER_FRAMES.length) % BRAILLE_SPINNER_FRAMES.length;
  return BRAILLE_SPINNER_FRAMES[index] ?? BRAILLE_SPINNER_FRAMES[0];
}

function toolStatusPrefix(state: any): string {
  if (state?.isPartial) return getToolSpinnerFrame(state);
  return state?.result?.isError ? "✗" : "✓";
}

function buildToolLine(state: any): string {
  const toolName = state?.toolName ?? "tool";
  const prefix = toolStatusPrefix(state);
  const summary = clip(summarizeArgs(toolName, state?.args), MAX_SUMMARY_LENGTH);
  const suffix = summarizeResult(toolName, state?.result);
  const detail = summary || suffix ? ` ${TOOL_RULE} ${summary || "…"}${suffix}` : "";
  return `${prefix} ${toolName}${detail}`;
}

function getToolBgToken(state: any): ToolBgToken {
  if (state?.isPartial) return "toolPendingBg";
  return state?.result?.isError ? "toolErrorBg" : "toolSuccessBg";
}

function getThemeToolBgFn(token: ToolBgToken): ((text: string) => string) | undefined {
  if (!activeTheme) return undefined;
  return (text: string) => activeTheme?.bg(token, text) ?? text;
}

function getToolBgFn(state: any): ((text: string) => string) | undefined {
  const token = getToolBgToken(state);

  // Do not inherit from ToolExecutionComponent internals: self-shell tools keep
  // contentBox at the pending colour, which makes settled compact rows look grey.
  return getThemeToolBgFn(token);
}

function splitWrappingAnsi(wrapper: (text: string) => string): { prefix: string; suffix: string } | undefined {
  const wrapped = wrapper(BG_MARKER);
  const markerIndex = wrapped.indexOf(BG_MARKER);
  if (markerIndex < 0) return undefined;
  return {
    prefix: wrapped.slice(0, markerIndex),
    suffix: wrapped.slice(markerIndex + BG_MARKER.length),
  };
}

function applyBackgroundPreservingResets(text: string, bgFn: (text: string) => string): string {
  const wrapping = splitWrappingAnsi(bgFn);
  if (!wrapping) return bgFn(text);

  // truncateToWidth() inserts full SGR resets around ellipses to close active
  // foreground styles. Full resets also clear the row background, so re-apply
  // the background after each one before the final background-only reset.
  return `${wrapping.prefix}${text.replace(FULL_SGR_RESET_PATTERN, (reset) => `${reset}${wrapping.prefix}`)}${wrapping.suffix}`;
}

function renderOneLine(rawLine: string, width: number, bgFn?: (text: string) => string, preserveAnsi = false): string[] {
  if (!Number.isFinite(width) || width <= 0) return [];

  const line = truncateToWidth(preserveAnsi ? rawLine : stripAnsi(rawLine), Math.max(1, width), "…");
  const padded = `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
  return [bgFn ? applyBackgroundPreservingResets(padded, bgFn) : padded];
}

function renderCompactToolLine(state: any, width: number): string[] {
  return renderOneLine(buildToolLine(state), width, getToolBgFn(state), true);
}

type UserMessageWithContentBox = {
  contentBox?: unknown;
};

type BoxWithVerticalPadding = Record<string, unknown> & {
  paddingY: number;
  bgFn?: unknown;
  children?: unknown;
  cache?: unknown;
  cachedText?: unknown;
  cachedWidth?: unknown;
  cachedLines?: unknown;
};

type ToolExecutionWithShells = {
  contentBox?: unknown;
  contentText?: unknown;
  expanded?: boolean;
  setExpanded?: (expanded: boolean) => void;
  isPartial?: boolean;
  ui?: { requestRender?: () => void };
  [TOOL_SPINNER_INTERVAL_KEY]?: ReturnType<typeof setInterval>;
  [TOOL_SPINNER_FRAME_KEY]?: number;
};

function requestToolRender(component: ToolExecutionWithShells): void {
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

function startToolSpinner(component: ToolExecutionWithShells): void {
  if (component[TOOL_SPINNER_INTERVAL_KEY] !== undefined) return;
  if (typeof component.ui?.requestRender !== "function") return;
  component[TOOL_SPINNER_FRAME_KEY] ??= 0;

  const interval = setInterval(() => {
    component[TOOL_SPINNER_FRAME_KEY] = ((component[TOOL_SPINNER_FRAME_KEY] ?? 0) + 1) % BRAILLE_SPINNER_FRAMES.length;
    requestToolRender(component);
  }, TOOL_SPINNER_INTERVAL_MS);

  if (typeof interval === "object" && interval && "unref" in interval && typeof interval.unref === "function") {
    interval.unref();
  }

  component[TOOL_SPINNER_INTERVAL_KEY] = interval;
}

function stopToolSpinner(component: ToolExecutionWithShells): void {
  const interval = component[TOOL_SPINNER_INTERVAL_KEY];
  if (interval !== undefined) clearInterval(interval);
  component[TOOL_SPINNER_INTERVAL_KEY] = undefined;
  component[TOOL_SPINNER_FRAME_KEY] = 0;
}

function shouldRenderCompactToolLine(component: ToolExecutionWithShells): boolean {
  return toolRendering.mode === "compact" && !component.expanded;
}

function syncToolSpinner(component: ToolExecutionWithShells, compactLine: boolean): void {
  if (compactLine && component.isPartial) startToolSpinner(component);
  else stopToolSpinner(component);
}

function syncToolSpinnerForCurrentExpansion(component: ToolExecutionWithShells): void {
  syncToolSpinner(component, shouldRenderCompactToolLine(component));
}

function getVerticalPaddingShell(value: unknown): BoxWithVerticalPadding | undefined {
  return isRecord(value) && typeof value.paddingY === "number" ? (value as BoxWithVerticalPadding) : undefined;
}

function clearShellCache(shell: BoxWithVerticalPadding): void {
  shell.cache = undefined;
  shell.cachedText = undefined;
  shell.cachedWidth = undefined;
  shell.cachedLines = undefined;
}

function withPaddingY<T>(shells: BoxWithVerticalPadding[], paddingY: number, render: () => T): T {
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

function isBlankRenderedLine(line: string): boolean {
  return stripAnsi(line).trim().length === 0;
}

function withoutLeadingBlankLine(lines: string[]): string[] {
  return lines.length > 0 && isBlankRenderedLine(lines[0]) ? lines.slice(1) : lines;
}

function withToolGap(lines: string[]): string[] {
  const content = withoutLeadingBlankLine(lines);
  return toolRendering.gap && content.length > 0 ? ["", ...content] : content;
}

function renderBorderlessTool(
  component: ToolExecutionWithShells,
  width: number,
  originalRender: (width: number) => string[],
): string[] {
  const shells = [getVerticalPaddingShell(component.contentBox), getVerticalPaddingShell(component.contentText)].filter(
    (shell): shell is BoxWithVerticalPadding => shell !== undefined,
  );
  return withPaddingY(shells, 0, () => withToolGap(originalRender.call(component, width)));
}

function renderConfiguredTool(component: ToolExecutionWithShells, width: number, originalRender: (width: number) => string[]): string[] {
  const compactLine = shouldRenderCompactToolLine(component);
  syncToolSpinner(component, compactLine);

  if (toolRendering.mode === "hidden" || !Number.isFinite(width) || width <= 0) return [];

  if (compactLine) return withToolGap(renderCompactToolLine(component, width));
  if (toolRendering.mode === "borderless") return renderBorderlessTool(component, width, originalRender);
  return withToolGap(originalRender.call(component, width));
}

function getUserMessageContentBox(component: UserMessageWithContentBox): BoxWithVerticalPadding | undefined {
  return getVerticalPaddingShell(component.contentBox);
}

function getUserBgFn(component: UserMessageWithContentBox): ((text: string) => string) | undefined {
  const bgFn = getUserMessageContentBox(component)?.bgFn;
  return typeof bgFn === "function" ? (bgFn as (text: string) => string) : undefined;
}

function getUserMessageTextFromComponent(component: UserMessageWithContentBox): string {
  const children = getUserMessageContentBox(component)?.children;
  if (!Array.isArray(children)) return "";

  for (const child of children) {
    if (typeof child?.text === "string") return child.text;
  }

  return "";
}

function getUserMessageTextFromRendered(lines: string[]): string {
  return squash(stripAnsi(lines.join(" ")));
}

function withUserZoneMarkers(lines: string[]): string[] {
  if (lines.length === 0) return lines;

  const marked = [...lines];
  marked[0] = OSC133_ZONE_START + marked[0];
  marked[marked.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + marked[marked.length - 1];
  return marked;
}

function withUserMessageGap(lines: string[]): string[] {
  return userRendering.gap && lines.length > 0 ? [...lines, ""] : lines;
}

function renderBorderlessUserMessage(
  component: UserMessageWithContentBox,
  width: number,
  originalRender: (width: number) => string[],
): string[] {
  const contentBox = getUserMessageContentBox(component);
  if (!contentBox) return originalRender.call(component, width);

  return withPaddingY([contentBox], 0, () => {
    const lines = originalRender.call(component, width);
    // Preserve Pi's post-user-message separation, but keep the blank row outside the grey background.
    return withUserMessageGap(lines);
  });
}

function renderCompactUserMessage(
  component: UserMessageWithContentBox,
  width: number,
  originalRender: (width: number) => string[],
): string[] {
  const text = getUserMessageTextFromComponent(component) || getUserMessageTextFromRendered(originalRender.call(component, width));
  const summary = clip(squash(text), MAX_USER_MESSAGE_LENGTH) || "…";
  return withUserMessageGap(withUserZoneMarkers(renderOneLine(`${USER_PROMPT_MARKER} ${summary}`, width, getUserBgFn(component))));
}

function renderConfiguredUserMessage(
  component: UserMessageWithContentBox,
  width: number,
  originalRender: (width: number) => string[],
): string[] {
  if (userRendering.mode === "hidden" || !Number.isFinite(width) || width <= 0) return [];
  if (userRendering.mode === "compact") return renderCompactUserMessage(component, width, originalRender);
  if (userRendering.mode === "borderless") return renderBorderlessUserMessage(component, width, originalRender);
  return originalRender.call(component, width);
}

function assistantThinkingTimingKeys(message: any): string[] {
  if (message?.role !== "assistant") return [];

  const api = typeof message.api === "string" ? message.api : "";
  const provider = typeof message.provider === "string" ? message.provider : "";
  const model = typeof message.model === "string" ? message.model : "";
  const keys: string[] = [];

  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
    keys.push(`${api}:${provider}:${model}:ts:${message.timestamp}`);
  }
  if (typeof message.responseId === "string" && message.responseId.length > 0) {
    keys.push(`${api}:${provider}:${model}:response:${message.responseId}`);
  }

  return [...new Set(keys)];
}

function attachThinkingTiming(message: any, timing: CompactThinkingTiming): void {
  if (!isRecord(message)) return;

  try {
    Object.defineProperty(message, ASSISTANT_THINKING_TIMING_KEY, {
      value: timing,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    try {
      message[ASSISTANT_THINKING_TIMING_KEY] = timing;
    } catch {
      // Ignore non-extensible message objects.
    }
  }
}

function storeThinkingTiming(message: any, timing: CompactThinkingTiming): void {
  for (const key of assistantThinkingTimingKeys(message)) {
    thinkingTimings.set(key, timing);
  }
  attachThinkingTiming(message, timing);
}

function getThinkingTiming(message: any): CompactThinkingTiming | undefined {
  const attached = message?.[ASSISTANT_THINKING_TIMING_KEY];
  if (isCompactThinkingTiming(attached)) return attached;

  for (const key of assistantThinkingTimingKeys(message)) {
    const timing = thinkingTimings.get(key);
    if (timing) return timing;
  }

  return undefined;
}

function recordAssistantThinkingTiming(message: any, assistantEvent?: any, final = false): void {
  if (message?.role !== "assistant") return;

  const eventType = assistantEvent?.type;
  const startsThinking = eventType === "start" || eventType === "thinking_start" || eventType === "thinking_delta";
  let timing = getThinkingTiming(message);
  if (!timing) {
    if (!startsThinking) return;
    timing = {};
  }

  const now = Date.now();
  if (eventType === "start") {
    timing.startedAtMs ??= now;
    timing.completedAtMs = undefined;
  } else if (eventType === "thinking_start") {
    timing.startedAtMs ??= now;
    timing.completedAtMs = undefined;
  } else if (eventType === "thinking_delta") {
    timing.startedAtMs ??= now;
  } else if (eventType === "thinking_end") {
    timing.startedAtMs ??= now;
  }

  const completesThinking =
    final ||
    eventType === "thinking_end" ||
    eventType === "text_start" ||
    eventType === "text_delta" ||
    eventType === "text_end" ||
    eventType === "toolcall_start" ||
    eventType === "toolcall_delta" ||
    eventType === "toolcall_end" ||
    eventType === "done" ||
    eventType === "error";
  if (completesThinking && timing.startedAtMs !== undefined && timing.completedAtMs === undefined) {
    timing.completedAtMs = now;
  }

  if (timing.startedAtMs !== undefined) storeThinkingTiming(message, timing);
}

function recordAssistantThinkingTimingForEvent(event: any, final = false): void {
  const assistantEvent = event?.assistantMessageEvent;
  recordAssistantThinkingTiming(event?.message, assistantEvent, final);

  const eventMessage = assistantEvent?.partial ?? assistantEvent?.message ?? assistantEvent?.error;
  if (eventMessage && eventMessage !== event?.message) recordAssistantThinkingTiming(eventMessage, assistantEvent, final);
}

function getThinkingBlocks(message: any): string[] {
  if (!Array.isArray(message?.content)) return [];
  return message.content
    .filter((content: any) => content?.type === "thinking" && typeof content.thinking === "string")
    .map((content: any) => content.thinking.trim());
}

function cloneWithoutThinking(message: any): any {
  if (!Array.isArray(message?.content)) return message;
  return {
    ...message,
    content: message.content.filter((content: any) => content?.type !== "thinking"),
  };
}

function isThinkingActive(message: any): boolean {
  if (message?.stopReason === "error" || message?.stopReason === "aborted" || !Array.isArray(message?.content)) return false;

  for (let index = message.content.length - 1; index >= 0; index--) {
    const content = message.content[index];
    if (content?.type === "thinking" && typeof content.thinking === "string") return true;
    if (content?.type === "text" || content?.type === "toolCall") return false;
  }

  return false;
}

function createThinkingState(
  message: any,
  blocks: string[],
  previous?: CompactThinkingState,
  timing?: CompactThinkingTiming,
): CompactThinkingState {
  const text = blocks.join("\n");
  const now = Date.now();
  const active = timing?.completedAtMs === undefined && isThinkingActive(message);
  const state: CompactThinkingState = {
    charCount: stripAnsi(text).length,
    startedAtMs: timing?.startedAtMs ?? previous?.startedAtMs ?? now,
  };

  const completedAtMs = timing?.completedAtMs ?? (!active ? previous?.completedAtMs ?? now : undefined);
  if (completedAtMs !== undefined) state.completedAtMs = completedAtMs;
  if (message?.stopReason === "error" || message?.stopReason === "aborted") state.stopReason = message.stopReason;
  return state;
}

function formatCount(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function elapsedThinkingSeconds(state: CompactThinkingState): number {
  const end = state.completedAtMs ?? Date.now();
  return Math.max(0, (end - state.startedAtMs) / 1000);
}

function formatElapsedSeconds(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

function buildThinkingLine(state: CompactThinkingState): string {
  const elapsed = formatElapsedSeconds(elapsedThinkingSeconds(state));
  const characters = formatCount(state.charCount, "char");
  const suffix = state.stopReason === "error" ? " → error" : state.stopReason === "aborted" ? " → aborted" : "";

  return `${THINKING_MARKER} ${elapsed} · ${characters}${suffix}`;
}

function getThinkingBgFn(state: CompactThinkingState): ((text: string) => string) | undefined {
  if (state.stopReason === "error" || state.stopReason === "aborted") return getThemeToolBgFn("toolErrorBg");
  return getThemeToolBgFn(state.completedAtMs === undefined ? "toolPendingBg" : "toolSuccessBg");
}

function renderCompactThinkingLine(state: CompactThinkingState, width: number): string[] {
  const line = activeTheme?.fg("muted", buildThinkingLine(state)) ?? buildThinkingLine(state);
  return renderOneLine(line, width, getThinkingBgFn(state), true);
}

function patchToolExecutionComponent(): boolean {
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
      const result = originalSetExpanded.call(this, expanded);
      syncToolSpinnerForCurrentExpansion(this);
      return result;
    };

    proto[TOOL_ORIGINAL_RENDER_KEY] = originalRender;
    proto[TOOL_ORIGINAL_SET_EXPANDED_KEY] = originalSetExpanded;
    lastToolPatchError = undefined;
    return true;
  } catch (error) {
    lastToolPatchError = error instanceof Error ? error.stack ?? error.message : String(error);
    return false;
  }
}

function patchUserMessageComponent(): boolean {
  try {
    const proto = (UserMessageComponent as any)?.prototype;
    if (!proto || typeof proto.render !== "function") {
      throw new Error("UserMessageComponent unavailable");
    }

    const originalRender = typeof proto[USER_ORIGINAL_RENDER_KEY] === "function" ? proto[USER_ORIGINAL_RENDER_KEY] : proto.render;

    proto.render = function piCompactUserRender(this: UserMessageWithContentBox, width: number) {
      return renderConfiguredUserMessage(this, width, originalRender);
    };

    proto[USER_ORIGINAL_RENDER_KEY] = originalRender;
    lastUserPatchError = undefined;
    return true;
  } catch (error) {
    lastUserPatchError = error instanceof Error ? error.stack ?? error.message : String(error);
    return false;
  }
}


type CustomThemeLike = {
  fg(color: string, text: string): string;
  bold?(text: string): string;
};

type CustomMessageLike = {
  customType?: string;
  content?: unknown;
  details?: unknown;
};

function themeFg(theme: CustomThemeLike, color: string, text: string): string {
  try {
    return theme.fg(color, text);
  } catch {
    return text;
  }
}

function textFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    else if (part.type === "image") parts.push("[image]");
    else if (part.type === "thinking" && typeof part.thinking === "string") parts.push(part.thinking);
  }
  return parts.join("\n");
}

function numberFromDetails(details: unknown, key: string): number | undefined {
  if (!isRecord(details)) return undefined;
  const value = details[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayLengthFromDetails(details: unknown, key: string): number | undefined {
  if (!isRecord(details)) return undefined;
  const value = details[key];
  return Array.isArray(value) ? value.length : undefined;
}

function plural(value: number, singular: string, pluralText = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : pluralText}`;
}

function formatCompactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatCompactChars(value: number): string {
  return `${formatCompactCount(value)}ch`;
}

function compactJanitorNoticeLine(message: CustomMessageLike): string {
  const details = message.details;
  const rawText = squash(textFromMessageContent(message.content));
  const rawChars = numberFromDetails(details, "rawChars");
  const projectedChars = numberFromDetails(details, "projectedChars");
  const savedChars = rawChars !== undefined && projectedChars !== undefined ? Math.max(0, rawChars - projectedChars) : undefined;
  const toolCalls = numberFromDetails(details, "toolCalls");
  const summaryId = isRecord(details) && typeof details.summaryId === "string" ? details.summaryId : undefined;
  const restoreCount = arrayLengthFromDetails(details, "summaryIds");

  if (restoreCount !== undefined) {
    return `${JANITOR_MARKER} restored ${plural(restoreCount, "janitor run")}`;
  }

  if (toolCalls !== undefined) {
    const parts = [`${JANITOR_MARKER} truncated ${plural(toolCalls, "tool output")}`];
    if (savedChars !== undefined) parts.push(`saved ≈${formatCompactChars(savedChars)}`);
    if (summaryId) parts.push(summaryId);
    return parts.join(" · ");
  }

  if (rawText) return `${JANITOR_MARKER} ${clip(rawText, MAX_SUMMARY_LENGTH)}`;
  return `${JANITOR_MARKER} Context Janitor`;
}

class HiddenCustomMessageComponent implements Component {
  invalidate(): void {}
  render(_width: number): string[] {
    return [];
  }
}

class CompactJanitorNoticeComponent implements Component {
  constructor(
    private readonly message: CustomMessageLike,
    private readonly theme: CustomThemeLike,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (!Number.isFinite(width) || width <= 0) return [];
    const line = themeFg(this.theme, "muted", compactJanitorNoticeLine(this.message));
    return [truncateToWidth(replaceTabs(line), Math.max(1, width), "…")];
  }
}

function registerJanitorMessageRenderers(pi: ExtensionAPI): void {
  const hidden = () => new HiddenCustomMessageComponent();
  pi.registerMessageRenderer(JANITOR_INDEX_CUSTOM_TYPE, hidden);
  pi.registerMessageRenderer(JANITOR_RESTORE_CUSTOM_TYPE, hidden);
  pi.registerMessageRenderer(JANITOR_SUMMARY_CUSTOM_TYPE, hidden);
  pi.registerMessageRenderer(JANITOR_NOTICE_CUSTOM_TYPE, (message, _state, theme) => {
    return new CompactJanitorNoticeComponent(message as CustomMessageLike, theme as CustomThemeLike);
  });
}

type CustomMessageComponentWithMessage = {
  message?: { customType?: unknown };
};

function janitorCustomType(component: CustomMessageComponentWithMessage): string | undefined {
  const customType = component.message?.customType;
  return typeof customType === "string" && JANITOR_CUSTOM_TYPES.has(customType) ? customType : undefined;
}

function withoutLeadingBlankLines(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length && isBlankRenderedLine(lines[start] ?? "")) start += 1;
  return start === 0 ? lines : lines.slice(start);
}

function renderConfiguredCustomMessage(
  component: CustomMessageComponentWithMessage,
  width: number,
  originalRender: (width: number) => string[],
): string[] {
  const lines = originalRender.call(component, width);
  const customType = janitorCustomType(component);
  if (!customType) return lines;

  const content = withoutLeadingBlankLines(lines);
  if (customType !== JANITOR_NOTICE_CUSTOM_TYPE || !Number.isFinite(width) || width <= 0) return content;

  const bgFn = getThemeToolBgFn("toolSuccessBg");
  return content.flatMap((line) => renderOneLine(replaceTabs(line), width, bgFn, true));
}

function patchCustomMessageComponent(): boolean {
  try {
    const proto = (CustomMessageComponent as any)?.prototype;
    if (!proto || typeof proto.render !== "function") {
      throw new Error("CustomMessageComponent unavailable");
    }

    const originalRender = typeof proto[CUSTOM_ORIGINAL_RENDER_KEY] === "function" ? proto[CUSTOM_ORIGINAL_RENDER_KEY] : proto.render;

    proto.render = function piCompactCustomRender(this: CustomMessageComponentWithMessage, width: number) {
      return renderConfiguredCustomMessage(this, width, originalRender);
    };

    proto[CUSTOM_ORIGINAL_RENDER_KEY] = originalRender;
    lastCustomPatchError = undefined;
    return true;
  } catch (error) {
    lastCustomPatchError = error instanceof Error ? error.stack ?? error.message : String(error);
    return false;
  }
}

function patchAssistantMessageComponent(): boolean {
  try {
    const proto = (AssistantMessageComponent as any)?.prototype;
    if (!proto || typeof proto.render !== "function" || typeof proto.updateContent !== "function") {
      throw new Error("AssistantMessageComponent unavailable");
    }

    const originalRender = typeof proto[ASSISTANT_ORIGINAL_RENDER_KEY] === "function" ? proto[ASSISTANT_ORIGINAL_RENDER_KEY] : proto.render;
    const originalUpdateContent =
      typeof proto[ASSISTANT_ORIGINAL_UPDATE_CONTENT_KEY] === "function"
        ? proto[ASSISTANT_ORIGINAL_UPDATE_CONTENT_KEY]
        : proto.updateContent;

    proto.updateContent = function piCompactAssistantUpdateContent(this: any, message: any) {
      const blocks = getThinkingBlocks(message);
      this[ASSISTANT_THINKING_APPLIED_MODE_KEY] = thinkingMode;

      if (blocks.length === 0 || thinkingMode === "normal") {
        this[ASSISTANT_THINKING_STATE_KEY] = undefined;
        return originalUpdateContent.call(this, message);
      }

      this[ASSISTANT_THINKING_STATE_KEY] = createThinkingState(
        message,
        blocks,
        this[ASSISTANT_THINKING_STATE_KEY],
        getThinkingTiming(message),
      );

      try {
        return originalUpdateContent.call(this, cloneWithoutThinking(message));
      } finally {
        this.lastMessage = message;
      }
    };

    proto.render = function piCompactAssistantRender(this: any, width: number) {
      if (this[ASSISTANT_THINKING_APPLIED_MODE_KEY] !== thinkingMode && this.lastMessage) {
        this.updateContent(this.lastMessage);
      }

      const lines = originalRender.call(this, width);
      const thinkingState = this[ASSISTANT_THINKING_STATE_KEY] as CompactThinkingState | undefined;
      if (thinkingMode !== "compact" || !thinkingState) return lines;

      const thinkingLines = renderCompactThinkingLine(thinkingState, width);
      return thinkingLines.length > 0 ? [...thinkingLines, ...lines] : lines;
    };

    proto[ASSISTANT_ORIGINAL_RENDER_KEY] = originalRender;
    proto[ASSISTANT_ORIGINAL_UPDATE_CONTENT_KEY] = originalUpdateContent;
    lastAssistantPatchError = undefined;
    return true;
  } catch (error) {
    lastAssistantPatchError = error instanceof Error ? error.stack ?? error.message : String(error);
    return false;
  }
}

async function patchPiCompactComponents(): Promise<boolean> {
  if (patchPromise) return patchPromise;

  patchPromise = (async () => {
    const toolsOk = patchToolExecutionComponent();
    const usersOk = patchUserMessageComponent();
    const assistantOk = patchAssistantMessageComponent();
    const customOk = patchCustomMessageComponent();
    return toolsOk && usersOk && assistantOk && customOk;
  })();

  return patchPromise;
}

function patchErrorDetails(): string {
  const errors = [];
  if (lastToolPatchError) errors.push(`tools: ${lastToolPatchError}`);
  if (lastUserPatchError) errors.push(`user-messages: ${lastUserPatchError}`);
  if (lastAssistantPatchError) errors.push(`thinking: ${lastAssistantPatchError}`);
  if (lastCustomPatchError) errors.push(`custom-messages: ${lastCustomPatchError}`);
  if (lastConfigError) errors.push(`config: ${lastConfigError}`);
  return errors.length > 0 ? `\n${errors.join("\n")}` : "";
}

function formatGapRendering(value: GapRendering): string {
  return value.mode === "normal" || value.mode === "hidden" ? value.mode : `${value.mode}${value.gap ? "+gap" : "+tight"}`;
}

function statusMessage(): string {
  const toolsStatus = lastToolPatchError ? "failed" : formatGapRendering(toolRendering);
  const userStatus = lastUserPatchError ? "failed" : formatGapRendering(userRendering);
  const thinkingStatus = lastAssistantPatchError ? "failed" : thinkingMode;
  const customStatus = lastCustomPatchError ? "failed" : "compact";
  return `pi-compact: tools=${toolsStatus} • user=${userStatus} • thinking=${thinkingStatus} • custom=${customStatus}${patchErrorDetails()}`;
}

function hasStatusError(): boolean {
  return Boolean(lastToolPatchError || lastUserPatchError || lastAssistantPatchError || lastCustomPatchError || lastConfigError);
}

function parseGapRenderingArg(args: string, current: GapRendering, defaultValue: GapRendering): GapRendering | undefined {
  const value = args.trim().toLowerCase();
  if (!value || value === "status") return current;

  switch (value) {
    case "normal":
      return { ...current, mode: "normal" };
    case "borderless":
      return { ...current, mode: "borderless", gap: defaultValue.gap };
    case "borderless-tight":
      return { ...current, mode: "borderless", gap: false };
    case "compact":
      return { ...current, mode: "compact", gap: defaultValue.gap };
    case "compact-tight":
      return { ...current, mode: "compact", gap: false };
    case "hidden":
    case "hide":
    case "off":
      return { ...current, mode: "hidden" };
    case "gap":
      return { ...current, gap: true };
    case "no-gap":
    case "nogap":
      return { ...current, gap: false };
    case "toggle":
      return current.mode === "normal" || current.mode === "hidden" ? cloneGapRendering(defaultValue) : { ...current, mode: "normal" };
    case "cycle":
      if (current.mode === "normal") return { ...current, mode: "borderless", gap: defaultValue.gap };
      if (current.mode === "borderless") return { ...current, mode: "compact", gap: defaultValue.gap };
      if (current.mode === "compact") return { ...current, mode: "hidden" };
      return { ...current, mode: "normal" };
    default:
      return undefined;
  }
}

function parseThinkingArg(args: string, current: ThinkingMode): ThinkingMode | undefined {
  const value = args.trim().toLowerCase();
  if (!value || value === "status") return current;

  switch (value) {
    case "normal":
      return "normal";
    case "compact":
      return "compact";
    case "hidden":
    case "hide":
    case "off":
      return "hidden";
    case "toggle":
      if (current === "normal") return "compact";
      return current === "compact" ? "hidden" : "compact";
    default:
      return undefined;
  }
}

void patchPiCompactComponents();

export default function (pi: ExtensionAPI) {
  (globalThis as Record<string, unknown>)[PI_COMPACT_GLOBAL_KEY] = true;
  registerJanitorMessageRenderers(pi);

  pi.on("message_update", (event) => {
    recordAssistantThinkingTimingForEvent(event);
  });

  pi.on("message_end", (event) => {
    recordAssistantThinkingTimingForEvent(event, true);
  });

  pi.registerCommand("compact-status", {
    description: "Show pi-compact patch status",
    handler: async (_args, ctx) => {
      await patchPiCompactComponents();
      ctx.ui.notify(statusMessage(), hasStatusError() ? "error" : "info");
    },
  });

  pi.registerCommand("compact-user", {
    description: "Set user message rendering (normal|borderless|borderless-tight|compact|compact-tight|hidden)",
    handler: async (args, ctx) => {
      const next = parseGapRenderingArg(args, userRendering, DEFAULT_PI_COMPACT_SETTINGS.user);
      if (next === undefined) {
        ctx.ui.notify("Usage: /compact-user [normal|borderless|borderless-tight|compact|compact-tight|hidden|gap|no-gap|toggle|cycle|status]", "error");
        return;
      }

      userRendering = next;
      await patchPiCompactComponents();
      ctx.ui.notify(statusMessage(), hasStatusError() ? "error" : "info");
    },
  });

  pi.registerCommand("compact-tools", {
    description: "Set tool rendering (normal|borderless|borderless-tight|compact|compact-tight|hidden)",
    handler: async (args, ctx) => {
      const next = parseGapRenderingArg(args, toolRendering, DEFAULT_PI_COMPACT_SETTINGS.tools);
      if (next === undefined) {
        ctx.ui.notify("Usage: /compact-tools [normal|borderless|borderless-tight|compact|compact-tight|hidden|gap|no-gap|toggle|cycle|status]", "error");
        return;
      }

      toolRendering = next;
      await patchPiCompactComponents();
      ctx.ui.notify(statusMessage(), hasStatusError() ? "error" : "info");
    },
  });

  pi.registerCommand("compact-thinking", {
    description: "Set thinking rendering (normal|compact|hidden|toggle)",
    handler: async (args, ctx) => {
      const next = parseThinkingArg(args, thinkingMode);
      if (next === undefined) {
        ctx.ui.notify("Usage: /compact-thinking [normal|compact|hidden|toggle|status]", "error");
        return;
      }

      thinkingMode = next;
      await patchPiCompactComponents();
      ctx.ui.notify(statusMessage(), hasStatusError() ? "error" : "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const settings = resolvePiCompactSettings(ctx.cwd);
    toolRendering = cloneGapRendering(settings.tools);
    userRendering = cloneGapRendering(settings.user);
    thinkingMode = settings.thinking.mode;
    activeTheme = ctx.hasUI ? ctx.ui.theme : undefined;

    await patchPiCompactComponents();
    if (!ctx.hasUI) return;
    if (hasStatusError()) ctx.ui.notify(statusMessage(), "error");
  });
}

