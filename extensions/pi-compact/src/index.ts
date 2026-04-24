import { SettingsManager, ToolExecutionComponent, UserMessageComponent, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { homedir } from "node:os";

const MAX_SUMMARY_LENGTH = 120;
const MAX_RESULT_LENGTH = 72;
const MAX_USER_INPUT_LENGTH = 512;

const COMPACT_USER_INPUTS_FLAG = "compact-user-inputs";
const COMPACT_USER_INPUTS_ENV = "PI_COMPACT_USER_INPUTS";

const DEFAULT_COMPACT_TOOLS = true;
const DEFAULT_COMPACT_USER_INPUTS = false;

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

let patchPromise: Promise<boolean> | undefined;
let lastToolPatchError: string | undefined;
let lastUserPatchError: string | undefined;
let lastConfigError: string | undefined;
let compactTools = DEFAULT_COMPACT_TOOLS;
let compactUserInputs = envBool(COMPACT_USER_INPUTS_ENV) ?? DEFAULT_COMPACT_USER_INPUTS;
let toolColourBgFn: ((text: string) => string) | undefined;
let userColourBgFn: ((text: string) => string) | undefined;

const TOOL_ORIGINAL_RENDER_KEY = "__piCompactOriginalToolRender";
const USER_ORIGINAL_RENDER_KEY = "__piCompactOriginalUserRender";
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
  tool_colour?: string;
  user_colour?: string;
}

type ResolvedPiCompactSettings = Required<Pick<PiCompactSettings, "user" | "tools">> & Pick<PiCompactSettings, "tool_colour" | "user_colour">;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function extractPiCompactSettings(settings: Record<string, unknown>): PiCompactSettings {
  const block = objectValue(settings["pi-compact"]);
  if (!block) return {};

  const result: PiCompactSettings = {};
  if (typeof block.user === "boolean") result.user = block.user;
  if (typeof block.tools === "boolean") result.tools = block.tools;
  if (typeof block.tool_colour === "string") result.tool_colour = block.tool_colour;
  if (typeof block.user_colour === "string") result.user_colour = block.user_colour;
  return result;
}

function readPiCompactSettings(cwd: string): PiCompactSettings {
  try {
    const settings = SettingsManager.create(cwd);
    const globalSettings = extractPiCompactSettings(settings.getGlobalSettings() as unknown as Record<string, unknown>);
    const projectSettings = extractPiCompactSettings(settings.getProjectSettings() as unknown as Record<string, unknown>);
    lastConfigError = undefined;
    return { ...globalSettings, ...projectSettings };
  } catch (error) {
    lastConfigError = error instanceof Error ? error.stack ?? error.message : String(error);
    return {};
  }
}

function resolvePiCompactSettings(cwd: string, pi: ExtensionAPI): ResolvedPiCompactSettings {
  const settings = readPiCompactSettings(cwd);
  const envUser = envBool(COMPACT_USER_INPUTS_ENV);

  return {
    tools: settings.tools ?? DEFAULT_COMPACT_TOOLS,
    user: pi.getFlag(COMPACT_USER_INPUTS_FLAG) === true ? true : envUser ?? settings.user ?? DEFAULT_COMPACT_USER_INPUTS,
    tool_colour: settings.tool_colour,
    user_colour: settings.user_colour,
  };
}

function createHexBgFn(value: string | undefined): ((text: string) => string) | undefined {
  if (!value) return undefined;

  const normalized = value.trim().replace(/^#/, "");
  const hex = /^[0-9a-f]{3}$/i.test(normalized)
    ? normalized
        .split("")
        .map((char) => char + char)
        .join("")
    : /^[0-9a-f]{6}$/i.test(normalized)
      ? normalized
      : undefined;

  if (!hex) return undefined;

  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  if (![r, g, b].every(Number.isFinite)) return undefined;

  return (text: string) => `\x1b[48;2;${r};${g};${b}m${text}\x1b[0m`;
}

function squash(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
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

function buildToolLine(state: any): string {
  const prefix = state?.isPartial ? "… " : state?.result?.isError ? "✗ " : "✓ ";
  const summary = clip(summarizeArgs(state?.toolName ?? "tool", state?.args), MAX_SUMMARY_LENGTH);
  const suffix = summarizeResult(state?.toolName ?? "tool", state?.result);
  return `${prefix}${state?.toolName ?? "tool"} ${summary || "…"}${suffix}`;
}

function getToolBgFn(state: any): ((text: string) => string) | undefined {
  const bgFn = state?.contentText?.customBgFn ?? state?.contentBox?.bgFn;
  return toolColourBgFn ?? (typeof bgFn === "function" ? bgFn : ((text: string) => `\x1b[42m${text}\x1b[0m`));
}

function renderOneLine(rawLine: string, width: number, bgFn?: (text: string) => string): string[] {
  if (!Number.isFinite(width) || width <= 0) return [];

  const line = truncateToWidth(stripAnsi(rawLine), Math.max(1, width), "…");
  const padded = `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
  return [bgFn ? bgFn(padded) : padded];
}

function renderCompactToolLine(state: any, width: number): string[] {
  return renderOneLine(buildToolLine(state), width, getToolBgFn(state));
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
  return userColourBgFn ?? (typeof bgFn === "function" ? bgFn : undefined);
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

async function patchPiCompactComponents(): Promise<boolean> {
  if (patchPromise) return patchPromise;

  patchPromise = (async () => {
    const toolsOk = patchToolExecutionComponent();
    const usersOk = patchUserMessageComponent();
    return toolsOk && usersOk;
  })();

  return patchPromise;
}

function patchErrorDetails(): string {
  const errors = [];
  if (lastToolPatchError) errors.push(`tools: ${lastToolPatchError}`);
  if (lastUserPatchError) errors.push(`user-inputs: ${lastUserPatchError}`);
  if (lastConfigError) errors.push(`config: ${lastConfigError}`);
  return errors.length > 0 ? `\n${errors.join("\n")}` : "";
}

function statusMessage(): string {
  const toolsStatus = lastToolPatchError ? "failed" : compactTools ? "compact" : "normal";
  const userStatus = lastUserPatchError ? "failed" : compactUserInputs ? "compact" : "normal";
  return `pi-compact: tools=${toolsStatus} • user=${userStatus}${patchErrorDetails()}`;
}

function hasStatusError(): boolean {
  return Boolean(lastToolPatchError || lastUserPatchError || lastConfigError);
}

function parseCompactArg(args: string, current: boolean): boolean | undefined {
  const value = args.trim().toLowerCase();
  if (!value || value === "status") return current;
  if (["1", "on", "true", "yes", "y", "enable", "enabled", "compact"].includes(value)) return true;
  if (["0", "off", "false", "no", "n", "disable", "disabled", "normal"].includes(value)) return false;
  if (["toggle", "flip"].includes(value)) return !current;
  return undefined;
}

void patchPiCompactComponents();

export default function (pi: ExtensionAPI) {
  pi.registerFlag(COMPACT_USER_INPUTS_FLAG, {
    description: "Render user inputs as single compact lines",
    type: "boolean",
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

  pi.on("session_start", async (_event, ctx) => {
    const settings = resolvePiCompactSettings(ctx.cwd, pi);
    compactTools = settings.tools;
    compactUserInputs = settings.user;
    toolColourBgFn = createHexBgFn(settings.tool_colour);
    userColourBgFn = createHexBgFn(settings.user_colour);

    await patchPiCompactComponents();
    if (!ctx.hasUI) return;
    if (hasStatusError()) ctx.ui.notify(statusMessage(), "error");
  });
}
