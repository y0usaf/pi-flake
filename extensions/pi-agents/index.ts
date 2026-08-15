/**
 * Multi-Agent Extension for pi
 *
 * Parent tools: spawn_agent, kill_agent, list_agents.
 * Children additionally get pi's built-in read/write/edit/bash tools, a
 * progress-only report tool, a submit_answers tool, and descendant-scoped
 * orchestration tools bounded by maxDepth/maxLiveAgents from pi-agents.json.
 *
 * Every spawn carries an AskUserQuestion-style contract (questions,
 * options, allowOther). The run completes only after the child calls
 * submit_answers; the tool result is those answers as data. Enforcement is a
 * re-prompt loop capped at MAX_CONTRACT_NUDGES.
 *
 * An agent's lifetime is its contract: spawn_agent blocks until the child
 * fulfills it, returns the answers as data, and removes the child — a typed
 * function call. Multiple calls in one turn run concurrently.
 *
 * Concurrency invariants (see DESIGN.md):
 * - Spawn capacity and ID uniqueness are reserved synchronously before any
 *   await, so parallel spawn_agent calls cannot both pass the checks.
 * - killSubtree marks states killed and aborts them, but only removes states
 *   with no active run. A running spawn removes its own state in its
 *   finally block once the prompt has settled, so no work continues against
 *   an unregistered agent.
 * - Teardown is identity-checked: callers only remove the exact ChildState
 *   they operated on, never a same-ID replacement.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, type AgentTool, type AgentToolResult, type AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	getAgentDir,
	type ExtensionAPI,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Text, Container, Spacer } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Child bash environment (strict allowlist)
// ---------------------------------------------------------------------------

const SAFE_ENV_KEYS: ReadonlySet<string> = new Set([
	"PATH",
	"HOME",
	"SHELL",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"TERM",
	"COLORTERM",
	"TMPDIR",
	"XDG_RUNTIME_DIR",
	// TLS / CA certificates (required on NixOS and custom-CA environments)
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"CURL_CA_BUNDLE",
	"REQUESTS_CA_BUNDLE",
	"NODE_EXTRA_CA_CERTS",
]);

function buildSafeEnv(): NodeJS.ProcessEnv {
	const safe: NodeJS.ProcessEnv = {};
	for (const key of SAFE_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) safe[key] = value;
	}
	return safe;
}

// ---------------------------------------------------------------------------
// Contract (AskUserQuestion-style): the deliverable a child must fulfill
// ---------------------------------------------------------------------------

/** Host-added answer value: the child's explicit punt, better than fabrication. */
const UNABLE_VALUE = "__unable__";
/** Distinct tally value for a member that never answered this question. */
const NO_ANSWER_VALUE = "__no_answer__";
const MAX_CONTRACT_QUESTIONS = 8;
/** Per question, including the host-added "Unable to determine" option. */
const MAX_CONTRACT_OPTIONS = 8;
const MAX_ANSWER_TEXT = 2000;
/** Watchdog on the enforcement loop: a model refusing at nudge 10 refuses at 500. */
const MAX_CONTRACT_NUDGES = 10;

interface ContractOption {
	value: string;
	label: string;
	description?: string;
	recommended?: boolean;
}

interface ContractQuestion {
	id: string;
	label: string;
	prompt: string;
	options: ContractOption[];
	allowOther: boolean;
}

interface ContractAnswer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
}

/** Shared by reference between the child's submit_answers tool and the owning run loop. */
interface ContractBox {
	questions: ContractQuestion[];
	answers?: ContractAnswer[];
}

const contractOptionSchema = Type.Object({
	label: Type.String({ description: "Short display label" }),
	value: Type.Optional(Type.String({ description: "Stable option value; derived from label when omitted" })),
	description: Type.Optional(Type.String({ description: "Concise meaning or consequence" })),
	recommended: Type.Optional(Type.Boolean({ description: "Hint the preferred answer; at most one per question" })),
});

const contractQuestionSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable question identifier; derived from label/prompt when omitted" })),
	label: Type.Optional(Type.String({ description: "Short label, e.g. Scope" })),
	prompt: Type.String({ description: "Exact question the child must answer" }),
	options: Type.Optional(Type.Array(contractOptionSchema, { description: "Allowed answer values. Empty or omitted makes it a free-text question (requires allowOther)" })),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow a free-text answer; default true" })),
});

const contractSchema = Type.Array(contractQuestionSchema, {
	minItems: 1,
	description:
		"AskUserQuestion-style contract the child must fulfill. The run completes only after the child calls " +
		"submit_answers with one answer per question; the tool result is those answers as data. " +
		'Every question also gets a host-added "Unable to determine" option so the child can punt explicitly.',
});

const submitAnswersSchema = Type.Object({
	answers: Type.Array(
		Type.Object({
			id: Type.String({ description: "Contract question id" }),
			value: Type.String({ description: 'Option value, free text where permitted, or "__unable__" to punt' }),
		}),
		{ description: "One answer per contract question" },
	),
});
// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const spawnSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for the child agent" }),
	system_prompt: Type.String({ description: "System prompt defining the child agent's role and behavior" }),
	task: Type.String({ description: "Initial task to assign to the child agent" }),
	contract: contractSchema,
	timeout_seconds: Type.Optional(Type.Number({ description: "Maximum wall-clock seconds to wait for the agent to finish (must be > 0). If the deadline expires the agent is aborted, removed from the registry, and an error is thrown." })),
	async: Type.Optional(Type.Boolean({ description: "Return immediately after the agent starts; it keeps running in the background. Retrieve its result later with collect_agent. Not valid with panel (panels always block). Default false." })),
	panel: Type.Optional(Type.Object({
		size: Type.Optional(Type.Number({ description: "Number of independent panel members (2-5)" })),
		models: Type.Optional(Type.Array(Type.String(), { description: "One model spec per panel member" })),
	}, { description: "Consult a panel: spawn N independent children on this same contract and return an agreement tally. Members get ids <id>-1..N. `models` gives each member its own model spec (\"provider/modelId\" or a bare id); when omitted, the configured `panelModels` roster is used if present, and `panel: {}` is legal and uses the whole roster. Model diversity is the point; N clones of one model agree because they are the same function, not because the answer is right." })),
});

const killSchema = Type.Object({
	id: Type.String({ description: "ID of the child agent to kill" }),
});

const reportSchema = Type.Object({
	message: Type.String({ description: "Report content to send to the parent agent" }),
});

const listSchema = Type.Object({});

const collectSchema = Type.Object({
	id: Type.String({ description: "ID of the asynchronously spawned agent to collect results from" }),
});

// ---------------------------------------------------------------------------
// Extension config
// ---------------------------------------------------------------------------

const CONFIG_FILE_NAME = "pi-agents.json";
const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_MAX_LIVE_AGENTS = 6;

const CONFIG_KEYS = new Set(["maxDepth", "maxLiveAgents", "model", "panelModels", "orchestrator"]);

