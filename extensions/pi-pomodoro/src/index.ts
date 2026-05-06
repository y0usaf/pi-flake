import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, watchFile, unwatchFile } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const KEY = "pi-pomodoro";
const VERSION = 1;
const TICK_MS = 1000;
const ICON = "🍅";
const BAR_WIDTH = Array.from(` ${ICON}  break 00:00 `).length;
const RESET = "\x1b[0m";
const TEXT = "\x1b[38;2;18;18;20m";
const COLORS = {
  workBg: "\x1b[48;2;105;220;140m",
  workDim: "\x1b[48;2;49;78;62m",
  breakBg: "\x1b[48;2;255;92;92m",
  breakDim: "\x1b[48;2;80;20;24m",
};

type Phase = "work" | "break";
type State = {
  version: number;
  running: boolean;
  paused: boolean;
  phase: Phase;
  cycle: number;
  startedAt: number;
  endsAt: number;
  updatedAt: number;
  remainingMs?: number;
  totalMs?: number;
  source?: string;
};
type Settings = {
  workMinutes: number;
  breakMinutes: number;
  longBreakMinutes: number;
  longBreakEvery: number;
  syncFile: string;
  notifyTransitions: boolean;
};

type RawSettings = Partial<Record<keyof Settings, unknown>>;

const now = () => Date.now();

let settings = defaults();
let state = idle();
let ctxRef: ExtensionContext | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let watchedFile: string | undefined;
let lastPhase = "";
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const agentDir = () => join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".pi", "agent");

function defaults(): Settings {
  const uid = typeof process.getuid === "function" ? process.getuid() : process.env.USER ?? "user";
  return {
    workMinutes: 25,
    breakMinutes: 5,
    longBreakMinutes: 15,
    longBreakEvery: 4,
    syncFile: join(process.env.XDG_RUNTIME_DIR || tmpdir(), `pi-pomodoro-${uid}.json`),
    notifyTransitions: true,
  };
}

