// Declaration mechanism for workflow slash commands (pi-loom DESIGN.md, P3).
//
// A `command.json` next to a workflow script is the *only* way a workflow
// becomes a slash command. Before P3 the spec carried a free-text description
// whose "Usage:" tail was hand-written prose, and arguments were whatever
// JSON.parse happened to return. This module makes the argument contract
// declarative: `argsSchema` is a JSON Schema object, usage text is generated
// from it, and arguments are validated against it before a run is launched.
//
// P3b adds the other half of the mechanism: *where* a command.json may live.
// Discovery is here too, so one module answers both "what does a spec mean"
// and "which specs exist", and host.ts only registers what it is handed.
//
// Kept out of host.ts on purpose: no session, no run store and no UI, so it is
// readable and testable on its own.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import type { JsonSchema, JsonValue } from "./types.js";
import { errorText, fail, jsonValue, object } from "./utils.js";
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

// ---------------------------------------------------------------- discovery
//
// Three scopes, in precedence order. `builtin` is what ships with the wrapper,
// `user` is the agent dir, `project` is `<cwd>/.pi/workflows` — a repo keeping
// its own commands beside its own code, which is the point of P3b.
//
// First root to claim a name wins, so a project cannot silently shadow a
// builtin or user command: `/ship` must keep meaning what the user installed
// even after cloning someone else's repo. Cross-scope collision *precedence*
// (letting a project deliberately override) is deferred in DESIGN.md until
// installable packs force the question; until then the shadowed spec is
// reported by `/workflows` instead of being applied or silently dropped.
export const WORKFLOW_COMMAND_SCOPES = ["builtin", "user", "project"] as const;
export type WorkflowCommandScope = (typeof WORKFLOW_COMMAND_SCOPES)[number];

export interface WorkflowCommandRoot {
  scope: WorkflowCommandScope;
  path: string;
}

export interface DiscoveredWorkflowCommand {
  spec: WorkflowCommandSpec;
  scope: WorkflowCommandScope;
  specPath: string;
  scriptPath: string;
  /** Set when a higher-precedence scope already registered this name. */
  shadowedBy?: WorkflowCommandScope;
}

export interface WorkflowCommandProblem {
  scope: WorkflowCommandScope;
  specPath: string;
  message: string;
}

export interface WorkflowCommandDiscovery {
  roots: readonly WorkflowCommandRoot[];
  commands: readonly DiscoveredWorkflowCommand[];
  problems: readonly WorkflowCommandProblem[];
}

/** Project-local scan root. One directory, no upward search: the project is the cwd Pi was started in. */
export function projectWorkflowCommandRoot(cwd: string): string { return join(cwd, ".pi", "workflows"); }

export function workflowCommandRoots(extensionDir: string, agentDir: string, cwd: string): WorkflowCommandRoot[] {
  return [
    { scope: "builtin", path: join(extensionDir, "../workflows") },
    { scope: "builtin", path: join(extensionDir, "../../workflows") },
    { scope: "user", path: join(agentDir, "workflows") },
    { scope: "project", path: projectWorkflowCommandRoot(cwd) },
  ];
}

/**
 * Scan every root for `<dir>/command.json` and return what may be registered.
 *
 * A malformed spec in a builtin or user root throws: those are the operator's
 * own files and a silent skip would hide a typo. A malformed spec in the
 * project root is collected as a problem instead, because a cloned repo must
 * not be able to abort extension load — `loom` has to still start in a repo
 * whose `.pi/workflows` is broken or hostile.
 */
export function discoverWorkflowCommands(roots: readonly WorkflowCommandRoot[]): WorkflowCommandDiscovery {
  const commands: DiscoveredWorkflowCommand[] = [];
  const problems: WorkflowCommandProblem[] = [];
  const claimed = new Map<string, WorkflowCommandScope>();
  for (const root of roots) {
    if (!existsSync(root.path)) continue;
    // readdir order is filesystem-dependent; sort so shadowing is deterministic.
    const entries = readdirSync(root.path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    for (const name of entries) {
      const dir = join(root.path, name);
      const specPath = join(dir, "command.json");
      if (!existsSync(specPath)) continue;
      const tolerate = root.scope === "project";
      let spec: WorkflowCommandSpec;
      try {
        let parsed: unknown;
        try { parsed = JSON.parse(readFileSync(specPath, "utf8")); }
        catch (error) { fail("CONFIG_ERROR", `Invalid workflow command JSON at ${specPath}: ${errorText(error)}`); }
        spec = validateWorkflowCommandSpec(parsed, specPath);
        const scriptPath = join(dir, spec.script ?? "workflow.js");
        if (!existsSync(scriptPath)) fail("INVALID_METADATA", `Workflow command ${spec.name} script not found: ${scriptPath}`);
        const shadowedBy = claimed.get(spec.name);
        if (shadowedBy === undefined) claimed.set(spec.name, root.scope);
        commands.push({ spec, scope: root.scope, specPath, scriptPath, ...(shadowedBy ? { shadowedBy } : {}) });
      } catch (error) {
        if (!tolerate) throw error;
        problems.push({ scope: root.scope, specPath, message: errorText(error) });
      }
    }
  }
  return { roots, commands, problems };
}

/** Body of `/workflows`: every command, the scope it came from, and why anything was skipped. */
export function workflowCommandListing(discovery: WorkflowCommandDiscovery): string {
  const lines: string[] = [];
  for (const scope of WORKFLOW_COMMAND_SCOPES) {
    const roots = discovery.roots.filter((root) => root.scope === scope);
    const active = discovery.commands.filter((command) => command.scope === scope && !command.shadowedBy);
    lines.push(`${scope} (${roots.map((root) => root.path).join(", ")})`);
    if (!active.length) lines.push("  (none)");
    for (const command of active) lines.push(`  /${command.spec.name}  ${workflowCommandSignature(command.spec).replace(/^Usage: /, "")}${command.spec.description ? ` - ${command.spec.description}` : ""}`);
  }
  const shadowed = discovery.commands.filter((command) => command.shadowedBy);
  for (const command of shadowed) lines.push(`shadowed: ${command.specPath} declares /${command.spec.name}, already provided by ${command.shadowedBy ?? "another scope"} scope`);
  for (const problem of discovery.problems) lines.push(`skipped: ${problem.specPath} (${problem.message})`);
  return lines.join("\n");
}
