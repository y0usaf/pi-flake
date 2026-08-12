/**
 * pi-agents agent_loop module: the declarative workflow interpreter
 * (runWorkflow), its LoopCandidate/LoopLedgerEntry ledger types, and the
 * workflowSchema/agentLoopSchema declarations (plus the StringEnum helper and
 * StaticWorkflowType). Per DESIGN.md: "a bounded single-loop interpreter
 * (goal / doer / check / strategy / converge / budget)" that reuses
 * spawnChild/spawnPanel as its execution machinery (decision-making).
 *
 * createLoop(deps) is invoked inside multiAgent() with the per-session spawn
 * machinery, registry, and config loader; the schemas are pure data at module
 * scope. No module-level state, so multiple sessions stay isolated.
 */
import type { Model } from "@earendil-works/pi-ai";
import { type AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TUnsafe } from "@sinclair/typebox";
import { type Usage, formatUsage } from "./render.js";
import { contractQuestionSchema, normalizeContract, type ContractAnswer } from "./contract.js";
import { usageToDetails, type AgentToolDetails } from "./state.js";
import type { PiAgentsConfig } from "./config.js";
import type { Registry } from "./registry.js";
import type { SpawnChildFn, SpawnPanelFn } from "./spawn.js";

// ---------------------------------------------------------------------------
// Workflow schemas
// ---------------------------------------------------------------------------

function StringEnum<T extends readonly string[]>(values: T, options?: { description?: string; default?: T[number] }): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values as any,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}

const workflowSchema = Type.Object(
	{
		goal: Type.String({ description: "The objective. Included in every doer task." }),
		doer: Type.Object({
			system_prompt: Type.String({ description: "System prompt for the doer agents; the cheap worker that produces candidate artifacts." }),
			model: Type.Optional(Type.String({ description: 'Optional per-doer model spec ("provider/modelId" or bare id). Defaults to pi-agents config model (cheap).' })),
			contract: Type.Array(contractQuestionSchema, { minItems: 1, description: "Doer contract the candidate must fulfill. The FIRST question should be a free-text summary of the produced artifact so the checker can judge it." }),
		}),
		check: Type.Object({
			use: StringEnum(["agent", "panel"] as const, { description: '"agent": one checker child per candidate. "panel": a multi-model panel per candidate (slower, more robust verdicts).' }),
			system_prompt: Type.String({ description: "System prompt for the checker. MUST instruct it to judge the candidate against the goal and return the verdict option values in the contract." }),
			contract: Type.Array(contractQuestionSchema, { minItems: 1, description: "Checker contract. The FIRST question must be an enumerated verdict question whose option values include the passValue; it is scored mechanically. Remaining questions are folded into next-generation critiques as free text." }),
			passValue: Type.String({ description: 'The option value of the first contract question that counts as a pass, e.g. "pass".' }),
			panel: Type.Optional(Type.Object({
				size: Type.Optional(Type.Number({ description: "Panel size 2-5. Defaults to configured panelModels roster." })),
				models: Type.Optional(Type.Array(Type.String(), { description: "Explicit panel member models (provider/modelId)." })),
			})),
		}),
		strategy: Type.Object({
			population: Type.Integer({ minimum: 1, description: "Doers spawned per generation. 1 = plain refinement loop; >1 = genetic width." }),
			survivors: Type.Integer({ minimum: 1, description: "Candidates kept per generation (top-K by score). Must be <= population." }),
			parentMode: Type.Optional(StringEnum(["mutate", "pair"] as const, { description: '"mutate": each survivor is respawned with its own critique. "pair": survivors are paired and recombined (each next-gen doer task combines two survivors). Defaults to "mutate" for population 1, "pair" when survivors > 1.' })),
		}),
		converge: Type.Object({
			quorum: Type.Number({ minimum: 0, maximum: 1, description: "Pass fraction required to converge: bestScore >= quorum stops the loop with status converged." }),
		}),
		budget: Type.Object({
			maxGenerations: Type.Integer({ minimum: 1, description: "Hard cap on generations." }),
			maxSpawns: Type.Integer({ minimum: 1, description: "Hard cap on total spawned children (doers + checkers) across the whole run. Always dominates." }),
		}),
	},
	{ additionalProperties: false, description: "Declarative goal-loop workflow. No control flow, no expressions: data only. The interpreter is agent_loop's fixed while-loop." },
);

type StaticWorkflowType = Static<typeof workflowSchema>;

const agentLoopSchema = Type.Object({
	workflow: workflowSchema,
	timeout_seconds: Type.Optional(Type.Number({ description: "Maximum wall-clock seconds for the whole loop. Must be > 0." })),
});

export interface LoopDeps {
	spawn: { spawnChild: SpawnChildFn; spawnPanel: SpawnPanelFn };
	registry: Registry;
	getConfig: (cwd: string) => Promise<PiAgentsConfig>;
}