interface PiAgentsConfig {
	maxDepth: number;
	maxLiveAgents: number;
	/** Model for spawned children: "provider/modelId" or a bare modelId. Unset = inherit the parent session's model. */
	model?: string;
	/** Default panel member models, one spec per member ("provider/modelId" or a bare modelId). Used when spawn_agent's panel omits models. */
	panelModels?: string[];
	/** Strip write/edit from the main session so mutations route through spawned executors. Toggle with /orchestrate. */
	orchestrator: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNonNegativeInteger(value: unknown, key: string, path: string): number {
	if (!Number.isInteger(value) || (value as number) < 0) {
		throw new Error(`${path}: "${key}" must be an integer ≥ 0`);
	}
	return value as number;
}

function normalizePositiveInteger(value: unknown, key: string, path: string): number {
	if (!Number.isInteger(value) || (value as number) < 1) {
		throw new Error(`${path}: "${key}" must be an integer ≥ 1`);
	}
	return value as number;
}

function normalizeModelSpec(value: unknown, key: string, path: string): string {
	const spec = typeof value === "string" ? value.trim() : "";
	if (spec === "") {
		throw new Error(`${path}: "${key}" must be a non-empty string ("provider/modelId" or "modelId")`);
	}
	return spec;
}

function normalizeBoolean(value: unknown, key: string, path: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${path}: "${key}" must be a boolean`);
	}
	return value;
}

function normalizePanelModels(value: unknown, key: string, path: string): string[] {
	if (!Array.isArray(value)) {
		throw new Error(`${path}: "${key}" must be an array`);
	}
	if (value.length < 2 || value.length > 5) {
		throw new Error(`${path}: "${key}" must contain between 2 and 5 models`);
	}
	return value.map((spec, index) => {
		if (typeof spec !== "string" || spec.trim() === "") {
			throw new Error(`${path}: "${key}" element ${index} must be a non-empty string`);
		}
		return spec.trim();
	});
}

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

	const unknownKeys = Object.keys(parsed).filter((key) => !CONFIG_KEYS.has(key));
	if (unknownKeys.length > 0) {
		throw new Error(`${path}: unknown key(s): ${unknownKeys.join(", ")}`);
	}

	const config: Partial<PiAgentsConfig> = {};
	if ("maxDepth" in parsed) {
		config.maxDepth = normalizeNonNegativeInteger(parsed.maxDepth, "maxDepth", path);
	}
	if ("maxLiveAgents" in parsed) {
		config.maxLiveAgents = normalizePositiveInteger(parsed.maxLiveAgents, "maxLiveAgents", path);
	}
	if ("model" in parsed) {
		config.model = normalizeModelSpec(parsed.model, "model", path);
	}
	if ("panelModels" in parsed) {
		config.panelModels = normalizePanelModels(parsed.panelModels, "panelModels", path);
	}
	if ("orchestrator" in parsed) {
		config.orchestrator = normalizeBoolean(parsed.orchestrator, "orchestrator", path);
	}
	return config;
}

async function loadPiAgentsConfig(cwd: string): Promise<PiAgentsConfig> {
	const globalConfig = await readConfigFragment(join(getAgentDir(), CONFIG_FILE_NAME));
	const projectConfig = await readConfigFragment(resolve(cwd, ".pi", CONFIG_FILE_NAME));
	return {
		maxDepth: projectConfig.maxDepth ?? globalConfig.maxDepth ?? DEFAULT_MAX_DEPTH,
		maxLiveAgents: projectConfig.maxLiveAgents ?? globalConfig.maxLiveAgents ?? DEFAULT_MAX_LIVE_AGENTS,
		model: projectConfig.model ?? globalConfig.model,
		panelModels: projectConfig.panelModels ?? globalConfig.panelModels,
		orchestrator: projectConfig.orchestrator ?? globalConfig.orchestrator ?? false,
	};
}

/**
 * Resolve a config model spec against the session's model registry.
 * Accepts "provider/modelId" (exact) or a bare modelId (unique across available providers).
 */
function resolveChildModel(spec: string, registry: ModelRegistry): Model<any> {
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

// ---------------------------------------------------------------------------
// Streaming details (shared between execute and renderers)
// ---------------------------------------------------------------------------

interface ActivityItem {
	type: "tool_start" | "tool_end" | "report" | "text";
	label: string;
	timestamp: number;
}

interface AgentToolDetails {
	childId: string;
	/** Child model as the TUI shows it: bare id, plus "[provider]" when it differs from the parent's. */
	model?: string;
	activity: ActivityItem[];
	reports: string[];
	contract?: ContractQuestion[];
	answers?: ContractAnswer[];
	panel?: { members: { id: string; model: string; answers: ContractAnswer[] | undefined; reports: string[] }[]; tally: PanelTally };
	error?: string;
	done: boolean;
}

interface PanelTallyQuestion { questionId: string; prompt: string; freeText: boolean; unanimous: boolean; groups: { value: string; label: string; memberIds: string[]; count: number }[]; }
interface PanelTally { questions: PanelTallyQuestion[]; disagreementCount: number; }

const modelLabel = (agent: Agent): string => `${agent.state.model.provider}/${agent.state.model.id}`;

/** Pure tally; free-text questions are never treated as consensus. */
function tallyPanel(questions: ContractQuestion[], members: { id: string; model: string; answers: ContractAnswer[] | undefined }[]): PanelTally {
	let disagreementCount = 0;
	const result = questions.map((question) => {
		const freeText = question.options.filter((o) => o.value !== UNABLE_VALUE).length === 0;
		const groups = new Map<string, { value: string; label: string; memberIds: string[]; count: number }>();
		for (const member of members) {
			const answer = member.answers?.find((a) => a.id === question.id);
			const value = answer ? answer.value : NO_ANSWER_VALUE;
			const label = value === NO_ANSWER_VALUE ? "no answer" : value === UNABLE_VALUE ? "unable to determine" : (answer?.label ?? value);
			const group = groups.get(value) ?? { value, label, memberIds: [], count: 0 };
			group.memberIds.push(member.id); group.count++; groups.set(value, group);
		}
		const unanimous = groups.size === 1 && !groups.has(NO_ANSWER_VALUE);
		if (!freeText && !unanimous) disagreementCount++;
		return { questionId: question.id, prompt: question.prompt, freeText, unanimous, groups: [...groups.values()] };
	});
	return { questions: result, disagreementCount };
}

/**
 * Bare model id, with pi's muted "[provider]" badge (as /model renders it) only
 * when the child runs on a different provider than its parent.
 */
const modelDisplay = (child: Model<any>, parent: Model<any>): string =>
	child.provider === parent.provider ? child.id : `${child.id} [${child.provider}]`;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_RENDERED_ACTIVITY = 8;
// Cap on stored activity items to prevent unbounded growth during a run.
const MAX_ACTIVITY_STORAGE = 500;
const SHUTDOWN_GRACE_MS = 5000;

/**
 * Strip terminal control sequences from child-controlled text before it
 * reaches the TUI: OSC sequences (ESC ] ... ST), CSI sequences, and stray C0
 * controls except tab/newline. Child reports and tool args are untrusted.
 */
function stripControlSequences(value: string): string {
	return value
		.replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C)/g, "")
		.replace(/[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function normalizePositiveTimeout(value: number | undefined, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${label} must be a finite number greater than 0`);
	}
	return value;
}

class AgentTimeoutError extends Error {
	constructor(childId: string, timeoutSeconds: number) {
		super(`Agent "${childId}" timed out after ${timeoutSeconds}s`);
		this.name = "AgentTimeoutError";
	}
}

async function waitForAgentSettlement(agent: Agent, work: Promise<unknown>, graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
	await Promise.race([
		Promise.allSettled([work, agent.waitForIdle()]).then(() => undefined),
		new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
	]);
}

async function withOptionalTimeout<T>(
	agent: Agent,
	childId: string,
	work: Promise<T>,
	timeoutSeconds: number | undefined,
): Promise<T> {
	const timeout = normalizePositiveTimeout(timeoutSeconds, "timeout_seconds");
	if (timeout === undefined) return await work;

	let handle: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;

	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				handle = setTimeout(() => {
					timedOut = true;
					agent.abort();
					reject(new AgentTimeoutError(childId, timeout));
				}, timeout * 1000);
			}),
		]);
	} catch (err) {
		if (timedOut) {
			await waitForAgentSettlement(agent, work);
		}
		throw err;
	} finally {
		clearTimeout(handle);
	}
}

function shortenPath(p: string): string {
	const home = homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatToolActivity(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "bash": {
			const cmd = (args.command as string) || "...";
			return `$ ${cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd}`;
		}
		case "read": {
			const p = shortenPath((args.path as string) || "...");
			const off = args.offset as number | undefined;
			const lim = args.limit as number | undefined;
			let s = `read ${p}`;
			if (off || lim) s += `:${off ?? 1}${lim ? `-${(off ?? 1) + lim - 1}` : ""}`;
			return s;
		}
		case "write":
			return `write ${shortenPath((args.path as string) || "...")}`;
		case "edit":
			return `edit ${shortenPath((args.path as string) || "...")}`;
		case "report": {
			const msg = (args.message as string) || "";
			return `report "${msg.length > 50 ? msg.slice(0, 50) + "..." : msg}"`;
		}
		case "submit_answers": {
			const count = Array.isArray(args.answers) ? args.answers.length : 0;
			return `submit_answers (${count} answer${count === 1 ? "" : "s"})`;
		}
		default: {
			const s = JSON.stringify(args);
			return `${name} ${s.length > 50 ? s.slice(0, 50) + "..." : s}`;
		}
	}
}

