import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

/**
 * claudish-to-english — a display-only plain-English rewrite of the final
 * assistant message each turn, ported from gvzdv/claudish-to-english.
 *
 * The rewrite is appended as a custom entry ("💬 In plain English: …") after
 * the original message. Custom entries never enter the model context, so the
 * agent keeps seeing the original text; only what you read on screen changes.
 *
 * Fail-open by construction: if there is no usable model or the rewrite
 * fails, nothing is appended and the original message stands untouched.
 */

const ENTRY_KEY = "claudish-to-english";

const SYSTEM_PROMPT =
	"You rewrite the assistant's message into much simpler, plain English. Keep every fact, name, number, and file path. Use short sentences and everyday words. Leave fenced code blocks unchanged. Output ONLY the rewritten message with no preamble, labels, or commentary.";

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const item = block as { type?: string; text?: string };
			return item.type === "text" ? item.text ?? "" : "";
		})
		.filter(Boolean)
		.join(" ");
}

let lastTranslatedText: string | null = null;

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer(ENTRY_KEY, (entry, _options, theme) => {
		const translation = (entry.data as { translation?: string } | undefined)?.translation ?? "";
		if (!translation) return undefined;
		const box = new Box(1, 1, (text) => theme.bg("toolSuccessBg", text));
		box.addChild(new Text(theme.fg("toolTitle", theme.bold("Agent")), 0, 0));
		box.addChild(new Text(translation, 0, 0));
		return box;
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		// Find the last assistant message in the branch — the final message of
		// the turn. Walk backwards so tool results after it don't matter.
		const branch = ctx.sessionManager.getBranch();
		let text: string | null = null;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "message") continue;
			if (!("content" in entry.message)) continue;
			if (entry.message.role !== "assistant") continue;
			const candidate = extractText(entry.message.content).trim();
			if (candidate) {
				text = candidate;
				break;
			}
		}
		if (!text) return;
		// Auto-retry / compaction re-fires agent_end on the same final message.
		if (text === lastTranslatedText) return;

		const model = ctx.model;
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return;

		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: SYSTEM_PROMPT,
					messages: [
						{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
					],
				},
				{ maxTokens: 4096, signal: ctx.signal },
			);
			const translation = extractText(response.content).trim();
			if (!translation || translation === text) return;
			lastTranslatedText = text;
			pi.appendEntry(ENTRY_KEY, { translation });
		} catch {
			// Fail open: leave the original message as-is.
		}
	});
}
