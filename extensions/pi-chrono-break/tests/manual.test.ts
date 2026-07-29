import { describe, expect, test } from "bun:test";
import { resolveTreeSummary, validateReason } from "../src/manual.ts";
import type { PendingManualCut } from "../src/types.ts";

const pending: PendingManualCut = { targetId: "entry-7", reason: "regex could not handle nested quotes", mode: "frozen" };

describe("resolveTreeSummary", () => {
	test("supplies the frozen note for the cut we started", () => {
		const result = resolveTreeSummary(pending, "entry-7", 6);
		expect(result?.summary.summary).toContain("regex could not handle nested quotes");
		expect(result?.summary.summary).toContain("6 entries");
		expect(result?.summary.summary).toContain("Do not retry");
	});

	test("stands aside for tree navigation the user started by hand", () => {
		// The whole point of the target-id check: without it, every /tree
		// navigation in the session would lose pi's own branch summary.
		expect(resolveTreeSummary(pending, "entry-99", 6)).toBeUndefined();
		expect(resolveTreeSummary(undefined, "entry-7", 6)).toBeUndefined();
	});

	test("stands aside when the user asked for pi's LLM summary", () => {
		const llm: PendingManualCut = { ...pending, mode: "llm" };
		expect(resolveTreeSummary(llm, "entry-7", 6)).toBeUndefined();
	});

	test("carries structured details for later inspection", () => {
		const result = resolveTreeSummary(pending, "entry-7", 3);
		expect(result?.summary.details).toEqual({
			source: "chrono-break",
			reason: "regex could not handle nested quotes",
			entriesLeft: 3,
		});
	});

	test("singularises a one-entry branch", () => {
		expect(resolveTreeSummary(pending, "entry-7", 1)?.summary.summary).toContain("1 entry of");
	});
});

describe("validateReason", () => {
	test("collapses whitespace", () => {
		expect(validateReason("  tried   sed,\n mangled it ")).toBe("tried sed, mangled it");
	});

	test("rejects a reason too short to act on", () => {
		expect(validateReason("nope")).toBeUndefined();
		expect(validateReason("   ")).toBeUndefined();
	});
});
