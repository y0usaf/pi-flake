/** Pure loop-detection core: text in, verdict out. No I/O, no state. */

export const MAX_SEGMENT_REPEAT = 3;
export const MIN_CHUNK_LEN = 12;

export interface LoopVerdict {
  looping: boolean;
  sample: string;
  count: number;
}

export function keyOf(chunk: string): string {
  return chunk
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim()
    .toLowerCase();
}

export function segmentize(text: string): string[] {
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
