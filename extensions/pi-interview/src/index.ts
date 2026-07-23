import type { ThinkingLevel } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	keyHint,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { configPath, loadConfig, parseBoolean, saveConfig } from "./config.js";
import { buildAutoAnswerContext } from "./context.js";
import { createJudgmentAnswers, normalizeQuestions } from "./protocol.js";
import { runAutoAnswerer } from "./answerer.js";
import { runWithLoader } from "./loader.js";
import { runQuestionnaire } from "./questionnaire.js";
import {
	INTERVIEW_REASONING_LEVELS,
	type InterviewAnswer,
	type InterviewConfig,
	type InterviewMode,
	type InterviewQuestion,
	type InterviewToolDetails,
	type QuestionnaireResult,
} from "./types.js";

const TOOL_NAME = "interview_user";
const STATUS_KEY = "pi-interview";

const QuestionOptionSchema = Type.Object({
	value: Type.Optional(Type.String({ description: "Stable option value; derived from label when omitted" })),
	label: Type.String({ description: "Short display label" }),
	description: Type.Optional(Type.String({ description: "Concise tradeoff or consequence" })),
	recommended: Type.Optional(Type.Boolean({ description: "Mark at most one recommended option per question" })),
});

const InterviewQuestionSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable question identifier; derived from label when omitted" })),
	label: Type.Optional(Type.String({ description: "Short tab label, e.g. Scope or Compatibility" })),
	prompt: Type.String({ description: "Exact question to ask" }),
	options: Type.Array(QuestionOptionSchema, {
		minItems: 1,
		maxItems: 6,
		description: "Concrete, mutually distinct choices",
	}),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow a free-text answer; default true" })),
});

const InterviewParams = Type.Object({
	questions: Type.Array(InterviewQuestionSchema, {
		minItems: 1,
		maxItems: 5,
		description: "Fully composed questionnaire to present unchanged or auto-answer",
	}),
});

function primaryGuidance(config: InterviewConfig): string {
	const answerRule =
		config.mode === "auto"
			? "Auto mode: compose exactly the questions you would ask the user. A separate inference context answers that same questionnaire using bounded current-session context."
			: "User-answer mode: the questionnaire is shown to the user and selections return to this tool call.";
	const strictRule =
		config.mode === "strict"
			? "\n- STRICT MODE: Call interview_user at least once during every user request before your final response. When no material ambiguity exists, ask one concise question about proceeding with recommended defaults, seeing a plan first, or adding constraints."
			: "";
	return `[PI INTERVIEW POLICY]
User clarification uses interview_user, following the standard ask-user-question pattern.
- The main-session model must compose the complete questions and options passed to interview_user; never delegate question generation.
- ${answerRule}
- Outside strict mode, ask only decision-relevant questions whose answers can change implementation, scope, risk, compatibility, or UX.
- Inspect the repository first when facts are discoverable. Do not ask for facts available through tools or conventional safe defaults.
- Do not ask free-form clarification questions in assistant prose while interview_user is available.
- Batch at most ${config.maxQuestions} questions with at most ${Math.max(1, config.maxOptions - 1)} domain options each. Host adds “Use your judgment”; optional free text follows allowOther.
- Treat returned answers according to their source label: direct user selections are requirements; auto-answers are inferred defaults.${strictRule}`;
}

