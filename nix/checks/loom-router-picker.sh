#!/usr/bin/env bash
# Runtime acceptance for phase P5c of extensions/pi-loom/DESIGN.md: the startup
# workflow picker. `loom` opens on the list of workflows it can run, and Esc
# drops to chat.
#
# What is under test. pi-loom-router registers a second `session_start` handler
# that reads pi.getCommands(), filters it down to the engine's workflow
# commands, offers them through ctx.ui.select, and prefills the chosen one into
# the editor. Five things can go wrong, and only the first is loud:
#
#   * the picker never appears (the phase bought nothing, and `loom` still opens
#     looking like a `pi` that has lost its editing tools);
#   * Esc does not drop to chat (a modal with no exit is a wall, and the user
#     has no way to reach the router at all);
#   * the filter is wrong (the picker offers /workflow, /interview or /atelier,
#     none of which are workflows, or misses a real one);
#   * the picker overwrites text the user already had in the editor;
#   * the picker fires in a non-TUI mode, where ctx.ui.select emits an
#     `extension_ui_request` and waits forever for a client that will never
#     answer it — which would hang every other check in this repo, since they
#     all drive `loom` over RPC with a script that cannot answer a dialog.
#
# How it is proved without a model, and without a terminal. Same shape as
# checks.pi-loom-router-shell and upstream's own extension tests
# (packages/coding-agent/test/plan-mode-extension.test.ts): the real extension
# file out of the built package is imported, handed a stub ExtensionAPI, and
# the handlers it registered are called with synthetic events and a stub ctx
# whose ui.select answers however the scenario needs. Nothing inside the
# extension is mocked, so a regression in the wiring or in the filter fails
# here.
#
# The command listing the stub replays is not invented: it is the shape a real
# `loom` reports from pi.getCommands(), where /build, /quick, /workflows and
# /workflow all carry the engine's src/index.ts as sourceInfo.path while every
# other extension carries its own file.
#
# The gap, stated honestly: this proves the handler pi would call, not that pi's
# TUI renders a dialog for it. checks.pi-loom-router-gate covers the live half —
# it boots a real `loom` in RPC mode, so it fails if this handler throws or
# blocks there.
#
# Usage: loom-router-picker.sh <path-to-pi-loom-router-package>
set -euo pipefail

router="${1:?usage: loom-router-picker.sh <pi-loom-router-package>}"
entry="$router/src/index.ts"

