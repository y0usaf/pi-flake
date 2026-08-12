import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RECALL_TOOL = "vcc_recall";

interface BranchEntryLike {
  type?: string;
  details?: { compactor?: string } | null;
}

/** True when the branch already contains a pi-vcc-produced compaction. */
export const hasPiVccCompaction = (entries: BranchEntryLike[]): boolean =>
  entries.some((e) => e.type === "compaction" && e.details?.compactor === "pi-vcc");

const hideRecall = (pi: ExtensionAPI): void => {
  try {
    const active = pi.getActiveTools();
    if (!active.includes(RECALL_TOOL)) return;
    pi.setActiveTools(active.filter((t) => t !== RECALL_TOOL));
  } catch {}
};

const showRecall = (pi: ExtensionAPI): void => {
  try {
    const active = pi.getActiveTools();
    if (active.includes(RECALL_TOOL)) return;
    pi.setActiveTools([...active, RECALL_TOOL]);
  } catch {}
};

/**
 * Keep vcc_recall out of the model's tool surface until pi-vcc has
 * compacted this branch — before that, recall adds nothing (full
 * history is already in context). The /pi-vcc-recall slash command
 * is unaffected; only the model-facing tool is gated.
 */
export const registerRecallGate = (pi: ExtensionAPI) => {
  hideRecall();

  pi.on("session_start", (_event, ctx) => {
    let branch: BranchEntryLike[] = [];
    try {
      branch = (ctx.sessionManager.getBranch?.() ?? []) as BranchEntryLike[];
    } catch {}
    // Resume/reload of a branch pi-vcc already compacted: keep visible.
    if (hasPiVccCompaction(branch)) showRecall(pi);
    else hideRecall(pi);
  });

  pi.on("session_compact", (event) => {
    if (!event.fromExtension) return; // core compaction — recall stays hidden
    showRecall(pi);
  });
};
