import type { Theme } from "@earendil-works/pi-coding-agent";
import { DEFAULT_THINKING_MODE, type FeatureId, type ThinkingMode } from "./types.js";

type FeatureFlags = Record<FeatureId, boolean>;

export const state = {
	theme: undefined as Theme | undefined,
	thinkingMode: DEFAULT_THINKING_MODE as ThinkingMode,
	features: { tools: true, user: true, thinking: true, editor: true } as FeatureFlags,

	lastToolPatchError: undefined as string | undefined,
	lastUserPatchError: undefined as string | undefined,
	lastAssistantPatchError: undefined as string | undefined,
	lastConfigError: undefined as string | undefined,
};
