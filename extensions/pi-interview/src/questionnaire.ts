import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	type OverlayHandle,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { normalizeCustomAnswer } from "./protocol.js";
import type {
	InterviewAnswer,
	InterviewQuestion,
	QuestionnaireResult,
	QuestionOption,
} from "./types.js";

interface RenderOption extends QuestionOption {
	isOther?: boolean;
}

const OTHER_VALUE = "__other__";

function displayLabel(option: QuestionOption): string {
	return `${option.recommended ? "★ " : ""}${option.label}`;
}

function displayDescription(option: QuestionOption): string | undefined {
	if (!option.recommended) return option.description;
	return option.description ? `Recommended · ${option.description}` : "Recommended";
}

function answerForOption(question: InterviewQuestion, option: QuestionOption, index: number): InterviewAnswer {
	return {
		id: question.id,
		value: option.value,
		label: option.label,
		wasCustom: false,
		index: index + 1,
	};
}

async function runRpcQuestionnaire(
	ctx: ExtensionContext,
	questions: InterviewQuestion[],
	signal?: AbortSignal,
): Promise<QuestionnaireResult> {
	const answers: InterviewAnswer[] = [];
	for (const question of questions) {
		if (signal?.aborted) return { questions, answers, cancelled: true };
		const options: RenderOption[] = [...question.options];
		if (question.allowOther) options.push({ value: OTHER_VALUE, label: "Type something…", isOther: true });
		const labels = options.map(displayLabel);
		const selected = await ctx.ui.select(question.prompt, labels, { signal });
		if (selected === undefined || signal?.aborted) return { questions, answers, cancelled: true };
		const index = labels.indexOf(selected);
		const option = options[index];
		if (!option) return { questions, answers, cancelled: true };
		if (option.isOther) {
			const rawCustom = await ctx.ui.input(`${question.label}:`, "Type your answer", { signal });
			const custom = normalizeCustomAnswer(rawCustom);
			if (!custom || signal?.aborted) return { questions, answers, cancelled: true };
			answers.push({ id: question.id, value: custom, label: custom, wasCustom: true });
		} else {
			answers.push(answerForOption(question, option, index));
		}
	}
	return { questions, answers, cancelled: false };
}

export interface QuestionnaireOptions {
	/**
	 * Render in the overlay layer instead of the editor slot.
	 *
	 * Only the restart-resume path needs this. It runs from `session_start`,
	 * where other extensions are still installing their own UI. pi-quiet, for
	 * one, calls `ui.setEditorComponent`, and pi implements that as
	 * `editorContainer.clear()` followed by `ui.setFocus(newEditor)`. An inline
	 * component installed during `session_start` is evicted by that clear
	 * without a word, leaving this promise pending forever. The overlay stack is
	 * a separate layer and survives the clear.
	 *
	 * A questionnaire opened mid-turn has no such race, so it stays inline like
	 * every other pi selector: it takes the editor slot and leaves the
	 * transcript visible above it.
	 */
	overlay?: boolean;
	/**
	 * Receives the overlay handle once the overlay is on screen.
	 *
	 * Surviving the container clear is only half the job: the `setFocus` that
	 * follows it hands keyboard input to the new editor, and pi-tui treats a
	 * non-overlay component taking focus from an overlay as a deliberate handoff
	 * (`blocked`), which suppresses the reclaim-on-keypress it would otherwise
	 * do. The caller uses this handle to take focus back.
	 */
	onHandle?: (handle: OverlayHandle) => void;
}

