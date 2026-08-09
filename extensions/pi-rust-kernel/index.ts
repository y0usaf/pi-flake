/**
 * pi-rust-kernel — persistent Rust evaluation scratchpad tool for Pi.
 *
 * Registers a `rust` tool backed by a long-lived child binary (compiled from
 * child/, using the evcxr Rust evaluation library). State (variables,
 * functions, types) persists across `rust` calls within a session; the child
 * dies with the session and is respawned on demand.
 *
 * The child speaks a tiny NDJSON protocol over stdio (see child/src/main.rs).
 * The host never touches kernel state directly: it writes one eval request
 * line per call, waits for the matching result line, and applies the
 * timeout/abort watchdog by killing and respawning the child (state lost).
 *
 * The child binary is compiled by the Nix derivation and its store path is
 * substituted in at build time (CHILD_BIN). Dev/standalone loads fall back to
 * the freshly cargo-built binary in child/target/debug.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";

// Replaced at nix build time with the compiled child store path.
// Dev/standalone: falls back to the cargo-built debug binary.
const CHILD_BIN = "child";
const DEV_CHILD_BIN = fileURLToPath(new URL("./child/target/release/pi-rust-kernel-child", import.meta.url));

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const MIN_STARTUP_MS = 30_000; // first eval compiles the evcxr module; be generous at spawn
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

// ---------------------------------------------------------------------------
// Kernel lifecycle helpers
// ---------------------------------------------------------------------------

function killKernel(): void {
	if (child && !child.killed) {
		child.kill("SIGKILL");
	}
	child = null;
	stdoutBuffer = "";
}

// ---------------------------------------------------------------------------
// Child stdout parser
// ---------------------------------------------------------------------------

function handleStdoutLine(line: string): void {
	const trimmed = line.trim();
	if (!trimmed) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return; // non-protocol diagnostic on stdout — ignore
	}
	const msg = parsed as Partial<KernelResponse>;
	if (msg.type !== undefined && msg.type !== "result") return;
	if (!pending) return;
	if (typeof msg.id !== "string" || msg.id !== pending.id) return;
	const req = pending;
	pending = null;
	req.resolve(msg as KernelResponse);
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
		if (process.env.PI_RUST_KERNEL_DEBUG) {
			console.error(`[pi-rust-kernel:child] ${chunk.trimEnd()}`);
		}
	});

	proc.on("exit", (code, signal) => {
		if (child === proc) child = null;
		stdoutBuffer = "";
		if (pending) {
			const req = pending;
			pending = null;
			req.reject(
				new Error(
					`Rust kernel exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}). Last stderr: ${lastStderrTail || "(none)"}`,
				),
			);
		}
	});
}

function resolveChildBin(): string {
	// Nix build substitutes CHILD_BIN with the store path. If it's still the
	// literal dev marker, try the cargo-built debug binary.
	if (CHILD_BIN !== "child") return CHILD_BIN;
	return DEV_CHILD_BIN;
}

function ensureChild(): Promise<ChildProcess> {
	if (child) return Promise.resolve(child);
	return new Promise((resolve, reject) => {
		const bin = resolveChildBin();
		let proc: ChildProcess;
		try {
			proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
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
		text += `\n[error] ${r.error.name}: ${r.error.message}`;
	}
	const trimmed = text.trim();
	if (trimmed) return trimmed;
	if (r.ok) {
		return "evaluated to a statement with no value — end with an expression (`x`) or print with println!().";
	}
	return trimmed;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	registerShutdownHook(pi);

	const rustToolDefinition = {
		name: "rust",
		label: "rust",
		description:
			"persistent Rust evaluation kernel (evcxr) — evaluated code keeps variables, functions, and types across calls within the session, and can run shell commands via the injected kernel_bash helper. State dies with the session (a new session starts fresh). The first call compiles a fresh evcxr module and is slow (tens of seconds); subsequent calls are incremental and fast. Available inside evaluated code: kernel_bash(cmd) -> String (runs a shell command child-side and returns its stdout). Long-running or never-settling code hits a timeout and the kernel is restarted (state lost).",
		promptSnippet: "rust - single persistent Rust kernel (evcxr) — keeps state across calls; kernel_bash(cmd) runs shell child-side",
		promptGuidelines: [
			"State (variables, functions, types) persists across rust calls within this session; a new session starts fresh.",
			"The first rust call is slow (compiles the evcxr module); subsequent calls are incremental and fast. Reuse the kernel as working memory — write helper functions and reuse them across calls.",
			"End code with the expression you want to see: `let x = computation(); x` returns x; a bare `let` statement returns no value.",
			"Run shell commands with kernel_bash(\"cmd\") which returns the command's stdout as a String.",
			"Code that exceeds the timeout restarts the kernel and loses all state — keep long-running work incremental.",
		],
		parameters: Type.Object({
			code: Type.String({
				description: "Rust source to evaluate in the persistent kernel",
			}),
			timeoutMs: Type.Optional(
				Type.Integer({
					description: "Per-call timeout in ms. Default 60000, clamped 1000..300000.",
				}),
			),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const timeoutMs = clampTimeout(params.timeoutMs);
			const restartNotice = kernelRestarted ? "[kernel restarted: REPL state lost]\n" : "";
			kernelRestarted = false;

			let proc: ChildProcess;
			try {
				proc = await ensureChild();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const text =
					`Failed to start the Rust kernel: ${message}. ` +
					"Build the child binary first: `cargo build` in extensions/pi-rust-kernel/child, or use the nix-built pi-rust-kernel extension.";
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

			// The first eval compiles the evcxr module; allow extra time for it.
			const effectiveTimeout = idCounter === 1 ? Math.max(timeoutMs, MIN_STARTUP_MS) : timeoutMs;

			// Timeout watchdog for THIS call.
			const expire = () => {
				if (aborted) return;
				timedOut = true;
				killKernel();
				kernelRestarted = true;
				if (pending) {
					const req = pending;
					pending = null;
					req.reject(new Error("timeout"));
				}
			};
			const timer = setTimeout(expire, effectiveTimeout);

			const onAbort = () => {
				if (aborted || timedOut) return;
				aborted = true;
				killKernel();
				kernelRestarted = true;
				if (pending) {
					const req = pending;
					pending = null;
					req.reject(new Error("aborted"));
				}
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			let response: KernelResponse;
			try {
				proc.stdin?.write(`${JSON.stringify({ type: "eval", id, code: params.code })}\n`);
				response = await responsePromise;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				let text: string;
				if (timedOut) {
					text = `Timed out after ${effectiveTimeout}ms. Kernel restarted — all REPL state lost.`;
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
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}

			const text = restartNotice + composeResultText(response);
			return {
				content: [{ type: "text" as const, text }],
				details: { status: response.ok ? ("ok" as const) : ("error" as const) },
			};
		},
	};

	pi.registerTool(rustToolDefinition);
}
