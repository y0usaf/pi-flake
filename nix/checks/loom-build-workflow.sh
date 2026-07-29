#!/usr/bin/env bash
# Runtime acceptance for phase P4b-ii of extensions/pi-loom/DESIGN.md: the
# `/build` workflow — plan -> exec -> review over one worktree, keyed per plan
# item.
#
# The shipped directory is what runs. This check copies workflows/build/ into a
# throwaway agent dir's `workflows` root, exactly where the system flake puts it,
# so a broken command.json or a renamed script fails here rather than on the
# user's machine.
#
# Boots the real `loom` wrapper headlessly against a throwaway git repository
# and proves:
#
#   1. /build is discoverable from the user-scope workflows root, with the
#      argument surface command.json declares.
#   2. A launch with no task is rejected with the generated usage text before a
#      run exists.
#   3. plan comes first and exec second. The probe asks for a model that does
#      not exist, so the plan stage's agent call is refused by the executor
#      before any network access; the run then fails in the `plan` phase, having
#      entered no item phase, with the probe repository still carrying zero
#      worktrees. A /build that called exec before plan would have opened one.
#   4. The caller's `model` argument reaches the stage (that is what UNKNOWN_MODEL
#      names) and command.json's schema defaults reach the run snapshot.
#
# What this cannot prove offline: the plan artifact, the exec diff and the review
# verdict themselves. Every one of them needs an agent to have returned, and the
# nix sandbox has no network and no key. The stage machinery underneath them is
# gated by checks.pi-loom-stages and checks.pi-loom-exec-stage; /build's own
# prompts are policy and are judged by using it against a real model.
#
# Usage: loom-build-workflow.sh <path-to-loom-binary> <path-to-workflows-build-dir>
set -euo pipefail

loom="${1:?usage: loom-build-workflow.sh <path-to-loom-binary> <path-to-workflows-build-dir>}"
workflow_src="${2:?usage: loom-build-workflow.sh <path-to-loom-binary> <path-to-workflows-build-dir>}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export HOME="$work/home"
agent_dir="$HOME/.pi/agent"
# Pi's agent dir defaults to $HOME/.pi/agent, which is what the nix sandbox gets.
# Pin it anyway: run this by hand from a Pi session and the inherited
# PI_CODING_AGENT_DIR would point the user-scope scan at the real agent dir.
export PI_CODING_AGENT_DIR="$agent_dir"
export GIT_AUTHOR_NAME="loom-build-check"
export GIT_AUTHOR_EMAIL="loom-build-check@localhost"
export GIT_COMMITTER_NAME="loom-build-check"
export GIT_COMMITTER_EMAIL="loom-build-check@localhost"
project="$work/project"
workflows_root="$agent_dir/workflows"
mkdir -p "$workflows_root" "$project/src"

# The installed layout: <agentDir>/workflows/<name>/{command.json,script}. The
# nix store copy is read-only, so make the copy writable or the run store cannot
# stat it the way a real install would.
cp -r "$workflow_src" "$workflows_root/build"
chmod -R u+w "$workflows_root/build"

# The worktree the engine would build is a snapshot of HEAD plus the working
# tree, so the probe repository needs a real commit even though this check stops
# before any worktree is opened.
printf 'original content\n' >"$project/src/app.txt"
git init --quiet -b main "$project"
git -C "$project" add -A
git -C "$project" commit --quiet -m "loom build workflow check fixture"
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
  --api-key build-workflow-check-not-a-real-key
)

fail_with() {
  echo "build-workflow: $1" >&2
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
  # `head -1` after `jq -r` would silently cut it to its first line. A run
  # delivers under customType "workflow"; the /workflows listing delivers under
  # "workflow-list", so both are collected here.
  jq -c 'select(.type == "message_start" and (.message.customType == "workflow" or .message.customType == "workflow-list")) | .message.content' \
    "$out" >"$work/$name.workflow.txt"
  jq -c 'select(.type == "extension_ui_request" and .method == "notify") | .message' \
    "$out" >"$work/$name.notify.txt"
}

# ------------------------------------------------------- discovery and scope
run_command listing '"/workflows"' '"customType":"workflow-list"'
listing="$(cat "$work/listing.workflow.txt")"
case "$listing" in
  *build*) ;;
  *) fail_with "/workflows never listed build (got: '$listing')" ;;
esac
case "$listing" in
  *"user ($workflows_root)"*) ;;
  *) fail_with "/workflows did not list build in user scope from $workflows_root (got: '$listing')" ;;
esac

# ------------------------------------------- a task-less launch never runs
run_command usage '"/build"' '"method":"notify"'
usage="$(cat "$work/usage.notify.txt")"
case "$usage" in
  *"required properties task"*) ;;
  *) fail_with "/build accepted a launch with no task (got: '$usage')" ;;
esac
case "$usage" in
  *"Usage: /build <task>"*) ;;
  *) fail_with "/build rejected a task-less launch without its generated usage text (got: '$usage')" ;;
esac

runs_root="$HOME/.pi/workflows"
run_count="$(find "$runs_root" -name state.json 2>/dev/null | wc -l)"
[ "$run_count" = "0" ] ||
  fail_with "a rejected /build launch still started $run_count run(s)"

# ------------------------------------------------------- plan before exec
# The model name is deliberately unknown. WorkflowAgentExecutor.resolve() refuses
# it before a session, a provider or a socket exists, which makes this the only
# way to reach the plan stage's agent call offline and still see what came before
# it -- and what did not come after it.
run_command build \
  '"/build {\"task\":\"rewrite src/app.txt\",\"model\":\"loom-build-check-not-a-real-model\"}"' \
  '"customType":"workflow"'
delivery="$(cat "$work/build.workflow.txt")"
case "$delivery" in
  *"Unknown model loom-build-check-not-a-real-model"*) ;;
  *) fail_with "/build did not pass the caller's model into its first stage (got: '$delivery')" ;;
esac

state="$(find "$runs_root" -name state.json 2>/dev/null | head -1)"
[ -n "$state" ] || fail_with "/build started no run"

jq -e '.state == "failed" and .error.code == "UNKNOWN_MODEL"' "$state" >/dev/null ||
  fail_with "/build failed for a reason other than the unknown model" "$state"

jq -e '.phase == "plan"' "$state" >/dev/null ||
  fail_with "/build was not in the plan phase when its first agent was refused" "$state"

jq -e '[.phaseHistory[].phase] == ["plan"]' "$state" >/dev/null ||
  fail_with "/build entered a phase other than plan before its first agent ran" "$state"

jq -e '[.phaseHistory[].phase] | map(select(startswith("item-"))) | length == 0' "$state" >/dev/null ||
  fail_with "/build entered a per-item phase before the plan stage returned" "$state"

worktrees="$(git -C "$project" worktree list --porcelain | grep -c '^worktree ' || true)"
[ "$worktrees" = "1" ] ||
  fail_with "/build opened a worktree before the plan stage returned ($worktrees worktrees exist)"

snapshot="$(dirname "$state")/snapshot.json"
[ -f "$snapshot" ] || fail_with "the /build run recorded no launch snapshot"
jq -e '.args.task == "rewrite src/app.txt" and .args.maxItems == 5 and .args.maxFixes == 1' "$snapshot" >/dev/null ||
  fail_with "command.json's schema defaults did not reach the /build run" "$snapshot"

echo "build-workflow: /build is registered from the user workflows root, rejects a task-less launch with generated usage before any run exists, and reaches its plan stage first -- failing there with the caller's model, having entered no item phase and opened no worktree"
