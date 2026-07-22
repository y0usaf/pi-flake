export const INTERVIEW_MODES = ["off", "auto", "strict"] as const;
export type InterviewMode = (typeof INTERVIEW_MODES)[number];

export const INTERVIEW_REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type InterviewReasoning = (typeof INTERVIEW_REASONING_LEVELS)[number];

export interface InterviewConfig {
	mode: InterviewMode;
	provider: string;
	model: string;
	reasoning: InterviewReasoning;
	maxTokens: number;
	maxQuestions: number;
	maxOptions: number;
	maxContextMessages: number;
	maxContextChars: number;
	includeContextFiles: boolean;
	timeoutMs: number;
}

export interface QuestionOption {
	value: string;
	label: string;
	description?: string;
	recommended?: boolean;
}

export interface InterviewQuestion {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
}

export interface InterviewDecision {
	action: "ask" | "proceed";
	questions: InterviewQuestion[];
}

export interface InterviewAnswer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

export interface QuestionnaireResult {
	questions: InterviewQuestion[];
	answers: InterviewAnswer[];
	cancelled: boolean;
}

export interface InterviewUsage {
	inputTokens: number;
	outputTokens: number;
	attempts: number;
}

export interface InterviewRunResult {
	decision: InterviewDecision;
	modelRef: string;
	usage: InterviewUsage;
}

export interface InterviewMessageDetails {
	modelRef: string;
	questions: InterviewQuestion[];
	answers: InterviewAnswer[];
	cancelled: boolean;
	usage?: InterviewUsage;
}

export interface InterviewToolDetails extends Partial<InterviewMessageDetails> {
	error?: string;
	message?: string;
}
