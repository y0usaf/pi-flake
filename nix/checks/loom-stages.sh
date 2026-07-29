#!/usr/bin/env bash
# Runtime acceptance for phase P4a of extensions/pi-loom/DESIGN.md: the stage
# library. Stages are shared, reviewed workflow steps; a workflow script reaches
# them by calling `stage(name, input)` and imports nothing, because the vm
# sandbox a script runs in has no module loader. Boots the real `loom` wrapper
# headlessly and proves what a build-only check cannot see:
#
#   1. The library reaches the sandbox. `typeof stage` inside a workflow body is
#      "function" even though the script imported nothing and the definitions
#      are appended after the author's own `return`.
#   2. An unknown stage name fails with the list of stages that do exist.
#   3. A stage rejects missing or out-of-range input before launching an agent,
#      so a typo costs nothing instead of a model call.
#   4. A script that declares its own top-level `stage` is rejected at launch:
#      no run starts, and the slash command explains why where it was typed.
#
# Usage: loom-stages.sh <path-to-loom-binary>
# Runs offline with a throwaway HOME; no network, no real API key. Assertions 1
# to 3 never call agent(), which is the point: a stage's input contract is
# enforced in the sandbox, before any model is contacted.
set -euo pipefail

loom="${1:?usage: loom-stages.sh <path-to-loom-binary>}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export HOME="$work/home"
agent_dir="$HOME/.pi/agent"
# Pi's agent dir defaults to $HOME/.pi/agent, which is what the nix sandbox
# gets. Pin it anyway: run this script by hand from a Pi session and the
# inherited PI_CODING_AGENT_DIR would point the user-scope scan at the real
# agent dir.
export PI_CODING_AGENT_DIR="$agent_dir"
project="$work/project"
project_root="$project/.pi/workflows"
mkdir -p "$agent_dir" "$project_root/stageprobe" "$project_root/conflictprobe"
cd "$project"

# --- the library, exercised from inside the sandbox ------------------------
cat >"$project_root/stageprobe/command.json" <<'JSON'
{
  "name": "stageprobe",
  "description": "pi-loom stage library probe.",
  "script": "probe.js"
}
JSON
cat >"$project_root/stageprobe/probe.js" <<'JS'
const seen = typeof stage;
let unknown = "";
try { await stage("nope", {}); } catch (error) { unknown = error.message; }
let missing = "";
try { await stage("plan", {}); } catch (error) { missing = error.message; }
let bounded = "";
try { await stage("plan", { task: "t", maxItems: 99 }); } catch (error) { bounded = error.message; }
let quick = "";
try { await stage("quick", {}); } catch (error) { quick = error.message; }
return { seen: seen, unknown: unknown, missing: missing, bounded: bounded, quick: quick };
JS

# --- a script that collides with the library ------------------------------
# The library is appended as top-level function declarations, so a top-level
# `const stage` would make the concatenated source a SyntaxError inside a child
# process. Launch has to refuse it instead, by name.
cat >"$project_root/conflictprobe/command.json" <<'JSON'
{
  "name": "conflictprobe",
  "description": "pi-loom stage name collision probe.",
  "script": "probe.js"
}
JSON
cat >"$project_root/conflictprobe/probe.js" <<'JS'
const stage = "mine";
return stage;
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

fail_with() {
  echo "stages: $1" >&2
  shift
  for file in "$@"; do cat "$file" >&2; done
  exit 1
}

# ------------------------------------------------------------ library probe
probe_out="$work/probe.jsonl"
: >"$probe_out"
{
  printf '{"id":"probe","type":"prompt","message":"/stageprobe"}\n'
  for _ in $(seq 1 180); do
    if grep -q '"customType":"workflow"' "$probe_out"; then break; fi
    sleep 1
  done
} | timeout 300 "$loom" "${loom_args[@]}" >"$probe_out"

# `jq -c` keeps a multi-line message escaped on one line: reading it with
# `head -1` after `jq -r` would silently cut it to its first line.
jq -r 'select(.type == "message_start" and .message.customType == "workflow") | .message.content' \
  "$probe_out" >"$work/probe.txt"
[ -s "$work/probe.txt" ] || fail_with "/stageprobe never completed" "$probe_out"

sed -n 's/^Workflow stageprobe completed: //p' "$work/probe.txt" >"$work/probe.json"
[ -s "$work/probe.json" ] || fail_with "/stageprobe did not complete successfully" "$work/probe.txt"

field() { jq -r ".$1 // \"\"" "$work/probe.json"; }

[ "$(field seen)" = "function" ] ||
  fail_with "stage() is not defined in the sandbox (typeof stage = '$(field seen)')" "$work/probe.json"

case "$(field unknown)" in
  *"Unknown stage: nope"*"available stages: plan, exec, review, quick"*) ;;
  *) fail_with "an unknown stage name did not list the available stages (got: '$(field unknown)')" ;;
esac

case "$(field missing)" in
  *"stage plan: task is required"*) ;;
  *) fail_with "a stage did not reject missing required input (got: '$(field missing)')" ;;
esac

case "$(field bounded)" in
  *"stage plan: maxItems must be an integer between 1 and 20"*) ;;
  *) fail_with "a stage did not reject out-of-range input (got: '$(field bounded)')" ;;
esac

case "$(field quick)" in
  *"stage quick: task is required"*) ;;
  *) fail_with "the quick stage did not reject a missing task (got: '$(field quick)')" ;;
esac

# ----------------------------------------------------------- name collision
# Rejection is an `extension_ui_request` notification, fire-and-forget, so
# nothing has to be answered; stdin stays open only until it lands.
conflict_out="$work/conflict.jsonl"
: >"$conflict_out"
{
  printf '{"id":"conflict","type":"prompt","message":"/conflictprobe"}\n'
  for _ in $(seq 1 180); do
    if grep -q '"method":"notify"' "$conflict_out"; then break; fi
    sleep 1
  done
} | timeout 300 "$loom" "${loom_args[@]}" >"$conflict_out"

jq -c 'select(.type == "extension_ui_request" and .method == "notify") | {type: .notifyType, message: .message}' \
  "$conflict_out" >"$work/notifications.jsonl"
[ -s "$work/notifications.jsonl" ] || fail_with "a colliding declaration produced no notification" "$conflict_out"

grep -q '"customType":"workflow"' "$conflict_out" &&
  fail_with "a run started despite a declaration colliding with the stage library" "$conflict_out"

notification="$(head -1 "$work/notifications.jsonl")"
[ "$(printf '%s' "$notification" | jq -r '.type')" = "error" ] ||
  fail_with "the collision was notified as '$(printf '%s' "$notification" | jq -r '.type')', not an error" "$work/notifications.jsonl"
case "$(printf '%s' "$notification" | jq -r '.message')" in
  *"stage is provided by the loom stage library"*) ;;
  *) fail_with "the collision message did not name the stage library (got: '$(printf '%s' "$notification" | jq -r '.message')')" ;;
esac

echo "stages: the appended library reached the sandbox, an unknown stage named the available ones, missing and out-of-range input were rejected before any agent launch, and a colliding top-level declaration stopped the launch with a named error"
