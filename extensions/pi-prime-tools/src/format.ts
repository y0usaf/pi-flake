import type { Theme } from "@earendil-works/pi-coding-agent";
import { SPECS } from "./specs";
import type { RenderDeps } from "./skin";

/** Interior call row built from the SPECS data tables: prefix (`$` for bash,
 * the label otherwise) + primary, with extras appended as dim `key=value`. */
export function callHeaderLine(name: string, args: any, theme: Theme, deps: RenderDeps): string {
	const spec = SPECS[name];
	if (!spec) return theme.fg("toolTitle", theme.bold(name));
	const prefix = spec.prefix ?? spec.label;
	const base = theme.fg("toolTitle", theme.bold(`${prefix} ${spec.primary(args, deps)}`));
	const extras = spec.extras(args, deps).map(([k, v]) => `${k}=${v}`);
	return extras.length > 0 ? `${base} ${theme.fg("dim", extras.join(" "))}` : base;
}