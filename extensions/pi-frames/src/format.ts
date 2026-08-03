import type { Theme } from "@earendil-works/pi-coding-agent";
import { SPECS, LINE_BUDGETS, EXT_BADGES, TREE_SPECS } from "./specs";
import type { RenderDeps } from "./skin";
import { renderTreeList } from "./tree";

/** Interior call row built from the SPECS data tables: prefix (`$` for bash,
 * the label otherwise) + primary, with extras appended as dim `key=value`. The
 * frame's wrap pass turns long commands into multiple `│` rows. */
export function callHeaderLine(name: string, args: any, theme: Theme, deps: RenderDeps): string {
  const spec = SPECS[name];
  if (!spec) return theme.fg("toolTitle", theme.bold(name));
  const prefix = spec.prefix ?? spec.label;
  const base = theme.fg("toolTitle", theme.bold(`${prefix} ${spec.primary(args, deps)}`));
  const extras = spec.extras(args, deps).map(([k, v]) => `${k}=${v}`);
  return extras.length > 0 ? `${base} ${theme.fg("dim", extras.join(" "))}` : base;
}

/** Tail view of a tool body within its LINE_BUDGETS. Returns the last `max`
 * lines, prefixed (dim) by an earlier-lines indicator when anything is
 * clipped — tail, not head, matching oh-my-pi's rendered rows. */
export function tailBody(name: string, body: string, expanded: boolean, theme: Theme, deps: RenderDeps): string[] {
  const lines = body ? body.split("\n") : [];
  if (!lines.length) return [];
  const budget = LINE_BUDGETS[name] ?? { collapsed: 3, expanded: 12 };
  const max = expanded ? budget.expanded : budget.collapsed;
  if (lines.length <= max) return lines;
  const dropped = lines.length - max;
  const clipped = `… (${dropped} earlier lines, showing ${max} of ${lines.length}) (${deps.keyHint("app.tools.expand", "to expand")})`;
  return [theme.fg("dim", clipped), ...lines.slice(-max)];
}

/** Non-path lines upstream puts into tool result content — the whole-body
 * no-result messages (no matches / empty directory) and the truncated/limit
 * notice block (`[N results limit…]`) both tools append after a blank line —
 * that must pass through outside the tree instead of rendering as items. */
const NO_RESULT_MESSAGES = new Set(["No files found matching pattern", "(empty directory)"]);

function parseTreeContent(body: string): { items: string[]; extras: string[] } {
  const items: string[] = [];
  const extras: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\[[^\]]*\]$/.test(line) || NO_RESULT_MESSAGES.has(line)) extras.push(line);
    else items.push(line);
  }
  return { items, extras };
}

/** Short badge for a path's extension from EXT_BADGES, or undefined when the
 * extension is unmapped, the basename has no extension, or it is a dotfile
 * (hidden files render without a badge). */
export function badgeForPath(path: string): string | undefined {
  const base = path.endsWith("/") ? path.slice(0, -1) : path;
  const name = base.slice(base.lastIndexOf("/") + 1);
  if (name.startsWith(".")) return undefined;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return EXT_BADGES[name.slice(dot + 1).toLowerCase()];
}

/** Tree-body rows for tools with a TREE_SPECS entry (find, ls): result lines
 * become tree items — `[D]` badge (accent) + muted path for directories, a dim
 * extension badge + path for files — and upstream's non-path lines pass through
 * outside the tree. maxCollapsed comes from the LINE_BUDGETS collapsed value;
 * expanded shows every item. */
function treeBody(name: string, body: string, expanded: boolean, theme: Theme, deps: RenderDeps): string[] {
  const spec = TREE_SPECS[name]!;
  const budget = LINE_BUDGETS[name] ?? { collapsed: 3, expanded: 12 };
  const { items, extras } = parseTreeContent(body);
  const rows = renderTreeList(
    {
      items,
      expanded,
      maxCollapsed: expanded ? budget.expanded : budget.collapsed,
      itemType: spec.itemType,
      renderItem: (line) => {
        if (spec.isDir(line)) return `${theme.fg("accent", "[D]")} ${theme.fg("muted", line)}`;
        const badge = badgeForPath(line);
        return badge ? `${theme.fg("dim", badge)} ${line}` : line;
      },
    },
    theme,
    deps,
  );
  return [...rows, ...extras];
}

/** Bracketed footer line built from available status data, or undefined when
 * there is none. Upstream tool details carry truncation and hit-limit info but
 * no exit code or duration, so the line renders a ✓/✗ glyph plus whatever
 * exists (truncation summary, hit limits, tracked elapsed time) and is omitted
 * entirely when nothing is available. */
export function resultFooter(
  result: any,
  isError: boolean,
  state: { startedAt?: number; endedAt?: number } | undefined,
  theme: Theme,
): string | undefined {
  const details = result?.details ?? {};
  const info: string[] = [];
  const truncation = details.truncation;
  if (truncation?.truncated && truncation.outputLines !== undefined && truncation.totalLines !== undefined && truncation.outputLines !== truncation.totalLines) {
    info.push(`showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
  }
  if (details.matchLimitReached) info.push(`${details.matchLimitReached} matches limit`);
  if (details.resultLimitReached) info.push(`${details.resultLimitReached} results limit`);
  if (details.entryLimitReached) info.push(`${details.entryLimitReached} entries limit`);
  if (typeof state?.startedAt === "number") {
    const ended = typeof state.endedAt === "number" ? state.endedAt : Date.now();
    info.push(`${((ended - state.startedAt) / 1000).toFixed(1)}s`);
  }
  if (info.length === 0) return undefined;
  const glyph = isError ? "✗" : "✓";
  return theme.fg(isError ? "error" : "success", `[${glyph} ${info.join(" · ")}]`);
}

/** Rows for the result slot's Output section: tail-clipped body lines (error
 * results stay unwrapped/full) plus the bracketed footer when one is
 * available. Empty row list means the result slot renders just the bottom bar.
 * Inline tools (find/ls) pass `includeFooter: false` so their bare tree rows
 * carry no bracketed footer. */
export function resultLines(
  name: string,
  result: any,
  expanded: boolean,
  isError: boolean,
  state: { startedAt?: number; endedAt?: number } | undefined,
  theme: Theme,
  deps: RenderDeps,
  includeFooter: boolean = true,
): string[] {
  const body = (result?.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text ?? "").join("\n");
  const lines = isError ? (body ? body.split("\n") : []) : TREE_SPECS[name] ? treeBody(name, body, expanded, theme, deps) : tailBody(name, body, expanded, theme, deps);
  if (includeFooter && (isError || lines.length > 0)) {
    const footer = resultFooter(result, isError, state, theme);
    if (footer) lines.push(footer);
  }
  return lines;
}
