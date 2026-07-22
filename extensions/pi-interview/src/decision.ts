import type { InterviewDecision, InterviewQuestion, QuestionOption } from "./types.js";

export const USE_JUDGMENT_VALUE = "__use_judgment__";

export interface DecisionLimits {
	maxQuestions: number;
	maxOptions: number;
}

export type DecisionParseResult =
	| { ok: true; decision: InterviewDecision }
	| { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
	if (!cleaned) return undefined;
	return cleaned.slice(0, maxLength);
}

function slug(value: string, fallback: string): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return normalized || fallback;
}

function parseJson(raw: string): unknown {
	const trimmed = raw.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	const embedded = firstBrace >= 0 && lastBrace > firstBrace ? trimmed.slice(firstBrace, lastBrace + 1) : undefined;
	const candidates = [trimmed, fenced, embedded].filter((candidate): candidate is string => Boolean(candidate));
	let lastError: unknown;
	for (const candidate of [...new Set(candidates)]) {
		try {
			return JSON.parse(candidate);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error("No JSON object found");
}

function isHostOption(value: string, label: string): boolean {
	const normalizedValue = value.trim().toLowerCase();
	const normalizedLabel = label.trim().toLowerCase().replace(/[.!…]+$/g, "");
	return (
		normalizedValue === USE_JUDGMENT_VALUE ||
		normalizedValue === "other" ||
		normalizedValue === "__other__" ||
		normalizedLabel === "use your judgment" ||
		normalizedLabel === "use your judgement" ||
		normalizedLabel === "other" ||
		normalizedLabel === "type something"
	);
}

function parseOption(raw: unknown, index: number): QuestionOption | undefined {
	if (typeof raw === "string") {
		const label = cleanText(raw, 120);
		if (!label) return undefined;
		const value = slug(label, `option-${index + 1}`);
		if (isHostOption(value, label)) return undefined;
		return { value, label };
	}
	if (!isRecord(raw)) return undefined;
	const label = cleanText(raw.label, 120);
	if (!label) return undefined;
	const value = cleanText(raw.value, 80) ?? slug(label, `option-${index + 1}`);
	if (isHostOption(value, label)) return undefined;
	return {
		value,
		label,
		description: cleanText(raw.description, 240),
		recommended: raw.recommended === true,
	};
}

function parseQuestion(
	raw: unknown,
	index: number,
	limits: DecisionLimits,
	usedQuestionIds: Set<string>,
): InterviewQuestion | undefined {
	if (!isRecord(raw)) return undefined;
	const prompt = cleanText(raw.prompt ?? raw.question, 500);
	if (!prompt || !Array.isArray(raw.options)) return undefined;

	const maxModelOptions = Math.max(1, limits.maxOptions - 1);
	const options: QuestionOption[] = [];
	const usedValues = new Set<string>();
	const usedLabels = new Set<string>();
	let hasRecommended = false;
	for (const candidate of raw.options) {
		if (options.length >= maxModelOptions) break;
		const parsed = parseOption(candidate, options.length);
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
	if (options.length === 0) return undefined;

	options.push({
		value: USE_JUDGMENT_VALUE,
		label: "Use your judgment",
		description: "Let primary agent choose using available evidence and conventional defaults.",
	});

	const requestedId = cleanText(raw.id, 80) ?? cleanText(raw.label, 80) ?? `question-${index + 1}`;
	const baseId = slug(requestedId, `question-${index + 1}`);
	let id = baseId;
	let suffix = 2;
	while (usedQuestionIds.has(id)) {
		id = `${baseId}-${suffix}`;
		suffix++;
	}
	usedQuestionIds.add(id);

	return {
		id,
		label: cleanText(raw.label, 32) ?? `Q${index + 1}`,
		prompt,
		options,
		allowOther: true,
	};
}

export function parseDecision(rawText: string, limits: DecisionLimits): DecisionParseResult {
	let parsed: unknown;
	try {
		parsed = parseJson(rawText);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	if (!isRecord(parsed)) return { ok: false, error: "Interviewer output must be a JSON object" };

	const action = parsed.action;
	if (action !== "ask" && action !== "proceed") {
		return { ok: false, error: 'Interviewer output needs action="ask" or action="proceed"' };
	}
	if (action === "proceed") return { ok: true, decision: { action, questions: [] } };
	if (!Array.isArray(parsed.questions)) {
		return { ok: false, error: 'action="ask" requires a questions array' };
	}

	const maxQuestions = Math.max(1, limits.maxQuestions);
	const safeLimits = { maxQuestions, maxOptions: Math.max(2, limits.maxOptions) };
	const questions: InterviewQuestion[] = [];
	const usedQuestionIds = new Set<string>();
	for (const candidate of parsed.questions) {
		if (questions.length >= maxQuestions) break;
		const question = parseQuestion(candidate, questions.length, safeLimits, usedQuestionIds);
		if (question) questions.push(question);
	}
	if (questions.length === 0) {
		return { ok: false, error: 'action="ask" did not contain any valid multiple-choice questions' };
	}
	return { ok: true, decision: { action, questions } };
}

export function createStrictFallback(maxOptions = 5): InterviewDecision {
	const domainOptions: QuestionOption[] = [
		{
			value: "recommended-defaults",
			label: "Proceed with recommended defaults",
			description: "Use conventional, reversible choices and continue.",
			recommended: true,
		},
		{
			value: "plan-first",
			label: "Present plan before changes",
			description: "Pause after investigation and show proposed implementation path.",
		},
	];
	const judgment: QuestionOption = {
		value: USE_JUDGMENT_VALUE,
		label: "Use your judgment",
		description: "Let primary agent choose based on available evidence.",
	};
	return {
		action: "ask",
		questions: [
			{
				id: "defaults",
				label: "Defaults",
				prompt: "No material ambiguity was found. How should primary agent proceed?",
				options: [...domainOptions.slice(0, Math.max(1, maxOptions - 1)), judgment],
				allowOther: true,
			},
		],
	};
}