// ---------------------------------------------------------------------------
// Contract machinery: normalization (ported from pi-interview protocol.ts),
// validation, prompt rendering, enforcement loop
// ---------------------------------------------------------------------------

function cleanText(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
	if (!cleaned) return undefined;
	return cleaned.slice(0, maxLength);
}

function slugify(value: string, fallback: string): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return normalized || fallback;
}

/** Drop model-supplied options that collide with the host-added punt option. */
function isHostContractOption(value: string, label: string): boolean {
	const normalizedValue = value.trim().toLowerCase();
	const normalizedLabel = label.trim().toLowerCase().replace(/[.!…]+$/g, "");
	return normalizedValue === UNABLE_VALUE || normalizedLabel === "unable to determine";
}

function parseContractOption(raw: unknown, index: number): ContractOption | undefined {
	if (typeof raw === "string") {
		const label = cleanText(raw, 120);
		if (!label) return undefined;
		const value = slugify(label, `option-${index + 1}`);
		if (isHostContractOption(value, label)) return undefined;
		return { value, label };
	}
	if (!isPlainObject(raw)) return undefined;
	const label = cleanText(raw.label, 120);
	if (!label) return undefined;
	const value = cleanText(raw.value, 80) ?? slugify(label, `option-${index + 1}`);
	if (isHostContractOption(value, label)) return undefined;
	return {
		value,
		label,
		description: cleanText(raw.description, 240),
		recommended: raw.recommended === true,
	};
}

function normalizeContractQuestion(raw: unknown, index: number, usedIds: Set<string>): ContractQuestion | undefined {
	if (!isPlainObject(raw)) return undefined;
	const prompt = cleanText(raw.prompt ?? raw.question, 500);
	if (!prompt) return undefined;

	const allowOther = raw.allowOther !== false;
	const options: ContractOption[] = [];
	const usedValues = new Set<string>();
	const usedLabels = new Set<string>();
	let hasRecommended = false;
	const rawOptions = Array.isArray(raw.options) ? raw.options : [];
	for (const candidate of rawOptions) {
		if (options.length >= MAX_CONTRACT_OPTIONS - 1) break;
		const parsed = parseContractOption(candidate, options.length);
		if (!parsed) continue;
		const labelKey = parsed.label.toLowerCase();
		if (usedValues.has(parsed.value) || usedLabels.has(labelKey)) continue;
		usedValues.add(parsed.value);
		usedLabels.add(labelKey);
		if (parsed.recommended) {
			if (hasRecommended) parsed.recommended = false;
			else hasRecommended = true;
		}
		options.push(parsed);
	}
	// Divergence from pi-interview: zero options plus allowOther is a valid
	// free-text question. Zero options without allowOther can answer nothing.
	if (options.length === 0 && !allowOther) return undefined;

	options.push({
		value: UNABLE_VALUE,
		label: "Unable to determine",
		description: "Explicit punt: the question could not be answered from available evidence.",
	});

	const requestedId = cleanText(raw.id, 80) ?? cleanText(raw.label, 80) ?? `question-${index + 1}`;
	const baseId = slugify(requestedId, `question-${index + 1}`);
	let id = baseId;
	let suffix = 2;
	while (usedIds.has(id)) {
		id = `${baseId}-${suffix}`;
		suffix++;
	}
	usedIds.add(id);

	return {
		id,
		label: cleanText(raw.label, 32) ?? `Q${index + 1}`,
		prompt,
		options,
		allowOther,
	};
}

/** Normalize a raw contract or throw. Fail-loud: a contract that normalizes to nothing is a caller bug. */
function normalizeContract(raw: unknown, label: string): ContractQuestion[] {
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new Error(`${label}: contract must be a non-empty array of questions`);
	}
	const questions: ContractQuestion[] = [];
	const usedIds = new Set<string>();
	for (const candidate of raw) {
		if (questions.length >= MAX_CONTRACT_QUESTIONS) break;
		const question = normalizeContractQuestion(candidate, questions.length, usedIds);
		if (question) questions.push(question);
	}
	if (questions.length === 0) {
		throw new Error(
			`${label}: contract normalized to zero questions. ` +
			`Each question needs a non-empty prompt, and at least one option unless allowOther is enabled.`,
		);
	}
	return questions;
}

/** Rendered into every spawn prompt so the child knows its deliverable. */
function renderContractBlock(questions: ContractQuestion[]): string {
	const lines: string[] = [
		"## Contract",
		"Your run is complete only after you call submit_answers with one answer per question below.",
		`Answer with an option value, free text where permitted, or "${UNABLE_VALUE}" to punt explicitly.`,
	];
	for (const question of questions) {
		lines.push(`- id "${question.id}": ${question.prompt}`);
		for (const option of question.options) {
			if (option.value === UNABLE_VALUE) continue;
			let optionLine = `    - value "${option.value}": ${option.label}`;
			if (option.description) optionLine += ` — ${option.description}`;
			if (option.recommended) optionLine += " (recommended)";
			lines.push(optionLine);
		}
		lines.push(`    - free text ${question.allowOther ? "permitted" : "not permitted"}`);
	}
	return lines.join("\n");
}

function validateContractAnswers(
	questions: ContractQuestion[],
	raw: Array<{ id: string; value: string }>,
): ContractAnswer[] {
	const byId = new Map(questions.map((question) => [question.id, question]));
	const accepted = new Map<string, ContractAnswer>();
	const problems: string[] = [];
	for (const entry of raw) {
		const question = byId.get(entry.id);
		if (!question) {
			problems.push(`unknown question id "${entry.id}"`);
			continue;
		}
		const option = question.options.find((candidate) => candidate.value === entry.value.trim());
		if (option) {
			accepted.set(question.id, { id: question.id, value: option.value, label: option.label, wasCustom: false });
			continue;
		}
		if (!question.allowOther) {
			const allowed = question.options.map((candidate) => `"${candidate.value}"`).join(", ");
			problems.push(`"${entry.id}": value must be one of ${allowed}`);
			continue;
		}
		const text = cleanText(entry.value, MAX_ANSWER_TEXT);
		if (!text) {
			problems.push(`"${entry.id}": free-text answer is empty`);
			continue;
		}
		accepted.set(question.id, { id: question.id, value: text, label: text, wasCustom: true });
	}
	const missing = questions.filter((question) => !accepted.has(question.id)).map((question) => `"${question.id}"`);
	if (missing.length > 0) problems.push(`missing answer(s) for ${missing.join(", ")}`);
	if (problems.length > 0) throw new Error(`Contract not fulfilled: ${problems.join("; ")}`);
	return questions.map((question) => accepted.get(question.id)!);
}

function buildSubmitAnswersTool(childId: string, contract: ContractBox): AgentTool<typeof submitAnswersSchema> {
	return {
		name: "submit_answers",
		label: "Submit Answers",
		description:
			"Fulfill your contract: submit one answer per contract question. Each value must be one of the " +
			`question's option values, free text where the question permits it, or "${UNABLE_VALUE}" to punt ` +
			"explicitly. Calling again before the run ends revises the previous submission.",
		parameters: submitAnswersSchema,
		execute: async (_toolCallId, params) => {
			const answers = validateContractAnswers(contract.questions, params.answers);
			contract.answers = answers;
			return {
				content: [{ type: "text", text: `Contract fulfilled: ${answers.length} answer(s) recorded.` }],
				details: { childId, answered: answers.length },
			};
		},
	};
}

const CONTRACT_NUDGE_PROMPT =
	"Your contract is not fulfilled. Call submit_answers now with one answer per contract question. " +
	`If a question cannot be determined, answer it with the value "${UNABLE_VALUE}".`;

/**
 * Enforcement loop: a model cannot be prevented from ending its turn, so the
 * only lever is re-prompting until submit_answers has been called. Bounded by
 * MAX_CONTRACT_NUDGES as the watchdog; abort, timeout, and kill still apply.
 */
