import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, type ExtensionAPI, getAgentDir } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { homedir } from "node:os";

const MAX_SUMMARY_LENGTH = 120;
const MAX_RESULT_LENGTH = 72;
const MAX_USER_INPUT_LENGTH = 512;

const COMPACT_USER_INPUTS_FLAG = "compact-user-inputs";
const COMPACT_USER_INPUTS_ENV = "PI_COMPACT_USER_INPUTS";

type CompactThinkingMode = "normal" | "compact" | "hidden";

const DEFAULT_COMPACT_TOOLS = true;
const DEFAULT_COMPACT_USER_INPUTS = true;
const DEFAULT_COMPACT_THINKING: CompactThinkingMode = "compact";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

let patchPromise: Promise<boolean> | undefined;
let lastToolPatchError: string | undefined;
let lastUserPatchError: string | undefined;
let lastAssistantPatchError: string | undefined;
let lastConfigError: string | undefined;
let compactTools = DEFAULT_COMPACT_TOOLS;
let compactUserInputs = envBool(COMPACT_USER_INPUTS_ENV) ?? DEFAULT_COMPACT_USER_INPUTS;
let compactThinking = DEFAULT_COMPACT_THINKING;
type ToolBgToken = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";
type ThemeFgToken = "toolDiffAdded" | "toolDiffRemoved" | "thinkingText";

type ThemeWithCompactColours = {
  bg(color: ToolBgToken, text: string): string;
  fg(color: ThemeFgToken, text: string): string;
};

let activeTheme: ThemeWithCompactColours | undefined;

const TOOL_ORIGINAL_RENDER_KEY = "__piCompactOriginalToolRender";
const USER_ORIGINAL_RENDER_KEY = "__piCompactOriginalUserRender";
const ASSISTANT_ORIGINAL_RENDER_KEY = "__piCompactOriginalAssistantRender";
const ASSISTANT_ORIGINAL_UPDATE_CONTENT_KEY = "__piCompactOriginalAssistantUpdateContent";
const ASSISTANT_THINKING_STATE_KEY = "__piCompactThinkingState";
const ASSISTANT_THINKING_APPLIED_MODE_KEY = "__piCompactThinkingAppliedMode";
const ASSISTANT_THINKING_TIMING_KEY = "__piCompactThinkingTiming";
const LEGACY_TOOL_ORIGINAL_RENDER_KEY = "__compactToolsPatchedOriginalRender";
const LEGACY_ORIGINAL_UPDATE_DISPLAY_KEY = "__compactToolsPatchedOriginalUpdateDisplay";

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;

function envBool(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

interface PiCompactSettings {
  user?: boolean;
  tools?: boolean;
  thinking?: CompactThinkingMode;
}

type ResolvedPiCompactSettings = Required<Pick<PiCompactSettings, "user" | "tools" | "thinking">>;

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

const thinkingTimings = new Map<string, CompactThinkingTiming>();

const DEFAULT_PI_COMPACT_SETTINGS: ResolvedPiCompactSettings = {
  tools: DEFAULT_COMPACT_TOOLS,
  user: DEFAULT_COMPACT_USER_INPUTS,
  thinking: DEFAULT_COMPACT_THINKING,
};

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

function parseThinkingMode(value: unknown): CompactThinkingMode | undefined {
  if (typeof value === "boolean") return value ? "compact" : "normal";
  if (typeof value !== "string") return undefined;

  const normalized = value.trim().toLowerCase();
  if (["1", "on", "true", "yes", "y", "enable", "enabled", "compact"].includes(normalized)) return "compact";
  if (["0", "off", "false", "no", "n", "disable", "disabled", "normal"].includes(normalized)) return "normal";
  if (["hide", "hidden", "none"].includes(normalized)) return "hidden";
  return undefined;
}

function parseSettings(raw: unknown): Partial<PiCompactSettings> {
  if (typeof raw === "boolean") return { tools: raw, thinking: raw ? "compact" : "normal" };
  if (!isRecord(raw)) return {};
  const out: Partial<PiCompactSettings> = {};
  if (typeof raw.user === "boolean") out.user = raw.user;
  if (typeof raw.tools === "boolean") out.tools = raw.tools;

  const thinking = parseThinkingMode(raw.thinking ?? raw.thinking_mode);
  if (thinking !== undefined) out.thinking = thinking;

  return out;
}

function readSettingsFile(path: string): Partial<PiCompactSettings> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!isRecord(parsed)) return {};
    return parseSettings(parsed["pi-compact"]);
  } catch (error) {
    lastConfigError = error instanceof Error ? error.stack ?? error.message : String(error);
    return {};
  }
}

