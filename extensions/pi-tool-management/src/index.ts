import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getSettingsListTheme, getAgentDir, type ExtensionAPI, type ToolInfo } from "@mariozechner/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@mariozechner/pi-tui";

interface ToolSettingsFile {
	version: number;
	disabledTools: string[];
}

interface ParsedToolSettings {
	disabledTools: string[];
	dirty: boolean;
	warning?: string;
}

interface ToolStateSnapshot {
	allTools: ToolInfo[];
	activeTools: Set<string>;
	disabledTools: Set<string>;
	loadWarning?: string;
	saveError?: string;
	dirty: boolean;
}

interface ToolSetMergeResult {
	mergedToolNames: string[];
	conflicts: string[];
}

interface DiskSettingsResultOk {
	kind: "ok";
	parsed: ParsedToolSettings;
}

interface DiskSettingsResultMissing {
	kind: "missing";
}

interface DiskSettingsResultParseError {
	kind: "parse-error";
	message: string;
}

interface DiskSettingsResultError {
	kind: "error";
	message: string;
}

type DiskSettingsResult =
	| DiskSettingsResultOk
	| DiskSettingsResultMissing
	| DiskSettingsResultParseError
	| DiskSettingsResultError;

const SETTINGS_VERSION = 1;
const SETTINGS_PATH = join(getAgentDir(), "tool-settings.json");

let baseDisabledTools = new Set<string>();
let cachedDisabledTools = new Set<string>();
let baseStateValid = false;
let settingsLoaded = false;
let settingsDirty = false;
let settingsRevision = 0;
let lastLoadWarning: string | undefined;
let lastSaveError: string | undefined;
let lastConsoleWarning: string | undefined;
let lastConsoleError: string | undefined;
let queuedSaveRevision: number | undefined;
let pendingSave: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function normalizeToolNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];

	return Array.from(
		new Set(
			value
				.filter((item): item is string => typeof item === "string")
				.map((item) => item.trim())
				.filter(Boolean),
		),
	).sort((a, b) => a.localeCompare(b));
}

function normalizeToolSet(value: Iterable<string>): Set<string> {
	return new Set(normalizeToolNames(Array.from(value)));
}

function toolNamesSetKey(value: Iterable<string>): string {
	return normalizeToolNames(Array.from(value)).join("\u0000");
}

function orderedToolNames(value: Iterable<string>, knownToolNames?: Set<string>): string[] {
	const seen = new Set<string>();
	const ordered: string[] = [];

	for (const item of value) {
		if (typeof item !== "string") continue;
		const toolName = item.trim();
		if (!toolName || seen.has(toolName)) continue;
		if (knownToolNames && !knownToolNames.has(toolName)) continue;
		seen.add(toolName);
		ordered.push(toolName);
	}

	return ordered;
}

