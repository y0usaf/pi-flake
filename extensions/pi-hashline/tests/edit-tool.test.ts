import { expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeLineHash } from "../src/hashline";

let diffInput: { oldContent: string; newContent: string } | undefined;
let patchInput: { path: string; oldContent: string; newContent: string } | undefined;

mock.module("@earendil-works/pi-ai", () => ({
  StringEnum: () => ({}),
}));

mock.module("@earendil-works/pi-coding-agent", () => ({
  DEFAULT_MAX_BYTES: 50 * 1024,
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
    const lineId = `2${computeLineHash(2, "b")}`;
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
    expect(result.content[0].text).toContain(`2${computeLineHash(2, "B")}|B`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
