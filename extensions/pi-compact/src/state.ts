import type { Theme } from "@earendil-works/pi-coding-agent";

export const state = {
  theme: undefined as Theme | undefined,
  thinkingLevel: "off" as Parameters<Theme["getThinkingBorderColor"]>[0],
  lastToolPatchError: undefined as string | undefined,
  lastUserPatchError: undefined as string | undefined,
  lastAssistantPatchError: undefined as string | undefined,
};
