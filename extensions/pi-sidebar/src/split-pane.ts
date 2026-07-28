/**
 * Split-pane controller: narrows Pi's own render and docks an overlay panel
 * on the right edge, crush-style.
 *
 * Adapted from pi-atelier's src/split-pane.ts (MIT, © 2026 Michael,
 * @extensions/michaelmjhhhh_pi-atelier/). Trimmed to the sidebar use case:
 * render-wrap + right-docked overlay + divider drag-resize.
 */

import { matchesKey } from "@earendil-works/pi-tui";
import type { OverlayOptions, TUI } from "@earendil-works/pi-tui";

const ENABLE_MOUSE = "[?1002h[?1006h";
const DISABLE_MOUSE = "[?1006l[?1002l";
const SGR_MOUSE = /^<(\d+);(\d+);(\d+)([Mm])$/;

export interface SgrMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
	motion: boolean;
}

export function parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
	const match = data.match(SGR_MOUSE);
	if (!match) return undefined;
	const button = Number(match[1]);
	const x = Number(match[2]);
	const y = Number(match[3]);
	if (![button, x, y].every(Number.isFinite) || x < 1 || y < 1) return undefined;
	return { button, x, y, release: match[4] === "m", motion: (button & 32) !== 0 };
}

export const DEFAULT_SIDEBAR_WIDTH = 32;
export const MIN_SIDEBAR_WIDTH = 24;
export const MAX_SIDEBAR_WIDTH = 72;
export const MIN_MAIN_WIDTH = 64;

type RenderFunction = TUI["render"];

