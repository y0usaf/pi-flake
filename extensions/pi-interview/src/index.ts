import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { Container, type OverlayHandle, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	CONFIG_FIELD_NAMES,
	CONFIG_FIELDS,
	DEFAULT_CONFIG,
	normalizeConfig,
	setConfigField,
} from "./config.js";
import { buildToolResult, findDanglingToolCalls, hasRecoveryMessage, insertToolResults } from "./durability.js";
import { createJudgmentAnswers, normalizeQuestions } from "./protocol.js";
import { runQuestionnaire } from "./questionnaire.js";
import type {
	AnswerSource,
	InterviewAnswer,
	InterviewConfig,
	InterviewMode,
	InterviewQuestion,
	InterviewToolDetails,
	QuestionnaireResult,
} from "./types.js";

const TOOL_NAME = "interview_user";
const STATUS_KEY = "pi-interview";
/** customType of the message that carries answers recovered after a restart. */
const RECOVERY_TYPE = "pi-interview";

const INTERRUPTED_TEXT = `[PI INTERVIEW INTERRUPTED]
The questionnaire was still open when the session ended, so no answers were recorded. Continue with best judgment and do not repeat the same questions unless work is blocked.`;

const RECOVERED_TEXT = `[PI INTERVIEW INTERRUPTED]
The questionnaire was still open when the session ended. The user answered it after restarting; those answers appear in a later message in this conversation.`;

interface ConfigLoadResult {
	config: InterviewConfig;
	error?: string;
}

function configPath(): string {
	return join(getAgentDir(), "interview.json");
}

function loadConfig(): ConfigLoadResult {
	const path = configPath();
	if (!existsSync(path)) return { config: { ...DEFAULT_CONFIG } };
	try {
		return { config: normalizeConfig(JSON.parse(readFileSync(path, "utf8"))) };
	} catch (error) {
		return {
			config: { ...DEFAULT_CONFIG },
			error: `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function saveConfig(config: InterviewConfig): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.tmp-${process.pid}`;
	writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	renameSync(temporaryPath, path);
}

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
		description: "Fully composed questionnaire to present unchanged",
	}),
});

