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
    const contentRows = lines.filter((l) => l.startsWith("|"));
    expect(contentRows.length).toBe(2);
    // the first wrapped chunk still carries its trailing space (nothing padded
    // over it)
    expect(contentRows[0]).toBe("| ab |");
  });

  test("default trimEndContent true trims before wrapping", () => {
    // Same boundary width: the default trims "ab  " → "ab", which fits on one
    // row, so existing callers keep their current behavior.
    const lines = renderOutputBlock(
      { state: "success", sections: [{ label: "Output", lines: ["ab  "] }], width: 6, topBar: false },
      theme,
      frameDeps,
    ).map(strip);
    const contentRows = lines.filter((l) => l.startsWith("|"));
    expect(contentRows.length).toBe(1);
    expect(contentRows[0]).toBe("| ab |");
  });
});
