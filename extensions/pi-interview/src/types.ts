export const INTERVIEW_MODES = ["off", "manual", "auto", "strict"] as const;
export type InterviewMode = (typeof INTERVIEW_MODES)[number];

export interface InterviewConfig {
	mode: InterviewMode;
	maxQuestions: number;
	maxOptions: number;
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

export interface InterviewAnswer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
}

export interface QuestionnaireResult {
	questions: InterviewQuestion[];
	answers: InterviewAnswer[];
	cancelled: boolean;
}

/** Who produced the answers attached to a tool result. */
export type AnswerSource = "user" | "judgment";

export interface InterviewToolDetails {
	mode?: InterviewMode;
	answerSource?: AnswerSource;
	questions?: InterviewQuestion[];
	answers?: InterviewAnswer[];
	cancelled?: boolean;
	error?: string;
	message?: string;
}
