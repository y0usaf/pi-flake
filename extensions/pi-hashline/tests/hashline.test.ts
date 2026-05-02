import { describe, expect, test } from "bun:test";
import {
  applyEditsToContent,
  applyEditsToRawContentPreservingLineEndings,
  buildChangedAnchorResponse,
  computeEditLineMetrics,
  computeLineHash,
  formatHashlineRegion,
  getVisibleLines,
  type RawEdit,
} from "../src/hashline";

function anchor(lineNumber: number, line: string): string {
  return `${lineNumber}${computeLineHash(lineNumber, line)}`;
}

function apply(original: string, edits: RawEdit[]): string {
  return applyEditsToContent(original, edits);
}

function applyRaw(original: string, edits: RawEdit[]): string {
  return applyEditsToRawContentPreservingLineEndings(original, edits);
}

describe("hashline formatting", () => {
  test("visible lines ignore only the terminal newline", () => {
    expect(getVisibleLines("")).toEqual([]);
    expect(getVisibleLines("a\nb")).toEqual(["a", "b"]);
    expect(getVisibleLines("a\nb\n")).toEqual(["a", "b"]);
    expect(getVisibleLines("a\n\nb\n")).toEqual(["a", "", "b"]);
  });

  test("hashes are two characters from the custom alphabet", () => {
    const hash = computeLineHash(12, "  return value;");
    expect(hash).toMatch(/^[a-z]{2}$/);
    expect(computeLineHash(12, "  return value;")).toBe(hash);
  });

  test("symbol-only lines include line number seed", () => {
    expect(computeLineHash(1, "}")).not.toBe(computeLineHash(2, "}"));
  });

  test("formatted region prefixes LINEID|content", () => {
    expect(formatHashlineRegion(["alpha", "beta"], 10)).toBe(
      `10${computeLineHash(10, "alpha")}|alpha\n11${computeLineHash(11, "beta")}|beta`,
    );
  });
});

describe("anchor edits", () => {
  test("replace, append, prepend, and delete apply to original snapshot", () => {
    const original = "a\nb\nc\nd\n";
    const result = apply(original, [
      { op: "replace", pos: anchor(2, "b"), lines: ["B"] },
      { op: "append", pos: anchor(4, "d"), lines: ["e"] },
    ]);
    expect(result).toBe("a\nB\nc\nd\ne\n");

    expect(apply("a\nb\n", [
      { op: "prepend", pos: anchor(1, "a"), lines: ["z"] },
    ])).toBe("z\na\nb\n");

    expect(apply("a\nb\nc\n", [
      { op: "replace", pos: anchor(2, "b"), end: anchor(3, "c"), lines: null },
    ])).toBe("a\n");
  });

  test("preserves original terminal newline state", () => {
    expect(apply("a\nb\n", [
      { op: "replace", pos: anchor(2, "b"), lines: ["B"] },
    ])).toBe("a\nB\n");
    expect(apply("a\nb", [
      { op: "replace", pos: anchor(2, "b"), lines: ["B"] },
    ])).toBe("a\nB");
  });

  test("empty file supports boundary inserts", () => {
    expect(apply("", [{ op: "prepend", lines: ["a"] }])).toBe("a");
    expect(apply("", [{ op: "append", lines: ["a", "b"] }])).toBe("a\nb");
  });

  test("stale and malformed anchors reject", () => {
    expect(() => apply("a\nb\n", [
      { op: "replace", pos: "2aa", lines: ["B"] },
    ])).toThrow("[E_STALE_ANCHOR]");
    expect(() => apply("a\nb\n", [
      { op: "replace", pos: "2#ZZ", lines: ["B"] },
    ])).toThrow("[E_BAD_REF]");
    expect(() => apply("a\nb\n", [
      { op: "replace", pos: "2", lines: ["B"] },
    ])).toThrow("[E_BAD_REF]");
  });

  test("rebases a stale anchor to a nearby identical hash", () => {
    const result = apply("a\nbar\nfoo\nb\n", [
      { op: "replace", pos: anchor(2, "foo"), lines: ["FOO"] },
    ]);
    expect(result).toBe("a\nbar\nFOO\nb\n");
  });

  test("overlapping or adjacent edits reject", () => {
    expect(() => apply("a\nb\nc\n", [
      { op: "replace", pos: anchor(1, "a"), lines: ["A"] },
      { op: "replace", pos: anchor(2, "b"), lines: ["B"] },
    ])).toThrow("[E_EDIT_CONFLICT]");
  });

  test("rendered hashline and diff prefixes are rejected in patch lines", () => {
    expect(() => apply("a\n", [
      { op: "replace", pos: anchor(1, "a"), lines: [`1${computeLineHash(1, "a")}|a`] },
    ])).toThrow("[E_INVALID_PATCH]");
    expect(() => apply("a\n", [
      { op: "replace", pos: anchor(1, "a"), lines: [`+ 1${computeLineHash(1, "a")}|a`] },
    ])).toThrow("[E_INVALID_PATCH]");
    expect(apply("a\n", [
      { op: "replace", pos: anchor(1, "a"), lines: ["+ legitimate text"] },
    ])).toBe("+ legitimate text\n");
  });

  test("v2 loc/content edits apply", () => {
    expect(apply("a\nb\nc\n", [
      { loc: { range: { pos: anchor(2, "b"), end: anchor(2, "b") } }, content: ["B"] },
      { loc: { append: anchor(3, "c") }, content: ["d"] },
    ])).toBe("a\nB\nc\nd\n");
    expect(apply("a\n", [{ loc: "prepend", content: ["z"] }])).toBe("z\na\n");
  });

  test("raw anchor edits preserve mixed line endings", () => {
    const original = "a\nb\r\nc\r\n";
    const result = applyRaw(original, [
      { loc: { range: { pos: anchor(2, "b"), end: anchor(2, "b") } }, content: ["B"] },
    ]);
    expect(result).toBe("a\nB\r\nc\r\n");
  });

  test("raw inserts preserve final newline state", () => {
    expect(applyRaw("a", [{ loc: { append: anchor(1, "a") }, content: ["b"] }])).toBe("a\nb");
    expect(applyRaw("a\r\n", [{ loc: { append: anchor(1, "a") }, content: ["b"] }])).toBe("a\r\nb\r\n");
  });
});

