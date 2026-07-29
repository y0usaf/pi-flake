#!/usr/bin/env bash
# Runtime acceptance for phase P3b of extensions/pi-loom/DESIGN.md: the
# project-local scan root. A repo keeps its own workflow commands in
# `<cwd>/.pi/workflows/<name>/command.json`, and `/workflows` says where every
# command came from. Boots the real `loom` wrapper headlessly and proves what a
# build-only check cannot see:
#
#   1. A command.json dropped into the project's `.pi/workflows/` is a slash
#      command: it reaches the palette and launches a run. Nothing in the agent
#      dir or the package was edited to make that happen.
#   2. `/workflows` names the scope and root path of every command, so a user
#      can tell a project command from one they installed.
#   3. A project spec cannot shadow a user-scope command of the same name: the
#      user's version runs, and the listing reports the shadowed spec instead of
#      dropping it silently.
#   4. A malformed project spec does not abort extension load: `loom` still
#      starts, other commands still work, and the listing reports it as skipped.
#
# Usage: loom-project-workflows.sh <path-to-loom-binary>
# Runs offline with a throwaway HOME; no network, no real API key. The probes
# never call agent(), so no model is ever contacted.
set -euo pipefail

loom="${1:?usage: loom-project-workflows.sh <path-to-loom-binary>}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export HOME="$work/home"
agent_dir="$HOME/.pi/agent"
# Pi's agent dir defaults to $HOME/.pi/agent, which is what the nix sandbox
# gets. Pin it anyway: run this script by hand from a Pi session and the
# inherited PI_CODING_AGENT_DIR would point the user-scope scan at the real
# agent dir, where these probes do not exist.
export PI_CODING_AGENT_DIR="$agent_dir"
project="$work/project"
project_root="$project/.pi/workflows"
mkdir -p "$agent_dir/workflows/bothprobe" "$project_root/projprobe" "$project_root/bothprobe" "$project_root/brokenprobe"
cd "$project"

# --- project scope: the phase's whole point -------------------------------
cat >"$project_root/projprobe/command.json" <<'JSON'
{
  "name": "projprobe",
  "description": "pi-loom project-scope probe.",
  "script": "probe.js",
  "argKey": "topic",
  "argsSchema": {
    "type": "object",
    "properties": {
      "topic": {"type": "string", "minLength": 1, "description": "What to work on"}
    },
    "required": ["topic"],
    "additionalProperties": false
  }
}
JSON
cat >"$project_root/projprobe/probe.js" <<'JS'
return "project:" + args.topic;
JS

# --- shadowing: same name in user scope and project scope -----------------
# The user's copy must win, because a clone must not be able to redefine a
# command the user installed.
cat >"$agent_dir/workflows/bothprobe/command.json" <<'JSON'
{
  "name": "bothprobe",
  "description": "pi-loom user-scope probe.",
  "script": "probe.js",
  "argKey": "topic"
}
JSON
cat >"$agent_dir/workflows/bothprobe/probe.js" <<'JS'
return "user-scope-wins";
JS
cat >"$project_root/bothprobe/command.json" <<'JSON'
{
  "name": "bothprobe",
  "description": "pi-loom project-scope shadow attempt.",
  "script": "probe.js",
  "argKey": "topic"
}
JSON
cat >"$project_root/bothprobe/probe.js" <<'JS'
return "project-scope-shadowed-user-scope";
JS

# --- hostile input: a project spec that does not parse ---------------------
printf '{ this is not json' >"$project_root/brokenprobe/command.json"
printf 'return "never";\n' >"$project_root/brokenprobe/probe.js"

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

fail_with() {
  echo "project-workflows: $1" >&2
  shift
  for file in "$@"; do cat "$file" >&2; done
  exit 1
}

