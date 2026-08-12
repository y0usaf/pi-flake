import type { ExtensionAPI, AfterProviderResponseEvent } from "@earendil-works/pi-coding-agent";

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
 * Also detects transient provider errors (5xx, 429) at HTTP level via
 * after_provider_response, before the stream is consumed. Any such error
 * on the last turn forces a retry without running the judge.
 *
 * Fail-safe direction: any ambiguity (no model, judge error, empty reply)
 * counts as COMPLETE. The extension can under-fire but never loop; a
 * continuation cap bounds the worst case, and stopReason "aborted" (user
 * pressed Esc) is always respected.
 */

// PI_RETRY_MAX env var: default 3 (0 = no cap = infinite).
const MAX_CONTINUATIONS = (() => {
  const v = process.env.PI_RETRY_MAX;
  if (v === undefined || v === "") return 3;
  if (v === "0") return Infinity;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();
const INTENT_CHARS = 1200;
const TAIL_CHARS = 1600;
const JUDGE_MAX_TOKENS = 256;

const CONTINUE_NUDGE = "continue";

function continuationLabel(n: number, max: number): string {
  return max === Infinity ? `continuing (${n})` : `continuing (${n}/${max})`;
}

export default function (pi: ExtensionAPI): void {
  let intent = "";
  let continuations = 0;
  let providerErrorStatus: number | undefined; // HTTP status from after_provider_response
  let retriedFromContinue = false; // true after sentinel sends "continue" for a provider error; prevents re-sending on the same cycle
  let lastAssistant: {
    role: string;
    stopReason?: string;
    content?: Array<{ type?: string; text?: string }>;
  } | undefined;
  let judging = false;

  pi.on("input", (event) => {
    if (event.source === "extension") return;
    intent = event.text;
    continuations = 0;
    providerErrorStatus = undefined;
    retriedFromContinue = false;
  });

  pi.on("agent_end", (event) => {
    const assistants = event.messages.filter((m) => m.role === "assistant");
    lastAssistant = assistants[assistants.length - 1] as typeof lastAssistant;
  });

  pi.on("after_provider_response", (event: AfterProviderResponseEvent) => {
    if (event.status >= 500 || event.status === 429) {
      providerErrorStatus = event.status;
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (judging) return;
    const message = lastAssistant;
    lastAssistant = undefined;
    if (!message || !intent) return;
    if (continuations >= MAX_CONTINUATIONS) return;

    if (message.stopReason === "aborted") return;

    // Provider returned transient HTTP error — retry immediately, no judge.
    if (providerErrorStatus) {
      if (retriedFromContinue) return;
      retriedFromContinue = true;
      const status = providerErrorStatus;
      providerErrorStatus = undefined;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
      continuations++;
      ctx.ui.notify(
        `sentinel: provider returned ${status}, ${continuationLabel(continuations, MAX_CONTINUATIONS)}`,
        "warning",
      );
      pi.sendUserMessage(CONTINUE_NUDGE, { deliverAs: "followUp" });
      return;
    }

    let verdict: "COMPLETE" | "ABRUPT";

    if (message.stopReason === "length" || message.stopReason === "error") {
      // Provider truncation or error is abrupt by definition; skip judge.
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
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

    continuations++;
    ctx.ui.notify(
      `sentinel: run ended abruptly, ${continuationLabel(continuations, MAX_CONTINUATIONS)}`,
      "warning",
    );
    pi.sendUserMessage(CONTINUE_NUDGE, { deliverAs: "followUp" });
  });
}

function textOf(message: {
  content?: Array<{ type?: string; text?: string }>;
}): string {
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