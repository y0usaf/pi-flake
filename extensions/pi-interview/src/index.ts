import type { ThinkingLevel } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	keyHint,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { configPath, loadConfig, parseBoolean, saveConfig } from "./config.js";
import { buildPreflightContext, buildToolContext } from "./context.js";
import { runInterviewer } from "./interviewer.js";
import { runWithLoader } from "./loader.js";
import { runQuestionnaire } from "./questionnaire.js";
import {
	INTERVIEW_REASONING_LEVELS,
	type InterviewAnswer,
	type InterviewConfig,
	type InterviewMessageDetails,
	type InterviewMode,
	type InterviewQuestion,
	type InterviewRunResult,
	type InterviewToolDetails,
	type QuestionnaireResult,
} from "./types.js";

const MESSAGE_TYPE = "pi-interview";
const TOOL_NAME = "interview_user";
const STATUS_KEY = "pi-interview";

const PRIMARY_GUIDANCE = `[PI INTERVIEW POLICY]
User clarification is handled through the interview_user tool.
- If a new user-owned decision appears after repository inspection, call interview_user with concise findings and the exact decision point.
- Do not ask free-form clarification questions in assistant prose when interview_user is available.
- Do not ask user for facts discoverable from repository, tools, or conventional safe defaults.
- Treat answers in PI INTERVIEW CLARIFICATIONS messages as direct user requirements. Do not re-ask answered questions unless evidence conflicts.`;

