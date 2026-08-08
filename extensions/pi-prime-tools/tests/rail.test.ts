import { describe, expect, mock, test } from "bun:test";
import { callHeaderLine } from "../src/format";
import { renderTreeList } from "../src/tree";
import { skinDefinition } from "../src/skin";
import { renderOutputBlock } from "../../shared/frame";

const strip = (s: string): string =>
	s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\[BG\]/g, "").replace(/\[FG\]/g, "");

const theme: any = {
	fg: (_token: string, s: string) => s,
	bg: (_token: string, s: string) => "[BG]" + s,
	bold: (s: string) => s,
	getBgAnsi: () => "[BG]",
	getFgAnsi: () => "[FG]",
};

process.env.PI_SYMBOLS = "ascii";

const truncateToWidth = (s: string, width: number): string => {
	let out = "";
	let length = 0;
	for (const ch of s) {
		if (strip(ch).length === 0) out += ch;
		else if (length < width) {
			out += ch;
			length += 1;
		}
	}
	return out;
};

const wrapTextWithAnsi = (s: string, width: number): string[] => {
	if (width <= 0) return [s];
	const out: string[] = [];
	for (let i = 0; i < s.length; i += width) out.push(s.slice(i, i + width));
	return out.length > 0 ? out : [""];
};

const deps = {
	keyHint: (_id: string, d: string) => "ctrl+o " + d,
	visibleWidth: (s: string) => strip(s).length,
	truncateToWidth,
};

mock.module("@earendil-works/pi-tui", () => ({
	Text: class { render() { return []; } },
	truncateToWidth,
	visibleWidth: deps.visibleWidth,
	wrapTextWithAnsi,
}));
mock.module("@earendil-works/pi-coding-agent", () => ({
	keyHint: deps.keyHint,
}));

const { renderCall, renderResult } = await import("../src/render");

const render = (c: { render: (w: number) => string[] }, w = 30): string[] => c.render(w).map((l) => strip(l).trimEnd());

describe("rail rendering", () => {
	test("call slot: bare corner, indented call line, closed rail when no result", () => {
		const lines = render(
			renderCall("bash", { command: "echo hi" }, theme, {
				isError: false,
				isPartial: true,
				executionStarted: false,
			}),
		);
		expect(lines[0]).toBe("+");
		expect(lines[1]).toContain("|  bash $ echo hi");
		expect(lines[lines.length - 1]).toBe("+");
	});

	test("call slot drops the bottom corner once a result frame owns the closure", () => {
		const lines = render(
			renderCall("bash", { command: "echo hi" }, theme, {
				isError: false,
				isPartial: false,
				executionStarted: true,
				state: { hasResult: true },
				expanded: true,
			}),
		);
		expect(lines[0]).toBe("+");
		expect(lines[lines.length - 1]).not.toBe("+");
	});

	test("result slot: content rows plus closing corner, no top bar", () => {
		const lines = render(
			renderResult(
				"bash",
				{ content: [{ type: "text", text: "out1\nout2" }] },
				{},
				theme,
				{ isError: false, expanded: true, state: {} },
			),
		);
		expect(lines[0]).toContain("|  out1");
		expect(lines[1]).toContain("|  out2");
		expect(lines[lines.length - 1]).toBe("+");
		expect(lines[0]).not.toBe("+");
	});

	test("collapsed non-error result renders nothing", () => {
		const c = renderResult(
			"bash",
			{ content: [{ type: "text", text: "out" }] },
			{},
			theme,
			{ isError: false, expanded: false, state: {} },
		);
		expect(c.render(30)).toEqual([]);
	});

	test("error result renders even collapsed", () => {
		const lines = render(
			renderResult("bash", { content: [{ type: "text", text: "boom" }] }, {}, theme, {
				isError: true,
				expanded: false,
				state: {},
			}),
		);
		expect(lines[0]).toContain("boom");
		expect(lines[lines.length - 1]).toBe("+");
	});

	test("js call line shows the code snippet", () => {
		const lines = render(
			renderCall("js", { code: "if (a) b()" }, theme, {
				isError: false,
				isPartial: true,
				executionStarted: false,
			}),
		);
		expect(lines[1]).toContain("|  js if (a) b()");
	});

	test("find/ls results render as flat tree rows", () => {
		const lines = render(
			renderResult(
				"find",
				{ content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }] },
				{},
				theme,
				{ isError: false, expanded: true, state: {} },
			),
		);
		expect(lines[0]).toContain("|--");
		expect(lines[1]).toContain("'--");
		expect(lines[lines.length - 1]).toBe("+");
	});

	test("renderOutputBlock rail: no horizontal strokes, no right rail", () => {
		const lines = renderOutputBlock(
			{ style: "rail", state: "success", sections: [{ lines: ["a", "b"] }], width: 12, applyBg: false, contentPaddingLeft: 2 },
			theme,
			{ visibleWidth: deps.visibleWidth, truncateToWidth, wrapTextWithAnsi },
		).map((l) => strip(l).trimEnd());
		expect(lines).toEqual(["+", "|  a", "|  b", "+"]);
	});
});

