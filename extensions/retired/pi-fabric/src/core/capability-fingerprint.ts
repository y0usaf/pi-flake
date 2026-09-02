import type { FabricActionDescriptor } from "../protocol.js";

// English stopwords plus prose fillers common in tool descriptions that would
// otherwise dominate tf-idf fingerprints and prompt matching.
const CAPABILITY_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "of", "to", "in", "for", "on", "with", "and", "or", "as",
  "by", "at", "from", "into", "one", "this", "that", "it", "its", "their",
  "your", "you", "we", "i", "me", "my", "mine", "us", "is", "are", "be", "been", "current", "existing",
  "please", "thanks",
  // Interrogatives and question fillers: they frame every request, carry no
  // capability intent of their own, and — worst case — collide with identity
  // prose like "recommendations based on what you want to create".
  "what", "how", "who", "whom", "whose", "why", "where", "which",
  "new", "use", "used", "using", "via", "per", "each", "all", "any", "can",
  "will", "also", "not", "no", "if", "when", "then", "else", "than", "so",
  "such", "over", "under", "out", "up", "down", "off", "through", "during",
  "about", "between", "same", "many", "much", "more", "most", "other",
  "some", "only",
]);

export interface CapabilitySourceFingerprint {
  namespace: string;
  label: string;
  toolCount: number;
  names: string[];
  descriptions: string[];
  toolTerms: ReadonlySet<string>[];
  tf: Map<string, number>;
}

export interface CapabilityIndex {
  sourceCount: number;
  sources: CapabilitySourceFingerprint[];
  idf(term: string): number;
  docFrequency(term: string): number;
}

// Matching is latin-alphanumeric only: anything else (notably CJK scripts)
// atomizes to nothing, so a non-latin prompt matches through the latin brand
// words it contains.
export const tokenizeCapabilityText = (text: string): string[] => {
  const matches = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .toLowerCase()
    .match(/[a-z][a-z0-9]{1,}/g);
  if (!matches) return [];
  return matches.filter((token) => !CAPABILITY_STOPWORDS.has(token));
};

// Written words as typed, before any camelCase atomization: original casing
// preserved, deduped case-insensitively in first-seen order. The advisory
// counts these for its vocabulary-overlap gate, so one word is one unit of
// intent regardless of casing ("GitHub" and "github" are each a single word)
// — camelCase atomization must not inflate real vocabulary overlap.
// Corpus candidates for one written word: its camelCase atoms plus the word
// itself, held to the same token rules as the corpus. Both readings mean the
// same vocabulary, so a word's spelling pattern — "GitHub", "github",
// "GITHUB" — never changes what it can match or how much it can weigh.
export const capabilityWordCandidates = (word: string): string[] => {
  const candidates = new Set(tokenizeCapabilityText(word));
  const joined = word.toLowerCase();
  if (/^[a-z][a-z0-9]{1,}$/.test(joined) && !CAPABILITY_STOPWORDS.has(joined)) {
    candidates.add(joined);
  }
  return [...candidates];
};

// Path/URL/filename spans in a prompt: tokens found ONLY inside these denote
// local artifacts ("docs/heat-diffusion.md" is something to read, not evidence
// for any documentation-search capability), so the advisory halves their match
// weight. Filename detection uses an extension allowlist so brand names like
// "fal.ai" stay full-weight prose.
const PATH_SPAN =
  /(?:[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]+)|(?:[\w.~-]+\/[\w./~-]+)|(?:\b[\w~-]+\.(?:md|markdown|txt|tsx?|jsx?|mjs|cjs|mts|cts|jsonc?|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ya?ml|toml|ini|cfg|conf|xml|html?|css|s[ac]ss|less|sql|[ct]sv|lock|log|png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|tar|mp4|mp3|wav|wasm|proto|graphql|vue|svelte)\b)/gi;

// Prompt terms whose every occurrence lives inside a path/URL/filename span.
export const capabilityPathOnlyTerms = (text: string): ReadonlySet<string> => {
  const pathOnly = new Set<string>();
  for (const span of text.match(PATH_SPAN) ?? []) {
    for (const token of tokenizeCapabilityText(span)) pathOnly.add(token);
  }
  if (pathOnly.size === 0) return pathOnly;
  for (const token of tokenizeCapabilityText(text.replace(PATH_SPAN, " "))) {
    pathOnly.delete(token);
  }
  return pathOnly;
};

export const splitCapabilityWords = (text: string): string[] => {
  const words = text.match(/[A-Za-z0-9]+/g);
  if (!words) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const word of words) {
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(word);
  }
  return result;
};