describe("replace_text", () => {
  test("replaces exact unique text", () => {
    expect(apply("a b c", [
      { op: "replace_text", oldText: "b", newText: "B" },
    ])).toBe("a B c");
  });

  test("rejects empty, missing, and multiple matches", () => {
    expect(() => apply("abc", [{ op: "replace_text", oldText: "", newText: "x" }])).toThrow("[E_BAD_OP]");
    expect(() => apply("abc", [{ op: "replace_text", oldText: "z", newText: "x" }])).toThrow("[E_NO_MATCH]");
    expect(() => apply("aa", [{ op: "replace_text", oldText: "a", newText: "x" }])).toThrow("[E_MULTI_MATCH]");
  });

  test("cannot mix replace_text with anchor edits", () => {
    expect(() => apply("a\n", [
      { op: "replace_text", oldText: "a", newText: "A" },
      { op: "append", lines: ["b"] },
    ])).toThrow("[E_EDIT_CONFLICT]");
  });

  test("raw replace_text preserves unrelated mixed line endings", () => {
    const result = applyRaw("a\nb\r\nc\r\n", [
      { op: "replace_text", oldText: "b", newText: "B" },
    ]);
    expect(result).toBe("a\nB\r\nc\r\n");

    expect(applyRaw("a\nb\r\nc\r\n", [
      { op: "replace_text", oldText: "b\nc", newText: "B\nC" },
    ])).toBe("a\nB\r\nC\r\n");
  });
});

describe("changed anchor response", () => {
  test("returns fresh anchors around changed region", () => {
    const response = buildChangedAnchorResponse("a\nb\nc\n", "a\nB\nc\n");
    expect(response.text).toContain("--- Anchors 1-3 ---");
    expect(response.text).toContain(`2${computeLineHash(2, "B")}|B`);
    expect(response.addedLines).toBe(1);
    expect(response.removedLines).toBe(1);
  });

  test("edit metrics sum requested edits instead of spanning unchanged lines", () => {
    const original = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const edits: RawEdit[] = [
      { op: "replace", pos: anchor(2, "line 2"), lines: ["LINE 2"] },
      { op: "replace", pos: anchor(50, "line 50"), lines: ["LINE 50"] },
      { op: "replace", pos: anchor(98, "line 98"), lines: ["LINE 98"] },
    ];
    const response = buildChangedAnchorResponse(original, apply(original, edits));
    expect(response.addedLines).toBe(97);
    expect(response.removedLines).toBe(97);
    expect(computeEditLineMetrics(original, edits)).toEqual({ addedLines: 3, removedLines: 3 });
  });

  test("omits overly large anchor blocks", () => {
    const response = buildChangedAnchorResponse("a\n", "A\n", { maxBytes: 5 });
    expect(response.text).toContain("Anchors omitted");
  });
});
