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
 * Athwart the content question: the loop's real signature is behavioral
 * STALL, so a message that has emitted a tool call is by definition
 * progressing and is NEVER eligible for cutting. Only pure-prose output that
 * is lexically exhausted (redundant + low novelty) can be a loop.
 *
 * Spectator: never touches files or the JS kernel. Only aborts generation,
 * replaces one assistant message, and queues a user message.
 */

const MAX_STRIKES = 3; // per user-turn give-up: no abort/re-run spin loop
const SCRUB_TEXT = "[generation loop terminated by chronobreak - re-running]";
const TRUNCATE_NOTE = "\n\n[chronobreak: generation loop truncated here]";

function isToolCallBlock(c: { type?: string }): boolean {
  return c.type === "toolCall";
}
function isTextBlock(c: { type?: string; text?: string }): c is { type: string; text: string } {
  return c.type === "text" && typeof c.text === "string";
}

export default function (pi: ExtensionAPI): void {
  let terminating = false;
  let pendingNudge: string | undefined;
  let soleLoopStart = -1; // -1: no scrub lead-in captured yet
  let strike = 0;

  /** Text of a message: only non-thinking text blocks. Thinking and tool-call
   *  content are excluded — thinking is never inspected, and a toolCall makes
   *  the message ineligible anyway (handled before this is called). */
  function textOf(message: { content?: Array<{ type?: string; text?: string }> }): string {
    if (!message.content) return "";
    return message.content.filter(isTextBlock).map((c) => c.text).join("\n");
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

    // Behavioral eligibility gate: a progressing turn (one that has emitted a
    // tool call) is never a loop. This is the distribution-free discriminator.
    const content = event.message.content as Array<{ type?: string; text?: string }> | undefined;
    if (content?.some(isToolCallBlock)) return;

    const text = textOf(event.message as never);
    if (text.length === 0) return;
    const verdict = detectLoop(text);
    if (!verdict.looping) return;

    terminating = true;
    soleLoopStart = verdict.loopStart;
    strike++;
    if (strike >= MAX_STRIKES) {
      ctx.ui.notify(
        "chronobreak: generation loop detected, but strike limit (" + MAX_STRIKES + ") reached. Aborting without re-run.",
        "error",
      );
    } else {
      ctx.ui.notify(
        'chronobreak: generation loop detected ("' + verdict.sample + '" ' + verdict.kind + "). Re-running the turn.",
        "warning",
      );
      pendingNudge = buildNudge(verdict.sample);
    }
    ctx.abort();
  });

  // The aborted assistant message is persisted by pi; rewrite it to keep the
  // coherent text before the loop began and drop the repeated tail, with the
  // marker at the cut point so the model never sees the looped garbage again.
  pi.on("message_end", (event) => {
    if (!terminating) return;
    if (event.message.role !== "assistant") return;
    terminating = false;
    const loopStart = soleLoopStart;
    soleLoopStart = -1;
    const full = textOf(event.message as never);
    let kept: string;
    if (loopStart > 0 && loopStart < full.length) {
      // Keep the lead-in, trimmed to a clean character boundary, then note.
      const lead = full.slice(0, loopStart).trim();
      kept = lead ? lead + TRUNCATE_NOTE : SCRUB_TEXT;
    } else {
      kept = SCRUB_TEXT;
    }
    return {
      message: {
        ...event.message,
        content: [{ type: "text" as const, text: kept }],
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
