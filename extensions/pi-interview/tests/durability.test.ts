import { describe, expect, test } from "bun:test";
import {
	buildToolResult,
	findDanglingToolCalls,
	hasRecoveryMessage,
	insertToolResults,
	type MessageLike,
} from "../src/durability.ts";

const TOOL = "interview_user";

function assistantCall(id: string, name = TOOL): MessageLike {
	return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: { questions: [] } }] };
}

function toolResult(toolCallId: string): MessageLike {
	return { role: "toolResult", toolCallId, content: [] };
}

describe("findDanglingToolCalls", () => {
	test("finds a call with no result", () => {
		const messages: MessageLike[] = [{ role: "user" }, assistantCall("call-1")];
		expect(findDanglingToolCalls(messages, TOOL)).toEqual([
			{ messageIndex: 1, toolCallId: "call-1", arguments: { questions: [] } },
		]);
	});

	test("ignores calls that were answered", () => {
		const messages: MessageLike[] = [assistantCall("call-1"), toolResult("call-1")];
		expect(findDanglingToolCalls(messages, TOOL)).toEqual([]);
	});

	test("ignores other tools", () => {
		const messages: MessageLike[] = [assistantCall("call-1", "bash")];
		expect(findDanglingToolCalls(messages, TOOL)).toEqual([]);
	});

	test("finds every dangling call after repeated interruptions", () => {
		const messages: MessageLike[] = [
			assistantCall("call-1"),
			{ role: "user" },
			assistantCall("call-2"),
			toolResult("call-2"),
			assistantCall("call-3"),
		];
		expect(findDanglingToolCalls(messages, TOOL).map((call) => call.toolCallId)).toEqual(["call-1", "call-3"]);
	});
});

describe("insertToolResults", () => {
	test("places each result immediately after its own call", () => {
		const messages: MessageLike[] = [{ role: "user" }, assistantCall("call-1"), { role: "user" }];
		const repaired = insertToolResults(messages, [
			{ afterIndex: 1, message: toolResult("call-1") },
		]);
		expect(repaired.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
	});

	test("returns a copy when there is nothing to repair", () => {
		const messages: MessageLike[] = [{ role: "user" }];
		const repaired = insertToolResults(messages, []);
		expect(repaired).toEqual(messages);
		expect(repaired).not.toBe(messages);
	});
});

describe("hasRecoveryMessage", () => {
	test("matches customType and toolCallId together", () => {
		const messages = [
			{ role: "custom", customType: "other", details: { toolCallId: "call-1" } },
			{ role: "custom", customType: "pi-interview", details: { toolCallId: "call-2" } },
		];
		expect(hasRecoveryMessage(messages, "pi-interview", "call-1")).toBe(false);
		expect(hasRecoveryMessage(messages, "pi-interview", "call-2")).toBe(true);
	});
});

describe("buildToolResult", () => {
	test("pairs with the call it repairs", () => {
		const result = buildToolResult("call-1", TOOL, "interrupted", true);
		expect(result.toolCallId).toBe("call-1");
		expect(result.toolName).toBe(TOOL);
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "interrupted" }]);
	});
});
