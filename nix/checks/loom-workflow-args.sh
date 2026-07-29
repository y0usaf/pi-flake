#!/usr/bin/env bash
# Runtime acceptance for phase P3a of extensions/pi-loom/DESIGN.md: the
# declaration mechanism for workflow slash commands. A `command.json` declares
# its arguments as a JSON Schema (`argsSchema`); usage text is generated from
# that schema and never hand-written. Boots the real `loom` wrapper headlessly
# and proves what a build-only check cannot see:
#
#   1. The generated signature reaches the command palette: the registered
#      description carries `Usage: /argsprobe <topic> [rounds] [mode]`, built
#      from the schema's required/optional split.
#   2. Bad arguments are rejected with the generated usage text and no run is
#      started. Three ways to be wrong are covered, because they come from
#      three different parts of the schema: a missing required property, a
#      violated numeric bound, and an undeclared property.
#   3. Good arguments launch with the schema applied: bare command text lands
#      under `argKey`, declared defaults are filled in, and a text scalar is
#      coerced to the declared integer type (RPC sends "7", the child sees 7).
#
# Usage: loom-workflow-args.sh <path-to-loom-binary>
# Runs offline with a throwaway HOME; no network, no real API key. The probe
# never calls agent(), so no model is ever contacted.
set -euo pipefail

loom="${1:?usage: loom-workflow-args.sh <path-to-loom-binary>}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export HOME="$work/home"
agent_dir="$HOME/.pi/agent"
# Pi's agent dir defaults to $HOME/.pi/agent, which is what the nix sandbox
# gets. Pin it anyway: run this script by hand from a Pi session and the
# inherited PI_CODING_AGENT_DIR would point the scan at the real agent dir,
# where the probe workflow does not exist.
export PI_CODING_AGENT_DIR="$agent_dir"
project="$work/project"
mkdir -p "$agent_dir/workflows/argsprobe" "$project"
cd "$project"

cat >"$agent_dir/workflows/argsprobe/command.json" <<'JSON'
{
  "name": "argsprobe",
  "description": "pi-loom declaration-mechanism probe.",
  "script": "probe.js",
  "argKey": "topic",
  "argsSchema": {
    "type": "object",
    "properties": {
      "topic": {"type": "string", "minLength": 1, "description": "What to work on"},
      "rounds": {"type": "integer", "minimum": 1, "maximum": 10, "default": 3, "description": "Debate rounds"},
      "mode": {"type": "string", "enum": ["fast", "deep"], "default": "fast"}
    },
    "required": ["topic"],
    "additionalProperties": false
  }
}
JSON

# Runs inside the forked child's vm sandbox. Returns a field-order-independent
# signature of what the host actually handed over, including the runtime type
# of `rounds` -- a string "7" that survived as a string would fail here.
cat >"$agent_dir/workflows/argsprobe/probe.js" <<'JS'
log("args " + JSON.stringify(args));
return [args.topic, args.rounds, args.mode, typeof args.rounds].join("|");
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

usage_head='Usage: /argsprobe <topic> [rounds] [mode]'

fail_with() {
  echo "workflow-args: $1" >&2
  shift
  for file in "$@"; do cat "$file" >&2; done
  exit 1
}

# ---------------------------------------------------------------- rejections
# One boot, one get_commands probe and three bad invocations. Notifications are
# fire-and-forget `extension_ui_request` lines, so nothing has to be answered;
# stdin stays open only until the third notification lands.
reject_out="$work/reject.jsonl"
: >"$reject_out"
{
  printf '{"id":"cmds","type":"get_commands"}\n'
  printf '{"id":"missing","type":"prompt","message":"/argsprobe"}\n'
  printf '{"id":"bound","type":"prompt","message":"/argsprobe {\\"topic\\":\\"x\\",\\"rounds\\":99}"}\n'
  printf '{"id":"extra","type":"prompt","message":"/argsprobe {\\"topic\\":\\"x\\",\\"nope\\":1}"}\n'
  for _ in $(seq 1 180); do
    if [ "$(grep -c '"method":"notify"' "$reject_out" 2>/dev/null || true)" -ge 3 ]; then break; fi
    sleep 1
  done
} | timeout 300 "$loom" "${loom_args[@]}" >"$reject_out"

jq -c 'select(.type == "response" and .command == "get_commands") | .data.commands' \
  "$reject_out" >"$work/commands.json"
[ -s "$work/commands.json" ] || fail_with "loom never answered get_commands" "$reject_out"

described="$(jq -r 'first(.[] | select(.name == "argsprobe") | .description) // ""' "$work/commands.json")"
case "$described" in
  *"$usage_head"*) ;;
  *) fail_with "registered description carries no generated signature (got: '$described')" ;;
esac

# `jq -c` keeps each multi-line usage message escaped on one line: reading it
# with `head -1` after `jq -r` would silently cut the message to its first line.
jq -c 'select(.type == "extension_ui_request" and .method == "notify") | {type: .notifyType, message: .message}' \
  "$reject_out" >"$work/notifications.jsonl"
count="$(wc -l <"$work/notifications.jsonl")"
[ "$count" -eq 3 ] || fail_with "expected 3 rejection notifications, saw $count" "$work/notifications.jsonl"

grep -q '"customType":"workflow"' "$reject_out" &&
  fail_with "a workflow run started despite invalid arguments" "$reject_out"

expected_fragment=(
  "arguments must have required properties topic"
  "rounds must be <= 10"
  "arguments must not have additional properties"
)
for index in 0 1 2; do
  line="$(sed -n "$((index + 1))p" "$work/notifications.jsonl")"
  kind="$(printf '%s' "$line" | jq -r '.type')"
  message="$(printf '%s' "$line" | jq -r '.message')"
  [ "$kind" = "warning" ] || fail_with "rejection $index was notified as '$kind', not a warning"
  case "$message" in
    *"${expected_fragment[$index]}"*) ;;
    *) fail_with "rejection $index did not explain the schema violation (got: '$message')" ;;
  esac
  case "$message" in
    *"$usage_head"*) ;;
    *) fail_with "rejection $index carried no generated usage signature (got: '$message')" ;;
  esac
  case "$message" in
    *"rounds  integer, range 1..10, optional, default 3 - Debate rounds"*) ;;
    *) fail_with "rejection $index usage did not describe rounds from the schema (got: '$message')" ;;
  esac
done

# ------------------------------------------------------------------ launches
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

bare="$(run_probe bare '/argsprobe deep dish')"
[ "$bare" = 'Workflow argsprobe completed: "deep dish|3|fast|number"' ] ||
  fail_with "bare text did not land under argKey with schema defaults (got: '$bare')" "$work/bare.jsonl"

coerced="$(run_probe coerced '/argsprobe {\"topic\":\"x\",\"rounds\":\"7\"}')"
[ "$coerced" = 'Workflow argsprobe completed: "x|7|fast|number"' ] ||
  fail_with "a text scalar was not coerced to the declared integer type (got: '$coerced')" "$work/coerced.jsonl"

echo "workflow-args: generated usage reached the palette, three bad-arg shapes were rejected without starting a run, defaults and coercion reached the child"
