// Vendored from can1357/oh-my-pi (MIT) commit 403931b9, packages/coding-agent/src/tui/tree-list.ts.
// Trims: trailingSummary/caller-driven collapse, maxCollapsedLines budget, TreeContext depth.
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RenderDeps } from "./skin";

/** Options consumed by {@link renderTreeList}. The caller maps tool result
 * lines to items and decides how each renders (badge, directory marker). */
export type TreeListOptions<T> = {
  items: T[];
  expanded?: boolean;
  maxCollapsed?: number;
  itemType?: string;
  renderItem: (item: T) => string | string[];
};

// Local box-drawing constants replace the upstream theme.tree.* tokens; the
// continue-prefix lines are kept for multi-line items (unused by find/ls).
const branch = "├──";
const last = "└──";
const continuePrefix = "│  ";
const lastContinuePrefix = "   ";

/** Tabs render as two spaces so indentation never breaks the frame's wrap
 * pass (upstream replaces tabs with a fixed display width too). */
const replaceTabs = (text: string): string => text.replaceAll("\t", "  ");

/** `… N more <itemType>` summary text, pluralized for the item type
 * (file → files, entry → entries). */
function formatMoreItems(remaining: number, itemType: string): string {
  const safe = Number.isFinite(remaining) ? remaining : 0;
  const plural = itemType.endsWith("y") ? `${itemType.slice(0, -1)}ies` : `${itemType}s`;
  return `… ${safe} more ${plural}`;
}

/** Flatten a tool's result lines into a compact flat tree: each item gets a
 * `├──` branch except the last visible row, which uses `└──` — either the true
 * last item or the clipped summary (`└── … N more files`) when collapsed and
 * there are more lines than `maxCollapsed`. The upstream trailingSummary
 * caller-driven collapse, the `maxCollapsedLines` budget, and the
 * TreeContext depth parameter are all trimmed away. */
export function renderTreeList<T>(options: TreeListOptions<T>, theme: Theme, _deps: RenderDeps): string[] {
  const { items, expanded = false, maxCollapsed = 8, itemType = "item", renderItem } = options;
  const visibleCount = expanded ? items.length : Math.min(items.length, maxCollapsed);
  const remaining = items.length - visibleCount;
  const hasSummary = !expanded && remaining > 0;
  const lines: string[] = [];
  for (let i = 0; i < visibleCount; i++) {
    const isLast = i === visibleCount - 1 && !hasSummary;
    const rendered = renderItem(items[i]!);
    const itemLines = Array.isArray(rendered) ? rendered : rendered ? [rendered] : [];
    if (itemLines.length === 0) continue;
    lines.push(`${theme.fg("dim", isLast ? last : branch)} ${replaceTabs(itemLines[0]!)}`);
    for (let j = 1; j < itemLines.length; j++) {
      lines.push(`${theme.fg("dim", isLast ? lastContinuePrefix : continuePrefix)}${replaceTabs(itemLines[j]!)}`);
    }
  }
  if (hasSummary) {
    lines.push(`${theme.fg("dim", last)} ${theme.fg("muted", formatMoreItems(remaining, itemType))}`);
  }
  return lines;
}
