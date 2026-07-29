import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionAPI, TreeSelectorComponent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { applyCuts } from "./filter.js";
import { resolveTreeSummary, validateReason } from "./manual.js";
import { resolveTreeFilterMode, type TreeFilterMode } from "./settings.js";
import { buildBreadcrumb, formatTokens, replayMarkers } from "./state.js";
import { buildTurnAnchors, estimateTokens, findAnchorById, findAnchorByTurnsBack, renderTurnMap } from "./turns.js";
import {
	CUT_ENTRY_TYPE,
	type CutMarker,
	MANUAL_ENTRY_TYPE,
	type ManualCutRecord,
	type MessageLike,
	type PendingManualCut,
	UNDO_ENTRY_TYPE,
} from "./types.js";

const TOOL_NAME = "chrono_break";

/** Reads a JSON file, or undefined when it is missing or malformed. */
function readJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * The filter `/tree` would open with, so `/chrono cut` shows the same rows.
 * Project settings are honoured only for a trusted project.
 */
function readTreeFilterMode(cwd: string, home: string, trusted: boolean): TreeFilterMode {
	const paths = [
		...(trusted ? [join(cwd, CONFIG_DIR_NAME, "settings.json")] : []),
		join(home, CONFIG_DIR_NAME, "agent", "settings.json"),
	];
	return resolveTreeFilterMode(readJsonFile, paths);
}

const ChronoBreakParams = Type.Object({
	action: StringEnum(["preview", "rewind", "undo"] as const, {
		description: "preview: list rewindable turns. rewind: remove a turn and everything after it. undo: restore the last rewind.",
	}),
	anchor: Type.Optional(
		Type.String({
			description: "Anchor id from a preview call, e.g. cb-3f9a. Required for rewind unless turns is given.",
		}),
	),
	turns: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Alternative to anchor: how many user turns back to cut, counting 1 as the most recent user turn.",
		}),
	),
	reason: Type.Optional(
		Type.String({
			description: "Required for rewind. What was attempted and why it failed. Replayed verbatim to you after the rewind.",
		}),
	),
});

