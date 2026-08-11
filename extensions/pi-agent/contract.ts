/**
 * pi-agents contract module (decision-making): the AskUserQuestion-style
 * deliverable — TypeBox schemas, normalization, answer validation, prompt
 * rendering, and the capped nudge enforcement loop, plus the child-only
 * report/submit_answers/ask_parent tools, the child-mode env protocol
 * (the boundary between the parent and a literal `pi --mode rpc` child), and
 * the child-mode tool wrappers registered by index.ts's child-mode branch.
 * Per DESIGN.md: "contract normalization, answer validation, prompt
 * rendering, nudge loop — decision-making (pure except the loop's prompts)".
 */
import { type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { isPlainObject } from "./config.js";

// ---------------------------------------------------------------------------
// Contract (AskUserQuestion-style): the deliverable a child must fulfill
// ---------------------------------------------------------------------------

/** Host-added answer value: the child's explicit punt, better than fabrication. */
export const UNABLE_VALUE = "__unable__";
/** Distinct tally value for a member that never answered this question. */
export const NO_ANSWER_VALUE = "__no_answer__";
const MAX_CONTRACT_QUESTIONS = 8;
/** Per question, including the host-added "Unable to determine" option. */
const MAX_CONTRACT_OPTIONS = 8;
const MAX_ANSWER_TEXT = 4000;
/** Watchdog on the enforcement loop: a model refusing at nudge 2 refuses at 500. */
export const MAX_CONTRACT_NUDGES = 2;
/** Budget on parent round-trips; each ask costs a deliberate parent tool call, the nudge cap remains the ultimate watchdog. */
const MAX_ASKS = 8;

export interface ContractOption {
	value: string;
	label: string;
	description?: string;
	recommended?: boolean;
}

export interface ContractQuestion {
	id: string;
	label: string;
	prompt: string;
	options: ContractOption[];
	allowOther: boolean;
}

export interface ContractAnswer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
}

/** Shared by reference between the child's submit_answers tool and the owning run loop. */
export interface ContractBox {
	questions: ContractQuestion[];
	answers?: ContractAnswer[];
	pendingAsk?: ContractQuestion[];
}

const contractOptionSchema = Type.Object({
	label: Type.String({ description: "Short display label" }),
	value: Type.Optional(Type.String({ description: "Stable option value; derived from label when omitted" })),
	description: Type.Optional(Type.String({ description: "Concise meaning or consequence" })),
	recommended: Type.Optional(Type.Boolean({ description: "Hint the preferred answer; at most one per question" })),
});

export const contractQuestionSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable question identifier; derived from label/prompt when omitted" })),
	label: Type.Optional(Type.String({ description: "Short label, e.g. Scope" })),
	prompt: Type.String({ description: "Exact question the child must answer" }),
	options: Type.Optional(Type.Array(contractOptionSchema, { description: "Allowed answer values. Empty or omitted makes it a free-text question (requires allowOther)" })),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow a free-text answer; default true" })),
});

export const contractSchema = Type.Array(contractQuestionSchema, {
	minItems: 1,
	description:
		"AskUserQuestion-style contract the child must fulfill. The run completes only after the child calls " +
		"submit_answers with one answer per question; the tool result is those answers as data. " +
		'Every question also gets a host-added "Unable to determine" option so the child can punt explicitly.',
});

const contractAnswerSchema = Type.Object({
	id: Type.String({ description: "Contract question id" }),
	value: Type.String({ description: 'Option value, free text where permitted, or "__unable__" to punt' }),
});
export const contractAnswersSchema = Type.Array(contractAnswerSchema, { description: "One answer per contract question" });
const submitAnswersSchema = Type.Object({ answers: contractAnswersSchema });
const askParentSchema = Type.Object({
	questions: Type.Array(contractQuestionSchema, { minItems: 1, description: "Questions for your parent, same shape as a contract. Your run suspends until the parent answers." }),
});

export const reportSchema = Type.Object({
	message: Type.String({ description: "Report content to send to the parent agent" }),
});

// ---------------------------------------------------------------------------
// Child-mode env protocol: the boundary between a parent and a literal
// `pi --mode rpc` subprocess spawned via process.execPath. The stage-2
// rpc-child engine builds these env vars and the child-mode branch in
// index.ts reads them. Kept here (under ~40 lines) rather than a new module
// so the nix-built package needs no installPhase change; the contract env
// var is itself a contract, so contract.ts is its natural home.
// ---------------------------------------------------------------------------

export const PI_AGENTS_CHILD = "PI_AGENTS_CHILD";
export const PI_AGENTS_DEPTH = "PI_AGENTS_DEPTH";
export const PI_AGENTS_CONTRACT = "PI_AGENTS_CONTRACT";

/**
 * Read the child-mode env protocol. Returns undefined when this process is
 * not a child (PI_AGENTS_CHILD !== "1"). Fails loud on a missing/invalid
 * depth or a malformed contract (fail-loud per canon).
 */
