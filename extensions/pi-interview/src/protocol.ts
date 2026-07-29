import type { InterviewAnswer, InterviewQuestion, QuestionOption } from "./types.js";

export const USE_JUDGMENT_VALUE = "__use_judgment__";

export interface QuestionLimits {
	maxQuestions: number;
	maxOptions: number;
}


function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
	if (!cleaned) return undefined;
	return cleaned.slice(0, maxLength);
}

export function normalizeCustomAnswer(value: unknown): string | undefined {
	return cleanText(value, 500);
}

function slug(value: string, fallback: string): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return normalized || fallback;
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

function normalizeQuestion(
	raw: unknown,
	index: number,
	limits: QuestionLimits,
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

	const requestedId = cleanText(raw.id, 80) ?? cleanText(raw.label ?? raw.header, 80) ?? `question-${index + 1}`;
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
		label: cleanText(raw.label ?? raw.header, 32) ?? `Q${index + 1}`,
		prompt,
		options,
		allowOther: raw.allowOther !== false,
	};
}

export function normalizeQuestions(rawQuestions: readonly unknown[], limits: QuestionLimits): InterviewQuestion[] {
	const maxQuestions = Math.max(1, limits.maxQuestions);
	const safeLimits = { maxQuestions, maxOptions: Math.max(2, limits.maxOptions) };
	const questions: InterviewQuestion[] = [];
	const usedQuestionIds = new Set<string>();
	for (const candidate of rawQuestions) {
		if (questions.length >= maxQuestions) break;
		const question = normalizeQuestion(candidate, questions.length, safeLimits, usedQuestionIds);
		if (question) questions.push(question);
	}
	return questions;
}


export function createJudgmentAnswers(questions: readonly InterviewQuestion[]): InterviewAnswer[] {
	const answers: InterviewAnswer[] = [];
	for (const question of questions) {
		const optionIndex = question.options.findIndex((option) => option.value === USE_JUDGMENT_VALUE);
		const fallbackIndex = optionIndex >= 0 ? optionIndex : 0;
		const option = question.options[fallbackIndex];
		if (!option) continue;
		answers.push({
			id: question.id,
			value: option.value,
			label: option.label,
			wasCustom: false,
			index: fallbackIndex + 1,
		});
	}
	return answers;
}
