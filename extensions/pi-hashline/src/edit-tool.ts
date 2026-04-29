import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { StringEnum } from "@mariozechner/pi-ai";
import { withFileMutationQueue, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { resolveMutationTargetPath, writeTextFileAtomically } from "./fs-write";
import { applyEditsToContent, buildChangedAnchorResponse, type EditRequest } from "./hashline";
import { resolveToCwd } from "./path-utils";
import { throwIfAborted } from "./runtime";
import { isImagePath, loadTextFile, restoreLineEnding } from "./text-file";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function prepareEditArguments(args: unknown): unknown {
  if (!isRecord(args) || Array.isArray(args.edits)) return args;
  const path = args.path;
  if (typeof path !== "string") return args;

  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    return {
      path,
      edits: [{ op: "replace_text", oldText: args.oldText, newText: args.newText }],
    };
  }

  if (typeof args.old_text === "string" && typeof args.new_text === "string") {
    return {
      path,
      edits: [{ op: "replace_text", oldText: args.old_text, newText: args.new_text }],
    };
  }

  return args;
}

function assertEditRequest(value: unknown): asserts value is EditRequest {
  if (!isRecord(value)) throw new Error("Edit request must be an object.");
  if (typeof value.path !== "string" || value.path.length === 0) {
    throw new Error('Edit request requires a non-empty "path" string.');
  }
  if (!Array.isArray(value.edits) || value.edits.length === 0) {
    throw new Error('Edit request requires a non-empty "edits" array.');
  }

  for (const [index, edit] of value.edits.entries()) {
    if (!isRecord(edit)) throw new Error(`Edit ${index} must be an object.`);
    const op = edit.op;
    if (op !== "replace" && op !== "append" && op !== "prepend" && op !== "replace_text") {
      throw new Error(`Edit ${index} uses unknown op ${JSON.stringify(op)}. Expected replace, append, prepend, or replace_text.`);
    }

    if ("pos" in edit && typeof edit.pos !== "string") {
      throw new Error(`Edit ${index} field "pos" must be a string when provided.`);
    }
    if ("end" in edit && typeof edit.end !== "string") {
      throw new Error(`Edit ${index} field "end" must be a string when provided.`);
    }

    if (op === "replace_text") {
      if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
        throw new Error(`Edit ${index} with op "replace_text" requires string oldText and newText.`);
      }
      if ("pos" in edit || "end" in edit || "lines" in edit) {
        throw new Error(`Edit ${index} with op "replace_text" only supports oldText and newText.`);
      }
      continue;
    }

    if (!("lines" in edit)) {
      throw new Error(`Edit ${index} requires a "lines" field.`);
    }
    if (
      edit.lines !== null &&
      typeof edit.lines !== "string" &&
      !(Array.isArray(edit.lines) && edit.lines.every((line) => typeof line === "string"))
    ) {
      throw new Error(`Edit ${index} field "lines" must be a string array, string, or null.`);
    }
    if ("oldText" in edit || "newText" in edit) {
      throw new Error(`Edit ${index} with op "${op}" does not support oldText/newText; use op "replace_text".`);
    }
    if (op === "replace" && typeof edit.pos !== "string") {
      throw new Error(`Edit ${index} with op "replace" requires a pos anchor.`);
    }
    if ((op === "append" || op === "prepend") && "end" in edit) {
      throw new Error(`Edit ${index} with op "${op}" does not support end.`);
    }
  }
}

export function registerEditTool(pi: ExtensionAPI): void {
  const editLinesSchema = Type.Union([
    Type.Array(Type.String(), { description: "literal replacement content lines" }),
    Type.String({ description: "literal replacement content split on newlines" }),
    Type.Null({ description: "delete target range" }),
  ]);

  const editItemSchema = Type.Object(
    {
      op: StringEnum(["replace", "append", "prepend", "replace_text"] as const, {
        description: "edit operation",
      }),
      pos: Type.Optional(Type.String({ description: "LINE#HASH anchor" })),
      end: Type.Optional(Type.String({ description: "inclusive LINE#HASH end anchor for replace" })),
      lines: Type.Optional(editLinesSchema),
      oldText: Type.Optional(Type.String({ description: "exact text for replace_text" })),
      newText: Type.Optional(Type.String({ description: "replacement text for replace_text" })),
    },
    { additionalProperties: false },
  );

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
      "Patch a UTF-8 text file using LINE#HASH anchors copied from read output.",
      "Ops: replace(pos,end?,lines), append(pos?,lines), prepend(pos?,lines), replace_text(oldText,newText).",
      "Anchors are strict; stale hash mismatches are rejected with fresh retry anchors.",
      "lines must be literal file content: no LINE#HASH prefixes and no diff +/- prefixes.",
      "Multiple anchor edits validate against the same pre-edit snapshot and apply bottom-up. Merge overlapping or adjacent edits.",
    ].join("\n"),
    promptSnippet: "Patch files using LINE#HASH anchors from read output.",
    promptGuidelines: [
      "Use edit with LINE#HASH anchors copied from the latest read output for that file.",
      "Do not invent or adjust anchors; if an anchor is stale or missing, call read again.",
      "Use literal file content in edit lines, without LINE#HASH or diff prefixes.",
      "Merge overlapping or adjacent edits in the same file into one replace range.",
    ],
    parameters: editSchema,
    prepareArguments: prepareEditArguments,

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
      text.setText(context.isError ? theme.fg("error", body) : body);
      return text;
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      assertEditRequest(params);
      const path = params.path;
      const absolutePath = resolveToCwd(path, ctx.cwd);
      const mutationTargetPath = await resolveMutationTargetPath(absolutePath);

      return withFileMutationQueue(mutationTargetPath, async () => {
        throwIfAborted(signal);
        try {
          await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
        } catch (error: unknown) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") throw new Error(`File not found: ${path}`);
          if (code === "EACCES" || code === "EPERM") throw new Error(`File is not writable: ${path}`);
          throw new Error(`Cannot access file: ${path}`);
        }

        if (isImagePath(absolutePath)) {
          throw new Error(`Path is an image file: ${path}. Hashline edit only supports UTF-8 text files.`);
        }

        throwIfAborted(signal);
        const file = await loadTextFile(absolutePath);
        const original = file.text;
        const result = applyEditsToContent(original, params.edits);

        if (result === original) {
          return {
            content: [{ type: "text", text: "No changes made. The requested edits produced identical content." }],
            details: { classification: "noop" },
          };
        }

        throwIfAborted(signal);
        const persisted = file.bom + restoreLineEnding(result, file.lineEnding);
        await writeTextFileAtomically(absolutePath, persisted);

        const response = buildChangedAnchorResponse(original, result);
        return {
          content: [{ type: "text", text: response.text }],
          details: {
            firstChangedLine: response.firstChangedLine,
            metrics: {
              edits_attempted: params.edits.length,
              added_lines: response.addedLines,
              removed_lines: response.removedLines,
            },
          },
        };
      });
    },
  });
}
