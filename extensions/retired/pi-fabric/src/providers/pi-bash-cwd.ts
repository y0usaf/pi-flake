import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { createBashToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";

// pi.bash's per-call execution directory.
//
// pi's shell backend already takes cwd as a first-class parameter
// (BashOperations.exec(command, cwd, options)), and pi-agent-core's harness
// shell goes further with a per-command ShellExecOptions.cwd. Only the bash
// *tool schema* omits it, so a model-supplied cwd is dropped without a word by
// pi core and rejected outright by Fabric's guest type check. Accepting the
// field therefore has to come with honoring it, or the rejections would turn
// into commands silently running in the wrong directory.
//
// The alternative — telling models to write `cd <dir> && <command>` — buries
// the directory in the command string, where it defeats extensions that match
// on command names (permission prompts, sandboxing) and hides the target from
// Fabric's own approval classifier.

export const PI_BASH_CWD_KEY = "cwd";

/**
 * Resolve and validate a single bash call's execution directory.
 *
 * Relative paths resolve against the session cwd. Unlike the leaf-agent
 * resolver this deliberately does NOT canonicalize symlinks: agents commonly
 * target git worktrees whose paths are symlinks, and rewriting those to their
 * real targets changes what `pwd` reports inside the command and breaks
 * tooling that keys on the worktree path. `path.resolve` normalizes `..`
 * lexically, which is all the approval classifier needs to see a truthful
 * absolute target.
 *
 * Containment is intentionally not enforced. Models can already reach any
 * directory with `cd <dir> && <command>`, which Fabric neither inspects nor
 * contains, so a containment check here would add no boundary — it would only
 * push calls back into the string-concatenated form that evades it. Directory
 * containment belongs to pi's project-trust layer or a bash spawn hook.
 */
export const resolvePiBashCwd = (sessionCwd: string, requested: unknown): string => {
  if (typeof requested !== "string" || requested.trim().length === 0) {
    throw new Error(
      `Invalid pi.bash cwd ${JSON.stringify(requested)}: path must be a non-empty string`,
    );
  }
  const resolved = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(sessionCwd, requested);
  try {
    if (!statSync(resolved).isDirectory()) throw new Error("path is not a directory");
    accessSync(resolved, constants.R_OK | constants.X_OK);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid pi.bash cwd ${JSON.stringify(requested)} (${resolved}): ${reason}`);
  }
  return resolved;
};

/**
 * Rewrite a bash call's cwd in place, leaving every other argument untouched.
 *
 * The arguments are never split into an execution copy: pi's bash schema
 * declares no additionalProperties and its execute destructures
 * { command, timeout }, so the extra key is inert there, while events,
 * approval, and previews all benefit from seeing it. Resolving at the
 * preparation stage means an unusable directory fails before validation and
 * before approval — no prompt, nothing executed — and everything downstream
 * reads the resolved absolute path instead of the model's `../..` spelling,
 * so an obfuscated target cannot pass for a harmless one.
 */
export const resolveBashCwdArgument = (
  sessionCwd: string,
  args: Record<string, unknown>,
): Record<string, unknown> =>
  Object.hasOwn(args, PI_BASH_CWD_KEY)
    ? { ...args, [PI_BASH_CWD_KEY]: resolvePiBashCwd(sessionCwd, args[PI_BASH_CWD_KEY]) }
    : args;

const CWD_PROPERTY = Type.Optional(
  Type.String({
    description:
      "Execution directory for this command; relative paths resolve from the session cwd.",
  }),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Declare `cwd` on the bash descriptor.
 *
 * Not load-bearing for validation — pi's bash schema sets no
 * additionalProperties, so an undeclared cwd would pass anyway. It is declared
 * because the descriptor is the contract the capability surface, the generated
 * guest declarations, and the approval classifier all read; a tool that
 * quietly honors a field it does not advertise is the next person's trap.
 *
 * Rebuilt as a fresh TObject rather than spread-cloned: TypeBox schemas carry
 * Symbol keys that a spread drops, which would leave Value.Check unable to
 * validate the descriptor at all. Property values are reused by reference, so
 * they keep their own Symbols.
 */
export const withBashCwdSchema = (schema: unknown): unknown => {
  if (!isRecord(schema) || !isRecord(schema.properties)) return schema;
  if (Object.hasOwn(schema.properties, PI_BASH_CWD_KEY)) return schema;
  const { type: _type, properties, required, ...rest } = schema;
  return Type.Object(
    { ...properties, [PI_BASH_CWD_KEY]: CWD_PROPERTY } as Record<string, TSchema>,
    { ...rest, ...(Array.isArray(required) ? { required } : {}) },
  );
};

// Bash definitions are cheap closure-holding objects, but one per distinct
// directory still beats rebuilding on every call in a loop over one tree.
const MAX_CACHED_DEFINITIONS = 16;

/**
 * Bash definitions bound to an execution directory.
 *
 * This class is the whole seam between Fabric's per-call cwd and pi's
 * cwd-bound tool family: `createBashToolDefinition(cwd)`'s argument is what
 * reaches spawn context and then BashOperations.exec. If pi-coding-agent ever
 * honors ExtensionContext.cwd (earendil-works/pi#8679), or Fabric moves onto
 * pi-agent-core's harness tools where the execution environment already
 * carries cwd, this collapses to passing cwd through the context and the class
 * goes away — the guest-facing `pi.bash({ command, cwd })` contract is
 * unaffected either way.
 */
export class BashCwdDefinitions {
  readonly #cache = new Map<string, ToolDefinition<any, any, any>>();

  /** A bash definition bound to `cwd`, reusing a recent one when possible. */
  get(cwd: string): ToolDefinition<any, any, any> {
    const cached = this.#cache.get(cwd);
    if (cached) {
      // Refresh recency so a hot directory survives eviction.
      this.#cache.delete(cwd);
      this.#cache.set(cwd, cached);
      return cached;
    }
    const definition = createBashToolDefinition(cwd);
    this.#cache.set(cwd, definition);
    if (this.#cache.size > MAX_CACHED_DEFINITIONS) {
      const oldest = this.#cache.keys().next();
      if (!oldest.done) this.#cache.delete(oldest.value);
    }
    return definition;
  }
}
