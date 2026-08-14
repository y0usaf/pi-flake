/**
 * Hashline edit tool -- dual input mode.
 *
 * Mode A (anchor):  {path, edits} -- hashline's native JSON format with LINEID anchors
 * Mode B (script):  {text}        -- row-script format (@REPLACE 103heah, @INS.BEFORE, etc.)
 *                                   or patch format (*** Begin Patch ...)
 *
 * Both modes feed into hashline's anchor validator and atomic write flow.
 * Row-script formulas without LINEID anchors are rejected.
 * Use anchors from read output.
 */


import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import {
  DEFAULT_MAX_BYTES,
  generateDiffString,
  generateUnifiedPatch,
  renderDiff,
  withFileMutationQueue,
  defineTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { resolveMutationTargetPath, writeTextFileAtomically } from "./fs-write";
import {
  applyEditsToRawContentPreservingLineEndings,
  buildChangedAnchorResponse,
  computeEditLineMetrics,
  type EditRequest,
  type RawEdit,
} from "./hashline";
import { resolveToCwd } from "./path-utils";
import { throwIfAborted } from "./runtime";
import { loadTextFileWithSnapshot, normalizeToLF } from "./text-file";
import { isRecord, prepareEditArguments } from "./edit-shapes";
import { rowScriptToEdits, validateRowAnchors, isPatch, parsePatchText } from "./row-script";

// ---------------------------------------------------------------------------
// Schema — accepts both shapes
// ---------------------------------------------------------------------------

const anchorContentSchema = Type.Union([
  Type.Array(Type.String()),
  Type.String(),
  Type.Null(),
]);

const anchorLocSchema = Type.Union([
  Type.Literal("append"),
  Type.Literal("prepend"),
  Type.Object({ append: Type.String() }, { additionalProperties: false }),
  Type.Object({ prepend: Type.String() }, { additionalProperties: false }),
  Type.Object({
    range: Type.Object({
      pos: Type.String(),
      end: Type.String(),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
]);

const anchorEditItemSchema = Type.Union([
  Type.Object({ loc: anchorLocSchema, content: anchorContentSchema }, { additionalProperties: false }),
  Type.Object({ oldText: Type.String(), newText: Type.String() }, { additionalProperties: false }),
]);

const anchorEditSchema = Type.Object({
  path: Type.String(),
  edits: Type.Array(anchorEditItemSchema, { minItems: 1 }),
}, { additionalProperties: false });

const scriptSchema = Type.Object({
  text: Type.String(),
}, { additionalProperties: false });

// Accept either {text} or {path, edits}
const toolParamsSchema = Type.Union([scriptSchema, anchorEditSchema]);

// ---------------------------------------------------------------------------
// prepareArguments
// ---------------------------------------------------------------------------

/**
 * Classify raw args into an internal shape tagged with a kind switch. Used by
 * renderCall/renderResult/execute, which re-derive the mode from whatever the
 * host passes in (raw or prepared). Not suitable for `prepareArguments` — see
 * prepareSchemaValidArgs.
 */
function prepareEditParams(args: unknown): { kind: "anchor" | "script"; path?: string; edits?: RawEdit[]; text?: string } {
  if (!isRecord(args)) return { kind: "script", text: "" };

  // Script mode: has a 'text' key with a string value
  if (typeof args.text === "string") {
    return { kind: "script", text: args.text };
  }

  // Anchor mode: has 'path' and 'edits'
  // Normalize via edit-shapes first
  const normalized = prepareEditArguments(args);
  if (isRecord(normalized) && typeof normalized.path === "string" && Array.isArray(normalized.edits)) {
    return {
      kind: "anchor",
      path: normalized.path,
      edits: normalized.edits,
    };
  }

  // Fallback: try anchor shape
  if ("path" in args || "oldText" in args || "old_text" in args) {
    const n = prepareEditArguments(args);
    return {
      kind: "anchor",
      path: isRecord(n) && typeof n.path === "string" ? n.path : "...",
      edits: isRecord(n) && Array.isArray(n.edits) ? n.edits : [],
    };
  }

  // Last resort: empty anchor
  return { kind: "anchor", path: "...", edits: [] };
}

/**
 * Schema-valid `prepareArguments`: strips the internal `kind` tag so the
 * returned object matches the tool schema (which forbids additional top-level
 * properties). Pi validates the result of prepareArguments against the schema
 * before dispatching to execute, so leaking `kind` here made edits fail.
 */
function prepareSchemaValidArgs(args: unknown): unknown {
  const prepared = prepareEditParams(args);
  if (prepared.kind === "script") {
    return { text: prepared.text ?? "" };
  }
  return { path: prepared.path ?? "...", edits: prepared.edits ?? [] };
}

// ---------------------------------------------------------------------------
// Row-script → anchor edits converter
// ---------------------------------------------------------------------------

async function convertRowScriptToHashes(
  text: string,
  ctx: { cwd: string },
): Promise<EditRequest[]> {
  if (isPatch(text)) {
    // Patch → oldText/newText pairs
    const pairs = parsePatchText(text);
    return pairs.map(p => ({
      path: p.path,
      edits: [{ oldText: p.oldText, newText: p.newText }],
    }));
  }

  const parsed = rowScriptToEdits(text);

  if (parsed.hasUnsupported) {
    throw new Error(
      "Row script contains content-matching operations without LINEID anchors. " +
      "Add a LINEID anchor from current read output (e.g. @REPLACE 103heah), or use anchor-based ops only.",
    );
  }

  if (parsed.edits.length === 0) {
    throw new Error(
      "Row script has no anchor-based operations. Use LINEID anchors " +
      "(e.g. @REPLACE LINEID) for anchor-based edits.",
    );
  }

  // Validate LINEID anchors against file content
  await validateRowAnchors(parsed.edits, ctx.cwd);

  // Group by path → hashline EditRequest shape
  const byPath = new Map<string, Array<{ loc: any; content: string[] | null }>>();

  for (const e of parsed.edits) {
    const arr = byPath.get(e.path) ?? [];
    arr.push({ loc: e.loc, content: e.content });
    byPath.set(e.path, arr);
  }

  return Array.from(byPath, ([path, edits]) => ({ path, edits }));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerEditTool(pi: ExtensionAPI): void {
  const def = defineTool({
    name: "edit",
    label: "Edit",
    description: [
      "Patch UTF-8 text files using LINEID anchors from read output or row scripts.",
      "",
      "Mode A — LINEID anchor edits (preferred):",
      '  { "path": "src/main.ts", "edits": [{ "loc": { "range": { "pos": "103heah", "end": "105mno" } }, "content": ["new"] }] }',
      "  loc: \"append\", \"prepend\", {append:LINEID}, {prepend:LINEID}, {range:{pos,end}}.",
      "  content: literal lines (string/string[]) or null to delete.",
      "",
      "Mode B — Row script (text):",
      "  [path/to/file]",
      "  @REPLACE 103heah-105mno",
      "  +replacement content",
      "  @INS.BEFORE 103heah",
      "  +inserted content",
      "  @INS.AFTER 103heah",
      "  +inserted content",
      "  @DEL 103heah-105mno",
      "  @APPEND",
      "  +content",
      "",
      "  LINEID anchors from current read output. Row scripts must use LINEID",
      "  anchors from read output. Content-matching rows are not accepted.",
    ].join("\n"),
    promptGuidelines: [
      "Use read before edit to get current LINEID anchors (e.g. 160sray).",
      "For JSON: use {loc,content} format. For row scripts: use @REPLACE LINEID, @INS.BEFORE LINEID, etc.",
      "Stale anchors (content changed since read) fail with retry options. Read again to refresh.",
    ],
    parameters: toolParamsSchema,
    prepareArguments: prepareSchemaValidArgs,
    renderShell: "default",

    renderCall(args, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const prepared = prepareEditParams(args);
      let label = "";

      switch (prepared.kind) {
        case "anchor": {
          const path = prepared.path ?? "...";
          const count = Array.isArray(prepared.edits) ? prepared.edits.length : 0;
          const suffix = count > 0 ? theme.fg("muted", ` (${count} edit${count === 1 ? "" : "s"})`) : "";
          label = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path)}${suffix}`;
          break;
        }
        case "script": {
          const raw = prepared.text ?? "";
          const lines = raw.split("\n").length;
          const firstFile = raw.match(/^\s*\[([^\]]+)\]\s*$/m);
          const path = firstFile ? firstFile[1] : "";
          const loc = path ? theme.fg("accent", path) : "";
          const suffix = theme.fg("muted", ` (script, ${lines} lines)`);
          label = `${theme.fg("toolTitle", theme.bold("edit"))} ${loc}${suffix}`;
          break;
        }
      }

      text.setText(label);
      return text;
    },

    renderResult(result, { isPartial }, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      if (isPartial) {
        text.setText(theme.fg("warning", "Editing..."));
        return text;
      }

      const body = result.content
        ?.map((e: any) => e.type === "text" ? e.text ?? "" : "")
        .filter((s: string) => s.length > 0)
        .join("\n") ?? "";
      const details = isRecord(result.details) ? result.details : undefined;
      const diff = details && typeof details.diff === "string" ? details.diff : "";
      if (!context.isError && diff) {
        text.setText(renderDiff(diff));
        return text;
      }

      text.setText(context.isError ? theme.fg("error", body) : body);
      return text;
    },

    // -----------------------------------------------------------------------
    // execute — the main branching point
    // -----------------------------------------------------------------------

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const prepared = prepareEditParams(params);

      if (prepared.kind === "script") {
        // Convert row-script to hashline edits, then apply via hashline flow
        const fileRequests = await convertRowScriptToHashes(prepared.text, ctx);

        if (fileRequests.length === 0) {
          return {
            content: [{ type: "text", text: "Row script produced no anchor-based edits." }],
            details: { classification: "noop", diff: "", patch: "" },
          };
        }

        // Apply each file edit through hashline's pipeline
        const results: Array<{
          path: string;
          diff: string;
          patch: string;
          firstChangedLine?: number;
          anchorText: string;
          metrics: { added_lines: number; removed_lines: number };
        }> = [];

        for (const req of fileRequests) {
          throwIfAborted(signal);
          const absolutePath = resolveToCwd(req.path, ctx.cwd);

          try {
            await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
          } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "ENOENT") throw new Error(`File not found: ${req.path}`);
            throw new Error(`Cannot access: ${req.path}`);
          }

          const targetPath = await resolveMutationTargetPath(absolutePath);
          const fileResult = await withFileMutationQueue(targetPath, async () => {
            throwIfAborted(signal);
            const file = await loadTextFileWithSnapshot(targetPath);
            const resultRaw = applyEditsToRawContentPreservingLineEndings(file.rawText, req.edits, {
              defaultLineEnding: file.lineEnding,
            });
            const result = normalizeToLF(resultRaw);

            if (result === file.text) {
              return null;
            }

            throwIfAborted(signal);
            const updatedSnapshot = await writeTextFileAtomically(targetPath, file.bom + resultRaw, {
              expectedSnapshot: file.snapshot,
            });

            const response = buildChangedAnchorResponse(file.text, result, { maxBytes: DEFAULT_MAX_BYTES });
            const metrics = computeEditLineMetrics(file.text, req.edits);
            const diffResult = generateDiffString(file.text, result);
            const patch = generateUnifiedPatch(req.path, file.text, result);
            return {
              path: req.path,
              diff: diffResult.diff,
              patch,
              firstChangedLine: diffResult.firstChangedLine ?? response.firstChangedLine,
              anchorText: response.text,
              metrics: {
                edits_attempted: req.edits.length,
                added_lines: metrics.addedLines,
                removed_lines: metrics.removeLines,
              },
            };
          });

          if (fileResult) results.push(fileResult);
        }

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No changes made. The requested edits produced identical content." }],
            details: { classification: "noop", diff: "", patch: "" },
          };
        }

        const summary = results.length === 1
          ? `Edited ${results[0].path}.`
          : `Edited ${results.length} files:\n${results.map(r => `- ${r.path}`).join("\n")}`;

        const combinedDiff = results.length === 1
          ? results[0].diff
          : results.map(r => `File: ${r.path}\n${r.diff}`).join("\n\n");
        const combinedPatch = results.map(r => r.patch).join("\n");
        const firstChangedLine = results.find(r => r.firstChangedLine != null)?.firstChangedLine;

        return {
          content: [
            { type: "text", text: summary },
            { type: "text", text: results.length === 1 ? results[0].anchorText : "" },
          ],
          details: {
            diff: combinedDiff,
            patch: combinedPatch,
            firstChangedLine,
            text: results.length <= 1 ? combinedDiff : undefined, // for rendering
          },
        };
      }

      // ----------------------------------------------------
      // Anchor mode (existing hashline flow)
      // ----------------------------------------------------
      const { path, edits } = prepared as { path: string; edits: RawEdit[] };
      const absolutePath = resolveToCwd(path, ctx.cwd);

      try {
        await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") throw new Error(`File not found: ${path}`);
        if (code === "EACCES" || code === "EPERM") throw new Error(`File is not writable: ${path}`);
        throw new Error(`Cannot access file: ${path}`);
      }

      const targetPath = await resolveMutationTargetPath(absolutePath);
      return withFileMutationQueue(targetPath, async () => {
        throwIfAborted(signal);
        const file = await loadTextFileWithSnapshot(targetPath);
        const resultRaw = applyEditsToRawContentPreservingLineEndings(file.rawText, edits, {
          defaultLineEnding: file.lineEnding,
        });
        const result = normalizeToLF(resultRaw);

        if (result === file.text) {
          return {
            content: [{ type: "text", text: "No changes made. The requested edits produced identical content." }],
            details: { classification: "noop", snapshotId: file.snapshot.snapshotId, diff: "", patch: "" },
          };
        }

        throwIfAborted(signal);
        const updatedSnapshot = await writeTextFileAtomically(targetPath, file.bom + resultRaw, {
          expectedSnapshot: file.snapshot,
        });

        const response = buildChangedAnchorResponse(file.text, result, { maxBytes: DEFAULT_MAX_BYTES });
        const metrics = computeEditLineMetrics(file.text, edits);
        const diffResult = generateDiffString(file.text, result);
        const patch = generateUnifiedPatch(path, file.text, result);
        return {
          content: [{ type: "text", text: response.text }],
          details: {
            diff: diffResult.diff,
            patch,
            firstChangedLine: diffResult.firstChangedLine ?? response.firstChangedLine,
            snapshotId: updatedSnapshot.snapshotId,
            metrics: {
              edits_attempted: edits.length,
              added_lines: metrics.addedLines,
              removed_lines: metrics.removedLines,
            },
          },
        };
      });
    },
  });
  pi.registerTool(def);
}