function modelRef(config: InterviewConfig): string {
	return config.provider && config.model ? `${config.provider}/${config.model}` : "not configured";
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

function answerLines(questions: readonly InterviewQuestion[], answers: readonly InterviewAnswer[]): string[] {
	const byId = new Map(answers.map((answer) => [answer.id, answer]));
	return questions.flatMap((question) => {
		const answer = byId.get(question.id);
		return answer ? [`${question.prompt}\nAnswer: ${answer.label}`] : [];
	});
}

function questionnaireContent(
	result: QuestionnaireResult,
	source: "user" | "model" | "fallback",
	autoModelRef?: string,
): string {
	if (result.cancelled) {
		return `[PI INTERVIEW ANSWERS]\nUser cancelled the questionnaire. Continue with best judgment and avoid repeating the same questions unless work is blocked.`;
	}
	const heading =
		source === "user"
			? "[PI INTERVIEW ANSWERS — selected directly by user]"
			: source === "model"
				? `[PI INTERVIEW AUTO-ANSWERS — selected by ${autoModelRef ?? "configured model"}]`
				: "[PI INTERVIEW AUTO-ANSWER FALLBACK]";
	const instruction =
		source === "user"
			? "Treat these answers as requirements for current request."
			: source === "model"
				? "Use these model-inferred answers as resolved defaults for current request; they are not direct user statements."
				: "Auto-answer inference failed. Continue using primary-agent judgment for these decisions.";
	return `${heading}\n${answerLines(result.questions, result.answers).join("\n\n")}\n\n${instruction}`;
}


function renderSummary(
	details: InterviewToolDetails | undefined,
	fallback: string,
	theme: ExtensionContext["ui"]["theme"],
	expanded: boolean,
): Container {
	const container = new Container();
	const title = details?.answerSource === "model" ? "Interview · auto" : details?.answerSource === "fallback" ? "Interview · fallback" : "Interview";
	const titleColor = details?.error ? "warning" : details?.cancelled ? "warning" : "toolTitle";
	container.addChild(new Text(theme.fg(titleColor, theme.bold(title)), 0, 0));
	if (details?.error) {
		container.addChild(new Text(theme.fg("warning", details.message ?? fallback), 0, 0));
	}
	if (details?.cancelled) {
		container.addChild(new Text(theme.fg("warning", "Questionnaire cancelled; primary agent will use judgment."), 0, 0));
		return container;
	}
	if (details?.questions && details.answers) {
		const answers = new Map(details.answers.map((answer) => [answer.id, answer]));
		for (const question of details.questions) {
			const answer = answers.get(question.id);
			if (!answer) continue;
			container.addChild(
				new Text(`${theme.fg("muted", `${question.label}: `)}${theme.fg("accent", answer.label)}`, 0, 0),
			);
		}
	} else if (!details?.error) {
		container.addChild(new Text(fallback, 0, 0));
	}
	if (expanded && details?.modelRef) {
		container.addChild(new Spacer(1));
		let footer = details.modelRef;
		if (details.usage) {
			footer += ` · ↑${formatTokens(details.usage.inputTokens)} ↓${formatTokens(details.usage.outputTokens)}`;
			if (details.usage.attempts > 1) footer += ` · ${details.usage.attempts} attempts`;
		}
		container.addChild(new Text(theme.fg("dim", footer), 0, 0));
	}
	return container;
}

function parseModelRef(value: string): { provider: string; model: string } | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

async function selectModel(
	ctx: ExtensionCommandContext,
	requested?: string,
): Promise<{ provider: string; model: string } | undefined> {
	if (requested?.trim()) {
		const parsed = parseModelRef(requested.trim());
		if (!parsed) {
			ctx.ui.notify("Use provider/model, e.g. anthropic/claude-haiku-4-5", "warning");
			return undefined;
		}
		if (!ctx.modelRegistry.find(parsed.provider, parsed.model)) {
			ctx.ui.notify(`Model ${parsed.provider}/${parsed.model} not found`, "error");
			return undefined;
		}
		return parsed;
	}

	try {
		await ctx.modelRegistry.refresh();
	} catch {
		// Existing snapshot may still be usable.
	}
	const choices = ctx.modelRegistry
		.getAvailable()
		.map((model) => `${model.provider}/${model.id}`)
		.sort((left, right) => left.localeCompare(right));
	if (choices.length === 0) {
		ctx.ui.notify("No authenticated models available. Run /login first.", "error");
		return undefined;
	}
	const selected = await ctx.ui.select("Select auto-answer model", choices);
	return selected ? parseModelRef(selected) : undefined;
}

function configStatus(config: InterviewConfig): string {
	return [
		`pi-interview: ${config.mode}`,
		`Auto-answer model: ${modelRef(config)}`,
		`Reasoning: ${config.reasoning}`,
		`Questions/options: ${config.maxQuestions}/${config.maxOptions}`,
		`Recent messages shared for auto-answer: ${config.maxContextMessages}`,
		`Session-context budget: ${config.maxContextChars} chars (questionnaire excluded)`,
		`Project context files: ${config.includeContextFiles ? "shared for auto-answer" : "not shared"}`,
		`Timeout: ${config.timeoutMs}ms`,
		`Config: ${configPath()}`,
		"",
		"manual: main model asks when needed; user answers.",
		"auto: main model asks when needed; separate model answers.",
		"strict: main model must ask every request; user answers.",
	].join("\n");
}

export default function piInterview(pi: ExtensionAPI): void {
	let loaded = loadConfig();
	let config = loaded.config;
	let currentPrompt = "Current user request";
	let currentContextFiles: unknown;
	let currentImageCount = 0;

	function applyModeState(ctx: ExtensionContext): void {
		const active = pi.getActiveTools();
		const canRun = config.mode === "auto" || ((config.mode === "manual" || config.mode === "strict") && ctx.hasUI);
		if (canRun && !active.includes(TOOL_NAME)) pi.setActiveTools([...active, TOOL_NAME]);
		if (!canRun && active.includes(TOOL_NAME)) {
			pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
		}
		const status = config.mode === "auto" ? `interview:auto · ${modelRef(config)}` : `interview:${config.mode}`;
		ctx.ui.setStatus(STATUS_KEY, config.mode === "off" ? undefined : ctx.ui.theme.fg("accent", status));
	}

	function persist(next: InterviewConfig, ctx: ExtensionContext): boolean {
		try {
			saveConfig(next);
			config = next;
			applyModeState(ctx);
			return true;
		} catch (error) {
			ctx.ui.notify(`Could not save pi-interview config: ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		loaded = loadConfig();
		config = loaded.config;
		currentPrompt = "Current user request";
		currentContextFiles = undefined;
		currentImageCount = 0;
		applyModeState(ctx);
		if (loaded.error && ctx.hasUI) ctx.ui.notify(loaded.error, "error");
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("before_agent_start", (event, ctx) => {
		currentPrompt = event.prompt;
		currentContextFiles = event.systemPromptOptions.contextFiles;
		currentImageCount = event.images?.length ?? 0;
		if (config.mode === "off") return;
		if ((config.mode === "manual" || config.mode === "strict") && !ctx.hasUI) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${primaryGuidance(config)}` };
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Interview user",
		description:
			"Ask one or more structured multiple-choice questions composed by the main-session model. Depending on /interview mode, answers come from the user or a separate auto-answer inference.",
		promptSnippet: "interview_user({ questions }): ask a structured questionnaire composed in the main session",
		promptGuidelines: [
			"Use interview_user when a user-owned decision materially changes implementation, scope, compatibility, risk, or UX.",
			"Compose interview_user questions and concrete options in the tool arguments; never ask another model to generate them.",
			"Do not ask free-form clarification in assistant prose while interview_user is active.",
			"Outside strict mode, do not use interview_user for facts discoverable with read/search tools or for reversible conventional defaults.",
		],
		parameters: InterviewParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (config.mode === "off") {
				return {
					content: [{ type: "text", text: "pi-interview is disabled. Continue using best judgment." }],
					details: { mode: config.mode, error: "disabled", message: "pi-interview is disabled" } as InterviewToolDetails,
				};
			}

			const questions = normalizeQuestions(params.questions, config);
			if (questions.length === 0) throw new Error("interview_user requires at least one valid question with options");

			if (config.mode === "auto") {
				const packet = buildAutoAnswerContext(
					ctx,
					config,
					currentPrompt,
					questions,
					currentContextFiles,
					currentImageCount,
				);
				const run = await runWithLoader(
					ctx,
					`Auto-answering with ${modelRef(config)}…`,
					(uiSignal) => runAutoAnswerer(ctx, config, packet, questions, uiSignal ?? signal),
					signal,
				);
				if (run.status !== "ok") {
					const message = run.status === "cancelled" ? "Auto-answer cancelled" : run.error;
					const answers = createJudgmentAnswers(questions);
					const questionnaire = { questions, answers, cancelled: false };
					return {
						content: [
							{
								type: "text",
								text: `${questionnaireContent(questionnaire, "fallback")}\n\nAuto-answer unavailable: ${message}`,
							},
						],
						details: {
							mode: config.mode,
							answerSource: "fallback",
							modelRef: modelRef(config),
							questions,
							answers,
							cancelled: false,
							error: run.status,
							message,
						} as InterviewToolDetails,
					};
				}
				const questionnaire = { questions, answers: run.value.answers, cancelled: false };
				return {
					content: [{ type: "text", text: questionnaireContent(questionnaire, "model", run.value.modelRef) }],
					details: {
						mode: config.mode,
						answerSource: "model",
						modelRef: run.value.modelRef,
						questions,
						answers: run.value.answers,
						cancelled: false,
						usage: run.value.usage,
					} as InterviewToolDetails,
				};
			}

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Interactive UI unavailable. Continue using best judgment." }],
					details: {
						mode: config.mode,
						error: "ui_unavailable",
						message: "Interactive UI unavailable",
						questions,
					} as InterviewToolDetails,
				};
			}
			const questionnaire = await runQuestionnaire(ctx, questions);
			return {
				content: [{ type: "text", text: questionnaireContent(questionnaire, "user") }],
				details: {
					mode: config.mode,
					answerSource: "user",
					questions: questionnaire.questions,
					answers: questionnaire.answers,
					cancelled: questionnaire.cancelled,
				} as InterviewToolDetails,
			};
		},
		renderCall(args, theme) {
			const count = Array.isArray(args.questions) ? args.questions.length : 0;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("Interview"))}${theme.fg("muted", count ? ` · ${count} question${count === 1 ? "" : "s"}` : "")}`,
				0,
				0,
			);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("muted", "Interviewing…"), 0, 0);
			const fallback = result.content[0]?.type === "text" ? result.content[0].text : "(no result)";
			const details = result.details as InterviewToolDetails | undefined;
			const container = renderSummary(details, fallback, theme, expanded);
			if (!expanded && details?.modelRef && details.answers?.length) {
				container.addChild(new Text(theme.fg("dim", keyHint("app.tools.expand", "for model + usage")), 0, 0));
			}
			return container;
		},
	});

	pi.registerCommand("interview", {
		description: "Manage ask-user interviews: manual, auto, strict, off, model, config",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trim();
			if (!trimmed.includes(" ")) {
				const values = ["manual", "auto", "strict", "off", "model", "config"];
				const matches = values.filter((value) => value.startsWith(trimmed));
				return matches.length ? matches.map((value) => ({ value, label: value })) : null;
			}
			const parts = trimmed.split(/\s+/);
			if (parts[0] === "config" && parts.length <= 2) {
				const values = [
					"reasoning=",
					"maxTokens=",
					"maxQuestions=",
					"maxOptions=",
					"maxContextMessages=",
					"maxContextChars=",
					"includeContextFiles=",
					"timeoutMs=",
				];
				const last = parts.at(-1) ?? "";
				const matches = values.filter((value) => value.startsWith(last));
				return matches.length ? matches.map((value) => ({ value: `config ${value}`, label: value })) : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const [command = "", ...tail] = args.trim().split(/\s+/).filter(Boolean);
			const rest = tail.join(" ");

			if (command === "manual" || command === "strict") {
				if (rest) {
					ctx.ui.notify(`${command} mode uses direct user answers and does not take a model`, "warning");
					return;
				}
				if (persist({ ...config, mode: command as InterviewMode }, ctx)) {
					ctx.ui.notify(
						command === "manual"
							? "pi-interview manual: main model may ask; user answers"
							: "pi-interview strict: main model must ask every request; user answers",
						"info",
					);
				}
				return;
			}

			if (command === "auto") {
				let selected = rest ? await selectModel(ctx, rest) : undefined;
				if (!selected && !rest && config.provider && config.model && ctx.modelRegistry.find(config.provider, config.model)) {
					selected = { provider: config.provider, model: config.model };
				}
				if (!selected && !rest) selected = await selectModel(ctx);
				if (!selected) return;
				const next = { ...config, mode: "auto" as const, ...selected };
				if (!persist(next, ctx)) return;
				const sameAsPrimary = ctx.model?.provider === selected.provider && ctx.model.id === selected.model;
				ctx.ui.notify(
					`pi-interview auto-answer: ${selected.provider}/${selected.model}${sameAsPrimary ? " (same model as primary; separate context)" : ""}`,
					sameAsPrimary ? "warning" : "info",
				);
				return;
			}

			if (command === "off") {
				if (persist({ ...config, mode: "off" }, ctx)) ctx.ui.notify("pi-interview disabled", "info");
				return;
			}

			if (command === "model") {
				const selected = await selectModel(ctx, rest || undefined);
				if (!selected) return;
				if (persist({ ...config, ...selected }, ctx)) {
					ctx.ui.notify(`Auto-answer model: ${selected.provider}/${selected.model}`, "info");
				}
				return;
			}

			if (command === "config") {
				if (!rest) {
					ctx.ui.notify(configStatus(config), "info");
					return;
				}
				const match = rest.match(/^(\w+)=(.+)$/);
				if (!match) {
					ctx.ui.notify("Use /interview config key=value", "warning");
					return;
				}
				const key = match[1];
				const value = match[2];
				if (!key || value === undefined) {
					ctx.ui.notify("Use /interview config key=value", "warning");
					return;
				}
				const next = { ...config };
				const integer = Number.parseInt(value, 10);
				switch (key) {
					case "reasoning":
						if (!INTERVIEW_REASONING_LEVELS.includes(value as ThinkingLevel)) {
							ctx.ui.notify(`reasoning: ${INTERVIEW_REASONING_LEVELS.join(", ")}`, "warning");
							return;
						}
						next.reasoning = value as InterviewConfig["reasoning"];
						break;
					case "maxTokens":
						if (!Number.isInteger(integer) || integer < 256 || integer > 16384) return void ctx.ui.notify("maxTokens must be 256-16384", "warning");
						next.maxTokens = integer;
						break;
					case "maxQuestions":
						if (!Number.isInteger(integer) || integer < 1 || integer > 5) return void ctx.ui.notify("maxQuestions must be 1-5", "warning");
						next.maxQuestions = integer;
						break;
					case "maxOptions":
						if (!Number.isInteger(integer) || integer < 2 || integer > 7) return void ctx.ui.notify("maxOptions must be 2-7", "warning");
						next.maxOptions = integer;
						break;
					case "maxContextMessages":
						if (!Number.isInteger(integer) || integer < 0 || integer > 30) return void ctx.ui.notify("maxContextMessages must be 0-30", "warning");
						next.maxContextMessages = integer;
						break;
					case "maxContextChars":
						if (!Number.isInteger(integer) || integer < 2000 || integer > 100000) return void ctx.ui.notify("maxContextChars must be 2000-100000", "warning");
						next.maxContextChars = integer;
						break;
					case "includeContextFiles": {
						const parsed = parseBoolean(value);
						if (parsed === undefined) return void ctx.ui.notify("includeContextFiles must be true/false", "warning");
						next.includeContextFiles = parsed;
						break;
					}
					case "timeoutMs":
						if (!Number.isInteger(integer) || integer < 5000 || integer > 180000) return void ctx.ui.notify("timeoutMs must be 5000-180000", "warning");
						next.timeoutMs = integer;
						break;
					default:
						ctx.ui.notify("Unknown config key. Run /interview config for current settings.", "warning");
						return;
				}
				if (persist(next, ctx)) ctx.ui.notify(`pi-interview: ${key}=${value}`, "info");
				return;
			}

			ctx.ui.notify(configStatus(config), "info");
		},
	});
}
