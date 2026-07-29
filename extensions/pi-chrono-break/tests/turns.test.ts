import { describe, expect, test } from "bun:test";
import { buildTurnAnchors, estimateTokens, findAnchorByTurnsBack, renderTurnMap, summarize } from "../src/turns.ts";
import type { MessageLike } from "../src/types.ts";

function user(timestamp: number, text: string): MessageLike {
	return { role: "user", timestamp, content: [{ type: "text", text }] };
}

function assistant(timestamp: number, text: string): MessageLike {
	return { role: "assistant", timestamp, content: [{ type: "text", text }] };
}

describe("buildTurnAnchors", () => {
	test("numbers user turns newest-first", () => {
		const anchors = buildTurnAnchors([
			user(1000, "original task"),
			assistant(1100, "ok"),
			user(2000, "try approach A"),
			assistant(2100, "doing A"),
			user(3000, "A failed"),
		]);

		expect(anchors.map((anchor) => anchor.turnsBack)).toEqual([1, 2, 3]);
		expect(anchors[0].preview).toBe("A failed");
		expect(anchors[2].preview).toBe("original task");
	});

	test("ignores non-user messages, including breadcrumbs from an earlier rewind", () => {
		const anchors = buildTurnAnchors([
			user(1000, "original task"),
			{ role: "custom", customType: "chrono-break", timestamp: 2000, content: "[chrono-break] Rewound 2 turns" },
			assistant(2100, "continuing"),
		]);

		expect(anchors).toHaveLength(1);
		expect(anchors[0].turnsBack).toBe(1);
	});

	test("trailing cost grows as the anchor gets older", () => {
		const anchors = buildTurnAnchors([user(1000, "a".repeat(400)), assistant(1100, "b".repeat(400)), user(2000, "c".repeat(400))]);

		const newest = anchors[0];
		const oldest = anchors[1];
		expect(newest.trailingMessages).toBe(1);
		expect(oldest.trailingMessages).toBe(3);
		expect(oldest.trailingTokens).toBeGreaterThan(newest.trailingTokens);
	});

	test("anchor ids are unique", () => {
		const anchors = buildTurnAnchors([user(1000, "one"), user(1000, "two"), user(1000, "three")]);
		expect(new Set(anchors.map((anchor) => anchor.id)).size).toBe(3);
	});

	test("findAnchorByTurnsBack resolves the counting shorthand", () => {
		const anchors = buildTurnAnchors([user(1000, "first"), user(2000, "second")]);
		expect(findAnchorByTurnsBack(anchors, 1)?.preview).toBe("second");
		expect(findAnchorByTurnsBack(anchors, 2)?.preview).toBe("first");
		expect(findAnchorByTurnsBack(anchors, 3)).toBeUndefined();
	});
});

describe("estimateTokens", () => {
	test("counts text, thinking, and tool arguments", () => {
		const tokens = estimateTokens([
			{ role: "assistant", timestamp: 1, content: [{ type: "thinking", thinking: "x".repeat(40) }] },
			{ role: "assistant", timestamp: 2, content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "y".repeat(30) } }] },
		]);
		expect(tokens).toBeGreaterThan(10);
	});

	test("handles string content and empty messages", () => {
		expect(estimateTokens([{ role: "user", timestamp: 1, content: "abcd" }])).toBe(1);
		expect(estimateTokens([{ role: "user", timestamp: 1 }])).toBe(0);
	});
});

describe("renderTurnMap", () => {
	test("explains the empty case instead of printing a bare header", () => {
		expect(renderTurnMap([])).toContain("nothing to rewind");
	});

	test("lists anchor ids", () => {
		const anchors = buildTurnAnchors([user(1000, "first"), user(2000, "second")]);
		const rendered = renderTurnMap(anchors);
		expect(rendered).toContain(anchors[0].id);
		expect(rendered).toContain(anchors[1].id);
	});
});

describe("summarize", () => {
	test("collapses whitespace and truncates", () => {
		expect(summarize("a\n  b   c")).toBe("a b c");
		expect(summarize("x".repeat(100)).length).toBe(72);
	});
});
