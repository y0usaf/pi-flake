import type { FabricTypeError } from "./runtime/type-checker.js";

const SYNTAX_ERROR_PATTERN = /expected|unterminated|unexpected|invalid character/i;
const PAYLOAD_CALL_PATTERN = /\bpi\.(?:edit|write)\s*\(/;

export const typeErrorRecoveryHint = (
  code: string,
  errors: FabricTypeError[],
): string | undefined => {
  if (!PAYLOAD_CALL_PATTERN.test(code)) return undefined;
  if (!errors.some((error) => SYNTAX_ERROR_PATTERN.test(error.message))) {
    return undefined;
  }
  return "Recovery hint: if embedded edit/write payload text caused the syntax error, pass it through top-level `strings` and reference `π.key` instead of escaping it inside `code`.";
};