export function readChildEnv(): { depth: number; contract: ContractQuestion[] } | undefined {
	if (process.env[PI_AGENTS_CHILD] !== "1") return undefined;
	const rawDepth = process.env[PI_AGENTS_DEPTH];
	const rawContract = process.env[PI_AGENTS_CONTRACT];
	if (rawDepth === undefined || rawContract === undefined) {
		throw new Error(`pi-agents child mode: ${PI_AGENTS_DEPTH} and ${PI_AGENTS_CONTRACT} must both be set when ${PI_AGENTS_CHILD}=1`);
	}
	const depth = Number(rawDepth);
	if (!Number.isInteger(depth) || depth < 0) {
		throw new Error(`pi-agents child mode: ${PI_AGENTS_DEPTH} must be a non-negative integer; got "${rawDepth}"`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawContract);
	} catch (error) {
		throw new Error(`pi-agents child mode: ${PI_AGENTS_CONTRACT} is malformed JSON: ${(error as Error).message}`);
	}
	return { depth, contract: normalizeContract(parsed, PI_AGENTS_CONTRACT) };
}

/**
 * Build the child-mode env vars the rpc-child engine passes to a spawned pi
 * subprocess. The contract env var carries the questions WITHOUT the
 * host-added "Unable to determine" option: readChildEnv re-runs
 * normalizeContract, which drops host-colliding options (value
 * UNABLE_VALUE or a "unable to determine" label) — sending an
 * already-normalized contract verbatim would trip that filter loudly.
 * Stripping the host option here makes the child round-trip cleanly (it
 * re-adds UNABLE_VALUE itself).
 */
