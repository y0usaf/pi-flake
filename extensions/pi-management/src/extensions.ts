import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { getAgentDir, getSettingsListTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { createDisabledListStore, isRecord, statusDiagnostics, statusSeverity, uniqueSorted } from "./store";

// ── Types & constants ──────────────────────────────────────────────

interface ExtensionCandidate {
	/** Stable identity: bundle dir name, or settings-pattern for dir entries. */
	id: string;
	/** Absolute path of the extension entry file. */
	path: string;
	/** Where the entry was discovered. */
	source: "bundle" | "user" | "project";
	/** Human label, e.g. package name or file name. */
	label: string;
}

const ENABLED = "enabled";
const DISABLED = "disabled";
/**
 * Own bundle dir name. Never shown as toggleable: disabling the manager locks
 * you out of both /tools and /extensions, recoverable only by hand-editing
 * extension-settings.json. MUST match the bundle attribute name in the root
 * flake.nix `bundledExtensions` map.
 */
const SELF_NAME = "management";
const ENV_DISABLED = "PI_EXT_DISABLED";
const ENV_DEFAULT_PACKAGES = "PI_DEFAULT_PACKAGES";

const store = createDisabledListStore({
	fileName: "extension-settings.json",
	field: "disabledExtensions",
	logPrefix: "[pi-management/extensions]",
});

// ── Discovery ──────────────────────────────────────────────────────
// pi itself discovers extensions from three places, mirrored here:
//  1. package roots (PI_DEFAULT_PACKAGES roots, one extensions/ dir each)
//  2. ~/.pi/agent/extensions/ (global auto-load)
//  3. <cwd>/.pi/extensions/ (project auto-load)
// Rules per entry copied from pi's collectAutoExtensionEntries: a .ts/.js
// file, or a directory containing index.ts/index.js or package.json with
// pi.extensions entries.

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

function readManifestEntries(dir: string): string[] | undefined {
	const pkgPath = join(dir, "package.json");
	if (!existsSync(pkgPath)) return undefined;
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { pi?: { extensions?: string[] } };
		const entries = pkg?.pi?.extensions;
		if (!Array.isArray(entries) || entries.length === 0) return undefined;
		const resolved = entries.map((e) => join(dir, e)).filter((p) => existsSync(p));
		return resolved.length > 0 ? resolved : undefined;
	} catch {
		return undefined;
	}
}

function discoverInDir(dir: string): { name: string; entry: string }[] {
	if (!existsSync(dir)) return [];
	const found: { name: string; entry: string }[] = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	for (const entry of entries) {
		const entryPath = join(dir, entry.name);
		if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
			found.push({ name: entry.name, entry: entryPath });
			continue;
		}
		if (entry.isDirectory() || entry.isSymbolicLink()) {
			const manifestEntries = readManifestEntries(entryPath);
			if (manifestEntries) {
				for (const e of manifestEntries) found.push({ name: entry.name, entry: e });
				continue;
			}
			for (const idx of ["index.ts", "index.js"]) {
				const idxPath = join(entryPath, idx);
				if (existsSync(idxPath)) {
					found.push({ name: entry.name, entry: idxPath });
					break;
				}
			}
		}
	}
	return found;
}

function bundleRoots(): string[] {
	const raw = process.env[ENV_DEFAULT_PACKAGES];
	if (!raw?.trim()) return [];
	const sep = process.platform === "win32" ? ";" : ":";
	return raw
		.split(sep)
		.map((s) => s.trim())
		.filter(Boolean);
}

function scanExtensions(cwd: string): ExtensionCandidate[] {
	const out: ExtensionCandidate[] = [];
	const seenIds = new Set<string>();

	// Bundle: PI_DEFAULT_PACKAGES roots, one extensions/ dir per root.
	for (const root of bundleRoots()) {
		for (const { name } of discoverInDir(join(root, "extensions"))) {
			if (name === SELF_NAME) continue;
			if (seenIds.has(name)) continue;
			seenIds.add(name);
			out.push({ id: name, path: join(root, "extensions", name), source: "bundle", label: name });
		}
	}

	// Global + project auto-load dirs. Identity for these is the settings
	// pattern pi would match: path relative to the base dir that pi uses.
	const dirSources: { dir: string; base: string; source: "user" | "project" }[] = [
		{ dir: join(getAgentDir(), "extensions"), base: getAgentDir(), source: "user" },
		{ dir: join(cwd, ".pi", "extensions"), base: join(cwd, ".pi"), source: "project" },
	];
	for (const { dir, base, source } of dirSources) {
		for (const { name, entry } of discoverInDir(dir)) {
			const pattern = relative(base, entry).split("\\").join("/");
			if (seenIds.has(pattern)) continue;
			seenIds.add(pattern);
			out.push({ id: pattern, path: entry, source, label: name });
		}
	}
	return out.sort((a, b) => a.label.localeCompare(b.label));
}

// ── Projections ────────────────────────────────────────────────────
// The JSON file is the truth. Two levers read projections of it:
//  - bundle extensions: PI_EXT_DISABLED env var, read by the Nix-generated
//    .pi-gate.ts shim on every /reload.
//  - global/project dir extensions: "-pattern" entries in pi's own
//    settings.json extensions array (same lever `pi config` uses).

