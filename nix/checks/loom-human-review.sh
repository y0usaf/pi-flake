#!/usr/bin/env bash
# Runtime acceptance for phase P2c of extensions/pi-loom/DESIGN.md: the
# human.review DSL primitive. Boots the real `loom` wrapper headlessly and
# proves the whole round trip, which no build-only check can see:
#
#   1. A workflow calling human.review() puts the subject under review into the
#      session (a custom message with customType "workflow-review", because a
#      picker title is one line and a diff is not) and opens a verdict picker.
#      In RPC mode ctx.ui.select is an `extension_ui_request` with method
#      "select", so the request line IS the rendered UI.
#   2. The verdicts offered are the fixed trio, not the workflow's own choices:
#      that is what separates human.review from human.ask.
#   3. A "Request changes" verdict opens a note prompt (method "input") and the
#      typed note reaches the NEXT stage: the second review's prompt is built
#      from the first review's note, so the second picker title proves it.
#   4. "Approve" takes no note prompt, and the run resumes with the verdict.
#
# Usage: loom-human-review.sh <path-to-loom-binary>
# Runs offline with a throwaway HOME; no network, no real API key. The probe
# never calls agent(), so no model is ever contacted.
set -euo pipefail

loom="${1:?usage: loom-human-review.sh <path-to-loom-binary>}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export HOME="$work/home"
agent_dir="$HOME/.pi/agent"
project="$work/project"
mkdir -p "$agent_dir/workflows/loomreview" "$project"
cd "$project"

cat >"$agent_dir/workflows/loomreview/command.json" <<'JSON'
{
  "name": "loomreview",
  "description": "pi-loom human.review smoke probe: proves a run suspends on a verdict and resumes with the note",
  "script": "review.js",
  "args": {}
}
JSON

# Runs inside the forked child's vm sandbox. The second review's prompt is built
# from the first review's note, so the note crossing a stage boundary is
# observable from outside as the second picker's title.
cat >"$agent_dir/workflows/loomreview/review.js" <<'JS'
const first = await human.review({
  name: "diff",
  prompt: "Review the smoke probe diff",
  subject: "--- a/probe\n+++ b/probe\n-old line\n+new line",
  context: { probe: true },
});
log("review1 verdict=" + first.verdict + " note=" + first.note);
const second = await human.review({
  name: "repair",
  prompt: "Reviewer asked for: " + first.note,
  subject: "+repaired line",
  context: {},
});
log("review2 verdict=" + second.verdict + " note=" + second.note);
return second.verdict + ":" + first.note;
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

out="$work/review.jsonl"
: >"$out"

# stdin must stay open across four writes (launch, verdict, note, verdict), so
# drive it through a FIFO held by fd 3 instead of a pipeline. Closing fd 3 is
# what makes pi exit at the end.
mkfifo "$work/stdin"
timeout 300 "$loom" "${loom_args[@]}" <"$work/stdin" >"$out" &
loom_pid=$!
exec 3>"$work/stdin"

fail() {
  echo "human-review: $1" >&2
  cat "$out" >&2
  exec 3>&- || true
  exit 1
}

# Wait for the Nth UI request of one method. jq is fed a file that is still
# being appended to, so a partial trailing line is normal and its parse error is
# not a failure.
await_request() {
  local method="$1" index="$2" found=""
  for _ in $(seq 1 120); do
    found="$(jq -c --arg method "$method" 'select(.type == "extension_ui_request" and .method == $method)' "$out" 2>/dev/null | sed -n "${index}p")"
    [ -n "$found" ] && break
    sleep 1
  done
  [ -n "$found" ] || return 1
  printf '%s' "$found"
}

answer_request() {
  printf '{"type":"extension_ui_response","id":"%s","value":%s}\n' "$1" "$2" >&3
}

printf '{"id":"review","type":"prompt","message":"/loomreview"}\n' >&3

request="$(await_request select 1)" || fail "no verdict picker was rendered for human.review"

title="$(printf '%s' "$request" | jq -r '.title')"
[ "$title" = "Review the smoke probe diff" ] || fail "verdict picker title is not the workflow's prompt (got: '$title')"

printf '%s' "$request" | jq -e '.options == ["Approve", "Request changes", "Reject"]' >/dev/null \
  || fail "verdict picker did not offer the fixed approve/changes/reject trio: $request"

# The diff itself cannot fit in a picker title, so it is presented in the
# session as its own custom message. Without this the reviewer is judging
# something they cannot see. Kept JSON-encoded (no jq -r) so the multi-line
# diff stays on one line and survives head -1.
presented=""
for _ in $(seq 1 60); do
  presented="$(jq -c 'select(.type == "message_start" and .message.customType == "workflow-review") | .message.content' "$out" 2>/dev/null | head -1)"
  [ -n "$presented" ] && break
  sleep 1
done
printf '%s' "$presented" | grep -Fq -- "+new line" || fail "the subject under review never reached the session (got: '$presented')"

answer_request "$(printf '%s' "$request" | jq -r '.id')" '"Request changes"'

# A non-approve verdict must collect the note that tells the next stage what to
# do; an approve verdict must not (asserted at the end by the input count).
note_request="$(await_request input 1)" || fail "no note prompt followed a Request changes verdict"
note_title="$(printf '%s' "$note_request" | jq -r '.title')"
[ "$note_title" = "Note for review diff" ] || fail "note prompt is not keyed to the review name (got: '$note_title')"
answer_request "$(printf '%s' "$note_request" | jq -r '.id')" '"tighten the error path"'

# The acceptance criterion: the note reaches the next stage. The probe builds
# the second review's prompt from the first review's note, so the second
# picker's title is the note making the crossing.
second="$(await_request select 2)" || fail "the run did not reach the second human.review"
second_title="$(printf '%s' "$second" | jq -r '.title')"
[ "$second_title" = "Reviewer asked for: tighten the error path" ] \
  || fail "the note did not reach the next stage (second picker title: '$second_title')"
answer_request "$(printf '%s' "$second" | jq -r '.id')" '"Approve"'

# Hold stdin open only until the run reports back, then close it so pi exits.
for _ in $(seq 1 120); do
  if grep -q '"customType":"workflow"' "$out"; then break; fi
  sleep 1
done
exec 3>&-
wait "$loom_pid" || true

inputs="$(jq -c 'select(.type == "extension_ui_request" and .method == "input")' "$out" | wc -l)"
[ "$inputs" = "1" ] || {
  echo "human-review: an approve verdict must not prompt for a note (input prompts: $inputs)" >&2
  exit 1
}

logs="$(jq -r 'select(.type == "entry_appended" and .entry.customType == "workflow-log") | .entry.data.message' "$out")"

expect_log() {
  printf '%s\n' "$logs" | grep -Fqx "$1" || {
    echo "human-review: expected workflow log '$1', got:" >&2
    printf '%s\n' "$logs" >&2
    exit 1
  }
}

expect_log "review1 verdict=changes note=tighten the error path"
expect_log "review2 verdict=approve note="

result="$(jq -r 'select(.type == "message_start" and .message.customType == "workflow") | .message.content' "$out" | head -1)"
[ "$result" = 'Workflow loomreview completed: "approve:tighten the error path"' ] || {
  echo "human-review: run did not resume with the typed verdict (got: '$result')" >&2
  exit 1
}

echo "human-review: verdict picker offered the fixed trio, the note reached the next stage, the run resumed with the verdict"
