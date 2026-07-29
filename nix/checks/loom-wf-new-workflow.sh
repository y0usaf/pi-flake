#!/usr/bin/env bash
# Runtime acceptance for phase P6b of extensions/pi-loom/DESIGN.md: the `/wf-new`
# interview. The workflow asks three questions through human.ask and every answer
# becomes one input of stage("scaffold", ...).
#
# The shipped directory is what runs. This check copies workflows/wf-new/ into a
# throwaway agent dir's `workflows` root, exactly where the system flake puts it,
# so a broken command.json or a renamed script fails here rather than on the
# user's machine.
#
# Three claims, all offline:
#
#   1. Discovery and rejection. /wf-new registers from the user workflows root,
#      and a task-less launch is refused with the generated usage before a run
#      exists.
#   2. No answers parks the run rather than guessing. The first question renders
#      as a choice UI carrying the candidate names derived from the task's own
#      words; closing the client without answering leaves the run in
#      `awaiting_input`, the question in the journal, the `scaffold` phase never
#      entered, and no workflow directory created anywhere in the project.
#   3. The recorded answers reach stage("scaffold", ...). Answering all three
#      questions resumes the run into the scaffold stage, which creates its
#      directory before its agent exists: the probe answers "repository workflow
#      set" and a derived name, so `workflows/<chosen name>/` appearing in the
#      project is filesystem evidence that both the scope answer and the name
#      answer became stage inputs -- neither is the stage's default, which is
#      `.pi/workflows`. The shape answer is not observable on disk (it is prompt
#      text for an agent that never runs), so it is read from the run journal's
#      log line instead.
#
# What this cannot prove offline: the scaffolded workflow itself. The agent is
# asked for a model that does not exist, so the run dies at model resolution
# inside the `scaffold` phase. What the stage does after an agent returns is
# gated by checks.pi-loom-scaffold-stage.
#
# Usage: loom-wf-new-workflow.sh <path-to-loom-binary> <path-to-workflows-wf-new-dir>
set -euo pipefail

loom="${1:?usage: loom-wf-new-workflow.sh <path-to-loom-binary> <path-to-workflows-wf-new-dir>}"
workflow_src="${2:?usage: loom-wf-new-workflow.sh <path-to-loom-binary> <path-to-workflows-wf-new-dir>}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export HOME="$work/home"
agent_dir="$HOME/.pi/agent"
# Pi's agent dir defaults to $HOME/.pi/agent, which is what the nix sandbox gets.
# Pin it anyway: run this by hand from a Pi session and the inherited
# PI_CODING_AGENT_DIR would point the user-scope scan at the real agent dir.
export PI_CODING_AGENT_DIR="$agent_dir"
export GIT_AUTHOR_NAME="loom-wf-new-check"
export GIT_AUTHOR_EMAIL="loom-wf-new-check@localhost"
export GIT_COMMITTER_NAME="loom-wf-new-check"
export GIT_COMMITTER_EMAIL="loom-wf-new-check@localhost"
project="$work/project"
workflows_root="$agent_dir/workflows"
runs_root="$HOME/.pi/workflows"
mkdir -p "$workflows_root" "$project"

# The installed layout: <agentDir>/workflows/<name>/{command.json,script}. The
# nix store copy is read-only, so make the copy writable or the run store cannot
# stat it the way a real install would.
cp -r "$workflow_src" "$workflows_root/wf-new"
chmod -R u+w "$workflows_root/wf-new"

printf 'wf-new interview check fixture\n' >"$project/README.md"
git init --quiet -b main "$project"
git -C "$project" add -A
git -C "$project" commit --quiet -m "loom wf-new workflow check fixture"
cd "$project"

# A prompt is refused before command dispatch unless a model resolves with a key,
# so pass a throwaway one. --offline keeps startup off the network; the key is
# never used because extension commands run locally.
loom_args=(
  --mode rpc
  --offline
  --no-session
  --no-skills
  --no-context-files
  --provider anthropic
  --model claude-sonnet-4-5
  --api-key wf-new-workflow-check-not-a-real-key
)

fail_with() {
  echo "wf-new-workflow: $1" >&2
  shift
  for file in "$@"; do cat "$file" >&2; done
  exit 1
}

# The task is fixed because the candidate names are derived from it: slug
# derivation is deterministic, so this exact sentence must offer this exact list.
# "the" sits in position two on purpose. It is a filler word, so a derivation
# that stopped dropping filler would offer `audit-the` here and fail this check
# instead of shipping slugs named after articles.
task="audit the flake inputs for staleness"
expected_choices='["audit-flake","audit-flake-inputs","wf-audit"]'
chosen_name="audit-flake-inputs"
chosen_scope="repository workflow set (workflows/, installed by the flake)"
chosen_shape="plan only, no implementation"

