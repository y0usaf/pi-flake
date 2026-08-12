import { INTERVIEW_MODES, type InterviewConfig, type InterviewMode } from "./types.js";

/**
 * Pure configuration core: no file system, no pi imports, no I/O.
 * Reading and writing interview.json lives in index.ts, the imperative shell.
 *
 * Every tunable field is declared once here. Defaults, ranges, help text, the
 * `/interview config` parser, and the completion list all read this table, so a
 * range can never disagree with itself.
 */
export const CONFIG_FIELDS = {
	maxQuestions: { default: 3, min: 1, max: 5, help: "questions per questionnaire" },
	maxOptions: { default: 5, min: 2, max: 7, help: "options per question, including “Use your judgment”" },
} as const;

export type ConfigFieldName = keyof typeof CONFIG_FIELDS;

export const CONFIG_FIELD_NAMES = Object.keys(CONFIG_FIELDS) as ConfigFieldName[];

export const DEFAULT_CONFIG: InterviewConfig = {
	mode: "off",
	maxQuestions: CONFIG_FIELDS.maxQuestions.default,
	maxOptions: CONFIG_FIELDS.maxOptions.default,
};

export type ConfigFieldResult = { ok: true; config: InterviewConfig } | { ok: false; error: string };
export interface NormalizedConfig { config: InterviewConfig; warnings: string[]; }

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce anything read off disk into a valid config. Unknown keys are dropped. */
export function normalizeConfig(raw: unknown): NormalizedConfig {
	const source = isRecord(raw) ? raw : {};
	const config = { ...DEFAULT_CONFIG };
	const warnings: string[] = [];
	if (source.mode !== undefined && !INTERVIEW_MODES.includes(source.mode as InterviewMode)) warnings.push(`Invalid mode ${String(source.mode)}; using ${DEFAULT_CONFIG.mode}`);
	config.mode = INTERVIEW_MODES.includes(source.mode as InterviewMode) ? (source.mode as InterviewMode) : DEFAULT_CONFIG.mode;
	for (const name of CONFIG_FIELD_NAMES) {
		const field = CONFIG_FIELDS[name], value = source[name];
		if (value !== undefined && !(typeof value === "number" && Number.isInteger(value) && value >= field.min && value <= field.max)) warnings.push(`Invalid ${name}; using ${field.default}`);
		config[name] = typeof value === "number" && Number.isInteger(value) && value >= field.min && value <= field.max ? value : field.default;
	}
	return { config, warnings };
}

/** Apply one `key=value` edit. Returns a new config or an error string. */
export function setConfigField(config: InterviewConfig, key: string, value: string): ConfigFieldResult {
	if (!CONFIG_FIELD_NAMES.includes(key as ConfigFieldName)) {
		return { ok: false, error: `Unknown key ${key}. Known keys: ${CONFIG_FIELD_NAMES.join(", ")}` };
	}
	const name = key as ConfigFieldName;
	const field = CONFIG_FIELDS[name];
	const parsed = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
	if (!Number.isInteger(parsed) || parsed < field.min || parsed > field.max) {
		return { ok: false, error: `${name} must be ${field.min}-${field.max}` };
	}
	return { ok: true, config: { ...config, [name]: parsed } };
}
