// oh-my-pi-style symbol-preset substitution for the frame/status/tree glyphs.
// Unicode is the default; ASCII is opt-in via PI_SYMBOLS=ascii or the
// setting's symbols.preset. Per-key overrides come from PI_SYMBOL_OVERRIDES
// (JSON object of dotted keys) and, below it, settings.json `symbols.overrides`.
// Flattened dotted keys mirror oh-my-pi's theme.token tables (theme.box.*,
// theme.tree.*, theme.status.*).
//
// settings.json lives at $PI_CODING_AGENT_DIR/settings.json (default
// ~/.pi/agent) and is read once at module load; its `symbols` key is an
// optional `{ "preset": "ascii"|"unicode", "overrides": { "<dotted-key>":
// "glyph" } }`. A missing file, missing key, or invalid JSON all ignore that
// source (same console.warn pattern as the other loosely-typed settings reads).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SymbolPreset = "unicode" | "ascii";

export type SymbolMap = Record<string, string>;

export const SYMBOL_PRESETS: Record<SymbolPreset, SymbolMap> = {
  unicode: {
    "box.tl": "┌",
    "box.tr": "┐",
    "box.bl": "└",
    "box.br": "┘",
    "box.h": "─",
    "box.v": "│",
    "box.teeL": "├",
    "box.teeR": "┤",
    "sep.dot": " · ",
    "tree.branch": "├─",
    "tree.last": "└─",
    "tree.cont": "│",
    "status.pending": "…",
    "status.success": "✓",
    "status.error": "✗",
    "footer.ok": "✓",
    "footer.err": "✗",
    "clip.ellipsis": "…",
  },
  ascii: {
    "box.tl": "+",
    "box.tr": "+",
    "box.bl": "+",
    "box.br": "+",
    "box.h": "-",
    "box.v": "|",
    "box.teeL": "+",
    "box.teeR": "+",
    "sep.dot": " - ",
    "tree.branch": "|--",
    "tree.last": "'--",
    "tree.cont": "|",
    "status.pending": "[*]",
    "status.success": "[ok]",
    "status.error": "[!!]",
    "footer.ok": "ok",
    "footer.err": "!!",
    "clip.ellipsis": "...",
  },
};

type Env = Record<string, string | undefined>;

type SettingsSymbols = { preset: SymbolPreset; overrides: SymbolMap };

/** Read settings.json's optional `symbols` block once at module load. Any
 * miss (missing file, missing key, bad JSON, non-string preset/glyph) collapses
 * to a neutral unicode/default source so a broken user config never crashes or
 * silently blanks the renderer. */
function loadSettingsSymbols(): SettingsSymbols {
  const configuredDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = configuredDir?.startsWith("~/")
    ? join(homedir(), configuredDir.slice(2))
    : configuredDir || join(homedir(), ".pi", "agent");
  let settings: { symbols?: { preset?: unknown; overrides?: unknown } } = {};
  try {
    settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  } catch {
    // Missing or unreadable settings.json: not a render failure.
    return { preset: "unicode", overrides: {} };
  }
  const symbols = settings.symbols;
  if (typeof symbols !== "object" || symbols === null || Array.isArray(symbols)) {
    return { preset: "unicode", overrides: {} };
  }
  const preset: SymbolPreset = symbols.preset === "ascii" ? "ascii" : "unicode";
  let overrides: SymbolMap = {};
  if (typeof symbols.overrides === "object" && symbols.overrides !== null && !Array.isArray(symbols.overrides)) {
    for (const [key, value] of Object.entries(symbols.overrides)) {
      if (typeof value === "string") overrides[key] = value;
    }
  }
  return { preset, overrides };
}

// Read once per process: the extensions live for a whole session and the
// setting does not change underneath the renderers.
const SETTINGS = loadSettingsSymbols();

/** Resolved preset: env PI_SYMBOLS wins over the settings preset, which wins
 * over the unicode default. */
export function currentPreset(env: Env = process.env): SymbolPreset {
  if (env.PI_SYMBOLS === "ascii") return "ascii";
  if (env.PI_SYMBOLS === "unicode") return "unicode";
  return SETTINGS.preset;
}

export function resolveSymbols(env: Env = process.env): SymbolMap {
  const merged: SymbolMap = { ...SYMBOL_PRESETS[currentPreset(env)] };
  // settings.json per-key overrides sit under the env preset...
  for (const [key, value] of Object.entries(SETTINGS.overrides)) {
    merged[key] = value;
  }
  // ...and env PI_SYMBOL_OVERRIDES wins over them per key.
  const raw = env.PI_SYMBOL_OVERRIDES;
  if (raw === undefined) return merged;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return merged;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") merged[key] = value;
    }
    return merged;
  } catch {
    // Invalid override JSON is a config error, not a render failure: log and
    // fall back to the preset (settings.json overrides still apply). `spans`
    // logging is not available in this shared module, so warn via console
    // (repo-wide pattern).
    console.warn(`[symbols] invalid PI_SYMBOL_OVERRIDES JSON, ignoring overrides: ${raw}`);
    return merged;
  }
}

export function symbol(m: SymbolMap, key: string): string {
  return m[key] ?? "";
}
