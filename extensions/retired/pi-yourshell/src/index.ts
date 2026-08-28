import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Register $SHELL as the bash tool; no-op when unset.
export default function (pi: ExtensionAPI) {
	const shell = process.env.SHELL;
	if (!shell) return;
	pi.registerTool(createBashToolDefinition(process.cwd(), { shellPath: shell }));
}
