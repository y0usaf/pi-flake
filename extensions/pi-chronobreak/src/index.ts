import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectLoop } from "./detector";

/**
 * chronobreak - terminates assistant generation loops.
 *
 * The failure: the model emits the same prose/sentence over and over inside
 * one turn, never settling on an action, and every repetition appends to the
 * session (output degradation). On detection: abort the run, scrub the
 * polluted assistant message down to a one-line marker, re-inject a nudge
 * that re-runs the turn with a decisive-action directive.
 *
 * Spectator: never touches files or the JS kernel. Only aborts generation,
 * replaces one assistant message, and queues a user message.
 */

const MAX_STRIKES = 3; // per user-turn give-up: no abort/re-run spin loop
const SCRUB_TEXT = "[generation loop terminated by chronobreak - re-running]";

export default function (pi: ExtensionAPI): void {
  let terminating = false;
  let pendingNudge: string | undefined;
  let strike = 0;

  function textOf(message: { content?: Array<{ type?: string; text?: string }> }): string {
    if (!message.content) return "";
    return message.content
      .filter((c): c is { type: string; text: string } => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
  }

  function buildNudge(sample: string): string {
    const sampleLine = sample ? '\n\nRepeat detected: "' + sample + '"' : "";
    return (
      "chronobreak terminated a generation loop in your previous attempt." +
      sampleLine +
      "\n\nDo NOT repeat yourself. Re-answer the task you were working on with ONE decisive action " +
      "in this message: either a single clean tool call, or a direct final answer. Do not restate intent."
    );
  }

  pi.on("message_start", (event) => {
    if (event.message.role !== "assistant") return;
    terminating = false;
  });

  pi.on("message_update", (event, ctx) => {
    if (terminating) return;
    if (event.message.role !== "assistant") return;
    const text = textOf(event.message as never);
    if (text.length === 0) return;
    const verdict = detectLoop(text);
    if (!verdict.looping) return;

    terminating = true;
    strike++;
    if (strike >= MAX_STRIKES) {
      ctx.ui.notify(
        "chronobreak: generation loop detected, but strike limit (" + MAX_STRIKES + ") reached. Aborting without re-run.",
        "error",
      );
    } else {
      ctx.ui.notify(
        'chronobreak: generation loop detected ("' + verdict.sample + '"). Re-running the turn.',
        "warning",
      );
      pendingNudge = buildNudge(verdict.sample);
    }
    ctx.abort();
  });

  // The aborted assistant message is persisted by pi; scrub it to a one-line
  // marker so the repeated garbage never stays in context.
  pi.on("message_end", (event) => {
    if (!terminating) return;
    if (event.message.role !== "assistant") return;
    terminating = false;
    return {
      message: {
        ...event.message,
        content: [{ type: "text" as const, text: SCRUB_TEXT }],
      },
    };
  });

  pi.on("agent_end", () => {
    if (!pendingNudge) return;
    const nudge = pendingNudge;
    pendingNudge = undefined;
    pi.sendUserMessage(nudge, { deliverAs: "followUp" });
  });

  // User-driven input is a fresh direction: reset the strike counter.
  pi.on("input", (event) => {
    if (event.source === "extension") return;
    strike = 0;
  });
}
