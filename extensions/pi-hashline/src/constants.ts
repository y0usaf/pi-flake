export const HASH_ALPHABET = "ZPMQVRWSNKTXJBYH";
export const HASH_LENGTH = 2;
export const HASH_RE = new RegExp(`^[${HASH_ALPHABET}]{${HASH_LENGTH}}$`);

export const HASHLINE_PREFIX_RE = new RegExp(
  `^\\s*(?:>>>|>>)?\\s*\\d+\\s*#\\s*[${HASH_ALPHABET}]{${HASH_LENGTH}}:`,
);
export const HASHLINE_PLUS_PREFIX_RE = new RegExp(
  `^\\+\\s*\\d+\\s*#\\s*[${HASH_ALPHABET}]{${HASH_LENGTH}}:`,
);
export const DIFF_DELETE_PREFIX_RE = /^-\s*\d+\s{2,}/;

export const SIGNIFICANT_RE = /[\p{L}\p{N}]/u;
export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
