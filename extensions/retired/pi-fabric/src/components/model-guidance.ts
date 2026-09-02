import { stableJsonHash } from "../core/stable-hash.js";
import type {
  FabricModelGuidance,
  FabricModelGuidanceInfo,
  FabricModelGuidancePlacement,
  FabricModelGuidanceTarget,
} from "./types.js";

export const FABRIC_EXECUTION_GUIDANCE_SLOT = "fabric.execution";
export const MAX_FABRIC_MODEL_GUIDANCE_PER_COMPONENT = 64;
export const MAX_FABRIC_MODEL_GUIDANCE_CONTENT_CHARS = 32_000;
export const MAX_FABRIC_MODEL_GUIDANCE_TOTAL_CHARS = 64_000;
export const MAX_FABRIC_MODEL_GUIDANCE_REGISTRATIONS = 1_024;
export const MAX_FABRIC_MODEL_GUIDANCE_SNAPSHOT_CHARS = 1_000_000;

const MAX_LABEL_CHARS = 128;
const MAX_SLOT_CHARS = 128;
const MAX_MODEL_PATTERNS = 32;
const MAX_MODEL_PATTERN_CHARS = 256;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const REGEX_CHARACTER = /[\\^$+.[\]{}()|]/;

export interface NormalizedFabricModelGuidance {
  label: string;
  models: string[];
  content: string;
  targets: FabricModelGuidanceTarget[];
  placement: FabricModelGuidancePlacement;
  slot?: string;
}

export interface FabricOwnedModelGuidance extends NormalizedFabricModelGuidance {
  componentId: string;
  component: string;
  revision: number;
}

const compareStableText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const compareFabricOwnedModelGuidance = (
  left: FabricOwnedModelGuidance,
  right: FabricOwnedModelGuidance,
): number =>
  compareStableText(left.componentId, right.componentId) ||
  compareStableText(left.label, right.label);

export interface FabricGuidanceDefaultSlot {
  slot: string;
  content: string;
}

export interface FabricResolvedModelGuidance {
  slotText: string;
  appendText: string;
  digest: string;
  sources: Array<{
    componentId: string;
    component: string;
    label: string;
    placement: FabricModelGuidancePlacement;
    slot?: string;
    contentHash: string;
  }>;
}

const guidanceError = (message: string): Error =>
  new Error(`Invalid Fabric model guidance: ${message}`);

const normalizedIdentifier = (value: unknown, field: "label" | "slot", max: number): string => {
  if (typeof value !== "string") throw guidanceError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw guidanceError(`${field} must not be empty`);
  if (normalized.length > max) throw guidanceError(`${field} exceeds ${max} characters`);
  if (CONTROL_CHARACTER.test(normalized)) {
    throw guidanceError(`${field} must not contain control characters`);
  }
  return normalized;
};

const normalizeTargets = (
  targets: readonly FabricModelGuidanceTarget[] | undefined,
): FabricModelGuidanceTarget[] => {
  if (targets === undefined) return ["main", "participant"];
  if (!Array.isArray(targets) || targets.length === 0) {
    throw guidanceError("targets must contain main and/or participant");
  }
  const normalized: FabricModelGuidanceTarget[] = [];
  for (const target of targets) {
    if (target !== "main" && target !== "participant") {
      throw guidanceError(`unsupported target ${String(target)}`);
    }
    if (!normalized.includes(target)) normalized.push(target);
  }
  return normalized;
};

export const normalizeFabricModelGuidance = (
  guidance: FabricModelGuidance,
): NormalizedFabricModelGuidance => {
  if (!guidance || typeof guidance !== "object" || Array.isArray(guidance)) {
    throw guidanceError("registration must be an object");
  }
  const label = normalizedIdentifier(guidance.label, "label", MAX_LABEL_CHARS);
  if (!Array.isArray(guidance.models) || guidance.models.length === 0) {
    throw guidanceError(`${label} must select at least one provider/model pattern`);
  }
  if (guidance.models.length > MAX_MODEL_PATTERNS) {
    throw guidanceError(`${label} selects more than ${MAX_MODEL_PATTERNS} model patterns`);
  }
  const models: string[] = [];
  for (const candidate of guidance.models) {
    if (typeof candidate !== "string") {
      throw guidanceError(`${label} model patterns must be strings`);
    }
    const pattern = candidate.trim();
    if (!pattern || pattern.length > MAX_MODEL_PATTERN_CHARS || !pattern.includes("/")) {
      throw guidanceError(
        `${label} model pattern ${JSON.stringify(candidate)} must be a provider/model glob of at most ${MAX_MODEL_PATTERN_CHARS} characters`,
      );
    }
    if (CONTROL_CHARACTER.test(pattern)) {
      throw guidanceError(`${label} model patterns must not contain control characters`);
    }
    if (!models.includes(pattern)) models.push(pattern);
  }
  if (typeof guidance.content !== "string" || !guidance.content.trim()) {
    throw guidanceError(`${label} content must be a non-empty string`);
  }
  const content = guidance.content.trim();
  if (content.length > MAX_FABRIC_MODEL_GUIDANCE_CONTENT_CHARS) {
    throw guidanceError(
      `${label} content exceeds ${MAX_FABRIC_MODEL_GUIDANCE_CONTENT_CHARS} characters`,
    );
  }
  const placement = guidance.placement ?? "append";
  if (placement !== "append" && placement !== "replace") {
    throw guidanceError(`${label} placement must be append or replace`);
  }
  const slot = guidance.slot === undefined
    ? undefined
    : normalizedIdentifier(guidance.slot, "slot", MAX_SLOT_CHARS);
  if (placement === "replace" && !slot) {
    throw guidanceError(`${label} replacement guidance requires a slot`);
  }
  if (placement === "append" && slot) {
    throw guidanceError(`${label} append guidance must not declare a slot`);
  }
  return {
    label,
    models,
    content,
    targets: normalizeTargets(guidance.targets),
    placement,
    ...(slot ? { slot } : {}),
  };
};

