/**
 * Subagent host handlers: `rlm.run` / `rlm.list_subagents` / `rlm.delete_subagent`,
 * plus the orchestration surface `rlm.panel` (concurrent multi-model),
 * `rlm.loop` (declarative workflow), `rlm.peek` (live output), and the
 * `rlm.list` / `rlm.kill` aliases.
 *
 * Spawning returns as soon as the child is admitted, never when it is done: a
 * parent that blocked on its children could not supervise them, and a handle is
 * useful immediately while an answer is not. Results therefore arrive through
 * the filesystem — each child's final output is written to
 * `<subagentDir>/<child_id>.output.md` — and the registry reports whether a
 * child is running, completed, or errored so the parent can decide when to read.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostRequestHandlers } from "../engine/index.js";
import type { FrameRecord } from "./frames.js";

export type SubagentStatus = "running" | "completed" | "error";

export interface SubagentEntry {
	rlm_child_id: string;
	session_name: string;
	session_dir: string;
	output_file: string;
	model: string;
	status: SubagentStatus;
	exit_code: number | null;
	pid: number | undefined;
}

export interface SubagentHostOptions {
	cwd: string;
	/** Directory for child session files and output files. */
	subagentDir: string;
	/** provider/model for children unless kwargs.model overrides. */
	defaultModel: string;
	/**
	 * Auth-configured "provider/id" strings used to pick distinct panel models.
	 * Empty when unknown; panel then repeats defaultModel.
	 */
	availableModels?: string[];
	/** Recursion depth of THIS agent; children get depth + 1. */
	depth: number;
	maxDepth: number;
	/**
	 * The id the parent assigned THIS agent (PI_RLM_CHILD_ID), stamped into
	 * every frame record it writes so grandchildren link back to it. Absent at
	 * the root: its frames are linked by spawn cell alone.
	 */
	selfChildId?: string;
	/** Override the spawned command for tests. Receives the fully built args. */
	spawnCommand?: (entry: SubagentEntry, prompt: string) => { command: string; args: string[] };
}

export const MAX_SUBAGENT_NAME_LENGTH = 64;

/**
 * Volume-tier names, in preference order. Fan-out economics only work at
 * volume prices — inheriting the parent would run children at flagship rates
 * while a 25x cheaper model sits in the same account (sol at $5/$30 vs luna
 * at $0.20/$1.20 per MTok) — and the industry names its volume tiers
 * consistently enough that matching the name beats maintaining a per-provider
 * table that goes stale with every model launch. Ordered best-for-fan-out
 * first: the dedicated volume flagships, then the mini/nano/lite ladders.
 * Tokens match whole hyphen/dot-delimited segments: "mini" must find
 * gpt-5.4-mini and never gemini-3-pro, whose name merely contains the letters.
 */
const VOLUME_TIER_PATTERNS = ["haiku", "luna", "flash", "mini", "nano", "lite"].map(
	(token) => new RegExp(`(^|[-.])${token}($|[-.])`),
);

/** Dated snapshots always have an undated alias; the alias is the stable name. */
const DATED_SNAPSHOT = /-\d{8}$/;

/**
 * What children run when rlm.run names no model. A hardcoded default breaks
 * every session whose auth cannot spawn it, so the choice degrades: explicit
 * override, then the parent provider's own volume tier — children bill and
 * authenticate where the parent already lives — then any provider's volume
 * tier, then the parent's own model, valid by construction. Matching runs
 * against the model id, never the provider; newest wins by natural version
 * order. The bare fallback only applies when nothing is known, where any
 * guess fails equally.
 */
export function resolveDefaultSubagentModel(options: {
	override?: string;
	available: string[];
	current?: string;
}): string {
	if (options.override) return options.override;
	const candidates = options.available.filter((entry) => !DATED_SNAPSHOT.test(entry));
	const slash = options.current?.indexOf("/") ?? -1;
	const parentProvider = slash > 0 ? options.current?.slice(0, slash) : undefined;
	const pools = parentProvider
		? [candidates.filter((entry) => entry.startsWith(`${parentProvider}/`)), candidates]
		: [candidates];
	for (const pool of pools) {
		for (const pattern of VOLUME_TIER_PATTERNS) {
			const matches = pool.filter((entry) => pattern.test(entry.slice(entry.indexOf("/") + 1)));
			if (matches.length > 0) {
				return matches.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] as string;
			}
		}
	}
	return options.current ?? "anthropic/haiku";
}

