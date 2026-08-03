// Vendored from can1357/oh-my-pi (MIT) commit 403931b9, packages/coding-agent/src/tui/status-line.ts.
// Trims: upstream status icons are replaced with local ASCII pending/success/error glyphs that
// mirror oh-my-pi's ASCII symbol preset (`status.pending` `[*]`, `status.success` `[ok]`,
// `status.error` `[!!]`), and theme.format bracket tokens are replaced with plain "[" / "]"
// (upstream pi-tui lacks them).
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { FrameState } from "../../shared/frame";

export type StatusLineOptions = {
  icon?: FrameState;
  /** Pre-rendered glyph that replaces the status icon; takes precedence over `icon`. */
  iconOverride?: string;
  title: string;
  titleColor?: string;
  description?: string;
  badge?: { label: string; color: string };
  meta?: string[];
};

/** Flatten CR/LF runs in caller-supplied header fragments so a single newline
 * embedded in `description` or `meta` cannot expand the status line into
 * multiple rows — which would otherwise break the bordered output block the
 * header sits on. */
function flattenForHeader(text: string): string {
  return text.replace(/\r\n?|\n/g, " ");
}

/** ASCII status glyph for a frame state, mirroring oh-my-pi's ASCII symbol
 * preset (`status.pending` `[*]`, `status.success` `[ok]`, `status.error`
 * `[!!]`). Exported so the inline call line can prefix its state icon. */
export function formatStatusIcon(status: FrameState, theme: Theme): string {
  switch (status) {
    case "pending":
      return theme.fg("muted", "[*]");
    case "success":
      return theme.fg("success", "[ok]");
    case "error":
      return theme.fg("error", "[!!]");
  }
}

export function renderStatusLine(options: StatusLineOptions, theme: Theme): string {
  const icon = options.iconOverride ?? (options.icon ? formatStatusIcon(options.icon, theme) : "");
  const titleColor = options.titleColor ?? "accent";
  const title = theme.fg(titleColor, flattenForHeader(options.title));
  let line = icon ? `${icon} ${title}` : title;

  if (options.description) {
    line += `: ${theme.fg("muted", flattenForHeader(options.description))}`;
  }

  if (options.badge) {
    const { label, color } = options.badge;
    line += ` ${theme.fg(color, `[${flattenForHeader(label)}]`)}`;
  }

  const meta = options.meta?.map(flattenForHeader).filter((value) => value.trim().length > 0) ?? [];
  if (meta.length > 0) {
    line += ` ${theme.fg("dim", meta.join(" · "))}`;
  }

  return line;
}
