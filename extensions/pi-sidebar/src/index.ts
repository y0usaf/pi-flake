/**
 * pi-sidebar — crush-style right-docked sidebar for Pi.
 *
 * Layout trick (adapted from pi-atelier, MIT): wrap tui.render so Pi renders
 * at (terminal width − sidebar width), and dock a non-capturing overlay on
 * the right edge. Events write into a session-scoped SidebarState; the
 * component renders from immutable snapshots only.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createSidebarComponent } from "./sidebar.js";
import { createSplitPaneController, type SplitPaneController } from "./split-pane.js";
import {
	MAX_RECENT_TOOLS,
	createInitialState,
	isFileMutatingTool,
	noteModifiedFile,
	shortenPath,
	toolHint,
	type SidebarSnapshot,
	type SidebarState,
} from "./state.js";

const ANIMATION_INTERVAL_MS = 500;

export default function (pi: ExtensionAPI) {
	let state: SidebarState | undefined;
	let split: SplitPaneController | undefined;
	let overlayVisible = false;
	let enabled = true;
	let generation = 0;
	let closeOverlay: (() => void) | undefined;
	let requestRender: (() => void) | undefined;
	let animationTimer: ReturnType<typeof setInterval> | undefined;
	let currentCtx: ExtensionContext | undefined;
	let branchRefreshAt = 0;

	const safely = (fn: () => void): void => {
		try {
			fn();
		} catch (error) {
			const ctx = currentCtx;
			if (ctx?.hasUI) {
				safelyNotify(ctx, error);
			}
		}
	};

	const safelyNotify = (ctx: ExtensionContext, error: unknown): void => {
		try {
			ctx.ui.notify(`pi-sidebar: ${error instanceof Error ? error.message : String(error)}`, "error");
		} catch {
			// Never let reporting escape the render path.
		}
	};

	const refresh = (): void => {
		requestRender?.();
	};

	const stopAnimation = (): void => {
		if (!animationTimer) return;
		clearInterval(animationTimer);
		animationTimer = undefined;
	};

	const syncAnimation = (): void => {
		const shouldAnimate = overlayVisible && (state?.runningTools.length ?? 0) > 0 && requestRender !== undefined;
		if (!shouldAnimate) {
			stopAnimation();
			return;
		}
		if (animationTimer) return;
		animationTimer = setInterval(() => {
			refresh();
		}, ANIMATION_INTERVAL_MS);
		animationTimer.unref?.();
	};

	const buildSnapshot = (): SidebarSnapshot => {
		const current = state ?? createInitialState(currentCtx?.cwd ?? process.cwd());
		const ctx = currentCtx;
		const usage = ctx?.getContextUsage();
		const cwd = current.cwd;
		return {
			...current,
			sessionName: pi.getSessionName() ?? current.sessionName,
			modelName: ctx?.model?.name ?? current.modelName,
			modelProvider: ctx?.model?.provider ?? current.modelProvider,
			thinkingLevel: pi.getThinkingLevel() ?? current.thinkingLevel,
			activeToolCount: safeCount(() => pi.getActiveTools().length),
			availableToolCount: safeCount(() => pi.getAllTools().length),
			projectName: cwd.split("/").filter(Boolean).pop() ?? cwd,
			contextTokens: usage?.tokens ?? null,
			contextWindow: usage?.contextWindow ?? 0,
			contextPercent: usage?.percent ?? null,
		};
	};

	const safeCount = (fn: () => number): number => {
		try {
			return fn();
		} catch {
			return 0;
		}
	};

	const refreshBranch = async (ctx: ExtensionContext, force = false): Promise<void> => {
		const now = Date.now();
		if (!force && now - branchRefreshAt < 15_000) return;
		branchRefreshAt = now;
		try {
			const result = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ctx.cwd });
			const branch = result.code === 0 ? result.stdout.trim() : undefined;
			if (state && branch && state.branch !== branch) {
				state.branch = branch;
				refresh();
			}
		} catch {
			// Not a git repo or git missing — leave branch unset.
		}
	};

	const hide = (): void => {
		if (!overlayVisible && !closeOverlay) return;
		overlayVisible = false;
		generation += 1;
		stopAnimation();
		const close = closeOverlay;
		closeOverlay = undefined;
		requestRender = undefined;
		if (close) safely(close);
		split?.hide();
	};

	const show = (ctx: ExtensionContext): void => {
		if (overlayVisible) return;
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			return;
		}
		overlayVisible = true;
		const currentGeneration = ++generation;
		split ??= createSplitPaneController({
			subscribeInput: (handler) => ctx.ui.onTerminalInput(handler),
			onResizeChange: () => refresh(),
			onError: (error) => safelyNotify(ctx, error),
		});
		split.show();

		const pending = ctx.ui.custom<void>(
			(tui: TUI, theme, _keybindings, done) => {
				let closed = false;
				const close = (): void => {
					if (closed) return;
					closed = true;
					done(undefined);
				};
				try {
					split?.attach(tui);
				} catch (error) {
					safelyNotify(ctx, error);
					overlayVisible = false;
					split?.hide();
					close();
					// Return a stub; the overlay closes immediately via done().
					return { render: () => [], invalidate: () => {} };
				}
				if (overlayVisible && generation === currentGeneration) {
					closeOverlay = close;
					requestRender = () => tui.requestRender();
					syncAnimation();
				} else {
					close();
				}
				return createSidebarComponent({
					getSnapshot: buildSnapshot,
					getHeight: () => tui.terminal.rows,
					theme,
				});
			},
			{
				overlay: true,
				overlayOptions: () =>
					split?.overlayOptions() ?? {
						anchor: "right-center",
						width: 32,
						maxHeight: "100%",
						nonCapturing: true,
					},
			},
		);
		void pending
			.catch((error: unknown) => {
				safelyNotify(ctx, error);
			})
			.finally(() => {
				closeOverlay = undefined;
				requestRender = undefined;
				stopAnimation();
				if (overlayVisible && generation === currentGeneration) {
					// Overlay closed underneath us (e.g. ui reset): hide the pane too.
					overlayVisible = false;
					split?.hide();
				}
			});
	};

	const toggle = (ctx: ExtensionContext): void => {
		if (overlayVisible) hide();
		else show(ctx);
	};

	pi.registerCommand("sidebar", {
		description: "Toggle the sidebar: /sidebar [on|off]",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("pi-sidebar requires TUI mode", "warning");
				return;
			}
			const action = args.trim().toLowerCase();
			if (action === "on") show(ctx);
			else if (action === "off") hide();
			else if (action === "" ) toggle(ctx);
			else ctx.ui.notify("Usage: /sidebar [on|off]", "warning");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		state = createInitialState(ctx.cwd);
		state.branch = undefined;
		if (ctx.mode === "tui" && ctx.hasUI) {
			if (enabled) show(ctx);
			void refreshBranch(ctx, true);
		}
	});

	pi.on("session_shutdown", () => {
		hide();
		split?.dispose();
		split = undefined;
		state = undefined;
		currentCtx = undefined;
	});

	pi.on("turn_start", (event) => {
		if (!state) return;
		state.activity = "running";
		state.turnIndex = event.turnIndex + 1;
		refresh();
		syncAnimation();
	});

	pi.on("turn_end", (event, ctx) => {
		if (!state) return;
		state.turnIndex = event.turnIndex + 1;
		void refreshBranch(ctx);
		refresh();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!state) return;
		state.activity = "idle";
		void refreshBranch(ctx);
		refresh();
		syncAnimation();
	});

	pi.on("tool_execution_start", (event) => {
		if (!state) return;
		const args = event.args as Record<string, unknown> | undefined;
		const rawPath = args?.path ?? args?.filePath ?? args?.file_path;
		const filePath = isFileMutatingTool(event.toolName) && typeof rawPath === "string" && rawPath.length > 0 ? rawPath : undefined;
		state.runningTools.push({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			hint: toolHint(event.toolName, event.args),
			...(filePath ? { filePath } : {}),
			startedAt: Date.now(),
		});
		refresh();
		syncAnimation();
	});

	pi.on("tool_execution_end", (event) => {
		if (!state) return;
		const index = state.runningTools.findIndex((t) => t.toolCallId === event.toolCallId);
		const run = index >= 0 ? state.runningTools[index] : undefined;
		const started = run?.startedAt ?? Date.now();
		if (index >= 0) state.runningTools.splice(index, 1);
		state.recentTools.unshift({
			toolName: event.toolName,
			hint: run?.hint,
			durationMs: Date.now() - started,
			isError: event.isError,
		});
		state.recentTools = state.recentTools.slice(0, MAX_RECENT_TOOLS);
		if (!event.isError && run?.filePath) {
			noteModifiedFile(state, run.filePath);
		}
		refresh();
		syncAnimation();
	});

	pi.on("message_end", (event) => {
		if (!state) return;
		const message = event.message;
		if (message.role !== "assistant") return;
		const usage = message.usage;
		if (!usage) return;
		state.totalInput += usage.input ?? 0;
		state.totalOutput += usage.output ?? 0;
		state.totalCacheRead += usage.cacheRead ?? 0;
		state.totalCacheWrite += usage.cacheWrite ?? 0;
		state.totalCost += usage.cost?.total ?? 0;
		refresh();
	});

	pi.on("model_select", () => refresh());
	pi.on("thinking_level_select", () => refresh());
	pi.on("session_info_changed", () => refresh());
}
