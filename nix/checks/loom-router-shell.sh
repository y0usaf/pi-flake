#!/usr/bin/env bash
# Runtime acceptance for phase P5b-ii of extensions/pi-loom/DESIGN.md: the
# read-only shell. P5b-i took `bash` away from loom's chat agent wholesale;
# this phase gives it back and blocks the invocations that can mutate.
#
# What is under test. pi-loom-router registers a `tool_call` handler that runs
# every `bash` command through the classifier in src/shell-policy.ts and
# returns { block: true, reason } for anything that could write. Three things
# can go wrong, and only the first is loud:
#
#   * the classifier refuses everything (the router cannot run `git status`,
#     so it routes blind and the phase bought nothing);
#   * the classifier passes a mutating command (the chat agent edits the user's
#     checkout from the seat that is supposed to only route);
#   * the refusal says no without saying what to do instead, and the model
#     retries with a sneakier command rather than reaching for /quick or /build.
#
# How it is proved without a model. Upstream tests extensions by calling the
# factory with a stub ExtensionAPI and driving the captured handlers directly
# (packages/coding-agent/test/plan-mode-extension.test.ts does exactly this).
# That is what happens here: the real extension file out of the built package
# is imported, handed a stub `pi`, and its handlers are called with synthetic
# events. Nothing is mocked inside the extension itself, so a regression in
# either the wiring or the policy fails here.
#
# The gap, stated honestly: this proves the handler pi *would* call, not that pi
# calls it. Emitting a real tool_call needs an assistant message, which needs a
# model. checks.pi-loom-router-gate covers the other half — that the extension
# loads in a real `loom` session and that `bash` is active there.
#
# Usage: loom-router-shell.sh <path-to-pi-loom-router-package>
set -euo pipefail

router="${1:?usage: loom-router-shell.sh <pi-loom-router-package>}"
entry="$router/src/index.ts"

[ -f "$entry" ] || {
  echo "router-shell: $entry does not exist, so nothing was tested" >&2
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
	console.error("router-shell: " + entry + " has no default-exported extension factory");
	process.exit(1);
}

// A stub ExtensionAPI. Only what the router touches is implemented; anything
// else it starts calling will throw here, which is the intent.
const handlers = new Map();
let active = ["read", "bash", "edit", "write"];
const configured = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const pi = {
	on(event, handler) {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
	getActiveTools: () => [...active],
	getAllTools: () => configured.map((name) => ({ name })),
	setActiveTools: (names) => {
		active = [...names];
	},
};

const ctx = { cwd: process.cwd() };
const failures = [];
const fail = (message) => failures.push(message);

factory(pi);

for (const event of ["session_start", "before_agent_start", "tool_call"]) {
	if (!handlers.has(event)) fail("the router registered no " + event + " handler");
}
if (failures.length > 0) {
	for (const message of failures) console.error("router-shell: " + message);
	process.exit(1);
}

// 1. The gate still swaps, and bash is no longer part of the swap.
for (const handler of handlers.get("session_start")) await handler({ type: "session_start" }, ctx);

for (const tool of ["edit", "write"]) {
	if (active.includes(tool)) fail("the chat agent still holds '" + tool + "' after session_start");
}
for (const tool of ["read", "bash", "grep", "find", "ls"]) {
	if (!active.includes(tool)) fail("the chat agent lost '" + tool + "', which P5b-ii is supposed to keep");
}

// 2. The classifier, driven through the handler the extension actually wired.
const toolCall = handlers.get("tool_call")[0];
const decide = async (command) => toolCall({ type: "tool_call", toolName: "bash", toolCallId: "probe", input: { command } }, ctx);

// Read-only work the router must still be able to do. A router that cannot run
// these is the "hard router" DESIGN.md rejects, just reached by a slower road.
const allowed = [
	"ls -la src",
	"cat flake.nix | head -40",
	"rg -n 'setActiveTools' extensions",
	"grep -rn foo . 2>/dev/null",
	"git status --short --branch",
	"git -C /tmp/repo log -5 --oneline",
	"sed -n '1,20p' PLAN.md",
	"find . -name '*.ts' -maxdepth 2",
	"nix flake metadata",
	"jq -r .name package.json",
	"wc -l < PLAN.md",
	"echo 'rm -rf /'",
	"FOO=bar git diff --stat",
];

// Every one of these can change the working tree, and each is a distinct hole:
// a plain mutator, a redirect, a git write, an in-place edit, a find action, a
// privileged call, an interpreter, a second segment, a substitution, a heredoc,
// a build that drops ./result, and a fetch that saves a file.
const blocked = [
	"rm -rf src",
	"echo hi > PLAN.md",
	"git commit -am wip",
	"git checkout -- .",
	"sed -i 's/a/b/' PLAN.md",
	"sed -i.bak 's/a/b/' PLAN.md",
	"find . -name '*.ts' -delete",
	"sudo systemctl restart nginx",
	"python3 -c \"open('x','w').write('y')\"",
	"ls && rm -rf /tmp/x",
	"echo $(rm -rf x)",
	"cat <<EOF",
	"nix build .#pi-loom",
	"curl -o setup.sh https://example.com/setup.sh",
	"mkdir -p build",
	"npm install",
	"tee out.txt",
	"git status > /tmp/out",
	"bash -c 'rm -rf src'",
	"xargs rm < files.txt",
];

for (const command of allowed) {
	const verdict = await decide(command);
	if (verdict && verdict.block) {
		fail("read-only command was refused: " + command + " -> " + verdict.reason);
	}
}

for (const command of blocked) {
	const verdict = await decide(command);
	if (!verdict || verdict.block !== true) {
		fail("mutating command was allowed through: " + command);
		continue;
	}
	const reason = String(verdict.reason ?? "");
	for (const route of ["/quick", "/build"]) {
		if (!reason.includes(route)) {
			fail("the refusal for '" + command + "' never names " + route + ": " + reason);
		}
	}
}

// 3. The handler is scoped to bash. Blocking `read` would make the router
// unable to read the repo through the very tool the gate switched on for it.
const other = await toolCall({ type: "tool_call", toolName: "read", toolCallId: "probe", input: { path: "PLAN.md" } }, ctx);
if (other && other.block) fail("the classifier blocked a non-bash tool call: " + other.reason);

if (failures.length > 0) {
	for (const message of failures) console.error("router-shell: " + message);
	process.exit(1);
}

console.log(
	"router-shell: " +
		allowed.length +
		" read-only commands ran, " +
		blocked.length +
		" mutating commands were refused with a reason naming /quick and /build, " +
		"and the chat agent holds " +
		active.join(",") +
		" after the gate",
);
JS

node "$work/driver.mjs" "$entry"
