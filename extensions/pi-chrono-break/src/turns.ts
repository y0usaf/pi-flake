import type { ContentBlock, MessageLike, TurnAnchor } from "./types.js";

/**
 * Rough token estimate. Four characters per token is the usual English-prose
 * approximation; it is only ever shown to the model prefixed with "≈", and no
 * decision in this extension depends on it being exact.
 */
export function estimateTokens(messages: readonly MessageLike[]): number {
	let chars = 0;
	for (const message of messages) chars += messageChars(message);
	return Math.round(chars / 4);
}

function messageChars(message: MessageLike): number {
	const content = message.content;
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content as ContentBlock[]) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
			chars += (block as { text: string }).text.length;
		} else if (block.type === "thinking" && typeof (block as { thinking?: unknown }).thinking === "string") {
			chars += (block as { thinking: string }).thinking.length;
		} else if (block.type === "toolCall") {
			const args = (block as { arguments?: unknown }).arguments;
			chars += args ? JSON.stringify(args).length : 0;
		}
	}
	return chars;
}

export function messageText(message: MessageLike): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as ContentBlock[])
		.filter((block): block is { type: "text"; text: string } => {
			return !!block && block.type === "text" && typeof (block as { text?: unknown }).text === "string";
		})
		.map((block) => block.text)
		.join(" ");
}

export function summarize(text: string, maxChars = 72): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= maxChars) return flat;
	return `${flat.slice(0, maxChars - 1)}…`;
}

function anchorId(timestamp: number, taken: Set<string>): string {
	const base = `cb-${(timestamp % 1679616).toString(36).padStart(4, "0")}`;
	if (!taken.has(base)) return base;
	for (let suffix = 1; suffix < 100; suffix++) {
		const candidate = `${base}${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${base}x`;
}

/**
 * Build the rewindable turn index for a transcript.
 *
 * A turn boundary is always a plain user message. That restriction is not
 * cosmetic: cutting anywhere else could land between an assistant `toolCall`
 * block and its matching `toolResult` message, and Anthropic rejects a request
 * whose `tool_use` block has no `tool_result` immediately after it.
 *
 * Synthetic breadcrumbs inserted by a previous rewind carry role "custom", so
 * they are not anchors and a second rewind cannot target the inside of a
 * region that is already gone.
 *
 * Returned newest-first: `turnsBack === 1` is the most recent user turn.
 */
export function buildTurnAnchors(messages: readonly MessageLike[]): TurnAnchor[] {
	const userIndexes: number[] = [];
	for (let index = 0; index < messages.length; index++) {
		if (messages[index]?.role === "user") userIndexes.push(index);
	}

	const taken = new Set<string>();
	const anchors: TurnAnchor[] = [];
	for (let position = userIndexes.length - 1; position >= 0; position--) {
		const index = userIndexes[position];
		const message = messages[index];
		if (!message) continue;
		const id = anchorId(message.timestamp, taken);
		taken.add(id);
		const trailing = messages.slice(index);
		anchors.push({
			id,
			timestamp: message.timestamp,
			index,
			turnsBack: userIndexes.length - position,
			preview: summarize(messageText(message)),
			trailingMessages: trailing.length,
			trailingTokens: estimateTokens(trailing),
		});
	}
	return anchors;
}

export function findAnchorById(anchors: readonly TurnAnchor[], id: string): TurnAnchor | undefined {
	const wanted = id.trim().toLowerCase();
	return anchors.find((anchor) => anchor.id.toLowerCase() === wanted);
}

export function findAnchorByTurnsBack(anchors: readonly TurnAnchor[], turnsBack: number): TurnAnchor | undefined {
	return anchors.find((anchor) => anchor.turnsBack === turnsBack);
}

function formatTokens(tokens: number): string {
	if (tokens < 1000) return `${tokens}`;
	return `${(tokens / 1000).toFixed(1)}k`;
}

export function renderTurnMap(anchors: readonly TurnAnchor[], limit = 12): string {
	if (anchors.length === 0) return "No user turns in context yet; there is nothing to rewind to.";
	const shown = anchors.slice(0, limit);
	const lines = shown.map((anchor) => {
		const back = anchor.turnsBack === 1 ? "1 turn back " : `${anchor.turnsBack} turns back`;
		const reclaim = `≈${formatTokens(anchor.trailingTokens)} tok`;
		return `  ${anchor.id}  ${back}  ${reclaim.padStart(11)}  ${anchor.preview}`;
	});
	const omitted = anchors.length - shown.length;
	const tail = omitted > 0 ? `\n  … ${omitted} older turn(s) not shown` : "";
	return [
		"Turn map, newest first. Rewinding to an anchor removes that user turn and everything after it.",
		...lines,
		tail,
		"",
		'Call chrono_break again with { action: "rewind", anchor: "<id>", reason: "<what failed>" }.',
	]
		.filter((line) => line !== "")
		.join("\n");
}
