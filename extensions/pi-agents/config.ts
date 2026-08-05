/**
 * pi-agents config module: the env allowlist (data) and config load/validate
 * plus model resolution (decision-making). Per DESIGN.md: "env allowlist =
 * data; schemas/config-load/contract-normalization/registry = decision-making".
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";

// Extension config
// ---------------------------------------------------------------------------

const CONFIG_FILE_NAME = "pi-agents.json";
const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_MAX_LIVE_AGENTS = 6;

export interface PiAgentsConfig {
	maxDepth: number;
	maxLiveAgents: number;
	/** Model for spawned children: "provider/modelId" or a bare modelId. Unset = inherit the parent session's model. */
	model?: string;
	/** Default panel member models, one spec per member ("provider/modelId" or a bare modelId). Used when agent's panel omits models. */
	panelModels?: string[];
	/** Strip write/edit from the main session so mutations route through spawned executors. Toggle with /orchestrate. */
	orchestrator: boolean;
	/** Directory for child session JSONL files, resolved against cwd at use time. Default `.pi/agents/sessions/` under the parent cwd. */
	sessionDir?: string;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const intAtLeast = (min: number) => (value: unknown, key: string, path: string): number => {
	if (!Number.isInteger(value) || (value as number) < min) {
		throw new Error(`${path}: "${key}" must be an integer ≥ ${min}`);
	}
	return value as number;
};

/** Every config key and its validator; readConfigFragment rejects keys outside this table. */
const CONFIG_VALIDATORS: Record<keyof PiAgentsConfig, (value: unknown, key: string, path: string) => unknown> = {
	maxDepth: intAtLeast(0),
	maxLiveAgents: intAtLeast(1),
	model: (value, key, path) => {
		const spec = typeof value === "string" ? value.trim() : "";
		if (spec === "") throw new Error(`${path}: "${key}" must be a non-empty string ("provider/modelId" or "modelId")`);
		return spec;
	},
	panelModels: (value, key, path) => {
		if (!Array.isArray(value)) throw new Error(`${path}: "${key}" must be an array`);
		if (value.length < 2 || value.length > 5) throw new Error(`${path}: "${key}" must contain between 2 and 5 models`);
		return value.map((spec, index) => {
			if (typeof spec !== "string" || spec.trim() === "") throw new Error(`${path}: "${key}" element ${index} must be a non-empty string`);
			return spec.trim();
		});
	},
	orchestrator: (value, key, path) => {
		if (typeof value !== "boolean") throw new Error(`${path}: "${key}" must be a boolean`);
		return value;
	},
	sessionDir: (value, key, path) => {
		const dir = typeof value === "string" ? value.trim() : "";
		if (dir === "") throw new Error(`${path}: "${key}" must be a non-empty string`);
		return dir;
	},
};

async function readConfigFragment(path: string): Promise<Partial<PiAgentsConfig>> {
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return {};
		throw new Error(`Failed to read ${path}: ${(err as Error).message}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
	}
	if (!isPlainObject(parsed)) {
		throw new Error(`${path}: expected a JSON object`);
	}

	const unknownKeys = Object.keys(parsed).filter((key) => !(key in CONFIG_VALIDATORS));
	if (unknownKeys.length > 0) {
		throw new Error(`${path}: unknown key(s): ${unknownKeys.join(", ")}`);
	}

	const config: Partial<PiAgentsConfig> = {};
	for (const [key, value] of Object.entries(parsed)) {
		(config as Record<string, unknown>)[key] = CONFIG_VALIDATORS[key as keyof PiAgentsConfig](value, key, path);
	}
	return config;
}

export async function loadPiAgentsConfig(cwd: string): Promise<PiAgentsConfig> {
	const globalConfig = await readConfigFragment(join(getAgentDir(), CONFIG_FILE_NAME));
	const projectConfig = await readConfigFragment(resolve(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME));
	return {
		maxDepth: projectConfig.maxDepth ?? globalConfig.maxDepth ?? DEFAULT_MAX_DEPTH,
		maxLiveAgents: projectConfig.maxLiveAgents ?? globalConfig.maxLiveAgents ?? DEFAULT_MAX_LIVE_AGENTS,
		model: projectConfig.model ?? globalConfig.model,
		panelModels: projectConfig.panelModels ?? globalConfig.panelModels,
		orchestrator: projectConfig.orchestrator ?? globalConfig.orchestrator ?? false,
		sessionDir: projectConfig.sessionDir ?? globalConfig.sessionDir,
	};
}

/**
 * Resolve a config model spec against the session's model registry.
 * Accepts "provider/modelId" (exact) or a bare modelId (unique across available providers).
 */
export function resolveChildModel(spec: string, registry: ModelRegistry): Model<any> {
	const slash = spec.indexOf("/");
	if (slash > 0) {
		const scoped = registry.find(spec.slice(0, slash), spec.slice(slash + 1));
		if (scoped) return scoped as Model<any>;
	}
	const matches = registry.getAvailable().filter((candidate) => candidate.id === spec);
	if (matches.length === 1) return matches[0] as Model<any>;
	if (matches.length > 1) {
		throw new Error(
			`pi-agents: model "${spec}" is ambiguous (${matches.map((m) => `${m.provider}/${m.id}`).join(", ")}). ` +
			`Qualify it as "provider/modelId".`,
		);
	}
	throw new Error(
		`pi-agents: model "${spec}" is not in the model registry. ` +
		`Use a "provider/modelId" pair that /model lists, e.g. "anthropic/claude-haiku-4-5".`,
	);
}
