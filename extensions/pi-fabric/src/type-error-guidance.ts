import type { FabricTypeError } from "./runtime/type-checker.js";
import {
  CORE_TOOL_NAMES,
  CORE_TOOL_PROPERTIES,
} from "./runtime/core-tool-properties.js";

const SYNTAX_ERROR_PATTERN = /expected|unterminated|unexpected|invalid character/i;
const PAYLOAD_CALL_PATTERN = /\bpi\.(?:edit|write)\s*\(/;
const PROMISE_ALL_PATTERN = /\bPromise\.all\s*\(/;
const TUPLE_ARITY_PATTERN = /Tuple type .* of length '[0-9]+' has no element at index '[0-9]+'/;
const MISSING_NAME_PATTERN = /^Cannot find name '([^']+)'/;
const UNKNOWN_PROPERTY_PATTERN = /'([^']+)' does not exist in type '([^']+)'/;
const PI_CALL_PATTERN = /\bpi\.(\w+)\s*\(/g;

// fabric_exec envelope arguments that are commonly misplaced inside `code`.
const FABRIC_EXEC_ARGUMENT_NOTES: Readonly<Record<string, string>> = {
  strings:
    "named `strings` belong in the outer `fabric_exec` arguments, then become available inside `code` as `π.key`.",
  tokenBudget:
    "budget arguments (`tokenBudget`, `agentBudget`) belong to the outer `fabric_exec` call, not inside `code`.",
  agentBudget:
    "budget arguments (`tokenBudget`, `agentBudget`) belong to the outer `fabric_exec` call, not inside `code`.",
  display: "the `display` objective belongs to the outer `fabric_exec` call, not inside `code`.",
  resultFormat:
    "`resultFormat` belongs to the outer `fabric_exec` call, not inside `code`.",
};

const PROPERTY_NOTES: Readonly<Record<string, string>> = {
  settle:
    "`settle:true` settles nonzero `pi.bash` exits into an `ok:false` envelope instead of rejecting; other `pi.*` calls reject failures normally.",
  timeout: "`timeout` is measured in seconds; `timeoutMs` is converted from milliseconds.",
};

// pi.bash options that stay unsupported (cwd is honored per call since #71).
const BASH_OPTION_NOTES: Readonly<Record<string, string>> = {
  stdin:
    "`pi.bash` does not accept `stdin`. Write the content with `pi.write(path, content)`, then pass that path to the command or redirect the file into it.",
};

const isCoreToolName = (name: string): name is (typeof CORE_TOOL_NAMES)[number] =>
  (CORE_TOOL_NAMES as readonly string[]).includes(name);

// The 2353 message names the checked type (e.g. 'PiCommandArgument &
// PiBashOptions'); strip alias suffixes to recover the called tool.
const toolFromTypeText = (typeText: string): string | undefined => {
  for (const match of typeText.matchAll(/\bPi([A-Z]\w*)/g)) {
    const captured = match[1];
    if (captured === undefined) continue;
    const candidate = captured
      .replace(/(?:Compatibility)?(?:Argument|Options)$/, "")
      .toLowerCase();
    if (isCoreToolName(candidate)) return candidate;
  }
  return undefined;
};

// Fallback for messages naming only shared bags (e.g. 'PiPathArgument'): find
// the `pi.<tool>(` call enclosing the error position. Type-checker lines are
// 1-based and preceded by the guest wrapper, so try both offsets.
const enclosingCoreTool = (code: string, error: FabricTypeError): string | undefined => {
  const lines = code.split("\n");
  for (const lineIndex of [error.line - 2, error.line - 1]) {
    if (lineIndex < 0 || lineIndex >= lines.length) continue;
    const offset =
      lines.slice(0, lineIndex).join("\n").length +
      (lineIndex > 0 ? 1 : 0) +
      Math.max(0, error.column - 1);
    PI_CALL_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    let tool: string | undefined;
    while ((match = PI_CALL_PATTERN.exec(code)) !== null && match.index < offset) {
      const called = match[1];
      if (called !== undefined && isCoreToolName(called)) tool = called;
    }
    if (tool !== undefined) return tool;
  }
  return undefined;
};

const unknownPropertyHint = (
  property: string,
  tool: string | undefined,
): string | undefined => {
  if (tool === undefined) return undefined;
  if (tool === "bash") {
    const bashNote = BASH_OPTION_NOTES[property];
    if (bashNote !== undefined) return `Recovery hint: ${bashNote}`;
  }
  const envelopeNote = FABRIC_EXEC_ARGUMENT_NOTES[property];
  if (envelopeNote !== undefined) {
    return `Recovery hint: \`${property}\` is a \`fabric_exec\` argument, not a \`pi.${tool}\` property. ${envelopeNote}`;
  }
  const ownerTools = CORE_TOOL_PROPERTIES.get(property);
  if (ownerTools === undefined || ownerTools.includes(tool as never)) return undefined;
  const owners = ownerTools.map((owner) => `\`pi.${owner}\``).join(", ");
  const note = PROPERTY_NOTES[property];
  return `Recovery hint: \`${property}\` is not a \`pi.${tool}\` property — it belongs to ${owners}.${note ? ` ${note}` : ""}`;
};

const hasLiteralPayloadInterpolation = (
  code: string,
  errors: FabricTypeError[],
): boolean => {
  if (!PAYLOAD_CALL_PATTERN.test(code)) return false;
  return errors.some((error) => {
    const name = MISSING_NAME_PATTERN.exec(error.message)?.[1];
    return name !== undefined && code.includes(`\${${name}}`);
  });
};

export const typeErrorRecoveryHint = (
  code: string,
  errors: FabricTypeError[],
): string | undefined => {
  for (const error of errors) {
    const property = UNKNOWN_PROPERTY_PATTERN.exec(error.message)?.[1];
    const typeText = UNKNOWN_PROPERTY_PATTERN.exec(error.message)?.[2];
    if (property !== undefined && typeText !== undefined) {
      const tool = toolFromTypeText(typeText) ?? enclosingCoreTool(code, error);
      const hint = unknownPropertyHint(property, tool);
      if (hint) return hint;
    }
  }
  if (
    PROMISE_ALL_PATTERN.test(code)
    && errors.some((error) => TUPLE_ARITY_PATTERN.test(error.message))
  ) {
    return "Recovery hint: match `Promise.all` destructuring one binding per promise; remove the extra binding or add the missing call.";
  }
  if (hasLiteralPayloadInterpolation(code, errors)) {
    return "Recovery hint: a `${...}` expression in an edit/write payload is being evaluated by the Fabric TypeScript program. Declare it if intentional; for literal file content, move the payload to top-level `strings` and reference `π.key`.";
  }
  if (!PAYLOAD_CALL_PATTERN.test(code)) return undefined;
  if (!errors.some((error) => SYNTAX_ERROR_PATTERN.test(error.message))) {
    return undefined;
  }
  return "Recovery hint: if embedded edit/write payload text caused the syntax error, pass it through top-level `strings` and reference `π.key` instead of escaping it inside `code`.";
};
