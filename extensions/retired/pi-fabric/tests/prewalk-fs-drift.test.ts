import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrewalkDriftTracker } from "../src/prewalk/fs-drift.js";

const HAS_GIT = (() => {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

const tempRoots: string[] = [];

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prewalk-drift-"));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("PrewalkDriftTracker", () => {
  it("detects added, modified, and deleted files between baselines", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "a.txt"), "alpha");
    const tracker = new PrewalkDriftTracker();
    await tracker.captureBaseline("session-1", root);

    await writeFile(path.join(root, "a.txt"), "alpha-plus");
    await writeFile(path.join(root, "b.txt"), "beta");
    const drift = await tracker.evaluate("session-1", root);

    expect(drift?.added).toBe(1);
    expect(drift?.modified).toBe(1);
    expect(drift?.deleted).toBe(0);
    expect(drift?.files.slice().sort()).toEqual(["a.txt", "b.txt"]);

    await rm(path.join(root, "a.txt"));
    const second = await tracker.evaluate("session-1", root);
    expect(second?.deleted).toBe(1);
    expect(second?.files).toEqual(["a.txt"]);
  });

  it("advances the baseline so the same change never fires twice", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "a.txt"), "alpha");
    const tracker = new PrewalkDriftTracker();
    await tracker.captureBaseline("session-1", root);

    await writeFile(path.join(root, "a.txt"), "alpha-plus");
    expect(await tracker.evaluate("session-1", root)).toMatchObject({ modified: 1 });
    expect(await tracker.evaluate("session-1", root)).toBeUndefined();
  });

  it("claims mtime-only churn once, records the content hash, then filters repeats", async () => {
    const root = await tempRoot();
    const file = path.join(root, "a.txt");
    await writeFile(file, "alpha");
    const tracker = new PrewalkDriftTracker();
    await tracker.captureBaseline("session-1", root);

    // First sighting: the baseline holds no content hash yet, so the churn
    // still claims — and teaches the fresh baseline a.txt's SHA-1.
    let stamp = await stat(file);
    await utimes(file, stamp.atime, new Date(stamp.mtimeMs + 5_000));
    const first = await tracker.evaluate("session-1", root);
    expect(first).toMatchObject({ modified: 1, unchanged: 0, files: ["a.txt"] });

    // Repeat churn with identical content is filtered as mtime-only noise.
    stamp = await stat(file);
    await utimes(file, stamp.atime, new Date(stamp.mtimeMs + 5_000));
    expect(await tracker.evaluate("session-1", root)).toBeUndefined();
    // Content actually changing claims again regardless of the recorded hash.
    await writeFile(file, "alpha-2");
    expect(await tracker.evaluate("session-1", root)).toMatchObject({ modified: 1 });
  });

  it("filters hashed churn while still reporting real content changes", async () => {
    const root = await tempRoot();
    const churned = path.join(root, "a.txt");
    const real = path.join(root, "b.txt");
    await writeFile(churned, "alpha");
    await writeFile(real, "beta");
    const tracker = new PrewalkDriftTracker();
    await tracker.captureBaseline("session-1", root);

    // Real content change claims and records a.txt's hash in the new baseline.
    await writeFile(churned, "alpha-2");
    expect(await tracker.evaluate("session-1", root)).toMatchObject({
      modified: 1,
      files: ["a.txt"],
    });

    // a.txt churns with identical content while b.txt actually changes.
    const stamp = await stat(churned);
    await utimes(churned, stamp.atime, new Date(stamp.mtimeMs + 5_000));
    await writeFile(real, "beta-2");
    const second = await tracker.evaluate("session-1", root);
    expect(second).toMatchObject({ modified: 1, unchanged: 1, files: ["b.txt"] });
  });

  it("baselines silently on first evaluation and claims only later drift", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "a.txt"), "alpha");
    const tracker = new PrewalkDriftTracker();

    expect(await tracker.evaluate("session-new", root)).toBeUndefined();
    await writeFile(path.join(root, "a.txt"), "alpha-plus");
    expect(await tracker.evaluate("session-new", root)).toMatchObject({ modified: 1 });
  });

  it("keeps baselines isolated per session", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "a.txt"), "alpha");
    const tracker = new PrewalkDriftTracker();
    await tracker.captureBaseline("session-1", root);

    await writeFile(path.join(root, "a.txt"), "alpha-plus");
    expect(await tracker.evaluate("session-2", root)).toBeUndefined();
    expect(await tracker.evaluate("session-1", root)).toMatchObject({ modified: 1 });
  });

  it("skips node_modules and .git in git-less walks", async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "dep", "index.js"), "v1");
    await writeFile(path.join(root, "watched.ts"), "one");
    const tracker = new PrewalkDriftTracker();
    await tracker.captureBaseline("session-1", root);

    await writeFile(path.join(root, "node_modules", "dep", "index.js"), "v2-changed");
    expect(await tracker.evaluate("session-1", root)).toBeUndefined();

    await writeFile(path.join(root, "watched.ts"), "one-changed");
    expect(await tracker.evaluate("session-1", root)).toMatchObject({ modified: 1 });
  });

  it.skipIf(!HAS_GIT)(
    "uses the git index so ignored artifacts never register as drift",
    async () => {
      const root = await tempRoot();
      execFileSync("git", ["init", "-q", root]);
      await writeFile(path.join(root, ".gitignore"), "ignored/\n");
      await mkdir(path.join(root, "ignored"));
      await writeFile(path.join(root, "ignored", "artifact.js"), "v1");
      await writeFile(path.join(root, "watched.ts"), "one");
      const tracker = new PrewalkDriftTracker();
      await tracker.captureBaseline("session-1", root);

      await writeFile(path.join(root, "ignored", "artifact.js"), "v2-changed");
      await writeFile(path.join(root, "ignored", "fresh.js"), "new file");
      expect(await tracker.evaluate("session-1", root)).toBeUndefined();

      await writeFile(path.join(root, "watched.ts"), "one-changed");
      const drift = await tracker.evaluate("session-1", root);
      expect(drift?.files).toEqual(["watched.ts"]);
      expect(drift?.modified).toBe(1);
    },
  );

  it("rebaselines without claiming when the tree overflows the file cap", async () => {
    const root = await tempRoot();
    for (let index = 0; index < 4; index += 1) {
      await writeFile(path.join(root, `file-${index}.txt`), String(index));
    }
    const tracker = new PrewalkDriftTracker({ maxTrackedFiles: 3 });
    await tracker.captureBaseline("session-1", root);

    await writeFile(path.join(root, "file-0.txt"), "zero-changed");
    expect(await tracker.evaluate("session-1", root)).toBeUndefined();
  });
});