# ------------------------------------------------- palette + /workflows listing
# One boot: ask for the command list, then run /workflows and wait for the
# display-only listing message it appends to the session.
listing_out="$work/listing.jsonl"
: >"$listing_out"
{
  printf '{"id":"cmds","type":"get_commands"}\n'
  printf '{"id":"list","type":"prompt","message":"/workflows"}\n'
  for _ in $(seq 1 180); do
    if grep -q '"customType":"workflow-list"' "$listing_out"; then break; fi
    sleep 1
  done
} | timeout 300 "$loom" "${loom_args[@]}" >"$listing_out"

jq -c 'select(.type == "response" and .command == "get_commands") | .data.commands' \
  "$listing_out" >"$work/commands.json"
[ -s "$work/commands.json" ] || fail_with "loom never answered get_commands" "$listing_out"

described="$(jq -r 'first(.[] | select(.name == "projprobe") | .description) // ""' "$work/commands.json")"
case "$described" in
  *"Usage: /projprobe <topic>"*) ;;
  *) fail_with "a .pi/workflows command.json did not reach the palette (got: '$described')" "$work/commands.json" ;;
esac

[ "$(jq -r 'first(.[] | select(.name == "workflows") | .name) // ""' "$work/commands.json")" = "workflows" ] ||
  fail_with "/workflows is not registered" "$work/commands.json"

# `jq -c` keeps the multi-line listing escaped on one line: reading it with
# `head -1` after `jq -r` would silently cut it to its first line.
jq -r 'select(.type == "message_start" and .message.customType == "workflow-list") | .message.content' \
  "$listing_out" >"$work/listing.txt"
[ -s "$work/listing.txt" ] || fail_with "/workflows produced no listing" "$listing_out"

expect_listing() {
  grep -qF -- "$1" "$work/listing.txt" || fail_with "listing is missing: $1" "$work/listing.txt"
}
expect_listing "user ($agent_dir/workflows)"
expect_listing "project ($project_root)"
expect_listing "/projprobe"
expect_listing "shadowed: $project_root/bothprobe/command.json declares /bothprobe, already provided by user scope"
expect_listing "skipped: $project_root/brokenprobe/command.json"

# The project scope header must be the one that carries /projprobe, otherwise
# the listing names a scope without meaning it. A scope's entries are its
# indented lines; the first unindented line after them ends the section.
awk '/^project \(/{found=1; next} found && !/^  /{found=0} found' "$work/listing.txt" >"$work/project-section.txt"
grep -q -- "/projprobe" "$work/project-section.txt" ||
  fail_with "/projprobe is not listed under the project scope" "$work/listing.txt"
if grep -q -- "/bothprobe" "$work/project-section.txt"; then
  fail_with "a shadowed project command was listed as active" "$work/listing.txt"
fi

# ------------------------------------------------------------------- launches
# Each accepted invocation gets its own boot: the run has to finish before the
# result line exists, and holding one session open across two runs would only
# make the failure modes harder to read.
run_probe() {
  local label="$1" message="$2" out="$work/$1.jsonl"
  : >"$out"
  {
    printf '{"id":"%s","type":"prompt","message":"%s"}\n' "$label" "$message"
    for _ in $(seq 1 180); do
      if grep -q '"customType":"workflow"' "$out"; then break; fi
      sleep 1
    done
  } | timeout 300 "$loom" "${loom_args[@]}" >"$out"
  jq -r 'select(.type == "message_start" and .message.customType == "workflow") | .message.content' "$out"
}

project_run="$(run_probe project '/projprobe local scan root')"
[ "$project_run" = 'Workflow projprobe completed: "project:local scan root"' ] ||
  fail_with "a project-scope workflow did not run from .pi/workflows (got: '$project_run')" "$work/project.jsonl"

shadow_run="$(run_probe shadow '/bothprobe anything')"
[ "$shadow_run" = 'Workflow bothprobe completed: "user-scope-wins"' ] ||
  fail_with "a project spec shadowed a user-scope command (got: '$shadow_run')" "$work/shadow.jsonl"

echo "project-workflows: a .pi/workflows command.json reached the palette and ran, /workflows named every scope, a project spec could not shadow user scope, and a malformed project spec was skipped without aborting load"
