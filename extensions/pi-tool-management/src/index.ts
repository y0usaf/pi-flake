import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getSettingsListTheme, getAgentDir, type ExtensionAPI, type ToolInfo } from "@mariozechner/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@mariozechner/pi-tui";

// ── Types & constants ──────────────────────────────────────────────

interface ToolSettingsFile {
	version: number;
	disabledTools: string[];
}

const SETTINGS_VERSION = 1;
const SETTINGS_PATH = join(getAgentDir(), "tool-settings.json");

// ── Helpers ────────────────────────────────────────────────────────

function uniqueSorted(arr: string[]): string[] {
	return [...new Set(arr)].sort((a, b) => a.localeCompare(b));
}

function sameElements(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const v of a) if (!b.has(v)) return false;
	return true;
}

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === "string").map((s) => s.trim()).filter(Boolean);
}

// ── Settings I/O ───────────────────────────────────────────────────

let disabledTools = new Set<string>();
let loaded = false;
let lastWarning: string | undefined;
let lastSaveError: string | undefined;

function parseSettings(raw: string): { disabledTools: string[]; warning?: string } {
	const parsed: unknown = JSON.parse(raw);

	// Legacy: bare array
	if (Array.isArray(parsed)) {
		return { disabledTools: uniqueSorted(toStringArray(parsed)), warning: `Migrated legacy array format in ${SETTINGS_PATH}` };
	}

	if (typeof parsed !== "object" || parsed === null) {
		return { disabledTools: [], warning: `Ignoring invalid settings in ${SETTINGS_PATH}: expected object or array` };
	}

	const obj = parsed as Record<string, unknown>;
	const tools = uniqueSorted(toStringArray(obj.disabledTools));

	if (obj.version === undefined) {
		return { disabledTools: tools, warning: `Migrated unversioned settings in ${SETTINGS_PATH}` };
	}
	if (typeof obj.version === "number" && obj.version > SETTINGS_VERSION) {
		return { disabledTools: tools, warning: `Settings use newer version ${obj.version}; using disabledTools as-is` };
	}
	return { disabledTools: tools };
}

async function loadSettings(): Promise<void> {
	try {
		const raw = await readFile(SETTINGS_PATH, "utf-8");
		try {
			const result = parseSettings(raw);
			disabledTools = new Set(result.disabledTools);
			lastWarning = result.warning;
			if (lastWarning) console.warn(`[pi-tool-management] ${lastWarning}`);
		} catch (e) {
			const msg = `Failed to parse ${SETTINGS_PATH}: ${e instanceof Error ? e.message : String(e)}`;
			lastWarning = msg;
			console.warn(`[pi-tool-management] ${msg}`);
		}
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err?.code !== "ENOENT") {
			const msg = `Failed to load ${SETTINGS_PATH}: ${err.message}`;
			lastWarning = msg;
			console.warn(`[pi-tool-management] ${msg}`);
		}
		// ENOENT: no file yet, keep current disabledTools (empty on first load)
	}
	loaded = true;
}

