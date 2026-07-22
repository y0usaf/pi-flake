/**
 * Permissions — Kimi Code-style allow/ask/deny rules for tool calls.
 *
 * Rules are loaded from (first match wins, in this order):
 *   1. <project>/.pi/pi-kimi/permissions.json   (nearest .pi dir walking up from cwd)
 *   2. ~/.pi/agent/pi-kimi/permissions.json
 *   3. Built-in defaults
 *
 * Config shape:
 *   {
 *     "rules": [
 *       { "action": "allow" | "ask" | "deny", "tool": "bash", "pattern": "^git status" },
 *       { "action": "deny", "tool": "write", "pattern": "**\/\.env" }
 *     ]
 *   }
 *
 * For bash, `pattern` is a regex tested against the command. For file tools
 * (read, write, edit), `pattern` is a glob matched against the resolved path
 * (supports `**`, `*`, `?`). Rules with "tool": "*" apply to every tool.
 *
 * "ask" prompts in interactive mode and blocks in non-interactive mode.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getPermissionMode } from "./state.js";

type Action = "allow" | "ask" | "deny";

interface Rule {
	action: Action;
	tool: string;
	pattern: string;
	source: string;
}

const FILE_TOOLS = new Set(["read", "write", "edit"]);

function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i++;
				if (glob[i + 1] === "/") i++;
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else if ("\\^$.|+()[]{}".includes(c)) {
			re += `\\${c}`;
		} else {
			re += c;
		}
	}
	return new RegExp(`^${re}$`);
}

function loadRulesFrom(filePath: string, source: string): Rule[] {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as { rules?: unknown };
		if (!Array.isArray(parsed.rules)) return [];
		const rules: Rule[] = [];
		for (const r of parsed.rules) {
			const rule = r as Partial<Rule>;
			if (
				(rule.action === "allow" || rule.action === "ask" || rule.action === "deny") &&
				typeof rule.tool === "string" &&
				typeof rule.pattern === "string"
			) {
				rules.push({ action: rule.action, tool: rule.tool, pattern: rule.pattern, source });
			}
		}
		return rules;
	} catch {
		return [];
	}
}

function findProjectConfig(cwd: string): string | null {
	let dir = cwd;
	while (true) {
		const candidate = path.join(dir, ".pi", "pi-kimi", "permissions.json");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function defaultRules(cwd: string): Rule[] {
	const defaults: Array<Omit<Rule, "source">> = [
		// Dangerous shell commands
		{ action: "ask", tool: "bash", pattern: "\\brm\\s+(-[a-zA-Z]*[rf]|--recursive)" },
		{ action: "ask", tool: "bash", pattern: "\\bsudo\\b" },
		{ action: "ask", tool: "bash", pattern: "\\b(chmod|chown)\\b.*777" },
		{ action: "ask", tool: "bash", pattern: "\\bdd\\b.*\\bof=/dev/" },
		{ action: "ask", tool: "bash", pattern: "\\bmkfs" },
		{ action: "ask", tool: "bash", pattern: "\\bgit\\s+push\\b.*(--force|-f\\b)" },
		{ action: "ask", tool: "bash", pattern: "\\bgit\\s+reset\\s+--hard" },
		{ action: "ask", tool: "bash", pattern: "(curl|wget)[^|]*\\|\\s*(sudo\\s+)?(ba|z|fi)?sh\\b" },
		// Credential-ish files
		{ action: "ask", tool: "write", pattern: "**/.env" },
		{ action: "ask", tool: "write", pattern: "**/.env.*" },
		{ action: "ask", tool: "write", pattern: "**/.ssh/**" },
		{ action: "ask", tool: "write", pattern: "**/*.pem" },
		{ action: "ask", tool: "edit", pattern: "**/.env" },
		{ action: "ask", tool: "edit", pattern: "**/.env.*" },
		{ action: "ask", tool: "edit", pattern: "**/.ssh/**" },
		{ action: "ask", tool: "edit", pattern: "**/*.pem" },
		{ action: "deny", tool: "read", pattern: "**/.ssh/id_*" },
		// The plan-mode plan files must stay writable even in plan mode.
		{ action: "allow", tool: "write", pattern: `${getAgentDir()}/pi-kimi/plans/**` },
		{ action: "allow", tool: "edit", pattern: `${getAgentDir()}/pi-kimi/plans/**` },
		// Writes inside the working directory are fine...
		{ action: "allow", tool: "write", pattern: `${cwd}/**` },
		{ action: "allow", tool: "edit", pattern: `${cwd}/**` },
		// ...anything outside it needs confirmation (catch-all).
		{ action: "ask", tool: "write", pattern: "**" },
		{ action: "ask", tool: "edit", pattern: "**" },
	];
	return defaults.map((r) => ({ ...r, source: "defaults" }));
}

function extractSubject(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
	if (toolName === "bash") {
		return typeof input.command === "string" ? input.command : undefined;
	}
	if (FILE_TOOLS.has(toolName)) {
		const p = input.path ?? input.file_path;
		if (typeof p !== "string") return undefined;
		return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
	}
	return undefined;
}

function matchRule(rule: Rule, toolName: string, subject: string): boolean {
	if (rule.tool !== "*" && rule.tool !== toolName) return false;
	try {
		if (toolName === "bash") return new RegExp(rule.pattern, "i").test(subject);
		if (FILE_TOOLS.has(toolName)) return globToRegExp(rule.pattern).test(subject);
		return false;
	} catch {
		return false;
	}
}

export function registerPermissions(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		const toolName = event.toolName;
		const subject = extractSubject(toolName, event.input as Record<string, unknown>, ctx.cwd);

		// Tools without a matchable subject are allowed through.
		if (subject === undefined) return;

		const rules: Rule[] = [];
		const projectConfig = findProjectConfig(ctx.cwd);
		if (projectConfig) rules.push(...loadRulesFrom(projectConfig, projectConfig));
		const globalConfig = path.join(getAgentDir(), "pi-kimi", "permissions.json");
		rules.push(...loadRulesFrom(globalConfig, globalConfig));

		// First match wins: user rules (project, then global), then defaults.
		// The defaults end with in-cwd allow rules followed by outside-cwd
		// catch-all ask rules, so writes never fall through silently.
		const evaluationOrder = [...rules, ...defaultRules(ctx.cwd)];

		for (const rule of evaluationOrder) {
			if (!matchRule(rule, toolName, subject)) continue;

			if (rule.action === "allow") return;

			if (rule.action === "deny") {
				return { block: true, reason: `Blocked by pi-kimi permission rule (${rule.source}): ${rule.action} ${rule.tool} "${rule.pattern}"` };
			}

			// ask: yolo/auto modes auto-approve; otherwise prompt (block when non-interactive).
			if (getPermissionMode() !== "manual") return;
			if (!ctx.hasUI) {
				return {
					block: true,
					reason: `Confirmation required but no UI available (rule: ${rule.tool} "${rule.pattern}" from ${rule.source})`,
				};
			}
			const preview = subject.length > 300 ? `${subject.slice(0, 300)}...` : subject;
			const choice = await ctx.ui.select(
				`Permission request (${rule.source})\n\n  ${toolName}: ${preview}\n\nAllow?`,
				["Yes", "No"],
			);
			if (choice !== "Yes") {
				return { block: true, reason: "Blocked by user" };
			}
			return;
		}

		// No rule matched: allow.
		return;
	});
}
