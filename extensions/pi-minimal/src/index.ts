import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { type FeatureSetting, nextThinkingMode, parseOnOff, parseThinkingMode, resolveConfig } from "./config.js";
import { applyEditorFeature, releaseEditor } from "./editor.js";
import { state } from "./state.js";
import { patchAssistantMessageComponent } from "./thinking-rendering.js";
import { patchToolExecutionComponent } from "./tool-rendering.js";
import { FEATURE_IDS, type FeatureId, type ThinkingMode } from "./types.js";
import { patchUserMessageComponent } from "./user-rendering.js";

function patchComponents(): boolean {
	const toolOk = patchToolExecutionComponent();
	const userOk = patchUserMessageComponent();
	const assistantOk = patchAssistantMessageComponent();
	return toolOk && userOk && assistantOk;
}

function patchErrors(): string {
	const errors = [
		state.lastToolPatchError,
		state.lastUserPatchError,
		state.lastAssistantPatchError,
		state.lastConfigError,
	].filter(Boolean);
	return errors.length > 0 ? `\n${errors.join("\n")}` : "";
}

// Prototype patches are process-global and idempotent (originals stashed on the
// prototype). Feature flags gate behavior at render time, so disabling a
// feature falls back to the original renderer without unpatching.
void patchComponents();

function parseArgs(args: string): { feature?: FeatureId; setting?: FeatureSetting } | undefined {
	const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { setting: "status" };
	if (parts.length > 2) return undefined;

	const [first, second] = parts;
	if ((FEATURE_IDS as readonly string[]).includes(first)) {
		if (second === undefined || second === "status") return { feature: first as FeatureId, setting: "status" };
		if (second === "toggle") return { feature: first as FeatureId, setting: "toggle" };
		if (first === "thinking") {
			const mode = parseThinkingMode(second);
			return mode ? { feature: "thinking", setting: mode } : undefined;
		}
		const onOff = parseOnOff(second);
		return onOff === undefined ? undefined : { feature: first as FeatureId, setting: onOff };
	}

	// Bare thinking mode or on/off word: treat as the thinking feature for
	// backwards compatibility with /compact-thinking.
	if (parts.length === 1) {
		const mode = parseThinkingMode(first);
		if (mode) return { feature: "thinking", setting: mode };
		if (first === "toggle") return { feature: "thinking", setting: "toggle" };
	}
	return undefined;
}

function applyFeature(feature: FeatureId, setting: FeatureSetting, ctx: ExtensionCommandContext): void {
	if (feature === "thinking") {
		if (setting === "toggle") {
			const effective: ThinkingMode = state.features.thinking ? state.thinkingMode : "normal";
			state.thinkingMode = nextThinkingMode(effective);
			state.features.thinking = true;
		} else if (setting === true) {
			state.features.thinking = true;
		} else if (setting === false) {
			state.features.thinking = false;
		} else if (typeof setting === "string") {
			state.thinkingMode = setting;
			state.features.thinking = true;
		}
		return;
	}

	if (setting === "toggle") state.features[feature] = !state.features[feature];
	else if (typeof setting === "boolean") state.features[feature] = setting;
	if (feature === "editor") applyEditorFeature(ctx);
}

function statusLine(feature: FeatureId): string {
	if (feature === "thinking") {
		return `thinking=${state.features.thinking ? state.thinkingMode : "off"}`;
	}
	return `${feature}=${state.features[feature] ? "on" : "off"}`;
}

function fullStatus(): string {
	return `pi-minimal: ${FEATURE_IDS.map(statusLine).join(" ")}`;
}

async function minimalCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parsed = parseArgs(args);
	if (!parsed) {
		ctx.ui.notify("Usage: /minimal [tools|user|thinking|editor] [on|off|toggle|normal|compact|hidden|status]", "error");
		return;
	}
	if (!parsed.feature || parsed.setting === "status") {
		ctx.ui.notify(parsed.feature ? `pi-minimal: ${statusLine(parsed.feature)}` : fullStatus(), "info");
		return;
	}
	applyFeature(parsed.feature, parsed.setting, ctx);
	ctx.ui.notify(`pi-minimal: ${statusLine(parsed.feature)}`, "info");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("minimal", {
		description: "Toggle minimal UI features: /minimal [tools|user|thinking|editor] [on|off|toggle|status]",
		handler: minimalCommand,
	});

	// Backwards-compatible alias for /compact-thinking.
	pi.registerCommand("compact-thinking", {
		description: "Set thinking rendering (normal|compact|hidden|toggle|status)",
		handler: async (args, ctx) => minimalCommand(`thinking ${args}`.trim(), ctx),
	});

	pi.on("session_start", (_event, ctx) => {
		state.theme = ctx.mode === "tui" ? ctx.ui.theme : undefined;
		resolveConfig({
			global: join(getAgentDir(), "settings.json"),
			project: ctx.isProjectTrusted() ? join(ctx.cwd, CONFIG_DIR_NAME, "settings.json") : undefined,
		});
		applyEditorFeature(ctx);
		if ((!patchComponents() || state.lastConfigError) && ctx.hasUI) {
			ctx.ui.notify(`pi-minimal: renderer/config issue${patchErrors()}`, "error");
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		releaseEditor(ctx);
	});
}
