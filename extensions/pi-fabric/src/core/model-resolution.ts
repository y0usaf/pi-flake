const PROVIDER_MODEL_RE = /^[^\s/]+\/[^\s/]+$/;

/** Minimal model view needed for resolution; satisfied by pi Model entries. */
export interface FabricModelCandidate {
  provider: string;
  id: string;
  name?: string;
}

export type FabricModelResolution =
  | { kind: "resolved"; model: FabricModelCandidate; via?: string }
  | { kind: "already-active"; model: FabricModelCandidate }
  | { kind: "ambiguous"; query: string; candidates: FabricModelCandidate[] }
  | { kind: "not-found"; query: string; tried?: string[] };

const modelKey = (model: FabricModelCandidate): string => `${model.provider}/${model.id}`;

const sameModel = (
  left: FabricModelCandidate,
  right: FabricModelCandidate | undefined,
): boolean =>
  right !== undefined &&
  left.provider.toLowerCase() === right.provider.toLowerCase() &&
  left.id.toLowerCase() === right.id.toLowerCase();

/**
 * Normalize raw `models.aliases` config into alias name → ordered targets.
 * String targets degrade to one-element fallback chains. Entries whose name,
 * target list, or any `provider/model` target string is malformed are
 * dropped entirely, matching the lenient fallback style of the other config
 * normalizers (no partial alias survives with a silently missing target).
 */
export const normalizeModelAliases = (input: unknown): Record<string, string[]> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const aliases: Record<string, string[]> = {};
  for (const [rawName, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const name = rawName.trim();
    if (!name) continue;
    const values = typeof rawValue === "string" ? [rawValue] : rawValue;
    if (!Array.isArray(values) || values.length === 0) continue;
    const targets: string[] = [];
    let valid = true;
    for (const candidate of values) {
      if (typeof candidate !== "string") {
        valid = false;
        break;
      }
      const target = candidate.trim();
      if (!PROVIDER_MODEL_RE.test(target)) {
        valid = false;
        break;
      }
      if (!targets.includes(target)) targets.push(target);
    }
    if (valid && targets.length > 0) aliases[name] = targets;
  }
  return aliases;
};

/**
 * Resolve a model selector against aliases and the available (authenticated)
 * registry. Order: alias lookup first so a configured name always wins, then
 * exact provider/id, exact id, then a single partial match across provider,
 * id, and name. Multiple partial matches stay the caller's disambiguation
 * problem so a fuzzy switch can never land on the wrong model.
 */
export const resolveFabricModel = (
  query: string,
  options: {
    aliases: Record<string, string[]>;
    available: readonly FabricModelCandidate[];
    current?: FabricModelCandidate;
    provider?: string;
  },
): FabricModelResolution => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return { kind: "not-found", query };
  const providerFilter = options.provider?.trim().toLowerCase();
  const available = providerFilter
    ? options.available.filter((model) => model.provider.toLowerCase() === providerFilter)
    : [...options.available];
  if (available.length === 0) return { kind: "not-found", query };

  const aliasKey = Object.keys(options.aliases).find(
    (key) => key.toLowerCase() === normalized,
  );
  const tried: string[] = [];
  if (aliasKey !== undefined) {
    const chain = options.aliases[aliasKey] ?? [];
    for (const target of chain) {
      tried.push(target);
      const separator = target.indexOf("/");
      const provider = target.slice(0, separator);
      const id = target.slice(separator + 1);
      const match = available.find(
        (model) =>
          model.provider.toLowerCase() === provider.toLowerCase() &&
          model.id.toLowerCase() === id.toLowerCase(),
      );
      if (match) {
        return sameModel(match, options.current)
          ? { kind: "already-active", model: match }
          : { kind: "resolved", model: match, via: aliasKey };
      }
    }
    return { kind: "not-found", query, tried };
  }

  const exact = available.find((model) => modelKey(model).toLowerCase() === normalized)
    ?? available.find((model) => model.id.toLowerCase() === normalized);
  if (exact) {
    return sameModel(exact, options.current)
      ? { kind: "already-active", model: exact }
      : { kind: "resolved", model: exact };
  }

  const candidates = available.filter(
    (model) =>
      model.id.toLowerCase().includes(normalized) ||
      (model.name !== undefined && model.name.toLowerCase().includes(normalized)) ||
      model.provider.toLowerCase().includes(normalized),
  );
  if (candidates.length === 1) {
    const match = candidates[0];
    if (match === undefined) return { kind: "not-found", query };
    return sameModel(match, options.current)
      ? { kind: "already-active", model: match }
      : { kind: "resolved", model: match };
  }
  if (candidates.length > 1) return { kind: "ambiguous", query, candidates };
  return { kind: "not-found", query };
};
