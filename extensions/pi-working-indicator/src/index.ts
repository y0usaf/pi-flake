import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";

const HIDDEN_WORKING_MESSAGE = "\u200B"; // zero-width: Pi treats "" as "use default"

export default function workingIndicator(pi: ExtensionAPI) {
	pi.on("agent_start", (_event, ctx) => ctx.ui.setWorkingMessage(HIDDEN_WORKING_MESSAGE));
}
