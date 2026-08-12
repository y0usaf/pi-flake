/**
 * pi-agents rpc-child machinery module: subprocess spawn + JSONL event pump
 * for literal `pi --mode rpc` children. Per DESIGN.md: "subprocess spawn +
 * JSONL event pump: spawns pi --mode rpc children via process.execPath with
 * the child-mode env protocol from contract.ts, pumps their JSONL events, and
 * captures tool data from tool_execution_start args".
 *
 * Components:
 * - A minimal hand-rolled JSONL client (pi's own RpcClient spawns
 *   `node <cliPath>` and cannot drive the compiled bun binary via
 *   process.execPath, so we pump stdout ourselves, splitting only on `\n`).
 * - The spawn logic (process.execPath + --mode rpc + session/system/model
 *   flags; the child-mode env protocol; the installed-vs-dev extension rule).
 * - The drive loop (runContract) that replaces contract.ts
 *   runUntilContractFulfilled: send a prompt, read tool_execution_* /
 *   message_end / agent_settled events, mutate ChildState, and nudge until
 *   the contract is fulfilled, the child suspends via ask_parent, or the run
 *   errors out under the nudge cap.
 *
 * No module imports state.ts at runtime beyond types; state.ts owns the
 * ChildEngine interface this module implements.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import {
	MAX_CONTRACT_NUDGES,
	buildChildEnv,
	buildNudgePrompt,
	normalizeContract,
	validateContractAnswers,
	type ContractQuestion,
} from "./contract.js";
import { stripControlSequences } from "./render.js";
import type { ChildEngine, ChildRpcEvent, ChildRpcResponse, ChildState } from "./state.js";

// ---------------------------------------------------------------------------
// Minimal JSONL client (hand-rolled; see module docstring)
// ---------------------------------------------------------------------------

const DEFAULT_RPC_TIMEOUT_MS = 60_000;
/** Graceful-teardown window between SIGTERM and SIGKILL. */
const STOP_GRACE_MS = 3_000;

/**
 * Pump a child's stdout as strict JSONL: split ONLY on \n (never readline,
 * which also splits on U+2028/U+2029 inside JSON strings), strip an optional
 * trailing \r, and hand each complete record to onLine.
 */
function attachJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): () => void {
	let buffer = "";
	const onData = (chunk: Buffer | string) => {
		buffer += chunk.toString();
		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) break;
			const line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
		}
	};
	stream.on("data", onData);
	const onEnd = () => {
		stream.off("data", onData);
		if (buffer.length > 0) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
	};
	stream.once("end", onEnd);
	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}

interface PendingRequest {
	resolve: (response: ChildRpcResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

function makeJsonlClient(proc: ReturnType<typeof spawn>) {
	let exitedInfo: { code: number | null; signal: string | null } | null = null;
	let exitError: Error | undefined;
	let stderrBuf = "";
	let reqId = 0;
	let stopResolve: (() => void) | undefined;
	const pending = new Map<string, PendingRequest>();
	const eventListeners = new Set<(event: ChildRpcEvent) => void>();
	const exitListeners = new Set<(info: { code: number | null; signal: string | null }) => void>();

	const exitPromise = new Promise<void>((resolve) => {
		stopResolve = resolve;
	});

	const failPending = (err: Error) => {
		for (const [, p] of pending) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		pending.clear();
	};

	proc.stderr?.on("data", (chunk: Buffer) => {
		stderrBuf += chunk.toString();
	});

	proc.once("error", (err) => {
		exitError = new Error(`Agent process error: ${err.message}. Stderr: ${stderrBuf.trim()}`);
		failPending(exitError);
	});

	proc.once("exit", (code, signal) => {
		exitedInfo = { code, signal };
		exitError = new Error(`Agent process exited (code=${code} signal=${signal}). Stderr: ${stderrBuf.trim()}`);
		failPending(exitError);
		for (const listener of exitListeners) listener(exitedInfo);
		exitListeners.clear();
		stopResolve?.();
	});

	const handleLine = (line: string) => {
		let data: unknown;
		try {
			data = JSON.parse(line);
		} catch {
			return; // ignore non-JSON lines (startup noise)
		}
		if (typeof data !== "object" || data === null) return;
		const record = data as ChildRpcResponse & ChildRpcEvent;
		if (record.type === "response" && typeof record.id === "string") {
			const request = pending.get(record.id);
			if (request) {
				pending.delete(record.id);
				clearTimeout(request.timer);
				request.resolve(record);
				return;
			}
		}
		for (const listener of eventListeners) listener(record as ChildRpcEvent);
	};
	const unread = attachJsonlReader(proc.stdout!, handleLine);

	return {
		pid: proc.pid ?? -1,
		get exited(): { code: number | null; signal: string | null } | null {
			return exitedInfo;
		},
		get exitError(): Error | undefined {
			return exitError;
		},
		get stderr(): string {
			return stderrBuf;
		},
		onEvent(listener: (event: ChildRpcEvent) => void): () => void {
			eventListeners.add(listener);
			return () => eventListeners.delete(listener);
		},
		onExit(listener: (info: { code: number | null; signal: string | null }) => void): () => void {
			if (exitedInfo) listener(exitedInfo);
			else exitListeners.add(listener);
			return () => exitListeners.delete(listener);
		},
		send(command: Record<string, unknown>): Promise<ChildRpcResponse> {
			if (exitedInfo) return Promise.reject(exitError ?? new Error("Agent process exited"));
			const stdin = proc.stdin;
			if (!stdin || stdin.destroyed || !stdin.writable) {
				return Promise.reject(new Error(`Agent process stdin is not writable. Stderr: ${stderrBuf.trim()}`));
			}
			const id = `req_${++reqId}`;
			return new Promise<ChildRpcResponse>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`RPC timeout waiting for response to ${String(command.type)}. Stderr: ${stderrBuf.trim()}`));
				}, DEFAULT_RPC_TIMEOUT_MS);
				pending.set(id, { resolve, reject, timer });
				try {
					stdin.write(JSON.stringify({ ...command, id }) + "\n");
				} catch (err) {
					pending.delete(id);
					clearTimeout(timer);
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			});
		},
		async stop(): Promise<void> {
			if (exitedInfo || proc.pid === undefined) return;
			proc.kill("SIGTERM");
			await Promise.race([
				exitPromise,
				new Promise<void>((resolve) => {
					setTimeout(() => {
						if (exitedInfo === null && proc.pid !== undefined) proc.kill("SIGKILL");
						resolve();
					}, STOP_GRACE_MS);
				}),
			]);
		},
		waitForExit(): Promise<void> {
			return exitedInfo ? Promise.resolve() : exitPromise;
		},
		// Keep the reader attached (and the stream referenced) until teardown.
		closeReader: unread,
	};
}