[ -f "$entry" ] || {
  echo "router-picker: $entry does not exist, so nothing was tested" >&2
  exit 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Node runs the extension's TypeScript directly: type stripping is on by
# default from Node 22.18, and the router imports nothing but types from pi.
cat >"$work/driver.mjs" <<'JS'
import { pathToFileURL } from "node:url";

const entry = process.argv[2];
const module = await import(pathToFileURL(entry).href);
const factory = module.default;

if (typeof factory !== "function") {
	console.error("router-picker: " + entry + " has no default-exported extension factory");
	process.exit(1);
}

const failures = [];
const fail = (message) => failures.push(message);

// The engine registers every workflow command from its own src/index.ts, which
// is what makes that path usable as an anchor. Two decoys share the file and
// are not workflows (/workflows, /workflow); three more come from other
// extensions in the loom stack and must never appear in the picker.
const ENGINE = "/nix/store/xxxx-pi-loom-3.4.2/src/index.ts";
const commands = [
	{
		name: "build",
		description: "Plan a change, implement it item by item. Usage: /build <task> [context] [maxItems]",
		source: "extension",
		sourceInfo: { path: ENGINE, source: "cli", scope: "temporary", origin: "top-level" },
	},
	{
		name: "quick",
		description: "Make one small change with a single agent. Usage: /quick <task> [context] [model]",
		source: "extension",
		sourceInfo: { path: ENGINE, source: "cli", scope: "temporary", origin: "top-level" },
	},
	{
		name: "workflows",
		description: "List workflow slash commands and the scope each was declared in",
		source: "extension",
		sourceInfo: { path: ENGINE, source: "cli", scope: "temporary", origin: "top-level" },
	},
	{
		name: "workflow",
		description: "Inspect and control workflows for this Pi session",
		source: "extension",
		sourceInfo: { path: ENGINE, source: "cli", scope: "temporary", origin: "top-level" },
	},
	{
		name: "interview",
		description: "Manage ask-user interviews",
		source: "extension",
		sourceInfo: { path: "/nix/store/yyyy-pi-interview-0.1.0/src/index.ts" },
	},
	{
		name: "atelier",
		description: "Open or control the Pi Atelier status menu",
		source: "extension",
		sourceInfo: { path: "/nix/store/zzzz-pi-atelier-0.4.0/extensions/index.ts" },
	},
	{ name: "llama", description: "Manage llama.cpp router models", source: "extension", sourceInfo: { path: "<inline:llama.cpp>" } },
];

// A stub ExtensionAPI. Only what the router touches is implemented; anything
// else it starts calling will throw here, which is the intent.
function stubApi(listing) {
	const handlers = new Map();
	const state = {
		handlers,
		active: ["read", "bash", "edit", "write"],
	};
	state.pi = {
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		getActiveTools: () => [...state.active],
		getAllTools: () => ["read", "bash", "edit", "write", "grep", "find", "ls"].map((name) => ({ name })),
		setActiveTools: (names) => {
			state.active = [...names];
		},
		getCommands: () => listing,
	};
	return state;
}

// A stub ExtensionContext. `answer` decides what the user "pressed": a row
// string, or undefined for Esc. `observe` is called at the moment the dialog
// opens, which is how the gate-before-picker ordering is checked.
function stubCtx({ mode = "tui", answer = undefined, editorText = "", observe = undefined } = {}) {
	const seen = { selects: [], editor: editorText, notified: [], activeAtSelect: undefined };
	return {
		seen,
		ctx: {
			mode,
			cwd: process.cwd(),
			ui: {
				select: async (title, options) => {
					seen.selects.push({ title, options });
					if (observe) seen.activeAtSelect = observe();
					return typeof answer === "function" ? answer(options) : answer;
				},
				getEditorText: () => seen.editor,
				setEditorText: (text) => {
					seen.editor = text;
				},
				notify: (message) => seen.notified.push(message),
			},
		},
	};
}

// Drive every session_start handler the extension registered, in order — which
// is how pi emits them, and how the gate gets to run before the picker awaits.
async function startSession(listing, ctxOptions, reason = "startup") {
	const api = stubApi(listing);
	factory(api.pi);
	const started = handlersFor(api, "session_start");
	if (started.length < 2) {
		fail("the router registered " + started.length + " session_start handler(s); the gate and the picker are two");
		return { api, probe: stubCtx(ctxOptions) };
	}
	const probe = stubCtx({ ...ctxOptions, observe: () => api.pi.getActiveTools() });
	for (const handler of started) await handler({ type: "session_start", reason }, probe.ctx);
	return { api, probe };
}

function handlersFor(api, event) {
	return api.handlers.get(event) ?? [];
}

// ------------------------------------------------- 1. the picker is offered
{
	const { api, probe } = await startSession(commands, { answer: undefined });
	if (probe.seen.selects.length !== 1) {
		fail("startup offered " + probe.seen.selects.length + " picker(s); loom must open on exactly one");
	} else {
		const { title, options } = probe.seen.selects[0];
		if (!/Esc/i.test(title)) fail("the picker title never mentions Esc, so the way out is invisible: " + title);

		// The rows are the acceptance: every installed workflow, nothing else.
		const named = options.map((option) => (/^\/([\w.-]+)/.exec(option) ?? [])[1]).filter(Boolean);
		for (const wanted of ["build", "quick"]) {
			if (!named.includes(wanted)) fail("the picker does not offer /" + wanted + ": " + options.join(" | "));
		}
		for (const unwanted of ["workflow", "workflows", "interview", "atelier", "llama"]) {
			if (named.includes(unwanted)) fail("the picker offers /" + unwanted + ", which is not a workflow");
		}
		if (options.length !== 3) fail("expected two workflows plus an explicit chat row, got: " + options.join(" | "));
		if (!/Esc/i.test(options[options.length - 1])) {
			fail("the last row is not an explicit way to reach chat: " + options[options.length - 1]);
		}
		// The generated usage tail belongs in the palette, not in a menu row.
		if (options.some((option) => option.includes("Usage:"))) {
			fail("a picker row still carries the generated usage tail: " + options.join(" | "));
		}

		// The gate is applied before the picker awaits anything. Registration
		// order is the whole mechanism: pi runs one extension's handlers for an
		// event in the order they were registered, awaiting each, so a picker
		// registered first would leave the chat agent holding `edit` for as long
		// as the dialog is open — which is however long the user takes to read it.
		const atSelect = probe.seen.activeAtSelect ?? [];
		for (const tool of ["edit", "write"]) {
			if (atSelect.includes(tool)) {
				fail("'" + tool + "' was still active while the picker was open; the picker must be registered after the gate");
			}
		}
	}

	// 2. Esc drops to chat: nothing lands in the editor, and the gate still held.
	if (probe.seen.editor !== "") fail("Esc left '" + probe.seen.editor + "' in the editor instead of dropping to chat");
	for (const tool of ["edit", "write"]) {
		if (api.pi.getActiveTools().includes(tool)) {
			fail("the chat agent still holds '" + tool + "' after a startup that opened the picker");
		}
	}
	for (const tool of ["read", "bash", "grep", "find", "ls"]) {
		if (!api.pi.getActiveTools().includes(tool)) fail("the picker cost the chat agent '" + tool + "'");
	}
}

// ------------------------------------- 3. a choice lands as a prefilled command
{
	const { probe } = await startSession(commands, { answer: (options) => options.find((o) => o.startsWith("/build")) });
	if (probe.seen.editor !== "/build ") {
		fail("choosing /build left '" + probe.seen.editor + "' in the editor; expected '/build ' with the cursor after it");
	}
}

// ------------------------- 4. the explicit chat row behaves exactly like Esc
{
	const { probe } = await startSession(commands, { answer: (options) => options[options.length - 1] });
	if (probe.seen.editor !== "") fail("the chat row left '" + probe.seen.editor + "' in the editor");
}

// --------------------------------- 5. no workflows installed, so no dialog
// A `loom` whose agent dir has no workflows must open on a prompt, not on an
// empty menu.
{
	const bare = commands.filter((command) => !["build", "quick"].includes(command.name));
	const { probe } = await startSession(bare, { answer: undefined });
	if (probe.seen.selects.length !== 0) fail("a session with no installed workflows still opened a picker");
}

// ---------------------------------- 6. the engine absent, so no anchor, no dialog
{
	const stripped = commands.filter((command) => command.sourceInfo.path !== ENGINE);
	const { probe } = await startSession(stripped, { answer: undefined });
	if (probe.seen.selects.length !== 0) fail("a stack without the workflow engine still opened a picker");
}

// ------------------------------------------ 7. non-TUI modes never open a dialog
// This is the assertion that keeps every other check in this repo alive: they
// all drive `loom` in --mode rpc, where ui.select waits for a client response
// that never comes.
for (const mode of ["rpc", "json", "print"]) {
	const { probe } = await startSession(commands, { mode, answer: undefined });
	if (probe.seen.selects.length !== 0) fail("mode '" + mode + "' opened a dialog that nothing can answer");
}

// ------------------------------------- 8. only a startup opens the picker
for (const reason of ["reload", "resume", "fork", "new"]) {
	const { probe } = await startSession(commands, { answer: undefined }, reason);
	if (probe.seen.selects.length !== 0) fail("session_start reason '" + reason + "' opened an uninvited picker");
}

// ------------------------------- 9. text already in the editor is never lost
{
	const { probe } = await startSession(commands, { answer: undefined, editorText: "half a thought" });
	if (probe.seen.selects.length !== 0) fail("the picker interrupted a session that already had text in the editor");
	if (probe.seen.editor !== "half a thought") fail("the picker overwrote the editor: " + probe.seen.editor);
}

if (failures.length > 0) {
	for (const message of failures) console.error("router-picker: " + message);
	process.exit(1);
}

console.log(
	"router-picker: startup opens one picker listing /build and /quick and nothing else, " +
		"Esc and the chat row both leave the editor empty, choosing /build prefills '/build ', " +
		"the gate still held, and no dialog opens without workflows, without the engine, " +
		"outside tui mode, outside a startup, or over text the user already typed",
);
JS

node "$work/driver.mjs" "$entry"
