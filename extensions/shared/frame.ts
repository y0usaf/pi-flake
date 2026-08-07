// Vendored from can1357/oh-my-pi (MIT) commit 403931b9, packages/coding-agent/src/tui/output-block.ts.
// Trims: sixel, render cache, TERMINAL.
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { resolveSymbols } from "./symbols";

export type FrameState = "pending" | "success" | "error";

export type OutputBlockOptions = {
  header?: string;
  headerMeta?: string;
  state?: FrameState;
  sections?: Array<{ label?: string; lines: readonly string[]; separator?: boolean }>;
  width: number;
  applyBg?: boolean;
  contentPaddingLeft?: number;
  contentPaddingRight?: number;
  borderColor?: string;
  /** Draw the labeled top bar. renderResult suppresses it once a call frame
   * already owns the top so the row pair does not double-top the box. When
   * false the content rows start immediately and header/headerMeta are
   * ignored. */
  topBar?: boolean;
  /** Draw the closing bottom bar. renderCall suppresses it once a result frame
   * owns the closure so the row pair does not double-close the box. */
  bottomBar?: boolean;
  /** Trim trailing whitespace from each content line before wrapping. Default
   * true. Read passes false so its LINEID|content lines keep the raw trailing
   * whitespace — trimming would silently diverge the displayed line from the
   * hashed content. */
  trimEndContent?: boolean;
  /** nvim breakindent/showbreak-style continuation rows: when a line wraps,
   * later chunks get a marker glyph in the last hash cell and keep the
   * separator pipe, so wrapped chunks read as continuations of their anchored
   * line. sepIndexFor returns the index of the line's `|` separator, or -1
   * for lines that carry no anchor (rendered without the marker). */
  wrapContinuation?: { marker: string; sepIndexFor: (line: string) => number };
};

export type FrameDeps = {
  visibleWidth: (s: string) => number;
  truncateToWidth: (s: string, width: number) => string;
  wrapTextWithAnsi: (s: string, width: number) => string[];
};

// Box/separator glyphs come from the resolved symbol preset (unicode default,
// ascii opt-in, per-key overrides). The wrapContinuation marker and hashline
// `|` separator stay literal ASCII below — that pipe is the hashline anchor.

// Upstream runs five states (pending/running/success/error/warning); the PI
// tool slots only expose pending/success/error.
const STATE_BORDER: Record<FrameState, string> = {
  error: "error",
  pending: "accent",
  success: "dim",
};

const STATE_BG: Record<FrameState, string> = {
  pending: "toolPendingBg",
  success: "toolSuccessBg",
  error: "toolErrorBg",
};

type BlockRow =
  | { kind: "bar"; leftChar: string; rightChar: string; label?: string; meta?: string }
  | { kind: "bottom"; leftChar: string; rightChar: string }
  | { kind: "content"; inner: string };

function normalizeContentPaddingLeft(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.max(0, Math.floor(value));
}

