import { expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeLineHash } from "../src/hashline";

let diffInput: { oldContent: string; newContent: string } | undefined;
let patchInput: { path: string; oldContent: string; newContent: string } | undefined;


mock.module("@earendil-works/pi-coding-agent", () => ({
  DEFAULT_MAX_BYTES: 50 * 1024,
  defineTool: (tool: unknown) => tool,
  generateDiffString(oldContent: string, newContent: string) {
    diffInput = { oldContent, newContent };
    return { diff: "-2 b\n+2 B", firstChangedLine: 2 };
  },
  generateUnifiedPatch(path: string, oldContent: string, newContent: string) {
    patchInput = { path, oldContent, newContent };
    return `--- ${path}\n+++ ${path}\n`;
  },
  renderDiff: (diff: string) => diff,
  withFileMutationQueue: async (_path: string, run: () => Promise<unknown>) => run(),
}));

mock.module("@earendil-works/pi-tui", () => ({
  Text: class {
    constructor(public text = "") {}
    setText(text: string) {
      this.text = text;
    }
  },
}));

mock.module("@sinclair/typebox", () => ({
  Type: new Proxy({}, {
    get: () => (..._args: unknown[]) => ({}),
  }),
}));

const { registerEditTool } = await import("../src/edit-tool");

function captureEditTool(): any {
  let tool: any;
  registerEditTool({
    registerTool(definition: unknown) {
      tool = definition;
    },
  } as any);
  return tool;
}

test("edit returns host-visible diff and unified patch details", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-hashline-edit-tool-"));
  const path = join(cwd, "sample.txt");
  try {
    await writeFile(path, "a\nb\nc\n", "utf8");
    const tool = captureEditTool();
    const lineId = `2${computeLineHash("b")}`;
    const result = await tool.execute(
      "edit-1",
      {
        path: "sample.txt",
        edits: [{ loc: { range: { pos: lineId, end: lineId } }, content: ["B"] }],
      },
      undefined,
      undefined,
      { cwd },
    );

    expect(await readFile(path, "utf8")).toBe("a\nB\nc\n");
    expect(diffInput).toEqual({ oldContent: "a\nb\nc\n", newContent: "a\nB\nc\n" });
    expect(patchInput).toEqual({ path: "sample.txt", oldContent: "a\nb\nc\n", newContent: "a\nB\nc\n" });
    expect(result.details.diff).toBe("-2 b\n+2 B");
    expect(result.details.patch).toBe("--- sample.txt\n+++ sample.txt\n");
    expect(result.details.firstChangedLine).toBe(2);
    expect(result.content[0].text).toContain(`2${computeLineHash("B")}|B`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("prepareArguments maps legacy edit shapes onto strict v3 shapes", () => {
  const tool = captureEditTool();
  expect(tool.prepareArguments({
    path: "f.txt",
    edits: [
      { op: "replace", pos: "1aabb", lines: ["X"] },
      { op: "replace", pos: "2aabb", end: "3ccdd", lines: null },
      { op: "append", lines: ["tail"] },
      { op: "prepend", pos: "1aabb", lines: "head" },
      { op: "replace_text", oldText: "a", newText: "b" },
      { loc: "append", content: ["kept"] },
      { range: { pos: "4aabb", end: "5ccdd" }, content: ["naive"] },
      { append: "6aabb", content: ["naive-append"] },
      { prepend: "7aabb", content: ["naive-prepend"] },
    ],
  })).toEqual({
    path: "f.txt",
    edits: [
      { loc: { range: { pos: "1aabb", end: "1aabb" } }, content: ["X"] },
      { loc: { range: { pos: "2aabb", end: "3ccdd" } }, content: null },
      { loc: "append", content: ["tail"] },
      { loc: { prepend: "1aabb" }, content: "head" },
      { oldText: "a", newText: "b" },
      { loc: "append", content: ["kept"] },
      { loc: { range: { pos: "4aabb", end: "5ccdd" } }, content: ["naive"] },
      { loc: { append: "6aabb" }, content: ["naive-append"] },
      { loc: { prepend: "7aabb" }, content: ["naive-prepend"] },
    ],
  });

  expect(tool.prepareArguments({ path: "f.txt", oldText: "a", newText: "b" })).toEqual({
    path: "f.txt",
    edits: [{ oldText: "a", newText: "b" }],
  });
  expect(tool.prepareArguments({ path: "f.txt", old_text: "a", new_text: "b" })).toEqual({
    path: "f.txt",
    edits: [{ oldText: "a", newText: "b" }],
  });
});
