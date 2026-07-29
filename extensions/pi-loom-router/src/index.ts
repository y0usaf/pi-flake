/**
 * pi-loom-router — the policy gate of the workflow-first `loom` stack.
 *
 * In `loom` the agent you chat with routes; it does not edit. Anything that
 * mutates the working tree happens inside a workflow run, where a sub-agent
 * gets the tool, a worktree bounds the blast radius, and git records the diff.
 * This extension is what makes that a property of the stack rather than a
 * convention the model is asked to honour: it removes the mutating tools from
 * the chat agent's active set, so they are never offered to the model at all.
 *
 * Shipped only in `loom` (packages.pi-loom-router, wired into the loom stack in
 * flake.nix). It is deliberately absent from extensions/registry.nix, so plain
 * `pi` and the `pi-full` bundle cannot pick it up through an extension flag.
 *
 * Two invariants this file exists to keep:
 *
 *   1. In memory, never persisted. The gate is re-applied from scratch on every
 *      session start. Nothing is written to disk, so a crashed or killed `loom`
 *      cannot leave a user's plain `pi` sessions crippled. (This is also why
 *      pi-tool-management is excluded from the loom stack: it persists a global
 *      disabled-tools list, which would outlive the session and fight this.)
 *
 *   2. It gates *visibility*, not the workflow launch boundary. A run's tool
 *      ceiling is read from pi.getAllTools() — the session's configured tool
 *      set — not pi.getActiveTools(), which is what this file narrows. That
 *      separation landed in P5a and is what lets a gated chat agent still
 *      launch a workflow whose executor sub-agent writes code. See the "Launch
 *      boundary" section of extensions/pi-loom/DESIGN.md before changing either
 *      side; collapsing them fails every exec stage with
 *      `UNKNOWN_TOOL: Tool is outside the launching session boundary: edit`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Tools the chat agent must not hold in `loom`.
 *
 * `bash` is here in full, not narrowed to its mutating invocations: one tool
 * name is all pi.setActiveTools can address, and a gate that leaves `bash`
 * reachable is not a gate at all (`bash` can write any file `edit` could).
 * Read-only shell is a real loss and is tracked as P5b-ii, which re-admits
 * `bash` behind a `tool_call` classifier.
 *
 * Matching is by name, which is also how tool overrides work: pi-hashline
 * registers its own `edit` under the builtin's name, so one entry covers both.
 */
const GATED_TOOLS: readonly string[] = ["edit", "write", "bash"];

/**
 * Read-only builtins the gate switches *on*, if the session was configured
 * with them.
 *
 * Measured, not assumed: pi's default active set is read, bash, edit and write,
 * while grep, find and ls are configured but inactive. Subtracting the gated
 * three from that default leaves a chat agent holding `read` alone — it cannot
 * list a directory or search for a symbol, so every routing decision is made
 * blind. DESIGN.md rejects exactly that ("Hard router (no file access at all)"),
 * so the gate is a swap rather than a subtraction: mutating capability out,
 * read-only discovery in.
 */
const RESTORED_TOOLS: readonly string[] = ["grep", "find", "ls"];

/**
 * Names of every tool the session was configured with.
 *
 * pi.getAllTools() returns metadata objects rather than names, and is the
 * session's configured ceiling: intersecting against it is what keeps a user's
 * own `loom --tools read` narrower than this policy rather than widened by it.
 */
function configuredToolNames(pi: ExtensionAPI): string[] {
	const all = pi.getAllTools() as unknown;
	if (!Array.isArray(all)) return [];
	return all
		.map((tool) => (typeof tool === "string" ? tool : (tool as { name?: unknown }).name))
		.filter((name): name is string => typeof name === "string");
}

/**
 * Swap the mutating tools out of the active set and the read-only ones in.
 *
 * Idempotent, and cheap enough to run on every prompt: when there is nothing to
 * gate and nothing to restore the active set is left untouched, so this never
 * disturbs another extension's additive tool loading.
 */
function applyGate(pi: ExtensionAPI): void {
	const active = pi.getActiveTools();
	const kept = active.filter((name) => !GATED_TOOLS.includes(name));

	const configured = new Set(configuredToolNames(pi));
	const restored = RESTORED_TOOLS.filter((name) => configured.has(name) && !kept.includes(name));

	if (restored.length === 0 && kept.length === active.length) return;
	pi.setActiveTools([...kept, ...restored]);
}

export default function loomRouter(pi: ExtensionAPI): void {
	// Nothing here may touch the action API. Calling pi.getActiveTools() in a
	// factory body kills the whole stack with "Extension runtime not
	// initialized. Action methods cannot be called during extension loading."
	//
	// session_start is also the earliest correct moment for a different reason:
	// every extension factory has finished by then, so tools registered at load
	// time — including pi-hashline's replacement `edit` — are already in the
	// active set and get filtered out with the builtins.
	pi.on("session_start", () => {
		applyGate(pi);
	});

	// Defence in depth for tools enabled *after* startup, by an extension's own
	// session_start handler or by a tool that calls setActiveTools mid-run.
	// before_agent_start fires once per submitted prompt, before the agent loop
	// builds the request, so a re-gate here lands before the model can see a
	// tool that came back. Returning nothing leaves the prompt untouched.
	pi.on("before_agent_start", () => {
		applyGate(pi);
	});
}