export async function runQuestionnaire(
	ctx: ExtensionContext,
	questions: InterviewQuestion[],
	signal?: AbortSignal,
	options: QuestionnaireOptions = {},
): Promise<QuestionnaireResult> {
	if (questions.length === 0) return { questions, answers: [], cancelled: false };
	if (signal?.aborted) return { questions, answers: [], cancelled: true };
	if (ctx.mode !== "tui") return runRpcQuestionnaire(ctx, questions, signal);

	const isMulti = questions.length > 1;
	const totalTabs = questions.length + 1;
	const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _keybindings, done) => {
		let currentTab = 0;
		let optionIndex = 0;
		let inputMode = false;
		let inputQuestionId: string | null = null;
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		let finished = false;
		let signalAbortHandler: (() => void) | undefined;
		const answers = new Map<string, InterviewAnswer>();
		/** Free-text kept per question so leaving the editor never loses typing. */
		const drafts = new Map<string, string>();

		const editorTheme: EditorTheme = {
			borderColor: (text) => theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		};
		const editor = new Editor(tui, editorTheme);

		function cleanupSignal(): void {
			if (signalAbortHandler) signal?.removeEventListener("abort", signalAbortHandler);
		}

		function refresh(): void {
			cachedWidth = undefined;
			cachedLines = undefined;
			tui.requestRender();
		}

		function submit(cancelled: boolean): void {
			if (finished) return;
			finished = true;
			cleanupSignal();
			done({ questions, answers: Array.from(answers.values()), cancelled });
		}

		signalAbortHandler = () => submit(true);
		if (signal?.aborted) signalAbortHandler();
		else signal?.addEventListener("abort", signalAbortHandler, { once: true });

		function currentQuestion(): InterviewQuestion | undefined {
			return questions[currentTab];
		}

		function currentOptions(): RenderOption[] {
			const question = currentQuestion();
			if (!question) return [];
			const options: RenderOption[] = [...question.options];
			if (question.allowOther) options.push({ value: OTHER_VALUE, label: "Type something…", isOther: true });
			return options;
		}

		function allAnswered(): boolean {
			return questions.every((question) => answers.has(question.id));
		}

		function advanceAfterAnswer(): void {
			if (!isMulti) {
				submit(false);
				return;
			}
			currentTab = currentTab < questions.length - 1 ? currentTab + 1 : questions.length;
			optionIndex = 0;
			refresh();
		}

		editor.onSubmit = (value) => {
			if (!inputQuestionId) return;
			const custom = normalizeCustomAnswer(value);
			if (!custom) {
				refresh();
				return;
			}
			answers.set(inputQuestionId, {
				id: inputQuestionId,
				value: custom,
				label: custom,
				wasCustom: true,
			});
			drafts.set(inputQuestionId, custom);
			inputMode = false;
			inputQuestionId = null;
			editor.setText("");
			advanceAfterAnswer();
		};

		function handleInput(data: string): void {
			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					// Escape returns to the option list. Keep the text: destroying it
					// here is what made answers disappear.
					if (inputQuestionId) drafts.set(inputQuestionId, editor.getText());
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			const question = currentQuestion();
			const options = currentOptions();

			if (isMulti && (matchesKey(data, Key.tab) || matchesKey(data, Key.right))) {
				currentTab = (currentTab + 1) % totalTabs;
				optionIndex = 0;
				refresh();
				return;
			}
			if (isMulti && (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))) {
				currentTab = (currentTab - 1 + totalTabs) % totalTabs;
				optionIndex = 0;
				refresh();
				return;
			}

			if (currentTab === questions.length) {
				if (matchesKey(data, Key.enter) && allAnswered()) submit(false);
				else if (matchesKey(data, Key.escape)) submit(true);
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(options.length - 1, optionIndex + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter) && question) {
				const option = options[optionIndex];
				if (!option) return;
				if (option.isOther) {
					inputMode = true;
					inputQuestionId = question.id;
					editor.setText(drafts.get(question.id) ?? "");
					refresh();
					return;
				}
				answers.set(question.id, answerForOption(question, option, optionIndex));
				advanceAfterAnswer();
				return;
			}
			if (matchesKey(data, Key.escape)) submit(true);
		}

		function render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			const lines: string[] = [];
			const renderWidth = Math.max(1, width);
			const question = currentQuestion();
			const options = currentOptions();

			function addWrapped(text: string): void {
				lines.push(...wrapTextWithAnsi(text, renderWidth));
			}

			function addWrappedWithPrefix(prefix: string, text: string): void {
				const prefixWidth = visibleWidth(prefix);
				if (prefixWidth >= renderWidth) {
					addWrapped(prefix + text);
					return;
				}
				const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
				const continuationPrefix = " ".repeat(prefixWidth);
				for (let index = 0; index < wrapped.length; index++) {
					lines.push(`${index === 0 ? prefix : continuationPrefix}${wrapped[index]}`);
				}
			}

			lines.push(theme.fg("accent", "─".repeat(renderWidth)));
			if (isMulti) {
				const tabs: string[] = ["← "];
				for (let index = 0; index < questions.length; index++) {
					const tabQuestion = questions[index];
					if (!tabQuestion) continue;
					const active = index === currentTab;
					const answered = answers.has(tabQuestion.id);
					const marker = answered ? "■" : "□";
					const text = ` ${marker} ${tabQuestion.label} `;
					const styled = active
						? theme.bg("selectedBg", theme.fg("text", text))
						: theme.fg(answered ? "success" : "muted", text);
					tabs.push(`${styled} `);
				}
				const active = currentTab === questions.length;
				const text = " ✓ Submit ";
				tabs.push(
					`${active ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(allAnswered() ? "success" : "dim", text)} →`,
				);
				addWrappedWithPrefix(" ", tabs.join(""));
				lines.push("");
			}

			function renderOptions(): void {
				for (let index = 0; index < options.length; index++) {
					const option = options[index];
					if (!option) continue;
					const selected = index === optionIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const draft = option.isOther && question ? drafts.get(question.id) : undefined;
					const label = `${index + 1}. ${displayLabel(option)}${option.isOther && (inputMode || draft) ? " ✎" : ""}`;
					addWrappedWithPrefix(prefix, theme.fg(selected ? "accent" : "text", label));
					const description = displayDescription(option);
					if (description) addWrappedWithPrefix("     ", theme.fg("muted", description));
				}
			}

			if (inputMode && question) {
				addWrappedWithPrefix(" ", theme.fg("text", question.prompt));
				lines.push("");
				renderOptions();
				lines.push("");
				addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
				for (const line of editor.render(Math.max(1, renderWidth - 2))) lines.push(` ${line}`);
				lines.push("");
				addWrappedWithPrefix(" ", theme.fg("dim", "Enter submit · Esc return to options"));
			} else if (currentTab === questions.length) {
				addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
				lines.push("");
				for (const item of questions) {
					const answer = answers.get(item.id);
					if (!answer) continue;
					const prefix = answer.wasCustom ? "(wrote) " : "";
					addWrappedWithPrefix(
						" ",
						`${theme.fg("muted", `${item.label}: `)}${theme.fg("text", prefix + answer.label)}`,
					);
				}
				lines.push("");
				if (allAnswered()) addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
				else {
					const missing = questions.filter((item) => !answers.has(item.id)).map((item) => item.label).join(", ");
					addWrappedWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`));
				}
			} else if (question) {
				addWrappedWithPrefix(" ", theme.fg("text", question.prompt));
				lines.push("");
				renderOptions();
			}

			lines.push("");
			if (!inputMode) {
				const help = isMulti
					? "Tab/←→ questions · ↑↓ options · Enter select · Esc cancel"
					: "↑↓ options · Enter select · Esc cancel";
				addWrappedWithPrefix(" ", theme.fg("dim", help));
			}
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));
			cachedWidth = width;
			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedWidth = undefined;
				cachedLines = undefined;
			},
			handleInput,
			dispose: cleanupSignal,
		};
		},
		options.overlay ? { overlay: true, ...(options.onHandle ? { onHandle: options.onHandle } : {}) } : undefined,
	);

	return result ?? { questions, answers: [], cancelled: true };
}
