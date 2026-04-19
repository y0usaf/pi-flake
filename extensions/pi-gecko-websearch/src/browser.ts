import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { type ChildProcess, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MarionetteClient } from "./marionette.js";

interface GeckoWebsearchSettings {
	binary?: string;
	profile?: string;
	profileRoot?: string;
}

interface ExtensionSettingsFile {
	"gecko-websearch"?: GeckoWebsearchSettings;
	geckoWebsearch?: GeckoWebsearchSettings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readSettings(filePath: string): GeckoWebsearchSettings {
	if (!fs.existsSync(filePath)) return {};

	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
		if (!isRecord(parsed)) return {};

		const file = parsed as ExtensionSettingsFile;
		const settings = file["gecko-websearch"] ?? file.geckoWebsearch;
		if (!isRecord(settings)) return {};

		return {
			binary: typeof settings.binary === "string" ? settings.binary.trim() || undefined : undefined,
			profile: typeof settings.profile === "string" ? settings.profile.trim() || undefined : undefined,
			profileRoot: typeof settings.profileRoot === "string" ? settings.profileRoot.trim() || undefined : undefined,
		};
	} catch (error) {
		console.error(
			`[gecko-websearch] Failed to load ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return {};
	}
}

/**
 * Manages the lifecycle of a headless Gecko browser instance
 * with Marionette enabled.
 */
export class BrowserManager {
	private process: ChildProcess | null = null;
	private client: MarionetteClient | null = null;
	private tempProfileDir: string | null = null;
	private running = false;
	private readonly settings: GeckoWebsearchSettings;

	constructor(cwd: string = process.cwd()) {
		const globalSettings = readSettings(path.join(getAgentDir(), "extension-settings.json"));
		const projectSettings = readSettings(path.join(cwd, ".pi", "extension-settings.json"));
		this.settings = { ...globalSettings, ...projectSettings };
	}

	/** Get the Marionette client. Only valid after ensureRunning(). */
	getClient(): MarionetteClient {
		if (!this.client || !this.running) {
			throw new Error("Browser not running. Call ensureRunning() first.");
		}
		return this.client;
	}

	/** Lazy-init: if browser isn't running, start it and connect Marionette. */
	async ensureRunning(): Promise<MarionetteClient> {
		if (this.running && this.client?.isConnected) {
			return this.client;
		}

		// Clean up any previous state
		await this.shutdown();

		// 1. Create temp profile directory
		this.tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gecko-"));

		// 2. Copy cookies from user's real profile
		const sourceProfile = this.resolveProfilePath();
		if (sourceProfile) {
			this.copyCookies(sourceProfile, this.tempProfileDir);
		}

		// 3. Write a user.js to the temp profile to configure Marionette
		const userJs = [
			'user_pref("marionette.port", 2828);',
			'user_pref("marionette.enabled", true);',
			// Disable first-run stuff
			'user_pref("browser.shell.checkDefaultBrowser", false);',
			'user_pref("browser.startup.homepage_override.mstone", "ignore");',
			'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
			'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
			// Disable session restore prompts
			'user_pref("browser.sessionstore.resume_from_crash", false);',
			// Reduce resource usage
			'user_pref("browser.cache.disk.enable", false);',
			'user_pref("media.hardware-video-decoding.enabled", false);',
		].join("\n");
		fs.writeFileSync(path.join(this.tempProfileDir, "user.js"), userJs);

		// 4. Find the Gecko browser binary
		const binary = this.findBinary();

		// 5. Spawn headless Gecko browser with Marionette
		const args = ["--marionette", "--headless", "--profile", this.tempProfileDir, "--no-remote"];

		this.process = spawn(binary, args, {
			stdio: "ignore",
			detached: false,
		});

		this.process.on("exit", () => {
			this.running = false;
		});

		// 6. Wait for Marionette port to be ready, then connect
		this.client = new MarionetteClient();
		await this.waitForMarionette(this.client, 2828, 15000);

		// 7. Create a session
		await this.client.newSession();

		this.running = true;
		return this.client;
	}

	/** Wait for the Marionette port to accept connections, retrying. */
	private async waitForMarionette(client: MarionetteClient, port: number, timeoutMs: number): Promise<void> {
		const start = Date.now();
		const retryDelay = 500;

		while (Date.now() - start < timeoutMs) {
			try {
				await client.connect(port);
				return;
			} catch {
				// Not ready yet — wait and retry
				await new Promise((r) => setTimeout(r, retryDelay));
			}
		}
		throw new Error(`Timed out waiting for Marionette on port ${port} after ${timeoutMs}ms`);
	}

	/**
	 * Resolve the Gecko profile path.
	 * Priority: PI_GECKO_PROFILE env → settings profile → PI_GECKO_PROFILE_ROOT env
	 * → settings profileRoot → auto-detect Firefox/LibreWolf roots.
	 */
	private resolveProfilePath(): string | null {
		const configuredProfile = process.env.PI_GECKO_PROFILE || this.settings.profile;
		if (configuredProfile && fs.existsSync(configuredProfile)) {
			return configuredProfile;
		}

		const home = os.homedir();
		const profileRoots = [
			process.env.PI_GECKO_PROFILE_ROOT,
			this.settings.profileRoot,
			path.join(home, ".mozilla", "firefox"),
			path.join(home, ".librewolf"),
		];

		for (const profileRoot of profileRoots) {
			const profile = this.resolveProfileRoot(profileRoot);
			if (profile) return profile;
		}

		return null;
	}

	private resolveProfileRoot(profileRoot: string | undefined): string | null {
		if (!profileRoot || !fs.existsSync(profileRoot)) return null;

		const profilesIni = path.join(profileRoot, "profiles.ini");
		if (fs.existsSync(profilesIni)) {
			const parsed = this.parseProfilesIni(profilesIni);
			if (parsed) return parsed;
		}

		return this.scanProfileRoot(profileRoot);
	}

	private scanProfileRoot(profileRoot: string): string | null {
		if (fs.existsSync(path.join(profileRoot, "cookies.sqlite"))) {
			return profileRoot;
		}

		try {
			const entries = fs.readdirSync(profileRoot, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory() && entry.name.includes(".default")) {
					const candidate = path.join(profileRoot, entry.name);
					if (fs.existsSync(path.join(candidate, "cookies.sqlite"))) {
						return candidate;
					}
				}
			}
			for (const entry of entries) {
				if (entry.isDirectory()) {
					const candidate = path.join(profileRoot, entry.name);
					if (fs.existsSync(path.join(candidate, "cookies.sqlite"))) {
						return candidate;
					}
				}
			}
		} catch {
			// ignore
		}

		return null;
	}

	/**
	 * Parse profiles.ini and return the default profile path.
	 * Looks for the profile marked Default=1 or the first [Profile*] section.
	 */
	private parseProfilesIni(iniPath: string): string | null {
		const content = fs.readFileSync(iniPath, "utf-8");
		const lines = content.split("\n");

		let currentSection = "";
		let currentPath = "";
		let currentIsRelative = true;
		let defaultProfile: string | null = null;
		let firstProfile: string | null = null;

		const baseDir = path.dirname(iniPath);

		const resolveProfilePath = (p: string, isRelative: boolean): string => {
			return isRelative ? path.join(baseDir, p) : p;
		};

		for (const rawLine of lines) {
			const line = rawLine.trim();

			if (line.startsWith("[")) {
				// Flush previous section
				if (currentSection.toLowerCase().startsWith("profile") && currentPath) {
					const resolved = resolveProfilePath(currentPath, currentIsRelative);
					if (!firstProfile) firstProfile = resolved;
				}

				currentSection = line.slice(1, -1);
				currentPath = "";
				currentIsRelative = true;
				continue;
			}

			const eqIdx = line.indexOf("=");
			if (eqIdx === -1) continue;

			const key = line.substring(0, eqIdx).trim();
			const value = line.substring(eqIdx + 1).trim();

			if (key === "Path") currentPath = value;
			if (key === "IsRelative") currentIsRelative = value === "1";
			if (key === "Default" && value === "1" && currentPath) {
				defaultProfile = resolveProfilePath(currentPath, currentIsRelative);
			}
		}

		// Flush last section
		if (currentSection.toLowerCase().startsWith("profile") && currentPath && !firstProfile) {
			firstProfile = resolveProfilePath(currentPath, currentIsRelative);
		}

		const chosen = defaultProfile || firstProfile;
		if (chosen && fs.existsSync(chosen)) return chosen;
		return null;
	}

	/** Copy cookies.sqlite (and cert9.db if present) from source to dest profile. */
	private copyCookies(sourceProfile: string, destProfile: string): void {
		const filesToCopy = ["cookies.sqlite", "cert9.db"];
		for (const file of filesToCopy) {
			const src = path.join(sourceProfile, file);
			if (fs.existsSync(src)) {
				try {
					fs.copyFileSync(src, path.join(destProfile, file));
				} catch {
					// Non-fatal: we can still browse without cookies
				}
			}
		}
	}

	/** Find the Gecko browser binary. */
	private findBinary(): string {
		const configuredCandidates = [process.env.PI_GECKO_BINARY, this.settings.binary];
		for (const candidate of configuredCandidates) {
			const resolved = this.resolveBinaryCandidate(candidate);
			if (resolved) return resolved;
		}

		const candidates = [
			"firefox",
			"librewolf",
			"/usr/bin/firefox",
			"/usr/local/bin/firefox",
			"/snap/bin/firefox",
			"/var/lib/flatpak/exports/bin/org.mozilla.firefox",
			path.join(os.homedir(), ".local/bin/firefox"),
			"/usr/bin/librewolf",
			"/usr/local/bin/librewolf",
			"/snap/bin/librewolf",
			"/var/lib/flatpak/exports/bin/io.gitlab.librewolf-community",
			path.join(os.homedir(), ".local/bin/librewolf"),
			"/Applications/Firefox.app/Contents/MacOS/firefox",
			"/Applications/LibreWolf.app/Contents/MacOS/librewolf",
		];

		for (const candidate of candidates) {
			const resolved = this.resolveBinaryCandidate(candidate);
			if (resolved) return resolved;
		}

		// Fallback: just try "firefox" and let spawn fail with a clear error
		return "firefox";
	}

	private resolveBinaryCandidate(candidate: string | undefined): string | null {
		if (!candidate) return null;
		const value = candidate.trim();
		if (!value) return null;

		if (value.includes("/") || value.includes(path.sep)) {
			return fs.existsSync(value) ? value : null;
		}

		const command = process.platform === "win32" ? "where" : "which";
		const result = spawnSync(command, [value], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (result.status !== 0) return null;

		const resolved = result.stdout.trim().split(/\r?\n/, 1)[0];
		return resolved || null;
	}

	/** Shut down the browser and clean up. */
	async shutdown(): Promise<void> {
		if (this.client) {
			try {
				await this.client.close();
			} catch {
				// ignore
			}
			this.client = null;
		}

		if (this.process) {
			try {
				this.process.kill("SIGTERM");
				// Give it a moment, then SIGKILL if needed
				await new Promise<void>((resolve) => {
					const timer = setTimeout(() => {
						try {
							this.process?.kill("SIGKILL");
						} catch {
							// ignore
						}
						resolve();
					}, 3000);

					this.process!.once("exit", () => {
						clearTimeout(timer);
						resolve();
					});
				});
			} catch {
				// ignore
			}
			this.process = null;
		}

		if (this.tempProfileDir) {
			try {
				fs.rmSync(this.tempProfileDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
			this.tempProfileDir = null;
		}

		this.running = false;
	}
}
