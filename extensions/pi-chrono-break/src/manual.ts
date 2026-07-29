import { buildManualBreadcrumb } from "./state.js";
import type { PendingManualCut } from "./types.js";

export interface TreeSummaryResult {
	summary: { summary: string; details: unknown };
}

/**
 * Decide what our `session_before_tree` handler returns for one navigation.
 *
 * Returning `undefined` means "stand aside": pi then behaves exactly as it does
 * with no extension loaded, which for a plain `/tree` means asking you the
 * usual summarize question and calling a model to write prose.
 *
 * We only supply a summary when all three hold:
 *
 *  1. A `/chrono cut` we started is in flight, and
 *  2. it targets this exact entry, and
 *  3. you chose the frozen one-liner rather than pi's LLM summary.
 *
 * Condition 2 is the load-bearing one. Without it the handler would replace the
 * summary for every tree navigation in the session, including ones you started
 * by hand, and pi's branch summaries would silently disappear.
 */
export function resolveTreeSummary(
	pending: PendingManualCut | undefined,
	targetId: string,
	entriesLeft: number,
): TreeSummaryResult | undefined {
	if (!pending) return undefined;
	if (pending.targetId !== targetId) return undefined;
	if (pending.mode !== "frozen") return undefined;

	return {
		summary: {
			summary: buildManualBreadcrumb(entriesLeft, pending.reason),
			details: { source: "chrono-break", reason: pending.reason, entriesLeft },
		},
	};
}

/** Reject a reason that carries no information for the model to act on. */
export function validateReason(reason: string): string | undefined {
	const clean = reason.replace(/\s+/g, " ").trim();
	if (clean.length < 10) return undefined;
	return clean;
}