function syncEnv(): void {
	const names = uniqueSorted([...store.names]);
	if (names.length === 0) {
		delete process.env[ENV_DISABLED];
	} else {
		process.env[ENV_DISABLED] = names.join(",");
	}
}

function settingsPathFor(source: "user" | "project", cwd: string): string {
	return source === "project" ? join(cwd, ".pi", "settings.json") : join(getAgentDir(), "settings.json");
}

function writePiExtensionPattern(source: "user" | "project", cwd: string, pattern: string, enabled: boolean): void {
	const settingsPath = settingsPathFor(source, cwd);
	let settings: Record<string, unknown> = {};
	try {
		settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
		if (!isRecord(settings)) settings = {};
	} catch {
		settings = {};
	}
	const current = Array.isArray(settings.extensions) ? (settings.extensions as string[]) : [];
	const updated = current.filter((p) => {
		const stripped = p.startsWith("!") || p.startsWith("+") || p.startsWith("-") ? p.slice(1) : p;
		return stripped !== pattern;
	});
	updated.push(`${enabled ? "+" : "-"}${pattern}`);
	settings.extensions = updated;
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

// ── Commands ───────────────────────────────────────────────────────

export function registerExtensionCommands(pi: ExtensionAPI) {
	// Seed env from the persisted list on load. Gate shims read this env var
	// on every /reload; the file is read again on session_start.
	syncEnv();

	pi.on("session_start", async () => {
		await store.load();
		syncEnv();
	});

	pi.registerCommand("extensions", {
		description: `Manage the disabled-extensions list (${store.path})`,
		handler: async (_args, ctx) => {
			await store.load();

			const candidates = scanExtensions(ctx.cwd);
			if (candidates.length === 0) {
				ctx.ui.notify("No extensions discovered", "info");
				return;
			}

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const items: SettingItem[] = candidates.map((ext) => {
					const currentValue = store.names.has(ext.id) ? DISABLED : ENABLED;
					return {
						id: ext.id,
						label: `${ext.label} · ${ext.source}`,
						description: currentValue === DISABLED ? "Disabled: factory will not run after reload." : undefined,
						currentValue,
						values: currentValue === DISABLED ? [DISABLED, ENABLED] : [ENABLED, DISABLED],
					};
				});

				const container = new Container();
				container.addChild(new Text(theme.fg("accent", theme.bold("Extension Management"))));
				container.addChild(new Text(theme.fg("dim", store.path)));
				container.addChild(
					new Text(theme.fg("muted", "Toggling writes settings, updates PI_EXT_DISABLED, then reloads pi.")),
				);
				container.addChild(
					new Text(theme.fg("muted", "bundle = Nix gate shim; user/project = settings.json -pattern.")),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						const ext = candidates.find((c) => c.id === id);
						if (!ext) return;
						const enabled = newValue === ENABLED;

						if (enabled) {
							store.names.delete(id);
						} else {
							store.names.add(id);
						}

						// Projections: own env for bundle gates, pi settings for dir entries.
						syncEnv();
						if (ext.source !== "bundle") {
							try {
								writePiExtensionPattern(ext.source, ctx.cwd, id, enabled);
							} catch (e) {
								ctx.ui.notify(`Failed to write pi settings: ${e instanceof Error ? e.message : String(e)}`, "error");
								return;
							}
						}

						settingsList.updateValue(id, newValue);
						tui.requestRender();

						// Ordering matters: the save must hit disk BEFORE reload, because
						// the reload's session_start handler re-reads the file into
						// memory; a still-queued save would revert this toggle. Then
						// waitForIdle, because ctx.reload() silently no-ops while the
						// agent is streaming or compacting.
						void (async () => {
							await store.save();
							if (store.lastSaveError) {
								ctx.ui.notify(`${store.lastSaveError}\nChanges remain applied in this session.`, "error");
							}
							await ctx.waitForIdle();
							// Must be the last action: the captured ctx goes stale on reload.
							await ctx.reload();
						})().catch((e) => {
							ctx.ui.notify(`Apply failed: ${e instanceof Error ? e.message : String(e)}`, "error");
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

	pi.registerCommand("extensions-status", {
		description: "Show extension-settings.json status",
		handler: async (_args, ctx) => {
			await store.load();

			const candidates = scanExtensions(ctx.cwd);
			const knownIds = new Set(candidates.map((c) => c.id));
			const disabled = uniqueSorted([...store.names]);
			const unresolved = disabled.filter((id) => !knownIds.has(id));

			const lines = [
				`settings: ${store.path}`,
				`env ${ENV_DISABLED}: ${process.env[ENV_DISABLED] ?? "(unset)"}`,
				`bundleRoots: ${bundleRoots().join(", ") || "(none)"}`,
				`discovered: ${candidates.length} (${candidates.map((c) => `${c.label}[${c.source}]`).join(", ") || "none"})`,
				`disabledExtensions: ${disabled.join(", ") || "(none)"}`,
			];
			if (unresolved.length > 0) lines.push(`unresolvedDisabled: ${unresolved.join(", ")}`);
			lines.push(...statusDiagnostics(store));

			ctx.ui.notify(lines.join("\n"), statusSeverity(store));
		},
	});
}
