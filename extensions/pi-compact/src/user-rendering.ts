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
import { clip, renderOneLine, squash, stripAnsi } from "./shared.js";

export type UserMessageComponentShape = {
  contentBox?: { children?: unknown };
};

function userTextFromComponent(component: UserMessageComponentShape): string {
  const children = component.contentBox?.children;
  if (!Array.isArray(children)) return "";
  for (const child of children) {
    if (typeof (child as any)?.text === "string") return (child as any).text;
  }
  return "";
}

function userTextFromRendered(lines: string[]): string {
  return squash(stripAnsi(lines.join(" ")));
}

function withZoneMarkers(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  const marked = [...lines];
  marked[0] = OSC133_ZONE_START + marked[0];
  marked[marked.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + marked[marked.length - 1];
  return marked;
}

export function renderCompactUserMessage(
  component: UserMessageComponentShape,
  width: number,
  originalRender: (width: number) => string[],
): string[] {
  const text = userTextFromComponent(component) || userTextFromRendered(originalRender.call(component, width));
  const summary = clip(squash(text), MAX_USER_MESSAGE_LENGTH) || "…";
  return withZoneMarkers(renderOneLine(`${USER_PROMPT_MARKER} ${summary}`, width));
}

export function patchUserMessageComponent(): boolean {
  try {
    const proto = (UserMessageComponent as any)?.prototype;
    if (!proto || typeof proto.render !== "function") throw new Error("UserMessageComponent unavailable");

    const originalRender = typeof proto[USER_ORIGINAL_RENDER_KEY] === "function" ? proto[USER_ORIGINAL_RENDER_KEY] : proto.render;
    proto.render = function piCompactUserRender(this: UserMessageComponentShape, width: number) {
      return renderCompactUserMessage(this, width, originalRender);
    };
    proto[USER_ORIGINAL_RENDER_KEY] = originalRender;
    state.lastUserPatchError = undefined;
    return true;
  } catch (error) {
    state.lastUserPatchError = error instanceof Error ? error.stack ?? error.message : String(error);
    return false;
  }
}
