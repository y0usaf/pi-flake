import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectLineEnding,
  detectSupportedImageMime,
  isSupportedImageFile,
  loadTextFile,
  normalizeToLF,
  restoreLineEnding,
  stripBom,
} from "../src/text-file";

describe("line endings and BOM", () => {
  test("normalizes and restores line endings", () => {
    expect(normalizeToLF("a\r\nb\rc")).toBe("a\nb\nc");
    expect(restoreLineEnding("a\nb", "\n")).toBe("a\nb");
    expect(restoreLineEnding("a\nb", "\r\n")).toBe("a\r\nb");
  });

  test("detects line ending from first newline", () => {
    expect(detectLineEnding("a\r\nb\n")).toBe("\r\n");
    expect(detectLineEnding("a\nb\r\n")).toBe("\n");
    expect(detectLineEnding("abc")).toBe("\n");
  });

  test("strips BOM", () => {
    expect(stripBom("\uFEFFabc")).toEqual({ bom: "\uFEFF", text: "abc" });
    expect(stripBom("abc")).toEqual({ bom: "", text: "abc" });
  });
});

describe("image detection", () => {
  test("detects common image magic bytes", () => {
    expect(detectSupportedImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(detectSupportedImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe("image/jpeg");
    expect(detectSupportedImageMime(Buffer.from("GIF89a", "ascii"))).toBe("image/gif");
    expect(detectSupportedImageMime(Buffer.from("RIFFxxxxWEBP", "ascii"))).toBe("image/webp");
    expect(detectSupportedImageMime(Buffer.from("hello", "utf8"))).toBeUndefined();
  });
});

describe("loadTextFile", () => {
  test("loads UTF-8, strips BOM, normalizes line endings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hashline-text-"));
    const path = join(dir, "file.png");
    await writeFile(path, "\uFEFFa\r\nb\r\n", "utf8");
    await expect(isSupportedImageFile(path)).resolves.toBe(false);
    await expect(loadTextFile(path)).resolves.toEqual({
      bom: "\uFEFF",
      text: "a\nb\n",
      lineEnding: "\r\n",
    });
  });

  test("rejects directories, null bytes, and invalid UTF-8", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hashline-text-"));
    await mkdir(join(dir, "subdir"));
    await expect(loadTextFile(join(dir, "subdir"))).rejects.toThrow("Path is a directory");

    const binary = join(dir, "binary.bin");
    await writeFile(binary, Buffer.from([0x61, 0x00, 0x62]));
    await expect(loadTextFile(binary)).rejects.toThrow("null bytes");

    const invalid = join(dir, "invalid.txt");
    await writeFile(invalid, Buffer.from([0xff, 0xfe, 0xfd]));
    await expect(loadTextFile(invalid)).rejects.toThrow("valid UTF-8");
  });

  test("isSupportedImageFile reads magic bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-hashline-image-"));
    const path = join(dir, "renamed.bin");
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await expect(isSupportedImageFile(path)).resolves.toBe(true);
    await expect(isSupportedImageFile(dir)).resolves.toBe(false);
  });
});
