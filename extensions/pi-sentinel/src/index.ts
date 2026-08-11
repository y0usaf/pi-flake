import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * sentinel - detects abrupt run endings and continues them.
 *
 * The failure: a run settles but the final assistant message is a cutoff --
 * mid-sentence, mid-plan, or a promised action that never happened. On
 * settle, a context-free judge (one-shot completion on the session model)
 * inspects a sparse excerpt: the user's request plus the tail of the final
 * assistant message. Verdict ABRUPT queues a follow-up user message that
 * resumes the run. COMPLETE does nothing.
 *
 * Fail-safe direction: any ambiguity (no model, judge error, empty reply)
 * counts as COMPLETE. The extension can under-fire but never loop; a
 * continuation cap bounds the worst case, and stopReason "aborted" (user
 * pressed Esc) is always respected.
 */

const MAX_CONTINUATIONS = 3;
const INTENT_CHARS = 1200;
const TAIL_CHARS = 1600;
const JUDGE_MAX_TOKENS = 256;

const CONTINUE_NUDGE =
	"Your previous reply stopped abruptly before the task was finished. " +
	"Continue from exactly where you stopped and complete the original request. " +
	"Do not restart, re-plan, or re-explain work already done.";

interface ContentBlock {
	type?: string;
	text?: string;
}

interface AssistantLike {
	role: string;
	stopReason?: string;
	content?: ContentBlock[];
}

function textOf(message: AssistantLike): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((c): c is { type: string; text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

function buildJudgePrompt(intent: string, tail: string): string {
	return [
		"You are auditing a transcript excerpt from an AI coding assistant.",
		"Decide whether the assistant's final message is a proper ending (task finished, question asked of the user, or a deliberate stop) or an abrupt cutoff (ends mid-sentence, mid-plan, or announces an action that never appears).",
		"",
		"User request (truncated):",
		intent.slice(0, INTENT_CHARS),
		"",
		"Final assistant message (tail):",
		tail.length > 0 ? tail.slice(-TAIL_CHARS) : "(no text content)",
		"",
		"Reply with exactly one word: COMPLETE or ABRUPT.",
	].join("\n");
}

export default function (pi: ExtensionAPI): void {
	let intent = "";
	let continuations = 0;
	let lastAssistant: AssistantLike | undefined;
	let judging = false;

	pi.on("input", (event) => {
		// Extension-sourced messages include our own nudges; they must not
		// reset the cap or the loop would never terminate.
		if (event.source === "extension") return;
		intent = event.text;
		continuations = 0;
	});

	pi.on("agent_end", (event) => {
		const assistants = event.messages.filter((m) => m.role === "assistant");
		lastAssistant = assistants[assistants.length - 1] as AssistantLike | undefined;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (judging) return;
		const message = lastAssistant;
		lastAssistant = undefined;
		if (!message || !intent) return;
		if (continuations >= MAX_CONTINUATIONS) return;

		// User pressed Esc: an intentional stop, never continue.
		if (message.stopReason === "aborted") return;

		let verdict: "COMPLETE" | "ABRUPT";
		if (message.stopReason === "length" || message.stopReason === "error") {
			// Provider truncation or error is abrupt by definition; skip the judge.
			verdict = "ABRUPT";
		} else {
			const model = ctx.model;
			if (!model) return;
			judging = true;
			try {
				const response = await ctx.modelRegistry.complete(
					model,
					{
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: buildJudgePrompt(intent, textOf(message)) }],
								timestamp: Date.now(),
							},
						],
					},
					{ maxTokens: JUDGE_MAX_TOKENS, cacheRetention: "none" },
				);
				if (response.stopReason === "error") {
					// complete() resolves errors as a message, it never throws;
					// without this check a broken judge is an invisible COMPLETE.
					ctx.ui.notify(
						`sentinel: judge failed (${(response as { errorMessage?: string }).errorMessage ?? "unknown error"})`,
						"warning",
					);
					return;
				}
				const reply = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join(" ");
				verdict = /\bABRUPT\b/i.test(reply) ? "ABRUPT" : "COMPLETE";
			} catch {
				// Judge unavailable: fail toward doing nothing.
				return;
			} finally {
				judging = false;
			}
		}

		if (verdict === "COMPLETE") return;
		// The judge call is async; if the user started typing meanwhile,
		// their turn wins.
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

		continuations++;
		ctx.ui.notify(
			`sentinel: run ended abruptly, continuing (${continuations}/${MAX_CONTINUATIONS})`,
			"warning",
		);
		pi.sendUserMessage(CONTINUE_NUDGE, { deliverAs: "followUp" });
	});
}
