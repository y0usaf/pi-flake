import { describe, expect, test } from "bun:test";
import { HASHLINE_BIGRAMS } from "../src/constants";
import {
  applyEditsToRawContentPreservingLineEndings,
  buildChangedAnchorResponse,
  computeEditLineMetrics,
  computeLineHash,
  formatHashlineRegion,
  getVisibleLines,
  type RawEdit,
} from "../src/hashline";

function anchor(lineNumber: number, line: string): string {
  return `${lineNumber}${computeLineHash(line)}`;
}

function apply(original: string, edits: RawEdit[]): string {
  return applyEditsToRawContentPreservingLineEndings(original, edits);
}

describe("hashline formatting", () => {
  test("visible lines ignore only the terminal newline", () => {
    expect(getVisibleLines("")).toEqual([]);
    expect(getVisibleLines("a\nb")).toEqual(["a", "b"]);
    expect(getVisibleLines("a\nb\n")).toEqual(["a", "b"]);
    expect(getVisibleLines("a\n\nb\n")).toEqual(["a", "", "b"]);
  });

  test("generated bigram table matches the original hand-written table", () => {
    // Pinned against the pre-generation implementation. Any change here means
    // every emitted anchor changes and stored sessions get stale-anchor errors.
    expect(HASHLINE_BIGRAMS.length).toBe(647);
    expect(HASHLINE_BIGRAMS[0]).toBe("aa");
    expect(HASHLINE_BIGRAMS[646]).toBe("zz");
    expect(computeLineHash("  return value;")).toBe("dqhk");
    expect(computeLineHash("")).toBe("duyy");
    expect(computeLineHash("const x = 1;")).toBe("heah");
  });

  test("hashes exact content", () => {
    expect(computeLineHash("}")).toMatch(/^[a-z]{4}$/);
    expect(computeLineHash("}")).not.toBe(computeLineHash("{"));
    expect(computeLineHash("value")).not.toBe(computeLineHash("value "));
    expect(computeLineHash("")).not.toBe(computeLineHash(" "));
  });

  test("formatted region prefixes LINEID|content", () => {
    expect(formatHashlineRegion(["alpha", "beta"], 10)).toBe(
      `10${computeLineHash("alpha")}|alpha\n11${computeLineHash("beta")}|beta`,
    );
  });
});