# ------------------------------------------------ discovery and usage rejection
# One-shot leg: a rejected launch never parks anything, so stdin can close as
# soon as the engine has answered.
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
}

run_command listing '"/workflows"' '"customType":"workflow-list"'
listing="$(jq -c 'select(.type == "message_start" and .message.customType == "workflow-list") | .message.content' "$work/listing.jsonl")"
case "$listing" in
  *wf-new*) ;;
  *) fail_with "/workflows never listed wf-new (got: '$listing')" ;;
esac

run_command usage '"/wf-new"' '"method":"notify"'
usage="$(jq -c 'select(.type == "extension_ui_request" and .method == "notify") | .message' "$work/usage.jsonl")"
case "$usage" in
  *"required properties task"*) ;;
  *) fail_with "/wf-new accepted a launch with no task (got: '$usage')" ;;
esac
case "$usage" in
  *"Usage: /wf-new <task>"*) ;;
  *) fail_with "/wf-new rejected a task-less launch without its generated usage text (got: '$usage')" ;;
esac

run_count="$(find "$runs_root" -name state.json 2>/dev/null | wc -l)"
[ "$run_count" = "0" ] ||
  fail_with "a rejected /wf-new launch still started $run_count run(s)"

# ----------------------------------------------------- an unanswered run parks
# stdin must stay open while the run is alive, so drive it through a FIFO held by
# fd 3 instead of a pipeline. Closing fd 3 is what makes pi exit -- here, while
# the run is still waiting for an answer that never comes.
#
# Everything about the parked run is read while pi is still running, on purpose:
# session_shutdown promotes every non-terminal run to `interrupted`
# (SHUTDOWN_TERMINAL_RUN_STATES in src/host.ts), so `awaiting_input` is only
# observable in a live process. The question is written to the journal and the
# state is set before the choice UI is emitted, so the request line arriving is
# proof that both are already on disk.
park_out="$work/park.jsonl"
: >"$park_out"
mkfifo "$work/park.stdin"
timeout 300 "$loom" "${loom_args[@]}" <"$work/park.stdin" >"$park_out" &
park_pid=$!
exec 3>"$work/park.stdin"

printf '{"id":"park","type":"prompt","message":"/wf-new %s"}\n' "$task" >&3

# jq is fed a file that is still being appended to, so a partial trailing line is
# normal and its parse error is not a failure.
request=""
for _ in $(seq 1 120); do
  request="$(jq -c 'select(.type == "extension_ui_request" and .method == "select")' "$park_out" 2>/dev/null | head -1)"
  [ -n "$request" ] && break
  sleep 1
done

[ -n "$request" ] || fail_with "/wf-new rendered no question; the interview never reached human.ask" "$park_out"
printf '%s\n' "$request" >"$work/park.request.json"

title="$(jq -r '.title' "$work/park.request.json")"
case "$title" in
  *"Name the new workflow"*) ;;
  *) fail_with "/wf-new asked something other than the naming question first (got: '$title')" ;;
esac

jq -e --argjson expected "$expected_choices" '.options == $expected' "$work/park.request.json" >/dev/null ||
  fail_with "/wf-new did not offer the candidate names derived from the task (expected $expected_choices)" "$work/park.request.json"

park_state="$(find "$runs_root" -name state.json 2>/dev/null | head -1)"
[ -n "$park_state" ] || fail_with "/wf-new started no run"

jq -e '.state == "awaiting_input"' "$park_state" >/dev/null ||
  fail_with "an unanswered /wf-new did not park the run" "$park_state"

jq -e '[.phaseHistory[].phase] == ["interview"]' "$park_state" >/dev/null ||
  fail_with "an unanswered /wf-new left the interview phase" "$park_state"

park_journal="$(dirname "$park_state")/journal.json"
[ -f "$park_journal" ] || fail_with "the parked /wf-new run wrote no journal"
jq -e --argjson expected "$expected_choices" \
  '[.awaitingHuman[] | select(.name == "name")] | length == 1 and (.[0].choices == $expected)' \
  "$park_journal" >/dev/null ||
  fail_with "the parked question was not recorded in the run journal" "$park_journal"

exec 3>&-
wait "$park_pid" || true

