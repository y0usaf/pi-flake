import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, watchFile, unwatchFile } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const EXTENSION_KEY = "pi-pomodoro";
const STATE_VERSION = 1;
const DEFAULT_WORK_MINUTES = 25;
const DEFAULT_BREAK_MINUTES = 5;
const DEFAULT_LONG_BREAK_MINUTES = 15;
const DEFAULT_LONG_BREAK_EVERY = 4;
const TICK_MS = 1000;

const RESET = "\x1b[0m";
const RED = "\x1b[38;2;255;92;92m";
const RED_BG = "\x1b[48;2;80;20;24m";
const GREEN = "\x1b[38;2;105;220;140m";
const DIM = "\x1b[2m";

/**
 * Shared runtime state defaults to XDG_RUNTIME_DIR or the OS tmp dir. Every active
 * pi process running this extension watches the same file, so phase changes
 * propagate without blocking input or requiring a central daemon.
 */
type Phase = "work" | "break";

type PomodoroState = {
  version: number;
  running: boolean;
  paused: boolean;
  phase: Phase;
  cycle: number;
  startedAt: number;
  endsAt: number;
  remainingMs?: number;
  updatedAt: number;
  source?: string;
};

type Settings = {
  workMinutes: number;
  breakMinutes: number;
  longBreakMinutes: number;
  longBreakEvery: number;
  syncFile: string;
  showWidgetDuringWork: boolean;
  notifyTransitions: boolean;
};

type RawSettings = Partial<{
  workMinutes: unknown;
  breakMinutes: unknown;
  longBreakMinutes: unknown;
  longBreakEvery: unknown;
  syncFile: unknown;
  showWidgetDuringWork: unknown;
  notifyTransitions: unknown;
}>;

let settings: Settings = defaultSettings();
let state: PomodoroState = idleState();
let ctxRef: ExtensionContext | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let lastRenderedKey = "";
let lastPhaseKey = "";
let watchedFile: string | undefined;

function agentDir(): string {
  return join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".pi", "agent");
}

function defaultSyncFile(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : process.env.USER ?? "user";
  return join(process.env.XDG_RUNTIME_DIR || tmpdir(), `pi-pomodoro-${uid}.json`);
}

function defaultSettings(): Settings {
  return {
    workMinutes: DEFAULT_WORK_MINUTES,
    breakMinutes: DEFAULT_BREAK_MINUTES,
    longBreakMinutes: DEFAULT_LONG_BREAK_MINUTES,
    longBreakEvery: DEFAULT_LONG_BREAK_EVERY,
    syncFile: defaultSyncFile(),
    showWidgetDuringWork: false,
    notifyTransitions: true,
  };
}

function idleState(): PomodoroState {
  const now = Date.now();
  return {
    version: STATE_VERSION,
    running: false,
    paused: false,
    phase: "work",
    cycle: 0,
    startedAt: now,
    endsAt: now,
    updatedAt: now,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function positiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = positiveNumber(value, fallback);
  return Math.max(1, Math.trunc(number));
}

function parseSettings(raw: RawSettings | undefined, base: Settings): Settings {
  if (!raw || !isRecord(raw)) return base;
  return {
    workMinutes: positiveNumber(raw.workMinutes, base.workMinutes),
    breakMinutes: positiveNumber(raw.breakMinutes, base.breakMinutes),
    longBreakMinutes: positiveNumber(raw.longBreakMinutes, base.longBreakMinutes),
    longBreakEvery: positiveInteger(raw.longBreakEvery, base.longBreakEvery),
    syncFile: typeof raw.syncFile === "string" && raw.syncFile.trim() ? raw.syncFile.trim() : base.syncFile,
    showWidgetDuringWork: typeof raw.showWidgetDuringWork === "boolean" ? raw.showWidgetDuringWork : base.showWidgetDuringWork,
    notifyTransitions: typeof raw.notifyTransitions === "boolean" ? raw.notifyTransitions : base.notifyTransitions,
  };
}

function pickExtensionSettings(root: Record<string, unknown> | undefined): RawSettings | undefined {
  const extensionSettings = root?.extensionSettings;
  if (!isRecord(extensionSettings)) return undefined;
  const raw = extensionSettings[EXTENSION_KEY];
  return isRecord(raw) ? (raw as RawSettings) : undefined;
}

function loadSettings(cwd: string): Settings {
  let loaded = defaultSettings();
  loaded = parseSettings(pickExtensionSettings(readJson(join(agentDir(), "settings.json"))), loaded);
  loaded = parseSettings(pickExtensionSettings(readJson(join(cwd, ".pi", "settings.json"))), loaded);
  return loaded;
}

function isPhase(value: unknown): value is Phase {
  return value === "work" || value === "break";
}

function parseState(raw: unknown): PomodoroState | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.running !== "boolean" || typeof raw.paused !== "boolean" || !isPhase(raw.phase)) return undefined;
  const cycle = typeof raw.cycle === "number" && Number.isFinite(raw.cycle) ? Math.max(0, Math.trunc(raw.cycle)) : 0;
  const startedAt = typeof raw.startedAt === "number" && Number.isFinite(raw.startedAt) ? raw.startedAt : Date.now();
  const endsAt = typeof raw.endsAt === "number" && Number.isFinite(raw.endsAt) ? raw.endsAt : startedAt;
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now();
  const remainingMs = typeof raw.remainingMs === "number" && Number.isFinite(raw.remainingMs) ? Math.max(0, raw.remainingMs) : undefined;
  return {
    version: STATE_VERSION,
    running: raw.running,
    paused: raw.paused,
    phase: raw.phase,
    cycle,
    startedAt,
    endsAt,
    updatedAt,
    remainingMs,
    source: typeof raw.source === "string" ? raw.source : undefined,
  };
}