export interface LoopTools {
	runWorkflow: (
		workflow: StaticWorkflowType,
		model: Model<any>,
		cwd: string,
		signal?: AbortSignal,
		onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void,
	) => Promise<AgentToolResult<AgentToolDetails>>;
}

export function createLoop(deps: LoopDeps): LoopTools {
	const { spawn, registry, getConfig } = deps;

	interface LoopCandidate {
		id: string;
		gen: number;
		score: number; // 0..1
		artifact: string;
		answers: ContractAnswer[];
		critique: string[]; // free-text answers beyond the verdict question
	}

	interface LoopLedgerEntry {
		gen: number;
		scores: { id: string; score: number }[];
		selected: string[];
		genSpawns: number;
		usage: Usage | undefined;
		totalSpawns: number;
	}

	async function runWorkflow(
		workflow: StaticWorkflowType,
		model: Model<any>,
		cwd: string,
		signal?: AbortSignal,
		onUpdate?: (partialResult: AgentToolResult<AgentToolDetails>) => void,
	): Promise<AgentToolResult<AgentToolDetails>> {
		const config = await getConfig(cwd);
		const checkContract = normalizeContract(workflow.check.contract, "agent_loop check");
		const verdictQuestionId = checkContract[0].id;
		const passValue = workflow.check.passValue;
		const population = workflow.strategy.population;
		const survivors = Math.min(workflow.strategy.survivors, population);
		const parentMode = workflow.strategy.parentMode ?? (survivors > 1 ? "pair" : "mutate");
		const quorum = workflow.converge.quorum;
		const maxGenerations = workflow.budget.maxGenerations;
		const maxSpawns = workflow.budget.maxSpawns;
		const usePanel = workflow.check.use === "panel";
		const panelCfg = workflow.check.panel;

		const addUsage = (a: Usage, b: Usage | undefined): Usage => {
			if (!b) return a;
			return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, cost: a.cost + b.cost };
		};

		/** Run a wave concurrently, chunked to maxLiveAgents - 1; on any failure kill the chunk and throw. */
		async function spawnWave(entries: Array<{ id: string; spawn: () => Promise<AgentToolResult<AgentToolDetails>> }>): Promise<AgentToolResult<AgentToolDetails>[]> {
			const results: AgentToolResult<AgentToolDetails>[] = [];
			const chunkSize = Math.max(1, Math.min(entries.length, Math.max(1, config.maxLiveAgents - 1)));
			for (let start = 0; start < entries.length; start += chunkSize) {
				const chunk = entries.slice(start, start + chunkSize);
				const settled = await Promise.allSettled(chunk.map((entry) => entry.spawn()));
				for (const r of settled) {
					if (r.status === "rejected") {
						for (const other of chunk) registry.killSubtree(other.id);
						throw (r as PromiseRejectedResult).reason;
					}
				}
				results.push(...(settled as PromiseFulfilledResult<AgentToolResult<AgentToolDetails>>[]).map((r) => r.value));
			}
			return results;
		}

		const buildMutateTask = (parent: LoopCandidate): string => [
			workflow.goal,
			"",
			"## Prior generation context",
			`- candidate ${parent.id}: verdict score ${parent.score.toFixed(2)}`,
			...(parent.critique.length > 0 ? parent.critique.map((line) => `  - critique: ${line}`) : []),
			"",
			"Improve on the best candidate above, addressing its critique.",
		].join("\n");

		const buildPairTask = (a: LoopCandidate, b: LoopCandidate): string => [
			workflow.goal,
			"",
			"## Prior generation context",
			`- candidate ${a.id}: verdict score ${a.score.toFixed(2)}`,
			...(a.critique.length > 0 ? a.critique.map((line) => `  - critique: ${line}`) : []),
			`- candidate ${b.id}: verdict score ${b.score.toFixed(2)}`,
			...(b.critique.length > 0 ? b.critique.map((line) => `  - critique: ${line}`) : []),
			"",
			"Combine the strengths of both candidates above into a single better artifact.",
		].join("\n");

		const buildGenerationTasks = (gen: number, selected: LoopCandidate[]): string[] => {
			if (gen === 1) {
				return Array.from({ length: population }, () => `${workflow.goal}\n\nProduce your best artifact for the goal. Submit your contract answers when done.`);
			}
			const tasks: string[] = [];
			if (parentMode === "pair") {
				const pairs: Array<[LoopCandidate, LoopCandidate | undefined]> = [];
				for (let i = 0; i < selected.length; i += 2) pairs.push([selected[i], selected[i + 1]]);
				for (let i = 0; i < population; i++) {
					const [a, b] = pairs[i % pairs.length];
					tasks.push(b ? buildPairTask(a, b) : buildMutateTask(a));
				}
			} else {
				for (let i = 0; i < population; i++) tasks.push(buildMutateTask(selected[i % selected.length]));
			}
			return tasks;
		};

		const buildCheckerTask = (candidate: LoopCandidate): string =>
			`Candidate: ${candidate.id}\n\n## Candidate artifact\n${candidate.artifact}\n\n## Goal\n${workflow.goal}`;

		const scoreOf = (result: AgentToolResult<AgentToolDetails>): { score: number; critique: string[] } => {
			const panel = result.details?.panel;
			if (panel?.tally && Array.isArray(panel.members)) {
				const q = panel.tally.questions.find((x) => x.questionId === verdictQuestionId);
				const group = q?.groups.find((g) => g.value === passValue);
				const score = panel.members.length > 0 ? (group?.count ?? 0) / panel.members.length : 0;
				const critique: string[] = [];
				for (const member of panel.members) for (const a of member.answers ?? []) if (a.id !== verdictQuestionId && a.wasCustom) critique.push(a.value);
				return { score, critique };
			}
			const answers = result.details?.answers ?? [];
			const verdict = answers.find((a) => a.id === verdictQuestionId);
			const score = verdict?.value === passValue ? 1 : 0;
			const critique = answers.filter((a) => a.id !== verdictQuestionId && a.wasCustom).map((a) => a.value);
			return { score, critique };
		};

		let totalUsage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		let totalSpawns = 0;
		let status = "running";
		let generation = 0;
		let winner: LoopCandidate | undefined;
		const ledger: LoopLedgerEntry[] = [];
		let selected: LoopCandidate[] = [];

		while (generation < maxGenerations) {
			if (totalSpawns >= maxSpawns) { status = "budget-exhausted"; break; }
			generation++;
			const tasks = buildGenerationTasks(generation, selected);
			if (totalSpawns + tasks.length > maxSpawns) { status = "budget-exhausted"; break; }
			const doerResults = await spawnWave(tasks.map((task, i) => {
				const id = `loop-doer-g${generation}-${i + 1}`;
				return { id, spawn: () => spawn.spawnChild(undefined, { id, system_prompt: workflow.doer.system_prompt, task, contract: workflow.doer.contract }, model, cwd, signal, onUpdate) };
			}));
			totalSpawns += doerResults.length;
			for (const r of doerResults) totalUsage = addUsage(totalUsage, r.details?.usage);

			const candidates: LoopCandidate[] = doerResults.map((r, i) => {
				const answers = r.details?.answers ?? [];
				const artifact = answers.find((a) => a.wasCustom)?.value ?? answers.map((a) => a.value).join("\n") ?? "(no artifact)";
				return { id: `loop-doer-g${generation}-${i + 1}`, gen: generation, score: 0, artifact, answers, critique: [] };
			});

			if (totalSpawns + candidates.length > maxSpawns) { status = "budget-exhausted"; break; }
			const checkerResults = await spawnWave(candidates.map((c) => {
				const id = `loop-check-${c.id}`;
				return { id, spawn: () => usePanel
					? spawn.spawnPanel(undefined, { id, system_prompt: workflow.check.system_prompt, task: buildCheckerTask(c), contract: workflow.check.contract, panel: { models: panelCfg?.models, size: panelCfg?.size } }, model, cwd, signal, onUpdate)
					: spawn.spawnChild(undefined, { id, system_prompt: workflow.check.system_prompt, task: buildCheckerTask(c), contract: workflow.check.contract }, model, cwd, signal, onUpdate) };
			}));
			totalSpawns += checkerResults.length;
			for (const r of checkerResults) totalUsage = addUsage(totalUsage, r.details?.usage);

			const scored: LoopCandidate[] = candidates.map((c, i) => {
				const { score, critique } = scoreOf(checkerResults[i]);
				return { ...c, score, critique };
			});
			scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
			selected = scored.slice(0, survivors);
			winner = scored[0];

			ledger.push({
				gen: generation,
				scores: scored.map((c) => ({ id: c.id, score: c.score })),
				selected: selected.map((c) => c.id),
				genSpawns: doerResults.length + checkerResults.length,
				usage: usageToDetails(totalUsage),
				totalSpawns,
			});

			if (winner.score >= quorum) { status = "converged"; break; }
		}

		const text = [
			`agent_loop ${status}`,
			`generations: ${generation}`,
			`total spawns: ${totalSpawns}`,
			`best score: ${winner ? winner.score.toFixed(2) : "n/a"}`,
			winner ? `winner: ${winner.id}` : "",
			formatUsage(totalUsage),
		].join("\n");
		return {
			content: [{ type: "text", text }],
			details: {
				childId: "agent_loop",
				activity: [],
				reports: [],
				usage: usageToDetails(totalUsage),
				done: true,
				answers: winner?.answers,
				contract: undefined,
				loop: { status, generations: generation, totalSpawns, bestScore: winner?.score ?? 0, winnerId: winner?.id, ledger },
			},
		};
	}

	return { runWorkflow };
}

export { workflowSchema, agentLoopSchema };
