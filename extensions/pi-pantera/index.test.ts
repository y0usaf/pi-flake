import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import panteraTheme from "./index.ts";

const tempDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalPantera = process.env.PI_PANTERA;

afterEach(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalPantera === undefined) delete process.env.PI_PANTERA;
  else process.env.PI_PANTERA = originalPantera;
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "pi-pantera-test-"));
  tempDirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;

  const calls: string[] = [];
  let handler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const pi = {
    on(event: string, registered: typeof handler) {
      expect(event).toBe("session_start");
      handler = registered;
    },
  };
  panteraTheme(pi as any);
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      setTheme: (name: string) => {
        calls.push(name);
        return { success: true };
      },
    },
  };
  return { dir, calls, ctx, run: () => handler!( {}, ctx) };
}

async function markerExists(dir: string): Promise<boolean> {
  try {
    await readFile(join(dir, "pantera-default-applied"));
    return true;
  } catch {
    return false;
  }
}

describe("pantera default theme", () => {
  test("applies without settings and creates the marker", async () => {
    const { dir, calls, run } = await setup();
    await run();
    expect(calls).toEqual(["pantera"]);
    expect(await markerExists(dir)).toBe(true);
  });

  test("does not apply when the marker already exists", async () => {
    const { dir, calls, run } = await setup();
    await writeFile(join(dir, "pantera-default-applied"), "");
    await run();
    expect(calls).toEqual([]);
  });

  test("does not apply a chosen theme", async () => {
    const { dir, calls, run } = await setup();
    await writeFile(join(dir, "settings.json"), JSON.stringify({ theme: "gruvbox" }));
    await run();
    expect(calls).toEqual([]);
    expect(await markerExists(dir)).toBe(false);
  });

  test("applies when the detected theme is dark", async () => {
    const { calls, run } = await setup();
    await writeFile(join(process.env.PI_CODING_AGENT_DIR!, "settings.json"), JSON.stringify({ theme: "dark" }));
    await run();
    expect(calls).toEqual(["pantera"]);
  });

  test("does not create a marker when applying the theme fails", async () => {
    const { dir, calls, ctx, run } = await setup();
    ctx.ui.setTheme = (name: string) => {
      calls.push(name);
      return { success: false };
    };
    await run();
    expect(calls).toEqual(["pantera"]);
    expect(await markerExists(dir)).toBe(false);
  });

  test("re-applies for read-only detected settings", async () => {
    const { dir, calls, run } = await setup();
    const settingsPath = join(dir, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ theme: "dark" }));
    await chmod(settingsPath, 0o444);
    await run();
    await run();
    expect(calls).toEqual(["pantera", "pantera"]);
    expect(await markerExists(dir)).toBe(false);
  });

  test("does not apply a pinned theme in read-only settings", async () => {
    const { dir, calls, run } = await setup();
    const settingsPath = join(dir, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ theme: "gruvbox" }));
    await chmod(settingsPath, 0o444);
    await run();
    expect(calls).toEqual([]);
  });

  test("does not apply when disabled by PI_PANTERA", async () => {
    const { dir, calls, run } = await setup();
    process.env.PI_PANTERA = "0";
    await run();
    expect(calls).toEqual([]);
    expect(await markerExists(dir)).toBe(false);
  });
});
