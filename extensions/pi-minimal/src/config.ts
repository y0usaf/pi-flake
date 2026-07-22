import { existsSync, readFileSync } from "node:fs";
import { isRecord } from "./shared.js";
import { state } from "./state.js";
import { FEATURE_IDS, type ThinkingMode } from "./types.js";

export type FeatureSetting = boolean | "toggle" | ThinkingMode | "status";

const THINKING_MODES: Record<string, ThinkingMode> = {
	normal: "normal",
	compact: "compact",
	hidden: "hidden",
	hide: "hidden",
	off: "hidden",
};

const BOOLEAN_WORDS: Record<string, boolean> = {
	on: true,
	off: false,
	enable: true,
	disable: false,
	enabled: true,
	disabled: false,
};

export function parseOnOff(value: string): boolean | undefined {
	return BOOLEAN_WORDS[value.trim().toLowerCase()];
}

export function parseThinkingMode(value: string): ThinkingMode | undefined {
	return THINKING_MODES[value.trim().toLowerCase()];
}

/** Cycle order for `/minimal <feature>` without an explicit state. */
export function nextThinkingMode(current: ThinkingMode): ThinkingMode {
	return current === "normal" ? "compact" : current === "compact" ? "hidden" : "compact";
}

/**
 * Read feature defaults from a settings.json. Accepts the current
 * `extensionSettings.pi-minimal` key and the legacy `pi-compact` key
 * (thinking mode only). pi-minimal wins when both exist.
 */
function readSettings(path: string): { features: Partial<Record<string, boolean>>; thinking?: ThinkingMode } {
	const result: { features: Partial<Record<string, boolean>>; thinking?: ThinkingMode } = { features: {} };
	if (!existsSync(path)) return result;

	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!isRecord(parsed) || !isRecord(parsed.extensionSettings)) return result;
		const settings = parsed.extensionSettings;

		const legacy = settings["pi-compact"];
		if (isRecord(legacy) && isRecord(legacy.thinking)) {
			result.thinking = parseThinkingMode(String(legacy.thinking.mode));
		}

		const current = settings["pi-minimal"];
		if (isRecord(current)) {
			for (const id of FEATURE_IDS) {
				if (typeof current[id] === "boolean") result.features[id] = current[id];
			}
			if (isRecord(current.thinking)) {
				result.thinking = parseThinkingMode(String(current.thinking.mode)) ?? result.thinking;
			}
		}
	} catch (error) {
		state.lastConfigError = error instanceof Error ? (error.stack ?? error.message) : String(error);
	}
	return result;
}

/** Project settings override global settings; unset values fall back to defaults. */
export function resolveConfig(paths: { global: string; project?: string }): void {
	state.lastConfigError = undefined;
	const global = readSettings(paths.global);
	const project = paths.project ? readSettings(paths.project) : { features: {} };

	for (const id of FEATURE_IDS) {
		state.features[id] = project.features[id] ?? global.features[id] ?? true;
	}
	state.thinkingMode = project.thinking ?? global.thinking ?? state.thinkingMode;
}
