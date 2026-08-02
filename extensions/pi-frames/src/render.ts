import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { frameComponent, type FrameDeps, type FrameState, type OutputBlockOptions } from "./frame";
import { callHeaderLine, resultLines } from "./format";
import type { RenderDeps } from "./skin";
import type { Component } from "@earendil-works/pi-tui";

const renderDeps: RenderDeps = { keyHint, visibleWidth, truncateToWidth };
const frameDeps: FrameDeps = { visibleWidth, truncateToWidth, wrapTextWithAnsi };

export function renderCall(name: string, args: any, theme: Theme, context: any): Component | Text {
  try {
    const status: FrameState = context.isError ? "error" : context.isPartial || !context.executionStarted ? "pending" : "success";
    if (context.executionStarted) {
      const state = context.state ?? (context.state = {});
      if (state.startedAt === undefined) state.startedAt = Date.now();
    }
    const line = callHeaderLine(name, args, theme, renderDeps);
    const build = (width: number): OutputBlockOptions => ({
      state: status,
      sections: [{ lines: [line] }],
      width,
      // A pending call shows a thin closed box; once the result frame owns the
      // closure, drop the bottom bar so the pair doesn't double-close.
      bottomBar: context.state?.hasResult !== true,
    });
    return frameComponent(build, theme, frameDeps);
  } catch {
    return new Text(name, 0, 0);
  }
}

export function renderResult(name: string, result: any, options: any, theme: Theme, context: any): Component | Text {
  try {
    const state = context.state ?? (context.state = {});
    if (!state.hasResult) {
      state.hasResult = true;
      if (!state.invalidated) {
        state.invalidated = true;
        context.invalidate?.();
      }
    }
    if (!options?.isPartial || context.isError) state.endedAt ??= Date.now();
    const lines = resultLines(name, result, context.expanded || options?.expanded, context.isError, state, theme, renderDeps);
    // Empty output with no footer renders just the closing bottom bar.
    const sections = lines.length > 0 ? [{ label: "Output", lines }] : [];
    const build = (width: number): OutputBlockOptions => ({
      state: context.isError ? "error" : "success",
      sections,
      width,
      // The call slot already owns the plain top bar; this slot only emits the
      // labeled Output tee, the content rows, and the closing bottom bar for
      // one continuous box.
      topBar: false,
    });
    return frameComponent(build, theme, frameDeps);
  } catch {
    return new Text(name, 0, 0);
  }
}
