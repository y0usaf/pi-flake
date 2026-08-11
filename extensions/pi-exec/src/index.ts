/**
 * pi-exec — one tool to route them all.
 *
 * Routes built-in tools plus any extension tool published to the shared
 * route registry. The registry is a Map on globalThis keyed by
 * Symbol.for("pi-exec.routes") — all extensions load via jiti into one
 * process, so any extension can publish its ToolDefinition there with no
 * dependency on this package:
 *
 *   const routes = ((globalThis as any)[Symbol.for("pi-exec.routes")] ??= new Map())
 *   routes.set(def.name, def)
 *
 * Registry routes shadow same-named built-ins (e.g. a hashline `read`).
 *
 * Default enabled routes mirror pi: built-ins that are active at
 * session_start (normally read/bash/edit/write — grep/find/ls are off in
 * stock pi) plus all registry routes. /exec-tools opens a SettingsList UI
 * (same pattern as pi-tools) to toggle routes; the selection persists to
 * ~/.pi/agent/pi-exec.json.
 *
 * The exec tool is (re)registered whenever routes change, so its
 * promptGuidelines carry the enabled routes' descriptions — exec's params
 * are an opaque record, so guidelines are the only channel the model
 * learns routed contracts from.
 *
 * Rendering and prepareArguments are delegated to the routed definition.
 * Params can be nested ({ route, params: { ... } }) or flat.
 *
 * Every non-job call spawns a fire-and-forget job. Collect results via
 * route "job" with params { id }. This is deliberate: the model always
 * sees a fast "spawned" response and must explicitly await the result.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent"
import {
	createReadToolDefinition,
	createBashToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
	createGrepToolDefinition,
	createFindToolDefinition,
	createLsToolDefinition,
	getAgentDir,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent"
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui"
import { Type } from "@sinclair/typebox"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

type AnyDef = ToolDefinition<any, any>

// ---- shared cross-extension route registry -------------------------------

// Symbol.for = same key even if this module is instantiated twice.
function execRoutes(): Map<string, AnyDef> {
	const g = globalThis as any
	return (g[Symbol.for("pi-exec.routes")] ??= new Map())
}

// ---- built-in backends ----------------------------------------------------

// The complete built-in set. A data table because the factory functions are
// the only public handle to built-in execute + renderers.
const factories = {
	read: createReadToolDefinition,
	bash: createBashToolDefinition,
	edit: createEditToolDefinition,
	write: createWriteToolDefinition,
	grep: createGrepToolDefinition,
	find: createFindToolDefinition,
	ls: createLsToolDefinition,
} as const

const builtinGuidelines: Record<string, string> = {
	read: 'Route "read": read files. Params { path, offset?, limit? }',
	bash: 'Route "bash": run commands. Params { command, timeout? }',
	edit: 'Route "edit": edit files. Params { path, oldText, newText }',
	write: 'Route "write": write files. Params { path, content }',
	grep: 'Route "grep": search file contents. Params { pattern, path?, glob? }',
	find: 'Route "find": find files by glob. Params { pattern, path? }',
	ls: 'Route "ls": list directories. Params { path? }',
	job: 'Route "job": Collect job result by job id. Params { id: string } — every exec call returns a job id immediately; use the "job" route to await the actual result.',
}

const defsByCwd = new Map<string, Record<string, AnyDef>>()

function builtinDefs(cwd: string): Record<string, AnyDef> {
	let defs = defsByCwd.get(cwd)
	if (!defs) {
		defs = Object.fromEntries(
			Object.entries(factories).map(([name, create]) => [name, create(cwd)]),
		)
		defsByCwd.set(cwd, defs)
	}
	return defs
}

/** Registry routes shadow same-named built-ins. Unrestricted: also used to render history. */
function resolveRoute(route: string, cwd: string): AnyDef | undefined {
	return execRoutes().get(route) ?? builtinDefs(cwd)[route]
}

function candidateRoutes(): string[] {
	return [...new Set([...Object.keys(factories), ...execRoutes().keys()])]
}

// ---- params helpers -------------------------------------------------------

