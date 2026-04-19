import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@mariozechner/pi-coding-agent";

interface CodexFastSettings {
	enabled: boolean;
	supportedModels: string[];
	showStatus: boolean;
}

const DEFAULT_SETTINGS: CodexFastSettings = {
	enabled: false,
	supportedModels: ["gpt-5.4"],
	showStatus: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readCodexFastSettings(path: string): Partial<CodexFastSettings> {
	if (!existsSync(path)) return {};

	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!isRecord(parsed)) return {};

		const settings = parsed["codex-fast"] ?? parsed.codexFast;
		if (typeof settings === "boolean") {
			return { enabled: settings };
		}
		return isRecord(settings) ? (settings as Partial<CodexFastSettings>) : {};
	} catch (error) {
		console.error(`[codex-fast] Failed to load ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
}

function loadSettings(cwd: string): CodexFastSettings {
	return {
		...DEFAULT_SETTINGS,
		...readCodexFastSettings(join(getAgentDir(), "extension-settings.json")),
		...readCodexFastSettings(join(cwd, ".pi", "extension-settings.json")),
	};
}

function isCodexFastActive(ctx: ExtensionContext, settings: CodexFastSettings): boolean {
	const model = ctx.model;
	return model?.provider === "openai-codex" && settings.enabled && settings.supportedModels.includes(model.id);
}

function updateStatus(ctx: ExtensionContext): void {
	const settings = loadSettings(ctx.cwd);
	if (!settings.showStatus) {
		ctx.ui.setStatus("codex-fast", undefined);
		return;
	}

	if (isCodexFastActive(ctx, settings)) {
		ctx.ui.setStatus("codex-fast", ctx.ui.theme.fg("accent", "⚡"));
		return;
	}

	ctx.ui.setStatus("codex-fast", undefined);
}

export default function codexFastExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.registerCommand("codex-fast", {
		description: "Show Codex fast-mode status",
		handler: async (_args, ctx) => {
			const settings = loadSettings(ctx.cwd);
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
			const active = isCodexFastActive(ctx, settings) ? "on" : "off";
			const lines = [
				`codex-fast: ${active}`,
				`model: ${model}`,
				`enabled: ${settings.enabled}`,
				`supportedModels: ${settings.supportedModels.join(", ") || "(none)"}`,
				"config: ~/.pi/agent/extension-settings.json, .pi/extension-settings.json",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		const settings = loadSettings(ctx.cwd);
		if (!isCodexFastActive(ctx, settings)) return;
		if (!isRecord(event.payload)) return;
		if (event.payload.service_tier !== undefined) return;

		return {
			...event.payload,
			service_tier: "priority",
		};
	});
}
