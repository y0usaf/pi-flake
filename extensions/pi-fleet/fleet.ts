/**
 * pi-fleet reasonix worker layer (machinery + decision-making):
 * - rx_run: spawn one `reasonix subagent run` worker, stream stdout, wait exit.
 * - rx_fleet: run a fleet loop over a manifest (slices, deps, worktrees,
 *   backoff relaunch, READY_FOR_REVIEW detection). No auto-merge: the manager
 *   (a full pi session) reviews and merges ready branches itself.
 * - rx_list/rx_kill/rx_output: supervise the worker table.
 *
 * Durable state lives under the fleet state dir:
 *   fleet.log, <slice>/RUNNING|READY_FOR_REVIEW|DONE, <slice>/run.log
 * Markers survive the session; the worker table (Map) is per-session.
 *
 * A worker is NOT a pi child: reasonix has no RPC/contract protocol, so there
 * is no ChildState/engine here. The worker table is separate from pi-agent's
 * child registry (see DESIGN.md: two registries, not one union).
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiAgentsConfig } from "./config.js";
import { stripControlSequences } from "./render.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants (tunables; the manifest/config layers override where noted)
// ---------------------------------------------------------------------------
const DEFAULT_BASE = "main";
const DEFAULT_MAX_STEPS = 0; // reasonix: 0 = automatic
const DEFAULT_TIMEOUT_SECONDS = 8 * 3600;
const BASE_BACKOFF_SEC = 5;
const MAX_BACKOFF_SEC = 300;
const DEP_POLL_MS = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FleetSlice {
	id: string;
	profile: string;
	task: string;
	deps: string; // whitespace slice ids or "_"
	worktree?: string;
	model?: string;
	maxSteps?: number;
}

export interface FleetManifest {
	project: string;
	repo?: string;
	base?: string;
	stateDir?: string;
	noGit?: boolean;
	timeoutSeconds?: number;
	maxIters?: number;
	slices: FleetSlice[];
}

export type WorkerStatus = "queued" | "running" | "ready" | "done" | "failed" | "killed";

export interface WorkerState {
	id: string;
	profile: string;
	task: string;
	dir: string;
	model?: string;
	maxSteps: number;
	status: WorkerStatus;
	pid?: number;
	proc?: ChildProcess;
	iter: number;
	createdAt: number;
	exitCode?: number | null;
	killed: boolean;
	stateDir: string;
	logFile: string;
}

export interface FleetDetails {
	project: string;
	stateDir: string;
	ready: string[];
	failed: string[];
	killed: string[];
	workers: Array<{ id: string; status: WorkerStatus; iter: number; exitCode: number | null | undefined }>;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function ts(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function logLine(path: string, text: string): Promise<void> {
	await appendFile(path, `${new Date().toISOString()} ${text}\n`);
}

async function git(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await execFileAsync("git", args, { cwd });
		return { code: 0, stdout, stderr };
	} catch (err) {
		const e = err as { code?: number; stdout?: string; stderr?: string };
		return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
	}
}

async function touch(path: string): Promise<void> {
	await writeFile(path, "");
}

function splitDeps(deps: string): string[] {
	return deps
		.trim()
		.split(/\s+/)
		.filter((dep) => dep !== "" && dep !== "_");
}

function depReady(stateDir: string, id: string): boolean {
	return existsSync(join(stateDir, id, "READY_FOR_REVIEW")) || existsSync(join(stateDir, id, "DONE"));
}

// ---------------------------------------------------------------------------
// reasonix worker spawn
// ---------------------------------------------------------------------------

interface WorkerRunResult {
	code: number | null;
	signal: string | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
}

/**
 * Spawn one `reasonix subagent run <profile> --dir <dir> --max-steps N [--model M] <task>`.
 * Streams complete stdout lines to onLine (ANSI stripped), captures full stdout
 * and stderr for the caller to persist. Resolves on exit or abort/timeout.
 */
