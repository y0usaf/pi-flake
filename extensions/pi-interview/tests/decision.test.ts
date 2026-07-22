import { describe, expect, test } from "bun:test";
import { createStrictFallback, parseDecision, USE_JUDGMENT_VALUE } from "../src/decision.ts";

const limits = { maxQuestions: 3, maxOptions: 5 };

describe("parseDecision", () => {
	test("accepts proceed JSON inside a code fence", () => {
		const result = parseDecision('```json\n{"action":"proceed","questions":[]}\n```', limits);
		expect(result).toEqual({ ok: true, decision: { action: "proceed", questions: [] } });
	});

	test("normalizes questions and appends host judgment option", () => {
		const result = parseDecision(
			JSON.stringify({
				action: "ask",
				questions: [
					{
						id: "API Scope",
						label: "Scope",
						prompt: "Which API should change?",
						options: [
							{ value: "public", label: "Public API", description: "Broader compatibility", recommended: true },
							{ value: "internal", label: "Internal only" },
						],
					},
				],
			}),
			limits,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.decision.questions[0].id).toBe("api-scope");
		expect(result.decision.questions[0].options.at(-1)?.value).toBe(USE_JUDGMENT_VALUE);
		expect(result.decision.questions[0].options).toHaveLength(3);
	});

	test("deduplicates and caps options while keeping one recommendation", () => {
		const result = parseDecision(
			JSON.stringify({
				action: "ask",
				questions: [
					{
						prompt: "Choose",
						options: [
							{ value: "a", label: "A", recommended: true },
							{ value: "a", label: "Duplicate value" },
							{ value: "b", label: "B", recommended: true },
							{ value: "c", label: "C" },
							{ value: "d", label: "D" },
							{ value: "e", label: "E" },
						],
					},
				],
			}),
			{ maxQuestions: 3, maxOptions: 4 },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const options = result.decision.questions[0].options;
		expect(options).toHaveLength(4);
		expect(options.filter((option) => option.recommended)).toHaveLength(1);
	});

	test("removes host-provided choices from model output", () => {
		const result = parseDecision(
			'{"action":"ask","questions":[{"prompt":"Choose","options":["Other","Use your judgment","Concrete path"]}]}',
			limits,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.decision.questions[0].options.map((option) => option.label)).toEqual([
			"Concrete path",
			"Use your judgment",
		]);
	});

	test("strips terminal control characters from model text", () => {
		const result = parseDecision(
			JSON.stringify({ action: "ask", questions: [{ prompt: "\u001b[2JChoose", options: ["Safe"] }] }),
			limits,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.decision.questions[0].prompt).not.toContain("\u001b");
	});

	test("rejects ask responses without usable choices", () => {
		const result = parseDecision('{"action":"ask","questions":[{"prompt":"Why?","options":[]}]}', limits);
		expect(result.ok).toBe(false);
	});
});

describe("strict fallback", () => {
	test("always provides structured choices", () => {
		const fallback = createStrictFallback();
		expect(fallback.action).toBe("ask");
		expect(fallback.questions).toHaveLength(1);
		expect(fallback.questions[0].options.some((option) => option.value === USE_JUDGMENT_VALUE)).toBe(true);
		expect(createStrictFallback(2).questions[0].options).toHaveLength(2);
	});
});