// Script profile in word units: one per latin letter-run, one per non-latin
// letter (digits and punctuation are script-neutral). A prompt whose non-latin
// letters outnumber its latin words is non-latin prose, where latin
// vocabulary-collision odds collapse: reaching for a latin brand word inside
// it means crossing a script boundary on purpose.
export const isMostlyNonLatinPrompt = (text: string): boolean => {
  const latinWords = text.match(/[A-Za-z]+/g)?.length ?? 0;
  const nonLatinLetters = (text.match(/\p{L}/gu) ?? []).reduce(
    (count, ch) => (/\p{Script=Latin}/u.test(ch) ? count : count + 1),
    0,
  );
  return nonLatinLetters > latinWords;
};

const SOURCE_LABEL_PREFIX = "extension:";

export const capabilitySourceLabel = (namespace: string | undefined): string =>
  namespace !== undefined && namespace.startsWith(SOURCE_LABEL_PREFIX)
    ? namespace.slice(SOURCE_LABEL_PREFIX.length)
    : (namespace ?? "unscoped");

// Capability fingerprints group captured tools by source namespace: a source's
// identity surface (tool names + the leading sentence of each description)
// gives far stronger signal than any single tool, and per-source tf-idf terms
// end up readable as capability labels without requiring manifest declarations
// or a curated taxonomy. Instructional description tails are deliberately not
// indexed — their meta-prose ("Use this when you need to understand…") is
// shared by every server and collides with interrogative user prompts.
export const buildCapabilityIndex = (
  descriptors: FabricActionDescriptor[],
): CapabilityIndex => {
  const grouped = new Map<string, FabricActionDescriptor[]>();
  for (const descriptor of descriptors) {
    const namespace = descriptor.namespace ?? "unscoped";
    const bucket = grouped.get(namespace);
    if (bucket) bucket.push(descriptor);
    else grouped.set(namespace, [descriptor]);
  }
  const sourceCount = grouped.size;
  const documentFrequency = new Map<string, number>();
  const sources: CapabilitySourceFingerprint[] = [];
  for (const [namespace, bucket] of grouped) {
    const tf = new Map<string, number>();
    for (const descriptor of bucket) {
      // Identity surface: the name plus the leading sentence is where a tool
      // states what it IS. Instructional tails ("Use this when you need to
      // understand…", "HOW TO USE: …") are meta-prose shared by every server —
      // indexing them once let "understand how X works" prompts ignite fal.ai.
      for (const token of tokenizeCapabilityText(
        `${descriptor.name} ${capabilityFirstSentence(descriptor.description)}`,
      )) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
      }
    }
    for (const token of tf.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
    sources.push({
      namespace,
      label: capabilitySourceLabel(namespace),
      toolCount: bucket.length,
      names: bucket.map((descriptor) => descriptor.name),
      descriptions: bucket.map((descriptor) => descriptor.description),
      toolTerms: bucket.map(
        (descriptor) =>
          new Set(
            tokenizeCapabilityText(
              `${descriptor.name} ${capabilityFirstSentence(descriptor.description)}`,
            ),
          ),
      ),
      tf,
    });
  }
  const docFrequency = (term: string): number => documentFrequency.get(term) ?? 0;
  const idf = (term: string): number => {
    const frequency = documentFrequency.get(term);
    if (frequency === undefined || sourceCount === 0) return 0;
    return Math.log(sourceCount / frequency);
  };
  return { sourceCount, sources, idf, docFrequency };
};

const CAPTURED_FROM_SUFFIX = /\s*\(captured from [^)]*\)\s*$/;

const FIRST_SENTENCE = /^(.{8,}?[.!?])(?:\s|$)/;

// Leading sentence of a description: the identity clause, before any
// instructional tail. Whole string when no sentence boundary exists (terse
// server descriptions like "Cancel subscription" are all identity).
export const capabilityFirstSentence = (description: string): string => {
  const cleaned = description.replace(/\s+/g, " ").trim();
  return FIRST_SENTENCE.exec(cleaned)?.[1] ?? cleaned;
};

// Advisory text shows one short clause per tool: the first sentence when it
// fits, otherwise a bounded slice. Provenance suffixes are stripped because
// the advisory names the source separately.
export const truncateAdvisoryDescription = (description: string, maxChars = 64): string => {
  const cleaned = description.replace(CAPTURED_FROM_SUFFIX, "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  const sentence = FIRST_SENTENCE.exec(cleaned)?.[1];
  if (sentence !== undefined && sentence.length <= maxChars) return sentence;
  return `${cleaned.slice(0, maxChars - 1)}…`;
};
