export type FabricEffectConflictReason = "shared_resource" | "unknown_resource";

const reasonText = (reason: FabricEffectConflictReason): string =>
  reason === "unknown_resource"
    ? "unknown resource footprint; declare resources and ordering"
    : "shared noncommutative resource";

export const formatFabricEffectConflict = (
  target: string,
  resources: readonly string[],
  reason: FabricEffectConflictReason,
): string => `${target} [${resources.join(", ")}] (${reasonText(reason)})`;
