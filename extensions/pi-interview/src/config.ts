import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	INTERVIEW_MODES,
	INTERVIEW_REASONING_LEVELS,
	type InterviewConfig,
	type InterviewMode,
	type InterviewReasoning,
} from "./types.js";

export const DEFAULT_CONFIG: InterviewConfig = {
	mode: "off",
	provider: "",
	model: "",
	reasoning: "low",
	maxTokens: 4096,
	maxQuestions: 3,
	maxOptions: 5,
	maxContextMessages: 8,
	maxContextChars: 24000,
	includeContextFiles: false,
	timeoutMs: 45000,
};

export interface ConfigLoadResult {
	config: InterviewConfig;
	error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerInRange(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function normalize(raw: unknown): InterviewConfig {
	if (!isRecord(raw)) return { ...DEFAULT_CONFIG };
	return {
		mode: INTERVIEW_MODES.includes(raw.mode as InterviewMode) ? (raw.mode as InterviewMode) : DEFAULT_CONFIG.mode,
		provider: typeof raw.provider === "string" ? raw.provider.trim() : DEFAULT_CONFIG.provider,
		model: typeof raw.model === "string" ? raw.model.trim() : DEFAULT_CONFIG.model,
		reasoning: INTERVIEW_REASONING_LEVELS.includes(raw.reasoning as InterviewReasoning)
			? (raw.reasoning as InterviewReasoning)
			: DEFAULT_CONFIG.reasoning,
		maxTokens: integerInRange(raw.maxTokens, DEFAULT_CONFIG.maxTokens, 256, 16384),
		maxQuestions: integerInRange(raw.maxQuestions, DEFAULT_CONFIG.maxQuestions, 1, 5),
		maxOptions: integerInRange(raw.maxOptions, DEFAULT_CONFIG.maxOptions, 2, 7),
		maxContextMessages: integerInRange(raw.maxContextMessages, DEFAULT_CONFIG.maxContextMessages, 0, 30),
		maxContextChars: integerInRange(raw.maxContextChars, DEFAULT_CONFIG.maxContextChars, 2000, 100000),
		includeContextFiles:
			typeof raw.includeContextFiles === "boolean" ? raw.includeContextFiles : DEFAULT_CONFIG.includeContextFiles,
		timeoutMs: integerInRange(raw.timeoutMs, DEFAULT_CONFIG.timeoutMs, 5000, 180000),
	};
}

export function configPath(): string {
	return join(getAgentDir(), "interview.json");
}

export function loadConfig(): ConfigLoadResult {
	const path = configPath();
	if (!existsSync(path)) return { config: { ...DEFAULT_CONFIG } };
	try {
		return { config: normalize(JSON.parse(readFileSync(path, "utf8"))) };
	} catch (error) {
		return {
			config: { ...DEFAULT_CONFIG },
			error: `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function saveConfig(config: InterviewConfig): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.tmp-${process.pid}`;
	writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	renameSync(temporaryPath, path);
}

export function parseBoolean(value: string): boolean | undefined {
	switch (value.trim().toLowerCase()) {
		case "true":
		case "on":
		case "yes":
		case "1":
			return true;
		case "false":
		case "off":
		case "no":
		case "0":
			return false;
		default:
			return undefined;
	}
}
