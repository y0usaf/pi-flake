import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import {
  DEFAULT_MAX_BYTES,
  generateDiffString,
  generateUnifiedPatch,
  renderDiff,
  withFileMutationQueue,
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
} from "./hashline";
import { resolveToCwd } from "./path-utils";
import { throwIfAborted } from "./runtime";
import { loadTextFileWithSnapshot, normalizeToLF } from "./text-file";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LEGACY_EDIT_KEYS = new Set(["op", "pos", "end", "lines", "oldText", "newText"]);

/**
 * Map one legacy edit entry (op/pos/end/lines, or op "replace_text") onto the
 * strict v3 shapes before schema validation, per Pi's prepareArguments
 * guidance. Anything unrecognized passes through for the schema to reject.
 */
function normalizeLegacyEdit(entry: unknown): unknown {
  if (!isRecord(entry) || "loc" in entry || "content" in entry) return entry;
  if (Object.keys(entry).some((key) => !LEGACY_EDIT_KEYS.has(key))) return entry;

  const { op, pos, end, lines, oldText, newText } = entry;
  if (op === "replace_text") {
    return typeof oldText === "string" && typeof newText === "string" &&
      pos === undefined && end === undefined && lines === undefined
      ? { oldText, newText }
      : entry;
  }
  if (oldText !== undefined || newText !== undefined || lines === undefined) return entry;

  if (op === "replace" && typeof pos === "string" && (end === undefined || typeof end === "string")) {
    return { loc: { range: { pos, end: end ?? pos } }, content: lines };
  }
  if ((op === "append" || op === "prepend") && end === undefined) {
    if (pos === undefined) return { loc: op, content: lines };
    if (typeof pos === "string") {
      return { loc: op === "append" ? { append: pos } : { prepend: pos }, content: lines };
    }
  }
  return entry;
}

function prepareEditArguments(args: unknown): unknown {
  if (!isRecord(args) || typeof args.path !== "string") return args;

  if (Array.isArray(args.edits)) {
    return { ...args, edits: args.edits.map(normalizeLegacyEdit) };
  }

  const oldText = args.oldText ?? args.old_text;
  const newText = args.newText ?? args.new_text;
  if (typeof oldText === "string" && typeof newText === "string") {
    return { path: args.path, edits: [{ oldText, newText }] };
  }
  return args;
}

export function registerEditTool(pi: ExtensionAPI): void {
  const editContentSchema = Type.Union([
    Type.Array(Type.String(), { description: "literal replacement content lines" }),
    Type.String({ description: "literal replacement content split on newlines" }),
    Type.Null({ description: "delete target range" }),
  ]);

  const locSchema = Type.Union([
    Type.Literal("append"),
    Type.Literal("prepend"),
    Type.Object({ append: Type.String({ description: "LINEID anchor" }) }, { additionalProperties: false }),
    Type.Object({ prepend: Type.String({ description: "LINEID anchor" }) }, { additionalProperties: false }),
    Type.Object({
      range: Type.Object({
        pos: Type.String({ description: "first LINEID anchor, inclusive" }),
        end: Type.String({ description: "last LINEID anchor, inclusive" }),
      }, { additionalProperties: false }),
    }, { additionalProperties: false }),
  ]);

  const editItemSchema = Type.Union([
    Type.Object(
      {
        loc: locSchema,
        content: editContentSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        oldText: Type.String({ description: "exact unique text to replace" }),
        newText: Type.String({ description: "replacement text" }),
      },
      { additionalProperties: false },
    ),
  ]);

  const editSchema = Type.Object(
    {
      path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
      edits: Type.Array(editItemSchema, { minItems: 1, description: "Hashline edits for this file" }),
    },
    { additionalProperties: false },
  );

  pi.registerTool({
    name: "edit",
    label: "Edit",
    description: [
      "Patch a UTF-8 text file using strict hashline v3 LINEID anchors copied from current read output (e.g. 160sray).",
      "Each edit is {loc,content}. loc: \"append\", \"prepend\", {append:LINEID}, {prepend:LINEID}, {range:{pos,end}}.",
      "content is literal file content lines (string[]/string) or null to delete.",
      "Fallback: a single {oldText,newText} edit performs one exact, unique text replacement.",
      "Anchors never relocate; stale hash mismatches are rejected with fresh retry anchors.",
      "Multiple anchor edits validate against the same pre-edit snapshot and apply bottom-up. Merge overlapping or adjacent edits.",
    ].join("\n"),
    promptSnippet: "Patch files using strict hashline v3 LINEID anchors from current read output.",
    promptGuidelines: [
      "Use read before edit; copy current full LINEID anchors exactly (e.g. 160sray, not sray). Hashline v2 anchors are rejected.",
      "Use loc/content: {range:{pos,end}} for replacements/deletes, {append}/{prepend} for inserts.",
      "Use literal file content in content lines, without LINEID| prefixes or diff prefixes.",
      "Merge overlapping or adjacent edits in the same file into one replace range.",
    ],
    parameters: editSchema,
    prepareArguments: prepareEditArguments,
    renderShell: "default",

    renderCall(args, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const path = isRecord(args) && typeof args.path === "string" ? args.path : "...";
      const count = isRecord(args) && Array.isArray(args.edits) ? args.edits.length : 0;
      const suffix = count > 0 ? theme.fg("muted", ` (${count} edit${count === 1 ? "" : "s"})`) : "";
      text.setText(`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path)}${suffix}`);
      return text;
    },

    renderResult(result, { isPartial }, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      if (isPartial) {
        text.setText(theme.fg("warning", "Editing..."));
        return text;
      }

      const body = result.content
        ?.map((entry) => entry.type === "text" ? entry.text ?? "" : "")
        .filter((entry) => entry.length > 0)
        .join("\n") ?? "";
      const details = isRecord(result.details) ? result.details : undefined;
      const diff = details && typeof details.diff === "string" ? details.diff : "";
      if (!context.isError && diff) {
        const path = isRecord(context.args) && typeof context.args.path === "string" ? context.args.path : undefined;
        text.setText(renderDiff(diff, { filePath: path }));
        return text;
      }

      text.setText(context.isError ? theme.fg("error", body) : body);
      return text;
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { path, edits } = params as EditRequest;
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
}