describe("anchor edits", () => {
  test("replace, append, prepend, and delete apply to original snapshot", () => {
    const original = "a\nb\nc\nd\n";
    const result = apply(original, [
      { loc: { range: { pos: anchor(2, "b"), end: anchor(2, "b") } }, content: ["B"] },
      { loc: { append: anchor(4, "d") }, content: ["e"] },
    ]);
    expect(result).toBe("a\nB\nc\nd\ne\n");

    expect(apply("a\nb\n", [
      { loc: { prepend: anchor(1, "a") }, content: ["z"] },
    ])).toBe("z\na\nb\n");

    expect(apply("a\nb\nc\n", [
      { loc: { range: { pos: anchor(2, "b"), end: anchor(3, "c") } }, content: null },
    ])).toBe("a\n");
  });

  test("preserves original terminal newline state", () => {
    expect(apply("a\nb\n", [
      { loc: { range: { pos: anchor(2, "b"), end: anchor(2, "b") } }, content: ["B"] },
    ])).toBe("a\nB\n");
    expect(apply("a\nb", [
      { loc: { range: { pos: anchor(2, "b"), end: anchor(2, "b") } }, content: ["B"] },
    ])).toBe("a\nB");
  });

  test("empty file supports boundary inserts", () => {
    expect(apply("", [{ loc: "prepend", content: ["a"] }])).toBe("a");
    expect(apply("", [{ loc: "append", content: ["a", "b"] }])).toBe("a\nb");
  });

  test("stale, v2, and malformed anchors reject", () => {
    const replaceAt = (pos: string): RawEdit[] => [
      { loc: { range: { pos, end: pos } }, content: ["B"] },
    ];
    expect(() => apply("a\nb\n", replaceAt(anchor(2, "not-b")))).toThrow("[E_STALE_ANCHOR]");
    expect(() => apply("a\nb\n", replaceAt("2aa"))).toThrow("[E_BAD_REF]");
    expect(() => apply("a\nb\n", replaceAt("2#ZZ"))).toThrow("[E_BAD_REF]");
    expect(() => apply("a\nb\n", replaceAt("2"))).toThrow("[E_BAD_REF]");
  });

  test("never relocates stale anchors to nearby matching content", () => {
    const pos = anchor(2, "foo");
    expect(() => apply("a\nbar\nfoo\nb\n", [
      { loc: { range: { pos, end: pos } }, content: ["FOO"] },
    ])).toThrow("[E_STALE_ANCHOR]");
  });

  test("overlapping or adjacent edits reject", () => {
    expect(() => apply("a\nb\nc\n", [
      { loc: { range: { pos: anchor(1, "a"), end: anchor(1, "a") } }, content: ["A"] },
      { loc: { range: { pos: anchor(2, "b"), end: anchor(2, "b") } }, content: ["B"] },
    ])).toThrow("[E_EDIT_CONFLICT]");
  });

  test("rendered v2/v3 hashline and diff prefixes are rejected in patch lines", () => {
    const pos = anchor(1, "a");
    const replaceWith = (content: string[]): RawEdit[] => [
      { loc: { range: { pos, end: pos } }, content },
    ];
    expect(() => apply("a\n", replaceWith([`1${computeLineHash("a")}|a`]))).toThrow("[E_INVALID_PATCH]");
    expect(() => apply("a\n", replaceWith(["1aa|a"]))).toThrow("[E_INVALID_PATCH]");
    expect(() => apply("a\n", replaceWith([`+ 1${computeLineHash("a")}|a`]))).toThrow("[E_INVALID_PATCH]");
    expect(apply("a\n", replaceWith(["+ legitimate text"]))).toBe("+ legitimate text\n");
  });

  test("raw anchor edits preserve mixed line endings", () => {
    const original = "a\nb\r\nc\r\n";
    const result = apply(original, [
      { loc: { range: { pos: anchor(2, "b"), end: anchor(2, "b") } }, content: ["B"] },
    ]);
    expect(result).toBe("a\nB\r\nc\r\n");
  });

  test("raw inserts preserve final newline state", () => {
    expect(apply("a", [{ loc: { append: anchor(1, "a") }, content: ["b"] }])).toBe("a\nb");
    expect(apply("a\r\n", [{ loc: { append: anchor(1, "a") }, content: ["b"] }])).toBe("a\r\nb\r\n");
  });
});

describe("replace_text", () => {
  test("replaces exact unique text", () => {
    expect(apply("a b c", [{ oldText: "b", newText: "B" }])).toBe("a B c");
  });

  test("rejects empty, missing, and multiple matches", () => {
    expect(() => apply("abc", [{ oldText: "", newText: "x" }])).toThrow("[E_BAD_OP]");
    expect(() => apply("abc", [{ oldText: "z", newText: "x" }])).toThrow("[E_NO_MATCH]");
    expect(() => apply("aa", [{ oldText: "a", newText: "x" }])).toThrow("[E_MULTI_MATCH]");
  });

  test("cannot mix replace_text with anchor edits", () => {
    expect(() => apply("a\n", [
      { oldText: "a", newText: "A" },
      { loc: "append", content: ["b"] },
    ])).toThrow("[E_EDIT_CONFLICT]");
  });

  test("raw replace_text preserves unrelated mixed line endings", () => {
    expect(apply("a\nb\r\nc\r\n", [
      { oldText: "b", newText: "B" },
    ])).toBe("a\nB\r\nc\r\n");

    expect(apply("a\nb\r\nc\r\n", [
      { oldText: "b\nc", newText: "B\nC" },
    ])).toBe("a\nB\r\nC\r\n");
  });
});

describe("changed anchor response", () => {
  test("returns fresh anchors around changed region", () => {
    const response = buildChangedAnchorResponse("a\nb\nc\n", "a\nB\nc\n");
    expect(response.text).toContain("--- Anchors 1-3 ---");
    expect(response.text).toContain(`2${computeLineHash("B")}|B`);
    expect(response.addedLines).toBe(1);
    expect(response.removedLines).toBe(1);
  });

  test("edit metrics sum requested edits instead of spanning unchanged lines", () => {
    const original = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const replaceLine = (line: number): RawEdit => {
      const pos = anchor(line, `line ${line}`);
      return { loc: { range: { pos, end: pos } }, content: [`LINE ${line}`] };
    };
    const edits = [replaceLine(2), replaceLine(50), replaceLine(98)];
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
