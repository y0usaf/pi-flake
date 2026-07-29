#!/usr/bin/env bash
# Runtime acceptance for phase P5a of extensions/pi-loom/DESIGN.md: the workflow
# launch boundary is separate from the main agent's live tool visibility.
#
# Why this exists. P5's router hides `edit`, `write` and `bash` from the agent
# you chat with, using pi.setActiveTools at session_start. Before this phase the
# engine read pi.getActiveTools() at launch time and used it as the run's tool
# boundary, so the router would also have starved every workflow sub-agent:
# preflight rejects `agent(..., { tools: ["edit"] })` with
#   UNKNOWN_TOOL -> "The workflow requested the unavailable tool edit."
# which would have made /build and /quick unusable under the very stack they
# ship in. The boundary now comes from pi.getAllTools(), which reports what the
# session was configured with and is unaffected by setActiveTools.
#
# The router itself is P5b and does not exist yet, so this check supplies its
# own stand-in: a small probe extension, loaded through the `loom` wrapper's
# trailing argv, that narrows the active tools exactly the way the router will.
# That is deliberate -- it proves the engine half on its own, the same way
# checks.pi-loom-exec-stage proves the exec stage without /build.
#
# Proves, offline, with no agent ever launched:
#   1. The gate really fired. The probe writes the post-gate active tool list to
#      a marker file, and that list contains none of edit, write or bash. Without
#      this the rest of the check would pass vacuously against an ungated
#      session and prove nothing at all.
#   2. A run launched under the gate records edit, write and bash in its launch
#      snapshot -- that snapshot is the tool set every sub-agent is checked
#      against, and it is written before any model is contacted.
#   3. A workflow whose agent call asks for all three mutating tools is not
#      rejected for a tool. It is rejected for its deliberately unknown model,
#      which is the next thing preflight checks, so the tools passed.
#
# Usage: loom-tool-boundary.sh <path-to-loom-binary>
set -euo pipefail

loom="${1:?usage: loom-tool-boundary.sh <path-to-loom-binary>}"

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
marker="$work/gated-tools.json"
export LOOM_BOUNDARY_MARKER="$marker"
mkdir -p "$agent_dir" "$project_root/snapshotprobe" "$project_root/boundaryprobe"

# --- the router stand-in --------------------------------------------------
# Exactly what pi-loom-router will do in P5b: drop the mutating tools from the
# main agent at session_start, in memory, never persisted. The marker file is
# the only addition, and exists so this check can prove the gate ran.
cat >"$work/gate.ts" <<'TS'
import { writeFileSync } from "node:fs";

const MUTATING = ["edit", "write", "bash"];

interface GateApi {
	on: (event: string, handler: () => void) => void;
	getActiveTools: () => string[];
	setActiveTools: (names: string[]) => void;
}

export default function boundaryGateProbe(pi: GateApi) {
	pi.on("session_start", () => {
		pi.setActiveTools(pi.getActiveTools().filter((name) => !MUTATING.includes(name)));
		const marker = process.env.LOOM_BOUNDARY_MARKER;
		if (marker) writeFileSync(marker, JSON.stringify(pi.getActiveTools()));
	});
}
TS

# --- a run that only needs to exist, so its snapshot can be read ------------
# No agent call at all: it completes offline, and completing is what writes the
# launch snapshot whose `tools` field is the boundary under test.
cat >"$project_root/snapshotprobe/command.json" <<'JSON'
{
  "name": "snapshotprobe",
  "description": "pi-loom launch-boundary snapshot probe.",
  "script": "probe.js"
}
JSON
cat >"$project_root/snapshotprobe/probe.js" <<'JS'
return { boundary: "recorded" };
JS

# --- a workflow whose sub-agent asks for every mutating tool ---------------
# preflight checks the requested tools against the launch boundary and only then
# the requested model, so an unknown model is how this probe stops without a
# network: reaching the model complaint means the tools were accepted.
cat >"$project_root/boundaryprobe/command.json" <<'JSON'
{
  "name": "boundaryprobe",
  "description": "pi-loom launch-boundary preflight probe.",
  "script": "probe.js"
}
JSON
cat >"$project_root/boundaryprobe/probe.js" <<'JS'
return await agent("write one line into src/app.txt", {
  label: "boundary",
  tools: ["read", "edit", "write", "bash"],
  model: "loom-boundary-check-not-a-real-model",
});
JS