async function saveSettings(): Promise<void> {
	const file: ToolSettingsFile = { version: SETTINGS_VERSION, disabledTools: uniqueSorted([...disabledTools]) };
	try {
		await mkdir(getAgentDir(), { recursive: true });
		await writeFile(SETTINGS_PATH, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
		lastSaveError = undefined;
	} catch (e) {
		const msg = `Failed to save ${SETTINGS_PATH}: ${e instanceof Error ? e.message : String(e)}`;
		lastSaveError = msg;
		console.error(`[pi-tool-management] ${msg}`);
	}
}

// ── Tool sorting & enforcement ─────────────────────────────────────

function getToolCategory(tool: ToolInfo): string {
	if (tool.sourceInfo.source === "builtin") return "Built-in";
	if (tool.sourceInfo.source === "sdk") return "SDK";
	if (tool.sourceInfo.scope === "project") return "Project extension";
	if (tool.sourceInfo.scope === "user") return "User extension";
	return "Extension";
}

function sortTools(tools: ToolInfo[]): ToolInfo[] {
	const rank = (t: ToolInfo) =>
		t.sourceInfo.source === "builtin" ? 0 :
		t.sourceInfo.source === "sdk" ? 1 :
		t.sourceInfo.scope === "project" ? 2 :
		t.sourceInfo.scope === "user" ? 3 : 4;
	return [...tools].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function enforceDisabledTools(pi: ExtensionAPI): void {
	const allNames = new Set(pi.getAllTools().map((t) => t.name));
	const active = pi.getActiveTools().filter((n) => allNames.has(n));
	const filtered = active.filter((n) => !disabledTools.has(n));
	if (active.length !== filtered.length || active.some((n, i) => n !== filtered[i])) {
		pi.setActiveTools(filtered);
	}
}

async function reloadAndEnforce(pi: ExtensionAPI): Promise<void> {
	await loadSettings();
	enforceDisabledTools(pi);
}

// ── Extension entry point ──────────────────────────────────────────

export default function toolManagementExtension(pi: ExtensionAPI) {
	// /tools command — interactive SettingsList UI
	pi.registerCommand("tools", {
		description: "Manage this extension's global disabled-tools list (~/.pi/agent/tool-settings.json)",
		handler: async (_args, ctx) => {
			await reloadAndEnforce(pi);

			const allTools = sortTools(pi.getAllTools());
			if (allTools.length === 0) {
				ctx.ui.notify("No tools available", "info");
				return;
			}

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const items: SettingItem[] = allTools.map((tool) => ({
					id: tool.name,
					label: `${tool.name} · ${getToolCategory(tool)}`,
					currentValue: disabledTools.has(tool.name) ? "blocked by this extension" : "allowed",
					values: ["allowed", "blocked by this extension"],
				}));

				const container = new Container();
				container.addChild(new Text(theme.fg("accent", theme.bold("Tool Management"))));
				container.addChild(new Text(theme.fg("dim", SETTINGS_PATH)));
				container.addChild(new Text(theme.fg("muted", "This menu edits this extension's global disabled-tools list.")));
				container.addChild(new Text(theme.fg("muted", "Allowed here = not blocked by this extension; another extension may still hide or re-add a tool later.")));
				container.addChild(new Text(theme.fg("muted", "Scans built-in + extension tools each time this menu opens.")));
				container.addChild(new Text(theme.fg("muted", "Close + reopen to refresh tools added while this menu is open.")));

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						if (newValue === "allowed") {
							disabledTools.delete(id);
						} else {
							disabledTools.add(id);
						}
						enforceDisabledTools(pi);
						saveSettings().then(() => {
							if (lastSaveError) ctx.ui.notify(`${lastSaveError}\nChanges remain applied in this session.`, "error");
						});
					},
					() => done(undefined),
				);

				container.addChild(settingsList);
				container.addChild(new Text(theme.fg("dim", "↑↓ navigate • ←/→ toggle • esc close")));

				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => { settingsList.handleInput?.(data); tui.requestRender(); },
				};
			});
		},
	});

	// /tools-status command — diagnostic info
	pi.registerCommand("tools-status", {
		description: "Show tool-settings.json status",
		handler: async (_args, ctx) => {
			await reloadAndEnforce(pi);

			const allTools = sortTools(pi.getAllTools());
			const activeTools = new Set(pi.getActiveTools());
			const knownNames = new Set(allTools.map((t) => t.name));
			const disabled = uniqueSorted([...disabledTools]);
			const unresolved = disabled.filter((n) => !knownNames.has(n));

			const lines = [
				`settings: ${SETTINGS_PATH}`,
				`currentlyActiveAfterAllFilters: ${activeTools.size}/${allTools.length}`,
				`disabledTools: ${disabled.join(", ") || "(none)"}`,
				"note: active count reflects the current runtime tool set after this extension and any other extensions have applied their filters",
			];
			if (unresolved.length > 0) lines.push(`unresolvedDisabledTools: ${unresolved.join(", ")}`);
			if (lastWarning) lines.push(`loadWarning: ${lastWarning}`);
			if (lastSaveError) lines.push(`saveError: ${lastSaveError}`);

			ctx.ui.notify(lines.join("\n"), lastSaveError ? "error" : lastWarning ? "warning" : "info");
		},
	});

	// Enforce disabled tools on all 4 lifecycle hooks
	for (const event of ["session_start", "session_tree", "before_agent_start", "before_provider_request"] as const) {
		pi.on(event, () => reloadAndEnforce(pi));
	}
}
