import { BREADCRUMB_TYPE, type ContentBlock, type CutMarker, type MessageLike } from "./types.js";

export interface CutResult {
	messages: MessageLike[];
	droppedMessages: number;
}

function toolCallIds(message: MessageLike): string[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	return (message.content as ContentBlock[])
		.filter((block): block is { type: "toolCall"; id: string } => {
			return !!block && block.type === "toolCall" && typeof (block as { id?: unknown }).id === "string";
		})
		.map((block) => block.id);
}

function inWindow(timestamp: number, marker: CutMarker): boolean {
	return timestamp >= marker.cutAt && timestamp <= marker.createdAt;
}

export function makeBreadcrumb(marker: CutMarker): MessageLike {
	return {
		role: "custom",
		customType: BREADCRUMB_TYPE,
		content: marker.breadcrumb,
		display: false,
		details: { id: marker.id },
		timestamp: marker.cutAt,
	};
}

/**
 * Remove every message covered by an active cut marker and splice each
 * marker's frozen breadcrumb in at its cut point.
 *
 * Three passes, because removing one message can invalidate another:
 *
 *  1. Window drop. A message goes if its timestamp falls inside any marker's
 *     [cutAt, createdAt] window. That window closes at the moment the tool ran,
 *     so work done after the rewind is never touched.
 *
 *  2. Paired-result drop. The assistant message carrying the chrono_break call
 *     is inside the window, but its own tool result is written a moment after
 *     the window closes. Dropping only the call would leave the provider with a
 *     `tool_result` referring to a `tool_use` that no longer exists, which
 *     Anthropic rejects outright. So any tool result whose `toolCallId` came
 *     from a dropped assistant message goes too, whatever its timestamp.
 *
 *  3. Orphan fixpoint. Repeat until stable: drop tool results with no surviving
 *     caller, and drop assistant messages whose tool calls lost their results.
 *     Dropping an assistant message can orphan further results, hence the loop.
 */
export function applyCuts(messages: readonly MessageLike[], markers: readonly CutMarker[]): CutResult {
	if (markers.length === 0) return { messages: [...messages], droppedMessages: 0 };

	const active = [...markers].sort((left, right) => left.createdAt - right.createdAt);
	const dropped = new Set<number>();

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (!message) continue;
		if (active.some((marker) => inWindow(message.timestamp, marker))) dropped.add(index);
	}

	const droppedCallIds = new Set<string>();
	for (const index of dropped) {
		const message = messages[index];
		if (message) for (const id of toolCallIds(message)) droppedCallIds.add(id);
	}
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (!message || message.role !== "toolResult") continue;
		if (typeof message.toolCallId === "string" && droppedCallIds.has(message.toolCallId)) dropped.add(index);
	}

	for (let pass = 0; pass < 8; pass++) {
		const surviving = new Set<string>();
		for (let index = 0; index < messages.length; index++) {
			if (dropped.has(index)) continue;
			const message = messages[index];
			if (message) for (const id of toolCallIds(message)) surviving.add(id);
		}

		const resolved = new Set<string>();
		let changed = false;
		for (let index = 0; index < messages.length; index++) {
			if (dropped.has(index)) continue;
			const message = messages[index];
			if (!message || message.role !== "toolResult") continue;
			const id = message.toolCallId;
			if (typeof id !== "string") continue;
			if (!surviving.has(id)) {
				dropped.add(index);
				changed = true;
			} else {
				resolved.add(id);
			}
		}

		for (let index = 0; index < messages.length; index++) {
			if (dropped.has(index)) continue;
			const message = messages[index];
			if (!message) continue;
			const ids = toolCallIds(message);
			if (ids.length > 0 && ids.some((id) => !resolved.has(id))) {
				dropped.add(index);
				changed = true;
			}
		}

		if (!changed) break;
	}

	// A marker whose cut point sits inside a later marker's window was itself
	// rewound past; replaying its breadcrumb would describe a path the model
	// can no longer see.
	const visible = active.filter((marker) => {
		return !active.some((other) => other.id !== marker.id && other.createdAt > marker.createdAt && inWindow(marker.cutAt, other));
	});

	const insertions = new Map<number, CutMarker[]>();
	for (const marker of visible) {
		let index = messages.findIndex((message) => message.timestamp >= marker.cutAt);
		if (index < 0) index = messages.length;
		const bucket = insertions.get(index) ?? [];
		bucket.push(marker);
		insertions.set(index, bucket);
	}

	const output: MessageLike[] = [];
	for (let index = 0; index <= messages.length; index++) {
		for (const marker of insertions.get(index) ?? []) output.push(makeBreadcrumb(marker));
		if (index === messages.length) break;
		if (!dropped.has(index)) {
			const message = messages[index];
			if (message) output.push(message);
		}
	}

	return { messages: output, droppedMessages: dropped.size };
}