export const parseFabricOwnedModelGuidance = (value: unknown): FabricOwnedModelGuidance[] => {
  if (!Array.isArray(value) || value.length > MAX_FABRIC_MODEL_GUIDANCE_REGISTRATIONS) return [];
  try {
    const parsed = value.map((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw guidanceError("serialized owner must be an object");
      }
      const record = candidate as Partial<FabricOwnedModelGuidance>;
      const normalized = normalizeFabricModelGuidance(record as FabricModelGuidance);
      if (
        typeof record.componentId !== "string" ||
        !record.componentId.trim() ||
        typeof record.component !== "string" ||
        !record.component.trim() ||
        !Number.isSafeInteger(record.revision) ||
        (record.revision ?? 0) < 1
      ) {
        throw guidanceError("serialized owner metadata is incomplete");
      }
      return {
        ...normalized,
        componentId: record.componentId.trim(),
        component: record.component.trim(),
        revision: record.revision!,
      };
    });
    if (parsed.reduce((sum, entry) => sum + entry.content.length, 0) >
      MAX_FABRIC_MODEL_GUIDANCE_SNAPSHOT_CHARS) return [];
    return parsed;
  } catch {
    return [];
  }
};

export const fabricModelGuidanceInfo = (
  guidance: NormalizedFabricModelGuidance,
): FabricModelGuidanceInfo => ({
  label: guidance.label,
  models: [...guidance.models],
  targets: [...guidance.targets],
  placement: guidance.placement,
  ...(guidance.slot ? { slot: guidance.slot } : {}),
  contentChars: guidance.content.length,
  contentHash: stableJsonHash(guidance.content),
});

const wildcardMatch = (pattern: string, value: string): boolean => {
  let expression = "^";
  for (const character of pattern) {
    if (character === "*") expression += ".*";
    else if (character === "?") expression += ".";
    else expression += REGEX_CHARACTER.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${expression}$`, "u").test(value);
};

const fabricModelGuidanceMatches = (
  guidance: NormalizedFabricModelGuidance,
  model: string,
  target: FabricModelGuidanceTarget,
): boolean =>
  guidance.targets.includes(target) && guidance.models.some((pattern) => wildcardMatch(pattern, model));

const sourceInfo = (guidance: FabricOwnedModelGuidance) => ({
  componentId: guidance.componentId,
  component: guidance.component,
  label: guidance.label,
  placement: guidance.placement,
  ...(guidance.slot ? { slot: guidance.slot } : {}),
  contentHash: stableJsonHash(guidance.content),
});

export const resolveFabricModelGuidance = (
  guidance: readonly FabricOwnedModelGuidance[],
  options: {
    model?: string;
    target: FabricModelGuidanceTarget;
    defaults?: readonly FabricGuidanceDefaultSlot[];
    includeSlots?: boolean;
  },
): FabricResolvedModelGuidance => {
  const includeSlots = options.includeSlots !== false;
  const matching = options.model
    ? guidance.filter((entry) => fabricModelGuidanceMatches(entry, options.model!, options.target))
    : [];
  const replacements = new Map<string, FabricOwnedModelGuidance[]>();
  const additions: FabricOwnedModelGuidance[] = [];
  for (const entry of matching) {
    if (entry.placement === "append") {
      additions.push(entry);
      continue;
    }
    if (!includeSlots || !entry.slot) continue;
    const existing = replacements.get(entry.slot) ?? [];
    existing.push(entry);
    replacements.set(entry.slot, existing);
  }

  const defaultSlots = options.defaults ?? [];
  const slotOrder = [
    ...defaultSlots.map((entry) => entry.slot),
    ...[...replacements.keys()]
      .filter((slot) => !defaultSlots.some((entry) => entry.slot === slot))
      .sort(compareStableText),
  ];
  const slotSections: string[] = [];
  const sources: FabricResolvedModelGuidance["sources"] = [];
  if (includeSlots) {
    for (const slot of slotOrder) {
      const candidates = replacements.get(slot) ?? [];
      if (candidates.length > 1) {
        const owners = candidates
          .map((entry) => `${entry.componentId}:${entry.label}`)
          .sort(compareStableText)
          .join(", ");
        throw new Error(
          `Fabric guidance slot ${slot} has multiple replacements for ${options.model ?? "the current model"}: ${owners}`,
        );
      }
      const replacement = candidates[0];
      if (replacement) {
        slotSections.push(replacement.content);
        sources.push(sourceInfo(replacement));
        continue;
      }
      const fallback = defaultSlots.find((entry) => entry.slot === slot)?.content.trim();
      if (fallback) slotSections.push(fallback);
    }
  }

  additions.sort(compareFabricOwnedModelGuidance);
  for (const addition of additions) sources.push(sourceInfo(addition));
  const appendSections = additions.map((entry) => entry.content);
  const slotText = slotSections.join("\n\n");
  const appendText = appendSections.join("\n\n");
  const resolvedChars = slotText.length + appendText.length +
    (slotText && appendText ? 2 : 0);
  if (resolvedChars > MAX_FABRIC_MODEL_GUIDANCE_TOTAL_CHARS) {
    throw new Error(
      `Resolved Fabric model guidance exceeds ${MAX_FABRIC_MODEL_GUIDANCE_TOTAL_CHARS} characters for ${options.model ?? "the current model"}`,
    );
  }
  return {
    slotText,
    appendText,
    sources,
    digest: stableJsonHash({
      model: options.model,
      target: options.target,
      slots: slotSections,
      additions: sources,
    }),
  };
};
