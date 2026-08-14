import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-yourshell — the native bash tool, identical, except the shell binary is
 * $SHELL instead of pi's hardcoded /bin/bash.
 *
 * createBashToolDefinition is the exact factory pi uses for its built-in bash
 * tool. Registering a tool named "bash" shadows the built-in (extension tools
 * overwrite same-named built-ins in the tool registry). No-op when $SHELL is
 * unset, so the native bash tool stays in place.
 */
export default function (pi: ExtensionAPI) {
	const shell = process.env.SHELL;
	if (!shell) return;
	pi.registerTool(createBashToolDefinition(process.cwd(), { shellPath: shell }));
}
