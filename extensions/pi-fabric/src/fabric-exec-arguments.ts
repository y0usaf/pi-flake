import { normalizeRunDisplay } from "./run-display.js";

const OPTIONAL_FABRIC_EXEC_KEYS = [
  "strings",
  "resultFormat",
  "tokenBudget",
  "agentBudget",
  "display",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const prepareFabricExecArguments = (input: unknown): unknown => {
  if (typeof input === "string") return { code: input };
  if (!isRecord(input)) return input;

  let prepared = input;
  const writable = (): Record<string, unknown> => {
    if (prepared === input) prepared = { ...input };
    return prepared;
  };

  if (Array.isArray(prepared.code) && prepared.code.every((line) => typeof line === "string")) {
    writable().code = prepared.code.join("\n");
  }

  for (const key of OPTIONAL_FABRIC_EXEC_KEYS) {
    if (!Object.hasOwn(prepared, key)) continue;
    if (prepared[key] === null || prepared[key] === undefined) delete writable()[key];
  }

  const display = prepared.display;
  if (typeof display === "string" || isRecord(display)) {
    const normalized = normalizeRunDisplay(display);
    if (normalized) writable().display = normalized;
    else delete writable().display;
  }

  return prepared;
};
