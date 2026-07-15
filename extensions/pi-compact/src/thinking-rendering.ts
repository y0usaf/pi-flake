import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { state } from "./state.js";
import { ASSISTANT_ORIGINAL_UPDATE_CONTENT_KEY } from "./types.js";

function cloneAssistantForDisplay(message: any): any {
  if (!Array.isArray(message?.content)) return message;
  const firstToolCall = message.content.findIndex((content: any) => content?.type === "toolCall");
  return {
    ...message,
    content: message.content.filter((content: any, index: number) => {
      if (content?.type === "thinking") return false;
      return !(firstToolCall >= 0 && index > firstToolCall && content?.type === "text");
    }),
  };
}

export function patchAssistantMessageComponent(): boolean {
  try {
    const proto = (AssistantMessageComponent as any)?.prototype;
    if (!proto || typeof proto.updateContent !== "function") throw new Error("AssistantMessageComponent unavailable");

    const originalUpdateContent =
      typeof proto[ASSISTANT_ORIGINAL_UPDATE_CONTENT_KEY] === "function"
        ? proto[ASSISTANT_ORIGINAL_UPDATE_CONTENT_KEY]
        : proto.updateContent;

    proto.updateContent = function piCompactAssistantUpdateContent(this: any, message: any) {
      return originalUpdateContent.call(this, cloneAssistantForDisplay(message));
    };

    proto[ASSISTANT_ORIGINAL_UPDATE_CONTENT_KEY] = originalUpdateContent;
    state.lastAssistantPatchError = undefined;
    return true;
  } catch (error) {
    state.lastAssistantPatchError = error instanceof Error ? error.stack ?? error.message : String(error);
    return false;
  }
}