function runReasonixWorker(opts: {
	bin: string;
	profile: string;
	task: string;
	dir: string;
	model?: string;
	maxSteps: number;
	timeoutSeconds: number;
	signal?: AbortSignal;
	onLine?: (line: string) => void;
	onProc?: (proc: ChildProcess) => void;
}): Promise<WorkerRunResult> {
	const { bin, profile, task, dir, model, maxSteps, timeoutSeconds, signal, onLine, onProc } = opts;
	const args = ["subagent", "run", profile, "--dir", dir, "--max-steps", String(maxSteps)];
	if (model) args.push("--model", model);
	args.push(task);

	return new Promise((resolveRun) => {
		let settled = false;
		let timedOut = false;
		let stdoutBuf = "";
		let stderrBuf = "";
		let lineBuf = "";
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abortListener: (() => void) | undefined;

		const finish = (code: number | null, sig: string | null) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (abortListener && signal) signal.removeEventListener("abort", abortListener);
			if (lineBuf.trim() && onLine) onLine(stripControlSequences(lineBuf));
			resolveRun({ code, signal: sig, timedOut, stdout: stdoutBuf, stderr: stderrBuf });
		};

		let proc: ChildProcess;
		try {
			proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
			onProc?.(proc);
		} catch (err) {
			finish(1, null);
			return;
		}

		proc.on("error", (err) => {
			stderrBuf += `spawn error: ${err.message}\n`;
			finish(1, null);
		});

		proc.stdout?.on("data", (chunk: Buffer | string) => {
			const text = chunk.toString();
			stdoutBuf += text;
			lineBuf += text;
			while (true) {
				const nl = lineBuf.indexOf("\n");
				if (nl === -1) break;
				const line = lineBuf.slice(0, nl);
				lineBuf = lineBuf.slice(nl + 1);
				if (onLine) onLine(stripControlSequences(line));
			}
		});

		proc.stderr?.on("data", (chunk: Buffer | string) => {
			stderrBuf += chunk.toString();
		});

		proc.on("exit", (code, sig) => finish(code, sig));

		if (timeoutSeconds > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				proc.kill("SIGKILL");
			}, timeoutSeconds * 1000);
		}

		if (signal) {
			abortListener = () => {
				timedOut = true;
				proc.kill("SIGKILL");
			};
			if (signal.aborted) {
				timedOut = true;
				proc.kill("SIGKILL");
			} else {
				signal.addEventListener("abort", abortListener);
			}
		}
	});
}

// ---------------------------------------------------------------------------
// Fleet machinery
// ---------------------------------------------------------------------------

async function ensureWorktree(repo: string, base: string, id: string, wt: string): Promise<void> {
	if (existsSync(join(wt, ".git"))) return;
	const branch = await git(["show-ref", "--verify", "--quiet", `refs/heads/${id}`], repo);
	if (branch.code === 0) {
		await git(["worktree", "add", "--detach", wt, base], repo);
		await git(["checkout", "-B", id], wt);
	} else {
		await git(["worktree", "add", "-b", id, wt, base], repo);
	}
}

async function syncFromBase(base: string, wt: string): Promise<void> {
	const ff = await git(["merge", "--ff-only", base], wt);
	if (ff.code !== 0) await git(["merge", base, "--no-edit"], wt);
}

/** True when the worktree branch has committed closure work ahead of base. */
async function hasClosureCommits(base: string, wt: string): Promise<boolean> {
	const rev = await git(["rev-list", `${base}..HEAD`], wt);
	return rev.code === 0 && rev.stdout.trim() !== "";
}

interface SliceLoopResult {
	id: string;
	status: "ready" | "failed" | "killed";
	iter: number;
	exitCode: number | null | undefined;
}

function computeBackoff(failures: number): number {
	let backoff = BASE_BACKOFF_SEC * 2 ** failures;
	if (backoff > MAX_BACKOFF_SEC) backoff = MAX_BACKOFF_SEC;
	return backoff;
}

// ---------------------------------------------------------------------------
// Factory (per-session state lives in the returned closure)
// ---------------------------------------------------------------------------

export interface FleetDeps {
	getConfig: (cwd: string) => Promise<PiAgentsConfig>;
}

export interface FleetHandle {
	workers: Map<string, WorkerState>;
	registerTools(pi: ExtensionAPI): void;
	shutdown(): Promise<void>;
}

