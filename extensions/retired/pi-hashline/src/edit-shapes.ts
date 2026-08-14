export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LEGACY_EDIT_KEYS = new Set(["op", "pos", "end", "lines", "oldText", "newText"]);

/**
 * Map one edit entry onto strict v3 shapes before schema validation, per Pi's
 * prepareArguments guidance. Anything unrecognized passes through for the
 * schema to reject.
 *
 * Two conveniences are folded here so every entry point (host edit tool and
 * the js-kernel bridge) accepts the same shapes:
 *  - naive v3: top-level {range}/{append}/{prepend} beside content, with no
 *    loc wrapper — the natural shape a model emits from read anchors
 *  - legacy v2 request shapes: op/pos/end/lines, and op "replace_text"
 */
export function normalizeEditShape(entry: unknown): unknown {
  if (!isRecord(entry) || "loc" in entry) return entry;

  if ("range" in entry || "append" in entry || "prepend" in entry) {
    const { range, append, prepend, ...rest } = entry;
    const loc = range !== undefined ? { range } : append !== undefined ? { append } : { prepend };
    return { ...rest, loc };
  }
  if ("content" in entry) return entry;

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

export function prepareEditArguments(args: unknown): unknown {
  if (!isRecord(args) || typeof args.path !== "string") return args;

  if (Array.isArray(args.edits)) {
    return { ...args, edits: args.edits.map(normalizeEditShape) };
  }

  const oldText = args.oldText ?? args.old_text;
  const newText = args.newText ?? args.new_text;
  if (typeof oldText === "string" && typeof newText === "string") {
    return { path: args.path, edits: [{ oldText, newText }] };
  }
  return args;
}
