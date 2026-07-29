import type { TextContent, ToolResultMessage } from "@earendil-works/pi-ai";

/**
 * Durability across process death.
 *
 * Pi persists the assistant message that *contains* a tool call before the tool
 * runs, and persists the result only when the tool returns. A questionnaire that
 * is open when pi exits therefore leaves a tool call with no result in the
 * session file. Nothing repairs that pairing on load, so the next provider
 * request carries a `tool_use` block with no matching `tool_result` and the API
 * rejects the whole turn.
 *
 * Extensions get a read-only SessionManager, so the session file cannot be
 * fixed. The `context` event is the only lever: it hands over a deep copy of the
 * messages about to be sent and accepts a replacement array. Everything here is
 * pure so the repair is derived from the messages themselves rather than from
 * a sidecar file that could rot.
 */

interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
}

/** Structural view of the message shapes this module inspects. */
export interface MessageLike {
	role: string;
	content?: unknown;
	toolCallId?: string;
}

export interface DanglingCall {
	/** Index of the assistant message holding the call. */
	messageIndex: number;
	toolCallId: string;
	arguments: Record<string, unknown>;
}

function isToolCallBlock(value: unknown, toolName: string): value is ToolCallBlock {
	if (typeof value !== "object" || value === null) return false;
	const block = value as Record<string, unknown>;
	return block.type === "toolCall" && block.name === toolName && typeof block.id === "string";
}

function asMessage(value: unknown): MessageLike | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	return typeof record.role === "string" ? (record as unknown as MessageLike) : undefined;
}

/**
 * Every call to `toolName` that has no matching tool result later in the branch,
 * oldest first. More than one can exist after repeated interrupted sessions.
 */
export function findDanglingToolCalls(messages: readonly unknown[], toolName: string): DanglingCall[] {
	const resolved = new Set<string>();
	for (const value of messages) {
		const message = asMessage(value);
		if (message?.role === "toolResult" && typeof message.toolCallId === "string") resolved.add(message.toolCallId);
	}

	const dangling: DanglingCall[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = asMessage(messages[index]);
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (!isToolCallBlock(block, toolName) || resolved.has(block.id)) continue;
			dangling.push({
				messageIndex: index,
				toolCallId: block.id,
				arguments: block.arguments ?? {},
			});
		}
	}
	return dangling;
}

export function buildToolResult(toolCallId: string, toolName: string, text: string, isError: boolean): ToolResultMessage {
	const content: TextContent[] = [{ type: "text", text }];
	return { role: "toolResult", toolCallId, toolName, content, isError, timestamp: Date.now() };
}

/**
 * Splice each result in directly after the assistant message that called it.
 * Anthropic requires `tool_result` immediately after its `tool_use`, so
 * appending at the end of the array is not good enough.
 */
export function insertToolResults<M>(messages: readonly M[], inserts: readonly { afterIndex: number; message: M }[]): M[] {
	if (inserts.length === 0) return [...messages];
	const byIndex = new Map<number, M[]>();
	for (const insert of inserts) {
		const bucket = byIndex.get(insert.afterIndex);
		if (bucket) bucket.push(insert.message);
		else byIndex.set(insert.afterIndex, [insert.message]);
	}
	const repaired: M[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message !== undefined) repaired.push(message);
		const appended = byIndex.get(index);
		if (appended) repaired.push(...appended);
	}
	return repaired;
}

/**
 * True when a recovery message for `toolCallId` already exists in the branch.
 * The recovery message is a normal pi custom message, so it is persisted by pi
 * itself: the answers survive restarts without this extension owning a file.
 */
export function hasRecoveryMessage(messages: readonly unknown[], customType: string, toolCallId: string): boolean {
	return messages.some((message) => {
		if (typeof message !== "object" || message === null) return false;
		const record = message as Record<string, unknown>;
		if (record.role !== "custom" || record.customType !== customType) return false;
		const details = record.details;
		if (typeof details !== "object" || details === null) return false;
		return (details as Record<string, unknown>).toolCallId === toolCallId;
	});
}
