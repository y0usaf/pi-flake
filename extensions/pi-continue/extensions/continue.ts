/**
 * pi-continue — resume an interrupted assistant stream.
 *
 * A hidden custom message triggers a fresh request. The context hook strips
 * every pi-continue marker before the provider payload is built, leaving the
 * previous assistant message as the provider's prefill.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MARKER = "pi-continue";

export default function (pi: ExtensionAPI) {
	pi.on("context", (event) => ({
		messages: event.messages.filter((message) => message.role !== "custom" || message.customType !== MARKER),
	}));

	const continueRun = (ctx: ExtensionContext) => {
		if (!ctx.isIdle()) {
			ctx.ui.notify("Cannot continue while pi is busy", "warning");
			return;
		}

		const entries = ctx.sessionManager.buildContextEntries();
		const last = entries.at(-1);
		const message = last?.type === "message" ? last.message : undefined;
		if (
			!message ||
			message.role !== "assistant" ||
			message.stopReason === "error" ||
			message.stopReason === "aborted" ||
			message.content.some((part) => part.type === "toolCall")
		) {
			ctx.ui.notify("Cannot continue: the last message is not a completed assistant prefill", "warning");
			return;
		}

		pi.sendMessage({ customType: MARKER, content: "Continue", display: false }, { triggerTurn: true });
	};

	pi.registerCommand("continue", {
		description: "Resume the previous assistant output",
		handler: async (_args, ctx) => continueRun(ctx),
	});
}
