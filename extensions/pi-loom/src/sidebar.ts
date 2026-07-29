// Always-on right-rail overlay showing live workflow runs.
//
// The split-pane technique is adapted from pi-atelier
// (@extensions/michaelmjhhhh_pi-atelier/src/split-pane.ts, MIT): mount a
// non-capturing overlay anchored top-right, then wrap tui.render so the main
// UI lays out in terminalWidth - sidebarWidth columns. The main TUI never
// learns the sidebar exists; the overlay paints the strip that the narrower
// layout reserved. Atelier's mouse/keyboard resize machinery is deliberately
// dropped: this rail has a fixed width and hides itself on narrow terminals.

export const SIDEBAR_WIDTH = 42;
export const SIDEBAR_MIN_MAIN_WIDTH = 64;

interface SidebarTerminal { columns: number; rows: number }
export interface SidebarTui { render(width: number): string[]; requestRender(): void; terminal: SidebarTerminal }

export interface SidebarOverlayLayout {
  anchor: "top-right";
  width: number;
  maxHeight: "100%";
  margin: 0;
  nonCapturing: true;
  visible: (terminalWidth: number) => boolean;
}

type SidebarDone = (value: undefined) => void;
type SidebarComponent = { render(width: number): string[]; invalidate(): void };
type SidebarFactory = (tui: SidebarTui, theme: unknown, keybindings: unknown, done: SidebarDone) => SidebarComponent;
export type SidebarCustomUi = (factory: SidebarFactory, options: { overlay: true; overlayOptions: () => SidebarOverlayLayout }) => Promise<unknown>;

export interface WorkflowSidebarOptions {
  renderBody(width: number, height: number): string[];
  onError?(error: unknown): void;
  width?: number;
  minMainWidth?: number;
}

export interface WorkflowSidebar {
  mount(custom: SidebarCustomUi): void;
  refresh(): void;
  mounted(): boolean;
  dispose(): void;
}

const finiteInteger = (value: number, fallback: number): number => (Number.isFinite(value) ? Math.trunc(value) : fallback);
const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));

export function createWorkflowSidebar(options: WorkflowSidebarOptions): WorkflowSidebar {
  const width = clamp(finiteInteger(options.width ?? SIDEBAR_WIDTH, SIDEBAR_WIDTH), 20, 80);
  const minMain = Math.max(20, finiteInteger(options.minMainWidth ?? SIDEBAR_MIN_MAIN_WIDTH, SIDEBAR_MIN_MAIN_WIDTH));
  let tui: SidebarTui | undefined;
  let originalRender: SidebarTui["render"] | undefined;
  let wrappedRender: SidebarTui["render"] | undefined;
  let close: (() => void) | undefined;
  let active = false;
  let disposed = false;

  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Error reporting is best effort; the rail must never break the host.
    }
  };

  const visibleAt = (terminalWidth: number): boolean => active && Number.isFinite(terminalWidth) && terminalWidth >= minMain + width;

  const layout: SidebarOverlayLayout = {
    anchor: "top-right",
    width,
    maxHeight: "100%",
    margin: 0,
    nonCapturing: true,
    visible: visibleAt,
  };

  const detach = (): void => {
    // Restore only our own wrapper: a later wrapper (another split pane) may
    // have patched render after us, and clobbering it would drop their strip.
    if (tui && originalRender && tui.render === wrappedRender) tui.render = originalRender;
    const previous = tui;
    tui = undefined;
    originalRender = undefined;
    wrappedRender = undefined;
    previous?.requestRender();
  };

  const attach = (nextTui: SidebarTui): void => {
    if (tui === nextTui) return;
    detach();
    tui = nextTui;
    originalRender = nextTui.render;
    const previousRender = nextTui.render;
    wrappedRender = function (this: SidebarTui, terminalWidth: number): string[] {
      const reserved = visibleAt(terminalWidth) ? width : 0;
      try {
        return previousRender.call(nextTui, terminalWidth - reserved);
      } catch (error) {
        active = false;
        report(error);
        return previousRender.call(nextTui, terminalWidth);
      }
    };
    nextTui.render = wrappedRender;
    nextTui.requestRender();
  };

  const component = (activeTui: SidebarTui): SidebarComponent => ({
    render: (componentWidth: number): string[] => {
      try {
        return options.renderBody(componentWidth, Math.max(4, activeTui.terminal.rows));
      } catch (error) {
        report(error);
        return ["loom: sidebar render failed"];
      }
    },
    invalidate: () => undefined,
  });

  return {
    mount(custom: SidebarCustomUi): void {
      if (disposed || active || close !== undefined) return;
      active = true;
      let settle: Promise<unknown>;
      try {
        settle = custom(
          (nextTui, _theme, _keybindings, done) => {
            let closed = false;
            close = () => {
              if (closed) return;
              closed = true;
              done(undefined);
            };
            attach(nextTui);
            return component(nextTui);
          },
          { overlay: true, overlayOptions: () => layout },
        );
      } catch (error) {
        active = false;
        close = undefined;
        report(error);
        return;
      }
      void settle
        .catch((error: unknown) => report(error))
        .then(() => {
          active = false;
          close = undefined;
          detach();
        });
    },
    refresh(): void {
      tui?.requestRender();
    },
    mounted(): boolean {
      return active;
    },
    dispose(): void {
      disposed = true;
      active = false;
      const finish = close;
      close = undefined;
      try {
        finish?.();
      } catch (error) {
        report(error);
      }
      detach();
    },
  };
}
