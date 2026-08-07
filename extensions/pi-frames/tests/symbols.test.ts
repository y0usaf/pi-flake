import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentPreset, resolveSymbols, symbol, SYMBOL_PRESETS } from "../../shared/symbols";

const env = (extra: Record<string, string | undefined> = {}) => ({ ...extra });

describe("pi-frames symbol presets", () => {
  test("unicode preset is the default and carries the unicode glyphs", () => {
    expect(currentPreset(env())).toBe("unicode");
    const m = resolveSymbols(env());
    expect(m["status.success"]).toBe("✓");
    expect(m["tree.branch"]).toBe("├─");
    expect(m["box.tl"]).toBe("┌");
    expect(m["sep.dot"]).toBe(" · ");
  });

  test("ascii preset via PI_SYMBOLS=ascii maps to plain-ASCII glyphs", () => {
    expect(currentPreset(env({ PI_SYMBOLS: "ascii" }))).toBe("ascii");
    const m = resolveSymbols(env({ PI_SYMBOLS: "ascii" }));
    expect(m["status.success"]).toBe("[ok]");
    expect(m["tree.branch"]).toBe("|--");
    expect(m["box.tl"]).toBe("+");
    expect(m["footer.ok"]).toBe("ok");
  });

  test("PI_SYMBOL_OVERRIDES merges per-key overrides over the preset", () => {
    const m = resolveSymbols(env({ PI_SYMBOL_OVERRIDES: JSON.stringify({ "status.success": "OK" }) }));
    expect(m["status.success"]).toBe("OK");
    // unaffected keys keep the preset value
    expect(m["box.tl"]).toBe("┌");
  });

  test("override survives in ascii preset too", () => {
    const m = resolveSymbols(env({ PI_SYMBOLS: "ascii", PI_SYMBOL_OVERRIDES: JSON.stringify({ "footer.err": "FAIL" }) }));
    expect(m["footer.err"]).toBe("FAIL");
    expect(m["tree.last"]).toBe("'--");
  });

  test("invalid override JSON falls back to the preset", () => {
    const m = resolveSymbols(env({ PI_SYMBOL_OVERRIDES: "{not json" }));
    expect(m["status.success"]).toBe("✓");
  });

  test("symbol helper reads a key (empty when missing)", () => {
    const m = resolveSymbols(env());
    expect(symbol(m, "clip.ellipsis")).toBe("…");
    expect(symbol(m, "nope.missing")).toBe("");
  });

  test("SYMBOL_PRESETS exposes both preset tables", () => {
    expect(SYMBOL_PRESETS.unicode["box.h"]).toBe("─");
    expect(SYMBOL_PRESETS.ascii["box.h"]).toBe("-");
  });
});

describe("settings.json symbol source", () => {
  // settings.json is read once at module load, and bun runs every test file in
  // one shared process/module registry, so a fresh module instance is loaded in
  // a subprocess with a temp PI_CODING_AGENT_DIR pointing at a temp settings.json.
  const symbolsEntry = new URL("../../shared/symbols.ts", import.meta.url).pathname;
  const runFresh = (dir: string, env: Record<string, string> = {}) => {
    const envLines = Object.entries(env)
      .map(([k, v]) => `process.env[${JSON.stringify(k)}] = ${JSON.stringify(v)};`)
      .join(" ");
    const script = [
      `process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(dir)};`,
      envLines,
      `const { resolveSymbols } = await import(${JSON.stringify(symbolsEntry)});`,
      `console.log(JSON.stringify(resolveSymbols()));`,
    ].join(" ");
    const res = Bun.spawnSync(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    expect(res.exitCode).toBe(0);
    return JSON.parse(res.stdout.toString()) as Record<string, string>;
  };

  test("ascii preset + override are picked up from settings.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-symbols-settings-"));
    try {
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({
          symbols: {
            preset: "ascii",
            overrides: { "status.success": "PASS", "status.error": "OOPS" },
          },
        }),
      );
      const m = runFresh(dir);
      expect(m["box.tl"]).toBe("+");
      expect(m["tree.branch"]).toBe("|--");
      expect(m["status.success"]).toBe("PASS");
      expect(m["status.error"]).toBe("OOPS");
      expect(m["footer.ok"]).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("env preset and PI_SYMBOL_OVERRIDES win over settings.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-symbols-settings-"));
    try {
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({
          symbols: {
            preset: "ascii",
            overrides: { "status.success": "PASS" },
          },
        }),
      );
      // env preset unicode beats settings ascii (box.tl un-overridden); env
      // override beats the settings override for the same key.
      const m = runFresh(dir, {
        PI_SYMBOLS: "unicode",
        PI_SYMBOL_OVERRIDES: JSON.stringify({ "status.success": "ENVWINS" }),
      });
      expect(m["box.tl"]).toBe("┌");
      expect(m["status.success"]).toBe("ENVWINS");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing settings.json falls back to the unicode default", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-symbols-settings-"));
    try {
      const m = runFresh(dir);
      expect(m["box.tl"]).toBe("┌");
      expect(m["status.success"]).toBe("✓");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