function sameOrderedToolNames(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function replaceBaseDisabledTools(value: Iterable<string>): boolean {
	const nextDisabledTools = normalizeToolSet(value);
	const changed = toolNamesSetKey(baseDisabledTools) !== toolNamesSetKey(nextDisabledTools);
	baseDisabledTools = nextDisabledTools;
	return changed;
}

function replaceCachedDisabledTools(value: Iterable<string>): boolean {
	const nextDisabledTools = normalizeToolSet(value);
	const changed = toolNamesSetKey(cachedDisabledTools) !== toolNamesSetKey(nextDisabledTools);
	cachedDisabledTools = nextDisabledTools;
	return changed;
}

function markSettingsDirty(): void {
	if (settingsDirty) return;
	settingsDirty = true;
	settingsRevision += 1;
}

function applyDesiredDisabledTools(value: Iterable<string>): boolean {
	const nextDisabledTools = normalizeToolSet(value);
	const changed = toolNamesSetKey(cachedDisabledTools) !== toolNamesSetKey(nextDisabledTools);
	if (!changed) return false;

	cachedDisabledTools = nextDisabledTools;
	settingsDirty = true;
	settingsRevision += 1;
	return true;
}

function getDisabledToolsArray(value: Iterable<string> = cachedDisabledTools): string[] {
	return normalizeToolNames(Array.from(value));
}

function mergeToolSets(base: Iterable<string>, local: Iterable<string>, disk: Iterable<string>): ToolSetMergeResult {
	const baseSet = normalizeToolSet(base);
	const localSet = normalizeToolSet(local);
	const diskSet = normalizeToolSet(disk);
	const merged = new Set<string>();
	const conflicts: string[] = [];
	const allToolNames = new Set<string>([...baseSet, ...localSet, ...diskSet]);

	for (const toolName of Array.from(allToolNames).sort((a, b) => a.localeCompare(b))) {
		const baseHas = baseSet.has(toolName);
		const localHas = localSet.has(toolName);
		const diskHas = diskSet.has(toolName);
		let mergedHas: boolean;

		if (localHas === baseHas) {
			mergedHas = diskHas;
		} else if (diskHas === baseHas || localHas === diskHas) {
			mergedHas = localHas;
		} else {
			mergedHas = diskHas;
			conflicts.push(toolName);
		}

		if (mergedHas) merged.add(toolName);
	}

	return {
		mergedToolNames: getDisabledToolsArray(merged),
		conflicts,
	};
}

function logWarning(message: string): void {
	if (lastConsoleWarning === message) return;
	lastConsoleWarning = message;
	console.warn(`[pi-tool-management] ${message}`);
}

function logError(message: string): void {
	if (lastConsoleError === message) return;
	lastConsoleError = message;
	console.error(`[pi-tool-management] ${message}`);
}

function combineWarnings(...warnings: Array<string | undefined>): string | undefined {
	const parts = warnings.filter(Boolean);
	if (parts.length === 0) return undefined;
	return parts.join("\n\n");
}

function buildSettingsFile(disabledTools: Iterable<string>): ToolSettingsFile {
	return {
		version: SETTINGS_VERSION,
		disabledTools: getDisabledToolsArray(disabledTools),
	};
}

function parseToolSettings(raw: string): ParsedToolSettings {
	const parsed = JSON.parse(raw) as unknown;

	if (Array.isArray(parsed)) {
		return {
			disabledTools: normalizeToolNames(parsed),
			dirty: true,
			warning: `Migrating legacy array format in ${SETTINGS_PATH}`,
		};
	}

	if (!isRecord(parsed)) {
		return {
			disabledTools: [],
			dirty: false,
			warning: `Ignoring invalid settings in ${SETTINGS_PATH}: expected object or array`,
		};
	}

	const normalizedDisabledTools = normalizeToolNames(parsed.disabledTools);
	const normalizedDiffers = Array.isArray(parsed.disabledTools)
		? JSON.stringify(parsed.disabledTools) !== JSON.stringify(normalizedDisabledTools)
		: parsed.disabledTools !== undefined;
	const version = parsed.version;

	if (version === undefined) {
		return {
			disabledTools: normalizedDisabledTools,
			dirty: true,
			warning: `Migrating unversioned settings in ${SETTINGS_PATH}`,
		};
	}

	if (version === SETTINGS_VERSION) {
		return {
			disabledTools: normalizedDisabledTools,
			dirty: normalizedDiffers,
		};
	}

	if (typeof version === "number" && version > SETTINGS_VERSION) {
		return {
			disabledTools: normalizedDisabledTools,
			dirty: false,
			warning: `Settings in ${SETTINGS_PATH} use newer version ${version}; using disabledTools without rewriting.`,
		};
	}

	return {
		disabledTools: normalizedDisabledTools,
		dirty: true,
		warning: `Migrating unexpected settings version in ${SETTINGS_PATH}`,
	};
}

async function readSettingsFromDiskResult(): Promise<DiskSettingsResult> {
	try {
		const raw = await readFile(SETTINGS_PATH, "utf-8");
		try {
			return { kind: "ok", parsed: parseToolSettings(raw) };
		} catch (error) {
			return { kind: "parse-error", message: formatError(error) };
		}
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException;
		if (nodeError?.code === "ENOENT") return { kind: "missing" };
		return { kind: "error", message: formatError(error) };
	}
}

async function waitForPendingSave(): Promise<void> {
	await pendingSave.catch(() => {});
}

async function loadSettingsFromDisk(): Promise<void> {
	const previousBase = new Set(baseDisabledTools);
	const result = await readSettingsFromDiskResult();

	switch (result.kind) {
		case "ok": {
			baseStateValid = true;
			replaceBaseDisabledTools(result.parsed.disabledTools);
			if (settingsDirty) {
				const merged = mergeToolSets(previousBase, cachedDisabledTools, result.parsed.disabledTools);
				replaceCachedDisabledTools(merged.mergedToolNames);
				lastLoadWarning = combineWarnings(
					result.parsed.warning,
					merged.conflicts.length > 0
						? `Concurrent edits detected in ${SETTINGS_PATH}; kept on-disk values for: ${merged.conflicts.join(", ")}`
						: undefined,
				);
			} else {
				replaceCachedDisabledTools(result.parsed.disabledTools);
				lastLoadWarning = result.parsed.warning;
			}

			if (lastLoadWarning) logWarning(lastLoadWarning);
			const nextDirty = toolNamesSetKey(cachedDisabledTools) !== toolNamesSetKey(baseDisabledTools) || result.parsed.dirty;
			if (nextDirty) {
				markSettingsDirty();
			} else {
				settingsDirty = false;
			}
			break;
		}
		case "missing": {
			baseStateValid = true;
			replaceBaseDisabledTools([]);
			if (settingsDirty) {
				const merged = mergeToolSets(previousBase, cachedDisabledTools, []);
				replaceCachedDisabledTools(merged.mergedToolNames);
				lastLoadWarning = merged.conflicts.length > 0
					? `Concurrent edits detected in ${SETTINGS_PATH}; kept on-disk values for: ${merged.conflicts.join(", ")}`
					: undefined;
			} else {
				replaceCachedDisabledTools([]);
				lastLoadWarning = undefined;
			}
			if (lastLoadWarning) logWarning(lastLoadWarning);
			settingsDirty = toolNamesSetKey(cachedDisabledTools) !== toolNamesSetKey(baseDisabledTools);
			break;
		}
		case "parse-error": {
			baseStateValid = false;
			const hasKnownState = settingsLoaded || previousBase.size > 0 || cachedDisabledTools.size > 0;
			if (!hasKnownState) {
				replaceBaseDisabledTools([]);
				replaceCachedDisabledTools([]);
				lastLoadWarning = `Failed to parse ${SETTINGS_PATH}: ${result.message}. Using defaults for this session until the file is repaired.`;
			} else {
				lastLoadWarning = `Failed to parse ${SETTINGS_PATH}: ${result.message}. Keeping the last known settings for this session until the file is repaired.`;
			}
			logWarning(lastLoadWarning);
			break;
		}
		case "error": {
			const hasKnownState = settingsLoaded || previousBase.size > 0 || cachedDisabledTools.size > 0;
			if (!hasKnownState) {
				replaceBaseDisabledTools([]);
				replaceCachedDisabledTools([]);
				lastLoadWarning = `Failed to load ${SETTINGS_PATH}: ${result.message}. Using defaults for this session.`;
			} else {
				lastLoadWarning = `Failed to load ${SETTINGS_PATH}: ${result.message}. Keeping the last known settings for this session.`;
				markSettingsDirty();
			}
			logWarning(lastLoadWarning);
			break;
		}
	}

	settingsLoaded = true;
}

async function ensureSettingsLoaded(options: { reloadFromDisk?: boolean } = {}): Promise<void> {
	if (!settingsLoaded) {
		await loadSettingsFromDisk();
		return;
	}

	if (!options.reloadFromDisk) return;

	await waitForPendingSave();
	await loadSettingsFromDisk();
}

async function saveToolSettings(disabledTools: Iterable<string>): Promise<void> {
	await mkdir(getAgentDir(), { recursive: true });

	const tempPath = `${SETTINGS_PATH}.${process.pid}.${Date.now()}.tmp`;
	const content = `${JSON.stringify(buildSettingsFile(disabledTools), null, 2)}\n`;
	let tempHandle: Awaited<ReturnType<typeof open>> | undefined;
	let dirHandle: Awaited<ReturnType<typeof open>> | undefined;

	try {
		tempHandle = await open(tempPath, "w");
		await tempHandle.writeFile(content, "utf-8");
		await tempHandle.sync();
		await tempHandle.close();
		tempHandle = undefined;

		await rename(tempPath, SETTINGS_PATH);

		dirHandle = await open(dirname(SETTINGS_PATH), "r");
		await dirHandle.sync();
		await dirHandle.close();
		dirHandle = undefined;
	} catch (error) {
		await tempHandle?.close().catch(() => {});
		await dirHandle?.close().catch(() => {});
		await rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}

async function buildMergedSaveState(
	baseSnapshot: Set<string>,
	desiredSnapshot: Set<string>,
): Promise<string[]> {
	if (!baseStateValid) {
		throw new Error(`Refusing to save while ${SETTINGS_PATH} is invalid. Repair the file, then rerun /tools or /tools-status.`);
	}

	const diskResult = await readSettingsFromDiskResult();
	let diskDisabledTools: string[];

	switch (diskResult.kind) {
		case "ok":
			diskDisabledTools = diskResult.parsed.disabledTools;
			if (diskResult.parsed.warning) {
				lastLoadWarning = diskResult.parsed.warning;
				logWarning(diskResult.parsed.warning);
			}
			break;
		case "missing":
			diskDisabledTools = [];
			break;
		case "parse-error":
			throw new Error(`Refusing to overwrite invalid settings file ${SETTINGS_PATH}: ${diskResult.message}`);
		case "error":
			lastLoadWarning = `Failed to read ${SETTINGS_PATH} before save: ${diskResult.message}. Saving over the last known good state.`;
			logWarning(lastLoadWarning);
			diskDisabledTools = getDisabledToolsArray(baseSnapshot);
			break;
	}

	const merged = mergeToolSets(baseSnapshot, desiredSnapshot, diskDisabledTools);
	if (merged.conflicts.length > 0) {
		lastLoadWarning = combineWarnings(
			lastLoadWarning,
			`Concurrent edits detected in ${SETTINGS_PATH}; kept on-disk values for: ${merged.conflicts.join(", ")}`,
		);
		logWarning(lastLoadWarning);
	}
	return merged.mergedToolNames;
}

function queuePersistSettings(onError?: (message: string) => void): void {
	if (!settingsDirty) return;

	const revision = settingsRevision;
	if (queuedSaveRevision === revision) return;

	queuedSaveRevision = revision;
	lastSaveError = undefined;

	pendingSave = pendingSave
		.catch(() => {})
		.then(async () => {
			if (!settingsDirty) {
				if (queuedSaveRevision === revision) queuedSaveRevision = undefined;
				return;
			}

			const baseSnapshot = new Set(baseDisabledTools);
			const desiredSnapshot = new Set(cachedDisabledTools);
			const desiredSnapshotKey = toolNamesSetKey(desiredSnapshot);
			const mergedDisabledTools = await buildMergedSaveState(baseSnapshot, desiredSnapshot);
			await saveToolSettings(mergedDisabledTools);
			if (queuedSaveRevision === revision) queuedSaveRevision = undefined;

			replaceBaseDisabledTools(mergedDisabledTools);
			if (toolNamesSetKey(cachedDisabledTools) === desiredSnapshotKey) {
				replaceCachedDisabledTools(mergedDisabledTools);
			}
			settingsDirty = toolNamesSetKey(cachedDisabledTools) !== toolNamesSetKey(baseDisabledTools);

			lastSaveError = undefined;
			lastLoadWarning = undefined;
			if (settingsDirty) {
				queuePersistSettings(onError);
			}
		})
		.catch((error) => {
			if (queuedSaveRevision === revision) queuedSaveRevision = undefined;
			const message = `Failed to save ${SETTINGS_PATH}: ${formatError(error)}`;
			lastSaveError = message;
			settingsDirty = true;
			logError(message);
			onError?.(message);
		});
}

function getToolCategory(tool: ToolInfo): string {
	if (tool.sourceInfo.source === "builtin") return "Built-in";
	if (tool.sourceInfo.source === "sdk") return "SDK";
	if (tool.sourceInfo.scope === "project") return "Project extension";
	if (tool.sourceInfo.scope === "user") return "User extension";
	return "Extension";
}

function getToolRank(tool: ToolInfo): number {
	if (tool.sourceInfo.source === "builtin") return 0;
	if (tool.sourceInfo.source === "sdk") return 1;
	if (tool.sourceInfo.scope === "project") return 2;
	if (tool.sourceInfo.scope === "user") return 3;
	return 4;
}

function sortTools(tools: ToolInfo[]): ToolInfo[] {
	return [...tools].sort((a, b) => {
		const rank = getToolRank(a) - getToolRank(b);
		if (rank !== 0) return rank;
		return a.name.localeCompare(b.name);
	});
}

function getCurrentActiveToolNames(pi: ExtensionAPI, allTools: ToolInfo[]): string[] {
	const allToolNames = new Set(allTools.map((tool) => tool.name));
	return orderedToolNames(pi.getActiveTools(), allToolNames);
}

function filterAllowedActiveToolNames(activeToolNames: string[]): string[] {
	return activeToolNames.filter((toolName) => !cachedDisabledTools.has(toolName));
}

function enforceDisabledTools(pi: ExtensionAPI, allTools: ToolInfo[]): Set<string> {
	const currentActiveToolNames = getCurrentActiveToolNames(pi, allTools);
	const nextActiveToolNames = filterAllowedActiveToolNames(currentActiveToolNames);

	if (!sameOrderedToolNames(currentActiveToolNames, nextActiveToolNames)) {
		pi.setActiveTools(nextActiveToolNames);
	}

	return new Set(nextActiveToolNames);
}

async function reconcileTools(
	pi: ExtensionAPI,
	options: {
		reloadFromDisk?: boolean;
		persistSanitized?: boolean;
		onSaveError?: (message: string) => void;
	} = {},
): Promise<ToolStateSnapshot> {
	await ensureSettingsLoaded({ reloadFromDisk: options.reloadFromDisk });

	const allTools = sortTools(pi.getAllTools());
	const activeTools = enforceDisabledTools(pi, allTools);

	if (options.persistSanitized && settingsDirty) {
		queuePersistSettings(options.onSaveError);
	}

	return {
		allTools,
		activeTools,
		disabledTools: new Set(cachedDisabledTools),
		loadWarning: lastLoadWarning,
		saveError: lastSaveError,
		dirty: settingsDirty,
	};
}

function buildWarningText(snapshot: ToolStateSnapshot): { level: "warning" | "error"; text?: string } {
	const lines: string[] = [];
	if (snapshot.loadWarning) lines.push(snapshot.loadWarning);
	if (snapshot.saveError) lines.push(`${snapshot.saveError}\nChanges remain applied in this session unless a later reload cannot preserve them.`);

	if (lines.length === 0) return { level: "warning" };
	return {
		level: snapshot.saveError ? "error" : "warning",
		text: lines.join("\n\n"),
	};
}

function applyToolToggle(
	pi: ExtensionAPI,
	toolName: string,
	allowed: boolean,
	onSaveError?: (message: string) => void,
): ToolStateSnapshot {
	const nextDisabledTools = new Set(cachedDisabledTools);
	if (allowed) {
		nextDisabledTools.delete(toolName);
	} else {
		nextDisabledTools.add(toolName);
	}
	applyDesiredDisabledTools(nextDisabledTools);

	const allTools = sortTools(pi.getAllTools());
	const currentActiveToolNames = getCurrentActiveToolNames(pi, allTools);
	const nextActiveToolNames = filterAllowedActiveToolNames(
		allowed ? currentActiveToolNames : currentActiveToolNames.filter((name) => name !== toolName),
	);

	if (!sameOrderedToolNames(currentActiveToolNames, nextActiveToolNames)) {
		pi.setActiveTools(nextActiveToolNames);
	}
	if (settingsDirty) queuePersistSettings(onSaveError);

	return {
		allTools,
		activeTools: new Set(nextActiveToolNames),
		disabledTools: new Set(cachedDisabledTools),
		loadWarning: lastLoadWarning,
		saveError: lastSaveError,
		dirty: settingsDirty,
	};
}

function notifySaveError(message: string, notify: (text: string, level: "error" | "warning" | "info") => void): void {
	notify(`${message}\nChanges remain applied in this session unless a later reload cannot preserve them.`, "error");
}

export default function toolManagementExtension(pi: ExtensionAPI) {
	pi.registerCommand("tools", {
		description: "Manage this extension's global disabled-tools list (~/.pi/agent/tool-settings.json)",
		handler: async (_args, ctx) => {
			const initialState = await reconcileTools(pi, {
				reloadFromDisk: true,
				persistSanitized: true,
				onSaveError: (message) => notifySaveError(message, ctx.ui.notify),
			});
			const warning = buildWarningText(initialState);
			if (warning.text) ctx.ui.notify(warning.text, warning.level);

			if (initialState.allTools.length === 0) {
				ctx.ui.notify("No tools available", "info");
				return;
			}

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const items: SettingItem[] = initialState.allTools.map((tool) => ({
					id: tool.name,
					label: `${tool.name} · ${getToolCategory(tool)}`,
					currentValue: initialState.disabledTools.has(tool.name) ? "blocked by this extension" : "allowed",
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
						const nextState = applyToolToggle(pi, id, newValue === "allowed", (message) => {
							notifySaveError(message, ctx.ui.notify);
						});
						const warningState = buildWarningText(nextState);
						if (warningState.text) ctx.ui.notify(warningState.text, warningState.level);
					},
					() => {
						done(undefined);
					},
				);

				container.addChild(settingsList);
				container.addChild(new Text(theme.fg("dim", "↑↓ navigate • ←/→ toggle • esc close")));

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});
		},
	});

	pi.registerCommand("tools-status", {
		description: "Show tool-settings.json status",
		handler: async (_args, ctx) => {
			const state = await reconcileTools(pi, {
				reloadFromDisk: true,
				persistSanitized: true,
				onSaveError: (message) => notifySaveError(message, ctx.ui.notify),
			});
			const unresolvedDisabledTools = getDisabledToolsArray(state.disabledTools).filter(
				(toolName) => !state.allTools.some((tool) => tool.name === toolName),
			);
			const lines = [
				`settings: ${SETTINGS_PATH}`,
				`currentlyActiveAfterAllFilters: ${state.activeTools.size}/${state.allTools.length}`,
				`disabledTools: ${getDisabledToolsArray(state.disabledTools).join(", ") || "(none)"}`,
				`unsaved: ${state.dirty ? "yes" : "no"}`,
				"note: active count reflects the current runtime tool set after this extension and any other extensions have applied their filters",
			];
			if (unresolvedDisabledTools.length > 0) {
				lines.push(`unresolvedDisabledTools: ${unresolvedDisabledTools.join(", ")}`);
			}
			if (state.loadWarning) lines.push(`loadWarning: ${state.loadWarning}`);
			if (state.saveError) lines.push(`saveError: ${state.saveError}`);
			ctx.ui.notify(lines.join("\n"), state.saveError ? "error" : state.loadWarning ? "warning" : "info");
		},
	});

	pi.on("session_start", async () => {
		await waitForPendingSave();
		await reconcileTools(pi, {
			reloadFromDisk: true,
			persistSanitized: true,
			onSaveError: (message) => logError(message),
		});
	});

	pi.on("session_tree", async () => {
		await waitForPendingSave();
		await reconcileTools(pi, {
			reloadFromDisk: true,
			persistSanitized: true,
			onSaveError: (message) => logError(message),
		});
	});

	pi.on("before_agent_start", async () => {
		await waitForPendingSave();
		await reconcileTools(pi, {
			reloadFromDisk: true,
			persistSanitized: true,
			onSaveError: (message) => logError(message),
		});
	});

	pi.on("before_provider_request", async () => {
		await waitForPendingSave();
		await reconcileTools(pi, {
			reloadFromDisk: true,
			persistSanitized: true,
			onSaveError: (message) => logError(message),
		});
	});
}
