#!/usr/bin/env bash
# Runtime acceptance for phase P2a of extensions/pi-loom/DESIGN.md: the
# human.ask DSL primitive. Boots the real `loom` wrapper headlessly and proves
# the whole round trip, which no build-only check can see:
#
#   1. A workflow calling human.ask() renders a choice UI in the main session.
#      In RPC mode ctx.ui.select is an `extension_ui_request` with
#      method "select" on stdout, so the request line IS the rendered UI.
#   2. The choices offered are the workflow's own, not checkpoint's fixed
#      Approve/Reject pair.
#   3. Answering resumes the suspended run with the selected value: the child
#      logs the answer from inside its vm sandbox and returns it as the run
#      result.
#
# Usage: loom-human-ask.sh <path-to-loom-binary>
# Runs offline with a throwaway HOME; no network, no real API key. The probe
# never calls agent(), so no model is ever contacted.
set -euo pipefail

loom="${1:?usage: loom-human-ask.sh <path-to-loom-binary>}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export HOME="$work/home"
agent_dir="$HOME/.pi/agent"
project="$work/project"
mkdir -p "$agent_dir/workflows/loomask" "$project"
cd "$project"

cat >"$agent_dir/workflows/loomask/command.json" <<'JSON'
{
  "name": "loomask",
  "description": "pi-loom human.ask smoke probe: proves a run suspends on a human choice and resumes",
  "script": "ask.js",
  "args": {}
}
JSON

# Runs inside the forked child's vm sandbox. human.ask suspends the run until
# the host resolves it; the returned value is the human's own choice string.
cat >"$agent_dir/workflows/loomask/ask.js" <<'JS'
const answer = await human.ask({
  name: "direction",
  prompt: "Which way should the smoke probe go?",
  choices: ["ship it", "hold it"],
  context: { probe: true },
});
log("human chose " + answer);
return answer;
JS

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

out="$work/ask.jsonl"
: >"$out"

# stdin must stay open across two writes (launch, then answer), so drive it
# through a FIFO held by fd 3 instead of a pipeline. Closing fd 3 is what makes
# pi exit at the end.
mkfifo "$work/stdin"
timeout 300 "$loom" "${loom_args[@]}" <"$work/stdin" >"$out" &
loom_pid=$!
exec 3>"$work/stdin"

printf '{"id":"ask","type":"prompt","message":"/loomask"}\n' >&3

# Wait for the choice UI. jq is fed a file that is still being appended to, so
# a partial trailing line is normal and its parse error is not a failure.
request=""
for _ in $(seq 1 120); do
  request="$(jq -c 'select(.type == "extension_ui_request" and .method == "select")' "$out" 2>/dev/null | head -1)"
  [ -n "$request" ] && break
  sleep 1
done

[ -n "$request" ] || {
  echo "human-ask: no choice UI was rendered for human.ask" >&2
  cat "$out" >&2
  exec 3>&- || true
  exit 1
}

title="$(printf '%s' "$request" | jq -r '.title')"
[ "$title" = "Which way should the smoke probe go?" ] || {
  echo "human-ask: choice UI title is not the workflow's prompt (got: '$title')" >&2
  exec 3>&- || true
  exit 1
}

printf '%s' "$request" | jq -e '.options == ["ship it", "hold it"]' >/dev/null || {
  echo "human-ask: choice UI did not offer the workflow's own choices" >&2
  printf '%s\n' "$request" >&2
  exec 3>&- || true
  exit 1
}

request_id="$(printf '%s' "$request" | jq -r '.id')"
printf '{"type":"extension_ui_response","id":"%s","value":"ship it"}\n' "$request_id" >&3

# Hold stdin open only until the run reports back, then close it so pi exits.
for _ in $(seq 1 120); do
  if grep -q '"customType":"workflow"' "$out"; then break; fi
  sleep 1
done
exec 3>&-
wait "$loom_pid" || true

child_log="$(jq -r 'select(.type == "entry_appended" and .entry.customType == "workflow-log") | .entry.data.message' "$out")"
[ "$child_log" = "human chose ship it" ] || {
  echo "human-ask: the answer never reached the workflow child (got: '$child_log')" >&2
  exit 1
}

result="$(jq -r 'select(.type == "message_start" and .message.customType == "workflow") | .message.content' "$out" | head -1)"
[ "$result" = 'Workflow loomask completed: "ship it"' ] || {
  echo "human-ask: run did not resume with the selected value (got: '$result')" >&2
  exit 1
}

echo "human-ask: choice UI rendered with the workflow's own choices, run resumed with the selection"
