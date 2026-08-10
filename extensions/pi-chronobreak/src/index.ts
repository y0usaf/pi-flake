import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectLoop } from "./detector";

/**
 * chronobreak - terminates assistant generation loops.
 *
 * The failure: a model emits the same prose over and over inside one turn,
 * never settling on an action. On detection: abort the run, scrub the
 * polluted assistant message down to a marker, and let the model retry.
 *
 * Athwart the content question: the loop's real signature is behavioral
 * STALL, so a message that has emitted a tool call is by definition
 * progressing and is NEVER eligible for cutting. Only pure-prose output that
 * is lexically exhausted (redundant + low novelty) can be a loop.
 *
 * Thinking blocks are scanned too: the observed degeneration ("Let me update
 * the doc." restated dozens of ways) happens inside thinking just as often as
 * in visible text. Text and thinking are scanned as separate streams so a
 * loop in one is never diluted by variety in the other.
 *
 * Spectator: never touches files or the JS kernel. Only aborts generation
 * and replaces the assistant message with a scrub marker.
 */

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
  let soleLoopStart = -1; // -1: no scrub lead-in captured yet
  let loopInThinking = false; // where the detected loop lives

  /** Text of a message: only non-thinking text blocks. Tool-call content is
   *  excluded — a toolCall makes the message ineligible anyway (handled
   *  before this is called). */
  function textOf(message: { content?: Array<{ type?: string; text?: string }> }): string {
    if (!message.content) return "";
    return message.content.filter(isTextBlock).map((c) => c.text).join("\n");
  }

  /** Thinking text of a message: thinking blocks only, scanned as their own
   *  stream so loops there are not diluted by varied visible text. */
  function thinkingOf(message: { content?: Array<{ type?: string; thinking?: string }> }): string {
    if (!message.content) return "";
    return message.content
      .filter((c): c is { type: string; thinking: string } => c.type === "thinking" && typeof c.thinking === "string")
      .map((c) => c.thinking)
      .join("\n");
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
    let verdict = text.length > 0 ? detectLoop(text) : undefined;
    let inThinking = false;
    if (!verdict?.looping) {
      const thinking = thinkingOf(event.message as never);
      verdict = thinking.length > 0 ? detectLoop(thinking) : undefined;
      inThinking = true;
    }
    if (!verdict?.looping) return;

    terminating = true;
    loopInThinking = inThinking;
    soleLoopStart = verdict.loopStart;
    ctx.ui.notify(
      'chronobreak: generation loop detected ("' + verdict.sample + '" ' + verdict.kind + "). Re-running the turn.",
      "warning",
    );
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
    const inThinking = loopInThinking;
    loopInThinking = false;
    const full = textOf(event.message as never);
    let kept: string;
    if (inThinking) {
      // The loop lived in thinking: drop all thinking, keep the (non-looping)
      // visible text if any, and mark the cut.
      const lead = full.trim();
      kept = lead ? lead + TRUNCATE_NOTE : SCRUB_TEXT;
    } else if (loopStart > 0 && loopStart < full.length) {
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


}