export function createFleet(deps: FleetDeps): FleetHandle {
	const workers = new Map<string, WorkerState>();

	// ---- rx_run -----------------------------------------------------------

	const rxRunSchema = Type.Object({
		id: Type.String({ description: "Unique worker id (slice id when used inside a fleet)" }),
		profile: Type.String({ description: "reasonix subagent profile name (the worker role)" }),
		task: Type.String({ description: "Task for this worker" }),
		dir: Type.String({ description: "Working directory (worktree or project dir)" }),
		model: Type.Optional(Type.String({ description: 'Model override "provider/modelId" (optional)' })),
		max_steps: Type.Optional(Type.Number({ description: "reasonix --max-steps; 0 = automatic" })),
		timeout_seconds: Type.Optional(Type.Number({ description: "Wall-clock seconds before SIGKILL" })),
	});

	const renderTextResult = (result: AgentToolResult<unknown>) => {
		const first = result.content[0];
		return new Text(first?.type === "text" ? first.text : "done", 0, 0);
	};

	function registerRxRun(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "rx_run",
			label: "Reasonix Worker",
			description:
				"Run ONE reasonix subagent worker: spawns `reasonix subagent run <profile> --dir <dir> <task>`, streams its stdout, and returns the exit code plus output tail. " +
				"The worker runs in a worktree/project dir you prepared (e.g. via git worktree add through the bash tool). " +
				"Use this for a single slice; use rx_fleet for a manifest-driven fleet loop with deps and backoff.",
			parameters: rxRunSchema,
			renderCall(args, theme) {
				return new Text(theme.fg("toolTitle", theme.bold("rx_run ")) + theme.fg("accent", args.id || "..."), 0, 0);
			},
			renderResult: renderTextResult,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const config = await deps.getConfig(ctx.cwd);
				const bin = config.reasonix ?? "reasonix";
				const stateDir = join(resolve(ctx.cwd, ".pi", "fleets"), "adhoc", params.id);
				await mkdir(stateDir, { recursive: true });
				const logFile = join(stateDir, "run.log");
				const worker: WorkerState = {
					id: params.id,
					profile: params.profile,
					task: params.task,
					dir: params.dir,
					model: params.model,
					maxSteps: params.max_steps ?? DEFAULT_MAX_STEPS,
					status: "running",
					iter: 1,
					createdAt: Date.now(),
					killed: false,
					stateDir,
					logFile,
				};
				workers.set(params.id, worker);
				try {
					const result = await runReasonixWorker({
						bin,
						profile: params.profile,
						task: params.task,
						dir: params.dir,
						model: params.model,
						maxSteps: params.max_steps ?? DEFAULT_MAX_STEPS,
						timeoutSeconds: params.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
						signal,
						onProc: (p) => {
							worker.proc = p;
							worker.pid = p.pid ?? undefined;
						},
						onLine: (line) => {
							if (line.trim()) onUpdate({ content: [{ type: "text", text: line }], details: { workerId: params.id } });
						},
					});
					worker.pid = undefined;
					worker.proc = undefined;
					worker.exitCode = result.code;
					worker.status = result.timedOut ? "failed" : result.code === 0 ? "done" : "failed";
					await appendFile(logFile, result.stdout + (result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""));
					const tail = result.stdout.trim().split("\n").slice(-40).join("\n") || result.stderr.trim().slice(-2000) || "(no output)";
					return {
						content: [{ type: "text", text: `rx_run ${params.id} exited code=${result.code}${result.timedOut ? " (timeout)" : ""}\n\n${tail}` }],
						details: { workerId: params.id, exitCode: result.code, timedOut: result.timedOut },
					};
				} finally {
					workers.delete(params.id);
				}
			},
		});
	}

	// ---- rx_fleet ---------------------------------------------------------

	const sliceSchema = Type.Object({
		id: Type.String({ description: "Slice id (also the worktree branch name)" }),
		profile: Type.String({ description: "reasonix subagent profile name" }),
		task: Type.String({ description: "Worker task for this slice" }),
		deps: Type.Optional(Type.String({ description: 'Whitespace slice ids this slice waits on, or "_" (none)' })),
		worktree: Type.Optional(Type.String({ description: "Worktree dir; default <stateDir>/worktrees/<id>" })),
		model: Type.Optional(Type.String({ description: 'Model override "provider/modelId"' })),
		maxSteps: Type.Optional(Type.Number({ description: "reasonix --max-steps; 0 = automatic" })),
	});

	const manifestSchema = Type.Object({
		project: Type.String({ description: "Fleet/project name (also default state dir name)" }),
		repo: Type.Optional(Type.String({ description: "Git repo path; required unless noGit" })),
		base: Type.Optional(Type.String({ description: "Base branch/ref; default main" })),
		stateDir: Type.Optional(Type.String({ description: "Fleet state dir; default <config fleetStateDir>/<project>" })),
		noGit: Type.Optional(Type.Boolean({ description: "true = run slices in repo as cwd, no worktrees" })),
		timeoutSeconds: Type.Optional(Type.Number({ description: "Per-worker wall-clock seconds; default 28800" })),
		maxIters: Type.Optional(Type.Number({ description: "Max relaunch iterations per slice; 0 = unlimited" })),
		slices: Type.Array(sliceSchema, { minItems: 1, description: "Slices to run; disjoint worktrees keep fan-out safe" }),
	});

	const fleetSchema = Type.Object({ manifest: manifestSchema });

	function registerRxFleet(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "rx_fleet",
			label: "Reasonix Fleet",
			description:
				"Run a fleet loop over a manifest: one reasonix subagent worker per slice, each in its own worktree, with dependency waiting, exponential-backoff relaunch, and READY_FOR_REVIEW detection. " +
				"Blocks until every slice is ready, failed, or killed. Does NOT merge: a git slice is READY when its branch has closure commits ahead of base; the caller (a manager session) reviews and merges via git. " +
				"Slices must own DISJOINT source paths — worktree isolation is what makes fan-out safe.",
			parameters: fleetSchema,
			renderCall(args, theme) {
				const m = (args as { manifest?: FleetManifest }).manifest;
				return new Text(theme.fg("toolTitle", theme.bold("rx_fleet ")) + theme.fg("accent", m?.project ?? "...") + (m ? theme.fg("muted", ` · ${m.slices.length} slices`) : ""), 0, 0);
			},
			renderResult: renderTextResult,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const manifest = params.manifest as FleetManifest;
				const config = await deps.getConfig(ctx.cwd);
				return runFleetLoop(manifest, config, signal, onUpdate);
			},
		});
	}

	async function runFleetLoop(manifest: FleetManifest, config: PiAgentsConfig, signal: AbortSignal | undefined, onUpdate: ((partial: AgentToolResult<unknown>) => void) | undefined): Promise<AgentToolResult<FleetDetails>> {
		const project = manifest.project;
		const repo = manifest.repo;
		const base = manifest.base ?? DEFAULT_BASE;
		const noGit = manifest.noGit === true;
		const bin = config.reasonix ?? "reasonix";
		const timeoutSeconds = manifest.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
		const maxIters = manifest.maxIters ?? 0;

		if (!project) throw new Error("rx_fleet: manifest.project is required");
		if (!noGit && !repo) throw new Error("rx_fleet: manifest.repo is required unless noGit is true");
		if (manifest.slices.length === 0) throw new Error("rx_fleet: manifest.slices must be non-empty");

		const stateDir = manifest.stateDir ?? join(resolve(config.fleetStateDir ?? ".pi/fleets"), project);
		await mkdir(stateDir, { recursive: true });
		const fleetLog = join(stateDir, "fleet.log");
		await logLine(fleetLog, `${project} fleet starting (repo=${repo ?? "-"} base=${base} noGit=${noGit})`);

		// Pre-flight: validate slices + ensure worktrees before fan-out.
		for (const slice of manifest.slices) {
			if (!slice.id || !slice.profile || !slice.task) {
				throw new Error(`rx_fleet: slice missing id/profile/task: ${JSON.stringify(slice)}`);
			}
		}
		if (!noGit) {
			for (const slice of manifest.slices) {
				const wt = slice.worktree ?? join(stateDir, "worktrees", slice.id);
				await ensureWorktree(repo!, base, slice.id, wt);
			}
		}

		const results = await Promise.all(
			manifest.slices.map((slice) =>
				runSliceLoop({
					slice,
					manifest,
					repo: repo ?? "",
					base,
					noGit,
					bin,
					timeoutSeconds,
					maxIters,
					stateDir,
					fleetLog,
					signal,
					onUpdate,
				}),
			),
		);

		const ready = results.filter((r) => r.status === "ready").map((r) => r.id);
		const failed = results.filter((r) => r.status === "failed").map((r) => r.id);
		const killed = results.filter((r) => r.status === "killed").map((r) => r.id);
		await logLine(fleetLog, `${project} fleet exiting (ready=${ready.length} failed=${failed.length} killed=${killed.length})`);

		const details: FleetDetails = {
			project,
			stateDir,
			ready,
			failed,
			killed,
			workers: [...workers.values()].map((w) => ({ id: w.id, status: w.status, iter: w.iter, exitCode: w.exitCode })),
		};
		const text =
			`rx_fleet ${project}: ready=${ready.length} failed=${failed.length} killed=${killed.length}\n` +
			(ready.length ? `Ready: ${ready.join(", ")}\n` : "") +
			(failed.length ? `Failed: ${failed.join(", ")}\n` : "") +
			(killed.length ? `Killed: ${killed.join(", ")}\n` : "") +
			`State: ${stateDir}`;
		return { content: [{ type: "text", text }], details };
	}

	async function runSliceLoop(opts: {
		slice: FleetSlice;
		manifest: FleetManifest;
		repo: string;
		base: string;
		noGit: boolean;
		bin: string;
		timeoutSeconds: number;
		maxIters: number;
		stateDir: string;
		fleetLog: string;
		signal?: AbortSignal;
		onUpdate?: (partial: AgentToolResult<unknown>) => void;
	}): Promise<SliceLoopResult> {
		const { slice, repo, base, noGit, bin, timeoutSeconds, maxIters, stateDir, fleetLog, signal, onUpdate } = opts;
		const id = slice.id;
		const sdir = join(stateDir, id);
		await mkdir(sdir, { recursive: true });
		const runLog = join(sdir, "run.log");
		const workdir = noGit ? repo : (slice.worktree ?? join(stateDir, "worktrees", id));

		// Wait on deps (READY_FOR_REVIEW/DONE markers).
		const deps = splitDeps(slice.deps ?? "_");
		for (const dep of deps) {
			while (!depReady(stateDir, dep)) {
				if (signal?.aborted) return { id, status: "killed", iter: 0, exitCode: undefined };
				await logLine(fleetLog, `[${id}] waiting on dep '${dep}'`);
				await sleep(DEP_POLL_MS);
			}
			await logLine(fleetLog, `[${id}] dep '${dep}' ready`);
		}

		let iter = 0;
		let failures = 0;
		for (;;) {
			if (signal?.aborted) return { id, status: "killed", iter, exitCode: undefined };
			if (maxIters > 0 && iter >= maxIters) {
				await logLine(fleetLog, `[${id}] reached maxIters=${maxIters}, failed`);
				return { id, status: "failed", iter, exitCode: undefined };
			}
			const existing = workers.get(id);
			if (existing?.killed) return { id, status: "killed", iter, exitCode: undefined };

			if (!noGit) await syncFromBase(base, workdir);
			iter++;
			await logLine(fleetLog, `[${id}] iteration ${iter}`);
			await touch(join(sdir, "RUNNING"));

			const worker: WorkerState = {
				id,
				profile: slice.profile,
				task: slice.task,
				dir: workdir,
				model: slice.model,
				maxSteps: slice.maxSteps ?? DEFAULT_MAX_STEPS,
				status: "running",
				iter,
				createdAt: Date.now(),
				killed: false,
				stateDir: sdir,
				logFile: runLog,
			};
			workers.set(id, worker);

			const result = await runReasonixWorker({
				bin,
				profile: slice.profile,
				task: slice.task,
				dir: workdir,
				model: slice.model,
				maxSteps: slice.maxSteps ?? DEFAULT_MAX_STEPS,
				timeoutSeconds,
				signal,
				onProc: (p) => {
					worker.proc = p;
					worker.pid = p.pid ?? undefined;
				},
				onLine: (line) => {
					if (line.trim()) onUpdate?.({ content: [{ type: "text", text: `[${id}] ${line}` }], details: { workerId: id } });
				},
			});

			worker.proc = undefined;
			worker.pid = undefined;
			worker.exitCode = result.code;
			await appendFile(runLog, result.stdout + (result.stderr ? `\n--- stderr ---\n${result.stderr}` : ""));
			await rm(join(sdir, "RUNNING"), { force: true });

			if (worker.killed) {
				worker.status = "killed";
				await logLine(fleetLog, `[${id}] killed`);
				return { id, status: "killed", iter, exitCode: result.code };
			}

			// Ready detection.
			if (noGit) {
				if (result.code === 0 && !result.timedOut) {
					worker.status = "done";
					await touch(join(sdir, "READY_FOR_REVIEW"));
					await touch(join(sdir, "DONE"));
					await logLine(fleetLog, `[${id}] noGit clean exit; READY`);
					return { id, status: "ready", iter, exitCode: result.code };
				}
			} else if (await hasClosureCommits(base, workdir)) {
				worker.status = "ready";
				await touch(join(sdir, "READY_FOR_REVIEW"));
				await logLine(fleetLog, `[${id}] closure commits ahead of base; READY_FOR_REVIEW`);
				return { id, status: "ready", iter, exitCode: result.code };
			}

			worker.status = "failed";
			await logLine(fleetLog, `[${id}] iteration ${iter} no closure (exit=${result.code}${result.timedOut ? " timeout" : ""}); backoff`);
			failures++;
			await sleep(computeBackoff(failures - 1));
		}
	}

	// ---- rx_list / rx_kill / rx_output ------------------------------------

	const listSchema = Type.Object({});
	const killSchema = Type.Object({ id: Type.String({ description: "Worker/slice id to kill" }) });
	const outputSchema = Type.Object({ id: Type.String({ description: "Worker/slice id to inspect" }) });

	function registerRxList(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "rx_list",
			label: "List Workers",
			description: "List the worker table: id, status, iteration, exit code, profile, and working dir.",
			parameters: listSchema,
			renderCall(_args, theme) {
				return new Text(theme.fg("toolTitle", theme.bold("rx_list")), 0, 0);
			},
			renderResult: renderTextResult,
			async execute() {
				const rows = [...workers.values()];
				const text =
					rows.length === 0
						? "No active workers."
						: rows.map((w) => `• ${w.id} — ${w.status}, iter ${w.iter}, exit ${w.exitCode ?? "-"}, ${w.profile}, ${w.dir}`).join("\n");
				return { content: [{ type: "text", text }], details: { workers: rows.map((w) => ({ id: w.id, status: w.status, iter: w.iter, exitCode: w.exitCode })) } };
			},
		});
	}

	function registerRxKill(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "rx_kill",
			label: "Kill Worker",
			description: "Kill a worker (or a slice inside a running fleet): SIGKILLs its process and marks it killed so the fleet loop stops relaunching it.",
			parameters: killSchema,
			renderCall(args, theme) {
				return new Text(theme.fg("toolTitle", theme.bold("rx_kill ")) + theme.fg("error", args.id || "..."), 0, 0);
			},
			renderResult: renderTextResult,
			async execute(_toolCallId, params) {
				const worker = workers.get(params.id);
				if (!worker) return { content: [{ type: "text", text: `No worker "${params.id}" in the table.` }], details: {} };
				worker.killed = true;
				worker.proc?.kill("SIGKILL");
				worker.status = "killed";
				return { content: [{ type: "text", text: `Killed worker "${params.id}".` }], details: { workerId: params.id } };
			},
		});
	}

	function registerRxOutput(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "rx_output",
			label: "Worker Output",
			description: "Peek at a worker's run.log tail plus its current table status.",
			parameters: outputSchema,
			renderCall(args, theme) {
				return new Text(theme.fg("toolTitle", theme.bold("rx_output ")) + theme.fg("accent", args.id || "..."), 0, 0);
			},
			renderResult: renderTextResult,
			async execute(_toolCallId, params) {
				const worker = workers.get(params.id);
				let tail = "(no run.log)";
				try {
					const raw = await readFile(worker?.logFile ?? join(worker?.stateDir ?? ".", "run.log"), "utf8");
					tail = raw.trim().split("\n").slice(-60).join("\n") || "(empty)";
				} catch {
					// missing log: keep the default tail
				}
				const header = worker ? `status ${worker.status}, iter ${worker.iter}, exit ${worker.exitCode ?? "-"}` : `"${params.id}" not in worker table`;
				return { content: [{ type: "text", text: `${header}\n\n${tail}` }], details: { workerId: params.id } };
			},
		});
	}

	// ---- registration + teardown -----------------------------------------

	function registerTools(pi: ExtensionAPI): void {
		registerRxRun(pi);
		registerRxFleet(pi);
		registerRxList(pi);
		registerRxKill(pi);
		registerRxOutput(pi);
	}

	async function shutdown(): Promise<void> {
		for (const worker of workers.values()) {
			worker.killed = true;
			worker.proc?.kill("SIGKILL");
		}
		workers.clear();
	}

	return { workers, registerTools, shutdown };
}
