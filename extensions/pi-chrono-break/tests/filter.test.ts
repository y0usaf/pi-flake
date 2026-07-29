import { describe, expect, test } from "bun:test";
import { applyCuts } from "../src/filter.ts";
import type { CutMarker, MessageLike } from "../src/types.ts";

function user(timestamp: number, text: string): MessageLike {
	return { role: "user", timestamp, content: [{ type: "text", text }] };
}

function assistant(timestamp: number, text: string): MessageLike {
	return { role: "assistant", timestamp, content: [{ type: "text", text }] };
}

function caller(timestamp: number, callId: string, name = "read"): MessageLike {
	return { role: "assistant", timestamp, content: [{ type: "toolCall", id: callId, name, arguments: {} }] };
}

function result(timestamp: number, callId: string, name = "read"): MessageLike {
	return { role: "toolResult", timestamp, toolCallId: callId, toolName: name, content: [{ type: "text", text: "ok" }] };
}

function marker(overrides: Partial<CutMarker> = {}): CutMarker {
	return {
		id: "cb-test",
		cutAt: 2000,
		createdAt: 2500,
		reason: "approach A failed",
		breadcrumb: "[chrono-break] Rewound 1 turn.",
		turnsBack: 1,
		droppedMessages: 0,
		droppedTokens: 0,
		...overrides,
	};
}

/** Every surviving tool result must still have the assistant call that produced it. */
function pairingIsValid(messages: readonly MessageLike[]): boolean {
	const callIds = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content as Array<{ type: string; id?: string }>) {
			if (block.type === "toolCall" && typeof block.id === "string") callIds.add(block.id);
		}
	}
	const resolved = new Set<string>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		if (typeof message.toolCallId !== "string" || !callIds.has(message.toolCallId)) return false;
		resolved.add(message.toolCallId);
	}
	return [...callIds].every((id) => resolved.has(id));
}

describe("applyCuts", () => {
	test("passes the transcript through untouched when there are no markers", () => {
		const messages = [user(1000, "hi"), assistant(1100, "hello")];
		const output = applyCuts(messages, []);
		expect(output.messages).toEqual(messages);
		expect(output.droppedMessages).toBe(0);
	});

	test("removes the cut turn and everything inside the window, leaving the breadcrumb", () => {
		const messages = [user(1000, "task"), assistant(1100, "ok"), user(2000, "approach A"), assistant(2100, "doing A")];
		const output = applyCuts(messages, [marker()]);

		expect(output.messages.map((message) => message.role)).toEqual(["user", "assistant", "custom"]);
		expect(output.messages[2].content).toBe("[chrono-break] Rewound 1 turn.");
		expect(output.messages[2].timestamp).toBe(2000);
	});

	test("drops the chrono_break tool result even though it lands after the window closes", () => {
		// This is the failure the whole design guards: the assistant message
		// carrying the rewind call is inside the window, but its result is
		// written a moment later. Keeping the result alone is a provider error.
		const messages = [
			user(1000, "task"),
			assistant(1100, "ok"),
			user(2000, "approach A"),
			caller(2400, "call-cb", "chrono_break"),
			result(2600, "call-cb", "chrono_break"),
		];
		const output = applyCuts(messages, [marker({ createdAt: 2500 })]);

		expect(output.messages.some((message) => message.role === "toolResult")).toBe(false);
		expect(pairingIsValid(output.messages)).toBe(true);
	});

	test("drops both halves of a sibling tool call in the same assistant message", () => {
		const both: MessageLike = {
			role: "assistant",
			timestamp: 2400,
			content: [
				{ type: "toolCall", id: "call-cb", name: "chrono_break", arguments: {} },
				{ type: "toolCall", id: "call-read", name: "read", arguments: {} },
			],
		};
		const messages = [user(1000, "task"), user(2000, "approach A"), both, result(2600, "call-cb"), result(2650, "call-read")];
		const output = applyCuts(messages, [marker({ createdAt: 2500 })]);

		expect(output.messages.some((message) => message.role === "toolResult")).toBe(false);
		expect(pairingIsValid(output.messages)).toBe(true);
	});

	test("keeps work done after the rewind", () => {
		const messages = [
			user(1000, "task"),
			user(2000, "approach A"),
			caller(2400, "call-cb", "chrono_break"),
			result(2600, "call-cb", "chrono_break"),
			assistant(3000, "approach B instead"),
			user(4000, "good"),
		];
		const output = applyCuts(messages, [marker({ createdAt: 2500 })]);
		const texts = output.messages.map((message) => JSON.stringify(message.content));

		expect(texts.some((text) => text.includes("approach B instead"))).toBe(true);
		expect(texts.some((text) => text.includes("good"))).toBe(true);
		expect(texts.some((text) => text.includes("approach A"))).toBe(false);
	});

	test("removes a tool result whose caller was cut and keeps pairing valid", () => {
		const messages = [user(1000, "task"), user(2000, "approach A"), caller(2100, "call-x"), result(2200, "call-x")];
		const output = applyCuts(messages, [marker({ createdAt: 2500 })]);
		expect(pairingIsValid(output.messages)).toBe(true);
		expect(output.messages.filter((message) => message.role === "toolResult")).toHaveLength(0);
	});

	test("suppresses the breadcrumb of a rewind that was itself rewound past", () => {
		const inner = marker({ id: "cb-inner", cutAt: 3000, createdAt: 3500, breadcrumb: "INNER" });
		const outer = marker({ id: "cb-outer", cutAt: 2000, createdAt: 5000, breadcrumb: "OUTER" });
		const messages = [user(1000, "task"), user(2000, "approach A"), user(3000, "approach B"), assistant(4000, "still wrong")];
		const output = applyCuts(messages, [inner, outer]);

		const breadcrumbs = output.messages.filter((message) => message.role === "custom").map((message) => message.content);
		expect(breadcrumbs).toEqual(["OUTER"]);
	});

	test("appends the breadcrumb at the end when the cut point is past every message", () => {
		const messages = [user(1000, "task")];
		const output = applyCuts(messages, [marker({ cutAt: 9000, createdAt: 9500 })]);
		expect(output.messages).toHaveLength(2);
		expect(output.messages[1].role).toBe("custom");
	});
});
