/**
 * Hooks — run user shell commands at agent lifecycle events (Kimi Code-style).
 *
 * Config: ~/.pi/agent/pi-kimi/hooks.json and <project>/.pi/pi-kimi/hooks.json
 *   {
 *     "hooks": [
 *       { "event": "tool_call", "command": "./scripts/gate.sh", "timeoutMs": 10000 },
 *       { "event": "session_start", "command": "notify-send 'pi session started'" }
 *     ]
 *   }
 *
 * Supported events: session_start, before_agent_start, turn_end, agent_end, tool_call.
 * The event payload is passed as JSON on stdin; PI_KIMI_EVENT is set to the event
 * name. For tool_call, a non-zero exit blocks the call with the hook's output as
 * the reason; for all other events the exit code is ignored.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SUPPORTED_EVENTS = ["session_start", "before_agent_start", "turn_end", "agent_end", "tool_call"] as const;
type HookEvent = (typeof SUPPORTED_EVENTS)[number];

interface Hook {
	event: HookEvent;
	command: string;
	timeoutMs: number;
	source: string;
}

function loadHooksFrom(filePath: string, source: string): Hook[] {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as { hooks?: unknown };
		if (!Array.isArray(parsed.hooks)) return [];
		const hooks: Hook[] = [];
		for (const h of parsed.hooks) {
			const hook = h as Partial<Hook>;
			if (
				typeof hook.event === "string" &&
				(SUPPORTED_EVENTS as readonly string[]).includes(hook.event) &&
				typeof hook.command === "string"
			) {
				hooks.push({
					event: hook.event as HookEvent,
					command: hook.command,
					timeoutMs: typeof hook.timeoutMs === "number" && hook.timeoutMs > 0 ? hook.timeoutMs : 10000,
					source,
				});
			}
		}
		return hooks;
	} catch {
		return [];
	}
}

function findProjectConfig(cwd: string, name: string): string | null {
	let dir = cwd;
	while (true) {
		const candidate = path.join(dir, ".pi", "pi-kimi", name);
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function loadAllHooks(cwd: string): Hook[] {
	const hooks: Hook[] = [];
	const projectConfig = findProjectConfig(cwd, "hooks.json");
	if (projectConfig) hooks.push(...loadHooksFrom(projectConfig, projectConfig));
	const globalConfig = path.join(getAgentDir(), "pi-kimi", "hooks.json");
	hooks.push(...loadHooksFrom(globalConfig, globalConfig));
	return hooks;
}

function runHook(
	hook: Hook,
	payload: unknown,
	cwd: string,
): Promise<{ code: number; output: string }> {
	return new Promise((resolve) => {
		const child = execFile(
			"sh",
			["-c", hook.command],
			{
				cwd,
				timeout: hook.timeoutMs,
				maxBuffer: 1024 * 1024,
				env: { ...process.env, PI_KIMI_EVENT: hook.event },
			},
			(error, stdout, stderr) => {
				const code = error && typeof error.code !== "number" ? 1 : ((error?.code as number | undefined) ?? 0);
				resolve({ code, output: [stdout, stderr].filter(Boolean).join("\n").trim() });
			},
		);
		child.stdin?.end(JSON.stringify(payload));
	});
}

export function registerHooks(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		const hooks = loadAllHooks(ctx.cwd).filter((h) => h.event === "tool_call");
		for (const hook of hooks) {
			const { code, output } = await runHook(
				hook,
				{ tool: event.toolName, input: event.input },
				ctx.cwd,
			);
			if (code !== 0) {
				return {
					block: true,
					reason: `Blocked by pi-kimi hook (${hook.source}): ${hook.command}\n${output}`,
				};
			}
		}
		return;
	});

	const runEventHooks = async (event: HookEvent, cwd: string) => {
		const hooks = loadAllHooks(cwd).filter((h) => h.event === event);
		for (const hook of hooks) {
			await runHook(hook, {}, cwd);
		}
	};

	pi.on("session_start", async (_event, ctx) => runEventHooks("session_start", ctx.cwd));
	pi.on("before_agent_start", async (_event, ctx) => runEventHooks("before_agent_start", ctx.cwd));
	pi.on("turn_end", async (_event, ctx) => runEventHooks("turn_end", ctx.cwd));
	pi.on("agent_end", async (_event, ctx) => runEventHooks("agent_end", ctx.cwd));
}
