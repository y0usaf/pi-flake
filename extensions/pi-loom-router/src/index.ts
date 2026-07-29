/**
 * pi-loom-router — the policy gate of the workflow-first `loom` stack.
 *
 * In `loom` the agent you chat with routes; it does not edit. Anything that
 * mutates the working tree happens inside a workflow run, where a sub-agent
 * gets the tool, a worktree bounds the blast radius, and git records the diff.
 * This extension is what makes that a property of the stack rather than a
 * convention the model is asked to honour. It works on two levels, because the
 * tools differ in kind: `edit` and `write` are removed from the chat agent's
 * active set, so they are never offered to the model at all, while `bash`
 * stays offered and every invocation is classified before it runs (P5b-ii,
 * ./shell-policy.ts).
 *
 * A third mechanism points the *user* rather than the model: at startup the
 * session opens on a picker listing the workflows it can run, and Esc drops
 * straight to chat (P5c, ./picker.ts). Policy that only subtracts leaves a
 * `loom` looking like a `pi` that mysteriously lost its editing tools; the
 * picker is what makes the stack's purpose visible on the first screen.
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
import { offerWorkflowPicker } from "./picker.ts";
import { classifyShellCommand } from "./shell-policy.ts";

/**
 * Tools the chat agent must not hold in `loom`.
 *
 * `bash` is deliberately *not* here since P5b-ii. Two mechanisms, two failure
 * modes: pi.setActiveTools can only address a tool name, which is the right
 * instrument for `edit` and `write` (tools that exist to mutate) and the wrong
 * one for `bash` (a tool whose *invocation* decides). Hiding `bash` cost the
 * router `git status` and `rg -n`, so it stays visible and every call is
 * classified by ./shell-policy.ts from the `tool_call` handler below.
 *
 * Matching is by name, which is also how tool overrides work: pi-hashline
 * registers its own `edit` under the builtin's name, so one entry covers both.
 */
const GATED_TOOLS: readonly string[] = ["edit", "write"];

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

	// P5c: the picker. Registered *after* the gate handler on purpose. Handlers
	// for one event run in registration order and are awaited one at a time, so
	// the gate — which is synchronous — has already been applied before this one
	// reaches its first await. A picker that hangs, throws or is dismissed can
	// therefore never leave the chat agent holding `edit`.
	//
	// Only `reason: "startup"` opens it. The event also fires for "reload",
	// "new", "resume" and "fork"; a modal appearing on `/reload` or when you
	// return to existing work is a nuisance rather than an offer. Widening this
	// to "new" later is one condition, if opening a fresh session should feel
	// like opening loom.
	//
	// The mode guard and the empty-editor guard live in ./picker.ts, next to the
	// reasoning for each; the short version is that ui.select blocks forever in
	// RPC mode and setEditorText replaces the buffer.
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup") return;
		await offerWorkflowPicker(pi.getCommands(), ctx);
	});

	// The second half of the gate, and the one that needs a different mechanism:
	// `bash` stays in the active set, but every invocation is classified before
	// it runs. Returning { block: true, reason } is pi's documented way to refuse
	// a tool call; the reason is fed back to the model, which is why every
	// refusal names /quick and /build instead of only saying no.
	//
	// Scope is the chat session alone. Workflow sub-agents are separate sessions
	// built by createAgentSession() with explicit extensionFactories (see
	// extensions/pi-loom/src/agent-execution.ts), so this handler is not in their
	// stack and an exec stage keeps its full shell inside its worktree.
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;
		const input = event.input as BashToolInput | undefined;
		const command = typeof input?.command === "string" ? input.command : "";
		const verdict = classifyShellCommand(command);
		if (verdict.allowed) return;
		return { block: true, reason: verdict.reason };
	});
}

/** The `bash` tool's input shape; only `command` matters to the policy. */
interface BashToolInput {
	readonly command?: unknown;
}
