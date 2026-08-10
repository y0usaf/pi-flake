/** Pure loop-detection core: text in, verdict out. No I/O, no state.
 *
 * v2 — three tiers, all pure and recomputed from the full text on every call:
 *   tier 1  exact      (unchanged) verbatim normalized segment >=3 times.
 *   tier 2  stall      (paraphrase-tolerant, distribution-free) the model keeps
 *                      restating the same intent with different wording and never
 *                      settles; detected as pairwise near-duplication whose
 *                      growing tail is lexically exhausted (redundant + low novelty).
 *   tier 3  fragment   verbless/utterance degeneracies ("42. 42." / "yes." x60)
 *                      that evade the MIN_CHUNK_LEN floor.
 *
 * The loop's real signature is behavioral *stall*, not any content shape, so
 * nothing here assumes "let me <verb> <object>" — it fires on calculus loops,
 * "is-42" loops, code loops, and unknown distributions alike.
 */

export const MAX_SEGMENT_REPEAT = 3;
export const MIN_CHUNK_LEN = 12;

// tier 2 (stall) tuning
export const STALL_MIN_TEXT_LEN = 400;
export const STALL_MIN_SEGMENTS = 6;
export const STALL_MIN_REDUNDANT = 5;
export const STALL_RATIO = 0.5; // redundant / (N-1) whole-message
export const STALL_TAIL = 5; // last N segments = "settling now" window
export const STALL_TAIL_ECHO = 0.6; // >= this fraction of the tail redundant
export const STALL_MAX_NOVELTY = 0.5; // tail introduces <= this new content
export const STALL_ENUM_CORE_RATIO = 0.6; // core/token shared by ALL redundant members; >= this = template enumeration (exempt)
export const STALL_NEAR_JACCARD = 0.5;
export const STALL_NEAR_MIN_INTER = 3;
export const STALL_NEAR_CONTAINMENT = 0.6;

// tier 3 (fragment / verbless) tuning
export const FRAG_MIN_TEXT_LEN = 30;
export const FRAG_MIN_COUNT = 6;
export const FRAG_MAX_UNIQUE_RATIO = 0.3;
export const FRAG_MIN_DOMINANT = 4;

export type LoopKind = "exact" | "stall" | "fragment";

export interface LoopVerdict {
  looping: boolean;
  sample: string;
  count: number;
  /** Which tier fired. */
  kind: LoopKind;
  /** Char offset into the raw text where the looping begins (the earliest
   *  first occurrence of the repeated/stall material). When not looping, this
   *  is the full text length. */
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

/* ------------------------------------------------------------------ */
/* tier 1 — exact (unchanged)                                          */
/* ------------------------------------------------------------------ */

function detectExactLoop(text: string, withOffsets: SegmentWithOffset[]): LoopVerdict {
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
  return { looping: count >= MAX_SEGMENT_REPEAT, sample, count, kind: "exact", loopStart };
}

/* ------------------------------------------------------------------ */
/* tier 2 — stall loop (paraphrase-tolerant, distribution-free)        */
/* ------------------------------------------------------------------ */

/** Light, language-tolerant stemming: drop a trailing plural "s" only. */
function stem(tok: string): string {
  if (tok.length > 4 && tok.endsWith("s") && !tok.endsWith("ss") && !tok.endsWith("us") && !tok.endsWith("is")) {
    return tok.slice(0, -1);
  }
  return tok;
}

/** Content tokens from a segment: lowercase alnum words, len>=2, stemmed. Sets. */
function contentTokens(key: string): Set<string> {
  const out = new Set<string>();
  for (const t of key.split(" ")) {
    if (t.length >= 2) out.add(stem(t));
  }
  return out;
}

function nearDup(a: Set<string>, b: Set<string>): boolean {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const jaccard = inter / Math.max(1, a.size + b.size - inter);
  if (jaccard >= STALL_NEAR_JACCARD) return true;
  const containment = inter / Math.max(1, Math.min(a.size, b.size));
  return inter >= STALL_NEAR_MIN_INTER && containment >= STALL_NEAR_CONTAINMENT;
}

/** Tail novelty: fraction of distinct tail content tokens unseen before the tail.
 *  Numbers/identifiers are kept by keyOf, so a progressing proof/list lowers it. */
function tailNovelty(tokens: Set<string>[], tailStart: number): number {
  if (tailStart >= tokens.length) return 0;
  const seen = new Set<string>();
  for (let i = 0; i < tailStart; i++) for (const t of tokens[i]) seen.add(t);
  const tail = new Set<string>();
  for (let i = tailStart; i < tokens.length; i++) for (const t of tokens[i]) tail.add(t);
  if (tail.size === 0) return 0;
  let novel = 0;
  for (const t of tail) if (!seen.has(t)) novel++;
  return novel / tail.size;
}

function detectStallLoop(text: string, withOffsets: SegmentWithOffset[]): LoopVerdict {
  const n = withOffsets.length;
  const notLoop: LoopVerdict = { looping: false, sample: "", count: 0, kind: "stall", loopStart: text.length };
  if (text.length < STALL_MIN_TEXT_LEN || n < STALL_MIN_SEGMENTS) return notLoop;

  const tokens = withOffsets.map((s) => contentTokens(s.key));
  // redundant[j] = exists i<j with nearDup(i,j). Redundancy is directional (a
  // later utterance folding into an earlier one) so a single topic word alone
  // can't chain arbitrary segments together.
  const redundant = new Array<boolean>(n).fill(false);
  let firstRedundantStart = -1;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < j; i++) {
      if (nearDup(tokens[i], tokens[j])) {
        redundant[j] = true;
        if (firstRedundantStart < 0) firstRedundantStart = withOffsets[j].start;
        break;
      }
    }
  }

  let R = 0;
  for (let j = 0; j < n; j++) if (redundant[j]) R++;
  if (R < STALL_MIN_REDUNDANT) return notLoop;

  const wholeRatio = R / Math.max(1, n - 1);
  const denom = Math.min(STALL_TAIL, n);
  let tailEcho = 0;
  for (let j = n - denom; j < n; j++) if (redundant[j]) tailEcho++;
  tailEcho /= denom;

  const novelty = tailNovelty(tokens, n - denom);
  if (novelty > STALL_MAX_NOVELTY) return notLoop;

  // Enumeration exemption: if the redundant members share a LARGE core (the whole
  // skeleton, each differing by just one payload word), it's a template enumeration
  // ("I updated docs for X module" x14) — legitimate list of distinct work, not a loop.
  // A loop shares only a tiny intent core ("update doc") while rewordings diverge.
  const redIdx = redundant.map((r, i) => (r ? i : -1)).filter((i) => i >= 0);
  if (redIdx.length >= 3) {
    const core = new Set<string>(tokens[redIdx[0]]);
    for (const i of redIdx) for (const t of [...core]) if (!tokens[i].has(t)) core.delete(t);
    const sizes = redIdx.map((i) => tokens[i].size).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)];
    if (median > 0 && core.size / median >= STALL_ENUM_CORE_RATIO) return notLoop;
  }

  const looping = wholeRatio >= STALL_RATIO || tailEcho >= STALL_TAIL_ECHO;
  if (!looping) return notLoop;

  // sample: most-frequent redundant segment key
  const freq = new Map<string, number>();
  for (let j = 1; j < n; j++) {
    if (!redundant[j]) continue;
    freq.set(withOffsets[j].key, (freq.get(withOffsets[j].key) ?? 0) + 1);
  }
  let sample = "";
  let best = 0;
  for (const [k, c] of freq) if (c > best) { best = c; sample = k; }

  return {
    looping: true,
    sample,
    count: R,
    kind: "stall",
    loopStart: firstRedundantStart >= 0 ? firstRedundantStart : text.length,
  };
}

