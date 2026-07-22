import { describe, expect, test } from "bun:test";
import {
	createJudgmentAnswers,
	normalizeQuestions,
	parseAutoAnswers,
	USE_JUDGMENT_VALUE,
} from "../src/protocol.ts";

const limits = { maxQuestions: 3, maxOptions: 5 };

function sampleQuestions() {
	return normalizeQuestions(
		[
			{
				id: "API Scope",
				label: "Scope",
				prompt: "Which API should change?",
				options: [
					{ value: "public", label: "Public API", description: "Broader compatibility", recommended: true },
					{ value: "internal", label: "Internal only" },
				],
			},
			{
				id: "target",
				label: "Target",
				prompt: "Which platform?",
				options: [{ value: "portable", label: "Portable" }],
				allowOther: true,
			},
		],
		limits,
	);
}

describe("normalizeQuestions", () => {
	test("normalizes main-session questions and appends host judgment option", () => {
		const questions = sampleQuestions();
		expect(questions[0].id).toBe("api-scope");
		expect(questions[0].options.at(-1)?.value).toBe(USE_JUDGMENT_VALUE);
		expect(questions[0].options).toHaveLength(3);
	});

	test("deduplicates and caps options while keeping one recommendation", () => {
		const questions = normalizeQuestions(
			[
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
			{ maxQuestions: 3, maxOptions: 4 },
		);
		const options = questions[0].options;
		expect(options).toHaveLength(4);
		expect(options.filter((option) => option.recommended)).toHaveLength(1);
	});

	test("removes model-provided host choices before adding canonical judgment", () => {
		const questions = normalizeQuestions(
			[{ prompt: "Choose", options: ["Other", "Use your judgment", "Concrete path"] }],
			limits,
		);
		expect(questions[0].options.map((option) => option.label)).toEqual(["Concrete path", "Use your judgment"]);
	});

	test("strips terminal control characters", () => {
		const questions = normalizeQuestions([{ prompt: "\u001b[2JChoose", options: ["Safe"] }], limits);
		expect(questions[0].prompt).not.toContain("\u001b");
	});
});

describe("parseAutoAnswers", () => {
	test("maps selected values and custom answers to questionnaire result shape", () => {
		const questions = sampleQuestions();
		const result = parseAutoAnswers(
			'```json\n{"answers":[{"id":"api-scope","value":"internal"},{"id":"target","custom":"Linux only"}]}\n```',
			questions,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.answers).toEqual([
			{ id: "api-scope", value: "internal", label: "Internal only", wasCustom: false, index: 2 },
			{ id: "target", value: "Linux only", label: "Linux only", wasCustom: true },
		]);
	});

	test("rejects missing or unknown answers", () => {
		const questions = sampleQuestions();
		expect(parseAutoAnswers('{"answers":[]}', questions).ok).toBe(false);
		expect(
			parseAutoAnswers(
				'{"answers":[{"id":"api-scope","value":"unknown"},{"id":"target","value":"portable"}]}',
				questions,
			).ok,
		).toBe(false);
	});

	test("creates explicit use-judgment fallback answers", () => {
		const answers = createJudgmentAnswers(sampleQuestions());
		expect(answers).toHaveLength(2);
		expect(answers.every((answer) => answer.value === USE_JUDGMENT_VALUE)).toBe(true);
	});
});