export function defaultSubagentName(prompt: string, childId: string): string {
	const slug = prompt
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const suffix = childId.replace(/[^a-z0-9]/gi, "").slice(-8) || "child";
	const fixed = "subagent--".length + suffix.length;
	const promptPart = (slug || "worker").slice(0, Math.max(1, MAX_SUBAGENT_NAME_LENGTH - fixed)).replace(/-+$/g, "");
	return `subagent-${promptPart || "worker"}-${suffix}`;
}

export interface SubagentHost {
	handlers: HostRequestHandlers;
	entries(): SubagentEntry[];
	killAll(): void;
}

export function createSubagentHost(options: SubagentHostOptions): SubagentHost {
	const registry = new Map<string, SubagentEntry>();
	const children = new Map<string, ReturnType<typeof spawn>>();
	// Deleting a running child races its exit event: SIGTERM fires "exit" after
	// the delete handler already removed the frame file, and an unguarded exit
	// write would resurrect it. Discarding routes all later writes to nowhere.
	const discardFrame = new Map<string, () => void>();

	function toPublicEntry(entry: SubagentEntry): Record<string, unknown> {
		// One name for one concept: rlm.run replies with `name`, so the registry
		// must too — a poll that matches on `entry.name` has to work. (It did
		// not, and the resulting waits timed out silently instead of detecting
		// completion.)
		return {
			rlm_child_id: entry.rlm_child_id,
			name: entry.session_name,
			session_dir: entry.session_dir,
			output_file: entry.output_file,
			model: entry.model,
			status: entry.status,
		};
	}

	// ── peer selection ──────────────────────────────────────────────────────────
	// A panel must not fan out N clones of one model, which agree because they
	// are the same function. Prefer distinct auth-configured models; pad with
	// defaultModel when availability is unknown or the panel asks for more than
	// is configured.
	function pickPanelModels(size: number): string[] {
		const distinct = [...new Set(options.availableModels ?? [])];
		const defaultIdx = distinct.indexOf(options.defaultModel);
		if (defaultIdx >= 0) distinct.splice(defaultIdx, 1);
		const picked = distinct.slice(0, size);
		while (picked.length < size) picked.push(options.defaultModel);
		return picked;
	}

	/** Resolve a target (rlm_child_id or sibling name) to a live registry entry. */
	function findEntry(target: string): SubagentEntry {
		if (!target) throw new Error("a non-empty subagent target is required (rlm_child_id or name)");
		const entry =
			registry.get(target) ?? [...registry.values()].find((candidate) => candidate.session_name === target);
		if (!entry) throw new Error(`no subagent matches "${target}"`);
		return entry;
	}

	/** SIGTERM a child and drop its registry + frame records. Returns the removed entry. */
	function killEntry(target: string): SubagentEntry {
		const entry = findEntry(target);
		const child = children.get(entry.rlm_child_id);
		if (child) {
			child.kill("SIGTERM");
			children.delete(entry.rlm_child_id);
			entry.status = "error";
		}
		registry.delete(entry.rlm_child_id);
		// Deletion means gone everywhere the registry speaks: the frame record
		// goes with the entry, so the stack view cannot resurrect it.
		discardFrame.get(entry.rlm_child_id)?.();
		discardFrame.delete(entry.rlm_child_id);
		return entry;
	}

	function readOutput(entry: SubagentEntry): string {
		try {
			return readFileSync(entry.output_file, "utf8");
		} catch {
			// Not written yet, or the child died before writing anything.
			return "";
		}
	}

	// ── the one spawn primitive ──────────────────────────────────────────────
	// Both admission (rlm.run) and the orchestration handlers (panel, loop)
	// share a single spawn path: register the child, write the frame record,
	// and resolve a promise on exit so a handler can choose to wait or not.
	function spawnAgent(args: {
		prompt: string;
		model: string;
		name?: string;
		cellId?: string;
	}): { entry: SubagentEntry; exit: Promise<number | null> } {
		const { prompt, model, cellId } = args;
		const childId = `sub-${randomUUID()}`;
		const name = args.name?.trim() || defaultSubagentName(prompt, childId);
		mkdirSync(options.subagentDir, { recursive: true });
		const outputFile = join(options.subagentDir, `${childId}.output.md`);

		const entry: SubagentEntry = {
			rlm_child_id: childId,
			session_name: name,
			session_dir: options.subagentDir,
			output_file: outputFile,
			model,
			status: "running",
			exit_code: null,
			pid: undefined,
		};

		// The frame record is the durable half of the registry: rendering,
		// cross-process lineage, and post-mortem inspection all read this file,
		// so it exists from admission and is finalized in place on exit.
		const framePath = join(options.subagentDir, `${childId}.json`);
		const frame: FrameRecord = {
			rlm_child_id: childId,
			name,
			prompt,
			model,
			status: "running",
			spawned_at: new Date().toISOString(),
			...(cellId ? { spawn_cell_id: cellId } : {}),
			...(options.selfChildId ? { parent_child_id: options.selfChildId } : {}),
		};
		let frameDiscarded = false;
		discardFrame.set(childId, () => {
			frameDiscarded = true;
			try {
				rmSync(framePath, { force: true });
			} catch {}
		});
		const writeFrame = (): void => {
			if (frameDiscarded) return;
			try {
				writeFileSync(framePath, JSON.stringify(frame));
			} catch {
				// A frame that cannot be written costs the stack view, not the spawn.
			}
		};

		const spec = options.spawnCommand
			? options.spawnCommand(entry, prompt)
			: {
					command: "pi",
					args: [
						"-p",
						"--no-extensions",
						"-e",
						join(import.meta.dirname, "index.ts"),
						"--provider",
						model.includes("/") ? model.slice(0, model.indexOf("/")) : "anthropic",
						"--model",
						model.includes("/") ? model.slice(model.indexOf("/") + 1) : model,
						"--session-dir",
						options.subagentDir,
						"--name",
						name,
						prompt,
					],
				};

		const outFd = openSync(outputFile, "w");
		const child = spawn(spec.command, spec.args, {
			cwd: options.cwd,
			detached: false,
			stdio: ["ignore", outFd, outFd],
			// PI_RLM_FORCE activates the child regardless of flag plumbing: the
			// child loads this extension via -e and must enter the RLM world
			// without depending on --rlm surviving pi's argv handling.
			// PI_RLM_CHILD_ID tells the child its own id, so the frame records it
			// writes for grandchildren carry the link back to this one.
			env: {
				...process.env,
				PI_RLM_DEPTH: String(options.depth + 1),
				PI_RLM_FORCE: "1",
				PI_RLM_CHILD_ID: childId,
			},
		});
		closeSync(outFd);
		entry.pid = child.pid;
		frame.pid = child.pid;
		writeFrame();
		registry.set(childId, entry);
		children.set(childId, child);

		const exit = new Promise<number | null>((resolve) => {
			child.on("exit", (code) => {
				entry.exit_code = code;
				entry.status = code === 0 ? "completed" : "error";
				frame.status = entry.status;
				frame.exit_code = code;
				frame.finished_at = new Date().toISOString();
				writeFrame();
				children.delete(childId);
				resolve(code);
			});
			child.on("error", () => {
				entry.status = "error";
				frame.status = "error";
				frame.finished_at = new Date().toISOString();
				writeFrame();
				children.delete(childId);
				resolve(null);
			});
		});

		return { entry, exit };
	}

	const handlers: HostRequestHandlers = {
		"rlm.run": async (payload, context) => {
			const prompt = payload.prompt;
			if (typeof prompt !== "string" || prompt.trim().length === 0) {
				throw new Error("rlm.run prompt must be a non-empty string");
			}
			if (options.depth + 1 > options.maxDepth) {
				throw new Error(`rlm.run refused: recursion depth limit (${options.maxDepth}) reached`);
			}
			const kwargs = (payload.kwargs ?? {}) as Record<string, unknown>;
			const requestedName = kwargs.name;
			if (requestedName !== undefined && typeof requestedName !== "string") {
				throw new Error("rlm.run name must be a string");
			}
			if (typeof requestedName === "string" && requestedName.length > MAX_SUBAGENT_NAME_LENGTH) {
				throw new Error(`rlm.run name must be at most ${MAX_SUBAGENT_NAME_LENGTH} characters`);
			}
			const model = typeof kwargs.model === "string" && kwargs.model ? kwargs.model : options.defaultModel;
			const { entry } = spawnAgent({ prompt, model, name: requestedName, cellId: context?.cellId });
			// Admission: return the handle immediately; results land in output_file.
			return {
				rlm_child_id: entry.rlm_child_id,
				name: entry.session_name,
				session_dir: entry.session_dir,
				output_file: entry.output_file,
				model,
			};
		},

		"rlm.list_subagents": async () => {
			return { subagents: [...registry.values()].map(toPublicEntry) };
		},

		// Aliases keep the surface discoverable under both the pi-rlm names and
		// the orchestration names the pi-js-kernel port introduced.
		"rlm.list": async () => {
			return { subagents: [...registry.values()].map(toPublicEntry) };
		},

		"rlm.delete_subagent": async (payload) => {
			return { subagent: toPublicEntry(killEntry(String(payload.target ?? "").trim())) };
		},

		"rlm.kill": async (payload) => {
			const target = String(payload.id ?? payload.target ?? "").trim();
			return { subagent: toPublicEntry(killEntry(target)) };
		},

		// Read a child's live output file and current status — the filesystem is
		// the source of truth, so this reflects partial work while it runs.
		"rlm.peek": async (payload) => {
			const target = String(payload.target ?? payload.id ?? "").trim();
			const entry = findEntry(target);
			return { subagent: toPublicEntry(entry), output: readOutput(entry) };
		},

		// Blocking multi-model delegation: spawn N children on distinct models
		// against the same prompt, wait for all to settle, and return each
		// member's output plus completion counts. Runs inside one host request,
		// so concurrent spawning is fine; the handler just awaits all exits.
		"rlm.panel": async (payload, context) => {
			const prompt = payload.prompt;
			if (typeof prompt !== "string" || prompt.trim().length === 0) {
				throw new Error("rlm.panel prompt must be a non-empty string");
			}
			if (options.depth + 1 > options.maxDepth) {
				throw new Error(`rlm.panel refused: recursion depth limit (${options.maxDepth}) reached`);
			}
			const kwargs = (payload.kwargs ?? {}) as Record<string, unknown>;
			let models: string[];
			if (Array.isArray(kwargs.models) && (kwargs.models as unknown[]).filter((m) => typeof m === "string" && m.length > 0).length > 0) {
				models = (kwargs.models as unknown[]).filter((m): m is string => typeof m === "string" && m.length > 0);
			} else {
				const size = Number.isInteger(kwargs.size) && (kwargs.size as number) >= 2 && (kwargs.size as number) <= 6
					? (kwargs.size as number)
					: 3;
				models = pickPanelModels(size);
			}

			const members = await Promise.all(
				models.map(async (model) => {
					const { entry, exit } = spawnAgent({
						prompt: `${prompt}\n\n(panel member on ${model}) Your final printed answer is your complete, self-contained reply.`,
						model,
						cellId: context?.cellId,
					});
					const code = await exit;
					return {
						rlm_child_id: entry.rlm_child_id,
						name: entry.session_name,
						output_file: entry.output_file,
						model,
						status: entry.status,
						exit_code: code,
						output: readOutput(entry),
					};
				}),
			);

			const completed = members.filter((m) => m.status === "completed").length;
			return {
				size: members.length,
				members,
				completed,
				failed: members.length - completed,
				// Native children write free-form text, not a structured contract, so
				// an agreement tally is not meaningful here; the caller gets raw
				// outputs and synthesis is its job.
				note: "outputs are free-form; compare and synthesize them yourself",
			};
		},

		// Declarative workflow interpreter driving children: goal + optional
		// strategy steps + optional converge check, bounded by a budget. Children
		// are ordinary pi-rlm subagents whose output files accumulate into working
		// notes, mirroring the agent_loop shape without pi-agents' RPC machinery.
		"rlm.loop": async (payload, context) => {
			const wf = payload.workflow;
			if (!wf || typeof wf !== "object" || Array.isArray(wf)) {
				throw new Error("rlm.loop: workflow must be an object (goal + optional strategy/check/converge/budget)");
			}
			if (options.depth + 1 > options.maxDepth) {
				throw new Error(`rlm.loop refused: recursion depth limit (${options.maxDepth}) reached`);
			}
			const goal = typeof (wf as Record<string, unknown>).goal === "string" ? ((wf as Record<string, unknown>).goal as string).trim() : "";
			if (!goal) throw new Error("rlm.loop: workflow.goal is required and must be a non-empty string");

			const strategy = Array.isArray((wf as Record<string, unknown>).strategy)
				? ((wf as Record<string, unknown>).strategy as unknown[]).filter((s): s is string => typeof s === "string" && s.length > 0)
				: [];
			const doer = typeof (wf as Record<string, unknown>).doer === "string" && ((wf as Record<string, unknown>).doer as string).trim()
				? ((wf as Record<string, unknown>).doer as string).trim()
				: "Work toward the goal using the context. Your final printed answer is your self-contained contribution.";
			const converge = typeof (wf as Record<string, unknown>).converge === "string" && ((wf as Record<string, unknown>).converge as string).trim()
				? ((wf as Record<string, unknown>).converge as string).trim()
				: undefined;

			const budget = ((wf as Record<string, unknown>).budget ?? {}) as Record<string, unknown>;
			const maxSpawns = Number.isInteger(budget.maxSpawns) && (budget.maxSpawns as number) > 0 ? (budget.maxSpawns as number) : 4;
			const defaultGens = strategy.length > 0 ? strategy.length : 3;
			const maxGenerations = Number.isInteger(budget.maxGenerations) && (budget.maxGenerations as number) > 0 ? (budget.maxGenerations as number) : defaultGens;
			const model = typeof payload.model === "string" && payload.model.length > 0 ? payload.model : options.defaultModel;

			let workingNotes = "";
			const results: Record<string, unknown>[] = [];
			let generations = 0;
			let spawned = 0;
			let converged = false;

			while (generations < maxGenerations && spawned < maxSpawns && !converged) {
				generations += 1;
				const step = strategy[generations - 1];
				const prompt = [
					`Goal: ${goal}`,
					step ? `Current step: ${step}` : "",
					workingNotes ? `Context so far:\n${workingNotes}` : "",
					doer,
					"This is a child agent; your contribution is written to your own output file.",
				].filter((l) => l !== "").join("\n\n");
				const { entry, exit } = spawnAgent({ prompt, model, cellId: context?.cellId });
				spawned += 1;
				await exit;
				const out = readOutput(entry);
				results.push({
					generation: generations,
					role: "doer",
					rlm_child_id: entry.rlm_child_id,
					name: entry.session_name,
					model,
					status: entry.status,
					output: out,
				});
				workingNotes = workingNotes ? `${workingNotes}\n\n-- ${entry.session_name} (${entry.rlm_child_id}) --\n${out}` : out;

				if (converge && spawned < maxSpawns) {
					const verdictPrompt = [
						`${converge}`,
						`Goal: ${goal}`,
						`Candidate work:\n${workingNotes}`,
						'Reply EXACTLY with the word "CONVERGED" if the goal is met, otherwise reply with the word "CONTINUE" and a one-line reason.',
					].join("\n\n");
					const v = spawnAgent({ prompt: verdictPrompt, model, cellId: context?.cellId });
					spawned += 1;
					await v.exit;
					const vout = readOutput(v.entry);
					results.push({
						generation: generations,
						role: "check",
						rlm_child_id: v.entry.rlm_child_id,
						name: v.entry.session_name,
						model,
						status: v.entry.status,
						output: vout,
					});
					converged = /\bCONVERGED\b/i.test(vout);
				}
			}

			return {
				goal,
				converged,
				generations,
				spawned,
				budget: { maxSpawns, maxGenerations },
				workingNotes,
				results,
			};
		},
	};

	return {
		handlers,
		entries: () => [...registry.values()],
		killAll: () => {
			for (const child of children.values()) child.kill("SIGKILL");
			children.clear();
		},
	};
}
