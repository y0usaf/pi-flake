import { fabricExecTitleHint } from "./fabric-code-parser.js";

// Session-wide memo for the lexical fallback title, keyed by the exact program
// string. The same key recurs in three places — the compact renderCall card
// (re-rendered on every streaming tick), the activity store start, and
// compaction normalization over recorded arguments — so one tokenize pass per
// unique program covers all three. Bounded with insertion-order eviction: run
// names stay cheap for arbitrarily long sessions without retention growth.
const TITLE_HINT_CACHE_MAX = 256;

const titleHintCache = new Map<string, string | undefined>();

export const fabricExecTitleHintCached = (code: string): string | undefined => {
  const hit = titleHintCache.get(code);
  if (hit !== undefined || titleHintCache.has(code)) return hit;
  const hint = fabricExecTitleHint(code);
  if (titleHintCache.size >= TITLE_HINT_CACHE_MAX) {
    const oldest = titleHintCache.keys().next().value;
    if (oldest !== undefined) titleHintCache.delete(oldest);
  }
  titleHintCache.set(code, hint);
  return hint;
};