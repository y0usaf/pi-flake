import { constants } from "node:fs";
import { access as fsAccess, mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { applyEditsToRawContentPreservingLineEndings, buildChangedAnchorResponse, formatHashlineRegion, getVisibleLines, type RawEdit } from "../pi-hashline/src/hashline.js";
import { resolveMutationTargetPath, writeTextFileAtomically } from "../pi-hashline/src/fs-write.js";
import { resolveToCwd } from "../pi-hashline/src/path-utils.js";
import { isSupportedImageFile, loadTextFileWithSnapshot, normalizeToLF } from "../pi-hashline/src/text-file.js";

export type BridgeHandler = (payload: unknown, ctx: BridgeCtx) => Promise<unknown>;

export interface BridgeCtx {
  cwd: string;
  model: string;
  signal: AbortSignal;
  onUpdate?: (update: { content: { type: "text"; text: string }[]; details?: unknown }) => void;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Aborted");
}

/**
 * Same read preview formatting as pi-hashline's read tool: every returned line
 * is prefixed `LINEID|content` (hashline v3). Replicated locally to keep this
 * bridge independent of pi-hashline's tool registration layer.
 */
function formatHashlineReadPreview(
  text: string,
  options: { offset?: number; limit?: number },
): { text: string; nextOffset?: number } {
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
    ...(nextOffset !== undefined ? { nextOffset } : {}),
  };
}

async function checkReadable(absolutePath: string): Promise<void> {
  try {
    await fsAccess(absolutePath, constants.R_OK);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`File not found: ${absolutePath}`);
    if (code === "EACCES" || code === "EPERM") throw new Error(`File is not readable: ${absolutePath}`);
    throw new Error(`Cannot access file: ${absolutePath}`);
  }
}

async function checkWritable(absolutePath: string): Promise<void> {
  try {
    await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`File not found: ${absolutePath}`);
    if (code === "EACCES" || code === "EPERM") throw new Error(`File is not writable: ${absolutePath}`);
    throw new Error(`Cannot access file: ${absolutePath}`);
  }
}

export const readHandler: BridgeHandler = async (payload, ctx) => {
  const { path, offset, limit } = payload as { path: string; offset?: number; limit?: number };
  throwIfAborted(ctx.signal);

  const absolutePath = resolveToCwd(path, ctx.cwd);
  await checkReadable(absolutePath);

  // Images are delegated to the host's built-in read tool on the JS kernel side.
  // createReadTool's AgentTool.execute expects an ExtensionContext, which this
  // BridgeCtx cannot provide, so the model is told to use the host's read.
  if (await isSupportedImageFile(absolutePath)) {
    throw new Error(`[E_IMAGE] ${path} is an image. Use the host's built-in read tool to view it.`);
  }

  throwIfAborted(ctx.signal);
  const targetPath = await resolveMutationTargetPath(absolutePath);
  const file = await loadTextFileWithSnapshot(targetPath);
  const preview = formatHashlineReadPreview(file.text, { offset, limit });
  return preview.text;
};

export const editHandler: BridgeHandler = async (payload, ctx) => {
  const { path, edits } = payload as { path: string; edits: RawEdit[] };
  throwIfAborted(ctx.signal);

  const absolutePath = resolveToCwd(path, ctx.cwd);
  await checkWritable(absolutePath);

  const targetPath = await resolveMutationTargetPath(absolutePath);

  return withFileMutationQueue(targetPath, async () => {
    throwIfAborted(ctx.signal);
    const file = await loadTextFileWithSnapshot(targetPath);
    const resultRaw = applyEditsToRawContentPreservingLineEndings(file.rawText, edits, {
      defaultLineEnding: file.lineEnding,
    });
    const result = normalizeToLF(resultRaw);

    if (result === file.text) {
      return "No changes made. The requested edits produced identical content.";
    }

    throwIfAborted(ctx.signal);
    await writeTextFileAtomically(targetPath, file.bom + resultRaw, {
      expectedSnapshot: file.snapshot,
    });

    const response = buildChangedAnchorResponse(file.text, result, { maxBytes: DEFAULT_MAX_BYTES });
    return response.text;
  });
};

export const writeHandler: BridgeHandler = async (payload, ctx) => {
  const { path, content } = payload as { path: string; content: string };
  throwIfAborted(ctx.signal);

  const absolutePath = resolveToCwd(path, ctx.cwd);
  const targetPath = await resolveMutationTargetPath(absolutePath);

  return withFileMutationQueue(targetPath, async () => {
    throwIfAborted(ctx.signal);
    await fsMkdir(dirname(targetPath), { recursive: true });
    throwIfAborted(ctx.signal);
    await fsWriteFile(targetPath, content, "utf-8");
    return `Successfully wrote ${content.length} bytes to ${path}`;
  });
};
