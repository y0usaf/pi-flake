import { describe, expect, mock, test } from "bun:test";
import { callHeaderLine, resultLines, tailBody, badgeForPath } from "../src/format";
import { renderOutputBlock } from "../../shared/frame";
import { renderStatusLine } from "../src/status";
import { skinDefinition } from "../src/skin";
import { EXT_BADGES, TREE_SPECS } from "../src/specs";
import { renderTreeList } from "../src/tree";

// Local ANSI-stripping width helper: drop real escape sequences and the
// fake fg/bg markers so width arithmetic treats the injected styling as
// zero-width (matching how real ANSI resolves in visibleWidth).
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\[BG\]/g, "").replace(/\[FG\]/g, "");

const theme: any = {
  fg: (_token: string, s: string) => s,
  bg: (_token: string, s: string) => s,
  bold: (s: string) => s,
  getBgAnsi: () => "[BG]",
  getFgAnsi: () => "[FG]",
};

const wrapTextWithAnsi = (s: string, width: number): string[] => {
  if (!s) return [""];
  const lines: string[] = [];
  let current = "";
  let inEscape = false;
  for (const ch of s) {
    current += ch;
    if (inEscape) {
      if (ch === "m") inEscape = false;
      continue;
    }
    if (ch === "\x1b") {
      inEscape = true;
      continue;
    }
    if (strip(current).length >= width && current.trimEnd()) {
      lines.push(current);
      current = "";
    }
  }
  if (current || lines.length === 0) lines.push(current);
  return lines;
};

const truncateToWidth = (s: string, width: number): string => {
  let out = "";
  let length = 0;
  for (const ch of s) {
    if (strip(ch).length === 0) {
      out += ch;
    } else if (length < width) {
      out += ch;
      length += 1;
    }
  }
  return out;
};

const deps = {
  keyHint: (_id: string, d: string) => `ctrl+o ${d}`,
  visibleWidth: (s: string) => strip(s).length,
  truncateToWidth,
};
const frameDeps = { visibleWidth: deps.visibleWidth, truncateToWidth, wrapTextWithAnsi };

// Zero-node_modules pattern: render.ts statically imports pi packages, so the
// pi packages are mocked and render.ts is imported dynamically after the mocks
// are registered (same pattern pi-hashline uses).
mock.module("@earendil-works/pi-tui", () => ({
  Text: class {
    constructor(public text = "", ..._rest: unknown[]) {}
    setText(text: string) {
      this.text = text;
    }
  },
  truncateToWidth,
  visibleWidth: deps.visibleWidth,
  wrapTextWithAnsi,
}));
mock.module("@earendil-works/pi-coding-agent", () => ({
  keyHint: deps.keyHint,
}));

const { renderCall, renderResult } = await import("../src/render");

const slotContext = (extra: Record<string, unknown> = {}) =>
  ({
    state: {},
    expanded: false,
    isError: false,
    isPartial: false,
    executionStarted: true,
    invalidate: () => {},
    ...extra,
  }) as any;

