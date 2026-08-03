import type { RenderDeps } from "./skin";

export type ToolSpec = {
  label: string;
  /** Prefix rendered ahead of the primary argument in the interior call line.
   * Defaults to the label, so bash becomes `$ <command>` and the other
   * builtins become `<label> <primary>`. */
  prefix?: string;
  primary: (args: any, deps: RenderDeps) => string;
  extras: (args: any, deps: RenderDeps) => Array<[string, string]>;
  /** Render the call and result inline as plain text (no output-block frame,
   * no `Output` tee, no bracketed footer) instead of inside a bordered box. */
  inline?: boolean;
};

/** Collapse embedded whitespace so a multi-line argument can never split the
 * bordered call row; the frame's wrap pass handles long lines (it is never
 * truncated to a single row). */
const normalize = (value: unknown): string =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

export const SPECS: Record<string, ToolSpec> = {
  bash: { label: "bash", prefix: "$", primary: (a) => normalize(a?.command), extras: (a) => (a?.timeout ? [["timeout", String(a.timeout)]] : []) },
  write: { label: "write", primary: (a) => normalize(a?.path ?? a?.file_path), extras: (a) => (a?.content === undefined ? [] : [["bytes", String(String(a.content).length)]]) },
  grep: { label: "grep", primary: (a) => normalize(a?.pattern), extras: (a) => (a?.path ? [["path", String(a.path)]] : []) },
  find: { label: "find", inline: true, primary: (a) => normalize(a?.pattern), extras: (a) => (a?.path ? [["path", String(a.path)]] : []) },
  ls: { label: "ls", inline: true, primary: (a) => normalize(a?.path ?? "."), extras: (a) => (a?.depth !== undefined ? [["depth", String(a.depth)]] : []) },
};

export const LINE_BUDGETS: Record<string, { collapsed: number; expanded: number }> = {
  bash: { collapsed: 3, expanded: 10 },
  write: { collapsed: 1, expanded: 1 },
  grep: { collapsed: 3, expanded: 12 },
  find: { collapsed: 3, expanded: 12 },
  ls: { collapsed: 3, expanded: 12 },
};

/** Short badges for common file extensions shown dim ahead of tree file rows;
 * any unmapped extension renders with no badge. yaml normalizes to `yml`. */
export const EXT_BADGES: Record<string, string> = {
  ts: "ts",
  tsx: "ts",
  js: "js",
  rs: "rs",
  nix: "nix",
  md: "md",
  json: "json",
  toml: "toml",
  yaml: "yml",
  py: "py",
  go: "go",
  sh: "sh",
  lock: "lock",
  c: "c",
  h: "h",
  cpp: "cpp",
};

export type TreeSpec = {
  /** Label used by the clipped summary row, e.g. "file" → `… 2 more files`. */
  itemType: string;
  /** Classify a result line as a directory. Both tools mark directories with a
   * trailing '/', which tree rows keep and turn into a `[D]` badge. */
  isDir: (line: string) => boolean;
};

/** Which builtins render their result body as an oh-my-pi-style flat tree and
 * how to interpret each line. find globs files; ls lists directory entries. */
export const TREE_SPECS: Record<string, TreeSpec> = {
  find: { itemType: "file", isDir: (line) => line.endsWith("/") },
  ls: { itemType: "entry", isDir: (line) => line.endsWith("/") },
};