function modelRef(config: InterviewConfig): string {
	return config.provider && config.model ? `${config.provider}/${config.model}` : "not configured";
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

function answerLines(questions: InterviewQuestion[], answers: InterviewAnswer[]): string[] {
	const byId = new Map(answers.map((answer) => [answer.id, answer]));
	return questions.flatMap((question) => {
		const answer = byId.get(question.id);
		return answer ? [`${question.prompt}\nAnswer: ${answer.label}`] : [];
	});
}

function clarificationContent(result: QuestionnaireResult): string {
	if (result.cancelled) {
		return `[PI INTERVIEW CLARIFICATIONS]\nUser cancelled the questionnaire. Continue with best judgment and avoid repeating the same questions unless work is blocked.`;
	}
	return `[PI INTERVIEW CLARIFICATIONS — answers selected directly by user]\n${answerLines(result.questions, result.answers).join("\n\n")}\n\nTreat these answers as requirements for current request.`;
}

function messageDetails(run: InterviewRunResult, questionnaire: QuestionnaireResult): InterviewMessageDetails {
	return {
		modelRef: run.modelRef,
		questions: questionnaire.questions,
		answers: questionnaire.answers,
		cancelled: questionnaire.cancelled,
		usage: run.usage,
	};
}

function renderSummary(
	details: InterviewMessageDetails | InterviewToolDetails | undefined,
	fallback: string,
	theme: ExtensionContext["ui"]["theme"],
	expanded: boolean,
): Container {
	const container = new Container();
	const error = details && "error" in details ? details.error : undefined;
	const failureMessage = details && "message" in details ? details.message : undefined;
	const titleColor = error ? "error" : details?.cancelled ? "warning" : "toolTitle";
	container.addChild(new Text(theme.fg(titleColor, theme.bold("Interview")), 0, 0));
	if (error) {
		container.addChild(new Text(theme.fg("dim", failureMessage ?? fallback), 0, 0));
		return container;
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
	} else {
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
	const selected = await ctx.ui.select("Select secondary interviewer model", choices);
	return selected ? parseModelRef(selected) : undefined;
}

function configStatus(config: InterviewConfig): string {
	return [
		`pi-interview: ${config.mode}`,
		`Model: ${modelRef(config)}`,
		`Reasoning: ${config.reasoning}`,
		`Questions/options: ${config.maxQuestions}/${config.maxOptions}`,
		`Recent messages shared: ${config.maxContextMessages}`,
		`Context budget: ${config.maxContextChars} chars`,
		`Project context files: ${config.includeContextFiles ? "shared" : "not shared"}`,
		`Timeout: ${config.timeoutMs}ms`,
		`Config: ${configPath()}`,
		"",
		"Current request + bounded recent conversation are sent to secondary model.",
		"Tool outputs, primary system prompt, and image bytes are not sent.",
	].join("\n");
}

export default function piInterview(pi: ExtensionAPI): void {
	let loaded = loadConfig();
	let config = loaded.config;

	function applyModeState(ctx: ExtensionContext): void {
		const active = pi.getActiveTools();
		const shouldEnableTool = config.mode !== "off" && ctx.hasUI;
		if (shouldEnableTool && !active.includes(TOOL_NAME)) pi.setActiveTools([...active, TOOL_NAME]);
		if (!shouldEnableTool && active.includes(TOOL_NAME)) {
			pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
		}
		ctx.ui.setStatus(
			STATUS_KEY,
			config.mode === "off" ? undefined : `interview:${config.mode} · ${modelRef(config)}`,
		);
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
		applyModeState(ctx);
		if (loaded.error && ctx.hasUI) ctx.ui.notify(loaded.error, "error");
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (config.mode === "off" || !ctx.hasUI) return;
		const augmentedSystemPrompt = `${event.systemPrompt}\n\n${PRIMARY_GUIDANCE}`;
		const packet = buildPreflightContext(event, ctx, config);
		const run = await runWithLoader(
			ctx,
			`Checking clarification needs with ${modelRef(config)}…`,
			(signal) => runInterviewer(ctx, config, packet, config.mode === "strict", signal),
		);
		if (run.status === "cancelled") {
			ctx.ui.notify("Interviewer skipped; primary agent will continue.", "info");
			return { systemPrompt: augmentedSystemPrompt };
		}
		if (run.status === "error") {
			ctx.ui.notify(`Interviewer unavailable: ${run.error}. Primary agent will continue.`, "warning");
			return { systemPrompt: augmentedSystemPrompt };
		}
		if (run.value.decision.action === "proceed") return { systemPrompt: augmentedSystemPrompt };

		const questionnaire = await runQuestionnaire(ctx, run.value.decision.questions);
		return {
			systemPrompt: augmentedSystemPrompt,
			message: {
				customType: MESSAGE_TYPE,
				content: clarificationContent(questionnaire),
				display: true,
				details: messageDetails(run.value, questionnaire),
			},
		};
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Interview user",
		description:
			"Delegate a material user decision to the configured secondary interviewer model. The model generates a multiple-choice questionnaire; selected answers are returned as direct user requirements.",
		promptSnippet: "interview_user({ context }): ask user structured multiple-choice clarification via secondary model",
		promptGuidelines: [
			"Use interview_user when repository inspection reveals a user-owned decision that materially changes implementation.",
			"Pass interview_user concise findings, known constraints, and exact decision point; do not pre-compose questions.",
			"Do not ask free-form clarification in assistant prose while interview_user is active.",
			"Do not use interview_user for facts discoverable with read/search tools or for reversible conventional defaults.",
		],
		parameters: Type.Object({
			context: Type.String({
				description: "Concise findings, constraints, alternatives, and exact user-owned decision requiring clarification",
			}),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (config.mode === "off") {
				return {
					content: [{ type: "text", text: "pi-interview is disabled. Continue using best judgment." }],
					details: { error: "disabled", message: "pi-interview is disabled" } as InterviewToolDetails,
				};
			}
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Interactive UI unavailable. Continue using best judgment." }],
					details: { error: "ui_unavailable", message: "Interactive UI unavailable" } as InterviewToolDetails,
				};
			}
			const packet = buildToolContext(ctx, config, params.context);
			const run = await runWithLoader(
				ctx,
				`Preparing questions with ${modelRef(config)}…`,
				(uiSignal) => runInterviewer(ctx, config, packet, true, uiSignal ?? signal),
				signal,
			);
			if (run.status !== "ok") {
				const message = run.status === "cancelled" ? "Interviewer cancelled" : run.error;
				return {
					content: [{ type: "text", text: `${message}. Continue using best judgment.` }],
					details: { error: run.status, message } as InterviewToolDetails,
				};
			}
			const questionnaire = await runQuestionnaire(ctx, run.value.decision.questions);
			return {
				content: [{ type: "text", text: clarificationContent(questionnaire) }],
				details: messageDetails(run.value, questionnaire) as InterviewToolDetails,
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("Interview user")), 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("muted", "Interviewing…"), 0, 0);
			const fallback = result.content[0]?.type === "text" ? result.content[0].text : "(no result)";
			const details = result.details as InterviewToolDetails | undefined;
			const container = renderSummary(details, fallback, theme, expanded);
			if (!expanded && !details?.error && details?.answers?.length) {
				container.addChild(new Text(theme.fg("dim", keyHint("app.tools.expand", "for model + usage")), 0, 0));
			}
			return container;
		},
	});

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, { expanded }, theme) => {
		const details = message.details as InterviewMessageDetails | undefined;
		const fallback = typeof message.content === "string" ? message.content : "Interview complete";
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(renderSummary(details, fallback, theme, expanded));
		return box;
	});

	pi.registerCommand("interview", {
		description: "Manage secondary-model interviews: auto, strict, off, model, config",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trim();
			if (!trimmed.includes(" ")) {
				const values = ["auto", "strict", "off", "model", "config"];
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

			if (command === "auto" || command === "strict") {
				let selected = rest ? await selectModel(ctx, rest) : undefined;
				if (!selected && !rest && config.provider && config.model && ctx.modelRegistry.find(config.provider, config.model)) {
					selected = { provider: config.provider, model: config.model };
				}
				if (!selected && !rest) selected = await selectModel(ctx);
				if (!selected) return;
				const next = { ...config, mode: command as InterviewMode, ...selected };
				if (!persist(next, ctx)) return;
				const sameAsPrimary = ctx.model?.provider === selected.provider && ctx.model.id === selected.model;
				ctx.ui.notify(
					`pi-interview ${command}: ${selected.provider}/${selected.model}${sameAsPrimary ? " (same as primary model)" : ""}`,
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
					ctx.ui.notify(`Interviewer model: ${selected.provider}/${selected.model}`, "info");
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
