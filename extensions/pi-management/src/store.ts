import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SETTINGS_VERSION = 1;

export function uniqueSorted(arr: string[]): string[] {
	return [...new Set(arr)].sort((a, b) => a.localeCompare(b));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ParseResult = { list: string[] } | { warning: string };

/**
 * Versioned JSON store holding one sorted list of disabled names.
 *
 * `fileName` and `field` stay per-domain on purpose: tool-settings.json keeps
 * its `disabledTools` key and extension-settings.json keeps
 * `disabledExtensions`, so existing files on disk keep working unchanged.
 *
 * Writes are atomic (temp file + rename) and serialized through one queue, so
 * a burst of toggles cannot interleave two writers on the same path.
 */
export function createDisabledListStore(opts: { fileName: string; field: string; logPrefix: string }) {
	const path = join(getAgentDir(), opts.fileName);
	let names = new Set<string>();
	let lastWarning: string | undefined;
	let lastReportedWarning: string | undefined;
	let lastSaveError: string | undefined;
	let saveSequence = 0;
	let saveQueue = Promise.resolve();

	function reportLoadWarning(message: string): void {
		lastWarning = message;
		if (lastReportedWarning === message) return;
		lastReportedWarning = message;
		console.warn(`${opts.logPrefix} ${message}`);
	}

	function clearLoadWarning(): void {
		lastWarning = undefined;
		lastReportedWarning = undefined;
	}

	function parseSettings(raw: string): ParseResult {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) {
			return { warning: `Ignoring invalid settings in ${path}: expected object` };
		}
		if (parsed.version !== SETTINGS_VERSION) {
			return { warning: `Ignoring unsupported settings version in ${path}: ${String(parsed.version)}` };
		}
		const list = parsed[opts.field];
		if (!Array.isArray(list) || list.some((value) => typeof value !== "string" || !value.trim())) {
			return {
				warning: `Ignoring invalid settings in ${path}: ${opts.field} must be an array of non-empty strings`,
			};
		}
		return { list: uniqueSorted((list as string[]).map((name) => name.trim())) };
	}

	async function persistSettings(list: string[]): Promise<void> {
		const tempPath = `${path}.${process.pid}.${saveSequence++}.tmp`;
		const file = { version: SETTINGS_VERSION, [opts.field]: list };
		try {
			await mkdir(getAgentDir(), { recursive: true });
			await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
			await rename(tempPath, path);
			lastSaveError = undefined;
			clearLoadWarning();
		} catch (e) {
			let detail = e instanceof Error ? e.message : String(e);
			try {
				await rm(tempPath, { force: true });
			} catch (cleanupError) {
				detail += `; failed to remove temporary file: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
			}
			const message = `Failed to save ${path}: ${detail}`;
			lastSaveError = message;
			console.error(`${opts.logPrefix} ${message}`);
		}
	}

	return {
		path,
		/** Live set; `load()` replaces it, so always read through this getter. */
		get names(): Set<string> {
			return names;
		},
		get lastWarning(): string | undefined {
			return lastWarning;
		},
		get lastSaveError(): string | undefined {
			return lastSaveError;
		},

		async load(): Promise<void> {
			let raw: string;
			try {
				raw = await readFile(path, "utf-8");
			} catch (e) {
				const err = e as NodeJS.ErrnoException;
				if (err?.code === "ENOENT") {
					names = new Set();
					clearLoadWarning();
					return;
				}
				reportLoadWarning(`Failed to load ${path}: ${err.message}`);
				return;
			}

			let result: ParseResult;
			try {
				result = parseSettings(raw);
			} catch (e) {
				reportLoadWarning(`Failed to parse ${path}: ${e instanceof Error ? e.message : String(e)}`);
				return;
			}
			if ("warning" in result) {
				reportLoadWarning(result.warning);
				return;
			}

			names = new Set(result.list);
			clearLoadWarning();
		},

		save(): Promise<void> {
			const list = uniqueSorted([...names]);
			saveQueue = saveQueue.then(() => persistSettings(list));
			return saveQueue;
		},
	};
}

export type DisabledListStore = ReturnType<typeof createDisabledListStore>;

/** Trailing diagnostic lines shared by both `*-status` commands. */
export function statusDiagnostics(store: DisabledListStore): string[] {
	const lines: string[] = [];
	if (store.lastWarning) lines.push(`loadWarning: ${store.lastWarning}`);
	if (store.lastSaveError) lines.push(`saveError: ${store.lastSaveError}`);
	return lines;
}

/** Severity for a status notification, worst-first. */
export function statusSeverity(store: DisabledListStore): "error" | "warning" | "info" {
	if (store.lastSaveError) return "error";
	if (store.lastWarning) return "warning";
	return "info";
}
