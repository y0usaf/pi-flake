/**
 * pi-js-kernel — persistent Node.js REPL scratchpad RLM tool for Pi.
 *
 * Registers a `js` tool backed by a long-lived `node` child process. State
 * (variables, imports, functions) persists across tool calls within a
 * session; the child dies with the session and is respawned on demand.
 *
 * The child speaks a tiny NDJSON protocol over stdio (see kernel-child.mjs).
 * The host never touches kernel state directly: it writes one JSON request
 * line per call, waits for the matching response line, and applies the
 * timeout/abort watchdog by killing and respawning the child (state lost).
 *
 * This tool is an RLM bridge. Mid-eval, evaluated code may call
 * `kernel.read` / `kernel.edit` / `kernel.rlm.*`, which the child turns into
 * a `host_request` line. The host services it with the same hashline
 * read/edit handlers and the pi-agents rlm spawn machinery, answering with a
 * `host_response` line so the awaited Promise inside the eval resolves.
 *
 * During an in-flight host_request the per-call timeout watchdog is paused: a
 * slow `rlm.run` (or a slow read/edit) is bounded by the child agent's own
 * deadline, not by the js call's timer. The abort signal still kills the
 * kernel unconditionally.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import {
	readHandler,
	editHandler,
	writeHandler,
	type BridgeHandler,
	type BridgeCtx,
} from "./hashline-bridge.js";
import { createRlmBridge } from "./rlm-bridge.js";

// Replaced at nix build time with the store node (pi-rtk substituteInPlace pattern).
// Dev/standalone: falls back to "node" from PATH.
const NODE_BIN = "node";

const CHILD_PATH = fileURLToPath(new URL("./kernel-child.mjs", import.meta.url));

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_STDERR_TAIL = 4000;

interface KernelResponse {
	id: string;
	ok: boolean;
	stdout?: string;
	stderr?: string;
	result?: string | null;
	error?: { name: string; message: string; stack: string };
}

interface PendingRequest {
	id: string;
	resolve: (response: KernelResponse) => void;
	reject: (error: Error) => void;
}

interface PendingHostRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

// ---------------------------------------------------------------------------
// Module-level kernel state. One child per extension load (per session); the
// child is spawned lazily on first tool call, never from the factory.
// ---------------------------------------------------------------------------

let child: ChildProcess | null = null;
let stdoutBuffer = "";
let pending: PendingRequest | null = null;
let idCounter = 0;
let kernelRestarted = false;
let lastStderrTail = "";
let shutdownRegistered = false;

// Host bridge state. `pendingHostRequests` holds host_request promises that
// are in flight; the child answers each with a `host_response` line whose `id`
// matches. `currentBridgeCtx` carries cwd/model/signal/onUpdate for the *echo*
// js tool execution currently in flight — host_requests only fire mid-eval, so
// they are serviced against the live execution's ctx.
let pendingHostRequests = new Map<number, PendingHostRequest>();
let currentBridgeCtx: BridgeCtx | null = null;

// Watchdog (module-scope so the stdout parser can pause/resume it).
// See armWatchdog/pauseWatchdog below.
interface WatchdogState {
	timer: ReturnType<typeof setTimeout> | undefined;
	timeoutMs: number; // full budget for this call
	deadlineAt: number; // absolute Date.now() when the armed timer should fire
	pausedRemaining: number | null; // remaining budget while a host request is in flight
	hostRequests: number; // count of in-flight host requests (pauses the timer while > 0)
	expire: () => void; // the timeout action for this call
}
let watchdog: WatchdogState | null = null;

// A signal that never aborts — used to satisfy BridgeCtx for execute() calls
// that arrive without a real AbortSignal.
const NEVER_ABORTED = new AbortController().signal;

// Host-request handler registry, keyed by the child's `request.type`.
// Populated once in the factory below (see registerTool): read/edit are the
// hashline bridge handlers, and rlm.run/list/kill the pi-agents rlm bridge.
let bridgeHandlers: Record<string, BridgeHandler>;

// ---------------------------------------------------------------------------
// Kernel lifecycle helpers
// ---------------------------------------------------------------------------

function rejectPendingHostRequests(reason: Error): void {
	for (const { reject } of pendingHostRequests.values()) reject(reason);
	pendingHostRequests.clear();
}

function killKernel(): void {
	// Leftover host_requests can never be answered after the child is gone:
	// reject them so an in-flight rlm.run doesn't hang on a stale resolve.
	rejectPendingHostRequests(new Error("JS kernel killed"));
	if (child && !child.killed) {
		child.kill("SIGKILL");
	}
	child = null;
	stdoutBuffer = "";
}

// ---------------------------------------------------------------------------
// Watchdog: pause/resume the per-call timeout around in-flight host requests.
//
// Choice made: pause/resume. A host_request (notably rlm.run, but also a slow
// read/edit) is bounded by its own deadline — the child agent's timeout_seconds
// for rlm, the file tool's internal bounds for read/edit. Killing the kernel
// here would abort that in-flight work, so while any host_request is unresolved
// we clear the js timer and remember how much budget was left. When the last
// host_request settles we re-arm with the remaining budget. The abort signal is
// independent of this and kills the kernel unconditionally.
// ---------------------------------------------------------------------------

function armWatchdog(): void {
	const w = watchdog;
	if (!w || w.timer) return;
	if (w.hostRequests > 0) return; // paused: never arm while a host request is unresolved
	// Decide the remaining budget. On a fresh arm it is the full budget; while
	// paused we recorded the leftover explicitly against the deadline we had set.
	const remaining =
		w.pausedRemaining !== null ? w.pausedRemaining : Math.max(0, w.timeoutMs);
	w.pausedRemaining = null;
	if (remaining <= 0) {
		w.expire();
		return;
	}
	w.deadlineAt = Date.now() + remaining;
	w.timer = setTimeout(() => {
		w.timer = undefined;
		w.expire();
	}, remaining);
}

function pauseWatchdog(): void {
	const w = watchdog;
	if (!w) return;
	if (w.timer) {
		clearTimeout(w.timer);
		w.timer = undefined;
		// The timer was armed to fire at deadlineAt; computing remaining from the
		// deadline accounts for whatever budget was consumed before the pause.
		w.pausedRemaining = Math.max(0, w.deadlineAt - Date.now());
	}
}

function hostRequestStarted(): void {
	const w = watchdog;
	if (!w) return;
	w.hostRequests += 1;
	if (w.hostRequests === 1) pauseWatchdog();
}

function hostRequestSettled(): void {
	const w = watchdog;
	if (!w) return;
	w.hostRequests = Math.max(0, w.hostRequests - 1);
	if (w.hostRequests === 0) armWatchdog();
}

// ---------------------------------------------------------------------------
// Child stdout parser
// ---------------------------------------------------------------------------

interface HostRequestMessage {
	id: unknown;
	type?: string;
	request?: { type?: string; [key: string]: unknown };
}

function writeHostResponse(id: number, result: unknown): void {
	let line: string;
	try {
		line = JSON.stringify({ type: "host_response", id, result });
	} catch {
		// Handler returned a non-serializable value (BigInt, circular...).
		line = JSON.stringify({
			type: "host_response",
			id,
			result: {
				ok: false,
				error: {
					name: "HostResponseSerializationError",
					message: "host handler returned a value that could not be JSON-serialized",
					stack: "",
				},
			},
		});
	}
	// ORIGINAL serialized JSON write into the child stdin, exactly as the
	// protocol expects (LF-terminated, one object per line).
	child?.stdin?.write(line + "\n");
}

// Fire the host_request handler WITHOUT awaiting it here: the parser must
// return immediately so it can keep consuming stdout (the child stays busy
// awaiting its own host_response and emits nothing more until one arrives).
function dispatchHostRequest(msg: HostRequestMessage): void {
	const request = msg.request ?? {};
	const type = typeof request.type === "string" ? request.type : "";
	const handler = type ? bridgeHandlers[type] : undefined;
	const ctx = currentBridgeCtx;
	const hostId = Number(msg.id);

	// Do not block the stdout parser: run the handler in its own microtask.
	void (async () => {
		// Pause the js timer for the whole span of this host request.
		hostRequestStarted();
		let result: {
			ok: boolean;
			value?: unknown;
			error?: { name: string; message: string; stack: string };
		};
		try {
			if (!type) {
				result = {
					ok: false,
					error: { name: "UnknownHostRequest", message: "Missing host request type", stack: "" },
				};
			} else if (!handler) {
				result = {
					ok: false,
					error: {
						name: "UnknownHostRequest",
						message: `Unknown host request type: ${type}`,
						stack: "",
					},
				};
			} else if (!ctx) {
				result = {
					ok: false,
					error: {
						name: "NoActiveExecution",
						message: "Received host_request with no active js execution to service it",
						stack: "",
					},
				};
			} else {
				try {
					const value = await handler(request, ctx);
					result = { ok: true, value };
				} catch (err) {
					const e = err as Error;
					result = {
						ok: false,
						error: {
							name: e?.name ?? "Error",
							message: e?.message ?? String(err),
							stack: e?.stack ?? "",
						},
					};
				}
			}
		} finally {
			hostRequestSettled();
		}
		if (Number.isFinite(hostId) && child) {
			writeHostResponse(hostId, result);
		}
	})();
}

function handleStdoutLine(line: string): void {
	const trimmed = line.trim();
	if (!trimmed) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		// Unparseable line — ignore defensively.
		return;
	}
	const msg = parsed as HostRequestMessage & Partial<KernelResponse>;

	// host_request: service it async and keep parsing. These arrive mid-eval.
	if (msg.type === "host_request") {
		dispatchHostRequest(msg);
		return;
	}
	// Unknown/no-type protocol lines — ignore defensively (as today).
	if (msg.type !== undefined && msg.type !== "result") {
		return;
	}

	// Plain eval result.
	if (!pending) return;
	const response = parsed as Partial<KernelResponse>;
	if (typeof response.id !== "string" || response.id !== pending.id) return;
	const req = pending;
	pending = null;
	req.resolve(response as KernelResponse);
}

function setupChild(proc: ChildProcess): void {
	proc.stdout?.setEncoding("utf8");
	proc.stderr?.setEncoding("utf8");

	proc.stdout?.on("data", (chunk: string) => {
		stdoutBuffer += chunk;
		let newlineIndex = stdoutBuffer.indexOf("\n");
		while (newlineIndex >= 0) {
			const line = stdoutBuffer.slice(0, newlineIndex);
			stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
			handleStdoutLine(line);
			newlineIndex = stdoutBuffer.indexOf("\n");
		}
	});

	proc.stderr?.on("data", (chunk: string) => {
		lastStderrTail = (lastStderrTail + chunk).slice(-MAX_STDERR_TAIL);
		// Keep diagnostics available without flooding pi's log.
		console.error(`[pi-js-kernel:child] ${chunk.trimEnd()}`);
	});

	proc.on("exit", (code, signal) => {
		if (child === proc) child = null;
		stdoutBuffer = "";
		// An in-flight host_request's host_response can never arrive: reject it
		// now so the awaited eval (e.g. rlm.run) doesn't wait on a stale resolve.
		rejectPendingHostRequests(
			new Error(
				`JS kernel exited during a host request (code ${code ?? "null"}, signal ${signal ?? "null"}).`,
			),
		);
		if (pending) {
			const req = pending;
			pending = null;
			req.reject(
				new Error(
					`JS kernel exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}). Last stderr: ${lastStderrTail || "(none)"}`,
				),
			);
		}
	});
}

function ensureChild(): Promise<ChildProcess> {
	if (child) return Promise.resolve(child);
	return new Promise((resolve, reject) => {
		let proc: ChildProcess;
		try {
			proc = spawn(NODE_BIN, [CHILD_PATH], { stdio: ["pipe", "pipe", "pipe"] });
		} catch (error) {
			reject(error);
			return;
		}
		child = proc;
		setupChild(proc);

		let spawned = false;
		proc.once("spawn", () => {
			spawned = true;
			resolve(proc);
		});
		proc.once("error", (error: Error) => {
			if (child === proc) child = null;
			if (!spawned) {
				reject(error);
			} else if (pending) {
				const req = pending;
				pending = null;
				req.reject(error);
			}
		});
	});
}

function registerShutdownHook(pi: ExtensionAPI): void {
	if (shutdownRegistered) return;
	shutdownRegistered = true;
	pi.on("session_shutdown", () => {
		killKernel();
	});
}

function clampTimeout(raw: number | undefined): number {
	if (raw === undefined) return DEFAULT_TIMEOUT_MS;
	return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, raw));
}

function composeSections(r: KernelResponse): string {
	const sections: { label: string; body: string }[] = [];
	if (r.stdout) sections.push({ label: "stdout", body: r.stdout });
	if (r.result !== null && r.result !== undefined) {
		sections.push({ label: "result", body: String(r.result) });
	}
	if (r.stderr) sections.push({ label: "stderr", body: r.stderr });

	if (sections.length === 0) return "";
	if (sections.length === 1) return sections[0].body;
	return sections.map((s) => `[${s.label}]\n${s.body}`).join("\n");
}

function composeResultText(r: KernelResponse): string {
	let text = composeSections(r);
	if (!r.ok && r.error) {
		const stack = r.error.stack ? r.error.stack.slice(0, 2000) : "";
		text += `\n[error] ${r.error.name}: ${r.error.message}`;
		if (stack) text += `\n${stack}`;
	}
	return text.trim();
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	registerShutdownHook(pi);

	// The RLM bridge wires pi-agents' session-scoped spawn machinery internally
	// (model registry adoption happens on `session_start`). It MUST be created
	// here, at factory time, so that `session_start` fires for it; creating it
	// lazily on first `js` execute would miss the event and leave rlm.run without
	// a model registry. Call it once and keep the returned handlers.
	const rlmBridge = createRlmBridge(pi);

	// The kernel is the tool surface (canon:config-over-code): every host
	// capability the model reaches lives here as a bridge handler, registered
	// under the same name the REPL sees as kernel.<name>. Built-in tools stay
	// registered (the bridge reuses their cores) but are hidden from the model
	// via setActiveTools below, so the model reasons about one tool: js.

	bridgeHandlers = {
		read: readHandler,
		edit: editHandler,
		write: writeHandler,
		"rlm.run": rlmBridge.run,
		"rlm.list": rlmBridge.list,
		"rlm.kill": rlmBridge.kill,
	};

	pi.registerTool({
		name: "js",
		label: "js",
		description:
			"persistent JavaScript kernel (RLM) — evaluated code keeps variables, imports, and functions across calls within the session, and can delegate file work and child agents via the kernel API. State dies with the session (a new session starts fresh). js is the single tool: all file/search/shell/agent capabilities are reached through kernel.* inside evaluated code. Available: kernel.read(path, opts) (hashline v3 LINEID-anchored file preview), kernel.edit({path, edits}) (LINEID-anchored edits), kernel.write({path, content}) (create or overwrite a file), kernel.bash(cmd, {timeoutMs}) (subshell), kernel.rlm.run(task, {contract, model, timeoutSeconds}) (spawn a child agent and await its contract answers), kernel.rlm.list(), kernel.rlm.kill(id). Long-running or never-settling code hits a timeout and the kernel is restarted (state lost); an in-flight kernel.rlm.run is bounded by its own child deadline, not the js timer. Runs single-threaded.",
		promptSnippet: "js - single persistent Node.js kernel (RLM) — all file, shell, and agent work via kernel.read / kernel.edit / kernel.write / kernel.bash / kernel.rlm.*",
		promptGuidelines: [
			"State (variables, imports, functions) persists across js calls within this session; a new session starts fresh.",
			"js is the only tool. Do all file work with kernel.read / kernel.edit / kernel.write, shell work with kernel.bash, and agent delegation with kernel.rlm.run inside js. Results come back as awaited data.",
			"kernel.read returns hashline v3 output (lines prefixed LINEID) that kernel.edit accepts as anchors. Use kernel.write for new files or complete rewrites.",
			"Code that exceeds the timeout restarts the kernel and loses all REPL state — keep long-running work incremental. kernel.rlm.run is bounded by its own child timeout, not the js timer.",
			"Large multi-step work: write helper functions into the REPL and reuse them across calls; the kernel is the working memory.",
		],
		parameters: Type.Object({
			code: Type.String({
				description: "JavaScript source to evaluate in the persistent REPL",
			}),
			timeoutMs: Type.Optional(
				Type.Integer({
					description: "Per-call timeout in ms. Default 60000, clamped 1000..300000.",
				}),
			),
		}),
		executionMode: "sequential",

		renderCall(args, theme, _context) {
			const code = args?.code ?? "";
			const oneLine = code.replace(/\s*\n\s*/g, " ").trim();
			const snippet = oneLine.length > 100 ? oneLine.slice(0, 100) + "…" : oneLine;
			const label =
				theme.fg("toolTitle", theme.bold("js")) + (snippet ? ` ${theme.fg("muted", snippet)}` : "");
			return new Text(label, 0, 0);
		},

		renderResult(result, options, theme, context) {
			const output = (Array.isArray(result.content) ? result.content : [])
				.filter((c) => c.type === "text" && c.text)
				.map((c) => c.text)
				.join("\n");
			if (!options.expanded && !context.isError) return new Text("", 0, 0);
			const lines = output.replace(/\s+$/, "").split("\n");
			const max = options.expanded ? lines.length : 10;
			const shown = lines
				.slice(0, max)
				.map((l) => theme.fg("toolOutput", l))
				.join("\n");
			const remaining = lines.length - max;
			let text = `\n${shown}`;
			if (remaining > 0) text += theme.fg("muted", `\n... (${remaining} more lines, toggle expand to view)`);
			return new Text(text, 0, 0);
		},

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const timeoutMs = clampTimeout(params.timeoutMs);
			const restartNotice = kernelRestarted ? "[kernel restarted: REPL state lost]\n" : "";
			kernelRestarted = false;

			let proc: ChildProcess;
			if (!child) {
				onUpdate?.({ content: [{ type: "text", text: "Starting JS kernel..." }], details: undefined });
			}
			try {
				proc = await ensureChild();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const text =
					`Failed to start the JS kernel: ${message}. ` +
					"Node.js is not available — use the nix-built pi-js-kernel extension, which bundles node.";
				return {
					content: [{ type: "text" as const, text }],
					details: { status: "error" as const },
				};
			}

			const id = String(++idCounter);

			const responsePromise = new Promise<KernelResponse>((resolve, reject) => {
				pending = { id, resolve, reject };
			});

			let aborted = false;
			let timedOut = false;

			// Timeout watchdog for THIS call. Module-scoped so the stdout parser can
			// pause/resume it while a host_request is in flight.
			watchdog = {
				timer: undefined,
				timeoutMs,
				deadlineAt: 0,
				pausedRemaining: null,
				hostRequests: 0,
				expire: () => {
					if (aborted) return;
					timedOut = true;
					killKernel();
					kernelRestarted = true;
					if (pending) {
						const req = pending;
						pending = null;
						req.reject(new Error("timeout"));
					}
				},
			};
			armWatchdog();

			const onAbort = () => {
				if (aborted || timedOut) return;
				aborted = true;
				// Abort is unconditional — it kills the kernel even if a host_request
				// (rlm.run) is in flight; the exit handler rejects that request.
				killKernel();
				kernelRestarted = true;
				if (pending) {
					const req = pending;
					pending = null;
					req.reject(new Error("aborted"));
				}
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			// Publish the live execution's ctx for host_request dispatch. Set before
			// writing the eval so any host_request the code emits is serviced against
			// this execution. Cleared once this call settles.
			// onUpdate here is AgentToolUpdateCallback<unknown>; BridgeCtx.onUpdate
			// is a looser structural type whose details is optional. The runtime
			// payload satisfies the tighter AgentToolResult shape, so assert the
			// cast once (same pattern rlm-bridge uses).
			currentBridgeCtx = {
				cwd: _ctx?.cwd ?? "",
				model: _ctx?.model?.id ?? "",
				signal: signal ?? NEVER_ABORTED,
				onUpdate: onUpdate as BridgeCtx["onUpdate"],
			};

			let response: KernelResponse;
			try {
				proc.stdin?.write(`${JSON.stringify({ type: "eval", id, code: params.code })}\n`);
				response = await responsePromise;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				let text: string;
				if (timedOut) {
					text = `Timed out after ${timeoutMs}ms. Kernel restarted — all REPL state lost.`;
				} else if (aborted) {
					text = `Execution aborted. Kernel restarted — all REPL state lost.`;
				} else {
					text = message;
				}
				return {
					content: [{ type: "text" as const, text }],
					details: { status: "error" as const },
				};
			} finally {
				// Tear down the watchdog + ctx for this call.
				if (watchdog?.timer) clearTimeout(watchdog.timer);
				watchdog = null;
				currentBridgeCtx = null;
				signal?.removeEventListener("abort", onAbort);
			}

			const text = restartNotice + composeResultText(response);
			return {
				content: [{ type: "text" as const, text }],
				details: { status: response.ok ? ("ok" as const) : ("error" as const) },
			};
		},
	});

	// A-collapse: js is the single model-visible tool. setActiveTools keeps only
	// tools already in the registry (unknown names are ignored), so it MUST run
	// after registerTool or js would be dropped and the toolset emptied. Built-in
	// tools stay registered under the hood so the bridge keeps reusing their
	// cores; the model only sees js. This shrinks the safety/audit surface to one
	// choke point (the host-request dispatcher) instead of per-tool events.
	// Deferred to session_start: pi >=0.84 forbids action methods (like
	// setActiveTools) during extension loading — "Extension runtime not
	// initialized". registerTool above ran already, so js is in the registry
	// by the time this fires.
	pi.on("session_start", () => {
		pi.setActiveTools(["js"]);
	});
}
