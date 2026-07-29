// Declaration mechanism for workflow slash commands (pi-loom DESIGN.md, P3).
//
// A `command.json` next to a workflow script is the *only* way a workflow
// becomes a slash command. Before P3 the spec carried a free-text description
// whose "Usage:" tail was hand-written prose, and arguments were whatever
// JSON.parse happened to return. This module makes the argument contract
// declarative: `argsSchema` is a JSON Schema object, usage text is generated
// from it, and arguments are validated against it before a run is launched.
//
// Kept out of host.ts on purpose: this is pure input handling with no session,
// no run store and no UI, so it is readable and testable on its own.
import { Value } from "typebox/value";
import type { JsonSchema, JsonValue } from "./types.js";
import { fail, jsonValue, object } from "./utils.js";
import { validateSchema } from "./validation.js";

const COMMAND_NAME = /^[a-zA-Z0-9][\w-]*$/;
// A slash command's text is untyped, so "7" has to be able to reach an
// integer-typed property. Only exact numeric literals convert; "7 rounds"
// stays a string and fails validation with a real message.
const NUMERIC = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export interface WorkflowCommandSpec {
  name: string;
  description?: string;
  script?: string;
  args?: JsonValue;
  argKey?: string;
  argsSchema?: JsonSchema;
}

export type WorkflowCommandArgs = { ok: true; args: JsonValue } | { ok: false; message: string };

function schemaProperties(schema: JsonSchema): Record<string, JsonSchema> {
  const properties = schema.properties;
  if (!object(properties)) return {};
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => object(value))) as Record<string, JsonSchema>;
}

function requiredKeys(schema: JsonSchema): ReadonlySet<string> {
  return new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : []);
}

/** Structural check of one `command.json`. Throws a WorkflowError naming the file. */
export function validateWorkflowCommandSpec(parsed: unknown, specPath: string): WorkflowCommandSpec {
  if (!object(parsed)) fail("INVALID_METADATA", `Workflow command at ${specPath} must be an object`);
  const spec = parsed as unknown as WorkflowCommandSpec;
  if (typeof spec.name !== "string" || !COMMAND_NAME.test(spec.name)) fail("INVALID_METADATA", `Workflow command at ${specPath} requires a name matching /^[a-zA-Z0-9][\\w-]*$/`);
  if (spec.description !== undefined && typeof spec.description !== "string") fail("INVALID_METADATA", `Workflow command at ${specPath} description must be a string`);
  if (spec.script !== undefined && typeof spec.script !== "string") fail("INVALID_METADATA", `Workflow command at ${specPath} script must be a string`);
  if (spec.argKey !== undefined && typeof spec.argKey !== "string") fail("INVALID_METADATA", `Workflow command at ${specPath} argKey must be a string`);
  if (spec.argsSchema !== undefined) {
    validateSchema(spec.argsSchema, `Workflow command at ${specPath} argsSchema`);
    if (spec.argsSchema.type !== "object") fail("INVALID_METADATA", `Workflow command at ${specPath} argsSchema must declare type "object"`);
    const properties = schemaProperties(spec.argsSchema);
    if (spec.argKey !== undefined && !(spec.argKey in properties)) fail("INVALID_METADATA", `Workflow command at ${specPath} argKey "${spec.argKey}" is not a property of argsSchema`);
    for (const key of requiredKeys(spec.argsSchema)) {
      if (!(key in properties)) fail("INVALID_METADATA", `Workflow command at ${specPath} argsSchema requires "${key}" but does not declare it`);
    }
  }
  return spec;
}

function typeLabel(schema: JsonSchema): string {
  const type = typeof schema.type === "string" ? schema.type : Array.isArray(schema.type) ? schema.type.filter((value): value is string => typeof value === "string").join("|") : Array.isArray(schema.enum) ? "enum" : "any";
  if (type !== "array") return type;
  const items = object(schema.items) ? schema.items : undefined;
  const itemType = items && typeof items.type === "string" ? items.type : "any";
  return `${itemType}[]`;
}

function describeProperty(schema: JsonSchema, required: boolean): string {
  const parts = [typeLabel(schema)];
  if (Array.isArray(schema.enum)) parts.push(`one of ${schema.enum.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("|")}`);
  if (typeof schema.minimum === "number" || typeof schema.maximum === "number") parts.push(`range ${typeof schema.minimum === "number" ? String(schema.minimum) : "*"}..${typeof schema.maximum === "number" ? String(schema.maximum) : "*"}`);
  parts.push(required ? "required" : "optional");
  if (schema.default !== undefined) parts.push(`default ${JSON.stringify(schema.default)}`);
  const description = typeof schema.description === "string" && schema.description.trim() ? ` - ${schema.description.trim()}` : "";
  return `${parts.join(", ")}${description}`;
}

/** `Usage: /name <required> [optional]` — the one-line form, also used as the palette hint. */
export function workflowCommandSignature(spec: WorkflowCommandSpec): string {
  if (!spec.argsSchema) return spec.argKey ? `Usage: /${spec.name} <${spec.argKey}>` : `Usage: /${spec.name}`;
  const required = requiredKeys(spec.argsSchema);
  const keys = Object.keys(schemaProperties(spec.argsSchema));
  const placeholders = [...keys.filter((key) => required.has(key)).map((key) => `<${key}>`), ...keys.filter((key) => !required.has(key)).map((key) => `[${key}]`)];
  return `Usage: /${spec.name}${placeholders.length ? ` ${placeholders.join(" ")}` : ""}`;
}