async function runUntilContractFulfilled(state: ChildState, prompt: string, signal: AbortSignal | undefined): Promise<void> {
	await state.agent.prompt(prompt);
	let nudges = 0;
	while (
		!state.contract.answers &&
		!state.killed &&
		!signal?.aborted &&
		!state.agent.state.errorMessage &&
		nudges < MAX_CONTRACT_NUDGES
	) {
		nudges++;
		await state.agent.prompt(CONTRACT_NUDGE_PROMPT);
	}
	if (!state.contract.answers && !state.killed && !signal?.aborted && !state.agent.state.errorMessage) {
		throw new Error(`Agent "${state.id}" ended ${nudges} nudged run(s) without calling submit_answers; contract unfulfilled`);
	}
}
// ---------------------------------------------------------------------------
// Child tools: pi built-ins + report
// ---------------------------------------------------------------------------

function createChildTools(cwd: string): AgentTool<any>[] {
	const bashTool = createBashTool(cwd, {
		exposeSessionEnvironment: false,
		spawnHook: (context) => ({ ...context, env: buildSafeEnv() }),
	});
	return [
		createReadTool(cwd) as AgentTool<any>,
		createWriteTool(cwd) as AgentTool<any>,
		createEditTool(cwd) as AgentTool<any>,
		bashTool as AgentTool<any>,
	];
}

// ---------------------------------------------------------------------------
// Child state
// ---------------------------------------------------------------------------

interface ChildState {
	id: string;
	parentId?: string;
	rootId: string;
	depth: number;
	cwd: string;
	createdAt: number;
	agent: Agent;
	/** Precomputed TUI label; the parent model is only in scope at spawn time. */
	modelDisplay: string;
	reports: string[];
	activity: ActivityItem[];
	/** The deliverable for this agent's single run. */
	contract: ContractBox;
	/** Set while the spawn run is in flight; guards teardown ordering. */
	locked: boolean;
	/** Set by killSubtree. The owning run removes this state once its prompt settles. */
	killed: boolean;
	/** Set for async spawns: the background run promise. */
	runPromise?: Promise<AgentToolResult<AgentToolDetails>>;
	/** Error message if an async run failed; surfaced by collect_agent. */
	error?: string;
}

function extractLastAssistantText(agent: Agent): string {
	const messages = agent.state.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const parts = (msg as AssistantMessage).content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text);
			if (parts.length > 0) return parts.join("");
		}
	}
	return "(no output)";
}

function buildReportTool(childId: string, reports: string[]): AgentTool<typeof reportSchema> {
	return {
		name: "report",
		label: "Report",
		description:
			"Send a progress report to the parent agent. Use this for intermediate " +
			"findings; you may call it multiple times and every call is delivered. " +
			"Progress only — the run's result is your submit_answers contract submission.",
		parameters: reportSchema,
		execute: async (_toolCallId, params) => {
			reports.push(stripControlSequences(params.message));
			return {
				content: [{ type: "text", text: "Report delivered to parent." }],
				details: { childId, reportIndex: reports.length - 1 },
			};
		},
	};
}

/** Subscribe to child events, push activity + reports to onUpdate. */
function subscribeChild(
	child: Agent,
	childId: string,
	state: ChildState,
	onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void,
): () => void {
	let emitPending = false;
	let unsubscribed = false;
	const emit = () => {
		if (!emitPending && onUpdate && !unsubscribed) {
			emitPending = true;
			Promise.resolve().then(() => {
				emitPending = false;
				if (unsubscribed) return;
				onUpdate({
					content: [{ type: "text", text: `[${childId}] working...` }],
					details: {
						childId,
						model: state.modelDisplay,
						activity: [...state.activity],
						reports: [...state.reports],
						done: false,
					},
				});
			});
		}
	};

	const trimActivity = () => {
		if (state.activity.length > MAX_ACTIVITY_STORAGE) {
			state.activity = state.activity.slice(-MAX_ACTIVITY_STORAGE);
		}
	};

	const innerUnsub = child.subscribe((event: AgentEvent) => {
		if (event.type === "tool_execution_start") {
			state.activity.push({
				type: "tool_start",
				label: stripControlSequences(formatToolActivity(event.toolName, event.args)),
				timestamp: Date.now(),
			});
			trimActivity();
			emit();
		} else if (event.type === "tool_execution_end") {
			if (event.toolName === "report" && !event.isError) {
				const latest = state.reports[state.reports.length - 1];
				if (latest) {
					state.activity.push({
						type: "report",
						label: `report "${latest.length > 50 ? latest.slice(0, 50) + "..." : latest}"`,
						timestamp: Date.now(),
					});
				}
			} else {
				state.activity.push({
					type: "tool_end",
					label: `${event.toolName} ${event.isError ? "failed" : "done"}`,
					timestamp: Date.now(),
				});
			}
			trimActivity();
			emit();
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			const msg = event.message as AssistantMessage;
			const textParts = msg.content.filter((c): c is TextContent => c.type === "text");
			if (textParts.length > 0) {
				const preview = stripControlSequences(textParts[0].text.split("\n")[0]);
				state.activity.push({
					type: "text",
					label: preview.length > 60 ? preview.slice(0, 60) + "..." : preview,
					timestamp: Date.now(),
				});
				trimActivity();
				emit();
			}
		}
	});

	return () => {
		unsubscribed = true;
		innerUnsub();
	};
}

function collectResult(childId: string, state: ChildState, reportStartIdx: number): AgentToolResult<AgentToolDetails> {
	const newReports = state.reports.slice(reportStartIdx);
	const answers = state.contract.answers;
	let text: string;
	if (answers) {
		const lines = answers.map((answer) => {
			if (answer.value === UNABLE_VALUE) return `- ${answer.id}: (unable to determine)`;
			if (answer.wasCustom) return `- ${answer.id}: ${answer.value}`;
			return `- ${answer.id}: ${answer.value} — ${answer.label}`;
		});
		text = `Contract fulfilled (${answers.length}/${state.contract.questions.length}):\n${lines.join("\n")}`;
		if (newReports.length > 0) text += `\n\nProgress reports:\n${newReports.join("\n---\n")}`;
	} else {
		text = newReports.length > 0 ? newReports.join("\n---\n") : extractLastAssistantText(state.agent);
	}
	const error = state.agent.state.errorMessage;
	return {
		content: [{ type: "text", text: error ? `[Error]: ${error}\n\n${text}` : text }],
		details: {
			childId,
			model: state.modelDisplay,
			activity: [...state.activity],
			reports: [...newReports],
			contract: [...state.contract.questions],
			answers: answers ? [...answers] : undefined,
			error,
			done: true,
		},
	};
}

// ---------------------------------------------------------------------------
// Renderers (spawn_agent)
// ---------------------------------------------------------------------------

