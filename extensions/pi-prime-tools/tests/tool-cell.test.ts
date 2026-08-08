import { describe, expect, mock, test } from "bun:test";
import { callHeaderLine } from "../src/format";
import { renderTreeList } from "../src/tree";
import { skinDefinition } from "../src/skin";

// Local ANSI-stripping width helper: drop real escape sequences and the fake
// fg/bg markers so width arithmetic treats injected styling as zero-width.
const strip = (s: string): string =>
	s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\[BG\]/g, "").replace(/\[FG\]/g, "");

const theme: any = {
	fg: (_token: string, s: string) => s,
	bg: (_token: string, s: string) => "[BG]" + s,
	bold: (s: string) => s,
	getBgAnsi: () => "[BG]",
	getFgAnsi: () => "[FG]",
};

// format.ts and tool-cell.ts resolve symbols from process.env + ambient
// settings; force unicode so a symbols.preset=ascii setting does not flip the
// glyphs under test (the ascii path is covered by symbols.test.ts).
process.env.PI_SYMBOLS = "unicode";

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

// Zero-node_modules pattern: tool-cell.ts statically imports pi packages, so
// they are mocked and tool-cell.ts is imported dynamically after the mocks
// register (same pattern pi-frames and pi-hashline use).
mock.module("@earendil-works/pi-tui", () => ({
	truncateToWidth,
	visibleWidth: deps.visibleWidth,
	wrapTextWithAnsi,
}));
mock.module("@earendil-works/pi-coding-agent", () => ({
	keyHint: deps.keyHint,
}));

const { ToolCallCellComponent, ToolResultCellComponent, cellMarker, cellState, formatDuration } = await import(
	"../../shared/tool-cell"
);

describe("tool cell state", () => {
	test("maps render context to queued/running/done/error", () => {
		expect(cellState({ executionStarted: false, isPartial: true, isError: false })).toBe("queued");
		expect(cellState({ executionStarted: true, isPartial: true, isError: false })).toBe("running");
		expect(cellState({ executionStarted: true, isPartial: false, isError: false })).toBe("done");
		expect(cellState({ executionStarted: true, isPartial: false, isError: true })).toBe("error");
	});

	test("marker glyphs are the symbol-preset status glyphs", () => {
		expect(strip(cellMarker("queued", 0, theme))).toBe("…");
		expect(strip(cellMarker("done", 0, theme))).toBe("✓");
		expect(strip(cellMarker("error", 0, theme))).toBe("✗");
		expect(strip(cellMarker("running", 0, theme))).toBe("◇");
		expect(strip(cellMarker("running", 1, theme))).toBe("◈");
	});

	test("duration formats as seconds with one decimal", () => {
		expect(formatDuration(300)).toBe("0.3s");
		expect(formatDuration(3200)).toBe("3.2s");
	});
});

describe("call cell", () => {
	test("renders one line: marker · label · preview · stats · duration · hint", () => {
		const c = new ToolCallCellComponent();
		c.update({
			label: "bash",
			preview: "$ echo hi",
			state: "done",
			stats: ["↓ 3 lines"],
			durationMs: 1200,
			hint: "(ctrl+o to expand)",
			theme,
			invalidate: () => {},
		});
		const line = strip(c.render(80)[0]);
		expect(line).toContain("✓ bash");
		expect(line).toContain("$ echo hi");
		expect(line).toContain("↓ 3 lines");
		expect(line).toContain("1.2s");
		expect(line).toContain("ctrl+o to expand");
		expect(c.render(80).length).toBe(1);
	});

	test("error state carries the error summary in error color", () => {
		const c = new ToolCallCellComponent();
		c.update({
			label: "bash",
			preview: "$ ls missing",
			state: "error",
			errorName: "ls: cannot access",
			hint: "(ctrl+o to expand)",
			theme,
			invalidate: () => {},
		});
		const line = strip(c.render(80)[0]);
		expect(line).toContain("✗ bash");
		expect(line).toContain("ls: cannot access");
	});

	test("over-long lines truncate to the width", () => {
		const c = new ToolCallCellComponent();
		c.update({
			label: "bash",
			preview: "$ " + "x".repeat(200),
			state: "done",
			theme,
			invalidate: () => {},
		});
		expect(strip(c.render(40)[0]).length).toBe(40);
	});

	test("spinner settles when the state leaves running", () => {
		const c = new ToolCallCellComponent();
		c.update({ label: "bash", preview: "$ echo", state: "running", theme, invalidate: () => {} });
		const frame0 = strip(c.render(40)[0]);
		expect(frame0).toContain("◇");
		// Settle so the spinner interval is cleared and bun can exit.
		c.update({ label: "bash", preview: "$ echo", state: "done", theme, invalidate: () => {} });
	});
});

describe("result cell", () => {
	test("renders output only when expanded", () => {
		const c = new ToolResultCellComponent();
		c.update(["out1", "out2"], theme, false);
		expect(c.render(40)).toEqual([]);
		c.update(["out1", "out2"], theme, true);
		const lines = c.render(40);
		expect(strip(lines[0])).toContain("out1");
		expect(strip(lines[1])).toContain("out2");
	});

	test("wraps long lines and pads every row to the render width", () => {
		const c = new ToolResultCellComponent();
		const long = "x".repeat(100);
		c.update([long], theme, true);
		const lines = c.render(20);
		// 100 chars at 18-col content width → 6 rows, each exactly 20 wide.
		expect(lines.length).toBe(6);
		for (const line of lines) expect(strip(line).length).toBe(20);
		expect(strip(lines[0])).toContain("  xx");
		// Settle nothing: no timer in the result cell.
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
	});

	test("call header colors the preview per tool", () => {
		// fg mock tags tokens so we can assert which color each part got.
		const tokenTheme: any = { fg: (token: string, s: string) => `[${token}]${s}`, bold: (s: string) => `[bold]${s}` };
		expect(callHeaderLine("bash", { command: "cargo build" }, tokenTheme, deps)).toContain("[bashMode]cargo build");
		expect(callHeaderLine("bash", { command: "cargo build" }, tokenTheme, deps)).toContain("[toolTitle][bold]$");
		expect(callHeaderLine("write", { path: "a.txt" }, tokenTheme, deps)).toContain("[accent]a.txt");
		expect(callHeaderLine("grep", { pattern: "needle" }, tokenTheme, deps)).toContain("[accent]needle");
		expect(callHeaderLine("find", { pattern: "*.ts" }, tokenTheme, deps)).toContain("[accent]*.ts");
		expect(callHeaderLine("ls", { path: "src" }, tokenTheme, deps)).toContain("[accent]src");
		expect(callHeaderLine("bash", { command: "ls", timeout: 5 }, tokenTheme, deps)).toContain("[dim]timeout=5");
	});
	test("tree rows use unicode branch glyphs by default", () => {
		const rows = renderTreeList({ items: ["a.ts", "b.ts"], expanded: true, itemType: "file", renderItem: (l) => l }, theme, deps);
		expect(rows.length).toBe(2);
		expect(strip(rows[0])).toContain("├─");
		expect(strip(rows[1])).toContain("└─");
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