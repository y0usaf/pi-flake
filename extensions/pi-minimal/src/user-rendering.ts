import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { state } from "./state.js";
import {
	MAX_USER_MESSAGE_LENGTH,
	OSC133_ZONE_END,
	OSC133_ZONE_FINAL,
	OSC133_ZONE_START,
	USER_ORIGINAL_RENDER_KEY,
	USER_PROMPT_MARKER,
} from "./types.js";
import { clip, paint, renderOneLine, squash } from "./shared.js";

function userTextFromComponent(component: any): string {
	const children = component.contentBox?.children;
	return Array.isArray(children) ? (children.find((child: any) => typeof child?.text === "string")?.text ?? "") : "";
}

function withZoneMarkers(lines: string[]): string[] {
	if (lines.length === 0) return lines;
	const marked = [...lines];
	marked[0] = OSC133_ZONE_START + marked[0];
	marked[marked.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + marked[marked.length - 1];
	return marked;
}

export function renderCompactUserMessage(
	component: any,
	width: number,
	originalRender: (width: number) => string[],
): string[] {
	const text = userTextFromComponent(component) || squash(originalRender.call(component, width).join(" "));
	const summary = clip(text, MAX_USER_MESSAGE_LENGTH) || "…";
	const line = `${paint("warning", USER_PROMPT_MARKER, true)} ${paint("warning", summary, true)}`;
	const lines = withZoneMarkers(renderOneLine(line, width));
	return lines.length > 0 ? [...lines, ""] : lines;
}

export function patchUserMessageComponent(): boolean {
	try {
		const proto = (UserMessageComponent as any)?.prototype;
		if (!proto || typeof proto.render !== "function") throw new Error("UserMessageComponent unavailable");

		const originalRender = typeof proto[USER_ORIGINAL_RENDER_KEY] === "function" ? proto[USER_ORIGINAL_RENDER_KEY] : proto.render;
		proto.render = function piMinimalUserRender(this: any, width: number) {
			if (!state.features.user) return originalRender.call(this, width);
			return renderCompactUserMessage(this, width, originalRender);
		};
		proto[USER_ORIGINAL_RENDER_KEY] = originalRender;
		state.lastUserPatchError = undefined;
		return true;
	} catch (error) {
		state.lastUserPatchError = error instanceof Error ? (error.stack ?? error.message) : String(error);
		return false;
	}
}