export interface SplitPaneControllerOptions {
	defaultSidebarWidth?: number;
	minSidebarWidth?: number;
	maxSidebarWidth?: number;
	minMainWidth?: number;
	onError?(error: unknown): void;
	subscribeInput?(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
	onResizeChange?(resizing: boolean): void;
}

export interface SplitPaneController {
	attach(tui: TUI): void;
	show(): void;
	hide(): void;
	setSidebarWidth(width: number): void;
	getSidebarWidth(): number;
	isEnabled(): boolean;
	isVisibleAtWidth(terminalWidth: number): boolean;
	isResizing(): boolean;
	overlayOptions(): OverlayOptions;
	requestRender(): void;
	dispose(): void;
}

const finiteInteger = (value: number, fallback: number): number =>
	Number.isFinite(value) ? Math.trunc(value) : fallback;

const clamp = (value: number, minimum: number, maximum: number): number =>
	Math.min(maximum, Math.max(minimum, value));

export function createSplitPaneController(options: SplitPaneControllerOptions = {}): SplitPaneController {
	const minimumSidebar = Math.max(1, finiteInteger(options.minSidebarWidth ?? MIN_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH));
	const maximumSidebar = Math.max(
		minimumSidebar,
		finiteInteger(options.maxSidebarWidth ?? MAX_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
	);
	const minimumMain = Math.max(1, finiteInteger(options.minMainWidth ?? MIN_MAIN_WIDTH, MIN_MAIN_WIDTH));
	let sidebarWidth = clamp(
		finiteInteger(options.defaultSidebarWidth ?? DEFAULT_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH),
		minimumSidebar,
		maximumSidebar,
	);

	let tui: TUI | undefined;
	let originalRender: RenderFunction | undefined;
	let wrappedRender: RenderFunction | undefined;
	let unsubscribeInput: (() => void) | undefined;
	let enabled = false;
	let dragging = false;
	let disposed = false;

	const safely = (fn: () => void): boolean => {
		try {
			fn();
			return true;
		} catch (error) {
			safelyReport(error);
			return false;
		}
	};

	const safelyReport = (error: unknown): void => {
		try {
			options.onError?.(error);
		} catch {
			// Never let error reporting escape the render path.
		}
	};

	const requestRender = (): void => {
		if (!tui) return;
		safely(() => tui?.requestRender());
	};

	const visibleAt = (terminalWidth: number): boolean => terminalWidth >= minimumMain + minimumSidebar;

	const effectiveSidebarWidth = (terminalWidth: number): number => {
		if (!enabled || !visibleAt(terminalWidth)) return 0;
		const effectiveMax = Math.min(maximumSidebar, terminalWidth - minimumMain);
		return clamp(sidebarWidth, minimumSidebar, Math.max(minimumSidebar, effectiveMax));
	};

	const stopResize = (cancel: boolean): void => {
		if (!dragging) return;
		dragging = false;
		if (cancel) {
			// Drag updates apply live; cancel just ends the gesture.
		}
		safely(() => options.onResizeChange?.(false));
		if (tui) safely(() => tui?.terminal.write(DISABLE_MOUSE));
	};

	const beginDrag = (): void => {
		if (dragging || !tui) return;
		dragging = true;
		safely(() => tui?.terminal.write(ENABLE_MOUSE));
		safely(() => options.onResizeChange?.(true));
	};

	const reconcileResizeWidth = (terminalWidth: number): void => {
		const effectiveMax = Math.min(maximumSidebar, terminalWidth - minimumMain);
		sidebarWidth = clamp(sidebarWidth, minimumSidebar, Math.max(minimumSidebar, effectiveMax));
	};

	const attach = (nextTui: TUI): void => {
		if (disposed) throw new Error("Cannot attach a disposed split pane");
		if (tui === nextTui) return;
		if (tui) throw new Error("Split pane is already attached to another TUI");
		tui = nextTui;
		originalRender = nextTui.render;
		const previousRender = nextTui.render;
		wrappedRender = function (this: TUI, terminalWidth: number): string[] {
			reconcileResizeWidth(terminalWidth);
			const reserved = effectiveSidebarWidth(terminalWidth);
			try {
				return previousRender.call(nextTui, terminalWidth - reserved);
			} catch (error) {
				stopResize(true);
				enabled = false;
				safely(() => options.onError?.(error));
				return previousRender.call(nextTui, terminalWidth);
			}
		};
		nextTui.render = wrappedRender;

		if (options.subscribeInput) {
			unsubscribeInput = options.subscribeInput(handleInput);
		}
		requestRender();
	};

	const handleInput = (data: string): { consume?: boolean; data?: string } | undefined => {
		if (!enabled) return undefined;
		const mouse = parseSgrMouseEvent(data);
		if (mouse) {
			if (mouse.release) {
				stopResize(false);
				return { consume: true };
			}
			if (!mouse.motion && (mouse.button & 3) === 0 && (mouse.button & 64) === 0) {
				const dividerX = (tui?.terminal.columns ?? 0) - effectiveSidebarWidth(tui?.terminal.columns ?? 0);
				if (Math.abs(mouse.x - dividerX) <= 1) beginDrag();
				return { consume: true };
			}
			if (mouse.motion && dragging && tui) {
				const proposed = tui.terminal.columns - mouse.x + 1;
				const effectiveMax = Math.min(maximumSidebar, tui.terminal.columns - minimumMain);
				sidebarWidth = clamp(proposed, minimumSidebar, Math.max(minimumSidebar, effectiveMax));
				requestRender();
			}
			return { consume: true };
		}
		if (dragging) {
			if (matchesKey(data, "left")) {
				setSidebarWidthInternal(sidebarWidth + 1);
				return { consume: true };
			}
			if (matchesKey(data, "right")) {
				setSidebarWidthInternal(sidebarWidth - 1);
				return { consume: true };
			}
			if (matchesKey(data, "enter")) {
				stopResize(false);
				return { consume: true };
			}
			if (matchesKey(data, "escape")) {
				stopResize(true);
				return { consume: true };
			}
		}
		return undefined;
	};

	const setSidebarWidthInternal = (width: number): void => {
		const next = clamp(finiteInteger(width, sidebarWidth), minimumSidebar, maximumSidebar);
		if (next === sidebarWidth) return;
		sidebarWidth = next;
		requestRender();
	};

	const controller: SplitPaneController = {
		attach,
		show() {
			if (disposed || enabled) return;
			enabled = true;
			requestRender();
		},
		hide() {
			stopResize(true);
			if (!enabled) return;
			enabled = false;
			requestRender();
		},
		setSidebarWidth: setSidebarWidthInternal,
		getSidebarWidth: () => sidebarWidth,
		isEnabled: () => enabled,
		isVisibleAtWidth: visibleAt,
		isResizing: () => dragging,
		overlayOptions(): OverlayOptions {
			const columns = tui?.terminal.columns ?? 0;
			return {
				anchor: "right-center",
				width: effectiveSidebarWidth(columns) || sidebarWidth,
				maxHeight: "100%",
				nonCapturing: true,
				visible: (termWidth) => enabled && visibleAt(termWidth),
			};
		},
		requestRender,
		dispose() {
			if (disposed) return;
			disposed = true;
			stopResize(true);
			enabled = false;
			unsubscribeInput?.();
			unsubscribeInput = undefined;
			if (tui && originalRender && wrappedRender && tui.render === wrappedRender) {
				tui.render = originalRender;
			}
			tui = undefined;
			originalRender = undefined;
			wrappedRender = undefined;
		},
	};

	return controller;
}