export type JsonlClient = ReturnType<typeof makeJsonlClient>;

// ---------------------------------------------------------------------------
// Spawn: process.execPath + --mode rpc + child-mode env protocol
// ---------------------------------------------------------------------------

/** Default child session dir, resolved against the parent cwd at use time. */
export const DEFAULT_CHILD_SESSION_DIR = ".pi/agents/sessions";

export interface RpcChildSpawnOptions {
	childId: string;
	cwd: string;
	systemPrompt: string;
	/** Resolved child model; omitted to inherit the child's default. */
	model?: Model<any>;
	contract: ContractQuestion[];
	parentDepth: number;
	/** Absolute path to the child's session directory. */
	sessionDir: string;
}

/**
 * Resolve whether this loaded copy is the installed (nix-bundled) one or a
 * dev/source copy. The installed package.json's pi.extensions entry is the
 * generated `./.pi-gate.ts`; the source copy declares `./index.ts`.
 */
async function resolveExtensionMode(): Promise<{ ownDir: string; installed: boolean }> {
	const ownDir = dirname(fileURLToPath(import.meta.url));
	try {
		const pkg = JSON.parse(await readFile(join(ownDir, "package.json"), "utf8")) as { pi?: { extensions?: string[] } };
		const entries = pkg.pi?.extensions ?? [];
		const installed = entries.some((entry) => typeof entry === "string" && entry.includes(".pi-gate"));
		return { ownDir, installed };
	} catch {
		// Unreadable package.json (defensive): behave like the source copy.
		return { ownDir, installed: false };
	}
}

/**
 * Spawn a `pi --mode rpc` child via process.execPath. The child's env is the
 * full parent env plus the child-mode protocol (buildChildEnv) plus, for a
 * dev/source copy, a PI_EXT_DISABLED suffix that stops a co-installed bundled
 * copy from double-registering when we pass `-e <own dir>`. Always uses a
 * durable session dir (never --no-session). Captures the child's session file
 * from get_state (its name is a random uuidv7, not computable).
 */