function idle(): State {
  const time = now();
  return { version: VERSION, running: false, paused: false, phase: "work", cycle: 0, startedAt: time, endsAt: time, updatedAt: time };
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function minutes(value: unknown, fallback: number, integer = false): number {
  const n = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  return integer ? Math.max(1, Math.trunc(n)) : n;
}

function extensionSettings(path: string): RawSettings | undefined {
  const raw = readJson(path)?.extensionSettings;
  const ours = isRecord(raw) ? raw[KEY] : undefined;
  return isRecord(ours) ? (ours as RawSettings) : undefined;
}

function applySettings(raw: RawSettings | undefined, base: Settings): Settings {
  if (!raw) return base;
  return {
    workMinutes: minutes(raw.workMinutes, base.workMinutes),
    breakMinutes: minutes(raw.breakMinutes, base.breakMinutes),
    longBreakMinutes: minutes(raw.longBreakMinutes, base.longBreakMinutes),
    longBreakEvery: minutes(raw.longBreakEvery, base.longBreakEvery, true),
    syncFile: typeof raw.syncFile === "string" && raw.syncFile.trim() ? raw.syncFile.trim() : base.syncFile,
    notifyTransitions: typeof raw.notifyTransitions === "boolean" ? raw.notifyTransitions : base.notifyTransitions,
  };
}

function loadSettings(cwd: string): Settings {
  return [join(agentDir(), "settings.json"), join(cwd, ".pi", "settings.json")].reduce(
    (current, path) => applySettings(extensionSettings(path), current),
    defaults(),
  );
}

function parseState(raw: unknown): State | undefined {
  if (!isRecord(raw) || typeof raw.running !== "boolean" || typeof raw.paused !== "boolean") return undefined;
  if (raw.phase !== "work" && raw.phase !== "break") return undefined;
  const finite = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
  return {
    version: VERSION,
    running: raw.running,
    paused: raw.paused,
    phase: raw.phase,
    cycle: Math.max(0, Math.trunc(finite(raw.cycle, 0))),
    startedAt: finite(raw.startedAt, now()),
    endsAt: finite(raw.endsAt, finite(raw.startedAt, now())),
    updatedAt: finite(raw.updatedAt, now()),
    remainingMs: raw.remainingMs === undefined ? undefined : Math.max(0, finite(raw.remainingMs, 0)),
    totalMs: raw.totalMs === undefined ? undefined : Math.max(1, finite(raw.totalMs, 1)),
    source: typeof raw.source === "string" ? raw.source : undefined,
  };
}

function readState(): State {
  return parseState(readJson(settings.syncFile)) ?? idle();
}

function writeState(next: State): void {
  mkdirSync(dirname(settings.syncFile), { recursive: true });
  state = { ...next, version: VERSION, updatedAt: now() };
  const tmp = `${settings.syncFile}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tmp, settings.syncFile);
}

function duration(phase: Phase, cycle = state.cycle): number {
  if (phase === "work") return settings.workMinutes * 60_000;
  return (cycle > 0 && cycle % settings.longBreakEvery === 0 ? settings.longBreakMinutes : settings.breakMinutes) * 60_000;
}

function start(phase: Phase, cycle: number, source: string, customMinutes?: number): State {
  const time = now();
  const ms = (customMinutes ?? duration(phase, cycle) / 60_000) * 60_000;
  return { version: VERSION, running: true, paused: false, phase, cycle, startedAt: time, endsAt: time + ms, updatedAt: time, totalMs: ms, source };
}

function remaining(): number {
  if (!state.running) return 0;
  return state.paused ? state.remainingMs ?? Math.max(0, state.endsAt - now()) : Math.max(0, state.endsAt - now());
}

function advance(): void {
  if (!state.running || state.paused || now() < state.endsAt) return;
  const nextPhase: Phase = state.phase === "work" ? "break" : "work";
  writeState(start(nextPhase, nextPhase === "break" ? state.cycle + 1 : state.cycle, `auto:${process.pid}`));
}

function format(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function progress(width: number): number {
  if (!state.running) return 0;
  const total = Math.max(1, state.totalMs ?? state.endsAt - state.startedAt);
  const left = remaining();
  const elapsed = Math.max(0, total - left);
  return Math.max(0, Math.min(width, Math.round((elapsed / total) * width)));
}

function colour(phase: Phase, kind: "bg" | "dim"): string {
  return COLORS[`${phase}${kind === "bg" ? "Bg" : "Dim"}` as keyof typeof COLORS];
}

function bar(label: string, phase: Phase, width = BAR_WIDTH): string {
  const chars = Array.from(` ${label} `);
  const size = Math.max(width, chars.length);
  const filled = progress(size);
  const start = Math.max(0, Math.floor((size - chars.length) / 2));
  return Array.from({ length: size }, (_, i) => {
    const ch = i >= start && i < start + chars.length ? chars[i - start] : " ";
    return `${colour(phase, i < filled ? "bg" : "dim")}${TEXT}${ch}`;
  }).join("") + RESET;
}

function render(ctx: ExtensionContext): void {
  advance();
  const phase = state.running ? state.phase : "work";
  const label = state.running ? `${ICON}  ${phase}${state.paused ? " paused" : ""} ${format(remaining())}` : `${ICON}  idle`;
  ctx.ui.setStatus(KEY, bar(label, phase));

  const phaseKey = state.running && !state.paused ? `${state.phase}:${state.cycle}` : "idle";
  if (settings.notifyTransitions && lastPhase && phaseKey !== lastPhase && phaseKey !== "idle") {
    ctx.ui.notify(state.phase === "break" ? `${ICON} break time` : `${ICON} work time`, "info");
  }
  lastPhase = phaseKey;
}

function refresh(): void {
  const next = readState();
  if (next.updatedAt >= state.updatedAt || next.source === state.source) state = next;
  if (ctxRef) render(ctxRef);
}

function watchSyncFile(): void {
  if (watchedFile) unwatchFile(watchedFile);
  watchedFile = settings.syncFile;
  watchFile(watchedFile, { interval: 1000 }, refresh);
}

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => ctxRef && render(ctxRef), TICK_MS);
  (timer as { unref?: () => void }).unref?.();
}

const source = () => `command:${process.pid}`;
const parseMinutes = (arg?: string) => {
  const n = Number(arg?.trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const status = () => (state.running ? `${ICON}  ${state.phase}${state.paused ? " paused" : ""} ${format(remaining())} · cycle ${state.cycle}` : `${ICON}  pomodoro idle`);

export default function pomodoro(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctxRef = ctx;
    settings = loadSettings(ctx.cwd);
    state = readState();
    watchSyncFile();
    ensureTimer();
    render(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (watchedFile) unwatchFile(watchedFile);
    if (timer) clearInterval(timer);
    watchedFile = undefined;
    timer = undefined;
    ctx.ui.setStatus(KEY, undefined);
    ctxRef = undefined;
  });

  pi.registerCommand("pomodoro", {
    description: "Synced non-blocking pomodoro timer: start|stop|pause|resume|status|work|break [minutes]",
    handler: async (args, ctx) => {
      ctxRef = ctx;
      settings = loadSettings(ctx.cwd);
      watchSyncFile();
      refresh();

      const [rawAction, rawMinutes] = args.trim().split(/\s+/, 2);
      const action = (rawAction || "start").toLowerCase();
      const customMinutes = parseMinutes(rawMinutes);

      if (action === "start" || action === "work") writeState(start("work", state.cycle, source(), customMinutes));
      else if (action === "break") writeState(start("break", state.phase === "work" ? state.cycle + 1 : state.cycle, source(), customMinutes));
      else if (action === "pause" && state.running && !state.paused) writeState({ ...state, paused: true, remainingMs: remaining(), totalMs: state.totalMs ?? Math.max(1, state.endsAt - state.startedAt), source: source() });
      else if (action === "resume" && state.running && state.paused) {
        const time = now();
        const left = remaining();
        const total = Math.max(1, state.totalMs ?? state.endsAt - state.startedAt);
        writeState({ ...state, paused: false, startedAt: time - (total - left), endsAt: time + left, remainingMs: undefined, totalMs: total, source: source() });
      } else if (action === "stop" || action === "reset") writeState({ ...idle(), source: source() });
      else if (action !== "status") {
        ctx.ui.notify("Usage: /pomodoro [start|stop|pause|resume|status|work|break|reset] [minutes]", "warning");
        return;
      }

      render(ctx);
      ctx.ui.notify(status(), "info");
    },
  });
}
