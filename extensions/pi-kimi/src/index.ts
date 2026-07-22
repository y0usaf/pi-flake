/**
 * pi-kimi — Kimi Code-style agent features for pi.
 *
 * Bundles: subagents (with background tasks + resume), plan mode,
 * allow/ask/deny permissions, lifecycle shell hooks, and a todo tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.js";
import { registerHooks } from "./hooks.js";
import { registerPermissions } from "./permissions.js";
import { registerPlanMode } from "./plan-mode.js";
import registerSubagents from "./subagents.js";
import { registerTodos } from "./todos.js";

export default function (pi: ExtensionAPI) {
	registerSubagents(pi);
	registerPlanMode(pi);
	registerPermissions(pi);
	registerHooks(pi);
	registerTodos(pi);
	registerCommands(pi);
}
