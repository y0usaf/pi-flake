/** Pure loop-detection core: text in, verdict out. No I/O, no state. */

export const MAX_SEGMENT_REPEAT = 3;
export const MIN_CHUNK_LEN = 12;

export interface LoopVerdict {
  looping: boolean;
  sample: string;
  count: number;
  /** Char offset into the raw text where the looping begins (the earliest
   *  first occurrence of a repeated segment). When not looping, this is the
   *  full text length. */
  loopStart: number;
}

export function keyOf(chunk: string): string {
  return chunk
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim()
    .toLowerCase();
}

interface SegmentWithOffset {
  key: string;
  /** Char offset of this segment's start in the raw text. */
  start: number;
}

export function segmentize(text: string): string[] {
  return segmentizeWithOffsets(text).map((s) => s.key);
}

/** Like segmentize but keeps each segment's starting offset in the raw text. */
function segmentizeWithOffsets(text: string): SegmentWithOffset[] {
  const segments: SegmentWithOffset[] = [];
  // Split on sentence-ending punctuation + whitespace, or newlines. The split
  // overlaps both cases, so scanning with regex.exec keeps exact offsets while
  // the documented segmentize() still works via the same source of truth.
  const sepRe = /(?<=[.!?])\s+|\r?\n+/g;
  let searchFrom = 0;
  let m: RegExpExecArray | null;
  while ((m = sepRe.exec(text))) {
    const chunk = text.slice(searchFrom, m.index);
    const key = keyOf(chunk);
    if (key.length >= MIN_CHUNK_LEN) segments.push({ key, start: searchFrom });
    searchFrom = m.index + m[0].length;
  }
  const last = text.slice(searchFrom);
  const keyLast = keyOf(last);
  if (last.length > 0 && keyLast.length >= MIN_CHUNK_LEN) {
    segments.push({ key: keyLast, start: searchFrom });
  }
  return segments;
}

/**
 * Verdict is computed fresh from the full text. This is deliberate: the
 * message_update event carries the WHOLE accumulated message, so keeping
 * counts across calls would double-count earlier segments and false-trigger.
 */
export function detectLoop(text: string): LoopVerdict {
  const withOffsets = segmentizeWithOffsets(text);
  const counts = new Map<string, number>();
  let sample = "";
  let count = 0;
  for (const { key } of withOffsets) {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > count) {
      count = n;
      sample = key;
    }
  }
  let loopStart = text.length;
  if (count >= MAX_SEGMENT_REPEAT) {
    const repeated = new Set<string>();
    for (const [key, n] of counts) {
      if (n >= MAX_SEGMENT_REPEAT) repeated.add(key);
    }
    const firstRepeated = withOffsets.find((s) => repeated.has(s.key));
    if (firstRepeated) loopStart = firstRepeated.start;
  }
  return { looping: count >= MAX_SEGMENT_REPEAT, sample, count, loopStart };
}