describe("pi-frames formatting", () => {
  test("call header is $ command for bash, label primary for others, extras dim", () => {
    expect(callHeaderLine("bash", { command: "echo hi", timeout: 2 }, theme, deps)).toContain("$ echo hi");
    expect(callHeaderLine("bash", { command: "echo hi", timeout: 2 }, theme, deps)).toContain("timeout=2");
    expect(callHeaderLine("write", { path: "a.txt", content: "x" }, theme, deps)).toContain("write a.txt");
    expect(callHeaderLine("write", { path: "a.txt", content: "x" }, theme, deps)).toContain("bytes=1");
    expect(callHeaderLine("grep", { pattern: "needle", path: "src" }, theme, deps)).toContain("grep needle");
    expect(callHeaderLine("grep", { pattern: "needle", path: "src" }, theme, deps)).toContain("path=src");
    expect(callHeaderLine("find", { pattern: "*.ts" }, theme, deps)).toContain("find *.ts");
    expect(callHeaderLine("ls", {}, theme, deps)).toContain("ls .");
  });

  test("status line flattens embedded newlines", () => {
    const line = renderStatusLine({ icon: "pending", title: "write", description: "a\nb", meta: ["x\r\ny"] }, theme);
    expect(line).toContain("a b");
    expect(line).toContain("x y");
    expect(line.split("\n").length).toBe(1);
  });

  test("tail clips collapsed vs expanded, keeping the tail", () => {
    const body = "a\nb\nc\nd\ne";
    const collapsed = tailBody("grep", body, false, theme, deps);
    expect(collapsed[0]).toContain("… (2 earlier lines, showing 3 of 5)");
    expect(collapsed[0]).toContain("ctrl+o");
    expect(collapsed).toEqual(["… (2 earlier lines, showing 3 of 5) (ctrl+o to expand)", "c", "d", "e"]);
    expect(tailBody("grep", body, true, theme, deps)).toEqual(["a", "b", "c", "d", "e"]);
    expect(tailBody("grep", "a\nb", false, theme, deps)).toEqual(["a", "b"]);
  });

  test("error results stay full", () => {
    const lines = resultLines("grep", { content: [{ type: "text", text: "a\nb\nc\nd" }], details: {} }, false, true, undefined, theme, deps);
    expect(lines).toEqual(["a", "b", "c", "d"]);
  });

  test("footer omits when nothing available, renders from details and elapsed", () => {
    const rendered = (result: any, isError = false, state?: { startedAt?: number; endedAt?: number }) =>
      resultLines("bash", result, false, isError, state, theme, deps);
    expect(rendered({ content: [], details: {} })).toEqual([]);
    const truncation = rendered({ content: [{ type: "text", text: "x" }], details: { truncation: { truncated: true, outputLines: 10, totalLines: 24 } } });
    expect(truncation[truncation.length - 1]).toContain("showing 10 of 24");
    const matches = rendered({ content: [{ type: "text", text: "x" }], details: { matchLimitReached: 100 } }, false, { startedAt: 0, endedAt: 0 });
    expect(matches[matches.length - 1]).toContain("100 matches limit");
    const results = rendered({ content: [{ type: "text", text: "x" }], details: { resultLimitReached: 1000 } }, false, { startedAt: 0, endedAt: 0 });
    expect(results[results.length - 1]).toContain("1000 results limit");
    const entries = rendered({ content: [{ type: "text", text: "x" }], details: { entryLimitReached: 500 } }, false, { startedAt: 0, endedAt: 0 });
    expect(entries[entries.length - 1]).toContain("500 entries limit");
    const elapsed = rendered({ content: [{ type: "text", text: "x" }], details: {} }, false, { startedAt: 0, endedAt: 140 });
    expect(elapsed[elapsed.length - 1]).toContain("[✓ 0.1s]");
    const err = rendered({ content: [{ type: "text", text: "x" }], details: {} }, true, { startedAt: 0, endedAt: 140 });
    expect(err[err.length - 1]).toContain("[✗ 0.1s]");
  });

  test("skin sets renderShell self and preserves builtin identity", () => {
    const parameters = { type: "object" };
    const execute = async () => ({ content: [] });
    for (const name of ["bash", "write", "grep", "find", "ls"]) {
      const fake = { name, description: "d", parameters, execute, promptSnippet: "s" };
      const result = skinDefinition(fake, () => undefined, () => undefined);
      expect(result.renderShell).toBe("self");
      expect(result.name).toBe(name);
      expect(result.parameters).toBe(parameters);
      expect(result.execute).toBe(execute);
      expect(result.promptSnippet).toBe("s");
      expect(result.renderCall).toBeFunction();
      expect(result.renderResult).toBeFunction();
    }
  });
});

