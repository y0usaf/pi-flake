/**
 * pi-rust-kernel — persistent Rust evaluation scratchpad tool for Pi, with a
 * host bridge so evaluated Rust code can reach host tools (read/edit/write/rlm).
 *
 * Registers a `rust` tool backed by a long-lived child binary (compiled from
 * child/, using the evcxr Rust evaluation library). State (variables,
 * functions, types) persists across `rust` calls within a session.
 *
 * HOST BRIDGE: evcxr evaluates user code in a re-spawned subprocess with no
 * event loop, so the child gives evaluated code a synchronous bridge over a
 * Unix socket (see child/src/main.rs). When evaluated code calls
 * `kernel::read(path)` / `kernel::write(path, content)` / `kernel::edit(...)` /
 * `kernel::rlm::run(task)`, the child emits a `host_request` NDJSON line to the
 * host. This file services it with the same file/rlm handlers the built-in
 * tools use, answering with a `host_response` line that resolves the caller.
 *
 * The host never touches kernel state directly: it writes one eval request
 * line per call, waits for the result line, and applies the timeout/abort
 * watchdog by killing and respawning the child (state lost). While a
 * host_request is in flight the per-call watchdog is paused (the request is
 * bounded by the handler's own work), mirroring pi-js-kernel.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import { access, mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// Replaced at nix build time with the compiled child store path.
// Dev/standalone: falls back to the cargo-built release binary.
const CHILD_BIN = "child";
const DEV_CHILD_BIN = fileURLToPath(new URL("./child/target/release/pi-rust-kernel-child", import.meta.url));

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const MIN_STARTUP_MS = 30_000; // first eval compiles the evcxr module
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

interface BridgeCtx {
	cwd: string;
	model: string;
	signal: AbortSignal;
}

type BridgeHandler = (payload: unknown, ctx: BridgeCtx) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Module-level kernel state.
// ---------------------------------------------------------------------------

let child: ChildProcess | null = null;
let stdoutBuffer = "";
let pending: PendingRequest | null = null;
let idCounter = 0;
let kernelRestarted = false;
let lastStderrTail = "";
let shutdownRegistered = false;

// Host bridge state: the handler map and the live execution ctx (cwd/model)
// against which requests are serviced. (The child correlates host_responses
// by id in its socket server; the host just dispatches and answers.)
let bridgeHandlers: Record<string, BridgeHandler> = {};
let currentBridgeCtx: BridgeCtx | null = null;

// Watchdog pause/resume around in-flight host requests.
interface WatchdogState {
	timer: ReturnType<typeof setTimeout> | undefined;
	timeoutMs: number;
	deadlineAt: number;
	pausedRemaining: number | null;
	hostRequests: number;
	expire: () => void;
}
let watchdog: WatchdogState | null = null;

// ---------------------------------------------------------------------------
// Host bridge handlers (read/edit/write/rlm)
// ---------------------------------------------------------------------------

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Aborted");
}

async function ensureReadable(abs: string): Promise<void> {
	try {
		await access(abs);
	} catch {
		throw new Error(`File not found: ${abs}`);
	}
}

const readHandler: BridgeHandler = async (payload, ctx) => {
	const { path, offset, limit } = payload as { path: string; offset?: number; limit?: number };
	throwIfAborted(ctx.signal);
	const abs = resolve(ctx.cwd, path);
	await ensureReadable(abs);
	const text = await readFile(abs, "utf-8");
	const lines = text.split("\n");
	// Hashline-style: every line prefixed LINEID so kernel.edit can anchor.
	const startLine = Math.max(1, offset ?? 1);
	const endLine = limit ? Math.min(startLine - 1 + limit, lines.length) : lines.length;
	const selected = lines.slice(startLine - 1, endLine);
	const formatted = selected.map((l, i) => `${startLine + i}|${l}`).join("\n");
	const truncated = endLine < lines.length ? `\n[Showing lines ${startLine}-${endLine} of ${lines.length}. Use offset=${endLine + 1} to continue.]` : "";
	return formatted + truncated;
};

const writeHandler: BridgeHandler = async (payload, ctx) => {
	const { path, content } = payload as { path: string; content: string };
	throwIfAborted(ctx.signal);
	const abs = resolve(ctx.cwd, path);
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(abs, content, "utf-8");
	return `Successfully wrote ${content.length} bytes to ${path}`;
};

const editHandler: BridgeHandler = async (payload, ctx) => {
	const { path, edits } = payload as { path: string; edits?: { oldText: string; newText: string }[] };
	throwIfAborted(ctx.signal);
	const abs = resolve(ctx.cwd, path);
	await ensureReadable(abs);
	let text = await readFile(abs, "utf-8");
	for (const edit of edits ?? []) {
		if (!edit.oldText) throw new Error("each edit needs oldText");
		if (!text.includes(edit.oldText)) {
			throw new Error(`oldText not found:\n${edit.oldText}`);
		}
		text = text.replace(edit.oldText, edit.newText ?? "");
	}
	await writeFile(abs, text, "utf-8");
	return `Applied ${(edits ?? []).length} edit(s) to ${path}`;
};

// rlm.run: spawn a literal `pi --print <task>` child (clean text mode) and
// return its stdout as the answer. Self-contained; blocking. list/kill track
// spawned children by pid.
const rlmChildren = new Map<number, { pid: number; status: string }>();
let rlmCounter = 0;

const rlmRunHandler: BridgeHandler = async (payload, ctx) => {
	const { task } = payload as { task: string };
	throwIfAborted(ctx.signal);
	const id = ++rlmCounter;
	const proc = spawn("pi", ["--print", task], {
		stdio: ["ignore", "pipe", "pipe"],
		cwd: ctx.cwd,
	});
	rlmChildren.set(id, { pid: proc.pid ?? -1, status: "running" });
	let out = "";
	let settled = false;
	proc.stdout?.on("data", (c: Buffer) => (out += c.toString()));
	proc.stderr?.on("data", (c: Buffer) => (out += c.toString()));
	return new Promise<string>((resolvePromise) => {
		const finish = () => {
			if (settled) return;
			settled = true;
			rlmChildren.set(id, { pid: proc.pid ?? -1, status: "done" });
			resolvePromise(JSON.stringify({ childId: id, answer: out.trim().slice(0, 8000), status: "done" }));
		};
		proc.on("close", finish);
		proc.on("error", () => finish());
	});
};

const rlmListHandler: BridgeHandler = async () => {
	return JSON.stringify([...rlmChildren.entries()].map(([id, info]) => ({ childId: id, ...info })));
};

const rlmKillHandler: BridgeHandler = async (payload) => {
	const { id } = payload as { id: string };
	const numeric = Number(id);
	const info = rlmChildren.get(numeric);
	if (info) {
		try {
			process.kill(info.pid, "SIGKILL");
			info.status = "killed";
		} catch {
			info.status = "gone";
		}
	}
	return JSON.stringify(info ?? null);
};

// ---------------------------------------------------------------------------
// Kernel lifecycle
// ---------------------------------------------------------------------------

function killKernel(): void {
	if (child && !child.killed) child.kill("SIGKILL");
	child = null;
	stdoutBuffer = "";
}

// ---------------------------------------------------------------------------
// Watchdog pause/resume around in-flight host requests (mirrors pi-js-kernel).
// ---------------------------------------------------------------------------

function armWatchdog(): void {
	const w = watchdog;
	if (!w || w.timer) return;
	if (w.hostRequests > 0) return;
	const remaining = w.pausedRemaining !== null ? w.pausedRemaining : w.timeoutMs;
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

function hostRequestStarted(): void {
	const w = watchdog;
	if (!w) return;
	w.hostRequests += 1;
	if (w.hostRequests === 1) {
		if (w.timer) {
			clearTimeout(w.timer);
			w.timer = undefined;
			w.pausedRemaining = Math.max(0, w.deadlineAt - Date.now());
		}
	}
}

function hostRequestSettled(): void {
	const w = watchdog;
	if (!w) return;
	w.hostRequests = Math.max(0, w.hostRequests - 1);
	if (w.hostRequests === 0) armWatchdog();
}

// ---------------------------------------------------------------------------
// Stdout parser + host_request dispatch
// ---------------------------------------------------------------------------

function writeHostResponse(id: number, result: unknown): void {
	let line: string;
	try {
		line = JSON.stringify({ type: "host_response", id, result });
	} catch {
		line = JSON.stringify({
			type: "host_response",
			id,
			result: { ok: false, error: { name: "SerializationError", message: "non-serializable bridge result", stack: "" } },
		});
	}
	child?.stdin?.write(line + "\n");
}

function dispatchHostRequest(msg: { id: unknown; request?: { type?: string; [key: string]: unknown } }): void {
	const request = msg.request ?? {};
	const type = typeof request.type === "string" ? request.type : "";
	const handler = type ? bridgeHandlers[type] : undefined;
	const ctx = currentBridgeCtx;
	const hostId = Number(msg.id);

	void (async () => {
		hostRequestStarted();
		let result: { ok: boolean; value?: unknown; error?: { name: string; message: string; stack: string } };
		try {
			if (!type) result = { ok: false, error: { name: "UnknownHostRequest", message: "missing type", stack: "" } };
			else if (!handler) result = { ok: false, error: { name: "UnknownHostRequest", message: `Unknown host request type: ${type}`, stack: "" } };
			else if (!ctx) result = { ok: false, error: { name: "NoActiveExecution", message: "no active rust execution", stack: "" } };
			else {
				try {
					const value = await handler(request, ctx);
					result = { ok: true, value };
				} catch (err) {
					const e = err as Error;
					result = { ok: false, error: { name: e?.name ?? "Error", message: e?.message ?? String(err), stack: e?.stack ?? "" } };
				}
			}
		} finally {
			hostRequestSettled();
		}
		if (Number.isFinite(hostId) && child) writeHostResponse(hostId, result);
	})();
}

function handleStdoutLine(line: string): void {
	const trimmed = line.trim();
	if (!trimmed) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return;
	}
	const msg = parsed as { type?: string };
	if (msg.type === "host_request") {
		dispatchHostRequest(parsed as { id: unknown; request?: { type?: string } });
		return;
	}
	if (msg.type !== undefined && msg.type !== "result") return;
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
		if (process.env.PI_RUST_KERNEL_DEBUG) console.error(`[pi-rust-kernel:child] ${chunk.trimEnd()}`);
	});
	proc.on("exit", (code, signal) => {
		if (child === proc) child = null;
		stdoutBuffer = "";
		if (pending) {
			const req = pending;
			pending = null;
			req.reject(new Error(`Rust kernel exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}). Last stderr: ${lastStderrTail || "(none)"}`));
		}
	});
}

function resolveChildBin(): string {
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
			if (!spawned) reject(error);
			else if (pending) {
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
		for (const info of rlmChildren.values()) {
			try {
				process.kill(info.pid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
	});
}

function clampTimeout(raw: number | undefined): number {
	if (raw === undefined) return DEFAULT_TIMEOUT_MS;
	return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, raw));
}

function composeSections(r: KernelResponse): string {
	const sections: { label: string; body: string }[] = [];
	if (r.stdout) sections.push({ label: "stdout", body: r.stdout });
	if (r.result !== null && r.result !== undefined) sections.push({ label: "result", body: String(r.result) });
	if (r.stderr) sections.push({ label: "stderr", body: r.stderr });
	if (sections.length === 0) return "";
	if (sections.length === 1) return sections[0].body;
	return sections.map((s) => `[${s.label}]\n${s.body}`).join("\n");
}

function composeResultText(r: KernelResponse): string {
	let text = composeSections(r);
	if (!r.ok && r.error) text += `\n[error] ${r.error.name}: ${r.error.message}`;
	const trimmed = text.trim();
	if (trimmed) return trimmed;
	if (r.ok) return "evaluated to a statement with no value — end with an expression (`x`) or print with println!().";
	return trimmed;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	registerShutdownHook(pi);

	bridgeHandlers = {
		read: readHandler,
		write: writeHandler,
		edit: editHandler,
		"rlm.run": rlmRunHandler,
		"rlm.list": rlmListHandler,
		"rlm.kill": rlmKillHandler,
	};

	const rustToolDefinition = {
		name: "rust",
		label: "rust",
		description:
			"persistent Rust evaluation kernel (evcxr) — evaluated code keeps variables, functions, and types across calls within the session, and can use injected kernel helpers to reach host tools. State dies with the session (a new session starts fresh). The first call compiles a fresh evcxr module and is slow (~5s); subsequent calls are incremental and fast. Available inside evaluated code: kernel::read(path) -> String (hashline-style LINEID file preview), kernel::write(path, content) (create/overwrite), kernel::edit(path, edits_json) (edits = JSON array of {oldText,newText}), kernel::bash(cmd) -> String (child-side shell), kernel::rlm::run(task) (spawn a pi agent, returns its answer), kernel::rlm::list(), kernel::rlm::kill(id). Long-running or never-settling code hits a timeout and the kernel is restarted (state lost).",
		promptSnippet: "rust - single persistent Rust kernel (evcxr) — keeps state across calls; kernel::read/write/edit/bash/rlm.* reach host tools",
		promptGuidelines: [
			"State (variables, functions, types) persists across rust calls within this session; a new session starts fresh.",
			"The first rust call is slow (compiles the evcxr module); subsequent calls are incremental and fast. Reuse the kernel as working memory.",
			"End code with the expression you want to see: `let x = computation(); x` returns x; a bare `let` statement returns no value.",
			"Reach host tools with kernel::read(path), kernel::write(path, content), kernel::edit(path, edits_json) (edits = [{oldText,newText}]), kernel::bash(cmd), and kernel::rlm::run(task). Each returns a String.",
			"Code that exceeds the timeout restarts the kernel and loses all state — keep long-running work incremental.",
		],
		parameters: Type.Object({
			code: Type.String({ description: "Rust source to evaluate in the persistent kernel" }),
			timeoutMs: Type.Optional(Type.Integer({ description: "Per-call timeout in ms. Default 60000, clamped 1000..300000." })),
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
				return {
					content: [{ type: "text" as const, text: `Failed to start the Rust kernel: ${message}. Build the child first (cargo build --release in extensions/pi-rust-kernel/child) or use the nix-built extension.` }],
					details: { status: "error" as const },
				};
			}

			const id = String(++idCounter);
			const responsePromise = new Promise<KernelResponse>((resolve, reject) => {
				pending = { id, resolve, reject };
			});

			let aborted = false;
			let timedOut = false;
			const effectiveTimeout = idCounter === 1 ? Math.max(timeoutMs, MIN_STARTUP_MS) : timeoutMs;

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

			currentBridgeCtx = { cwd: _ctx?.cwd ?? "", model: _ctx?.model?.id ?? "", signal: signal ?? new AbortController().signal };

			let response: KernelResponse;
			try {
				proc.stdin?.write(`${JSON.stringify({ type: "eval", id, code: params.code })}\n`);
				response = await responsePromise;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				let text: string;
				if (timedOut) text = `Timed out after ${effectiveTimeout}ms. Kernel restarted — all REPL state lost.`;
				else if (aborted) text = `Execution aborted. Kernel restarted — all REPL state lost.`;
				else text = message;
				return { content: [{ type: "text" as const, text }], details: { status: "error" as const } };
			} finally {
				clearTimeout(timer);
				currentBridgeCtx = null;
				signal?.removeEventListener("abort", onAbort);
			}

			const text = restartNotice + composeResultText(response);
			return { content: [{ type: "text" as const, text }], details: { status: response.ok ? ("ok" as const) : ("error" as const) } };
		},
	};

	pi.registerTool(rustToolDefinition);

	// A-collapse: rust is the single model-visible tool (mirrors pi-js-kernel).
	// The built-in tools stay registered under the hood (the bridge reuses
	// their file operations) but are hidden from the model; all file/shell/agent
	// work goes through kernel::read/write/edit/bash/rlm.* inside evaluated
	// Rust. Deferred to session_start (pi >=0.84 forbids setActiveTools during
	// extension loading); registerTool above already ran by then.
	pi.on("session_start", () => {
		pi.setActiveTools(["rust"]);
	});
}
