import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RenderDeps } from "./skin";

export type ToolSpec = {
	label: string;
	/** Prefix rendered ahead of the primary argument in the interior call line.
	 * Defaults to the label, so bash becomes `$ <command>` and the other
	 * builtins become `<label> <primary>`. */
	prefix?: string;
	primary: (args: any, deps: RenderDeps, theme: Theme) => string;
	extras: (args: any, deps: RenderDeps) => Array<[string, string]>;
};

/** Collapse embedded whitespace so a multi-line argument can never split the
 * call row. */
const normalize = (value: unknown): string =>
	String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();

/** Preview colors: the bash command takes the shell-cell color (bashMode,
 * matching prime-agent's bash cells), paths and patterns take the accent
 * teal. Extras (timeout=/bytes=/path=/depth=) stay dim in callHeaderLine.
 * The plain-bold white look of pi's own bash renderer is deliberately NOT
 * reproduced — the whole point of this extension is prime's color. */
export const SPECS: Record<string, ToolSpec> = {
	bash: {
		label: "bash",
		prefix: "$",
		primary: (a, _deps, theme) => {
			const command = normalize(a?.command);
			return command ? theme.fg("bashMode", command) : theme.fg("toolOutput", "...");
		},
		extras: (a) => (a?.timeout ? [["timeout", String(a.timeout)]] : []),
	},
	write: {
		label: "write",
		primary: (a, _deps, theme) => theme.fg("accent", normalize(a?.path ?? a?.file_path) || "…"),
		extras: (a) => (a?.content === undefined ? [] : [["bytes", String(String(a.content).length)]]),
	},
	grep: {
		label: "grep",
		primary: (a, _deps, theme) => theme.fg("accent", normalize(a?.pattern) || "…"),
		extras: (a) => (a?.path ? [["path", String(a.path)]] : []),
	},
	find: {
		label: "find",
		primary: (a, _deps, theme) => theme.fg("accent", normalize(a?.pattern) || "…"),
		extras: (a) => (a?.path ? [["path", String(a.path)]] : []),
	},
	ls: {
		label: "ls",
		primary: (a, _deps, theme) => theme.fg("accent", normalize(a?.path ?? ".")),
		extras: (a) => (a?.depth !== undefined ? [["depth", String(a.depth)]] : []),
	},
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