function readState(): PomodoroState {
  const parsed = parseState(readJson(settings.syncFile));
  return parsed ?? idleState();
}

function writeState(next: PomodoroState): void {
  mkdirSync(dirname(settings.syncFile), { recursive: true });
  const normalized = { ...next, version: STATE_VERSION, updatedAt: Date.now() };
  const tmp = `${settings.syncFile}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  renameSync(tmp, settings.syncFile);
  state = normalized;
}

function durationMs(phase: Phase, cycle: number): number {
  if (phase === "work") return settings.workMinutes * 60_000;
  const longBreak = settings.longBreakEvery > 0 && cycle > 0 && cycle % settings.longBreakEvery === 0;
  return (longBreak ? settings.longBreakMinutes : settings.breakMinutes) * 60_000;
}

function startState(phase: Phase, cycle: number, source: string, minutes?: number): PomodoroState {
  const now = Date.now();
  const duration = (minutes && minutes > 0 ? minutes : phase === "work" ? settings.workMinutes : durationMs("break", cycle) / 60_000) * 60_000;
  return {
    version: STATE_VERSION,
    running: true,
    paused: false,
    phase,
    cycle,
    startedAt: now,
    endsAt: now + duration,
    updatedAt: now,
    source,
  };
}

function transition(nextPhase: Phase, source: string): void {
  const nextCycle = nextPhase === "break" ? state.cycle + 1 : state.cycle;
  writeState(startState(nextPhase, nextCycle, source));
}

function maybeAdvance(): void {
  if (!state.running || state.paused) return;
  if (Date.now() < state.endsAt) return;
  transition(state.phase === "work" ? "break" : "work", `auto:${process.pid}`);
}

function remainingMs(): number {
  if (!state.running) return 0;
  if (state.paused) return state.remainingMs ?? Math.max(0, state.endsAt - Date.now());
  return Math.max(0, state.endsAt - Date.now());
}

function formatMs(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function styled(phase: Phase, text: string): string {
  return phase === "break" ? `${RED}${text}${RESET}` : `${GREEN}${text}${RESET}`;
}

function bar(width: number): string {
  if (!state.running) return "";
  const total = state.paused ? (state.remainingMs ?? durationMs(state.phase, state.cycle)) : state.endsAt - state.startedAt;
  const elapsed = state.paused ? total - (state.remainingMs ?? 0) : Date.now() - state.startedAt;
  const filled = Math.max(0, Math.min(width, Math.round((elapsed / Math.max(1, total)) * width)));
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

function clearUi(ctx: ExtensionContext): void {
  ctx.ui.setStatus(EXTENSION_KEY, "");
  ctx.ui.setWidget(EXTENSION_KEY, []);
  ctx.ui.setTitle("");
}

function render(ctx: ExtensionContext): void {
  maybeAdvance();

  if (!state.running) {
    if (lastRenderedKey !== "idle") {
      ctx.ui.setStatus(EXTENSION_KEY, "🍅 idle");
      ctx.ui.setWidget(EXTENSION_KEY, []);
      ctx.ui.setTitle("");
      lastRenderedKey = "idle";
      lastPhaseKey = "idle";
    }
    return;
  }

  const phaseText = state.phase === "break" ? "BREAK" : "focus";
  const pausedText = state.paused ? " paused" : "";
  const left = formatMs(remainingMs());
  const status = styled(state.phase, `🍅 ${phaseText} ${left}${pausedText}`);
  const renderKey = `${state.phase}:${left}:${state.paused}:${state.cycle}:${state.running}`;
  const phaseKey = `${state.phase}:${state.cycle}:${state.running}`;

  ctx.ui.setStatus(EXTENSION_KEY, status);
  ctx.ui.setTitle(state.phase === "break" ? `🍅 BREAK ${left}` : "");

  if (state.phase === "break" || settings.showWidgetDuringWork) {
    const rawLine = ` 🍅 ${phaseText.toUpperCase()} ${left}${pausedText}  ${bar(18)} `;
    const line = state.phase === "break" ? `${RED_BG}${RED}${rawLine}${RESET}` : styled(state.phase, rawLine);
    const hint = state.phase === "break"
      ? `${RED}break time — input remains active; /pomodoro work to skip${RESET}`
      : `${DIM}/pomodoro pause|stop|break${RESET}`;
    ctx.ui.setWidget(EXTENSION_KEY, [line, hint]);
  } else {
    ctx.ui.setWidget(EXTENSION_KEY, []);
  }

  if (settings.notifyTransitions && phaseKey !== lastPhaseKey && lastPhaseKey !== "" && state.running && !state.paused) {
    ctx.ui.notify(state.phase === "break" ? "🍅 Pomodoro: break time" : "🍅 Pomodoro: focus time", "info");
  }

  lastRenderedKey = renderKey;
  lastPhaseKey = phaseKey;
}

function refreshFromDisk(): void {
  const next = readState();
  if (next.updatedAt < state.updatedAt && next.source !== state.source) return;
  state = next;
  if (ctxRef) render(ctxRef);
}

function restartWatcher(): void {
  if (watchedFile) unwatchFile(watchedFile);
  watchedFile = settings.syncFile;
  watchFile(settings.syncFile, { interval: 1000 }, () => refreshFromDisk());
}

function ensureTimer(): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    if (ctxRef) render(ctxRef);
  }, TICK_MS);
  if (typeof tickTimer === "object" && "unref" in tickTimer && typeof tickTimer.unref === "function") tickTimer.unref();
}

function parseMinutes(arg: string | undefined): number | undefined {
  if (!arg) return undefined;
  const value = Number(arg.trim());
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function commandStatus(): string {
  if (!state.running) return "🍅 pomodoro idle";
  return `🍅 ${state.phase}${state.paused ? " paused" : ""} ${formatMs(remainingMs())} · cycle ${state.cycle}`;
}

export default function pomodoro(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctxRef = ctx;
    settings = loadSettings(ctx.cwd);
    state = readState();
    restartWatcher();
    ensureTimer();
    render(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (watchedFile) unwatchFile(watchedFile);
    watchedFile = undefined;
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = undefined;
    clearUi(ctx);
    ctxRef = undefined;
  });

  pi.registerCommand("pomodoro", {
    description: "Synced non-blocking pomodoro timer: start|stop|pause|resume|status|work|break [minutes]",
    handler: async (args, ctx) => {
      ctxRef = ctx;
      settings = loadSettings(ctx.cwd);
      restartWatcher();
      refreshFromDisk();

      const [rawAction, rawMinutes] = args.trim().split(/\s+/, 2);
      const action = (rawAction || "start").toLowerCase();
      const minutes = parseMinutes(rawMinutes);

      if (action === "start" || action === "work") {
        writeState(startState("work", state.cycle, `command:${process.pid}`, minutes));
      } else if (action === "break") {
        const cycle = state.phase === "work" ? state.cycle + 1 : state.cycle;
        writeState(startState("break", cycle, `command:${process.pid}`, minutes));
      } else if (action === "pause") {
        if (state.running && !state.paused) writeState({ ...state, paused: true, remainingMs: remainingMs(), source: `command:${process.pid}` });
      } else if (action === "resume") {
        if (state.running && state.paused) {
          const now = Date.now();
          writeState({ ...state, paused: false, startedAt: now, endsAt: now + remainingMs(), remainingMs: undefined, source: `command:${process.pid}` });
        }
      } else if (action === "stop" || action === "reset") {
        writeState({ ...idleState(), source: `command:${process.pid}` });
      } else if (action === "status") {
        ctx.ui.notify(commandStatus(), "info");
        render(ctx);
        return;
      } else {
        ctx.ui.notify("Usage: /pomodoro [start|stop|pause|resume|status|work|break|reset] [minutes]", "warning");
        return;
      }

      render(ctx);
      ctx.ui.notify(commandStatus(), "info");
    },
  });
}
