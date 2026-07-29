export type TreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

const VALID: readonly string[] = ["default", "no-tools", "user-only", "labeled-only", "all"];

/**
 * Read the user's `/tree` filter preference so `/chrono cut` opens with the
 * same view `/tree` would.
 *
 * Extensions get no settings accessor on the context, so the file is read
 * directly. Project settings win over global, matching pi's own precedence,
 * and are consulted only when the project is trusted — an untrusted
 * `.pi/settings.json` must not influence anything we do.
 *
 * Any failure resolves to "default": a wrong filter is a cosmetic difference,
 * never a reason to fail the command.
 */
export function resolveTreeFilterMode(readJson: (path: string) => unknown, paths: readonly string[]): TreeFilterMode {
	for (const path of paths) {
		const parsed = readJson(path);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
		const value = (parsed as Record<string, unknown>).treeFilterMode;
		if (typeof value === "string" && VALID.includes(value)) return value as TreeFilterMode;
	}
	return "default";
}
