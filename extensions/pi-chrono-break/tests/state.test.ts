import { describe, expect, test } from "bun:test";
import { buildBreadcrumb, formatTokens, parseMarker, replayMarkers } from "../src/state.ts";
import { CUT_ENTRY_TYPE, type CutMarker, UNDO_ENTRY_TYPE } from "../src/types.ts";

function cutEntry(marker: Partial<CutMarker>) {
	return {
		type: "custom",
		customType: CUT_ENTRY_TYPE,
		data: {
			id: "cb-1",
			cutAt: 1000,
			createdAt: 1500,
			reason: "regex approach failed",
			breadcrumb: "[chrono-break] Rewound 2 turns.",
			turnsBack: 2,
			droppedMessages: 6,
			droppedTokens: 4200,
			...marker,
		},
	};
}

describe("replayMarkers", () => {
	test("rebuilds markers from session entries in creation order", () => {
		const markers = replayMarkers([
			{ type: "message" },
			cutEntry({ id: "cb-2", createdAt: 9000 }),
			cutEntry({ id: "cb-1", createdAt: 1500 }),
		]);
		expect(markers.map((marker) => marker.id)).toEqual(["cb-1", "cb-2"]);
	});

	test("an undo entry cancels its marker, because session files are append-only", () => {
		const markers = replayMarkers([
			cutEntry({ id: "cb-1" }),
			cutEntry({ id: "cb-2", createdAt: 2500 }),
			{ type: "custom", customType: UNDO_ENTRY_TYPE, data: { id: "cb-1" } },
		]);
		expect(markers.map((marker) => marker.id)).toEqual(["cb-2"]);
	});

	test("ignores unrelated and malformed entries", () => {
		const markers = replayMarkers([
			{ type: "custom", customType: "someone-elses-state", data: { id: "cb-9" } },
			{ type: "custom", customType: CUT_ENTRY_TYPE, data: { id: "cb-broken" } },
			"garbage",
			null,
		]);
		expect(markers).toHaveLength(0);
	});
});

describe("parseMarker", () => {
	test("rejects a marker with no breadcrumb, since the model would see a silent gap", () => {
		expect(parseMarker({ id: "cb-1", cutAt: 1, createdAt: 2, breadcrumb: "" })).toBeUndefined();
	});

	test("fills defaults for optional display fields", () => {
		const marker = parseMarker({ id: "cb-1", cutAt: 1, createdAt: 2, breadcrumb: "text" });
		expect(marker?.droppedTokens).toBe(0);
		expect(marker?.reason).toBe("");
	});
});

describe("buildBreadcrumb", () => {
	test("is byte-stable for the same inputs", () => {
		// The breadcrumb sits inside the cached prompt prefix. If it varied
		// between requests, the provider's cache boundary would move and every
		// later request would re-read the whole conversation at uncached price.
		const first = buildBreadcrumb(3, 8, 12400, "the parser rewrite broke round-tripping");
		const second = buildBreadcrumb(3, 8, 12400, "the parser rewrite broke round-tripping");
		expect(first).toBe(second);
	});

	test("contains no clock time or elapsed duration", () => {
		const text = buildBreadcrumb(2, 5, 900, "approach A failed");
		expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
		expect(text).not.toMatch(/ago|:\d{2}:/);
	});

	test("carries the reason and an explicit do-not-retry instruction", () => {
		const text = buildBreadcrumb(1, 2, 100, "  tried   sed,  mangled the file  ");
		expect(text).toContain("tried sed, mangled the file");
		expect(text).toContain("Do not retry");
	});
});

describe("formatTokens", () => {
	test("switches to k above a thousand", () => {
		expect(formatTokens(940)).toBe("940");
		expect(formatTokens(12400)).toBe("12.4k");
	});
});