function primaryGuidance(config: InterviewConfig): string {
	const answerRule =
		config.mode === "auto"
			? "Auto mode: compose exactly the questions you would ask the user. Every question resolves to “Use your judgment” and returns immediately, so the decision points are recorded in the transcript and you then decide them yourself."
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
- Treat returned answers according to their source label: direct user selections are requirements; judgment answers are yours to decide.${strictRule}`;
}

function answerLines(questions: readonly InterviewQuestion[], answers: readonly InterviewAnswer[]): string[] {
	const byId = new Map(answers.map((answer) => [answer.id, answer]));
	return questions.flatMap((question) => {
		const answer = byId.get(question.id);
		return answer ? [`${question.prompt}\nAnswer: ${answer.label}`] : [];
	});
}

const CONTENT_HEADINGS: Record<AnswerSource, { heading: string; instruction: string }> = {
	user: {
		heading: "[PI INTERVIEW ANSWERS — selected directly by user]",
		instruction: "Treat these answers as requirements for current request.",
	},
	resumed: {
		heading: "[PI INTERVIEW ANSWERS — selected directly by user after a session restart]",
		instruction:
			"The questionnaire above was interrupted; these are the user's answers to it. Treat them as requirements and resume the interrupted work.",
	},
	judgment: {
		heading: "[PI INTERVIEW — auto mode, no user input collected]",
		instruction:
			"Auto mode recorded these decision points without asking anyone. Decide each one yourself using available evidence and conventional reversible defaults.",
	},
	interrupted: {
		heading: "[PI INTERVIEW INTERRUPTED]",
		instruction: "Continue with best judgment.",
	},
};

function questionnaireContent(result: QuestionnaireResult, source: AnswerSource): string {
	if (result.cancelled) {
		return "[PI INTERVIEW ANSWERS]\nUser cancelled the questionnaire. Continue with best judgment and avoid repeating the same questions unless work is blocked.";
	}
	const { heading, instruction } = CONTENT_HEADINGS[source];
	return `${heading}\n${answerLines(result.questions, result.answers).join("\n\n")}\n\n${instruction}`;
}

function renderSummary(
	details: InterviewToolDetails | undefined,
	fallback: string,
	theme: ExtensionContext["ui"]["theme"],
): Container {
	const container = new Container();
	const title = details?.answerSource === "judgment" ? "Interview · auto" : "Interview";
	const titleColor = details?.error || details?.cancelled ? "warning" : "toolTitle";
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
	return container;
}

function configStatus(config: InterviewConfig): string {
	const fields = CONFIG_FIELD_NAMES.map((name) => `${name}: ${config[name]} (${CONFIG_FIELDS[name].help})`);
	return [
		`pi-interview: ${config.mode}`,
		...fields,
		`Config: ${configPath()}`,
		"",
		"manual: main model asks when needed; you answer.",
		"auto:   main model asks when needed; every question resolves to “Use your judgment”.",
		"strict: main model must ask every request; you answer.",
	].join("\n");
}

export default function piInterview(pi: ExtensionAPI): void {
	let loaded = loadConfig();
	let config = loaded.config;

	function applyModeState(ctx: ExtensionContext): void {
		const active = pi.getActiveTools();
		const canRun = config.mode === "auto" || ((config.mode === "manual" || config.mode === "strict") && ctx.hasUI);
		if (canRun && !active.includes(TOOL_NAME)) pi.setActiveTools([...active, TOOL_NAME]);
		if (!canRun && active.includes(TOOL_NAME)) {
			pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
		}
		ctx.ui.setStatus(
			STATUS_KEY,
			config.mode === "off" ? undefined : ctx.ui.theme.fg("accent", `interview:${config.mode}`),
		);
	}

	function persist(next: InterviewConfig, ctx: ExtensionContext): boolean {
		try {
			saveConfig(next);
			config = next;
			applyModeState(ctx);
			return true;
		} catch (error) {
			ctx.ui.notify(
				`Could not save pi-interview config: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return false;
		}
	}

	function judgmentResult(questions: InterviewQuestion[]): QuestionnaireResult {
		return { questions, answers: createJudgmentAnswers(questions), cancelled: false };
	}

	/**
	 * Ask a questionnaire from `session_start`, where the editor slot is not ours.
	 *
	 * Two separate hazards live in that window, both caused by other extensions
	 * still installing their own UI while this runs. pi-quiet is the concrete
	 * one today: its `session_start` handler calls `ui.setEditorComponent`, and
	 * pi implements that as `editorContainer.clear()` followed by
	 * `ui.setFocus(newEditor)`.
	 *
	 * The clear evicts an inline component, so the questionnaire is rendered in
	 * the overlay layer, which is a separate stack. The focus call then hands
	 * keyboard input to the new editor, and pi-tui records a non-overlay
	 * component taking focus from an overlay as a deliberate handoff, which
	 * disables the reclaim it would otherwise perform on the next keypress. The
	 * overlay stays on screen and answers nothing — so hold focus explicitly
	 * until the questionnaire closes.
	 *
	 * Which extension runs first is decided by directory read order, so this
	 * cannot be fixed by ordering; the invariant has to be asserted.
	 */
	async function askOnStartup(ctx: ExtensionContext, questions: InterviewQuestion[]): Promise<QuestionnaireResult> {
		let overlay: OverlayHandle | undefined;
		const holdFocus = setInterval(() => {
			if (overlay && !overlay.isFocused()) overlay.focus();
		}, 150);
		holdFocus.unref?.();
		try {
			return await runQuestionnaire(ctx, questions, undefined, {
				overlay: true,
				onHandle: (handle) => {
					overlay = handle;
				},
			});
		} finally {
			clearInterval(holdFocus);
		}
	}

	/**
	 * Finish a questionnaire that was still open when the previous process died.
	 *
	 * The questions are not stored anywhere by this extension: pi already
	 * persisted them inside the arguments of the tool call itself, so they are
	 * read back out of the session. The answers are delivered as a pi custom
	 * message, which pi persists, which is what makes them survive a second
	 * restart without a sidecar file.
	 */
	async function resumeInterrupted(ctx: ExtensionContext): Promise<void> {
		if (config.mode !== "manual" && config.mode !== "strict") return;
		if (!ctx.hasUI) return;
		const messages = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
		const pending = findDanglingToolCalls(messages, TOOL_NAME).filter(
			(call) => !hasRecoveryMessage(messages, RECOVERY_TYPE, call.toolCallId),
		);
		const call = pending.at(-1);
		if (!call) return;
		const raw = call.arguments.questions;
		const questions = normalizeQuestions(Array.isArray(raw) ? raw : [], config);
		if (questions.length === 0) return;

		ctx.ui.notify("Interview was interrupted by a restart — finishing it now", "info");
		const result = await askOnStartup(ctx, questions);
		if (result.cancelled || result.answers.length === 0) return;
		pi.sendMessage(
			{
				customType: RECOVERY_TYPE,
				content: questionnaireContent(result, "resumed"),
				display: true,
				details: { toolCallId: call.toolCallId },
			},
			{ triggerTurn: true },
		);
	}

	pi.on("session_start", (_event, ctx) => {
		loaded = loadConfig();
		config = loaded.config;
		applyModeState(ctx);
		if (loaded.error && ctx.hasUI) ctx.ui.notify(loaded.error, "error");
		// Deliberately not awaited: startup must not block on an overlay.
		void resumeInterrupted(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (config.mode === "off") return;
		if ((config.mode === "manual" || config.mode === "strict") && !ctx.hasUI) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${primaryGuidance(config)}` };
	});

	/**
	 * Repair tool calls left unanswered by a dead process.
	 *
	 * Pi writes the assistant message holding a tool call before the tool runs
	 * and the result only when it returns, and repairs nothing on load, so an
	 * interrupted questionnaire ships a `tool_use` block with no `tool_result`
	 * and the provider rejects the turn. `ctx.sessionManager` is read-only, so
	 * this hook — the one place a message list can be rewritten — supplies the
	 * missing result on every request instead.
	 */
	pi.on("context", (event) => {
		const dangling = findDanglingToolCalls(event.messages, TOOL_NAME);
		if (dangling.length === 0) return;
		const inserts = dangling.map((call) => {
			const recovered = hasRecoveryMessage(event.messages, RECOVERY_TYPE, call.toolCallId);
			return {
				afterIndex: call.messageIndex,
				message: buildToolResult(
					call.toolCallId,
					TOOL_NAME,
					recovered ? RECOVERED_TEXT : INTERRUPTED_TEXT,
					!recovered,
				) as (typeof event.messages)[number],
			};
		});
		return { messages: insertToolResults(event.messages, inserts) };
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Interview user",
		description:
			"Ask one or more structured multiple-choice questions composed by the main-session model. Depending on /interview mode, answers come from the user or resolve to “Use your judgment”.",
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

			if (config.mode === "auto" || !ctx.hasUI) {
				const result = judgmentResult(questions);
				const note = ctx.hasUI ? "" : "\n\nInteractive UI unavailable, so nobody was asked.";
				return {
					content: [{ type: "text", text: `${questionnaireContent(result, "judgment")}${note}` }],
					details: {
						mode: config.mode,
						answerSource: "judgment",
						questions,
						answers: result.answers,
						cancelled: false,
					} as InterviewToolDetails,
				};
			}

			const questionnaire = await runQuestionnaire(ctx, questions, signal);
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
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("muted", "Interviewing…"), 0, 0);
			const fallback = result.content[0]?.type === "text" ? result.content[0].text : "(no result)";
			return renderSummary(result.details as InterviewToolDetails | undefined, fallback, theme);
		},
	});

	pi.registerCommand("interview", {
		description: "Manage ask-user interviews: manual, auto, strict, off, config",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trim();
			if (!trimmed.includes(" ")) {
				const matches = ["manual", "auto", "strict", "off", "config"].filter((value) => value.startsWith(trimmed));
				return matches.length ? matches.map((value) => ({ value, label: value })) : null;
			}
			const parts = trimmed.split(/\s+/);
			if (parts[0] === "config" && parts.length <= 2) {
				const last = parts.at(-1) ?? "";
				const matches = CONFIG_FIELD_NAMES.map((name) => `${name}=`).filter((value) => value.startsWith(last));
				return matches.length ? matches.map((value) => ({ value: `config ${value}`, label: value })) : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const [command = "", ...tail] = args.trim().split(/\s+/).filter(Boolean);
			const rest = tail.join(" ");

			if (command === "manual" || command === "auto" || command === "strict" || command === "off") {
				if (rest) {
					ctx.ui.notify(`/interview ${command} takes no arguments`, "warning");
					return;
				}
				if (!persist({ ...config, mode: command as InterviewMode }, ctx)) return;
				ctx.ui.notify(`pi-interview ${command}`, "info");
				return;
			}

			if (command === "config") {
				if (!rest) {
					ctx.ui.notify(configStatus(config), "info");
					return;
				}
				const match = rest.match(/^(\w+)=(.+)$/);
				if (!match?.[1] || match[2] === undefined) {
					ctx.ui.notify("Use /interview config key=value", "warning");
					return;
				}
				const applied = setConfigField(config, match[1], match[2]);
				if (!applied.ok) {
					ctx.ui.notify(applied.error, "warning");
					return;
				}
				if (persist(applied.config, ctx)) ctx.ui.notify(`pi-interview: ${match[1]}=${match[2]}`, "info");
				return;
			}

			ctx.ui.notify(configStatus(config), "info");
		},
	});
}
