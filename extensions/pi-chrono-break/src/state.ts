import { CUT_ENTRY_TYPE, type CutMarker, UNDO_ENTRY_TYPE } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMarker(data: unknown): CutMarker | undefined {
	if (!isRecord(data)) return undefined;
	const { id, cutAt, createdAt, reason, breadcrumb, turnsBack, droppedMessages, droppedTokens } = data;
	if (typeof id !== "string" || typeof cutAt !== "number" || typeof createdAt !== "number") return undefined;
	if (typeof breadcrumb !== "string" || breadcrumb.length === 0) return undefined;
	return {
		id,
		cutAt,
		createdAt,
		reason: typeof reason === "string" ? reason : "",
		breadcrumb,
		turnsBack: typeof turnsBack === "number" ? turnsBack : 0,
		droppedMessages: typeof droppedMessages === "number" ? droppedMessages : 0,
		droppedTokens: typeof droppedTokens === "number" ? droppedTokens : 0,
	};
}

/**
 * Rebuild the live marker set from the session's custom entries.
 *
 * Session files are append-only, so an undo is recorded as its own entry rather
 * than by deleting the original. Replaying both kinds in file order is what
 * makes a rewind survive `pi -c` and `/resume`: without this, resuming a
 * session would silently resurrect the path the model deliberately abandoned.
 */
export function replayMarkers(entries: readonly unknown[]): CutMarker[] {
	const markers = new Map<string, CutMarker>();
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "custom") continue;
		if (entry.customType === CUT_ENTRY_TYPE) {
			const marker = parseMarker(entry.data);
			if (marker) markers.set(marker.id, marker);
		} else if (entry.customType === UNDO_ENTRY_TYPE) {
			const data = entry.data;
			if (isRecord(data) && typeof data.id === "string") markers.delete(data.id);
		}
	}
	return [...markers.values()].sort((left, right) => left.createdAt - right.createdAt);
}

export function formatTokens(tokens: number): string {
	if (tokens < 1000) return `${tokens}`;
	return `${(tokens / 1000).toFixed(1)}k`;
}

/**
 * The exact string the model will see in place of the removed turns.
 *
 * Built once and stored on the marker. It must not contain anything that can
 * change between requests — no wall-clock time, no "N minutes ago", no counter
 * recomputed at render time — because it sits inside the cached prompt prefix.
 * A string that drifts moves the cache boundary and turns every later request
 * into a full re-read at uncached input price.
 */
export function buildBreadcrumb(turnsBack: number, droppedMessages: number, droppedTokens: number, reason: string): string {
	const turns = turnsBack === 1 ? "1 turn" : `${turnsBack} turns`;
	const cleanReason = reason.replace(/\s+/g, " ").trim();
	return [
		`[chrono-break] Rewound ${turns} (${droppedMessages} messages, ≈${formatTokens(droppedTokens)} tokens removed from context).`,
		`Abandoned approach: ${cleanReason}`,
		"That work is intentionally no longer visible. Do not retry it. Continue from this point with a different approach.",
	].join(" ");
}

/**
 * Breadcrumb for a cut you made by hand through `/chrono cut`.
 *
 * Pi stores this as a real BranchSummaryEntry at the new position, so it is
 * written once and never re-rendered. Unlike the model-driven path there is no
 * token accounting here: those turns are genuinely off the active branch, so
 * there is nothing to report as "removed from context".
 */
export function buildManualBreadcrumb(entriesLeft: number, reason: string): string {
	const entries = entriesLeft === 1 ? "1 entry" : `${entriesLeft} entries`;
	const cleanReason = reason.replace(/\s+/g, " ").trim();
	return [
		`[chrono-break] The user rewound the session past ${entries} of abandoned work.`,
		`Abandoned approach: ${cleanReason}`,
		"That work is intentionally not in context. Do not retry it. Continue from this point with a different approach.",
	].join(" ");
}
