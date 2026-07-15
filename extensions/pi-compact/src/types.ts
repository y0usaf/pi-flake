export const MAX_SUMMARY_LENGTH = 120;
export const MAX_RESULT_LENGTH = 72;
export const MAX_USER_MESSAGE_LENGTH = 240;

export const TOOL_ARROW = "→";
export const TOOL_SEPARATOR = "·";
export const USER_PROMPT_MARKER = ">";

export const OSC133_ZONE_START = "\x1b]133;A\x07";
export const OSC133_ZONE_END = "\x1b]133;B\x07";
export const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export const TOOL_ORIGINAL_RENDER_KEY = "__piCompactOriginalToolRender";
export const TOOL_ORIGINAL_SET_EXPANDED_KEY = "__piCompactOriginalToolSetExpanded";
export const USER_ORIGINAL_RENDER_KEY = "__piCompactOriginalUserRender";
export const ASSISTANT_ORIGINAL_UPDATE_CONTENT_KEY = "__piCompactOriginalAssistantUpdateContent";

export const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;