cd "$project"

# A prompt is refused before command dispatch unless a model resolves with a key,
# so pass a throwaway one. --offline keeps startup off the network; the key is
# never used because neither probe reaches a provider.
loom_args=(
  -e "$work/gate.ts"
  --mode rpc
  --offline
  --no-session
  --no-skills
  --no-context-files
  --provider anthropic
  --model claude-sonnet-4-5
  --api-key boundary-check-not-a-real-key
)

fail_with() {
  echo "tool-boundary: $1" >&2
  shift
  for file in "$@"; do cat "$file" >&2; done
  exit 1
}

# Sends one slash command and waits for the engine to answer it. `settle` is what
# the wait watches for: a workflow-custom message for a run, a notify for a
# rejection that never becomes a run.
run_command() {
  local name="$1"
  local message="$2"
  local settle="$3"
  local out="$work/$name.jsonl"
  : >"$out"
  {
    printf '{"id":"%s","type":"prompt","message":%s}\n' "$name" "$message"
    for _ in $(seq 1 180); do
      if grep -q "$settle" "$out"; then break; fi
      sleep 1
    done
    sleep 2
  } | timeout 300 "$loom" "${loom_args[@]}" >"$out"

  # `jq -c` keeps a multi-line message escaped on one line: reading it with
  # `head -1` after `jq -r` would silently cut it to its first line.
  jq -c 'select(.type == "extension_ui_request" and .method == "notify") | .message' \
    "$out" >"$work/$name.notify.txt"
}

# --------------------------------------------------- 1. the gate really fired
run_command snapshot '"/snapshotprobe"' '"customType":"workflow"'

[ -f "$marker" ] ||
  fail_with "the gate probe never ran, so nothing was narrowed and the rest of this check would prove nothing" "$work/snapshot.jsonl"

for tool in edit write bash; do
  jq -e --arg tool "$tool" 'index($tool) == null' "$marker" >/dev/null ||
    fail_with "the gate probe left '$tool' active on the main agent, so the boundary was never actually under test" "$marker"
done

jq -e 'index("read") != null' "$marker" >/dev/null ||
  fail_with "the gate probe removed more than the mutating tools; 'read' should have survived" "$marker"

# ------------------------------------ 2. the launch snapshot kept the boundary
runs_root="$HOME/.pi/workflows"
state="$(find "$runs_root" -name state.json 2>/dev/null | head -1)"
[ -n "$state" ] || fail_with "/snapshotprobe started no run" "$work/snapshot.jsonl"

snapshot="$(dirname "$state")/snapshot.json"
[ -f "$snapshot" ] || fail_with "the run recorded no launch snapshot"

for tool in edit write bash; do
  jq -e --arg tool "$tool" '.tools | index($tool) != null' "$snapshot" >/dev/null ||
    fail_with "the launch snapshot lost '$tool' because the main agent no longer has it; the boundary collapsed into live visibility" "$snapshot"
done

# ------------------------------- 3. preflight did not refuse the mutating tools
run_command boundary '"/boundaryprobe"' '"method":"notify"'
rejection="$(cat "$work/boundary.notify.txt")"

case "$rejection" in
  *"unavailable tool"*)
    fail_with "preflight refused a sub-agent's mutating tool against the gated session (got: '$rejection')" ;;
esac

case "$rejection" in
  # The engine's UNKNOWN_MODEL phrasing keeps the raw "Unknown model <name>"
  # detail inline, so match the two halves rather than one exact sentence.
  *"unavailable model"*"loom-boundary-check-not-a-real-model"*) ;;
  *) fail_with "the probe did not reach the model check, so it proves nothing about the tool check before it (got: '$rejection')" ;;
esac

echo "tool-boundary: with edit, write and bash hidden from the main agent at session_start, a run launched in that session still records all three in its launch snapshot, and a sub-agent asking for all three passes preflight's tool check and is stopped only by its deliberately unknown model"
