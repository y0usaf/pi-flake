import { createHash } from "node:crypto";

// Deterministic JSON shaping for hashing: object keys sort recursively so
// equivalent values hash identically regardless of key insertion order. URL
// instances hash by href — they expose no enumerable own properties, so
// untreated they would all collapse to "{}" (MCP server definitions carry
// `URL` instances for HTTP transports).
const stableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value instanceof URL) return value.href;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableJsonValue(nested)]),
  );
};

export const stableJsonHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(stableJsonValue(value))).digest("hex");