describe("formatting", () => {
	test("call header is $ command for bash, label primary for others, extras dim", () => {
		expect(callHeaderLine("bash", { command: "echo hi", timeout: 2 }, theme, deps)).toContain("$ echo hi");
		expect(callHeaderLine("bash", { command: "echo hi", timeout: 2 }, theme, deps)).toContain("timeout=2");
		expect(callHeaderLine("write", { path: "a.txt", content: "x" }, theme, deps)).toContain("write a.txt");
		expect(callHeaderLine("write", { path: "a.txt", content: "x" }, theme, deps)).toContain("bytes=1");
		expect(callHeaderLine("grep", { pattern: "needle", path: "src" }, theme, deps)).toContain("grep needle");
		expect(callHeaderLine("find", { pattern: "*.ts" }, theme, deps)).toContain("find *.ts");
		expect(callHeaderLine("ls", {}, theme, deps)).toContain("ls .");
		expect(callHeaderLine("js", { code: "await fetch(\"url\")" }, theme, deps)).toContain("js await fetch");
	});

	test("call header colors the preview per tool", () => {
		const tokenTheme: any = { fg: (token: string, s: string) => `[${token}]${s}`, bold: (s: string) => `[bold]${s}` };
		expect(callHeaderLine("bash", { command: "cargo build" }, tokenTheme, deps)).toContain("[bashMode]cargo build");
		expect(callHeaderLine("bash", { command: "cargo build" }, tokenTheme, deps)).toContain("[toolTitle][bold]$");
		expect(callHeaderLine("write", { path: "a.txt" }, tokenTheme, deps)).toContain("[accent]a.txt");
		expect(callHeaderLine("grep", { pattern: "needle" }, tokenTheme, deps)).toContain("[accent]needle");
		expect(callHeaderLine("find", { pattern: "*.ts" }, tokenTheme, deps)).toContain("[accent]*.ts");
		expect(callHeaderLine("ls", { path: "src" }, tokenTheme, deps)).toContain("[accent]src");
		expect(callHeaderLine("bash", { command: "ls", timeout: 5 }, tokenTheme, deps)).toContain("[dim]timeout=5");
		expect(callHeaderLine("js", { code: "let x = 1" }, tokenTheme, deps)).toContain("[muted]let x = 1");
	});

	test("tree rows use ascii branch glyphs under PI_SYMBOLS=ascii", () => {
		const rows = renderTreeList({ items: ["a.ts", "b.ts"], expanded: true, itemType: "file", renderItem: (l) => l }, theme, deps);
		expect(rows.length).toBe(2);
		expect(strip(rows[0])).toContain("|--");
		expect(strip(rows[1])).toContain("'--");
	});
});

describe("skinDefinition", () => {
	test("keeps execute, sets renderShell self + forwards renderers", () => {
		const def: any = { name: "bash", execute: () => "ran" };
		const skinned = skinDefinition(def, (name: string) => "call:" + name, (name: string) => "result:" + name);
		expect(skinned.renderShell).toBe("self");
		expect(skinned.execute).toBe(def.execute);
		const call: any = skinned.renderCall({}, theme, {});
		expect(call).toBe("call:bash");
		const result: any = skinned.renderResult({}, {}, theme, {});
		expect(result).toBe("result:bash");
	});
});
