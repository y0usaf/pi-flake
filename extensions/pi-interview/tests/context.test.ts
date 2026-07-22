import { describe, expect, test } from "bun:test";
import { buildContextPacket } from "../src/context.ts";
import type { InterviewConfig } from "../src/types.ts";

const config: InterviewConfig = {
	mode: "auto",
	provider: "test",
	model: "interviewer",
	reasoning: "low",
	maxTokens: 4096,
	maxQuestions: 3,
	maxOptions: 5,
	maxContextMessages: 8,
	maxContextChars: 12000,
	includeContextFiles: false,
	timeoutMs: 45000,
};

const branch = [
	{
		type: "message",
		message: { role: "user", content: [{ type: "text", text: "Earlier requirement" }] },
	},
	{
		type: "message",
		message: { role: "toolResult", content: [{ type: "text", text: "SECRET_TOOL_OUTPUT" }] },
	},
	{
		type: "message",
		message: { role: "assistant", content: [{ type: "thinking", thinking: "SECRET_THINKING" }, { type: "text", text: "Known tradeoff" }] },
	},
	{
		type: "message",
		message: { role: "custom", customType: "pi-interview", content: "Prior selected answer" },
	},
];

describe("buildContextPacket", () => {
	test("includes conversational decisions but excludes tool output and thinking", () => {
		const packet = buildContextPacket({ prompt: "Current request", branch, config });
		expect(packet).toContain("Current request");
		expect(packet).toContain("Earlier requirement");
		expect(packet).toContain("Known tradeoff");
		expect(packet).toContain("Prior selected answer");
		expect(packet).not.toContain("SECRET_TOOL_OUTPUT");
		expect(packet).not.toContain("SECRET_THINKING");
	});

	test("shares context files only when enabled", () => {
		const contextFiles = [{ path: "AGENTS.md", content: "PROJECT_CONSTRAINT" }];
		const hidden = buildContextPacket({ prompt: "Current request", branch: [], contextFiles, config });
		const shared = buildContextPacket({
			prompt: "Current request",
			branch: [],
			contextFiles,
			config: { ...config, includeContextFiles: true },
		});
		expect(hidden).not.toContain("PROJECT_CONSTRAINT");
		expect(shared).toContain("PROJECT_CONSTRAINT");
	});
});