function readPiCompactSettings(cwd: string): Partial<PiCompactSettings> {
  try {
    lastConfigError = undefined;
    return {
      ...readSettingsFile(join(getAgentDir(), "extension-settings.json")),
      ...readSettingsFile(join(cwd, ".pi", "extension-settings.json")),
    };
  } catch (error) {
    lastConfigError = error instanceof Error ? error.stack ?? error.message : String(error);
    return {};
  }
}

function resolvePiCompactSettings(cwd: string, pi: ExtensionAPI): ResolvedPiCompactSettings {
  const settings = readPiCompactSettings(cwd);
  const envUser = envBool(COMPACT_USER_INPUTS_ENV);

  return {
    ...DEFAULT_PI_COMPACT_SETTINGS,
    ...settings,
    user: pi.getFlag(COMPACT_USER_INPUTS_FLAG) === true ? true : envUser ?? settings.user ?? DEFAULT_COMPACT_USER_INPUTS,
  };
}

function squash(value: unknown): string {
  return typeof value === "string" ? stripAnsi(value).replace(/\s+/g, " ").trim() : "";
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
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

function countDiffLines(diff: unknown): { added: number; removed: number } | undefined {
  if (typeof diff !== "string" || diff.length === 0) return undefined;

  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (/^\+\s*\d+\s/.test(line)) added++;
    else if (/^-\s*\d+\s/.test(line)) removed++;
  }

  return added > 0 || removed > 0 ? { added, removed } : undefined;
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
    case "edit": {
      const counts = countDiffLines(details?.diff);
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

function buildToolLine(state: any): string {
  const prefix = state?.isPartial ? "… " : state?.result?.isError ? "✗ " : "✓ ";
  const summary = clip(summarizeArgs(state?.toolName ?? "tool", state?.args), MAX_SUMMARY_LENGTH);
  const suffix = summarizeResult(state?.toolName ?? "tool", state?.result);
  return `${prefix}${state?.toolName ?? "tool"} ${summary || "…"}${suffix}`;
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

function renderOneLine(rawLine: string, width: number, bgFn?: (text: string) => string, preserveAnsi = false): string[] {
  if (!Number.isFinite(width) || width <= 0) return [];

  const line = truncateToWidth(preserveAnsi ? rawLine : stripAnsi(rawLine), Math.max(1, width), "…");
  const padded = `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
  return [bgFn ? bgFn(padded) : padded];
}

function renderCompactToolLine(state: any, width: number): string[] {
  return renderOneLine(buildToolLine(state), width, getToolBgFn(state), true);
}

function getUserMessageTextFromComponent(component: any): string {
  const children = component?.contentBox?.children;
  if (!Array.isArray(children)) return "";

  for (const child of children) {
    if (typeof child?.text === "string") return child.text;
  }

  return "";
}

function getUserMessageTextFromRendered(lines: string[]): string {
  return squash(stripAnsi(lines.join(" ")));
}

function getUserBgFn(component: any): ((text: string) => string) | undefined {
  const bgFn = component?.contentBox?.bgFn;
  return typeof bgFn === "function" ? bgFn : undefined;
}

function withUserZoneMarkers(lines: string[]): string[] {
  if (lines.length === 0) return lines;

  const marked = [...lines];
  marked[0] = OSC133_ZONE_START + marked[0];
  marked[marked.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + marked[marked.length - 1];
  return marked;
}

function renderCompactUserLine(component: any, width: number, originalRender: (width: number) => string[]): string[] {
  if (!Number.isFinite(width) || width <= 0) return [];

  const text = getUserMessageTextFromComponent(component) || getUserMessageTextFromRendered(originalRender.call(component, width));
  const summary = clip(squash(text), MAX_USER_INPUT_LENGTH) || "…";
  return withUserZoneMarkers(renderOneLine(`› ${summary}`, width, getUserBgFn(component)));
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
  const hasThinkingEvent = eventType === "thinking_start" || eventType === "thinking_delta" || eventType === "thinking_end";
  let timing = getThinkingTiming(message);
  if (!timing) {
    if (!hasThinkingEvent) return;
    timing = {};
  }

  const now = Date.now();
  if (eventType === "thinking_start") {
    timing.startedAtMs ??= now;
    timing.completedAtMs = undefined;
  } else if (eventType === "thinking_delta") {
    timing.startedAtMs ??= now;
  } else if (eventType === "thinking_end") {
    timing.startedAtMs ??= now;
    timing.completedAtMs = now;
  }

  const completesThinking =
    final ||
    eventType === "text_start" ||
    eventType === "text_delta" ||
    eventType === "text_end" ||
    eventType === "toolcall_start" ||
    eventType === "toolcall_delta" ||
    eventType === "toolcall_end";
  if (completesThinking && timing.startedAtMs !== undefined && timing.completedAtMs === undefined) {
    timing.completedAtMs = now;
  }

  if (timing.startedAtMs !== undefined) storeThinkingTiming(message, timing);
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
  return `${seconds.toFixed(1)} seconds`;
}

function buildThinkingLine(state: CompactThinkingState): string {
  const seconds = formatElapsedSeconds(elapsedThinkingSeconds(state));
  const characters = formatCount(state.charCount, "character");
  const status = state.completedAtMs === undefined ? "thinking" : "thought";
  const suffix = state.stopReason === "error" ? " → error" : state.stopReason === "aborted" ? " → aborted" : "";

  return `${status} for ${seconds}, ${characters}${suffix}`;
}

function renderCompactThinkingLine(state: CompactThinkingState, width: number): string[] {
  const line = buildThinkingLine(state);
  return renderOneLine(activeTheme?.fg("thinkingText", line) ?? line, width, undefined, true);
}

function patchToolExecutionComponent(): boolean {
  try {
    const proto = (ToolExecutionComponent as any)?.prototype;
    if (!proto || typeof proto.render !== "function") {
      throw new Error("ToolExecutionComponent unavailable");
    }

    if (typeof proto[LEGACY_ORIGINAL_UPDATE_DISPLAY_KEY] === "function") {
      proto.updateDisplay = proto[LEGACY_ORIGINAL_UPDATE_DISPLAY_KEY];
      delete proto[LEGACY_ORIGINAL_UPDATE_DISPLAY_KEY];
    }

    const originalRender =
      typeof proto[TOOL_ORIGINAL_RENDER_KEY] === "function"
        ? proto[TOOL_ORIGINAL_RENDER_KEY]
        : typeof proto[LEGACY_TOOL_ORIGINAL_RENDER_KEY] === "function"
          ? proto[LEGACY_TOOL_ORIGINAL_RENDER_KEY]
          : proto.render;

    proto.render = function piCompactToolRender(this: any, width: number) {
      if (this.hideComponent) return [];
      if (!compactTools || this.expanded) return originalRender.call(this, width);
      return renderCompactToolLine(this, width);
    };

    proto.__piCompactToolRowsPatched = true;
    proto[TOOL_ORIGINAL_RENDER_KEY] = originalRender;
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

    proto.render = function piCompactUserRender(this: any, width: number) {
      if (!compactUserInputs) return originalRender.call(this, width);
      return renderCompactUserLine(this, width, originalRender);
    };

    proto.__piCompactUserInputsPatched = true;
    proto[USER_ORIGINAL_RENDER_KEY] = originalRender;
    lastUserPatchError = undefined;
    return true;
  } catch (error) {
    lastUserPatchError = error instanceof Error ? error.stack ?? error.message : String(error);
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
      this[ASSISTANT_THINKING_APPLIED_MODE_KEY] = compactThinking;

      if (blocks.length === 0 || compactThinking === "normal") {
        this[ASSISTANT_THINKING_STATE_KEY] = undefined;
        return originalUpdateContent.call(this, message);
      }

      this[ASSISTANT_THINKING_STATE_KEY] =
        compactThinking === "compact"
          ? createThinkingState(message, blocks, this[ASSISTANT_THINKING_STATE_KEY], getThinkingTiming(message))
          : undefined;

      try {
        return originalUpdateContent.call(this, cloneWithoutThinking(message));
      } finally {
        this.lastMessage = message;
      }
    };

    proto.render = function piCompactAssistantRender(this: any, width: number) {
      if (this[ASSISTANT_THINKING_APPLIED_MODE_KEY] !== compactThinking && this.lastMessage) {
        this.updateContent(this.lastMessage);
      }

      const lines = originalRender.call(this, width);
      const thinkingState = this[ASSISTANT_THINKING_STATE_KEY] as CompactThinkingState | undefined;
      if (compactThinking !== "compact" || !thinkingState) return lines;

      const thinkingLines = renderCompactThinkingLine(thinkingState, width);
      return thinkingLines.length > 0 ? [...thinkingLines, ...lines] : lines;
    };

    proto.__piCompactThinkingPatched = true;
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
    return toolsOk && usersOk && assistantOk;
  })();

  return patchPromise;
}

function patchErrorDetails(): string {
  const errors = [];
  if (lastToolPatchError) errors.push(`tools: ${lastToolPatchError}`);
  if (lastUserPatchError) errors.push(`user-inputs: ${lastUserPatchError}`);
  if (lastAssistantPatchError) errors.push(`thinking: ${lastAssistantPatchError}`);
  if (lastConfigError) errors.push(`config: ${lastConfigError}`);
  return errors.length > 0 ? `\n${errors.join("\n")}` : "";
}

function statusMessage(): string {
  const toolsStatus = lastToolPatchError ? "failed" : compactTools ? "compact" : "normal";
  const userStatus = lastUserPatchError ? "failed" : compactUserInputs ? "compact" : "normal";
  const thinkingStatus = lastAssistantPatchError ? "failed" : compactThinking;
  return `pi-compact: tools=${toolsStatus} • user=${userStatus} • thinking=${thinkingStatus}${patchErrorDetails()}`;
}

function hasStatusError(): boolean {
  return Boolean(lastToolPatchError || lastUserPatchError || lastAssistantPatchError || lastConfigError);
}

function parseCompactArg(args: string, current: boolean): boolean | undefined {
  const value = args.trim().toLowerCase();
  if (!value || value === "status") return current;
  if (["1", "on", "true", "yes", "y", "enable", "enabled", "compact"].includes(value)) return true;
  if (["0", "off", "false", "no", "n", "disable", "disabled", "normal"].includes(value)) return false;
  if (["toggle", "flip"].includes(value)) return !current;
  return undefined;
}

function parseThinkingArg(args: string, current: CompactThinkingMode): CompactThinkingMode | undefined {
  const value = args.trim().toLowerCase();
  if (!value || value === "status") return current;
  if (["toggle", "flip"].includes(value)) return current === "compact" ? "normal" : "compact";
  return parseThinkingMode(value);
}

void patchPiCompactComponents();

export default function (pi: ExtensionAPI) {
  pi.registerFlag(COMPACT_USER_INPUTS_FLAG, {
    description: "Render user inputs as single compact lines",
    type: "boolean",
  });

  pi.on("message_update", (event) => {
    recordAssistantThinkingTiming(event.message, event.assistantMessageEvent);
  });

  pi.on("message_end", (event) => {
    recordAssistantThinkingTiming(event.message, undefined, true);
  });

  pi.registerCommand("compact-status", {
    description: "Show pi-compact patch status",
    handler: async (_args, ctx) => {
      await patchPiCompactComponents();
      ctx.ui.notify(statusMessage(), hasStatusError() ? "error" : "info");
    },
  });

  pi.registerCommand("compact-user-inputs", {
    description: "Show/toggle one-line user input rendering (on|off|toggle)",
    handler: async (args, ctx) => {
      const next = parseCompactArg(args, compactUserInputs);
      if (next === undefined) {
        ctx.ui.notify("Usage: /compact-user-inputs [on|off|toggle|status]", "error");
        return;
      }

      compactUserInputs = next;
      await patchPiCompactComponents();
      ctx.ui.notify(statusMessage(), hasStatusError() ? "error" : "info");
    },
  });

  pi.registerCommand("compact-tools", {
    description: "Show/toggle one-line tool rendering (on|off|toggle)",
    handler: async (args, ctx) => {
      const next = parseCompactArg(args, compactTools);
      if (next === undefined) {
        ctx.ui.notify("Usage: /compact-tools [on|off|toggle|status]", "error");
        return;
      }

      compactTools = next;
      await patchPiCompactComponents();
      ctx.ui.notify(statusMessage(), hasStatusError() ? "error" : "info");
    },
  });

  pi.registerCommand("compact-thinking", {
    description: "Show/toggle thinking rendering (compact|hidden|normal|toggle)",
    handler: async (args, ctx) => {
      const next = parseThinkingArg(args, compactThinking);
      if (next === undefined) {
        ctx.ui.notify("Usage: /compact-thinking [compact|hidden|normal|toggle|status]", "error");
        return;
      }

      compactThinking = next;
      await patchPiCompactComponents();
      ctx.ui.notify(statusMessage(), hasStatusError() ? "error" : "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const settings = resolvePiCompactSettings(ctx.cwd, pi);
    compactTools = settings.tools;
    compactUserInputs = settings.user;
    compactThinking = settings.thinking;
    activeTheme = ctx.hasUI ? ctx.ui.theme : undefined;

    await patchPiCompactComponents();
    if (!ctx.hasUI) return;
    if (hasStatusError()) ctx.ui.notify(statusMessage(), "error");
  });
}