export async function spawnRpcChild(options: RpcChildSpawnOptions): Promise<ChildEngine> {
	const { cwd, systemPrompt, model, contract, parentDepth, sessionDir } = options;
	const { ownDir, installed } = await resolveExtensionMode();

	const args = ["--mode", "rpc", "--session-dir", sessionDir, "--system-prompt", systemPrompt];
	if (model) args.push("--model", `${model.provider}/${model.id}`);
	if (!installed) {
		// Dev/source copy: load ourselves explicitly and disable the bundled
		// gate-named copy (PI_EXT_DISABLED is comma-separated and trimmed).
		args.push("-e", ownDir);
	}

	const env: NodeJS.ProcessEnv = { ...process.env, ...buildChildEnv(contract, parentDepth + 1) };
	if (!installed) {
		const existingPI_EXT_DISABLED = process.env.PI_EXT_DISABLED;
		env.PI_EXT_DISABLED = existingPI_EXT_DISABLED ? `${existingPI_EXT_DISABLED},agents` : "agents";
	}

	const proc = spawn(process.execPath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
	const client = makeJsonlClient(proc);

	// Capture the durable session file before the first prompt.
	let sessionFile: string | undefined;
	const stateResp = await client.send({ type: "get_state" });
	if (stateResp.success && typeof (stateResp.data as { sessionFile?: unknown } | undefined)?.sessionFile === "string") {
		sessionFile = (stateResp.data as { sessionFile: string }).sessionFile;
	}

	const engine: ChildEngine = {
		pid: client.pid,
		sessionFile,
		get alive() {
			return client.exited === null;
		},
		get exitError() {
			return client.exitError;
		},
		onEvent(listener) {
			return client.onEvent(listener);
		},
		onExit(listener) {
			return client.onExit(listener);
		},
		send(command) {
			return client.send(command);
		},
		abort() {
			client.stop().catch(() => {});
		},
		stop() {
			return client.stop();
		},
		waitForIdle() {
			return client.waitForExit();
		},
	};
	return engine;
}

// ---------------------------------------------------------------------------
// Drive loop (replaces contract.ts runUntilContractFulfilled)
// ---------------------------------------------------------------------------

export interface RunContractOptions {
	prompt: string;
	allowAsk: boolean;
	signal?: AbortSignal;
}

/**
 * Drive the child until its contract is fulfilled (state.contract.answers
 * set), the child suspends via ask_parent (state.contract.pendingAsk set), or
 * the run fails. Mutates ChildState from the RPC event stream: caches
 * tool_execution_start args (present on start, absent on end), joins them
 * with tool_execution_end isError, appends reports on report start, and
 * accumulates usage on assistant message_end. On agent_settled: fulfilled →
 * return; suspended → return (process stays alive); neither → nudge (capped
 * at MAX_CONTRACT_NUDGES), then error. A process exit mid-drive rejects the
 * pending settle wait so the run fails with the exit error.
 */
export async function runContract(state: ChildState, options: RunContractOptions): Promise<void> {
	const engine = state.engine;
	if (!engine) throw new Error(`Agent "${state.id}" has no live RPC process`);
	const { prompt, allowAsk, signal } = options;

	const toolArgs = new Map<string, Record<string, unknown>>();
	let driveError: Error | undefined;
	let settleWait: ((err?: unknown) => void) | null = null;

	const wakeSettle = (err?: unknown) => {
		const fn = settleWait;
		settleWait = null;
		if (fn) fn(err);
	};

	const unsubEvent = engine.onEvent((event: ChildRpcEvent) => {
		try {
			switch (event.type) {
				case "tool_execution_start": {
					const args = (event.args as Record<string, unknown> | undefined) ?? {};
					if (typeof event.toolCallId === "string") toolArgs.set(event.toolCallId, args);
					if (event.toolName === "report" && typeof args.message === "string") {
						state.reports.push(stripControlSequences(args.message));
					}
					break;
				}
				case "tool_execution_end": {
					if (event.isError) break;
					const args = typeof event.toolCallId === "string" ? toolArgs.get(event.toolCallId) : undefined;
					if (event.toolName === "submit_answers" && Array.isArray(args?.answers)) {
						// Defense in depth: re-validate parent-side (the child's own
						// submit_answers already validates and errors via isError).
						const answers = validateContractAnswers(state.contract.questions, args.answers as Array<{ id: string; value: string }>);
						state.contract.pendingAsk = undefined;
						state.contract.answers = answers;
					} else if (event.toolName === "ask_parent" && Array.isArray(args?.questions)) {
						const questions = normalizeContract(args.questions, `ask_parent from "${state.id}"`);
						state.askCount++;
						state.contract.pendingAsk = questions;
						state.awaitingSince = Date.now();
					}
					break;
				}
				case "agent_settled": {
					toolArgs.clear();
					wakeSettle();
					break;
				}
			}
		} catch (err) {
			driveError = err instanceof Error ? err : new Error(String(err));
			wakeSettle();
		}
	});
	const unsubExit = engine.onExit(() => {
		wakeSettle(engine.exitError ?? new Error(`Agent "${state.id}" process exited unexpectedly`));
	});

	try {
		let promptText = prompt;
		for (;;) {
			const settled = new Promise<void>((resolve, reject) => {
				settleWait = (err?: unknown) => {
					if (err) reject(err instanceof Error ? err : new Error(String(err)));
					else resolve();
				};
			});
			settled.catch(() => {});
			try {
				const resp = await engine.send({ type: "prompt", message: promptText });
				if (!resp.success) throw new Error(`RPC ${resp.command ?? "prompt"} failed: ${resp.error ?? "unknown"}`);
			} catch (err) {
				settleWait = null; // drop the pre-registered wait; it will never fire
				throw err;
			}
			await settled;
			if (driveError) throw driveError;
			if (state.contract.answers) return;
			if (state.contract.pendingAsk) return;
			if (signal?.aborted) throw new Error(`Agent "${state.id}" aborted while running`);
			if (state.killed) throw new Error(`Agent "${state.id}" was killed while running`);
			if (state.nudges >= MAX_CONTRACT_NUDGES) {
				throw new Error(`Agent "${state.id}" ended ${state.nudges} nudged run(s) without calling submit_answers; contract unfulfilled`);
			}
			state.nudges++;
			promptText = buildNudgePrompt(state.contract.questions, allowAsk);
		}
	} finally {
		unsubEvent();
		unsubExit();
		settleWait = null;
	}
}