/** Extract routed params: nested under `params`, or flat beside `route`. */
function innerParams(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return {}
	const { route: _r, params: p, ...rest } = raw as Record<string, unknown>
	return p ?? rest
}

/** Apply the routed tool's prepareArguments, tolerating partial args. */
function prepared(def: AnyDef, raw: unknown): unknown {
	const inner = innerParams(raw)
	if (!def.prepareArguments) return inner
	try {
		return def.prepareArguments(inner)
	} catch {
		return inner
	}
}

// ---- job stores (fire-and-forget jobs) ------------------------------------

let jobCounter = 0
const jobs = new Map<string, { route: string; args: unknown; promise: Promise<any> }>()
// ponytail: jobs never cancelled/GC'd; add abort/eviction if sessions run long.

// ---- persistence (same pattern as pi-tools) -------------------------------

function storePath(): string {
	return join(getAgentDir(), "pi-exec.json")
}

function loadSavedRoutes(): string[] | null {
	if (!existsSync(storePath())) return null
	try {
		const data = JSON.parse(readFileSync(storePath(), "utf-8"))
		if (Array.isArray(data.routes)) return data.routes
	} catch {
		// corrupt file — fall through to defaults
	}
	return null
}

function saveRoutes(names: string[]): void {
	try {
		writeFileSync(storePath(), JSON.stringify({ routes: names }, null, 2) + "\n")
	} catch {
		// best-effort
	}
}

// ---- exec tool ------------------------------------------------------------

function registerExec(pi: ExtensionAPI, enabled: Set<string>) {
	const registry = execRoutes()
	const routesListed = [...enabled, "job"].join(", ")

	const guidelines: string[] = []
	for (const name of enabled) {
		const def = registry.get(name)
		if (def) {
			guidelines.push(`Route "${name}": ${def.description}`)
			for (const g of def.promptGuidelines ?? []) guidelines.push(g)
		} else if (builtinGuidelines[name]) {
			guidelines.push(builtinGuidelines[name])
		}
	}
	guidelines.push(builtinGuidelines.job)
	guidelines.push("Always collect edit/write jobs before depending on their results.")

	pi.registerTool({
		name: "exec",
		label: "exec",
		description:
			`Dispatch tool calls by route (${routesListed}). Every call spawns a job and returns its id immediately. Collect results via route "job" with params { id }. Always collect edit/write jobs before depending on them.`,
		promptSnippet:
			`exec — call any tool by route (${routesListed}). ` +
			"Every call returns a job id immediately; collect via route \"job\" params { id }. " +
			"Always collect every spawned job to get actual results. Always collect edit/write before depending on them.",
		executionMode: "parallel",
		promptGuidelines: guidelines,
		parameters: Type.Object(
			{
				route: Type.String({ description: `Target tool: ${routesListed}` }),
				params: Type.Optional(
					Type.Record(Type.String(), Type.Any(), {
						description:
							"Tool parameters. Pass nested under params key, or alongside at top level.",
					}),
				),
			},
			{ additionalProperties: Type.Any() },
		),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const route = (params as Record<string, unknown>).route as string

			// pre-check: job collection — handled before route resolution
			if (route === "job") {
				const inner = innerParams(params) as Record<string, unknown>
				const id = inner?.id as string | undefined
				if (!id || !jobs.has(id)) {
					return {
						content: [
							{
								type: "text",
								text: `Unknown or missing job id: ${id ?? "<no id>"}. Known jobs: ${[...jobs.keys()].join(", ") || "(none)"}`,
							},
						],
						details: { error: true },
					}
				}
				const job = jobs.get(id)!
				return await job.promise
			}

			const def = enabled.has(route) ? resolveRoute(route, ctx.cwd) : undefined
			if (!def) {
				return {
					content: [
						{ type: "text", text: `Unknown route: ${route}. Available: ${routesListed}` },
					],
					details: { error: true },
				}
			}

			const id = `job-${++jobCounter}`
			const promise = def
				.execute(toolCallId, prepared(def, params), new AbortController().signal, () => {}, ctx)
				.catch((err) => ({
					content: [{ type: "text", text: String(err) }],
					details: { error: true },
				}))
			jobs.set(id, { route, args: innerParams(params), promise })
			return {
				content: [
					{
						type: "text",
						text: `spawned ${id} (route=${route}). Collect: exec route "job", params {id:"${id}"}`,
					},
				],
				details: { jobId: id, route },
			}
		},
		renderCall(args, theme, context) {
			const route = (args as any)?.route as string
			const def = resolveRoute(route, context.cwd)
			if (def?.renderCall) {
				const inner = prepared(def, args)
				return def.renderCall(inner, theme, { ...context, args: inner })
			}
			return new Text(
				theme.fg("toolTitle", theme.bold("exec ")) +
					theme.fg("muted", String(route ?? "")),
				0,
				0,
			)
		},
		renderResult(result, options, theme, context) {
			const args = context.args as Record<string, unknown> | undefined
			const route = args?.route as string

			// Spawn results (from fire-and-forget exec) — plain text
			if (result?.details?.jobId) {
				const first = result.content?.[0]
				return new Text(first?.type === "text" ? first.text : "", 0, 0)
			}

			// Job collection results — delegate to the original route's renderer
			if (route === "job") {
				const inner = innerParams(args) as Record<string, unknown>
				const jobId = inner?.id as string | undefined
				const job = jobId ? jobs.get(jobId) : undefined
				if (job) {
					const def = resolveRoute(job.route, context.cwd)
					if (def?.renderResult) {
						return def.renderResult(result as any, options, theme, {
							...context,
							args: job.args,
						})
					}
				}
				// Map miss (history replay) or no renderer — plain text fallback
				const first = result.content?.[0]
				return new Text(first?.type === "text" ? first.text : "", 0, 0)
			}

			// Normal route rendering
			const def = resolveRoute(route, context.cwd)
			if (def?.renderResult) {
				return def.renderResult(result as any, options, theme, {
					...context,
					args: prepared(def, args),
				})
			}
			const first = result.content?.[0]
			return new Text(first?.type === "text" ? first.text : "", 0, 0)
		},
	})
}

