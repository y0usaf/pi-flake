/**
 * Structural mirrors of the pi message/entry shapes this extension touches.
 *
 * They are declared locally, rather than imported from
 * `@earendil-works/pi-coding-agent`, so that every pure module (turns.ts,
 * filter.ts, state.ts) stays import-free and therefore runnable under
 * `bun test` inside the Nix sandbox, where no node_modules exist.
 */

export const CUT_ENTRY_TYPE = "chrono-break-cut";
export const UNDO_ENTRY_TYPE = "chrono-break-undo";
export const BREADCRUMB_TYPE = "chrono-break";

/**
 * Ledger entry for a cut you performed by hand through `/chrono cut`.
 *
 * Deliberately a different customType from CUT_ENTRY_TYPE. A manual cut is a
 * real leaf move performed by pi, so those turns are already off the active
 * branch; feeding it to the context filter as well would try to drop messages
 * that are no longer there, and its timestamp window would then bite into the
 * new branch. Manual records are for display and for `/chrono` only, and are
 * never parsed into CutMarkers.
 */
export const MANUAL_ENTRY_TYPE = "chrono-break-manual";

export interface TextBlock {
	type: "text";
	text: string;
}

export interface ThinkingBlock {
	type: "thinking";
	thinking: string;
}

export interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | { type: string; [key: string]: unknown };

/** Any message pi hands to the `context` hook. Only the fields we read are typed. */
export interface MessageLike {
	role: string;
	timestamp: number;
	content?: string | ContentBlock[];
	/** present on role === "toolResult" */
	toolCallId?: string;
	toolName?: string;
	/** present on role === "custom" */
	customType?: string;
	display?: boolean;
	details?: unknown;
	[key: string]: unknown;
}

/**
 * One rewind. Written to the session as a custom entry so it survives restart.
 *
 * `breadcrumb` is frozen at creation on purpose: it is replayed verbatim into
 * every later request, and any drift in that string would move the provider's
 * prompt-cache boundary and force a full re-read of the conversation prefix.
 */
export interface CutMarker {
	id: string;
	/** timestamp (ms) of the first message removed; always a user message */
	cutAt: number;
	/** ms; upper bound of the removal window, captured when the tool ran */
	createdAt: number;
	reason: string;
	breadcrumb: string;
	turnsBack: number;
	droppedMessages: number;
	droppedTokens: number;
}

/** A rewindable point: one user message and everything that followed it. */
export interface TurnAnchor {
	id: string;
	timestamp: number;
	index: number;
	/** 1 = the most recent user turn */
	turnsBack: number;
	preview: string;
	/** messages from this user message to the end of the transcript */
	trailingMessages: number;
	/** estimated tokens from this user message to the end of the transcript */
	trailingTokens: number;
}

/**
 * A `/chrono cut` navigation that this extension started and has not finished.
 *
 * It exists so the `session_before_tree` handler can tell our own navigation
 * apart from one you started with plain `/tree`. Without this, the handler
 * would hijack every tree navigation in the session and you would lose pi's
 * normal branch summary. The handler only acts when the target id matches.
 */
export interface PendingManualCut {
	targetId: string;
	reason: string;
	/** "frozen": use our one-liner. "llm": stand aside and let pi summarize. */
	mode: "frozen" | "llm";
}

/** Ledger record of a completed manual cut. Display only; never filtered. */
export interface ManualCutRecord {
	targetId: string;
	reason: string;
	mode: "frozen" | "llm";
	entriesLeft: number;
	createdAt: number;
}
