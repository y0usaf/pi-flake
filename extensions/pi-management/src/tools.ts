import { getSettingsListTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { createDisabledListStore, isRecord, statusDiagnostics, statusSeverity, uniqueSorted } from "./store";

// ── Types & constants ──────────────────────────────────────────────

interface ToolRecord {
	name: string;
	sourceInfo?: {
		source?: string;
		scope?: string;
	};
}

const ALLOWED = "allowed";
const BLOCKED = "blocked";
const BLOCKED_EXTERNALLY = "blocked (external)";

const store = createDisabledListStore({
	fileName: "tool-settings.json",
	field: "disabledTools",
	logPrefix: "[pi-management/tools]",
});

/** Tools we removed from the active set, kept so they can be restored. */
let removedByUs = new Set<string>();

// ── Discovery ──────────────────────────────────────────────────────

function normalizeTool(tool: unknown): ToolRecord | undefined {
	if (typeof tool === "string") {
		const name = tool.trim();
		return name ? { name } : undefined;
	}
	if (!isRecord(tool) || typeof tool.name !== "string") return undefined;

	const name = tool.name.trim();
	if (!name) return undefined;

	const sourceInfo = isRecord(tool.sourceInfo)
		? {
				source: typeof tool.sourceInfo.source === "string" ? tool.sourceInfo.source : undefined,
				scope: typeof tool.sourceInfo.scope === "string" ? tool.sourceInfo.scope : undefined,
			}
		: undefined;

	return sourceInfo ? { name, sourceInfo } : { name };
}

function getAllToolRecords(pi: ExtensionAPI): ToolRecord[] {
	const rawTools = pi.getAllTools() as unknown;
	if (!Array.isArray(rawTools)) return [];

	const seen = new Set<string>();
	const tools: ToolRecord[] = [];
	for (const rawTool of rawTools) {
		const tool = normalizeTool(rawTool);
		if (!tool || seen.has(tool.name)) continue;
		seen.add(tool.name);
		tools.push(tool);
	}
	return tools;
}

// ── Tool sorting & enforcement ─────────────────────────────────────

function getToolCategory(tool: ToolRecord): string {
	if (tool.sourceInfo?.source === "builtin") return "Built-in";
	if (tool.sourceInfo?.source === "sdk") return "SDK";
	if (tool.sourceInfo?.scope === "project") return "Project extension";
	if (tool.sourceInfo?.scope === "user") return "User extension";
	return tool.sourceInfo ? "Extension" : "Tool";
}

function sortTools(tools: ToolRecord[]): ToolRecord[] {
	const rank = (t: ToolRecord) =>
		t.sourceInfo?.source === "builtin"
			? 0
			: t.sourceInfo?.source === "sdk"
				? 1
				: t.sourceInfo?.scope === "project"
					? 2
					: t.sourceInfo?.scope === "user"
						? 3
						: 4;
	return [...tools].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function getToolValue(name: string, activeTools: Set<string>): string {
	if (store.names.has(name)) return BLOCKED;
	if (!activeTools.has(name)) return BLOCKED_EXTERNALLY;
	return ALLOWED;
}

function getToolValues(currentValue: string): string[] {
	if (currentValue === BLOCKED) return [BLOCKED, ALLOWED];
	if (currentValue === BLOCKED_EXTERNALLY) return [BLOCKED_EXTERNALLY, BLOCKED];
	return [ALLOWED, BLOCKED];
}

async function enforceDisabledTools(pi: ExtensionAPI): Promise<void> {
	const allNames = new Set(getAllToolRecords(pi).map((t) => t.name));
	if (allNames.size === 0) return;

	const active = pi.getActiveTools().filter((n) => allNames.has(n));
	const activeSet = new Set(active);

	// Forget removals that are active again (pi or another extension restored them)
	for (const name of [...removedByUs]) {
		if (activeSet.has(name) || !allNames.has(name)) removedByUs.delete(name);
	}

	// Restore tools we removed that are allowed again (appended at end)
	const restored = [...removedByUs].filter((n) => !store.names.has(n));
	for (const name of restored) removedByUs.delete(name);

	// Filter out currently disabled tools and record that we removed them
	const filtered = active.filter((n) => !store.names.has(n));
	for (const name of active) {
		if (store.names.has(name)) removedByUs.add(name);
	}

	const next = [...filtered, ...restored];
	if (active.length !== next.length || active.some((n, i) => n !== next[i])) {
		await pi.setActiveTools(next);
	}
}

async function reloadAndEnforce(pi: ExtensionAPI): Promise<void> {
	await store.load();
	await enforceDisabledTools(pi);
}

// ── Commands ───────────────────────────────────────────────────────

export function registerToolCommands(pi: ExtensionAPI) {
	// /tools command — interactive SettingsList UI
	pi.registerCommand("tools", {
		description: `Manage the global disabled-tools list (${store.path})`,
		handler: async (_args, ctx) => {
			await reloadAndEnforce(pi);

			const allTools = sortTools(getAllToolRecords(pi));
			if (allTools.length === 0) {
				ctx.ui.notify("No tools available", "info");
				return;
			}

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const activeTools = new Set(pi.getActiveTools());
				const blockedExternallyNames = allTools
					.map((tool) => tool.name)
					.filter((name) => !store.names.has(name) && !activeTools.has(name));
				const items: SettingItem[] = allTools.map((tool) => {
					const currentValue = getToolValue(tool.name, activeTools);
					const isBlockedExternally = currentValue === BLOCKED_EXTERNALLY;
					return {
						id: tool.name,
						label: `${tool.name} · ${getToolCategory(tool)}`,
						description: isBlockedExternally ? "Blocked (external)." : undefined,
						currentValue,
						values: getToolValues(currentValue),
					};
				});

				const container = new Container();
				container.addChild(new Text(theme.fg("accent", theme.bold("Tool Management"))));
				container.addChild(new Text(theme.fg("dim", store.path)));
				container.addChild(new Text(theme.fg("muted", "This menu edits this extension's global disabled-tools list.")));
				container.addChild(
					new Text(
						theme.fg(
							"muted",
							"Blocked = disabled by this extension. Blocked (external) = hidden by another extension or runtime mode.",
						),
					),
				);
				if (blockedExternallyNames.length > 0) {
					container.addChild(
						new Text(theme.fg("warning", `Blocked (external) now: ${blockedExternallyNames.join(", ")}`)),
					);
				}
				container.addChild(new Text(theme.fg("muted", "Scans built-in + extension tools each time this menu opens.")));
				container.addChild(
					new Text(theme.fg("muted", "Close + reopen to refresh tools added while this menu is open.")),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						if (newValue === BLOCKED) {
							store.names.add(id);
						} else {
							store.names.delete(id);
						}

						void enforceDisabledTools(pi)
							.then(() => {
								settingsList.updateValue(id, getToolValue(id, new Set(pi.getActiveTools())));
								tui.requestRender();
							})
							.catch((e) => {
								ctx.ui.notify(`Failed to apply tool changes: ${e instanceof Error ? e.message : String(e)}`, "error");
							});
						void store.save().then(() => {
							if (store.lastSaveError) {
								ctx.ui.notify(`${store.lastSaveError}\nChanges remain applied in this session.`, "error");
							}
						});
					},
					() => done(undefined),
				);

				container.addChild(settingsList);
				container.addChild(new Text(theme.fg("dim", "↑↓ navigate • ←/→ toggle • esc close")));

				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});
		},
	});

	// /tools-status command — diagnostic info
	pi.registerCommand("tools-status", {
		description: "Show tool-settings.json status",
		handler: async (_args, ctx) => {
			await reloadAndEnforce(pi);

			const allTools = sortTools(getAllToolRecords(pi));
			const activeTools = new Set(pi.getActiveTools());
			const knownNames = new Set(allTools.map((t) => t.name));
			const activeKnown = [...activeTools].filter((n) => knownNames.has(n));
			const disabled = uniqueSorted([...store.names]);
			const unresolved = disabled.filter((n) => !knownNames.has(n));
			const blockedExternallyNames = allTools
				.map((tool) => tool.name)
				.filter((name) => !store.names.has(name) && !activeTools.has(name));

			const lines = [
				`settings: ${store.path}`,
				`currentlyActiveAfterAllFilters: ${activeKnown.length}/${allTools.length}`,
				`disabledTools: ${disabled.join(", ") || "(none)"}`,
				`blockedExternally: ${blockedExternallyNames.join(", ") || "(none)"}`,
				"note: blockedExternally means a known tool this extension allows is shown as blocked (external) when it is absent from the current runtime active-tool set (another extension or runtime mode may be hiding it)",
			];
			if (unresolved.length > 0) lines.push(`unresolvedDisabledTools: ${unresolved.join(", ")}`);
			lines.push(...statusDiagnostics(store));

			ctx.ui.notify(lines.join("\n"), statusSeverity(store));
		},
	});

	// Enforce disabled tools on all 4 lifecycle hooks
	for (const event of ["session_start", "session_tree", "before_agent_start", "before_provider_request"] as const) {
		pi.on(event, () => reloadAndEnforce(pi));
	}
}
