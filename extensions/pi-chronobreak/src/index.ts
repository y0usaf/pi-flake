import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * chronobreak - terminates assistant generation loops.
 *
 * The failure: the model emits the same prose/sentence over and over inside
 * one turn, never settling on an action, and every repetition appends to the
 * session (output degradation). On detection: abort the run, scrub the
 * polluted assistant message down to a one-line marker, re-inject a nudge
 * that re-runs the turn with a decisive-action directive. There is no strike
 * limit: every detected loop is cut and re-run, indefinitely.
 *
 * Spectator: never touches files or the JS kernel. Only aborts generation,
 * replaces one assistant message, and queues a user message.
 */

const SCRUB_TEXT = "[generation loop terminated by chronobreak - re-running]";

// --- Loop detection core (pure: text in, verdict out, no state) ---

const MAX_SEGMENT_REPEAT = 3;
const MIN_CHUNK_LEN = 12;

export interface LoopVerdict {
  looping: boolean;
  sample: string;
  count: number;
}

function keyOf(chunk: string): string {
  return chunk
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim()
    .toLowerCase();
}

function segmentize(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(keyOf)
    .filter((s) => s.length >= MIN_CHUNK_LEN);
}

/**
 * Verdict is computed fresh from the full text. This is deliberate: the
 * message_update event carries the WHOLE accumulated message, so keeping
 * counts across calls would double-count earlier segments and false-trigger.
 */
export function detectLoop(text: string): LoopVerdict {
  const counts = new Map<string, number>();
  let sample = "";
  let count = 0;
  for (const key of segmentize(text)) {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > count) {
      count = n;
      sample = key;
    }
  }
  return { looping: count >= MAX_SEGMENT_REPEAT, sample, count };
}

export default function (pi: ExtensionAPI): void {
  let terminating = false;
  let pendingNudge: string | undefined;

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
    ctx.ui.notify(
      'chronobreak: generation loop detected ("' + verdict.sample + '"). Re-running the turn.',
      "warning",
    );
    pendingNudge = buildNudge(verdict.sample);
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
}
