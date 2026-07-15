import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { state } from "./state.js";
import {
  ASSISTANT_ORIGINAL_RENDER_KEY,
  ASSISTANT_ORIGINAL_UPDATE_CONTENT_KEY,
  ASSISTANT_THINKING_APPLIED_MODE_KEY,

  THINKING_MARKER,
  type ThinkingMode,
} from "./types.js";
import { clip, paint, renderOneLine, stripAnsi } from "./shared.js";

type ThinkingDisplayState = {
  charCount: number;
  active: boolean;
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

  const next = {
    charCount: stripAnsi(blocks.join("\n")).length,
    active: isThinkingActive(message),
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

function getAssistantThinkingMode(component: any): ThinkingMode {
  // Pi's Ctrl-T state is private in AssistantMessageComponent, but stable across
  // the public setter/rebuild path. Native hidden state wins over extension mode.
  return component?.hideThinkingBlock === true ? "hidden" : state.thinkingMode;
}

function buildThinkingLine(displayState: ThinkingDisplayState): string {
  const label = displayState.active ? "thinking" : "thought";
  const count = `${displayState.charCount} ${displayState.charCount === 1 ? "char" : "chars"}`;
  return [
    paint("accent", THINKING_MARKER),
    " ",
    paint(displayState.active ? "warning" : "muted", label),
    ` ${paint("dim", `· ${clip(count, 32)}`)}`,
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

    proto.updateContent = function piCompactAssistantUpdateContent(this: any, message: any) {
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

    proto.render = function piCompactAssistantRender(this: any, width: number) {
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
    state.lastAssistantPatchError = error instanceof Error ? error.stack ?? error.message : String(error);
    return false;
  }
}