scaffolded="$(find "$project" -mindepth 1 -name command.json -not -path "$project/.git/*" 2>/dev/null | wc -l)"
[ "$scaffolded" = "0" ] ||
  fail_with "an unanswered /wf-new wrote $scaffolded workflow manifest(s); it must park rather than guess a name"

# --------------------------------------- answered, the answers reach the stage
# A second run, in its own store, so the parked one above cannot be mistaken for
# it. The model is deliberately unknown: WorkflowAgentExecutor.resolve() refuses
# it before a session, a provider or a socket exists, which is what makes the
# scaffold stage reachable offline -- the stage creates its directory before its
# agent, so the directory survives the failure as evidence.
rm -rf "$runs_root"

answer_out="$work/answer.jsonl"
: >"$answer_out"
mkfifo "$work/answer.stdin"
timeout 300 "$loom" "${loom_args[@]}" <"$work/answer.stdin" >"$answer_out" &
answer_pid=$!
exec 3>"$work/answer.stdin"

printf '{"id":"answer","type":"prompt","message":"/wf-new {\\"task\\":\\"%s\\",\\"model\\":\\"loom-wf-new-check-not-a-real-model\\"}"}\n' \
  "$task" >&3

# Answers one question and returns its title, so the caller can assert what was
# asked. Questions arrive one at a time: the run is suspended between them, so
# the Nth select request cannot appear before the (N-1)th is answered.
answer_question() {
  local index="$1"
  local value="$2"
  local pending=""
  local id=""
  for _ in $(seq 1 120); do
    pending="$(jq -c 'select(.type == "extension_ui_request" and .method == "select")' "$answer_out" 2>/dev/null | sed -n "${index}p")"
    [ -n "$pending" ] && break
    sleep 1
  done
  [ -n "$pending" ] || return 1
  id="$(printf '%s' "$pending" | jq -r '.id')"
  printf '%s' "$pending" | jq -r '.title' >"$work/question.$index.txt"
  printf '{"type":"extension_ui_response","id":"%s","value":%s}\n' "$id" "$(printf '%s' "$value" | jq -Rs .)" >&3
}

answer_question 1 "$chosen_name" || fail_with "the naming question never arrived" "$answer_out"
answer_question 2 "$chosen_scope" || fail_with "the scope question never arrived after the name was chosen" "$answer_out"
answer_question 3 "$chosen_shape" || fail_with "the shape question never arrived after the scope was chosen" "$answer_out"

for _ in $(seq 1 180); do
  if grep -q '"customType":"workflow"' "$answer_out"; then break; fi
  sleep 1
done
exec 3>&-
wait "$answer_pid" || true

grep -q "Name the new workflow" "$work/question.1.txt" ||
  fail_with "question 1 was not the naming question" "$work/question.1.txt"
grep -q "Where should /$chosen_name be written" "$work/question.2.txt" ||
  fail_with "the scope question did not carry the name that was just chosen" "$work/question.2.txt"
grep -q "What shape should /$chosen_name have" "$work/question.3.txt" ||
  fail_with "the shape question did not carry the name that was just chosen" "$work/question.3.txt"

state="$(find "$runs_root" -name state.json 2>/dev/null | head -1)"
[ -n "$state" ] || fail_with "the answered /wf-new started no run"

jq -e '.state == "failed" and .error.code == "UNKNOWN_MODEL"' "$state" >/dev/null ||
  fail_with "the answered /wf-new failed for a reason other than the unknown model" "$state"

jq -e '[.phaseHistory[].phase] == ["interview", "scaffold"]' "$state" >/dev/null ||
  fail_with "the answered /wf-new did not resume from the interview into the scaffold stage" "$state"

# The scope answer, on disk. `.pi/workflows` is the stage's own default, so this
# path can only come from the answer that was given.
[ -d "$project/workflows/$chosen_name" ] ||
  fail_with "the chosen name and scope never reached stage(\"scaffold\"): $project/workflows/$chosen_name does not exist"
[ ! -d "$project/.pi/workflows/$chosen_name" ] ||
  fail_with "stage(\"scaffold\") used its default directory instead of the scope answer"

# The shape answer is prompt text for an agent that never ran, so the journal's
# own log line is where it is observable.
shape_log="$(jq -r 'select(.type == "entry_appended" and .entry.customType == "workflow-log") | .entry.data.message' "$answer_out" | grep '^interview:' | head -1)"
case "$shape_log" in
  *"shape=$chosen_shape"*) ;;
  *) fail_with "the shape answer was not recorded by the workflow (got: '$shape_log')" ;;
esac
case "$shape_log" in
  *"scope=workflows"*) ;;
  *) fail_with "the scope answer was not recorded by the workflow (got: '$shape_log')" ;;
esac

snapshot="$(dirname "$state")/snapshot.json"
[ -f "$snapshot" ] || fail_with "the answered /wf-new run recorded no launch snapshot"
jq -e --arg task "$task" '.args.task == $task' "$snapshot" >/dev/null ||
  fail_with "the caller's task did not reach the /wf-new run" "$snapshot"

echo "wf-new-workflow: /wf-new is registered from the user workflows root, rejects a task-less launch with generated usage before any run exists, parks in the interview phase with derived name candidates when nobody answers, and turns all three answers into stage(\"scaffold\") inputs -- the chosen name and scope proven by the directory the stage created"