export function buildChildEnv(contract: ContractQuestion[], depth: number): Record<string, string> {
	const portable = contract.map((question) => ({
		...question,
		options: question.options.filter((option) => option.value !== UNABLE_VALUE),
	}));
	return {
		[PI_AGENTS_CHILD]: "1",
		[PI_AGENTS_DEPTH]: String(depth),
		[PI_AGENTS_CONTRACT]: JSON.stringify(portable),
	};
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

export function normalizeContractQuestion(raw: unknown, index: number, usedIds: Set<string>): ContractQuestion {
	if (!isPlainObject(raw)) throw new Error("not an object");
	const prompt = cleanText(raw.prompt ?? raw.question, 500);
	if (!prompt) throw new Error("missing non-empty prompt");

	const allowOther = raw.allowOther !== false;
	const options: ContractOption[] = [];
	const usedValues = new Set<string>();
	const usedLabels = new Set<string>();
	let hasRecommended = false;
	const rawOptions = Array.isArray(raw.options) ? raw.options : [];
	for (const [optionIndex, candidate] of rawOptions.entries()) {
		if (options.length >= MAX_CONTRACT_OPTIONS - 1) throw new Error(`option ${optionIndex} exceeds maximum of ${MAX_CONTRACT_OPTIONS - 1}`);
		const parsed = parseContractOption(candidate, options.length);
		if (!parsed) throw new Error(`option ${optionIndex} is unparseable`);
		const labelKey = parsed.label.toLowerCase();
		if (usedValues.has(parsed.value) || usedLabels.has(labelKey)) throw new Error(`option ${optionIndex} is a duplicate`);
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
	if (options.length === 0 && !allowOther) throw new Error("has no options and disallows free text");

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
export function normalizeContract(raw: unknown, label: string): ContractQuestion[] {
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new Error(`${label}: contract must be a non-empty array of questions`);
	}
	const questions: ContractQuestion[] = [];
	const dropped: string[] = [];
	const usedIds = new Set<string>();
	for (const [index, candidate] of raw.entries()) {
		if (index >= MAX_CONTRACT_QUESTIONS) {
			dropped.push(`${index}: exceeds maximum of ${MAX_CONTRACT_QUESTIONS} questions`);
			continue;
		}
		try { questions.push(normalizeContractQuestion(candidate, index, usedIds)); }
		catch (error) { dropped.push(`${index}: ${(error as Error).message}`); }
	}
	if (dropped.length > 0) {
		throw new Error(`${label}: dropped contract questions — ${dropped.join("; ")}`);
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
export function renderQuestionLines(questions: ContractQuestion[]): string[] {
	const lines: string[] = [];
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
	return lines;
}

export function renderContractBlock(questions: ContractQuestion[], allowAsk = true): string {
	return [
		"## Contract",
		"Your run is complete only after you call submit_answers with one answer per question below.",
		`Answer with an option value, free text where permitted, or "${UNABLE_VALUE}" to punt explicitly.`,
		...(allowAsk ? ["If you are blocked on information only your parent has, call ask_parent with your questions; your run suspends until the parent answers."] : []),
		...renderQuestionLines(questions),
	].join("\n");
}

export function renderAnswersBlock(questions: ContractQuestion[], answers: ContractAnswer[], allowAsk = true): string {
	const byId = new Map(questions.map((question) => [question.id, question]));
	const lines = ["## Answers from your parent"];
	for (const answer of answers) {
		const question = byId.get(answer.id);
		if (!question) continue;
		const shown = answer.value === UNABLE_VALUE ? "(unable to determine)" : answer.wasCustom ? answer.value : `${answer.value} — ${answer.label}`;
		lines.push(`- ${question.prompt}`, `  answer: ${shown}`);
	}
	lines.push(`Continue your task. Your contract is unchanged: call submit_answers when done${allowAsk ? ", or ask_parent again if still blocked" : ""}.`);
	return lines.join("\n");
}

export function validateContractAnswers(
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
		const text = cleanText(entry.value, MAX_ANSWER_TEXT + 1);
		if (!text) {
			problems.push(`"${entry.id}": free-text answer is empty`);
			continue;
		}
		if (text.length > MAX_ANSWER_TEXT) {
			problems.push(`"${entry.id}": answer exceeds ${MAX_ANSWER_TEXT} chars; resubmit condensed`);
			continue;
		}
		accepted.set(question.id, { id: question.id, value: text, label: text, wasCustom: true });
	}
	const missing = questions.filter((question) => !accepted.has(question.id)).map((question) => `"${question.id}"`);
	if (missing.length > 0) problems.push(`missing answer(s) for ${missing.join(", ")}`);
	if (problems.length > 0) throw new Error(`Contract not fulfilled: ${problems.join("; ")}`);
	return questions.map((question) => accepted.get(question.id)!);
}

// ---------------------------------------------------------------------------
// Child-mode tools: thin wrappers registered at a child process's root by
// index.ts's child-mode branch. They have no ChildState — the parent reads
// the child's data from the RPC event stream (the tool_execution_start
// args), so these only validate locally and lean on the runtime's isError
// bit: a thrown error becomes an isError tool result whose content lists the
// problems, so the child model can correct and retry. registerTool accepts
// the AgentTool shape directly (the trailing ctx parameter is optional).
// ---------------------------------------------------------------------------

/** submit_answers in child mode: validate against the env contract; no parent IPC. */
export function buildChildModeSubmitTool(contract: ContractQuestion[]): AgentTool<typeof submitAnswersSchema> {
	return {
		name: "submit_answers",
		label: "Submit Answers",
		description:
			"Fulfill your contract: submit one answer per contract question. Each value must be one of the " +
			`question's option values, free text where the question permits it, or "${UNABLE_VALUE}" to punt ` +
			"explicitly. Calling again before the run ends revises the previous submission.",
		parameters: submitAnswersSchema,
		execute: async (_toolCallId, params) => {
			// validateContractAnswers throws on failure; the runtime turns the
			// throw into an isError tool result listing the problems.
			const answers = validateContractAnswers(contract, params.answers);
			return {
				content: [{ type: "text", text: `Contract fulfilled: ${answers.length} answer(s) recorded.` }],
				details: { answered: answers.length },
			};
		},
	};
}

/** report in child mode: progress ack only; the parent observes the message via the event stream. */
export function buildChildModeReportTool(): AgentTool<typeof reportSchema> {
	return {
		name: "report",
		label: "Report",
		description:
			"Send a progress report to the parent agent. Use this for intermediate " +
			"findings; you may call it multiple times and every call is delivered. " +
			"Progress only — the run's result is your submit_answers contract submission.",
		parameters: reportSchema,
		execute: async () => {
			return { content: [{ type: "text", text: "reported" }], details: {} };
		},
	};
}

/**
 * ask_parent in child mode: normalize the questions and end the turn. The
 * parent detects the ask via the event stream and suspends; MAX_ASKS bounds
 * round-trips per child process via an in-memory counter (askBudget).
 */
export function buildChildModeAskTool(askBudget: { count: number }): AgentTool<typeof askParentSchema> {
	return {
		name: "ask_parent", label: "Ask Parent",
		description: "Ask your parent for information; calling again in the same turn revises the pending questions. Your run suspends until answered. End your turn after calling this tool.",
		parameters: askParentSchema,
		execute: async (_toolCallId, params) => {
			if (askBudget.count >= MAX_ASKS) throw new Error(`Your ask budget is exhausted; submit answers now, using "${UNABLE_VALUE}" where blocked.`);
			const questions = normalizeContract(params.questions, "ask_parent via child-mode");
			askBudget.count++;
			return { content: [{ type: "text", text: "Questions recorded. End your turn now; the parent will answer and resume you via the RPC stream." }], details: { questionCount: questions.length } };
		},
	};
}
/** Nudge text the in-process loop and the rpc-child drive loop share. */
export function buildNudgePrompt(questions: ContractQuestion[], allowAsk: boolean): string {
	return [
		"Your contract is not fulfilled. Call submit_answers now with one answer per contract question.",
		`If a question cannot be determined, answer it with the value "${UNABLE_VALUE}".`,
		...(allowAsk ? ["If you are blocked on information only your parent can provide, call ask_parent with your questions instead."] : []),
		...renderQuestionLines(questions),
	].join("\n");
}