/* ------------------------------------------------------------------ */
/* tier 3 — fragment / verbless loop                                   */
/* ------------------------------------------------------------------ */

function detectFragmentLoop(text: string): LoopVerdict {
  const notLoop: LoopVerdict = { looping: false, sample: "", count: 0, kind: "fragment", loopStart: text.length };
  if (text.length < FRAG_MIN_TEXT_LEN) return notLoop;
  const frags = text.split(/(?<=[.!?])\s+|\r?\n+/).map(keyOf).filter((s) => s.length > 0);
  if (frags.length < FRAG_MIN_COUNT) return notLoop;
  const counts = new Map<string, number>();
  for (const f of frags) counts.set(f, (counts.get(f) ?? 0) + 1);
  const uniq = counts.size;
  if (uniq / frags.length > FRAG_MAX_UNIQUE_RATIO) return notLoop;
  let dominant = "";
  let domCount = 0;
  for (const [f, c] of counts) if (c > domCount) { domCount = c; dominant = f; }
  if (domCount < FRAG_MIN_DOMINANT) return notLoop;

  // loopStart = raw offset of the dominant fragment's 2nd occurrence
  let loopStart = text.length;
  const re = new RegExp("\\b" + dominant.split(" ").join("\\b.*?\\b") + "\\b");
  let seen = 0;
  let mi: RegExpExecArray | null;
  while ((mi = re.exec(text))) {
    seen++;
    if (seen === 2) { loopStart = mi.index; break; }
    re.lastIndex = mi.index + 1;
  }
  return { looping: true, sample: dominant, count: domCount, kind: "fragment", loopStart };
}

/* ------------------------------------------------------------------ */
/* public entry                                                        */
/* ------------------------------------------------------------------ */

/**
 * Verdict is computed fresh from the full text. This is deliberate: the
 * message_update event carries the WHOLE accumulated message, so keeping
 * counts across calls would double-count earlier segments and false-trigger.
 */
export function detectLoop(text: string): LoopVerdict {
  const withOffsets = segmentizeWithOffsets(text);
  const exact = detectExactLoop(text, withOffsets);
  if (exact.looping) return exact;
  const stall = detectStallLoop(text, withOffsets);
  if (stall.looping) return stall;
  return detectFragmentLoop(text);
}
