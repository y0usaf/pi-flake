#!/usr/bin/env bash
# Runtime acceptance for phase P5b-i of extensions/pi-loom/DESIGN.md: the router
# gate. In `loom` the agent you chat with routes, it does not edit.
#
# What is under test. pi-loom-router removes `edit` and `write` from the active
# tool set at session_start, in memory, never persisted, and is shipped
# only in the loom stack. Three things can go wrong and all three are silent:
#
#   * the gate does not fire (loom keeps its mutating tools and nobody notices
#     until a chat agent rewrites a file it was never meant to touch);
#   * the gate fires too widely (a stack with no read tool looks "safe" and is
#     useless);
#   * the gate leaks into plain `pi` (a user's normal sessions lose edit/write
#     for reasons nothing on screen explains).
#
# It also re-proves the P5a interlock from the other side. P5a made a run's tool
# ceiling come from pi.getAllTools() rather than pi.getActiveTools(); that check
# used a stand-in probe because the router did not exist yet. This one runs the
# real router, so a regression that collapses the launch boundary back into live
# visibility fails here as `UNKNOWN_TOOL` instead of shipping.
#
# Proves, offline, with no model ever contacted:
#   1. In `loom`, the chat agent's active tools contain neither edit nor write,
#      and do contain read, bash, grep, find and ls. The gate is a swap, not a
#      subtraction: pi's default active set is read/bash/edit/write, so removing
#      the mutating tools without switching the read-only three on would leave a
#      router that cannot list a directory. `bash` stays active since P5b-ii and
#      is narrowed per invocation instead — see checks.pi-loom-router-shell.
#   2. In plain `pi`, all three are active. The gate is stack policy, not a
#      change to pi.
#   3. `pi-full` ships no copy of pi-loom-router, so no extension flag can pull
#      the gate into the default bundle.
#   4. A workflow launched inside a gated loom session still records edit, write
#      and bash in its launch snapshot, which is the tool set every sub-agent is
#      checked against.
#
# Usage: loom-router-gate.sh <path-to-loom-binary> <path-to-pi-binary> <pi-full-prefix>
set -euo pipefail

loom="${1:?usage: loom-router-gate.sh <loom-binary> <pi-binary> <pi-full-prefix>}"
pi_bin="${2:?usage: loom-router-gate.sh <loom-binary> <pi-binary> <pi-full-prefix>}"
pi_full="${3:?usage: loom-router-gate.sh <loom-binary> <pi-binary> <pi-full-prefix>}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export HOME="$work/home"
agent_dir="$HOME/.pi/agent"
# Pi's agent dir defaults to $HOME/.pi/agent, which is what the nix sandbox gets.
# Pin it anyway: run this by hand from a Pi session and the inherited
# PI_CODING_AGENT_DIR would point the user-scope scan at the real agent dir.
export PI_CODING_AGENT_DIR="$agent_dir"

project="$work/project"
project_root="$project/.pi/workflows"
mkdir -p "$agent_dir" "$project_root/snapshotprobe"

fail_with() {
  echo "router-gate: $1" >&2
  shift
  for file in "$@"; do [ -f "$file" ] && cat "$file" >&2; done
  exit 1
}

# --- the witness -----------------------------------------------------------
# The router is production code and must not grow a test hook, so the active
# tool list is read from outside instead: a throwaway extension appended through
# trailing argv (`loom` ends in `exec pi --no-extensions <stack> "$@"`) that
# reports pi.getActiveTools() when asked.
#
# It reports from a *command handler*, not from session_start. Handler order
# between two extensions' session_start listeners is not something this check
# should depend on; a slash command is dispatched long after startup has
# settled, so what it sees is the gate's final answer.
cat >"$work/witness.ts" <<'TS'
import { writeFileSync } from "node:fs";

interface WitnessApi {
	registerCommand: (
		name: string,
		options: { description: string; handler: (args: string, ctx: any) => Promise<void> },
	) => void;
	getActiveTools: () => string[];
}

export default function toolWitness(pi: WitnessApi) {
	pi.registerCommand("toolwitness", {
		description: "Report the active tool set for the pi-loom-router gate check.",
		handler: async (_args, ctx) => {
			const tools = pi.getActiveTools();
			const target = process.env.LOOM_WITNESS_FILE;
			if (target) writeFileSync(target, JSON.stringify(tools));
			ctx.ui.notify("tool witness: " + tools.length + " active", "info");
		},
	});
}
TS

# --- a run that only needs to exist, so its snapshot can be read ------------
# No agent call at all: it completes offline, and completing is what writes the
# launch snapshot whose `tools` field is the boundary under test.
cat >"$project_root/snapshotprobe/command.json" <<'JSON'
{
  "name": "snapshotprobe",
  "description": "pi-loom router-gate launch snapshot probe.",
  "script": "probe.js"
}
JSON
cat >"$project_root/snapshotprobe/probe.js" <<'JS'
return { gated: "recorded" };
JS

