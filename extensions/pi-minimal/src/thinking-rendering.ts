import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { state } from "./state.js";
import {
	ASSISTANT_ORIGINAL_RENDER_KEY,
	ASSISTANT_ORIGINAL_UPDATE_CONTENT_KEY,
	ASSISTANT_THINKING_APPLIED_MODE_KEY,
	THINKING_MARKER,
	type ThinkingMode,
} from "./types.js";
import { countLabel, formatDuration, paint, renderOneLine, spinnerFrame, stripAnsi } from "./shared.js";

type ThinkingDisplayState = {
	charCount: number;
	active: boolean;
	/** Set when thinking was observed streaming in this process; absent for historic rows. */
	startedAt?: number;
	finishedAt?: number;
};

const thinkingStates = new WeakMap<object, ThinkingDisplayState>();

function getThinkingBlocks(message: any): string[] {
	if (!Array.isArray(message?.content)) return [];
	return message.content
		.filter((content: any) => content?.type === "thinking" && typeof content.thinking === "string")
		.map((content: any) => content.thinking.trim())
		.filter((thinking: string) => thinking.length > 0);
}

function isThinkingActive(message: any): boolean {
	if (message?.stopReason === "error" || message?.stopReason === "aborted" || !Array.isArray(message?.content)) {
		return false;
	}

	for (let index = message.content.length - 1; index >= 0; index--) {
		const content = message.content[index];
		if (content?.type === "thinking" && typeof content.thinking === "string" && content.thinking.trim()) return true;
		if (content?.type === "text" && typeof content.text === "string" && content.text.trim()) return false;
		if (content?.type === "toolCall") return false;
	}

	return false;
}

function updateThinkingState(component: any, message: any, blocks: string[]): ThinkingDisplayState | undefined {
	if (blocks.length === 0) {
		thinkingStates.delete(component as object);
		return undefined;
	}

	const prev = thinkingStates.get(component as object);
	const active = isThinkingActive(message);
	const now = Date.now();
	const startedAt = prev?.startedAt ?? (active ? now : undefined);
	const next: ThinkingDisplayState = {
		charCount: stripAnsi(blocks.join("\n")).length,
		active,
		startedAt,
		finishedAt: active ? undefined : (prev?.finishedAt ?? (startedAt !== undefined ? now : undefined)),
	};
	thinkingStates.set(component as object, next);
	return next;
}

function cloneAssistantForDisplay(message: any, hideThinking: boolean): any {
	if (!Array.isArray(message?.content)) return message;
	const firstToolCall = message.content.findIndex((content: any) => content?.type === "toolCall");
	return {
		...message,
		content: message.content.filter((content: any, index: number) => {
			if (hideThinking && content?.type === "thinking") return false;
			return !(firstToolCall >= 0 && index > firstToolCall && content?.type === "text");
		}),
	};
}

/** Effective display mode: the feature flag maps to native behavior when off,
 * and Pi's Ctrl-T hidden state always wins over the configured mode. */
function getAssistantThinkingMode(component: any): ThinkingMode {
	if (component?.hideThinkingBlock === true) return "hidden";
	return state.features.thinking ? state.thinkingMode : "normal";
}

function thinkingSuffix(displayState: ThinkingDisplayState): string {
	if (displayState.startedAt !== undefined) {
		const end = displayState.active ? Date.now() : (displayState.finishedAt ?? Date.now());
		return formatDuration(end - displayState.startedAt);
	}
	return countLabel(displayState.charCount, "char");
}

function buildThinkingLine(displayState: ThinkingDisplayState): string {
	const suffix = thinkingSuffix(displayState);
	return [
		paint("accent", displayState.active ? spinnerFrame() : THINKING_MARKER),
		" ",
		paint(displayState.active ? "warning" : "muted", displayState.active ? "thinking" : "thought"),
		suffix ? ` ${paint("dim", `· ${suffix}`)}` : "",
	].join("");
}

export function renderCompactThinkingLine(displayState: ThinkingDisplayState, width: number): string[] {
	return renderOneLine(buildThinkingLine(displayState), width);
}

export function patchAssistantMessageComponent(): boolean {
	try {
		const proto = (AssistantMessageComponent as any)?.prototype;
		if (!proto || typeof proto.render !== "function" || typeof proto.updateContent !== "function") {
			throw new Error("AssistantMessageComponent unavailable");
		}

		const originalRender =
			typeof proto[ASSISTANT_ORIGINAL_RENDER_KEY] === "function" ? proto[ASSISTANT_ORIGINAL_RENDER_KEY] : proto.render;
		const originalUpdateContent =
			typeof proto[ASSISTANT_ORIGINAL_UPDATE_CONTENT_KEY] === "function"
				? proto[ASSISTANT_ORIGINAL_UPDATE_CONTENT_KEY]
				: proto.updateContent;

		proto.updateContent = function piMinimalAssistantUpdateContent(this: any, message: any) {
			const thinkingMode = getAssistantThinkingMode(this);
			const blocks = getThinkingBlocks(message);
			this[ASSISTANT_THINKING_APPLIED_MODE_KEY] = thinkingMode;

			const displayState = thinkingMode === "compact" ? updateThinkingState(this, message, blocks) : undefined;
			if (thinkingMode !== "compact") thinkingStates.delete(this as object);

			try {
				return originalUpdateContent.call(this, cloneAssistantForDisplay(message, thinkingMode !== "normal"));
			} finally {
				// Keep source message so mode changes and Pi's invalidate path can rebuild
				// display without losing hidden thinking blocks.
				this.lastMessage = message;
			}
		};

		proto.render = function piMinimalAssistantRender(this: any, width: number) {
			const thinkingMode = getAssistantThinkingMode(this);
			if (this[ASSISTANT_THINKING_APPLIED_MODE_KEY] !== thinkingMode && this.lastMessage) {
				this.updateContent(this.lastMessage);
			}

			const lines = originalRender.call(this, width);
			const displayState = thinkingStates.get(this as object);
			if (thinkingMode !== "compact" || !displayState) return lines;

			const thinkingLines = renderCompactThinkingLine(displayState, width);
			return thinkingLines.length > 0 ? [...thinkingLines, ...lines] : lines;
		};

		proto[ASSISTANT_ORIGINAL_RENDER_KEY] = originalRender;
		proto[ASSISTANT_ORIGINAL_UPDATE_CONTENT_KEY] = originalUpdateContent;
		state.lastAssistantPatchError = undefined;
		return true;
	} catch (error) {
		state.lastAssistantPatchError = error instanceof Error ? (error.stack ?? error.message) : String(error);
		return false;
	}
}
