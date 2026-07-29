#!/usr/bin/env bash
# Runtime acceptance for phase P2b of extensions/pi-loom/DESIGN.md: the
# human.edit DSL primitive. Boots the real `loom` wrapper headlessly and proves
# the whole round trip, which no build-only check can see:
#
#   1. A workflow calling human.edit() opens an editor prefilled with the
#      workflow's own text. In RPC mode ctx.ui.editor is an
#      `extension_ui_request` with method "editor" on stdout, so the request
#      line IS the rendered editor, and its `prefill` is the buffer handed over.
#   2. Saving a modified buffer resumes the run with the saved text.
#   3. The three outcomes stay distinguishable: edited, saved byte-identical,
#      and abandoned (editor closed without saving, an `cancelled` response).
#      All three return text, so only the changed/abandoned flags separate them.
#
# Usage: loom-human-edit.sh <path-to-loom-binary>
# Runs offline with a throwaway HOME; no network, no real API key. The probe
# never calls agent(), so no model is ever contacted.
set -euo pipefail

loom="${1:?usage: loom-human-edit.sh <path-to-loom-binary>}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export HOME="$work/home"
agent_dir="$HOME/.pi/agent"
project="$work/project"
mkdir -p "$agent_dir/workflows/loomedit" "$project"
cd "$project"

cat >"$agent_dir/workflows/loomedit/command.json" <<'JSON'
{
  "name": "loomedit",
  "description": "pi-loom human.edit smoke probe: proves a run suspends on an editor round trip and resumes",
  "script": "edit.js",
  "args": {}
}
JSON

# Runs inside the forked child's vm sandbox. Each human.edit suspends the run
# until the host resolves it; the returned record carries the buffer plus the
# two flags a workflow branches on.
cat >"$agent_dir/workflows/loomedit/edit.js" <<'JS'
const edited = await human.edit({
  name: "draft",
  prompt: "Edit the smoke probe draft",
  text: "original draft",
  context: { probe: true },
});
const untouched = await human.edit({
  name: "untouched",
  prompt: "Leave the smoke probe draft alone",
  text: "keep me",
  context: {},
});
const abandoned = await human.edit({
  name: "abandoned",
  prompt: "Abandon the smoke probe draft",
  text: "never saved",
  context: {},
});
log("edit1 text=" + edited.text + " changed=" + edited.changed + " abandoned=" + edited.abandoned);
log("edit2 text=" + untouched.text + " changed=" + untouched.changed + " abandoned=" + untouched.abandoned);
log("edit3 text=" + abandoned.text + " changed=" + abandoned.changed + " abandoned=" + abandoned.abandoned);
return edited.text;
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

out="$work/edit.jsonl"
: >"$out"

# stdin must stay open across four writes (launch, then three editor answers),
# so drive it through a FIFO held by fd 3 instead of a pipeline. Closing fd 3 is
# what makes pi exit at the end.
mkfifo "$work/stdin"
timeout 300 "$loom" "${loom_args[@]}" <"$work/stdin" >"$out" &
loom_pid=$!
exec 3>"$work/stdin"

fail() {
  echo "human-edit: $1" >&2
  cat "$out" >&2
  exec 3>&- || true
  exit 1
}

# Wait for the Nth editor request. jq is fed a file that is still being appended
# to, so a partial trailing line is normal and its parse error is not a failure.
await_editor() {
  local index="$1" found=""
  for _ in $(seq 1 120); do
    found="$(jq -c 'select(.type == "extension_ui_request" and .method == "editor")' "$out" 2>/dev/null | sed -n "${index}p")"
    [ -n "$found" ] && break
    sleep 1
  done
  [ -n "$found" ] || return 1
  printf '%s' "$found"
}

printf '{"id":"edit","type":"prompt","message":"/loomedit"}\n' >&3

request="$(await_editor 1)" || fail "no editor was opened for human.edit"

title="$(printf '%s' "$request" | jq -r '.title')"
[ "$title" = "Edit the smoke probe draft" ] || fail "editor title is not the workflow's prompt (got: '$title')"

prefill="$(printf '%s' "$request" | jq -r '.prefill')"
[ "$prefill" = "original draft" ] || fail "editor was not prefilled with the workflow's text (got: '$prefill')"

request_id="$(printf '%s' "$request" | jq -r '.id')"
printf '{"type":"extension_ui_response","id":"%s","value":"edited draft"}\n' "$request_id" >&3

# Second edit: answered with the prefill byte for byte, which must read back as
# saved-but-unchanged rather than as an abandoned editor.
request="$(await_editor 2)" || fail "the run did not reach the second human.edit"
request_id="$(printf '%s' "$request" | jq -r '.id')"
printf '{"type":"extension_ui_response","id":"%s","value":"keep me"}\n' "$request_id" >&3

# Third edit: closed without saving. In RPC that is a `cancelled` response.
request="$(await_editor 3)" || fail "the run did not reach the third human.edit"
request_id="$(printf '%s' "$request" | jq -r '.id')"
printf '{"type":"extension_ui_response","id":"%s","cancelled":true}\n' "$request_id" >&3

# Hold stdin open only until the run reports back, then close it so pi exits.
for _ in $(seq 1 120); do
  if grep -q '"customType":"workflow"' "$out"; then break; fi
  sleep 1
done
exec 3>&-
wait "$loom_pid" || true

logs="$(jq -r 'select(.type == "entry_appended" and .entry.customType == "workflow-log") | .entry.data.message' "$out")"

expect_log() {
  printf '%s\n' "$logs" | grep -Fqx "$1" || {
    echo "human-edit: expected workflow log '$1', got:" >&2
    printf '%s\n' "$logs" >&2
    exit 1
  }
}

expect_log "edit1 text=edited draft changed=true abandoned=false"
expect_log "edit2 text=keep me changed=false abandoned=false"
expect_log "edit3 text=never saved changed=false abandoned=true"

result="$(jq -r 'select(.type == "message_start" and .message.customType == "workflow") | .message.content' "$out" | head -1)"
[ "$result" = 'Workflow loomedit completed: "edited draft"' ] || {
  echo "human-edit: run did not resume with the saved buffer (got: '$result')" >&2
  exit 1
}

echo "human-edit: editor opened prefilled, run resumed with the saved buffer, unchanged and abandoned edits stayed distinct"
