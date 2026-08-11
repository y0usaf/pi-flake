import { describe, expect, test } from "bun:test";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMutationTargetPath, writeTextFileAtomically } from "../src/fs-write";
import { getFileSnapshot } from "../src/snapshot";

describe("resolveMutationTargetPath", () => {
  test("resolves file and directory symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hashline-fs-"));
    const target = join(dir, "target.txt");
    await writeFile(target, "a", "utf8");
    const fileLink = join(dir, "file-link.txt");
    await symlink(target, fileLink);
    expect(await resolveMutationTargetPath(fileLink)).toBe(target);

    const realDir = join(dir, "real");
    await mkdir(realDir);
    const child = join(realDir, "child.txt");
    await writeFile(child, "b", "utf8");
    const dirLink = join(dir, "dir-link");
    await symlink(realDir, dirLink);
    expect(await resolveMutationTargetPath(join(dirLink, "child.txt"))).toBe(child);
  });

  test("detects symlink loops", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hashline-loop-"));
    const a = join(dir, "a");
    const b = join(dir, "b");
    await symlink(b, a);
    await symlink(a, b);
    await expect(resolveMutationTargetPath(a)).rejects.toMatchObject({ code: "ELOOP" });
  });
});

describe("writeTextFileAtomically", () => {
  test("writes through symlink without replacing link", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hashline-write-"));
    const target = join(dir, "target.txt");
    const link = join(dir, "link.txt");
    await writeFile(target, "old", "utf8");
    await symlink(target, link);

    await writeTextFileAtomically(link, "new");

    expect(await readFile(target, "utf8")).toBe("new");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  test("preserves file mode and removes temp files on success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hashline-mode-"));
    const path = join(dir, "file.txt");
    await writeFile(path, "old", "utf8");
    await chmod(path, 0o640);

    await writeTextFileAtomically(path, "new");

    expect(await readFile(path, "utf8")).toBe("new");
    expect((await lstat(path)).mode & 0o777).toBe(0o640);
    const files = await readdir(dir);
    expect(files.some((file) => file.startsWith(".pi-hashline-"))).toBe(false);
  });

  test("rejects hardlinked files without changing linked content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hashline-hardlink-"));
    const path = join(dir, "file.txt");
    const hardlink = join(dir, "hardlink.txt");
    await writeFile(path, "old", "utf8");
    await link(path, hardlink);

    await expect(writeTextFileAtomically(path, "new")).rejects.toThrow("[E_HARDLINK_UNSUPPORTED]");
    expect(await readFile(path, "utf8")).toBe("old");
    expect(await readFile(hardlink, "utf8")).toBe("old");
  });

  test("rejects when expected snapshot changed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hashline-snapshot-"));
    const path = join(dir, "file.txt");
    await writeFile(path, "old", "utf8");
    const snapshot = await getFileSnapshot(path);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(path, "external", "utf8");

    await expect(writeTextFileAtomically(path, "new", { expectedSnapshot: snapshot })).rejects.toThrow("[E_CONCURRENT_MODIFICATION]");
    expect(await readFile(path, "utf8")).toBe("external");
  });
});
