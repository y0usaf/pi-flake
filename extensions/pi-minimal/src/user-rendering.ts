import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { state } from "./state.js";
import { OSC133_ZONE_END, OSC133_ZONE_FINAL, OSC133_ZONE_START, USER_ORIGINAL_RENDER_KEY, USER_PROMPT_MARKER } from "./types.js";
import { paint } from "./shared.js";

function userTextFromComponent(component: any): string | undefined {
	if (typeof component?.text === "string") return component.text;

	const children = component?.contentBox?.children;
	if (!Array.isArray(children)) return undefined;
	return children.find((child: any) => typeof child?.text === "string")?.text;
}

function withZoneMarkers(lines: string[]): string[] {
	if (lines.length === 0) return lines;
	const marked = [...lines];
	marked[0] = OSC133_ZONE_START + marked[0];
	marked[marked.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + marked[marked.length - 1];
	return marked;
}

function renderWrappedText(text: string, width: number): string[] {
	if (!Number.isFinite(width) || width <= 0) return [];
	return wrapTextWithAnsi(text.replace(/\t/g, "   "), width).map((line) =>
		`${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`,
	);
}

export function renderCompactUserMessage(
	component: any,
	width: number,
	originalRender: (width: number) => string[],
): string[] {
	const text = userTextFromComponent(component);
	if (text === undefined) return originalRender.call(component, width);

	const line = paint("warning", `${USER_PROMPT_MARKER} ${text}`, true);
	const lines = withZoneMarkers(renderWrappedText(line, width));
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