function renderAgentCall(
	toolLabel: string,
	args: { id?: string; system_prompt?: string; task?: string; message?: string; contract?: unknown; panel?: { size?: number; models?: string[] } },
	theme: any,
	_context: any,
) {
	const id = args.id || "...";
	const taskText = args.task || args.message || "...";
	const preview = taskText.length > 70 ? taskText.slice(0, 70) + "..." : taskText;
	let text = theme.fg("toolTitle", theme.bold(`${toolLabel} `)) + theme.fg("accent", id);
	if (Array.isArray(args.contract)) text += theme.fg("muted", ` · contract: ${args.contract.length}q`);
	if (args.panel) text += theme.fg("muted", ` · panel ${args.panel.size ?? args.panel.models?.length ?? "?"}`);
	text += "\n  " + theme.fg("dim", preview);
	return new Text(text, 0, 0);
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const truncate = (text: string, n: number): string => (text.length > n ? text.slice(0, n) + "..." : text);

/** " · N actions · N reports · model" — pi joins metadata with a muted middot. */
function metaSuffix(model: string | undefined, activityCount: number, reportCount: number | undefined, theme: any): string {
	const parts = [plural(activityCount, "action")];
	if (reportCount !== undefined) parts.push(plural(reportCount, "report"));
	if (model) parts.push(model);
	return theme.fg("muted", parts.map((part) => ` · ${part}`).join(""));
}

function formatAnswerLines(answers: ContractAnswer[], theme: any): string {
	let text = "";
	for (const answer of answers) {
		const punted = answer.value === UNABLE_VALUE;
		const shownRaw = stripControlSequences(punted ? "unable to determine" : answer.label);
		const shown = shownRaw.length > 70 ? shownRaw.slice(0, 70) + "..." : shownRaw;
		const mark = punted ? theme.fg("warning", "◌") : theme.fg("success", "•");
		text += "\n  " + mark + " " + theme.fg("accent", answer.id) + (answer.wasCustom ? theme.fg("dim", " ✎ ") : " ") + theme.fg("toolOutput", shown);
	}
	return text;
}
function activityIcon(item: ActivityItem, theme: any): string {
	if (item.type === "report") return theme.fg("warning", "↑");
	if (item.type === "tool_start") return theme.fg("accent", "→");
	if (item.type === "text") return theme.fg("dim", "·");
	return theme.fg("success", "✓");
}

function formatActivityTail(activity: ActivityItem[], theme: any): string {
	const visible = activity.slice(-MAX_RENDERED_ACTIVITY);
	const skipped = activity.length - visible.length;
	let text = "";
	if (skipped > 0) text += "\n  " + theme.fg("muted", `... ${skipped} earlier`);
	for (const item of visible) {
		text += "\n  " + activityIcon(item, theme) + " " + theme.fg("dim", item.label);
	}
	return text;
}

function clearSpinner(context: any): void {
	if (context.state._spinnerInterval) {
		clearInterval(context.state._spinnerInterval);
		context.state._spinnerInterval = null;
	}
}

function renderAgentResult(
	result: { content: any[]; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: any,
	context: any,
) {
	const details = (result.details && typeof result.details === "object" && "childId" in result.details)
		? result.details as AgentToolDetails
		: undefined;

	if (!details) {
		clearSpinner(context);
		const t = result.content[0];
		return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
	}

	const { expanded, isPartial } = options;

	// -- panel summary --
	const panel = details.panel;
	const panelWellFormed = panel && Array.isArray(panel.members) && panel.members.every((member) =>
		member && typeof member.id === "string" && typeof member.model === "string" && Array.isArray(member.reports) && member.reports.every((report) => typeof report === "string") &&
		(member.answers === undefined || Array.isArray(member.answers) && member.answers.every((answer) => answer && typeof answer.id === "string" && typeof answer.value === "string" && (answer.label === undefined || typeof answer.label === "string"))),
	) && panel.tally && Array.isArray(panel.tally.questions) && panel.tally.questions.every((question) =>
		question && typeof question.questionId === "string" && typeof question.prompt === "string" && typeof question.freeText === "boolean" && typeof question.unanimous === "boolean" && Array.isArray(question.groups) && question.groups.every((group) =>
			group && typeof group.value === "string" && typeof group.label === "string" && typeof group.count === "number" && Array.isArray(group.memberIds) && group.memberIds.every((id) => typeof id === "string"),
		),
	) && typeof panel.tally.disagreementCount === "number";
	if (panelWellFormed) {
		const icon = theme.fg("success", "✓");
		const header = `${icon} ${theme.fg("toolTitle", theme.bold(stripControlSequences(details.childId)))} · panel ${panel.members.length} · ${panel.tally.disagreementCount} disagreement(s) · ${new Set(panel.members.map((m) => stripControlSequences(m.model))).size} models`;
		const lines = panel.tally.questions.map((q) => {
			const mark = q.freeText ? theme.fg("warning", "◌") : q.unanimous ? theme.fg("success", "•") : theme.fg("warning", "⚠");
			const summary = q.groups.map((g) => `${stripControlSequences(g.label)} (${g.count})`).join(" vs ");
			return `  ${mark} ${theme.fg("accent", truncate(stripControlSequences(q.prompt), 55))} — ${q.freeText ? "free-text — compare manually, not a consensus" : q.unanimous ? "unanimous" : "split"}: ${summary}`;
		});
		if (!expanded) return new Text([header, ...lines].join("\n"), 0, 0);
		const container = new Container();
		container.addChild(new Text(header, 0, 0));
		for (const q of panel.tally.questions) {
			const mark = q.freeText ? theme.fg("warning", "◌") : q.unanimous ? theme.fg("success", "•") : theme.fg("warning", "⚠");
			container.addChild(new Text(`  ${mark} ${theme.fg("accent", truncate(stripControlSequences(q.prompt), 55))}`, 0, 0));
			for (const g of q.groups) for (const id of g.memberIds) {
				const member = panel.members.find((m) => m.id === id); const answer = member?.answers?.find((a) => a.id === q.questionId);
				container.addChild(new Text(`    ${stripControlSequences(id)} [${stripControlSequences(member?.model ?? "?")}]: ${stripControlSequences(answer ? (answer.label ?? answer.value) : "no answer")}`, 0, 0));
			}
		}
		for (const member of panel.members) for (const report of member.reports || []) container.addChild(new Text(`    ${stripControlSequences(member.id)}: ${stripControlSequences(report)}`, 0, 0));
		return container;
	}

	// -- still running: spinner + live activity feed --
	if (isPartial && !details.done) {
		if (!context.state._spinnerInterval) {
			context.state._spinnerFrame = 0;
			context.state._spinnerInterval = setInterval(() => {
				context.state._spinnerFrame = ((context.state._spinnerFrame ?? 0) + 1) % SPINNER_FRAMES.length;
				context.invalidate();
			}, 80);
		}

		const frame = SPINNER_FRAMES[context.state._spinnerFrame ?? 0];
		const activity = details.activity;

		let text = theme.fg("accent", frame) + " " + theme.fg("toolTitle", theme.bold(details.childId));
		text += metaSuffix(details.model, activity.length, undefined, theme);
		text += formatActivityTail(activity, theme);

		const prev = context.lastComponent;
		const component = (prev instanceof Text) ? prev : new Text("", 0, 0);
		component.setText(text);
		return component;
	}

	clearSpinner(context);

	const hasError = !!details.error;
	const icon = hasError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const reports = details.reports || [];
	const activity = details.activity || [];
	const answers = details.answers ?? [];
	const contractTotal = details.contract?.length ?? 0;
	const contractBadge = contractTotal > 0
		? theme.fg("muted", ` · ${answers.length}/${contractTotal} answered`)
		: "";

	// Expanded view
	if (expanded) {
		const container = new Container();
		let header = `${icon} ${theme.fg("toolTitle", theme.bold(details.childId))}`;
		header += metaSuffix(details.model, activity.length, reports.length, theme);
		header += contractBadge;
		if (hasError) header += " " + theme.fg("error", `[error]`);
		container.addChild(new Text(header, 0, 0));

		if (hasError && details.error) {
			container.addChild(new Text(theme.fg("error", `Error: ${details.error}`), 0, 0));
		}

		if (activity.length > 0) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Activity ───"), 0, 0));
			for (const item of activity) {
				container.addChild(new Text(`  ${activityIcon(item, theme)} ${theme.fg("dim", item.label)}`, 0, 0));
			}
		}

		if (reports.length > 0) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Reports ───"), 0, 0));
			for (let i = 0; i < reports.length; i++) {
				container.addChild(new Text(
					theme.fg("warning", `  [${i + 1}] `) + theme.fg("toolOutput", reports[i]),
					0, 0,
				));
			}
		}

		if (answers.length > 0) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Contract ───") + formatAnswerLines(answers, theme), 0, 0));
		}

		const finalText = result.content[0];
		if (finalText?.type === "text" && reports.length === 0 && answers.length === 0) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
			container.addChild(new Text(theme.fg("toolOutput", finalText.text), 0, 0));
		}

		return container;
	}

	// Collapsed view
	let text = `${icon} ${theme.fg("toolTitle", theme.bold(details.childId))}`;
	text += metaSuffix(details.model, activity.length, reports.length, theme);
	text += contractBadge;
	if (hasError && details.error) {
		text += "\n  " + theme.fg("error", details.error);
	} else if (answers.length > 0) {
		text += formatAnswerLines(answers, theme);
	} else {
		text += formatActivityTail(activity, theme);
	}

	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function multiAgent(pi: ExtensionAPI) {
	const children = new Map<string, ChildState>();
	/** IDs reserved by in-flight spawns that have not yet inserted into `children`. */
	const reservedIds = new Set<string>();
	// cachedGetApiKey and cachedRegistry are initialized from the first ctx we see.
	// This assumes modelRegistry is stable for the session lifetime.
	let cachedGetApiKey: ((provider: string) => Promise<string | undefined>) | undefined;
	let cachedRegistry: ModelRegistry | undefined;
	let cachedConfig: PiAgentsConfig | undefined;
	let cachedConfigCwd: string | undefined;
	let cachedConfigError: Error | undefined;

	async function getConfig(cwd: string): Promise<PiAgentsConfig> {
		if (cachedConfig && cachedConfigCwd === cwd) return cachedConfig;
		if (cachedConfigError && cachedConfigCwd === cwd) throw cachedConfigError;

		try {
			const config = await loadPiAgentsConfig(cwd);
			cachedConfig = config;
			cachedConfigCwd = cwd;
			cachedConfigError = undefined;
			return config;
		} catch (err) {
			cachedConfig = undefined;
			cachedConfigCwd = cwd;
			cachedConfigError = err instanceof Error ? err : new Error(String(err));
			throw cachedConfigError;
		}
	}

	function clearConfigCache(): void {
		cachedConfig = undefined;
		cachedConfigCwd = undefined;
		cachedConfigError = undefined;
	}

	// ── Orchestrator mode ───────────────────────────────────────────────
	// Strip write/edit/bash from the main session so mutations route through
	// spawned executors; read/find/grep/ls stay for context-gathering and
	// verification. Removing the tools from the schema (setActiveTools)
	// beats blocking tool_call: the model never sees them, so no turns are
	// burned on rejections. bash is stripped too — it is the write escape
	// hatch (sed -i), and without it there is nothing to police.

	const ORCHESTRATOR_STRIPPED = new Set(["write", "edit", "bash"]);
	let orchestratorOn = false;
	let toolsBeforeOrchestrator: string[] | undefined;

	function applyOrchestrator(on: boolean, ctx: { hasUI: boolean; ui: any }): void {
		if (on === orchestratorOn) return;
		orchestratorOn = on;
		if (on) {
			toolsBeforeOrchestrator ??= pi.getActiveTools();
			pi.setActiveTools(toolsBeforeOrchestrator.filter((name) => !ORCHESTRATOR_STRIPPED.has(name)));
		} else {
			if (toolsBeforeOrchestrator) pi.setActiveTools(toolsBeforeOrchestrator);
			toolsBeforeOrchestrator = undefined;
		}
		if (ctx.hasUI) ctx.ui.setStatus("pi-agents", on ? "orchestrator" : undefined);
	}

	pi.registerCommand("orchestrate", {
		description: "Toggle orchestrator mode (strip write/edit/bash; delegate mutations via spawn_agent)",
		handler: async (_args, ctx) => {
			applyOrchestrator(!orchestratorOn, ctx);
			if (ctx.hasUI) {
				ctx.ui.notify(
					orchestratorOn
						? "Orchestrator mode on: write/edit/bash stripped from the main session; delegate mutations via spawn_agent."
						: "Orchestrator mode off: write/edit/bash restored.",
					"info",
				);
			}
		},
	});

	function getCallerState(callerId: string): ChildState {
		const state = children.get(callerId);
		if (!state) throw new Error(`Caller agent "${callerId}" is no longer active.`);
		return state;
	}

	function isInSubtree(targetId: string, ancestorId: string, allowSelf = true): boolean {
		let current: string | undefined = targetId;
		while (current) {
			if (current === ancestorId) return allowSelf || current !== targetId;
			current = children.get(current)?.parentId;
		}
		return false;
	}

	function getSubtreeIds(rootId: string): string[] {
		const result: string[] = [];
		const queue = [rootId];
		while (queue.length > 0) {
			const current = queue.shift()!;
			if (!children.has(current)) continue;
			result.push(current);
			const childIds = [...children.entries()]
				.filter(([, state]) => state.parentId === current)
				.map(([id]) => id)
				.sort((a, b) => a.localeCompare(b));
			queue.push(...childIds);
		}
		return result;
	}

	function getScopedEntries(callerId?: string): Array<[string, ChildState]> {
		const entries = [...children.entries()].filter(([id]) => !callerId || isInSubtree(id, callerId, true));
		entries.sort((a, b) => a[1].depth - b[1].depth || a[0].localeCompare(b[0]));
		return entries;
	}

	function formatScopedAgentIds(callerId?: string): string {
		const ids = getScopedEntries(callerId).map(([id]) => id);
		return ids.length > 0 ? ids.join(", ") : "(none)";
	}

	function getAccessibleTarget(callerId: string | undefined, targetId: string, action: string, allowSelf = false): ChildState {
		if (callerId) getCallerState(callerId);
		const state = children.get(targetId);
		if (!state || state.killed) {
			throw new Error(
				`Child agent "${targetId}" not found. Visible agents: ${formatScopedAgentIds(callerId)}. ` +
				`Call list_agents() for full status.`,
			);
		}
		if (!callerId) return state;
		if (!isInSubtree(targetId, callerId, allowSelf)) {
			throw new Error(
				`Agent "${callerId}" may only ${action} descendant agents in its own subtree. ` +
				`"${targetId}" is outside that subtree.`,
			);
		}
		return state;
	}

	/**
	 * Mark the subtree killed and abort its agents. States with no active run
	 * are removed immediately; a state whose run is in flight stays registered
	 * (as a killed tombstone) and is removed by that run's finally block once
	 * the prompt settles, so no work continues against an unregistered agent.
	 */
	function killSubtree(rootId: string): { killedIds: string[]; reportCount: number } {
		const ids = getSubtreeIds(rootId);
		let reportCount = 0;
		for (const id of ids) {
			const state = children.get(id);
			if (!state) continue;
			state.killed = true;
			reportCount += state.reports.length;
			state.agent.abort();
		}
		for (const id of ids) {
			const state = children.get(id);
			if (state && !state.locked) children.delete(id);
		}
		return { killedIds: ids, reportCount };
	}

	/** Remove exactly this state if it is still the registered one and has no active run. */
	function removeStateIfCurrent(state: ChildState): void {
		if (!state.locked && children.get(state.id) === state) {
			children.delete(state.id);
		}
	}

	function listAgentsResult(callerId?: string): AgentToolResult<unknown> {
		if (callerId) getCallerState(callerId);
		const agents = getScopedEntries(callerId).map(([id, state]) => ({
			id,
			model: modelLabel(state.agent),
			parentId: state.parentId,
			rootId: state.rootId,
			depth: state.depth,
			cwd: state.cwd,
			isRunning: state.agent.state.isStreaming || state.locked,
			contractFulfilled: state.contract.answers !== undefined,
			reportCount: state.reports.length,
			activityCount: state.activity.length,
			createdAt: state.createdAt,
			error: state.error,
		}));
		const text = agents.length === 0
			? "No active child agents."
			: agents.map((agent) =>
				`• ${agent.id} — ${agent.isRunning ? "running" : "idle"}, depth ${agent.depth}, ` +
				`${agent.parentId ? `parent ${agent.parentId}` : "root child"}, ${agent.model}, ${agent.reportCount} reports, ` +
				`contract ${agent.contractFulfilled ? "fulfilled" : "pending"}` +
				`${agent.error ? `, error: ${agent.error}` : ""}`,
			).join("\n");
		return { content: [{ type: "text", text }], details: { agents } };
	}

	function createChildManagementTools(callerId: string, cwd: string, model: Model<any>): AgentTool<any>[] {
		const spawnTool: AgentTool<typeof spawnSchema> = {
			name: "spawn_agent",
			label: "Spawn Agent",
			description:
				"Spawn a descendant agent within your own subtree. Pass `panel` to get a second opinion instead of judging alone: N independent children answer the same contract on different models and the result is an agreement tally. Requires a contract; " +
				"the descendant's result is its structured contract answers, and it is removed once it answers. " +
				"Subject to configured maxDepth and maxLiveAgents limits.",
			parameters: spawnSchema,
			execute: async (_toolCallId, params, signal, onUpdate) => {
				if (params.panel && params.async) throw new Error("Async panel spawn is not supported; panels always block until the tally is complete.");
				return params.panel ? await spawnPanel(callerId, params, model, cwd, signal, onUpdate) : await spawnChild(callerId, params, model, cwd, signal, onUpdate, undefined, params.async);
			},
		};

		const killTool: AgentTool<typeof killSchema> = {
			name: "kill_agent",
			label: "Kill Agent",
			description: "Kill a descendant agent in your subtree. Descendants are killed recursively.",
			parameters: killSchema,
			execute: async (_toolCallId, params) => {
				const state = getAccessibleTarget(callerId, params.id, "kill");
				const { killedIds, reportCount } = killSubtree(state.id);
				return {
					content: [{ type: "text", text: `Killed ${killedIds.length} agent(s): ${killedIds.join(", ")}.` }],
					details: { childId: state.id, killedIds, reportCount },
				};
			},
		};

		const listTool: AgentTool<typeof listSchema> = {
			name: "list_agents",
			label: "List Agents",
			description: "List agents in your subtree, including yourself.",
			parameters: listSchema,
			execute: async () => listAgentsResult(callerId),
		};

		const collectTool: AgentTool<typeof collectSchema> = {
			name: "collect_agent",
			label: "Collect Agent",
			description: "Collect the result of an asynchronously spawned descendant (spawn_agent with async: true). Blocks until its run finishes, returns its contract answers, and removes it. Throws its error if the run failed.",
			parameters: collectSchema,
			execute: async (_toolCallId, params) => collectAgent(callerId, params),
		};

		return [spawnTool as AgentTool<any>, killTool as AgentTool<any>, listTool as AgentTool<any>, collectTool as AgentTool<any>];
	}

	function buildChildAgent(
		childId: string,
		systemPrompt: string,
		model: Model<any>,
		cwd: string,
		reports: string[],
		contract: ContractBox,
	): Agent {
		const reportTool = buildReportTool(childId, reports);
		const submitTool = buildSubmitAnswersTool(childId, contract);
		const childTools = [
			...createChildTools(cwd),
			...createChildManagementTools(childId, cwd, model),
			reportTool as AgentTool<any>,
			submitTool as AgentTool<any>,
		];
		return new Agent({
			initialState: { systemPrompt, model, tools: childTools },
			streamFn: streamSimple,
			getApiKey: cachedGetApiKey,
		});
	}

	async function spawnChild(
		callerId: string | undefined,
		params: { id: string; system_prompt: string; task: string; timeout_seconds?: number; contract: unknown },
		model: Model<any>,
		cwd: string,
		signal?: AbortSignal,
		onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void,
		modelOverride?: Model<any>,
		asyncMode?: boolean,
	): Promise<AgentToolResult<AgentToolDetails>> {
		if (signal?.aborted) throw new Error(`spawn of "${params.id}" aborted before start`);

		// Reserve ID and capacity synchronously, before any await, so parallel
		// spawn_agent calls cannot both pass these checks.
		if (children.has(params.id) || reservedIds.has(params.id)) {
			throw new Error(
				`Child agent "${params.id}" already exists. ` +
				`Choose a different id, or call list_agents() to inspect active agents.`,
			);
		}
		const parentState = callerId ? getCallerState(callerId) : undefined;
		const childDepth = (parentState?.depth ?? 0) + 1;
		const reservedLive = children.size + reservedIds.size;
		reservedIds.add(params.id);

		try {
			const config = await getConfig(cwd);
			// config.model overrides the inherited parent model; unset means inherit.
			const childModel = modelOverride ?? (config.model && cachedRegistry ? resolveChildModel(config.model, cachedRegistry) : model);
			if (childDepth > config.maxDepth) {
				throw new Error(
					`Cannot spawn agent "${params.id}": depth ${childDepth} exceeds configured maxDepth ${config.maxDepth}.`,
				);
			}
			if (reservedLive >= config.maxLiveAgents) {
				throw new Error(
					`Cannot spawn agent "${params.id}": maxLiveAgents ${config.maxLiveAgents} reached. ` +
					`Kill or reuse an existing agent before spawning another one.`,
				);
			}

			const contract: ContractBox = { questions: normalizeContract(params.contract, `spawn_agent "${params.id}"`) };
			const reports: string[] = [];
			const child = buildChildAgent(params.id, params.system_prompt, childModel, cwd, reports, contract);
			const state: ChildState = {
				id: params.id,
				parentId: parentState?.id,
				rootId: parentState?.rootId ?? params.id,
				depth: childDepth,
				cwd,
				createdAt: Date.now(),
				modelDisplay: modelDisplay(childModel, model),
				agent: child,
				reports,
				activity: [],
				contract,
				locked: true,
				killed: false,
			};
			children.set(params.id, state);

			const onAbort = () => child.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			// Async must not emit partial updates after the tool returns; drop
			// onUpdate, activity is still recorded for list_agents/collect.
			const unsub = subscribeChild(child, params.id, state, asyncMode ? undefined : onUpdate);

			const run = async (): Promise<AgentToolResult<AgentToolDetails>> => {
				try {
					const runPromise = runUntilContractFulfilled(state, `${params.task}\n\n${renderContractBlock(contract.questions)}`, signal);
					await withOptionalTimeout(child, params.id, runPromise, params.timeout_seconds);
					if (state.killed) {
						throw new Error(`Agent "${params.id}" was killed while running`);
					}
					return collectResult(params.id, state, 0);
				} finally {
					state.locked = false;
					unsub();
					signal?.removeEventListener("abort", onAbort);
				}
			};

			if (!asyncMode) {
				try {
					const result = await run();
					// Agent-as-tool: a fulfilled contract ends the agent.
					killSubtree(params.id);
					return result;
				} catch (err) {
					// The subtree is removed on any error; nothing outlives a failed run.
					state.killed = true;
					killSubtree(params.id);
					throw err;
				}
			}

			// Async: fire the run in the background, return a handle immediately.
			// The state stays registered (tombstone) until collect_agent or
			// kill_agent removes it.
			state.runPromise = run();
			void state.runPromise.then(
				() => undefined,
				(err) => {
					state.error = err instanceof Error ? err.message : String(err);
					if (state.killed) removeStateIfCurrent(state);
				},
			);
			return {
				content: [{ type: "text", text: `Spawned "${params.id}" asynchronously; it is running in the background. Call collect_agent("${params.id}") to retrieve its result, list_agents() for status, or kill_agent("${params.id}") to abort.` }],
				details: { childId: params.id, activity: [], reports: [], done: false },
			};
		} finally {
			reservedIds.delete(params.id);
		}
	}

	async function collectAgent(callerId: string | undefined, params: { id: string }): Promise<AgentToolResult<AgentToolDetails>> {
		const state = getAccessibleTarget(callerId, params.id, "collect");
		if (!state.runPromise) {
			throw new Error(`Agent "${params.id}" was not spawned asynchronously; its result was already returned to spawn_agent. Use spawn_agent with async: true.`);
		}
		try {
			return await state.runPromise;
		} finally {
			killSubtree(state.id);
		}
	}

	async function spawnPanel(callerId: string | undefined, params: { id: string; system_prompt: string; task: string; timeout_seconds?: number; contract: unknown; panel?: { size?: number; models?: string[] } }, model: Model<any>, cwd: string, signal?: AbortSignal, onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void): Promise<AgentToolResult<AgentToolDetails>> {
		const config = await getConfig(cwd);
		const models = params.panel?.models;
		const size = params.panel?.size;
		if (models && size !== undefined && models.length !== size) throw new Error(`Panel models length ${models.length} does not match size ${size}`);
		let resolvedSpecs = models;
		if (!models && config.panelModels) {
			if (size !== undefined && size > config.panelModels.length) throw new Error(`Panel size ${size} exceeds configured panelModels length ${config.panelModels.length}`);
			resolvedSpecs = size === undefined ? config.panelModels : config.panelModels.slice(0, size);
		}
		const n = resolvedSpecs?.length ?? size;
		if (n === undefined) throw new Error("Panel requires size or models");
		if (!Number.isInteger(n) || n < 2 || n > 5) throw new Error(`Panel size ${n} must be between 2 and 5`);
		if (children.size + reservedIds.size + n > config.maxLiveAgents) throw new Error(`Panel of ${n} exceeds maxLiveAgents cap ${config.maxLiveAgents} (live count ${children.size + reservedIds.size})`);
		if (resolvedSpecs && !cachedRegistry) throw new Error("pi-agents: cannot resolve panel models because the model registry is not available");
		// Precedence: explicit per-member models, configured panelModels, configured child model, then inherited parent model.
		const memberModels = resolvedSpecs ? resolvedSpecs.map((spec) => resolveChildModel(spec, cachedRegistry as ModelRegistry)) : Array(n).fill(config.model && cachedRegistry ? resolveChildModel(config.model, cachedRegistry) : model);
		const memberParams = Array.from({ length: n }, (_, i) => ({ ...params, id: `${params.id}-${i + 1}`, panel: undefined }));
		let finished = 0;
		// Each member's spawnChild already aborts its agent on the shared signal.
		let firstFailure: unknown;
		let failureSeen = false;
		let teardownStarted = false;
		const promises = memberParams.map((p, i) => spawnChild(callerId, p, model, cwd, signal, undefined, memberModels[i]).catch((reason: unknown) => {
			if (!teardownStarted) {
				teardownStarted = true;
				firstFailure = reason;
				failureSeen = true;
				for (const other of memberParams) if (other.id !== p.id) killSubtree(other.id);
			}
			throw reason;
		}).finally(() => {
			finished++;
			onUpdate?.({ content: [{ type: "text", text: `Panel ${params.id}: ${finished}/${n} members finished` }], details: { childId: params.id, activity: [], reports: [], done: false } });
		}));
		const settled = await Promise.allSettled(promises);
		if (failureSeen) throw new Error(`Panel member failed: ${firstFailure instanceof Error ? firstFailure.message : String(firstFailure)}`);
		const results = settled.map((r) => (r as PromiseFulfilledResult<AgentToolResult<AgentToolDetails>>).value);
		const members = results.map((r, i) => ({ id: memberParams[i].id, model: `${memberModels[i].provider}/${memberModels[i].id}`, answers: r.details?.answers, reports: r.details?.reports ?? [] }));
		const questions = normalizeContract(params.contract, `panel "${params.id}"`);
		const tally = tallyPanel(questions, members);
		const lines = [`Panel "${params.id}": ${n} members, ${new Set(members.map((m) => m.model)).size} distinct models`];
		if (tally.disagreementCount) lines.unshift(`DISAGREEMENT on ${tally.disagreementCount}/${tally.questions.filter((q) => !q.freeText).length} tallyable question(s)`);
		for (const q of tally.questions) {
			lines.push(`${q.prompt} — ${q.freeText ? "[free-text — compare manually, not a consensus]" : q.unanimous ? "[unanimous]" : "[split]"}`);
			for (const g of q.groups) {
				lines.push(`  ${g.value} (${g.count}): ${g.memberIds.join(", ")} [${g.memberIds.map((id) => members.find((m) => m.id === id)?.model).join(", ")}]`);
				if (q.freeText || !q.unanimous) for (const id of g.memberIds) {
					const a = members.find((m) => m.id === id)?.answers?.find((a) => a.id === q.questionId);
					lines.push(`    ${id}: ${stripControlSequences(a ? (a.label ?? a.value) : "no answer")}`);
				}
			}
		}
		for (const member of members) for (const report of member.reports) lines.push(`  ${member.id}: ${stripControlSequences(report)}`);
		return { content: [{ type: "text", text: lines.join("\n") }], details: { childId: params.id, activity: [], reports: [], contract: questions, done: true, panel: { members, tally } } };
	}

	pi.on("session_start", async (_event, ctx) => {
		clearConfigCache();
		orchestratorOn = false;
		toolsBeforeOrchestrator = undefined;
		cachedRegistry ??= ctx.modelRegistry;
		cachedGetApiKey ??= (provider: string) => ctx.modelRegistry.getApiKeyForProvider(provider);
		try {
			const config = await getConfig(ctx.cwd);
			if (config.model) resolveChildModel(config.model, ctx.modelRegistry);
			if (config.panelModels) for (const spec of config.panelModels) resolveChildModel(spec, ctx.modelRegistry);
			if (config.orchestrator) applyOrchestrator(true, ctx);
		} catch (err) {
			if (ctx.hasUI) {
				ctx.ui.notify(`pi-agents config error: ${(err as Error).message}`, "error");
			}
		}
	});

	pi.on("session_shutdown", async () => {
		clearConfigCache();
		const states = [...children.values()];
		for (const state of states) {
			state.killed = true;
			state.agent.abort();
		}
		await Promise.race([
			Promise.allSettled(states.map((state) => state.agent.waitForIdle())).then(() => undefined),
			new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
		]);
		children.clear();
	});

	// ── spawn_agent ─────────────────────────────────────────────────────

	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		description:
			"Spawn a child agent with its own system prompt, task, and contract. " +
			"Pass `panel` to get a second opinion instead of judging alone: N independent children answer the same contract on different models and the result is an agreement tally. " +
			"The contract is the child's deliverable: AskUserQuestion-style questions the child must answer " +
			"via its submit_answers tool before its run can end; the tool result is those answers as data. " +
			"Children get read, write, edit, bash, report (progress only), submit_answers, and descendant-scoped orchestration tools. " +
			"Recursive spawning is bounded by pi-agents.json maxDepth/maxLiveAgents, which also picks the child model. " +
			"This call blocks until the contract is fulfilled; an unfulfilled contract is nudged up to 10 times, then errors. " +
			"Multiple spawn_agent calls in the same turn run concurrently. " +
			"The agent is removed as soon as its contract is fulfilled — spawn is a typed function call: " +
			"contract in, answers out, agent gone. Follow-ups are new spawns with the prior answers folded into the task. " +
			"kill_agent aborts a running agent. " +
			"On any error (including timeout) the agent subtree is removed from the registry automatically.",
		parameters: spawnSchema,
		promptGuidelines: [
			"When write, edit, and bash are unavailable (orchestrator mode), perform all file mutations by spawning executor agents via spawn_agent; keep using read, find, grep, and ls directly for context and verification.",
			"Do not self-judge a ship/block, safety, or correctness call — get a second opinion. When the decision is a judgment rather than a lookup, invoke a panel: use `panel: {}` when `panelModels` is configured; otherwise pass an explicit `models` list. Always give the panel an enumerated verdict question; consensus is only mechanical on questions with options.",
		],

		renderCall(args, theme, context) {
			return renderAgentCall("spawn_agent", args, theme, context);
		},

		renderResult(result, options, theme, context) {
			return renderAgentResult(result, options, theme, context);
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const model = ctx.model;
			if (!model) throw new Error("No model selected");

			cachedRegistry ??= ctx.modelRegistry;
			cachedGetApiKey ??= (provider: string) => ctx.modelRegistry.getApiKeyForProvider(provider);
			if (params.panel && params.async) throw new Error("Async panel spawn is not supported; panels always block until the tally is complete.");
			return params.panel ? await spawnPanel(undefined, params, model, ctx.cwd, signal, onUpdate) : await spawnChild(undefined, params, model, ctx.cwd, signal, onUpdate, undefined, params.async);
		},
	});

	// ── kill_agent ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "kill_agent",
		label: "Kill Agent",
		description:
			"Kill a child agent and free its resources. " +
			"If the child has descendants, they are killed recursively too.",
		parameters: killSchema,

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("kill_agent ")) + theme.fg("error", args.id || "..."), 0, 0);
		},

		renderResult(result) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "done";
			return new Text(text, 0, 0);
		},

		async execute(_toolCallId, params) {
			const state = getAccessibleTarget(undefined, params.id, "kill", true);
			const { killedIds, reportCount } = killSubtree(state.id);
			return {
				content: [{ type: "text", text: `Killed ${killedIds.length} agent(s): ${killedIds.join(", ")}.` }],
				details: { childId: state.id, killedIds, reportCount },
			};
		},
	});

	// ── list_agents ─────────────────────────────────────────────────────

	pi.registerTool({
		name: "list_agents",
		label: "List Agents",
		description: "List all currently active child agent IDs and their status. Includes depth and parent metadata.",
		parameters: listSchema,

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("list_agents")), 0, 0);
		},

		renderResult(result) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "done";
			return new Text(text, 0, 0);
		},

		async execute() {
			return listAgentsResult();
		},
	});

	// ── collect_agent ───────────────────────────────────────────────────

	pi.registerTool({
		name: "collect_agent",
		label: "Collect Agent",
		description:
			"Collect the result of an asynchronously spawned agent (spawn_agent with async: true). " +
			"Blocks until the agent's run finishes, returns its contract answers (the same result a blocking spawn would return), and removes the agent. " +
			"Throws the agent's error if its run failed.",
		parameters: collectSchema,

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("collect_agent ")) + theme.fg("accent", args.id || "..."), 0, 0);
		},

		renderResult(result, options, theme, context) {
			return renderAgentResult(result, options, theme, context);
		},

		async execute(_toolCallId, params) {
			return await collectAgent(undefined, params);
		},
	});
}
