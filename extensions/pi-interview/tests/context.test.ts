import { describe, expect, test } from "bun:test";
import { buildAutoAnswerPacket, buildContextPacket } from "../src/context.ts";
import type { InterviewConfig, InterviewQuestion } from "../src/types.ts";

const config: InterviewConfig = {
	mode: "auto",
	provider: "test",
	model: "answerer",
	reasoning: "low",
	maxTokens: 4096,
	maxQuestions: 3,
	maxOptions: 5,
	maxContextMessages: 8,
	maxContextChars: 12000,
	includeContextFiles: false,
	timeoutMs: 45000,
};

const questions: InterviewQuestion[] = [
	{
		id: "scope",
		label: "Scope",
		prompt: "Which scope should implementation use?",
		options: [
			{ value: "minimal", label: "Minimal" },
			{ value: "broad", label: "Broad" },
		],
		allowOther: true,
	},
];

const branch = [
	{
		type: "message",
		message: { role: "user", content: [{ type: "text", text: "Earlier requirement" }] },
	},
	{
		type: "message",
		message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "SECRET_TOOL_OUTPUT" }] },
	},
	{
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "SECRET_THINKING" },
				{ type: "text", text: "Known tradeoff" },
			],
		},
	},
	{
		type: "message",
		message: {
			role: "toolResult",
			toolName: "interview_user",
			content: [{ type: "text", text: "Prior interview answer" }],
		},
	},
];

describe("auto-answer context", () => {
	test("includes exact questionnaire and bounded session context but excludes general tool output and thinking", () => {
		const packet = buildAutoAnswerPacket({ prompt: "Current request", questions, branch, config });
		expect(packet).toContain("Current request");
		expect(packet).toContain("QUESTIONNAIRE TO ANSWER");
		expect(packet).toContain("Which scope should implementation use?");
		expect(packet).toContain("Earlier requirement");
		expect(packet).toContain("Known tradeoff");
		expect(packet).toContain("Prior interview answer");
		expect(packet).not.toContain("SECRET_TOOL_OUTPUT");
		expect(packet).not.toContain("SECRET_THINKING");

		const sessionContext = buildContextPacket({ prompt: "Current request", branch, config });
		expect(sessionContext.length).toBeLessThanOrEqual(config.maxContextChars);
	});

	test("shares context files only when enabled", () => {
		const contextFiles = [{ path: "AGENTS.md", content: "PROJECT_CONSTRAINT" }];
		const hidden = buildAutoAnswerPacket({ prompt: "Current request", questions, branch: [], contextFiles, config });
		const shared = buildAutoAnswerPacket({
			prompt: "Current request",
			questions,
			branch: [],
			contextFiles,
			config: { ...config, includeContextFiles: true },
		});
		expect(hidden).not.toContain("PROJECT_CONSTRAINT");
		expect(shared).toContain("PROJECT_CONSTRAINT");
	});
});
