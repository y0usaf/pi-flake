/**
 * Config for pi-sentinel.
 *
 * Self-contained on purpose: this package installs independently of any other
 * Jev extension, so it carries its own transport settings and key resolution.
 *
 * Layering: defaults <- ~/.pi/agent/pi-sentinel.json <- <cwd>/.pi/pi-sentinel.json.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_ENDPOINT,
	DEFAULT_MODEL,
	DEFAULT_RETRIES,
	DEFAULT_TIMEOUT_MS,
} from "./client";

export const CONFIG_FILE = "pi-sentinel.json";
export const API_KEY_ENV = "TYPESAFE_API_KEY";

/** A dimension counts as triggered when it crosses its threshold. */
export interface AuditThresholds {
	/** Flag when the probability of still being on task drops to or below this. */
	onTask: number;
	/** Flag when the probability of an unsupported claim rises to or above this. */
	unsupportedClaim: number;
	/** Flag when the probability of repeating a failed approach reaches this. */
	repeating: number;
}

export interface SentinelConfig {
	endpoint: string;
	model: string;
	apiKey: string | undefined;
	apiKeyFile: string | undefined;
	timeoutMs: number;
	retries: number;
	maxStateChars: number;

	enabled: boolean;
	/** Audit every Nth turn. 1 = every turn. */
	everyTurns: number;
	/** Messages in the audited window, counted back from the newest. */
	windowMessages: number;
	/** Do not audit until the branch has this many messages. */
	minMessages: number;
	/** Hard cap per session, so a long run cannot spend without bound. */
	maxAudits: number;
	/** Inject a reminder into the next turn when drift is found. */
	inject: boolean;
	thresholds: AuditThresholds;
}

export interface LoadedSentinelConfig {
	config: SentinelConfig;
	warnings: string[];
}

interface ParsedConfigFile extends Partial<Omit<SentinelConfig, "thresholds">> {
	thresholds?: Partial<AuditThresholds>;
}

export function defaultSentinelConfig(): SentinelConfig {
	return {
		endpoint: DEFAULT_ENDPOINT,
		model: DEFAULT_MODEL,
		apiKey: undefined,
		apiKeyFile: undefined,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		retries: DEFAULT_RETRIES,
		maxStateChars: 12_000,

		enabled: true,
		everyTurns: 1,
		windowMessages: 24,
		minMessages: 6,
		maxAudits: 40,
		// Off by default: injection was a coin flip in the design review, and a
		// wrong guess here writes words into the model's context.
		inject: false,
		thresholds: { onTask: 0.35, unsupportedClaim: 0.7, repeating: 0.7 },
	};
}

export function loadSentinelConfig(cwd: string): LoadedSentinelConfig {
	const defaults = defaultSentinelConfig();
	const warnings: string[] = [];
	const global = readConfigFile(join(getAgentDir(), CONFIG_FILE), warnings);
	const project = readConfigFile(join(cwd, CONFIG_DIR_NAME, CONFIG_FILE), warnings);

	const config: SentinelConfig = {
		...defaults,
		...global,
		...project,
		thresholds: {
			...defaults.thresholds,
			...global.thresholds,
			...project.thresholds,
		},
	};

	const key = resolveApiKey(config, warnings);
	return { config: { ...config, apiKey: key }, warnings };
}

/**
 * Env wins over config, so a host can inject the key without touching files.
 * apiKeyFile supports "~/" because keys usually live outside the repo.
 */
export function resolveApiKey(
	config: Pick<SentinelConfig, "apiKey" | "apiKeyFile">,
	warnings: string[] = [],
): string | undefined {
	const fromEnv = process.env[API_KEY_ENV]?.trim();
	if (fromEnv) return fromEnv;
	if (config.apiKey?.trim()) return config.apiKey.trim();
	if (!config.apiKeyFile) return undefined;

	const path = expandHome(config.apiKeyFile);
	try {
		const contents = readFileSync(path, "utf8").trim();
		return contents.length > 0 ? contents : undefined;
	} catch (error) {
		warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function readConfigFile(path: string, warnings: string[]): ParsedConfigFile {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		warnings.push(
			`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
		);
		return {};
	}
	if (typeof parsed !== "object" || parsed === null) {
		warnings.push(`${path}: expected a JSON object`);
		return {};
	}

	const out: ParsedConfigFile = {};
	const endpoint = asString(Reflect.get(parsed, "endpoint"));
	if (endpoint) out.endpoint = endpoint;
	const model = asString(Reflect.get(parsed, "model"));
	if (model) out.model = model;
	const apiKey = asString(Reflect.get(parsed, "apiKey"));
	if (apiKey) out.apiKey = apiKey;
	const apiKeyFile = asString(Reflect.get(parsed, "apiKeyFile"));
	if (apiKeyFile) out.apiKeyFile = apiKeyFile;
	const timeoutMs = asPositiveInt(Reflect.get(parsed, "timeoutMs"));
	if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
	const retries = asNonNegativeInt(Reflect.get(parsed, "retries"));
	if (retries !== undefined) out.retries = retries;
	const maxStateChars = asPositiveInt(Reflect.get(parsed, "maxStateChars"));
	if (maxStateChars !== undefined) out.maxStateChars = maxStateChars;

	const enabled = Reflect.get(parsed, "enabled");
	if (typeof enabled === "boolean") out.enabled = enabled;
	const inject = Reflect.get(parsed, "inject");
	if (typeof inject === "boolean") out.inject = inject;
	const everyTurns = asPositiveInt(Reflect.get(parsed, "everyTurns"));
	if (everyTurns !== undefined) out.everyTurns = everyTurns;
	const windowMessages = asPositiveInt(Reflect.get(parsed, "windowMessages"));
	if (windowMessages !== undefined) out.windowMessages = windowMessages;
	const minMessages = asPositiveInt(Reflect.get(parsed, "minMessages"));
	if (minMessages !== undefined) out.minMessages = minMessages;
	const maxAudits = asNonNegativeInt(Reflect.get(parsed, "maxAudits"));
	if (maxAudits !== undefined) out.maxAudits = maxAudits;

	const thresholds = Reflect.get(parsed, "thresholds");
	if (typeof thresholds === "object" && thresholds !== null) {
		const parsedThresholds: Partial<AuditThresholds> = {};
		const onTask = asRatio(Reflect.get(thresholds, "onTask"));
		if (onTask !== undefined) parsedThresholds.onTask = onTask;
		const unsupportedClaim = asRatio(Reflect.get(thresholds, "unsupportedClaim"));
		if (unsupportedClaim !== undefined) {
			parsedThresholds.unsupportedClaim = unsupportedClaim;
		}
		const repeating = asRatio(Reflect.get(thresholds, "repeating"));
		if (repeating !== undefined) parsedThresholds.repeating = repeating;
		out.thresholds = parsedThresholds;
	}

	return out;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function asPositiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: undefined;
}

function asNonNegativeInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: undefined;
}

function asRatio(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
		? value
		: undefined;
}
