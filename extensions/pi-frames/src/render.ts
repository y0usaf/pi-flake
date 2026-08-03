import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { frameComponent, type FrameDeps, type FrameState, type OutputBlockOptions } from "./frame";
import { callHeaderLine, resultLines } from "./format";
import { formatStatusIcon } from "./status";
import type { RenderDeps } from "./skin";
import { SPECS } from "./specs";
import type { Component } from "@earendil-works/pi-tui";

const renderDeps: RenderDeps = { keyHint, visibleWidth, truncateToWidth };
const frameDeps: FrameDeps = { visibleWidth, truncateToWidth, wrapTextWithAnsi };

export function renderCall(name: string, args: any, theme: Theme, context: any): Component | Text {
  try {
    if (SPECS[name]?.inline) {
      // Inline tools (find/ls) render the call as a plain text row; reuse the
      // context's last Text component when there is one (sibling pattern to
      // pi-hashline's read-tool renderCall). The line is prefixed with the
      // ASCII status icon (`[*]`/`[ok]`/`[!!]`) computed exactly like the
      // framed branch, so the call row still distinguishes state.
      const status: FrameState = context.isError ? "error" : context.isPartial || !context.executionStarted ? "pending" : "success";
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(`${formatStatusIcon(status, theme)} ${callHeaderLine(name, args, theme, renderDeps)}`);
      return text;
    }
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
        // Defer past the current updateDisplay pass: a synchronous invalidate
        // re-enters tool-execution's updateDisplay() from inside resultRenderer()
        // before this result component is added to the row container, leaving
        // [call2, result2, result1] — the result frame rendered twice. The
        // microtask rebuilds the row wholesale instead (sibling pattern to the
        // edit-tool double-render in pi issue #3830).
        queueMicrotask(() => context.invalidate?.());
      }
    }
    if (!options?.isPartial || context.isError) state.endedAt ??= Date.now();
    if (SPECS[name]?.inline) {
      // Inline tools (find/ls) return the bare tree rows as plain text with no
      // frame, no Output tee, and no bracketed footer. Error results still
      // render the full body; empty results render empty text.
      const lines = resultLines(name, result, context.expanded || options?.expanded, context.isError, state, theme, renderDeps, false);
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(lines.join("\n"));
      return text;
    }
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
