import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import {
  createReadTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { frameComponent, type FrameDeps, type OutputBlockOptions } from "../../shared/frame";
import { resolveMutationTargetPath } from "./fs-write";
import { formatHashlineRegion, getVisibleLines } from "./hashline";
import { resolveToCwd } from "./path-utils";
import { throwIfAborted } from "./runtime";
import { isSupportedImageFile, loadTextFileWithSnapshot } from "./text-file";

function formatHashlineReadPreview(
  text: string,
  options: { offset?: number; limit?: number },
): { text: string; truncation?: ReturnType<typeof truncateHead>; nextOffset?: number } {
  const allLines = getVisibleLines(text);
  const totalLines = allLines.length;
  const startLine = options.offset ?? 1;

  if (totalLines === 0) {
    return {
      text: startLine === 1
        ? "File is empty. Use edit with prepend or append and omit pos to insert content."
        : `Offset ${startLine} is beyond end of file (0 lines total). The file is empty.`,
    };
  }

  if (startLine > totalLines) {
    return {
      text: `Offset ${startLine} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`,
    };
  }

  const limit = options.limit;
  const endIndex = limit ? Math.min(startLine - 1 + limit, totalLines) : totalLines;
  const selected = allLines.slice(startLine - 1, endIndex);
  const formatted = formatHashlineRegion(selected, startLine);
  const truncation = truncateHead(formatted);

  if (truncation.firstLineExceedsLimit) {
    return {
      text: `[Line ${startLine} exceeds ${formatSize(truncation.maxBytes)}. Hashline output requires full lines; cannot compute hashes for a truncated preview.]`,
      truncation,
    };
  }

  let preview = truncation.content;
  let nextOffset: number | undefined;

  if (truncation.truncated) {
    const endLineDisplay = startLine + truncation.outputLines - 1;
    nextOffset = endLineDisplay + 1;
    preview += truncation.truncatedBy === "lines"
      ? `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${totalLines}. Use offset=${nextOffset} to continue.]`
      : `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${totalLines} (${formatSize(truncation.maxBytes)} limit). Use offset=${nextOffset} to continue.]`;
  } else if (endIndex < totalLines) {
    nextOffset = endIndex + 1;
    preview += `\n\n[Showing lines ${startLine}-${endIndex} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
  }

  return {
    text: preview,
    ...(truncation.truncated ? { truncation } : {}),
    ...(nextOffset !== undefined ? { nextOffset } : {}),
  };
}

const frameDeps: FrameDeps = { visibleWidth, truncateToWidth, wrapTextWithAnsi };

export function registerReadTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read",
    // Flush-edged frame needs it (pi-frames DESIGN lock 2026-08-01; without it
    // the box edges don't sit flush).
    renderShell: "self",
    label: "Read",
    description: `Read a UTF-8 text file. Every returned line is prefixed as LINEID|content (hashline v3). LINEID is line number plus a four-letter, two-bigram content hash. Copy current LINEID anchors into edit. Output is capped at ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Supported images are delegated to Pi's built-in read tool.`,
    promptSnippet: "Read files with strict hashline v3 LINEID anchors for edit.",
    promptGuidelines: [
      "Use read before edit so you can copy current full LINEID anchors exactly (e.g. 160sray). Hashline v2 anchors are rejected.",
      "When read output is truncated, continue with the suggested offset before editing unseen lines.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" })),
    }),

    renderCall(args, theme, context) {
      try {
        const path = typeof args?.path === "string" ? args.path : "...";
        const status = context.isError ? "error" : context.isPartial || !context.executionStarted ? "pending" : "success";
        const line = `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", path)}`;
        const build = (width: number): OutputBlockOptions => ({
          state: status,
          sections: [{ lines: [line] }],
          width,
          // A pending call shows a thin closed box; once the result frame owns
          // the closure, drop the bottom bar so the pair doesn't double-close.
          bottomBar: context.state?.hasResult !== true,
        });
        return frameComponent(build, theme, frameDeps);
      } catch {
        return new Text("read", 0, 0);
      }
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      try {
        const state = context.state ?? (context.state = {});
        if (!state.hasResult) {
          state.hasResult = true;
          if (!state.invalidated) {
            state.invalidated = true;
            // Defer past the current updateDisplay pass: a synchronous
            // invalidate re-enters tool-execution's updateDisplay() from inside
            // resultRenderer() before this result component is added to the row
            // container, leaving [call2, result2, result1] — the result frame
            // rendered twice. The microtask rebuilds the row wholesale instead
            // (sibling pattern to the edit-tool double-render in pi issue
            // #3830).
            queueMicrotask(() => context.invalidate?.());
          }
        }
        if (isPartial) {
          return new Text(theme.fg("warning", "Reading..."), 0, 0);
        }
        // Collapsed rows render nothing, matching Pi's built-in read tool. The
        // hashline body is a whole file region; printing it in every collapsed
        // row floods the transcript. Errors always render.
        if (!expanded && !context.isError) {
          return new Text("", 0, 0);
        }
        const bodyLines = result.content
          ?.flatMap((entry) => (entry.type === "text" ? entry.text ?? "" : "[attachment]").split("\n")) ?? [];
        const build = (width: number): OutputBlockOptions => ({
          state: context.isError ? "error" : "success",
          sections: [{ label: "Output", lines: bodyLines }],
          width,
          // The call slot already owns the plain top bar; this slot only emits
          // the labeled Output tee, the content rows, and the closing bottom
          // bar for one continuous box.
          topBar: false,
          bottomBar: true,
          // hashline lines are exact copy targets (LINEID|content); trimming
          // would silently diverge the displayed line from the hashed content.
          trimEndContent: false,
        });
        return frameComponent(build, theme, frameDeps);
      } catch {
        return new Text("read", 0, 0);
      }
    },

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const path = params.path;
      const absolutePath = resolveToCwd(path, ctx.cwd);
      throwIfAborted(signal);

      try {
        await fsAccess(absolutePath, constants.R_OK);
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") throw new Error(`File not found: ${path}`);
        if (code === "EACCES" || code === "EPERM") throw new Error(`File is not readable: ${path}`);
        throw new Error(`Cannot access file: ${path}`);
      }

      if (await isSupportedImageFile(absolutePath)) {
        return createReadTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
      }

      throwIfAborted(signal);
      const targetPath = await resolveMutationTargetPath(absolutePath);
      const file = await loadTextFileWithSnapshot(targetPath);
      const preview = formatHashlineReadPreview(file.text, {
        offset: params.offset,
        limit: params.limit,
      });

      return {
        content: [{ type: "text", text: preview.text }],
        details: {
          snapshotId: file.snapshot.snapshotId,
          ...(preview.truncation ? { truncation: preview.truncation } : {}),
          ...(preview.nextOffset !== undefined ? { nextOffset: preview.nextOffset } : {}),
        },
      };
    },
  });
}
