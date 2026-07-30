/**
 * pi-quiet — minimalist chrome, emoticon soul.
 *
 * Header removed; working loader row removed; hidden thinking collapses to
 * one blank line (empty label); faces on builtin tool rows; face embedded
 * in the editor's top border (colored by the live thinking-level border
 * color). While an agent run is active the whole top border pulses through
 * PULSE — the editor border IS the working indicator.
 *
 * Tool rows re-register the builtin *definitions* (not the wrapped
 * AgentTools) so promptSnippet/promptGuidelines survive the override.
 * Quiet rows (bash, grep, find, ls) go further: renderShell "self", so no
 * boxed background; a successful result renders NO body — the call row
 * gains a dim digest (` · ok · ctrl+o`, ` · 14 hits · ctrl+o`) and the
 * output stays behind ctrl+o. A failed result speaks: full output under a
 * thin error-colored rail. write keeps builtin result rendering: diffs
 * win over quiet. read/edit are absent on purpose: pi-hashline registers
 * those names.
 *
 * All personality is in the tables below. One timer, started and stopped
 * by agent_start/agent_end, same pattern as pi's rainbow-editor example.
 */

import {
	createBashToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createWriteToolDefinition,
	CustomEditor,
	keyText,
	type ExtensionAPI,
	type ExtensionUIContext,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

const PULSE_MS = 240;
const PULSE: ThemeColor[] = ["dim", "muted", "accent", "muted"];
const EDITOR_FACE = "(^-^)";
const ERROR_FACE = "(x_x)";
const RAIL = "│";

const tilde = (path?: string) => {
	const p = path ?? ".";
	return p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p;
};

const textOf = (r: any): string =>
	(r?.content ?? []).map((c: any) => c?.text ?? "").join("\n").trim();

const nonEmpty = (t: string) => t.split("\n").filter((l) => l.trim().length > 0);

const EMPTY_RESULT = /^(No matches found|No files found matching pattern|\(empty directory\))$/;

const expandHint = () => {
	try {
		return keyText("app.tools.expand" as any) || "ctrl+o";
	} catch {
		return "ctrl+o";
	}
};

const rail = (ls: string[], bar: string) => ls.map((l) => `  ${bar} ${l}`).join("\n");

const oneLine = (cmd?: string) => {
	const ls = String(cmd ?? "...").split("\n");
	return ls.length > 1 ? `${ls[0]} …` : ls[0];
};

// digest = the one-line success summary parked on the call row; the result
// body stays hidden behind it until ctrl+o. Failures render in full.
type Digest = (text: string, details: any) => string;
const count = (empty: string, unit: (n: number) => string): Digest => {
	return (text) => {
		const ls = nonEmpty(text);
		if (ls.length === 0 || (ls.length === 1 && EMPTY_RESULT.test(ls[0]))) return empty;
		return unit(ls.length);
	};
};

// name, face, builtin definition factory, call-line summary, success
// digest. Rows with a digest go quiet: self-shell, hidden success output,
// railed failures. write omits it on purpose — its diff stays builtin.
const TOOL_ROWS: Array<
	[name: string, face: string, make: (cwd: string) => any, arg: (a: Record<string, any>) => string, digest?: Digest]
> = [
	["bash", "(>_o)", createBashToolDefinition, (a) => `$ ${oneLine(a.command)}`, (_t, d) => `ok${d?.truncation ? " · truncated" : ""}`],
	["write", "(^-^)", createWriteToolDefinition, (a) => tilde(a.path)],
	["grep", "(o_O)", createGrepToolDefinition, (a) => `/${a.pattern ?? ""}/ ${tilde(a.path)}`, count("no matches", (n) => `${n} hits`)],
	["find", "(@_@)", createFindToolDefinition, (a) => `${a.pattern ?? ""} ${tilde(a.path)}`, count("none", (n) => `${n} found`)],
	["ls", "(-_-)", createLsToolDefinition, (a) => tilde(a.path), count("empty", (n) => `${n} entries`)],
];

// builtin definitions are cwd-bound at construction; memoize per cwd so a
// subagent running elsewhere still resolves paths against its own cwd.
const defCache = new Map<string, any>();
const defFor = (name: string, make: (cwd: string) => any, cwd: string) => {
	const key = `${cwd}\0${name}`;
	let def = defCache.get(key);
	if (!def) defCache.set(key, (def = make(cwd)));
	return def;
};

const ANSI = /\x1b\[[0-9;]*m/g;
const isPlainBorder = (line: string) => /^─+$/.test(line.replace(ANSI, ""));

// this.theme on Editor is the narrow EditorTheme (borderColor + selectList
// only, no fg/bg); the full Theme lives on ctx.ui and is read lazily so a
// mid-session theme switch is picked up.
let uiCtx: ExtensionUIContext | undefined;
let editor: QuietEditor | undefined;
let agentActive = false;
let pulseTimer: ReturnType<typeof setInterval> | undefined;
let pulseFrame = 0;

const startPulse = () => {
	if (pulseTimer) return;
	pulseFrame = 0;
	const t = setInterval(() => {
		pulseFrame++;
		editor?.requestPulse();
	}, PULSE_MS);
	t.unref?.();
	pulseTimer = t;
};
const stopPulse = () => {
	agentActive = false;
	if (pulseTimer) clearInterval(pulseTimer);
	pulseTimer = undefined;
	editor?.requestPulse(); // one last static-color render
};

class QuietEditor extends CustomEditor {
	private colors: ThemeColor[] = PULSE;
	render(width: number): string[] {
		const lines = super.render(width);
		// drop the bottom border (last plain-border line), keep scroll
		// indicators and autocomplete lines untouched
		for (let i = lines.length - 1; i > 0; i--) {
			if (isPlainBorder(lines[i])) {
				lines.splice(i, 1);
				break;
			}
		}
		// face in the top border; idle: borderColor (live thinking level);
		// running: border+face pulse through the theme ramp, replacing the
		// removed working indicator
		if (lines.length > 0 && isPlainBorder(lines[0])) {
			const paint = agentActive
				? (s: string) => uiCtx?.theme.fg(this.colors[pulseFrame % this.colors.length], s) ?? s
				: this.borderColor;
			const face = paint(EDITOR_FACE);
			const rule = paint("─".repeat(Math.max(0, width - visibleWidth(EDITOR_FACE) - 1)));
			lines[0] = `${face} ${rule}`;
		}
		return lines;
	}
	requestPulse() {
		this.tui.requestRender();
	}
}
export default function (pi: ExtensionAPI) {
	// Same execution as the builtins. Quiet rows: the call line carries the
	// digest once the result lands; success renders no body, failure rails
	// its full output. Non-quiet rows (write) keep builtin result rendering.
	for (const [name, face, make, arg, digest] of TOOL_ROWS) {
		pi.registerTool({
			...defFor(name, make, process.cwd()),
			// quiet rows draw their own framing: no Box padding, no status bg
			...(digest ? { renderShell: "self" as const } : {}),
			execute: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) =>
				defFor(name, make, ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx),
			renderCall(args: any, theme: any, ctx: any) {
				const failed = ctx?.isError === true;
				const digestText = ctx?.state?.digest as string | undefined;
				const done = failed || digestText !== undefined;
				const glyph = theme.fg(failed ? "error" : done ? "accent" : "dim", failed ? ERROR_FACE : face);
				const summary = theme.fg("dim", arg(args ?? {}));
				const suffix = digestText ? theme.fg("dim", ` · ${digestText}`) : "";
				return new Text(`${glyph} ${theme.bold(name)} ${summary}${suffix}`, 0, 0);
			},
			...(digest
				? {
						renderResult(result: any, opts: any, theme: any, ctx: any) {
							const text = textOf(result);
							if (opts?.isPartial) {
								const last = nonEmpty(text).pop();
								return last ? new Text(rail([last], theme.fg("dim", RAIL)), 0, 0) : new Container();
							}
							if (ctx?.isError) {
								return new Text(rail(nonEmpty(text), theme.fg("error", RAIL)), 0, 0);
							}
							const more = nonEmpty(text).length > 0 && !EMPTY_RESULT.test(text);
							const d = more ? `${digest(text, result?.details)} · ${expandHint()}` : digest(text, result?.details);
							if (ctx?.state && ctx.state.digest !== d) {
								ctx.state.digest = d;
								// renderCall already ran first in this pass; re-render so
								// the digest lands on the call row. Guarded: the second
								// pass sees an equal digest and does not invalidate.
								queueMicrotask(() => ctx.invalidate?.());
							}
							if (opts?.expanded) return new Text(rail(nonEmpty(text), theme.fg("dim", RAIL)), 0, 0);
							return new Container();
						},
					}
				: {}),
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		uiCtx = ctx.ui;
		ctx.ui.setHeader(() => ({
			render: () => [],
			invalidate() {},
		}));

		// loader row goes away entirely; the editor border takes its job
		ctx.ui.setWorkingVisible(false);

		// empty label: the builtin Text renders zero visible text, so a hidden
		// thinking run costs one blank line instead of a word. ctrl+t unhides.
		ctx.ui.setHiddenThinkingLabel("");

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			editor = new QuietEditor(tui, theme, keybindings);
			return editor;
		});
	});

	pi.on("agent_start", () => {
		agentActive = true;
		startPulse();
	});
	pi.on("agent_end", stopPulse);
	pi.on("agent_settled", stopPulse);
	pi.on("session_shutdown", stopPulse);
}