cd "$project"

# A prompt is refused before command dispatch unless a model resolves with a key,
# so pass a throwaway one. --offline keeps startup off the network; the key is
# never used because nothing here reaches a provider.
common_args=(
  --mode rpc
  --offline
  --no-session
  --no-skills
  --no-context-files
  --provider anthropic
  --model claude-sonnet-4-5
  --api-key router-gate-check-not-a-real-key
)

# Sends one slash command and waits for the binary to answer it. `settle` is what
# the wait watches for: a notify for the witness, a workflow-custom message for a
# run.
run_command() {
  local label="$1"
  local bin="$2"
  local message="$3"
  local settle="$4"
  local out="$work/$label.jsonl"
  : >"$out"
  {
    printf '{"id":"%s","type":"prompt","message":%s}\n' "$label" "$message"
    for _ in $(seq 1 180); do
      if grep -q "$settle" "$out"; then break; fi
      sleep 1
    done
    sleep 2
  } | timeout 300 "$bin" -e "$work/witness.ts" "${common_args[@]}" >"$out"
}

witness_tools() {
  local label="$1"
  local bin="$2"
  export LOOM_WITNESS_FILE="$work/$label.tools.json"
  rm -f "$LOOM_WITNESS_FILE"
  run_command "$label" "$bin" '"/toolwitness"' '"method":"notify"'
  [ -f "$LOOM_WITNESS_FILE" ] ||
    fail_with "the witness command never ran under $label, so nothing was observed" "$work/$label.jsonl"
}

# ------------------------------- 1. loom traded mutation for read-only discovery
witness_tools loom "$loom"
loom_tools="$work/loom.tools.json"

for tool in edit write; do
  jq -e --arg tool "$tool" 'index($tool) == null' "$loom_tools" >/dev/null ||
    fail_with "the chat agent still holds '$tool' in loom, so the router gate did not fire" "$loom_tools"
done

# `bash` is in this list on purpose: P5b-ii re-admitted it, and a regression that
# hides it again would silently take `git status` away from the router.
for tool in read bash grep find ls; do
  jq -e --arg tool "$tool" 'index($tool) != null' "$loom_tools" >/dev/null ||
    fail_with "the gated chat agent has no '$tool', so it cannot read the repo it is supposed to route over" "$loom_tools"
done

# ------------------------------------------------- 2. plain pi is not affected
witness_tools pi "$pi_bin"
pi_tools="$work/pi.tools.json"

for tool in edit write bash; do
  jq -e --arg tool "$tool" 'index($tool) != null' "$pi_tools" >/dev/null ||
    fail_with "plain pi lost '$tool'; the gate escaped the loom stack" "$pi_tools"
done

# --------------------------------------- 3. the router is not in the pi bundle
# Structural, not behavioural: this is what breaks the moment someone adds the
# router to extensions/registry.nix, where an extension flag could enable it in
# anyone's pi.
bundled=0
for manifest in "$pi_full"/share/pi/extensions/*/package.json; do
  [ -f "$manifest" ] || continue
  bundled=$((bundled + 1))
  name="$(jq -r '.name // ""' "$manifest")"
  [ "$name" = "pi-loom-router" ] &&
    fail_with "pi-full bundles pi-loom-router ($manifest); the gate must ship only in the loom stack"
done
[ "$bundled" -gt 0 ] ||
  fail_with "found no bundled extension manifests under $pi_full/share/pi/extensions, so this assertion proved nothing"

# ------------------------- 4. the launch boundary survived the real router gate
run_command snapshot "$loom" '"/snapshotprobe"' '"customType":"workflow"'

runs_root="$HOME/.pi/workflows"
state="$(find "$runs_root" -name state.json 2>/dev/null | head -1)"
[ -n "$state" ] || fail_with "/snapshotprobe started no run" "$work/snapshot.jsonl"

snapshot="$(dirname "$state")/snapshot.json"
[ -f "$snapshot" ] || fail_with "the run recorded no launch snapshot"

for tool in edit write bash; do
  jq -e --arg tool "$tool" '.tools | index($tool) != null' "$snapshot" >/dev/null ||
    fail_with "the launch snapshot lost '$tool' under the real router; the workflow boundary collapsed into the chat agent's visibility" "$snapshot"
done

echo "router-gate: in loom the chat agent holds no edit or write and does hold read, bash, grep, find and ls; plain pi holds all three mutating tools; pi-full bundles no copy of the router; and a workflow launched inside the gated session still records all three in its launch snapshot"
