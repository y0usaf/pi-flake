import { readFile, realpath, readdir, stat } from "node:fs/promises";
import { join, resolve, isAbsolute, sep, relative } from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export const timeoutSecondsSchema = Type.Integer({ minimum: 1, maximum: 86400, description: "Timeout in whole seconds (1..86400)." });

export const chainStepSchema = Type.Object({
	id: Type.String({ description: "Child agent id to spawn or delegate to" }),
	system_prompt: Type.Optional(Type.String({ description: "System prompt for spawn steps. Required when the child does not already exist." })),
	task: Type.String({ description: "Task/message for this step. Supports {previous}, {all}, and {step:<id>}." }),
	timeout_seconds: Type.Optional(timeoutSecondsSchema),
}, { additionalProperties: false });

export const parallelTaskSchema = Type.Object({
	id: Type.String({ description: "Unique child agent id to spawn" }),
	system_prompt: Type.String({ description: "System prompt defining the child agent's role and behavior" }),
	task: Type.String({ description: "Task to assign to the child agent. Supports workflow variables when used inside workflow steps." }),
	timeout_seconds: Type.Optional(timeoutSecondsSchema),
}, { additionalProperties: false });

const workflowAgentStepSchema = Type.Object({
	type: Type.Optional(Type.Literal("agent", { description: "Sequential agent step (default)." })),
	id: Type.String({ description: "Child agent id to spawn or delegate to" }),
	system_prompt: Type.Optional(Type.String({ description: "System prompt. Required when creating a new child." })),
	task: Type.String({ description: "Task/message. Supports {previous}, {all}, and {step:<id>}." }),
	timeout_seconds: Type.Optional(timeoutSecondsSchema),
}, { additionalProperties: false });

const workflowParallelStepSchema = Type.Object({
	type: Type.Literal("parallel"),
	id: Type.String({ description: "Barrier/output id for this parallel group" }),
	tasks: Type.Array(parallelTaskSchema, { minItems: 1, description: "Parallel fan-out tasks." }),
}, { additionalProperties: false });

const workflowUntilSchema = Type.Object({
	step: Type.String({ description: "Loop body step id whose latest output is inspected." }),
	contains: Type.Optional(Type.String({ description: "Stop when the step output contains this text." })),
	last_line_equals: Type.Optional(Type.String({ description: "Stop when the step output's last non-empty line equals this text." })),
}, { additionalProperties: false });

const workflowWhileStepSchema = Type.Object({
	type: Type.Literal("while"),
	id: Type.String({ description: "Loop/barrier output id" }),
	until: workflowUntilSchema,
	steps: Type.Array(Type.Any({ description: "Loop body steps. Nested while loops are supported. Loops run until their condition is met or the run is cancelled." }), { minItems: 1 }),
}, { additionalProperties: false });

const workflowStepSchema = Type.Union([
	workflowAgentStepSchema,
	workflowParallelStepSchema,
	workflowWhileStepSchema,
]);

export const workflowSchema = Type.Object({
	name: Type.Optional(Type.String({ description: "Workflow name" })),
	description: Type.Optional(Type.String({ description: "Workflow description" })),
	steps: Type.Array(workflowStepSchema, { minItems: 1, description: "Deterministic workflow steps run in order." }),
}, { additionalProperties: false });

export interface ChainStepParams {
	id: string;
	system_prompt?: string;
	task: string;
	timeout_seconds?: number;
}

export interface ParallelTaskParams {
	id: string;
	system_prompt: string;
	task: string;
	timeout_seconds?: number;
}

export type WorkflowUntilParams = { step: string; contains?: string; last_line_equals?: string };
export type WorkflowAgentStepParams = ChainStepParams & { type?: "agent" };
export type WorkflowParallelStepParams = { type: "parallel"; id: string; tasks: ParallelTaskParams[] };
export type WorkflowWhileStepParams = { type: "while"; id: string; until: WorkflowUntilParams; steps: WorkflowStepParams[] };
export type WorkflowStepParams = WorkflowAgentStepParams | WorkflowParallelStepParams | WorkflowWhileStepParams;
export type WorkflowBodyStepParams = WorkflowAgentStepParams | WorkflowParallelStepParams;

