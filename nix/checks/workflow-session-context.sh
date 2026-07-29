#!/usr/bin/env bash
# Runtime acceptance for the `sessionContext` field of a workflow command.json
# (local addition to @extensions/vekexasia_pi-extensible-workflows/).
#
# A workflow child runs in its own node process and can only see its `args`, so
# a slash command had to be handed a topic even when the session it was typed
# into already held the discussion. `sessionContext` closes that gap: the
# command handler renders the active session branch into the declared argument
# before the run is launched. This check boots the real pi wrapper headlessly
# and proves the three behaviours a build cannot see:
#
#   1. A bare command in a session with history reaches the child carrying the
#      user and assistant turns, and tool results are left out (they are where
#      a session's bulk lives and would blow the argument budget).
#   2. A bare command in a session with no history is refused where the user
#      typed it, with no run started.
#   3. An explicit argument still gets the transcript, so a topic-carrying run
#      builds on the session instead of starting clean.
#
# Usage: workflow-session-context.sh <path-to-pi-binary>
# Runs offline with a throwaway HOME; the probe workflow never calls agent(),
# so no model is ever contacted and the API key is never used.
set -euo pipefail

pi="${1:?usage: workflow-session-context.sh <path-to-pi>}"
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
sessions="$work/sessions"
mkdir -p "$agent_dir/workflows/sessionprobe" "$project" "$sessions"
cd "$project"

cat >"$agent_dir/workflows/sessionprobe/command.json" <<'JSON'
{
  "name": "sessionprobe",
  "description": "sessionContext declaration probe.",
  "script": "probe.js",
  "argKey": "topic",
  "sessionContext": { "key": "sessionContext", "maxChars": 400 }
}
JSON

# Runs inside the workflow child. Reports what the host actually handed over.
cat >"$agent_dir/workflows/sessionprobe/probe.js" <<'JS'
const seen = typeof args.sessionContext === "string" ? args.sessionContext.replace(/\s+/g, " ") : "MISSING";
return "TOPIC[" + String(args.topic) + "] SESSION[" + seen + "]";
JS

# A hand-written session: two conversation turns plus one tool result, which
# must not survive into the rendered transcript.
session="$sessions/probe.jsonl"
cat >"$session" <<'JSONL'
{"type":"session","version":3,"id":"11111111-2222-3333-4444-555555555555","timestamp":"2026-08-12T10:00:00.000Z","cwd":"/tmp"}
{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"2026-08-12T10:00:01.000Z","message":{"role":"user","content":"we need to pick a lock strategy for the sync engine"}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2026-08-12T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"CRDTs avoid locks entirely but cost storage"}],"provider":"anthropic","model":"claude-sonnet-4-5","stopReason":"stop","usage":{"input":10,"output":10,"cacheRead":0,"cacheWrite":0,"cost":{"totalCost":0}}}}
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2026-08-12T10:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_1","toolName":"bash","content":[{"type":"text","text":"TOOL_NOISE_SHOULD_NOT_APPEAR"}],"isError":false}}
JSONL

# A prompt is refused before command dispatch unless a model resolves with a
# key, so pass a throwaway one. --offline keeps startup off the network; the
# key is never used because extension commands run locally.
pi_args=(
  --mode rpc
  --offline
  --no-skills
  --no-context-files
  --provider anthropic
  --model claude-sonnet-4-5
  --api-key smoke-check-not-a-real-key
  --session-dir "$sessions"
)

fail_with() {
  echo "session-context: $1" >&2
  shift
  for file in "$@"; do cat "$file" >&2; done
  exit 1
}

# One boot per invocation: a backgrounded run has to finish before its result
# line exists, and sharing one session across cases would only make failures
# harder to read. Running this by hand from inside a Pi session would otherwise
# inherit that session's extension set and session file, so both are dropped.
run_probe() {
  local label="$1" message="$2" wait_for="$3"
  shift 3
  local out="$work/$label.jsonl"
  : >"$out"
  {
    printf '{"id":"%s","type":"prompt","message":"%s"}\n' "$label" "$message"
    for _ in $(seq 1 120); do
      if grep -q "$wait_for" "$out"; then break; fi
      sleep 1
    done
  } | env -u PI_DEFAULT_PACKAGES -u PI_SESSION_FILE -u PI_SESSION_ID -u PI_CODING_AGENT \
        -u PI_PACKAGE_DIR -u PI_PROVIDER -u PI_MODEL -u PI_REASONING_LEVEL \
        timeout 180 "$pi" "${pi_args[@]}" "$@" >"$out" 2>"$work/$label.err" || true
  printf '%s' "$out"
}

workflow_result() {
  jq -r 'select(.type == "message_start" and .message.customType == "workflow") | .message.content' "$1" | head -1
}

# --------------------------------------------- 1. bare command, live session
seeded="$(run_probe seeded '/sessionprobe' '"customType":"workflow"' --session "$session")"
result="$(workflow_result "$seeded")"
case "$result" in
  *"user: we need to pick a lock strategy for the sync engine"*) ;;
  *) fail_with "the user turn never reached the child (got: '$result')" "$seeded" ;;
esac
case "$result" in
  *"assistant: CRDTs avoid locks entirely but cost storage"*) ;;
  *) fail_with "the assistant turn never reached the child (got: '$result')" "$seeded" ;;
esac
case "$result" in
  *TOOL_NOISE_SHOULD_NOT_APPEAR*) fail_with "a tool result leaked into the transcript (got: '$result')" ;;
esac

# ------------------------------------------- 2. bare command, empty session
empty="$(run_probe empty '/sessionprobe' '"method":"notify"' --no-session)"
message="$(jq -r 'select(.type == "extension_ui_request" and .method == "notify") | .message' "$empty" | head -1)"
case "$message" in
  *"has no conversation yet"*) ;;
  *) fail_with "an empty session was not refused where the command was typed (got: '$message')" "$empty" ;;
esac
grep -q '"customType":"workflow"' "$empty" &&
  fail_with "a run started from a session with nothing in it" "$empty"

# ------------------------------------ 3. explicit argument keeps the session
topic="$(run_probe topic '/sessionprobe locking' '"customType":"workflow"' --session "$session")"
result="$(workflow_result "$topic")"
case "$result" in
  *"TOPIC[locking]"*"user: we need to pick a lock strategy for the sync engine"*) ;;
  *) fail_with "an explicit argument dropped the session transcript (got: '$result')" "$topic" ;;
esac

echo "session-context: a bare command reached the child with the conversation, tool output stayed out, an empty session was refused, and an explicit argument kept the transcript"