describe("pi-frames tree rendering", () => {
  test("last visible row uses '--, others |--", () => {
    const rows = renderTreeList({ items: ["a", "b", "c"], renderItem: (s) => s }, theme, deps);
    expect(rows).toEqual(["├─ a", "├─ b", "└─ c"]);
  });

  test("clipped list ends with the ... N more files summary on the final '-- row", () => {
    const rows = renderTreeList({ items: ["a", "b", "c", "d", "e"], maxCollapsed: 3, itemType: "file", renderItem: (s) => s }, theme, deps);
    expect(rows).toEqual(["├─ a", "├─ b", "├─ c", "└─ ... 2 more files"]);
    expect(rows[rows.length - 1]).toBe("└─ ... 2 more files");
  });

  test("expanded shows every item with no summary", () => {
    const rows = renderTreeList({ items: ["a", "b", "c", "d", "e"], expanded: true, maxCollapsed: 3, itemType: "file", renderItem: (s) => s }, theme, deps);
    expect(rows).toEqual(["├─ a", "├─ b", "├─ c", "├─ d", "└─ e"]);
    expect(rows.some((r) => r.includes("more files"))).toBe(false);
  });

  test("empty items render nothing", () => {
    expect(renderTreeList({ items: [], renderItem: (s) => s }, theme, deps)).toEqual([]);
  });

  test("badge table: ts/tsx→ts, yaml→yml; unknown/dotfile/no-ext get no badge", () => {
    expect(EXT_BADGES["ts"]).toBe("ts");
    expect(EXT_BADGES["tsx"]).toBe("ts");
    expect(EXT_BADGES["yaml"]).toBe("yml");
    expect(badgeForPath("src/web/search/provider.ts")).toBe("ts");
    expect(badgeForPath("src/main.rs")).toBe("rs");
    expect(badgeForPath("src/main.pyc")).toBeUndefined();
    expect(badgeForPath("Makefile")).toBeUndefined();
    expect(badgeForPath(".gitignore")).toBeUndefined();
  });

  test("ls '/' suffix classifies dirs; entry itemType pluralizes to entries", () => {
    expect(TREE_SPECS["ls"].isDir("dist/")).toBe(true);
    expect(TREE_SPECS["ls"].isDir("main.ts")).toBe(false);
    expect(TREE_SPECS["ls"].itemType).toBe("entry");
    expect(TREE_SPECS["find"].itemType).toBe("file");
    expect(TREE_SPECS["find"].isDir("src/web/search/providers/")).toBe(true);
  });

  test("find result lines tree into badge/[D] rows with trailing slash preserved", () => {
    const lines = resultLines(
      "find",
      { content: [{ type: "text", text: "src/web/search/provider.ts\nsrc/web/search/providers/" }], details: {} },
      false,
      false,
      undefined,
      theme,
      deps,
      false,
    );
    expect(lines).toEqual(["├─ ts src/web/search/provider.ts", "└─ [D] src/web/search/providers/"]);
  });

  test("ls entries clip under the collapsed budget to ... N more entries", () => {
    const lines = resultLines(
      "ls",
      { content: [{ type: "text", text: "README.md\ndist/\nsrc/\nmain.ts\nindex.html" }], details: {} },
      false,
      false,
      undefined,
      theme,
      deps,
      false,
    );
    expect(lines).toEqual(["├─ md README.md", "├─ [D] dist/", "├─ [D] src/", "└─ ... 2 more entries"]);
  });

  test("no-result and limit-notice content pass through outside the inline tree", () => {
    // find renders inline: its result rows carry no bracketed footer.
    const noResult = resultLines("find", { content: [{ type: "text", text: "No files found matching pattern" }], details: {} }, false, false, undefined, theme, deps, false);
    expect(noResult).toEqual(["No files found matching pattern"]);
    const limited = resultLines(
      "find",
      { content: [{ type: "text", text: "a.ts\nb.rs\n\n[1000 results limit reached. Use limit=2000 for more, or refine pattern]" }], details: { resultLimitReached: 1000 } },
      false,
      false,
      undefined,
      theme,
      deps,
      false,
    );
    expect(limited[0]).toBe("├─ ts a.ts");
    expect(limited[1]).toBe("└─ rs b.rs");
    expect(limited[2]).toBe("[1000 results limit reached. Use limit=2000 for more, or refine pattern]");
    // No footer: inline find rows drop the bracketed `[✓ …]` line.
    expect(limited.length).toBe(3);
  });

  test("inline call line prefixes the ascii status icon for pending/success/error", () => {
    // Not yet started → pending `[*]`; default settled → success `[ok]`; error
    // → `[!!]`. The icon prefix is not a frame glyph: the call row stays a
    // bare text line.
    let context = slotContext({ executionStarted: false });
    const pending = renderCall("ls", {}, theme, context) as any;
    expect(pending.text).toStartWith("… ls .");
    expect(pending.text).not.toContain("|");

    context = slotContext();
    const ok = renderCall("ls", {}, theme, context) as any;
    expect(ok.text).toStartWith("✓ ls .");

    context = slotContext({ isError: true });
    const err = renderCall("ls", {}, theme, context) as any;
    expect(err.text).toStartWith("✗ ls .");
  });

  test("find/ls render inline bare tree rows; bash stays framed tail-style", () => {
    // find/ls renderResult returns a Text whose lines are the bare tree rows:
    // no frame borders, no `- Output -` tee, no `[✓` footer.
    let context = slotContext();
    const findCall = renderCall("find", { pattern: "*.ts" }, theme, context) as any;
    expect(findCall.text).toContain("find *.ts");
    expect(findCall.text).toStartWith("✓ ");
    context = slotContext();
    const find = renderResult("find", { content: [{ type: "text", text: "src/main.ts\nsrc/search/" }], details: undefined }, { isPartial: false, expanded: false }, theme, context) as any;
    const findLines = find.text.split("\n");
    expect(findLines).toEqual(["├─ ts src/main.ts", "└─ [D] src/search/"]);
    expect(findLines.some((l) => l.includes("- Output -"))).toBe(false);
    expect(findLines.some((l) => l.includes("[✓"))).toBe(false);
    expect(findLines.some((l) => l.startsWith("| "))).toBe(false);

    context = slotContext();
    const ls = renderResult("ls", { content: [{ type: "text", text: "a.ts\nb.ts\nc.ts\nd.ts\ne.ts" }], details: undefined }, { isPartial: false, expanded: false }, theme, context) as any;
    const lsLines = ls.text.split("\n");
    expect(lsLines).toEqual(["├─ ts a.ts", "├─ ts b.ts", "├─ ts c.ts", "└─ ... 2 more entries"]);
    expect(lsLines.some((l) => l.includes("- Output -"))).toBe(false);
    expect(lsLines.some((l) => l.includes("[✓"))).toBe(false);

    // Inline error results still render the full body; inline empty results
    // render empty text.
    context = slotContext({ isError: true });
    const errFind = renderResult("find", { content: [{ type: "text", text: "boom\nline2" }], details: undefined }, { isPartial: false, expanded: false }, theme, context) as any;
    expect(errFind.text).toBe("boom\nline2");
    context = slotContext();
    const emptyLs = renderResult("ls", { content: [], details: undefined }, { isPartial: false, expanded: false }, theme, context) as any;
    expect(emptyLs.text).toBe("");

    context = slotContext();
    const bash = renderResult("bash", { content: [{ type: "text", text: "l1\nl2\nl3\nl4\nl5" }], details: undefined }, { isPartial: false, expanded: false }, theme, context) as any;
    const bashLines = bash.render(60).map(strip).filter((l) => l.startsWith("│"));
    expect(bashLines[0]).toContain("earlier lines");
    expect(bashLines.some((l) => l.includes("|--"))).toBe(false);
  });
});