export interface WorkflowParams {
	name?: string;
	description?: string;
	steps: WorkflowStepParams[];
}

export interface WorkflowLoadParams {
	workflow?: WorkflowParams;
	workflow_path?: string;
	workflow_name?: string;
}

interface WorkflowSummary {
	name: string;
	description?: string;
	path: string;
	scope: "project" | "global";
	steps?: number;
	error?: string;
}

export interface WorkflowRuntime<Details> {
	hasChild(id: string): boolean;
	spawn(params: { id: string; system_prompt: string; task: string; timeout_seconds?: number }, signal?: AbortSignal, onUpdate?: (partialResult: AgentToolResult<Details>) => void): Promise<AgentToolResult<unknown>>;
	delegate(params: { id: string; message: string; timeout_seconds?: number }, signal?: AbortSignal, onUpdate?: (partialResult: AgentToolResult<Details>) => void): Promise<AgentToolResult<unknown>>;
	runParallel(tasks: ParallelTaskParams[], signal?: AbortSignal, onUpdate?: (partialResult: AgentToolResult<Details>) => void): Promise<AgentToolResult<unknown>>;
}

function isWithinDirectory(base: string, target: string): boolean {
	const rel = relative(base, target);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

async function assertReadableRegularFile(path: string): Promise<void> {
	let info;
	try {
		info = await stat(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") throw Object.assign(new Error(`File not found: ${path}`), { code: "ENOENT" });
		throw err;
	}
	if (!info.isFile()) throw new Error(`Not a file: ${path}`);
}

function normalizePositiveTimeout(value: unknown, key: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 86_400) throw new Error(`${key} must be an integer 1..86400.`);
	return value as number;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[], source: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) throw new Error(`${source}: unknown key(s): ${unknown.join(", ")}`);
}

function assertWorkflowTask(task: ParallelTaskParams, source: string): void {
	if (!task || typeof task !== "object" || Array.isArray(task)) throw new Error(`${source} must be an object.`);
	rejectUnknownKeys(task as unknown as Record<string, unknown>, ["id", "system_prompt", "task", "timeout_seconds"], source);
	if (typeof task.id !== "string" || task.id.trim().length === 0) throw new Error(`${source} requires id.`);
	if (typeof task.system_prompt !== "string" || task.system_prompt.trim().length === 0) throw new Error(`${source} requires system_prompt.`);
	if (typeof task.task !== "string" || task.task.trim().length === 0) throw new Error(`${source} requires task.`);
	normalizePositiveTimeout(task.timeout_seconds, `${source}.timeout_seconds`);
}

function assertWorkflowStep(step: WorkflowStepParams, source: string): void {
	if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`${source} must be an object.`);
	const stepObj = step as unknown as Record<string, unknown>;
	const type = stepObj.type ?? "agent";
	if (type !== "agent" && type !== "parallel" && type !== "while") throw new Error(`${source}.type must be "agent", "parallel", or "while".`);
	if (type === "parallel") {
		rejectUnknownKeys(stepObj, ["type", "id", "tasks"], source);
		const parallelStep = step as WorkflowParallelStepParams;
		if (typeof parallelStep.id !== "string" || parallelStep.id.trim().length === 0) throw new Error(`${source} requires id.`);
		if (!Array.isArray(parallelStep.tasks) || parallelStep.tasks.length === 0) throw new Error(`${source} requires non-empty tasks.`);
		parallelStep.tasks.forEach((task, taskIndex) => assertWorkflowTask(task, `${source}.tasks[${taskIndex}]`));
		return;
	}
	if (type === "while") {
		rejectUnknownKeys(stepObj, ["type", "id", "until", "steps"], source);
		const whileStep = step as WorkflowWhileStepParams;
		if (typeof whileStep.id !== "string" || whileStep.id.trim().length === 0) throw new Error(`${source} requires id.`);
		if (!whileStep.until || typeof whileStep.until !== "object" || Array.isArray(whileStep.until)) throw new Error(`${source}.until must be an object.`);
		rejectUnknownKeys(whileStep.until as unknown as Record<string, unknown>, ["step", "contains", "last_line_equals"], `${source}.until`);
		if (typeof whileStep.until.step !== "string" || whileStep.until.step.trim().length === 0) throw new Error(`${source}.until requires step.`);
		if ((typeof whileStep.until.contains !== "string" || whileStep.until.contains.length === 0) && (typeof whileStep.until.last_line_equals !== "string" || whileStep.until.last_line_equals.length === 0)) throw new Error(`${source}.until requires non-empty contains or last_line_equals.`);
		if (!Array.isArray(whileStep.steps) || whileStep.steps.length === 0) throw new Error(`${source}.steps must be non-empty.`);
		whileStep.steps.forEach((bodyStep, bodyIndex) => assertWorkflowStep(bodyStep, `${source}.steps[${bodyIndex}]`));
		return;
	}
	rejectUnknownKeys(stepObj, ["type", "id", "system_prompt", "task", "timeout_seconds"], source);
	const agentStep = step as WorkflowAgentStepParams;
	if (typeof agentStep.id !== "string" || agentStep.id.trim().length === 0) throw new Error(`${source} requires id.`);
	if (typeof agentStep.task !== "string" || agentStep.task.trim().length === 0) throw new Error(`${source} requires task.`);
	normalizePositiveTimeout(agentStep.timeout_seconds, `${source}.timeout_seconds`);
}