export default function (pi: ExtensionAPI): void {
	let markers: CutMarker[] = [];
	/**
	 * The transcript exactly as the model last saw it: post-filter, so a second
	 * rewind can only target turns that are still visible.
	 */
	let lastContext: MessageLike[] = [];
	/**
	 * Set only while a `/chrono cut` we started is navigating. The
	 * session_before_tree handler checks it so that tree navigation you start
	 * by hand keeps pi's normal branch-summary behaviour.
	 */
	let pendingCut: PendingManualCut | undefined;

	pi.on("session_start", (_event, ctx) => {
		markers = replayMarkers(ctx.sessionManager.getEntries());
	});

	pi.on("context", (event) => {
		const result = applyCuts(event.messages as unknown as MessageLike[], markers);
		lastContext = result.messages;
		if (markers.length === 0) return undefined;
		return { messages: result.messages as unknown as typeof event.messages };
	});

	pi.registerEntryRenderer(CUT_ENTRY_TYPE, (entry, options, theme) => {
		const data = (entry.data ?? {}) as Partial<CutMarker>;
		const turns = data.turnsBack === 1 ? "1 turn" : `${data.turnsBack ?? "?"} turns`;
		const head = `⏪ chrono-break: rewound ${turns}, ≈${formatTokens(data.droppedTokens ?? 0)} tokens dropped`;
		const line = options.expanded && data.reason ? `${head}\n   ${data.reason}` : head;
		return new Text(theme.fg("dim", line));
	});

	pi.registerEntryRenderer(UNDO_ENTRY_TYPE, (entry, _options, theme) => {
		const data = (entry.data ?? {}) as { id?: string };
		return new Text(theme.fg("dim", `⏩ chrono-break: restored ${data.id ?? "last rewind"}`));
	});

	pi.registerEntryRenderer(MANUAL_ENTRY_TYPE, (entry, options, theme) => {
		const data = (entry.data ?? {}) as Partial<ManualCutRecord>;
		const kind = data.mode === "llm" ? "summarised branch" : "frozen note";
		const head = `⏪ chrono-break: manual cut, ${data.entriesLeft ?? "?"} entries left behind (${kind})`;
		const line = options.expanded && data.reason ? `${head}\n   ${data.reason}` : head;
		return new Text(theme.fg("dim", line));
	});

	// Only ever supplies a summary for navigation this extension started; see
	// resolveTreeSummary for why the target-id check is load-bearing.
	pi.on("session_before_tree", (event) => {
		return resolveTreeSummary(pendingCut, event.preparation.targetId, event.preparation.entriesToSummarize.length);
	});

	function commitRewind(anchorId: string, turnsBack: number, cutAt: number, index: number, reason: string): CutMarker {
		const droppedSlice = lastContext.slice(index);
		const marker: CutMarker = {
			id: anchorId,
			cutAt,
			createdAt: Date.now(),
			reason,
			turnsBack,
			droppedMessages: droppedSlice.length,
			droppedTokens: estimateTokens(droppedSlice),
			breadcrumb: "",
		};
		marker.breadcrumb = buildBreadcrumb(marker.turnsBack, marker.droppedMessages, marker.droppedTokens, reason);
		markers = [...markers, marker];
		pi.appendEntry(CUT_ENTRY_TYPE, marker);
		return marker;
	}

	pi.registerTool({
		name: TOOL_NAME,
		label: "Chrono Break",
		description: [
			"Rewind the conversation: remove a user turn and everything after it from your own context, permanently, for the rest of the session.",
			"Use it when an approach has failed and the record of that attempt is now noise that will keep pulling you back to it.",
			'Call with action "preview" first to see the turn map with anchor ids and token counts, then action "rewind" with an anchor and a reason.',
			"The removed turns are gone from your view but remain in the session file on disk, so the user can still audit them.",
			"You will not see this tool's own result after a rewind: the only thing that survives is your reason string, replayed at the cut point.",
		].join(" "),
		promptSnippet: "chrono_break({ action }): rewind your context past a failed approach",
		promptGuidelines: [
			"Use chrono_break when a line of work has been abandoned and its transcript is now misleading context, not when output is merely long.",
			'Always run chrono_break with action "preview" before a rewind; pick an anchor id from that map rather than guessing a turn count.',
			"Write the reason as instructions to your future self: what was tried, why it failed, what not to repeat.",
			"Never rewind past the user's original request, and never rewind work the user has not seen the outcome of.",
		],
		parameters: ChronoBreakParams,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const anchors = buildTurnAnchors(lastContext);

			if (params.action === "preview") {
				return {
					content: [{ type: "text", text: renderTurnMap(anchors) }],
					details: { action: "preview", anchors, activeCuts: markers.length },
				};
			}

			if (params.action === "undo") {
				const last = markers[markers.length - 1];
				if (!last) throw new Error("chrono_break: no rewind to undo in this session.");
				markers = markers.slice(0, -1);
				pi.appendEntry(UNDO_ENTRY_TYPE, { id: last.id, reason: last.reason });
				return {
					content: [{ type: "text", text: `Restored ${last.droppedMessages} messages removed by ${last.id}.` }],
					details: { action: "undo", id: last.id },
				};
			}

			const reason = (params.reason ?? "").trim();
			if (reason.length < 10) {
				throw new Error("chrono_break: rewind requires a reason of at least 10 characters; it is the only thing you keep.");
			}
			if (params.anchor && params.turns !== undefined) {
				throw new Error("chrono_break: pass either anchor or turns, not both.");
			}

			const target = params.anchor
				? findAnchorById(anchors, params.anchor)
				: params.turns !== undefined
					? findAnchorByTurnsBack(anchors, params.turns)
					: undefined;

			if (!target) {
				const known = anchors.map((anchor) => anchor.id).join(", ") || "none";
				throw new Error(`chrono_break: no such rewind point. Run action "preview" first. Known anchors: ${known}`);
			}
			if (target.turnsBack >= anchors.length) {
				throw new Error("chrono_break: refusing to rewind past the first user message; that would erase the original request.");
			}
			if (target.trailingMessages <= 1) {
				throw new Error("chrono_break: that anchor removes nothing beyond the pending call; pick an earlier turn.");
			}

			const marker = commitRewind(target.id, target.turnsBack, target.timestamp, target.index, reason);
			return {
				content: [
					{
						type: "text",
						text: `Rewound ${marker.turnsBack} turn(s): ${marker.droppedMessages} messages, ≈${formatTokens(marker.droppedTokens)} tokens removed.`,
					},
				],
				details: { action: "rewind", marker },
			};
		},
	});

	/**
	 * Manual cut: mount pi's own tree widget, then commit a real leaf move.
	 *
	 * This path is genuinely different from the tool's. `ctx.navigateTree` is
	 * only on the command context, and `agent-session.ts` throws
	 * "Wait for the current response to finish before navigating the session
	 * tree" while streaming, so the model can never take this route from inside
	 * a tool call. Here the leaf really moves and the abandoned turns leave the
	 * active branch, which is why no CutMarker is recorded for it.
	 *
	 * The control flow deliberately mirrors `showTreeSelector` in pi's
	 * interactive-mode: escape at the note step returns to the choice menu, and
	 * escape at the choice menu returns to the tree with the same row selected.
	 * Anything else makes this feel like a different program than `/tree`.
	 */
	type CommandCtx = Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1];

	type NoteOutcome = { mode: "frozen" | "llm"; reason: string } | "back" | "cancel";

	/** Choice menu plus note editor, looping the way pi's summary prompt does. */
	async function askForNote(ctx: CommandCtx): Promise<NoteOutcome> {
		for (;;) {
			const choice = await ctx.ui.select("Leave behind at the cut point:", ["Chrono-break note", "Pi branch summary"]);
			// Escape here goes back to the tree, exactly as escaping pi's
			// "Summarize branch?" menu re-opens the tree selector.
			if (choice === undefined) return "back";
			if (choice !== "Chrono-break note") return { mode: "llm", reason: "" };

			const typed = await ctx.ui.editor("Why is this path abandoned?");
			// Escape in the editor returns to the choice menu, not out of the flow.
			if (typed === undefined) continue;
			const clean = validateReason(typed);
			if (!clean) {
				ctx.ui.notify("chrono-break: reason too short, say what failed", "warning");
				continue;
			}
			return { mode: "frozen", reason: clean };
		}
	}

	async function manualCut(ctx: CommandCtx): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("chrono-break: /chrono cut needs the interactive TUI", "error");
			return;
		}
		await ctx.waitForIdle();

		const tree = ctx.sessionManager.getTree();
		if (tree.length === 0) {
			ctx.ui.notify("chrono-break: session has no entries to cut", "info");
			return;
		}

		const leafId = ctx.sessionManager.getLeafId();
		const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
		const filterMode = readTreeFilterMode(ctx.cwd, home, ctx.isProjectTrusted());
		let selectedId: string | undefined;

		for (;;) {
			// No overlay: pi's own selectors swap into the editor container, so
			// overlay:true is what made this float mid-screen instead of sitting
			// where /tree sits.
			const targetId = await ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) => {
				return new TreeSelectorComponent(
					tree,
					leafId,
					tui.terminal.rows,
					(entryId: string) => done(entryId),
					() => done(undefined),
					undefined,
					selectedId,
					filterMode,
				);
			});
			if (targetId === undefined) return;
			if (targetId === leafId) {
				ctx.ui.notify("chrono-break: already at this point", "info");
				return;
			}
			selectedId = targetId;

			const outcome = await askForNote(ctx);
			if (outcome === "cancel") return;
			if (outcome === "back") continue;

			const entriesLeft = ctx.sessionManager.getBranch(leafId ?? undefined).length;
			pendingCut = { targetId, reason: outcome.reason, mode: outcome.mode };
			try {
				const result = await ctx.navigateTree(targetId, { summarize: true, label: "chrono-break" });
				if (result.cancelled) {
					ctx.ui.notify("chrono-break: cut cancelled", "info");
					return;
				}
			} catch (error: unknown) {
				ctx.ui.notify(`chrono-break: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			} finally {
				pendingCut = undefined;
			}

			const record: ManualCutRecord = {
				targetId,
				reason: outcome.reason,
				mode: outcome.mode,
				entriesLeft,
				createdAt: Date.now(),
			};
			pi.appendEntry(MANUAL_ENTRY_TYPE, record);
			ctx.ui.notify("chrono-break: cut", "info");
			return;
		}
	}

	pi.registerCommand("chrono", {
		description: "Cut the session tree, or list, undo, and clear chrono-break rewinds",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "cut", label: "cut — pick a point in the tree and rewind to it" },
				{ value: "list", label: "list — show active rewinds" },
				{ value: "undo", label: "undo — restore the most recent rewind" },
				{ value: "clear", label: "clear — restore every rewind" },
			].filter((item) => item.value.startsWith(prefix));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const command = args.trim() || "list";

			if (command === "cut") {
				await manualCut(ctx);
				return;
			}

			if (command === "undo" || command === "clear") {
				if (markers.length === 0) {
					if (ctx.hasUI) ctx.ui.notify("chrono-break: nothing to restore", "info");
					return;
				}
				const removed = command === "clear" ? markers : markers.slice(-1);
				markers = command === "clear" ? [] : markers.slice(0, -1);
				for (const marker of removed) pi.appendEntry(UNDO_ENTRY_TYPE, { id: marker.id, reason: marker.reason });
				if (ctx.hasUI) ctx.ui.notify(`chrono-break: restored ${removed.length} rewind(s)`, "info");
				return;
			}

			if (markers.length === 0) {
				if (ctx.hasUI) ctx.ui.notify("chrono-break: no active rewinds", "info");
				return;
			}
			const lines = markers.map((marker) => {
				return `${marker.id}: ${marker.turnsBack} turn(s), ${marker.droppedMessages} msgs, ≈${formatTokens(marker.droppedTokens)} tok — ${marker.reason}`;
			});
			if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
