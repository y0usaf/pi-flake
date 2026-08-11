import { describe, expect, test } from "bun:test";
import { renderOutputBlock } from "../../shared/frame";

// Frame.ts only type-imports pi packages (erased at runtime), so the pure
// renderer can be exercised with zero node_modules here, mirroring the pi-frames
// test theme/deps mocks. read-tool.ts's renderResult is not separately exported
// (it lives inside registerTool's registration object), so the collapsed
// non-error "returns empty" behavior is not unit-tested here — exporting it
// would over-engineer the tool shell for a one-assertion gain.
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\[BG\]/g, "").replace(/\[FG\]/g, "");

const theme: any = {
  fg: (_token: string, s: string) => s,
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

const frameDeps = {
  visibleWidth: (s: string) => strip(s).length,
  truncateToWidth,
  wrapTextWithAnsi,
};

describe("shared frame renderer (hashline read)", () => {
  test("trimEndContent false preserves trailing whitespace before wrapping", () => {
    // contentWidth 3: the raw "ab  " wraps to two rows, where a trimmed "ab"
    // would fit one. Row count is the observable signal that the trailing
    // whitespace survived the wrap pass (hashline lines are exact copy targets;
    // trimming would silently diverge the displayed line from the hashed
    // content).
    const lines = renderOutputBlock(
      { state: "success", sections: [{ label: "Output", lines: ["ab  "] }], width: 6, topBar: false, trimEndContent: false },
      theme,
      frameDeps,
    ).map(strip);
    const contentRows = lines.filter((l) => l.startsWith("│"));
    expect(contentRows.length).toBe(2);
    // the first wrapped chunk still carries its trailing space (nothing padded
    // over it)
    expect(contentRows[0]).toBe("│ ab │");
  });

  test("default trimEndContent true trims before wrapping", () => {
    // Same boundary width: the default trims "ab  " → "ab", which fits on one
    // row, so existing callers keep their current behavior.
    const lines = renderOutputBlock(
      { state: "success", sections: [{ label: "Output", lines: ["ab  "] }], width: 6, topBar: false },
      theme,
      frameDeps,
    ).map(strip);
    const contentRows = lines.filter((l) => l.startsWith("│"));
    expect(contentRows.length).toBe(1);
    expect(contentRows[0]).toBe("│ ab │");
  });

  const wrapContinuation = { marker: ">", sepIndexFor: (line: string) => line.indexOf("|") };
  // Every rendered row must sit flush in the box: after stripping the fake
  // fg/bg markers (zero-width in the mock), each line is exactly `width`
  // visible cells, right border included. Overshoot from a continuation
  // prefix that exceeds the content width would surface here.
  const expectFlush = (lines: string[], width: number): void => {
    for (const line of lines) expect(strip(line).length).toBe(width);
  };

  test("wrapContinuation marks wrapped chunks of a two-digit-anchor line", () => {
    // contentWidth 12 (width 15 - 2 borders - 1 left pad): "10aphw|    {code}"
    // wraps to "10aphw|    {" + "code}". The anchored row keeps the line as-is;
    // the continuation row keeps the anchor column (1 pad + 5 blank cells),
    // puts the dim `>` in the final hash cell (6 hash chars in "10aphw") and
    // keeps the separator pipe.
    const lines = renderOutputBlock(
      {
        state: "success",
        sections: [{ label: "Output", lines: ["10aphw|    {code}"] }],
        width: 15,
        topBar: false,
        trimEndContent: false,
        wrapContinuation,
      },
      theme,
      frameDeps,
    ).map(strip);
    const contentRows = lines.filter((l) => l.startsWith("│"));
    expect(contentRows[0]).toBe("│ 10aphw|    {│");
    expect(contentRows[1]).toBe("│      >|code}│");
    expect(contentRows[1].startsWith("│      >|")).toBe(true);
    expectFlush(lines, 15);
  });

  test("wrapContinuation marks wrapped chunks of a single-digit-anchor line", () => {
    // Same shape for a 5-char anchor: 1 pad + 4 blank cells + `>` + kept `|`.
    const lines = renderOutputBlock(
      {
        state: "success",
        sections: [{ label: "Output", lines: ["9ajgs|    {code}"] }],
        width: 14,
        topBar: false,
        trimEndContent: false,
        wrapContinuation,
      },
      theme,
      frameDeps,
    ).map(strip);
    const contentRows = lines.filter((l) => l.startsWith("│"));
    expect(contentRows[0]).toBe("│ 9ajgs|    {│");
    expect(contentRows[1]).toBe("│     >|code}│");
    expect(contentRows[1].startsWith("│     >|")).toBe(true);
    expectFlush(lines, 14);
  });

  test("wrapContinuation leaves lines without an anchor marker-free (sep -1)", () => {
    // The "[Showing lines ...]" trailer has no `|`, so indexOf returns -1 and
    // the wrapped chunks render exactly as before — no marker, no indent.
    const trailer = "[Showing lines 8-14 of 100. Use offset=15 to continue.]";
    const options = {
      state: "success",
      sections: [{ label: "Output", lines: [trailer] }],
      width: 20,
      topBar: false,
      trimEndContent: false,
    };
    const withContinuation = renderOutputBlock({ ...options, wrapContinuation }, theme, frameDeps).map(strip);
    const withoutContinuation = renderOutputBlock(options, theme, frameDeps).map(strip);
    const contentRows = withContinuation.filter((l) => l.startsWith("│"));
    expect(contentRows.every((l) => !l.includes(">"))).toBe(true);
    // current behavior unchanged: identical rows with or without the option
    expect(withContinuation).toEqual(withoutContinuation);
    expect(contentRows[0]).toBe("│ [Showing lines 8-│");
    expectFlush(withContinuation, 20);
  });

  test("wrapContinuation rows stay within the box width (right border flush)", () => {
    // Wrapped anchored rows plus the plain trailer, all in one section: every
    // row — anchored, continuation, marker-free, bars — stays flush.
    const lines = renderOutputBlock(
      {
        state: "success",
        sections: [
          {
            label: "Output",
            lines: ["10aphw|    {code}", "9ajgs|    {code}", "[Showing lines 8-14 of 100. Use offset=15 to continue.]"],
          },
        ],
        width: 15,
        topBar: false,
        trimEndContent: false,
        wrapContinuation,
      },
      theme,
      frameDeps,
    ).map(strip);
    expectFlush(lines, 15);
    const contentRows = lines.filter((l) => l.startsWith("│"));
    // anchored row, its continuation, then the marker-free trailer chunks
    expect(contentRows[0]).toBe("│ 10aphw|    {│");
    expect(contentRows[1]).toBe("│      >|code}│");
    // only the two anchored lines' continuation rows carry the marker; the
    // trailer chunks (no `|`, sep -1) stay marker-free
    expect(contentRows.filter((l) => l.includes(">"))).toEqual(["│      >|code}│", "│     >|ode}  │"]);
    expect(contentRows.slice(4).every((l) => !l.includes(">"))).toBe(true);
  });
});