export function assertWorkflowShape(value: unknown, source: string): WorkflowParams {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${source}: expected workflow object.`);
	const workflow = value as WorkflowParams;
	rejectUnknownKeys(workflow as unknown as Record<string, unknown>, ["name", "description", "steps"], source);
	if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) throw new Error(`${source}: expected non-empty steps array.`);
	workflow.steps.forEach((step, index) => assertWorkflowStep(step, `${source}: steps[${index}]`));
	return workflow;
}

function workflowFileName(name: string): string {
	if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error("workflow_name may only contain letters, numbers, _, ., and -");
	return name.endsWith(".json") ? name : `${name}.json`;
}

async function readWorkflowFile(path: string, label: string, confinedTo?: string): Promise<WorkflowParams> {
	if (confinedTo) {
		const baseReal = await realpath(confinedTo);
		const targetReal = await realpath(path);
		if (!isWithinDirectory(baseReal, targetReal)) throw new Error(`workflow ${label} resolves outside workspace: ${path}`);
	}
	await assertReadableRegularFile(path);
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf-8"));
	} catch (err) {
		throw new Error(`Failed to parse workflow ${label}: ${(err as Error).message}`);
	}
	return assertWorkflowShape(parsed, label);
}

export async function loadWorkflow(params: WorkflowLoadParams, cwd: string): Promise<WorkflowParams> {
	const sources = [params.workflow, params.workflow_path, params.workflow_name].filter((value) => value !== undefined).length;
	if (sources !== 1) throw new Error(`agent action "workflow" requires exactly one of workflow, workflow_path, or workflow_name.`);
	if (params.workflow) return assertWorkflowShape(params.workflow, "workflow");
	if (params.workflow_path) {
		const lexical = isAbsolute(params.workflow_path) ? params.workflow_path : resolve(cwd, params.workflow_path);
		if (!isWithinDirectory(cwd, lexical)) throw new Error(`workflow_path resolves outside workspace: ${params.workflow_path}`);
		return await readWorkflowFile(lexical, params.workflow_path, cwd);
	}
	const name = workflowFileName(params.workflow_name!);
	const projectPath = resolve(cwd, ".pi", "agent", "workflows", name);
	try {
		return await readWorkflowFile(projectPath, `.pi/agent/workflows/${name}`, cwd);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	const globalPath = join(getAgentDir(), "workflows", name);
	return await readWorkflowFile(globalPath, `~/.pi/agent/workflows/${name}`);
}

async function listWorkflowFiles(cwd: string): Promise<Array<{ path: string; scope: "project" | "global" }>> {
	const dirs = [
		{ dir: resolve(cwd, ".pi", "agent", "workflows"), scope: "project" as const },
		{ dir: join(getAgentDir(), "workflows"), scope: "global" as const },
	];
	const files: Array<{ path: string; scope: "project" | "global" }> = [];
	for (const { dir, scope } of dirs) {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			continue;
		}
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith(".json")) files.push({ path: join(dir, entry.name), scope });
		}
	}
	files.sort((a, b) => (a.scope === b.scope ? a.path.localeCompare(b.path) : a.scope === "project" ? -1 : 1));
	return files;
}

async function listWorkflowSummaries(cwd: string): Promise<WorkflowSummary[]> {
	const summaries: WorkflowSummary[] = [];
	const seen = new Set<string>();
	for (const file of await listWorkflowFiles(cwd)) {
		const base = file.path.split(sep).pop()!.replace(/\.json$/, "");
		if (seen.has(base)) continue;
		seen.add(base);
		try {
			const parsed = JSON.parse(await readFile(file.path, "utf-8"));
			summaries.push({
				name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name : base,
				description: typeof parsed.description === "string" ? parsed.description : undefined,
				path: file.path,
				scope: file.scope,
				steps: Array.isArray(parsed.steps) ? parsed.steps.length : undefined,
			});
		} catch (err) {
			summaries.push({ name: base, path: file.path, scope: file.scope, error: (err as Error).message });
		}
	}
	return summaries;
}

export async function listWorkflowsResult(cwd: string): Promise<AgentToolResult<unknown>> {
	const workflows = await listWorkflowSummaries(cwd);
	const text = workflows.length === 0
		? "No workflows found. Add JSON workflows in .pi/agent/workflows/ or ~/.pi/agent/workflows/."
		: workflows.map((wf) => {
			const suffix = wf.error ? ` [invalid: ${wf.error}]` : `${wf.steps !== undefined ? ` (${wf.steps} steps)` : ""}${wf.description ? ` — ${wf.description}` : ""}`;
			return `• ${wf.name} [${wf.scope}]${suffix}`;
		}).join("\n");
	return { content: [{ type: "text", text }], details: { workflows } };
}

export async function showWorkflowResult(params: WorkflowLoadParams, cwd: string): Promise<AgentToolResult<unknown>> {
	const workflow = await loadWorkflow(params, cwd);
	const text = JSON.stringify(workflow, null, 2);
	return { content: [{ type: "text", text }], details: { workflow } };
}

export function isWorkflowParallelStep(step: WorkflowStepParams | WorkflowBodyStepParams): step is WorkflowParallelStepParams {
	return (step as { type?: string }).type === "parallel";
}

export function isWorkflowWhileStep(step: WorkflowStepParams): step is WorkflowWhileStepParams {
	return (step as { type?: string }).type === "while";
}

function collectWorkflowChildIds(steps: WorkflowStepParams[], ids: string[]): void {
	for (const step of steps) {
		if (isWorkflowParallelStep(step)) ids.push(...step.tasks.map((task) => task.id));
		else if (isWorkflowWhileStep(step)) collectWorkflowChildIds(step.steps, ids);
		else ids.push(step.id);
	}
}

export function workflowChildIds(workflow: WorkflowParams): string[] {
	const ids: string[] = [];
	collectWorkflowChildIds(workflow.steps, ids);
	return ids;
}

function findLatestOutput(outputs: Array<{ id: string; output: string }>, id: string): string {
	for (let i = outputs.length - 1; i >= 0; i--) {
		if (outputs[i]!.id === id) return outputs[i]!.output;
	}
	return "";
}

export function substituteStepVars(template: string, previous: string, outputs: Array<{ id: string; output: string }>, vars: Record<string, string> = {}): string {
	const all = outputs.map((o) => `=== ${o.id} ===\n${o.output}`).join("\n\n");
	return template
		.replaceAll("{previous}", previous)
		.replaceAll("{all}", all)
		.replace(/\{step:([^}]+)\}/g, (_match, id: string) => findLatestOutput(outputs, id))
		.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => vars[key] ?? match);
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function lastNonEmptyLine(text: string): string {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	return lines.at(-1) ?? "";
}

function isUntilSatisfied(until: WorkflowUntilParams, outputs: Array<{ id: string; output: string }>): boolean {
	const output = findLatestOutput(outputs, until.step);
	if (until.contains !== undefined && output.includes(until.contains)) return true;
	if (until.last_line_equals !== undefined && lastNonEmptyLine(output) === until.last_line_equals) return true;
	return false;
}

async function runWorkflowBodySteps<Details>(runtime: WorkflowRuntime<Details>, steps: WorkflowStepParams[], previous: string, outputs: Array<{ id: string; output: string }>, vars: Record<string, string>, signal?: AbortSignal, onUpdate?: (partialResult: AgentToolResult<Details>) => void): Promise<string> {
	for (const step of steps) {
		if (signal?.aborted) throw new Error("Workflow run was aborted.");
		if (isWorkflowWhileStep(step)) {
			previous = await runWhileStep(runtime, step, previous, outputs, signal, onUpdate);
			continue;
		}
		if (isWorkflowParallelStep(step)) {
			const tasks = step.tasks.map((task) => ({ ...task, task: substituteStepVars(task.task, previous, outputs, vars) }));
			const result = await runtime.runParallel(tasks, signal, onUpdate);
			previous = textOf(result);
			outputs.push({ id: step.id, output: previous });
			continue;
		}
		const task = substituteStepVars(step.task, previous, outputs, vars);
		const existing = runtime.hasChild(step.id);
		if (!existing && (typeof step.system_prompt !== "string" || step.system_prompt.trim().length === 0)) {
			throw new Error(`workflow step "${step.id}" creates a new agent and requires system_prompt.`);
		}
		const result = existing
			? await runtime.delegate({ id: step.id, message: task, timeout_seconds: step.timeout_seconds }, signal, onUpdate)
			: await runtime.spawn({ id: step.id, system_prompt: step.system_prompt!, task, timeout_seconds: step.timeout_seconds }, signal, onUpdate);
		previous = textOf(result);
		outputs.push({ id: step.id, output: previous });
	}
	return previous;
}

async function runWhileStep<Details>(runtime: WorkflowRuntime<Details>, step: WorkflowWhileStepParams, previous: string, outputs: Array<{ id: string; output: string }>, signal?: AbortSignal, onUpdate?: (partialResult: AgentToolResult<Details>) => void): Promise<string> {
	const loopOutputs: Array<{ id: string; output: string }> = [];
	let iteration = 1;
	while (true) {
		if (signal?.aborted) throw new Error("Workflow run was aborted.");
		const before = outputs.length;
		previous = await runWorkflowBodySteps(runtime, step.steps, previous, outputs, { iteration: String(iteration) }, signal, onUpdate);
		const iterationOutputs = outputs.slice(before);
		const iterationText = iterationOutputs.map((o) => `=== ${o.id} ===\n${o.output}`).join("\n\n");
		loopOutputs.push({ id: `${step.id}#${iteration}`, output: iterationText });
		if (isUntilSatisfied(step.until, iterationOutputs)) break;
		iteration++;
	}
	const text = [`while ${step.id}: stopped_by=until`, ...loopOutputs.map((o) => `=== ${o.id} ===\n${o.output}`)].join("\n\n");
	outputs.push({ id: step.id, output: text });
	return text;
}

export async function runWorkflow<Details>(workflow: WorkflowParams, runtime: WorkflowRuntime<Details>, signal?: AbortSignal, onUpdate?: (partialResult: AgentToolResult<Details>) => void): Promise<AgentToolResult<unknown>> {
	let previous = "";
	const outputs: Array<{ id: string; output: string }> = [];
	for (const step of workflow.steps) {
		if (isWorkflowWhileStep(step)) {
			previous = await runWhileStep(runtime, step, previous, outputs, signal, onUpdate);
		} else {
			previous = await runWorkflowBodySteps(runtime, [step], previous, outputs, {}, signal, onUpdate);
		}
	}
	const text = outputs.map((o) => `=== ${o.id} ===\n${o.output}`).join("\n\n");
	return { content: [{ type: "text", text }], details: { workflow: workflow.name, steps: outputs } };
}