function normalizeContentPaddingRight(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/** Inner content width renderOutputBlock wraps body lines to, for a given
 * outer `width`: both vertical borders (1 cell each) plus the content
 * paddings. Renderers that size a tail window MUST budget visual rows against
 * this, not the outer width. */
export function outputBlockContentWidth(width: number, contentPaddingLeft?: number, contentPaddingRight?: number): number {
  return Math.max(1, width - 2 - normalizeContentPaddingLeft(contentPaddingLeft) - normalizeContentPaddingRight(contentPaddingRight));
}

export function renderOutputBlock(options: OutputBlockOptions, theme: Theme, deps: FrameDeps): string[] {
  const { header, headerMeta, state, sections = [], width, applyBg = true, topBar = true, bottomBar = true } = options;
  const S = resolveSymbols();
  const topLeft = S["box.tl"];
  const topRight = S["box.tr"];
  const bottomLeft = S["box.bl"];
  const bottomRight = S["box.br"];
  const vertical = S["box.v"];
  const horizontal = S["box.h"];
  const teeRight = S["box.teeR"];
  const teeLeft = S["box.teeL"];
  const sep = S["sep.dot"];
  const cap = horizontal.repeat(3);
  const lineWidth = Math.max(0, width);
  // The state color now washes the whole box, not just the border strokes:
  // pending uses accent, success uses dim (gray), error keeps its color; an
  // explicit borderColor always wins on the border glyphs.
  const borderColor = options.borderColor ?? (state ? STATE_BORDER[state] : "dim");
  const border = (text: string): string => theme.fg(borderColor, text);
  const bgFn = (() => {
    if (!state || !applyBg) return undefined;
    const bgAnsi = theme.getBgAnsi(STATE_BG[state]);
    // Keep block background stable even if inner content contains SGR resets
    // (e.g. "\x1b[0m"), which would otherwise clear the outer background
    // mid-line.
    return (text: string): string => {
      const stabilized = text
        .replace(/\x1b\[(?:0)?m/g, (m) => `${m}${bgAnsi}`)
        .replace(/\x1b\[49m/g, (m) => `${m}${bgAnsi}`);
      return `${bgAnsi}${stabilized}\x1b[49m`;
    };
  })();
  const fgFn = (() => {
    const fgColor = state ? STATE_BORDER[state] : undefined;
    if (!fgColor) return undefined;
    const fgAnsi = theme.getFgAnsi(fgColor);
    return (text: string): string => {
      const stabilized = text
        .replace(/\x1b\[(?:0)?m/g, (m) => `${m}${fgAnsi}`)
        .replace(/\x1b\[39m/g, (m) => `${m}${fgAnsi}`);
      return `${fgAnsi}${stabilized}\x1b[39m`;
    };
  })();

  const contentPaddingLeft = normalizeContentPaddingLeft(options.contentPaddingLeft);
  const contentPaddingRight = normalizeContentPaddingRight(options.contentPaddingRight);
  const contentWidth = Math.max(0, lineWidth - vertical.length - contentPaddingLeft - vertical.length - contentPaddingRight);
  const contentLeftPadding = contentPaddingLeft > 0 ? " ".repeat(contentPaddingLeft) : "";
  const contentRightPadding = contentPaddingRight > 0 ? " ".repeat(contentPaddingRight) : "";

  // Layout pass: collect row descriptors before emitting the bordered lines.
  const rows: BlockRow[] = [];
  if (topBar) rows.push({ kind: "bar", leftChar: topLeft, rightChar: topRight, label: header, meta: headerMeta });

  const normalizedSections = sections.length > 0 ? sections : [{ lines: [] as string[] }];
  for (let sectionIndex = 0; sectionIndex < normalizedSections.length; sectionIndex++) {
    const section = normalizedSections[sectionIndex]!;
    // A labeled section always draws its titled separator bar. A label-less
    // section can still request a plain divider via `separator`, but only
    // between sections — leading with one would just double the header bar.
    if (section.label) {
      rows.push({ kind: "bar", leftChar: teeRight, rightChar: teeLeft, label: section.label });
    } else if (section.separator && sectionIndex > 0) {
      rows.push({ kind: "bar", leftChar: teeRight, rightChar: teeLeft });
    }
    const allLines = section.lines.flatMap((l) => l.split("\n"));
    for (const line of allLines) {
      // Default: trim trailing whitespace before wrapping (rendering nicety).
      // Read passes trimEndContent:false so its LINEID|content lines keep raw
      // trailing whitespace — trimming would silently diverge the displayed
      // line from the hashed content.
      const contentLine = options.trimEndContent === false ? line : line.trimEnd();
      const wrappedLines = deps.wrapTextWithAnsi(contentLine, contentWidth);
      // nvim breakindent-style continuation: when an anchored line wraps, chunk
      // 0 keeps the anchor and the later chunks are re-joined (lossless — the
      // trimEndContent:false test shows trailing spaces survive chunk
      // boundaries, so join("") reconstructs the source text) and re-wrapped
      // at the width left over after the marker + separator pipe claim their
      // columns. Lines without an anchor (sep -1) keep plain wrapping.
      const wrapContinuation = options.wrapContinuation;
      const sep = wrapContinuation ? wrapContinuation.sepIndexFor(line) : -1;
      const pushContentRow = (inner: string): void => {
        // The per-row right padding keeps every row flush to the box edge; the
        // continuation marker prefix is part of `inner`, so the total visible
        // width stays contentWidth.
        const innerPadding = " ".repeat(Math.max(0, contentWidth - deps.visibleWidth(inner)));
        rows.push({ kind: "content", inner: `${inner}${innerPadding}` });
      };
      if (!wrapContinuation || sep < 0 || wrappedLines.length <= 1) {
        for (const wrappedLine of wrappedLines) pushContentRow(wrappedLine);
        continue;
      }
      pushContentRow(wrappedLines[0]);
      const continuationWidth = Math.max(1, contentWidth - (sep + 1));
      const joinedRemainder = wrappedLines.slice(1).join("");
      for (const chunk of deps.wrapTextWithAnsi(joinedRemainder, continuationWidth)) {
        // The marker sits in the final hash cell; the separator pipe after it
        // stays plain (it mirrors the raw hashline separator, which is
        // unstyled content).
        const inner = `${" ".repeat(Math.max(0, sep - 1))}${theme.fg("dim", wrapContinuation.marker)}|${chunk}`;
        pushContentRow(inner);
      }
    }
  }

  if (bottomBar) rows.push({ kind: "bottom", leftChar: bottomLeft, rightChar: bottomRight });

  const renderBar = (row: { leftChar: string; rightChar: string; label?: string; meta?: string }): string => {
    const leftGlyphs = `${row.leftChar}${cap}`;
    const rightGlyph = row.rightChar;
    if (lineWidth <= 0) return border(leftGlyphs) + border(rightGlyph);
    const labelText = [row.label, row.meta].filter(Boolean).join(sep);
    if (!labelText) {
      // No header: draw a clean, continuous top/separator bar (no 1-col gap).
      const fillCount = Math.max(0, lineWidth - deps.visibleWidth(leftGlyphs) - deps.visibleWidth(rightGlyph));
      return `${border(leftGlyphs)}${border(horizontal.repeat(fillCount))}${border(rightGlyph)}`;
    }
    const rawLabel = ` ${labelText} `;
    const leftWidth = deps.visibleWidth(leftGlyphs);
    const rightWidth = deps.visibleWidth(rightGlyph);
    const maxLabelWidth = Math.max(0, lineWidth - leftWidth - rightWidth);
    const trimmedLabel = deps.truncateToWidth(rawLabel, maxLabelWidth);
    const labelWidth = deps.visibleWidth(trimmedLabel);
    const fillCount = Math.max(0, lineWidth - leftWidth - labelWidth - rightWidth);
    return `${border(leftGlyphs)}${trimmedLabel}${border(horizontal.repeat(fillCount))}${border(rightGlyph)}`;
  };

  const renderBottom = (row: { leftChar: string; rightChar: string }): string => {
    const leftGlyphs = `${row.leftChar}${cap}`;
    const rightGlyph = row.rightChar;
    const fillCount = Math.max(0, lineWidth - deps.visibleWidth(leftGlyphs) - deps.visibleWidth(rightGlyph));
    return `${border(leftGlyphs)}${border(horizontal.repeat(fillCount))}${border(rightGlyph)}`;
  };

  const renderContent = (inner: string): string =>
    `${border(vertical)}${contentLeftPadding}${inner}${contentRightPadding}${border(vertical)}`;

  const padLine = (line: string): string => {
    // Whole-box state wash: fg under the bg (bg outermost). The state color
    // covers borders and unstyled interior text; explicitly styled text
    // (badges, footer glyphs) keeps its colors. Both layers re-inject after
    // interior SGR resets, like bg alone did before.
    const washed = fgFn ? fgFn(line) : line;
    const colored = bgFn ? bgFn(washed) : washed;
    const padCount = Math.max(0, lineWidth - deps.visibleWidth(colored));
    return padCount > 0 ? colored + " ".repeat(padCount) : colored;
  };

  const lines: string[] = [];
  for (const row of rows) {
    const line =
      row.kind === "bar" ? renderBar(row) : row.kind === "bottom" ? renderBottom(row) : renderContent(row.inner);
    lines.push(padLine(line));
  }
  return lines;
}

/** Build a self-framing tool component backed by renderOutputBlock. The
 * `build` callback returns the block options for a given width. A plain
 * `{ render, invalidate }` object suffices — the upstream framed-block symbol
 * marking has no counterpart in the PI tool-execution container. */
export function frameComponent(build: (width: number) => OutputBlockOptions, theme: Theme, deps: FrameDeps): Component {
  return {
    render: (width: number): string[] => renderOutputBlock(build(width), theme, deps),
    invalidate: () => {},
  };
}