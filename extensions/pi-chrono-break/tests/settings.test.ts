import { describe, expect, test } from "bun:test";
import { resolveTreeFilterMode } from "../src/settings.ts";

function reader(files: Record<string, unknown>): (path: string) => unknown {
	return (path: string) => files[path];
}

describe("resolveTreeFilterMode", () => {
	test("project settings win over global, matching pi's precedence", () => {
		const read = reader({
			"/proj/.pi/settings.json": { treeFilterMode: "user-only" },
			"/home/.pi/agent/settings.json": { treeFilterMode: "all" },
		});
		expect(resolveTreeFilterMode(read, ["/proj/.pi/settings.json", "/home/.pi/agent/settings.json"])).toBe("user-only");
	});

	test("falls through to global when the project file has no preference", () => {
		const read = reader({
			"/proj/.pi/settings.json": { outputPad: 1 },
			"/home/.pi/agent/settings.json": { treeFilterMode: "no-tools" },
		});
		expect(resolveTreeFilterMode(read, ["/proj/.pi/settings.json", "/home/.pi/agent/settings.json"])).toBe("no-tools");
	});

	test("rejects a value pi would not accept", () => {
		const read = reader({ "/a.json": { treeFilterMode: "everything" } });
		expect(resolveTreeFilterMode(read, ["/a.json"])).toBe("default");
	});

	test("survives missing, malformed, and non-object files", () => {
		const read = reader({ "/b.json": "not an object", "/c.json": ["array"] });
		expect(resolveTreeFilterMode(read, ["/missing.json", "/b.json", "/c.json"])).toBe("default");
	});

	test("defaults when no paths are given", () => {
		expect(resolveTreeFilterMode(() => undefined, [])).toBe("default");
	});
});