/** Multi-line usage text: the signature, one line per declared argument, then the input forms. */
export function workflowCommandUsage(spec: WorkflowCommandSpec): string {
  const lines = [workflowCommandSignature(spec)];
  if (spec.argsSchema) {
    const required = requiredKeys(spec.argsSchema);
    const properties = Object.entries(schemaProperties(spec.argsSchema));
    const width = properties.reduce((longest, [key]) => Math.max(longest, key.length), 0);
    for (const [key, property] of properties) lines.push(`  ${key.padEnd(width)}  ${describeProperty(property, required.has(key))}`);
  }
  lines.push(spec.argKey ? `Bare text is taken as "${spec.argKey}"; a JSON object always works: /${spec.name} '{ "${spec.argKey}": "..." }'` : `Pass arguments as a JSON object: /${spec.name} '{ ... }'`);
  return lines.join("\n");
}

// JSON Schema `default` and slash-command text coercion are applied by hand
// rather than with Value.Default / Value.Convert: those two only act on
// TypeBox-constructed types (they key off an internal Kind symbol) and are
// silent no-ops on the plain JSON Schema a command.json carries. Value.Check
// and Value.Errors do understand plain JSON Schema, so validation itself is
// still real JSON Schema semantics, not a hand-rolled subset.
function applyDeclaredDefaults(schema: JsonSchema, args: Record<string, JsonValue>): Record<string, JsonValue> {
  const filled = { ...args };
  for (const [key, property] of Object.entries(schemaProperties(schema))) {
    if (filled[key] === undefined && property.default !== undefined) filled[key] = structuredClone(property.default);
  }
  return filled;
}

function coerceDeclaredScalars(schema: JsonSchema, args: Record<string, JsonValue>): Record<string, JsonValue> {
  const coerced = { ...args };
  for (const [key, property] of Object.entries(schemaProperties(schema))) {
    const value = coerced[key];
    if (typeof value !== "string") continue;
    const type = typeof property.type === "string" ? property.type : undefined;
    if ((type === "number" || type === "integer") && NUMERIC.test(value.trim())) coerced[key] = Number(value.trim());
    else if (type === "boolean" && (value.trim() === "true" || value.trim() === "false")) coerced[key] = value.trim() === "true";
  }
  return coerced;
}

function firstSchemaError(schema: JsonSchema, value: JsonValue): string {
  const [error] = [...Value.Errors(schema, value)] as { instancePath?: string; message?: string }[];
  const path = typeof error?.instancePath === "string" ? error.instancePath.replace(/^\//, "").replaceAll("/", ".") : "";
  const message = typeof error?.message === "string" ? error.message : "is invalid";
  return path ? `${path} ${message}` : `arguments ${message}`;
}

/**
 * Turn the raw text after a slash command into launch args.
 *
 * Without `argsSchema` this reproduces the pre-P3 behaviour exactly, so
 * existing command.json files keep working untouched. With `argsSchema`,
 * non-object JSON is wrapped under `argKey`, declared defaults are filled,
 * text scalars are coerced to declared numeric/boolean types, and the result
 * is validated — a failure returns generated usage instead of starting a run.
 */
export function parseWorkflowCommandArgs(spec: WorkflowCommandSpec, raw: string): WorkflowCommandArgs {
  const trimmed = raw.trim();
  const schema = spec.argsSchema;
  if (!schema) {
    if (!trimmed) {
      if (spec.args === undefined && spec.argKey) return { ok: false, message: workflowCommandUsage(spec) };
      return { ok: true, args: spec.args ?? null };
    }
    try { return { ok: true, args: JSON.parse(trimmed) as JsonValue }; }
    catch { return { ok: true, args: spec.argKey ? { [spec.argKey]: trimmed } : trimmed }; }
  }
  let candidate: JsonValue;
  if (!trimmed) candidate = spec.args ?? {};
  else {
    let parsed: JsonValue | undefined;
    try { parsed = JSON.parse(trimmed) as JsonValue; }
    catch { parsed = undefined; }
    if (parsed === undefined) candidate = spec.argKey ? { [spec.argKey]: trimmed } : trimmed;
    else if (object(parsed)) candidate = parsed;
    else candidate = spec.argKey ? { [spec.argKey]: parsed } : parsed;
  }
  if (object(spec.args) && object(candidate)) candidate = { ...spec.args, ...candidate };
  if (!object(candidate) || !jsonValue(candidate)) return { ok: false, message: `/${spec.name}: arguments must be a JSON object\n${workflowCommandUsage(spec)}` };
  const args = coerceDeclaredScalars(schema, applyDeclaredDefaults(schema, candidate));
  if (!Value.Check(schema, args)) return { ok: false, message: `/${spec.name}: ${firstSchemaError(schema, args)}\n${workflowCommandUsage(spec)}` };
  return { ok: true, args };
}
