#!/usr/bin/env bash
# Runtime acceptance for packages.pi-loom-cli (phase P1 of
# extensions/pi-loom/DESIGN.md): boot the real `loom` wrapper headlessly and
# prove three things that a build-only check cannot.
#
#   1. `/workflow` is registered, so the engine loaded.
#   2. Every CLI-loaded extension comes from the wrapper's own -e list and
#      nothing is user- or project-scoped, so `loom` runs the loom stack only.
#   3. A workflow child process really spawns: a probe workflow dropped into
#      the agent dir logs from inside the child sandbox and returns a value.
#      The child is forked with execPath=PI_WORKFLOW_NODE_PATH; with the
#      variable unset the same run dies with "Workflow child exited with
#      code 1", so a completed run is proof the wrapper exported it.
#
# Usage: loom-cli-smoke.sh <path-to-loom-binary>
# Runs offline with a throwaway HOME; no network, no real API key.
set -euo pipefail

loom="${1:?usage: loom-cli-smoke.sh <path-to-loom-binary>}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export HOME="$work/home"
agent_dir="$HOME/.pi/agent"
project="$work/project"
mkdir -p "$agent_dir/workflows/loomprobe" "$project"
cd "$project"

cat >"$agent_dir/workflows/loomprobe/command.json" <<'JSON'
{
  "name": "loomprobe",
  "description": "pi-loom-cli smoke probe: proves a workflow child process spawns",
  "script": "probe.js",
  "args": {}
}
JSON

# Runs inside the forked child's vm sandbox. log() is relayed to the host over
# IPC, the return value comes back as the run result. No agent() call, so this
# needs no model and no network.
cat >"$agent_dir/workflows/loomprobe/probe.js" <<'JS'
log("loom-probe child running");
return "loom-probe-ok";
JS

# A prompt is refused before command dispatch unless a model resolves with a
# key, so pass a throwaway one. --offline keeps startup off the network; the
# key is never used because extension commands run locally.
loom_args=(
  --mode rpc
  --offline
  --no-session
  --no-skills
  --no-context-files
  --provider anthropic
  --model claude-sonnet-4-5
  --api-key smoke-check-not-a-real-key
)

commands_out="$work/commands.jsonl"
printf '{"id":"cmds","type":"get_commands"}\n' |
  timeout 300 "$loom" "${loom_args[@]}" >"$commands_out"

jq -c 'select(.type == "response" and .command == "get_commands") | .data.commands' \
  "$commands_out" >"$work/commands.json"
[ -s "$work/commands.json" ] || {
  echo "smoke: loom never answered get_commands" >&2
  exit 1
}

jq -e 'any(.[]; .name == "workflow")' "$work/commands.json" >/dev/null || {
  echo "smoke: /workflow is not registered in loom" >&2
  jq -r '.[].name' "$work/commands.json" >&2
  exit 1
}

jq -e 'any(.[]; .name == "loomprobe")' "$work/commands.json" >/dev/null || {
  echo "smoke: probe workflow in <agentDir>/workflows did not register" >&2
  exit 1
}

# The wrapper's own -e flags are the definition of "the loom stack": read them
# back out of the generated script instead of duplicating the list here.
grep -o -- '-e /nix/store/[^ ]*' "$loom" | cut -d' ' -f2 | sort -u >"$work/expected-exts.txt"
[ -s "$work/expected-exts.txt" ] || {
  echo "smoke: no -e extension flags found in $loom" >&2
  exit 1
}

jq -r '.[] | select(.sourceInfo.source == "cli") | .sourceInfo.path' "$work/commands.json" |
  sed 's#\(/nix/store/[^/]*\).*#\1#' | sort -u >"$work/actual-exts.txt"

foreign="$(comm -23 "$work/actual-exts.txt" "$work/expected-exts.txt")"
[ -z "$foreign" ] || {
  echo "smoke: loom loaded extensions outside its own stack:" >&2
  echo "$foreign" >&2
  exit 1
}

jq -e 'all(.[]; .sourceInfo.scope != "user" and .sourceInfo.scope != "project")' \
  "$work/commands.json" >/dev/null || {
  echo "smoke: a user- or project-scoped command leaked into loom" >&2
  exit 1
}

# Fire the probe workflow, then hold stdin open only until the run reports
# back. Closing stdin makes pi exit, so the good path costs a few seconds and
# the bad path is capped.
probe_out="$work/probe.jsonl"
: >"$probe_out"
{
  printf '{"id":"probe","type":"prompt","message":"/loomprobe"}\n'
  for _ in $(seq 1 180); do
    if grep -q '"customType":"workflow"' "$probe_out"; then break; fi
    sleep 1
  done
} | timeout 300 "$loom" "${loom_args[@]}" >"$probe_out"

child_log="$(jq -r 'select(.type == "entry_appended" and .entry.customType == "workflow-log") | .entry.data.message' "$probe_out")"
[ "$child_log" = "loom-probe child running" ] || {
  echo "smoke: no log line from inside the workflow child (got: '$child_log')" >&2
  exit 1
}

result="$(jq -r 'select(.type == "message_start" and .message.customType == "workflow") | .message.content' "$probe_out" | head -1)"
[ "$result" = 'Workflow loomprobe completed: "loom-probe-ok"' ] || {
  echo "smoke: workflow run did not complete (got: '$result')" >&2
  exit 1
}

echo "smoke: /workflow present, stack clean, workflow child spawned and returned"