// ---- extension ------------------------------------------------------------

export default function execExtension(pi: ExtensionAPI) {
	let enabled = new Set<string>()

	function applyRoutes(names: string[]) {
		enabled = new Set(names)
		registerExec(pi, enabled)
		// Deactivate enabled routes (they go through exec); leave the rest of
		// the live active set untouched. Disabled routes are simply not added,
		// so a route off in stock pi (grep/find/ls) stays off entirely.
		const keep = pi.getActiveTools().filter((n) => !enabled.has(n) && n !== "exec")
		pi.setActiveTools(["exec", ...keep])
	}

	// Register at session_start: all extensions have loaded, so the route
	// registry is complete.
	pi.on("session_start", async () => {
		const saved = loadSavedRoutes()
		const candidates = new Set(candidateRoutes())
		const routes = saved
			? saved.filter((n) => candidates.has(n))
			: // Default mirrors pi: active built-ins only plus all registry routes.
				[
					...Object.keys(factories).filter((n) => pi.getActiveTools().includes(n)),
					...execRoutes().keys(),
				]
		applyRoutes([...new Set(routes)])
	})

	// /exec-tools — toggle exec routes, same UI pattern as pi-tools' /tools.
	pi.registerCommand("exec-tools", {
		description: "Toggle which routes the exec tool exposes",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/exec-tools requires TUI mode", "error")
				return
			}
			await ctx.ui.custom((tui, theme, _kb, done) => {
				const items: SettingItem[] = candidateRoutes().map((name) => ({
					id: name,
					label: name,
					currentValue: enabled.has(name) ? "enabled" : "disabled",
					values: ["enabled", "disabled"],
				}))

				const container = new Container()
				container.addChild(new Text(theme.fg("accent", theme.bold("Exec Routes")), 1, 1))

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						const next = new Set(enabled)
						newValue === "enabled" ? next.add(id) : next.delete(id)
						applyRoutes([...next])
						saveRoutes([...next])
					},
					() => done(undefined),
				)
				container.addChild(settingsList)

				return {
					render: (w) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						settingsList.handleInput?.(data)
						tui.requestRender()
					},
				}
			})
		},
	})
}