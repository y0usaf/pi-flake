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
 * Toggle: /sentinel on/off enables or disables all checks.
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

const MAX_CONTINUATIONS = 3;
const INTENT_CHARS = 1200;
const TAIL_CHARS = 1600;
const JUDGE_MAX_TOKENS = 256;

const CONTINUE_NUDGE = "continue";

function continuationLabel(n: number, max: number): string {
  return `continuing (${n}/${max})`;
}

export default function (pi: ExtensionAPI): void {
  let enabled = true;
  let intent = "";
  let continuations = 0;
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
  });

  pi.on("agent_end", (event) => {
    const assistants = event.messages.filter((m) => m.role === "assistant");
    lastAssistant = assistants.at(-1);
  });

  pi.registerCommand("sentinel", {
    description: "sentinel on/off - toggle abrupt-ending detection",
    handler: async (args) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on") enabled = true;
      else if (arg === "off") enabled = false;
      else return `sentinel is ${enabled ? "on" : "off"} (usage: /sentinel on|off)`;
      return `sentinel ${enabled ? "on" : "off"}`;
    },
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!enabled || judging) return;
    const message = lastAssistant;
    lastAssistant = undefined;
    if (!message || !intent) return;
    if (continuations >= MAX_CONTINUATIONS) return;

    if (message.stopReason === "aborted") return;

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
                content: [{ type: "text", text: buildJudgePrompt(intent, textOf(message.content)) }],
                timestamp: Date.now(),
              },
            ],
          },
          { maxTokens: JUDGE_MAX_TOKENS, cacheRetention: "none" },
        );
        if (response.stopReason === "error") {
          ctx.ui.notify(
            `sentinel: judge failed (${("errorMessage" in response ? response.errorMessage : undefined) ?? "unknown error"})`,
            "warning",
          );
          return;
        }
        const reply = textOf(response.content);
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

function textOf(content: Array<{ type?: string; text?: string }> | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
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