describe("pi-frames frame rendering", () => {
  test("top bar starts ┌─── and ends ┐; bottom └…┘; exact width", () => {
    const lines = renderOutputBlock({ header: "bash", state: "success", sections: [{ lines: ["body"] }], width: 20 }, theme, frameDeps);
    const top = strip(lines[0]);
    expect(top.startsWith("┌───")).toBe(true);
    expect(top.endsWith("┐")).toBe(true);
    const last = strip(lines[lines.length - 1]);
    expect(last.startsWith("└───")).toBe(true);
    expect(last.endsWith("┘")).toBe(true);
    for (const line of lines) expect(strip(line).length).toBe(20);
  });

  test("plain top bar renders a continuous fill with no label", () => {
    const lines = renderOutputBlock({ state: "pending", sections: [{ lines: ["body"] }], width: 20 }, theme, frameDeps);
    const top = strip(lines[0]);
    expect(top).toBe(`┌${"─".repeat(18)}┐`);
    expect(top).not.toContain(" ");
  });

  test("header label truncates rather than overflowing at narrow width", () => {
    const lines = renderOutputBlock({ header: "a very long header label that cannot fit", state: "pending", sections: [], width: 12 }, theme, frameDeps);
    const top = strip(lines[0]);
    expect(top.startsWith("┌───")).toBe(true);
    expect(top.endsWith("┐")).toBe(true);
    expect(top).not.toContain("cannot fit");
    expect(top.length).toBe(12);
  });

  test("content with SGR reset keeps bg re-injection when applyBg", () => {
    const lines = renderOutputBlock({ state: "success", sections: [{ lines: ["a\x1b[0mb"] }], width: 12 }, theme, frameDeps);
    expect(lines.some((l) => l.includes("\x1b[0m[BG]"))).toBe(true);
    for (const line of lines) expect(line.endsWith("\x1b[49m")).toBe(true);
  });

  test("applyBg false drops the bg wrapper", () => {
    const lines = renderOutputBlock({ state: "success", sections: [{ lines: ["body"] }], width: 12, applyBg: false }, theme, frameDeps);
    for (const line of lines) expect(line).not.toContain("[BG]");
  });

  test("topBar false: no + line and content starts on the first row", () => {
    const lines = renderOutputBlock({ state: "success", sections: [{ lines: ["body"] }], width: 20, topBar: false }, theme, frameDeps);
    // no top bar: the first row is content, not a + corner
    expect(strip(lines[0])).not.toContain("┌");
    expect(strip(lines[0]).startsWith("│")).toBe(true);
  });

  test("labeled section at index 0 draws its titled tee bar even with topBar false", () => {
    const lines = renderOutputBlock({ state: "success", topBar: false, sections: [{ label: "Output", lines: ["body"] }], width: 20 }, theme, frameDeps).map(strip);
    // the tee bar is the only corner line carrying the title (the bottom bar is a bare └─┘ streak)
    const tees = lines.filter((l) => l.includes("─ Output ─"));
    expect(tees.length).toBe(1);
    expect(tees[0].startsWith("┤")).toBe(true);
    expect(tees[0]).toContain("─ Output ─");
    expect(lines[0]).toBe(tees[0]);
  });

  test("call + result slots compose to one continuous box", () => {
    const context = slotContext();
    const call = renderCall("bash", { command: "git log --oneline -15", timeout: 2 }, theme, context) as any;
    const result = renderResult("bash", { content: [{ type: "text", text: "c1 commit message" }], details: undefined }, { isPartial: false, expanded: false }, theme, context) as any;
    const lines = [...call.render(30), ...result.render(30)].map(strip);

    // exactly three lines carry a corner/tee glyph: top bar, Output tee, bottom bar
    const corners = lines.filter((l) => l.includes("┌") || l.includes("┤") || l.includes("└") || l.includes("├"));
    expect(corners.length).toBe(3);
    expect(lines[0].startsWith("┌───")).toBe(true);
    expect(lines[0]).not.toContain("git");
    expect(lines[lines.length - 1].startsWith("└")).toBe(true);

    // the $ command is an interior row, not a border label
    expect(lines.some((l) => l.startsWith("│") && l.includes("$ git log"))).toBe(true);

    // exactly one tee row, carrying the Output label
    const tees = lines.filter((l) => l.includes("─ Output ─"));
    expect(tees.length).toBe(1);
    expect(tees[0]).toContain("Output");
  });

  test("long command wraps to multiple | rows without truncation", () => {
    const context = slotContext();
    const call = renderCall("bash", { command: "git log --oneline -15 --all --decorate --graph --stat" }, theme, context) as any;
    const lines = call.render(22).map(strip);
    const commandRows = lines.filter((l) => l.startsWith("│"));
    expect(commandRows.length).toBeGreaterThan(1);
    for (const row of commandRows) expect(row).not.toContain("…");
    // content is lossless across the wrapped rows (only frame glyphs/padding stripped)
    expect(commandRows.join("").replace(/[│ ]/g, "")).toContain("--decorate");
  });

  test("clipped output shows the earlier-lines indicator inside the frame", () => {
    const body = Array.from({ length: 24 }, (_, i) => `line ${i + 1}`).join("\n");
    const context = slotContext();
    const result = renderResult("bash", { content: [{ type: "text", text: body }], details: undefined }, { isPartial: false, expanded: false }, theme, context) as any;
    // wide enough that the indicator fits on one row: only indicator + 3 tail rows
    const interior = result.render(80).map(strip).filter((l) => l.startsWith("│"));
    expect(interior[0]).toContain("earlier lines");
    expect(interior[0]).toContain("showing 3 of 24");
    expect(interior[0]).toContain("ctrl+o");
    // the tail (3 collapsed-budget rows) follows the indicator
    expect(interior.length).toBe(4);
    expect(interior[1]).toContain("line 22");
    expect(interior[3]).toContain("line 24");
  });

  test("empty result with no footer renders just the closing bottom bar", () => {
    const context = slotContext();
    const result = renderResult("bash", { content: [], details: undefined }, { isPartial: false, expanded: false }, theme, context) as any;
    const lines = result.render(30).map(strip);
    expect(lines.length).toBe(1);
    expect(lines[0].startsWith("└")).toBe(true);
    expect(lines[0].endsWith("┘")).toBe(true);
  });

  test("whole box takes the state fg wash, not just border strokes", () => {
    const lines = renderOutputBlock({ state: "success", sections: [{ lines: ["plain body"] }], width: 20 }, theme, frameDeps);
    for (const line of lines) {
      expect(line.includes("[FG]")).toBe(true);
      expect(line.includes("\x1b[39m")).toBe(true);
      expect(line.endsWith("\x1b[49m")).toBe(true);
    }
  });

  test("no state means no fg wash", () => {
    const lines = renderOutputBlock({ sections: [{ lines: ["body"] }], width: 20 }, theme, frameDeps);
    for (const line of lines) expect(line).not.toContain("[FG]");
  });

  test("first result defers invalidate past the render pass (no sync re-entry)", async () => {
    let calls = 0;
    const context = slotContext({ invalidate: () => { calls++; } });
    renderCall("ls", {}, theme, context) as any;
    renderResult("ls", { content: [{ type: "text", text: "README.md" }], details: undefined }, { isPartial: false, expanded: false }, theme, context) as any;
    // A synchronous invalidate would re-enter updateDisplay() before this
    // result component is added to the row container; assert it is deferred.
    expect(calls).toBe(0);
    await Promise.resolve();
    expect(calls).toBe(1);
  });
});
