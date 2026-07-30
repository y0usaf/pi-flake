export const HASH_LENGTH = 4;

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

// All 676 lowercase bigrams minus these 29 non-BPE-friendly pairs, generated in
// lexicographic order. Order is part of the hash function: index -> bigram
// mapping must stay byte-identical or every emitted anchor changes.
const EXCLUDED_BIGRAMS = new Set([
	"bq", "gk", "gq", "jv", "jz", "kq", "kz", "lq", "nq", "qf",
	"qg", "qj", "qk", "qv", "qz", "rj", "tq", "wq", "wz", "xg",
	"xj", "xk", "xq", "xv", "xw", "yq", "zj", "zq", "zv",
]);

export const HASHLINE_BIGRAMS: readonly string[] = [...LETTERS]
	.flatMap((first) => [...LETTERS].map((second) => `${first}${second}`))
	.filter((bigram) => !EXCLUDED_BIGRAMS.has(bigram));

export const HASHLINE_BIGRAMS_COUNT = HASHLINE_BIGRAMS.length;

// One generated hash body contains two BPE-friendly bigrams.
export const HASHLINE_BIGRAM_RE_SRC = `(?:${HASHLINE_BIGRAMS.join("|")})`;
export const HASHLINE_HASH_RE_SRC = `(?:${HASHLINE_BIGRAM_RE_SRC}){2}`;
export const HASH_RE = new RegExp(`^${HASHLINE_HASH_RE_SRC}$`);

// Keep recognizing v2 prefixes in patch content so stale read output cannot be
// pasted into files during migration. Anchor parsing accepts v3 only.
const HASHLINE_PATCH_HASH_RE_SRC = `(?:${HASHLINE_HASH_RE_SRC}|${HASHLINE_BIGRAM_RE_SRC})`;

export const HASHLINE_PREFIX_RE = new RegExp(
  `^\\s*(?:>>>|>>)?\\s*(?:\\+\\s*)?\\d+${HASHLINE_PATCH_HASH_RE_SRC}[:|]`,
);
export const HASHLINE_PLUS_PREFIX_RE = new RegExp(
  `^\\s*(?:>>>|>>)?\\s*\\+\\s*\\d+${HASHLINE_PATCH_HASH_RE_SRC}[:|]`,
);
export const DIFF_DELETE_PREFIX_RE = new RegExp(`^-\\s*(?:\\d+${HASHLINE_PATCH_HASH_RE_SRC}[:|]|\\d+\\s{2,})`);
