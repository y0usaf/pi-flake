import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, _ctx) => {
    if (isToolCallEventType("bash", event)) {
      // prepend shell function wrappers so LLM's `grep` and `find` calls
      // route through rg/fd. Each bash invocation is a fresh process, so
      // these must be defined every call.
      event.input.command =
        `grep() { rg "$@"; }; find() { fd "$@"; };\n${event.input.command}`;
    }
  });
}