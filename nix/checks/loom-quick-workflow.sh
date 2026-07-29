#!/usr/bin/env bash
# Runtime acceptance for phase P4c of extensions/pi-loom/DESIGN.md: the `/quick`
# workflow — one agent, no plan stage, no review stage, no worktree.
#
# The shipped directory is what runs. This check copies workflows/quick/ into a
# throwaway agent dir's `workflows` root, exactly where the system flake puts it,
# so a broken command.json or a renamed script fails here rather than on the
# user's machine.
#
# Boots the real `loom` wrapper headlessly against a throwaway git repository
# that is deliberately dirty (one modified tracked file, one untracked file) and
# proves:
#
#   1. /quick is discoverable from the user-scope workflows root, with the
#      argument surface command.json declares.
#   2. A launch with no task is rejected with the generated usage text before a
#      run exists.
#   3. The first agent /quick reaches is its own single stage. The probe asks for
#      a model that does not exist, so that agent call is refused by the executor
#      before any network access; the run then fails in the `quick` phase, having
#      entered no other phase. A /quick that planned first would have failed in a
#      `plan` phase instead.
#   4. No worktree is opened — the change is meant to land in the user's own
#      checkout, which is what separates /quick from /build.
#   5. The pre-agent working-tree snapshot really happened, and was harmless: new
#      objects appear in the object database, while the user's index file is
#      byte-identical and `git status` reports exactly what it did before.
#
# What this cannot prove offline: the change itself, or that no reviewer follows
# the agent. Both need an agent to have returned, and the nix sandbox has no
# network and no key. The stage machinery underneath is gated by
# checks.pi-loom-stages; /quick's prompt is policy and is judged by using it.
#
# Usage: loom-quick-workflow.sh <path-to-loom-binary> <path-to-workflows-quick-dir>
set -euo pipefail

loom="${1:?usage: loom-quick-workflow.sh <path-to-loom-binary> <path-to-workflows-quick-dir>}"
workflow_src="${2:?usage: loom-quick-workflow.sh <path-to-loom-binary> <path-to-workflows-quick-dir>}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export HOME="$work/home"
agent_dir="$HOME/.pi/agent"
# Pi's agent dir defaults to $HOME/.pi/agent, which is what the nix sandbox gets.
# Pin it anyway: run this by hand from a Pi session and the inherited
# PI_CODING_AGENT_DIR would point the user-scope scan at the real agent dir.
export PI_CODING_AGENT_DIR="$agent_dir"
export GIT_AUTHOR_NAME="loom-quick-check"
export GIT_AUTHOR_EMAIL="loom-quick-check@localhost"
export GIT_COMMITTER_NAME="loom-quick-check"
export GIT_COMMITTER_EMAIL="loom-quick-check@localhost"
project="$work/project"
workflows_root="$agent_dir/workflows"
mkdir -p "$workflows_root" "$project/src"

# The installed layout: <agentDir>/workflows/<name>/{command.json,script}. The
# nix store copy is read-only, so make the copy writable or the run store cannot
# stat it the way a real install would.
cp -r "$workflow_src" "$workflows_root/quick"
chmod -R u+w "$workflows_root/quick"

printf 'original content\n' >"$project/src/app.txt"
git init --quiet -b main "$project"
git -C "$project" add -A
git -C "$project" commit --quiet -m "loom quick workflow check fixture"

# Dirty on purpose. The snapshot the quick stage takes before its agent must hash
# these two files, which is what makes it observable offline: it writes objects
# no other command in this check would write.
printf 'edited by the user before the run\n' >>"$project/src/app.txt"
printf 'untracked by the user before the run\n' >"$project/src/scratch.txt"
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
  --api-key quick-workflow-check-not-a-real-key
)

fail_with() {
  echo "quick-workflow: $1" >&2
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
  *quick*) ;;
  *) fail_with "/workflows never listed quick (got: '$listing')" ;;
esac
case "$listing" in
  *"user ($workflows_root)"*) ;;
  *) fail_with "/workflows did not list quick in user scope from $workflows_root (got: '$listing')" ;;
esac

# ------------------------------------------- a task-less launch never runs
run_command usage '"/quick"' '"method":"notify"'
usage="$(cat "$work/usage.notify.txt")"
case "$usage" in
  *"required properties task"*) ;;
  *) fail_with "/quick accepted a launch with no task (got: '$usage')" ;;
esac
case "$usage" in
  *"Usage: /quick <task>"*) ;;
  *) fail_with "/quick rejected a task-less launch without its generated usage text (got: '$usage')" ;;
esac

runs_root="$HOME/.pi/workflows"
run_count="$(find "$runs_root" -name state.json 2>/dev/null | wc -l)"
[ "$run_count" = "0" ] ||
  fail_with "a rejected /quick launch still started $run_count run(s)"

# --------------------------------------- the tree, exactly as the user left it
# `git status` may refresh the index's stat cache, so read status first and copy
# the index afterwards: otherwise this check would blame the run for its own
# bookkeeping.
git -C "$project" status --porcelain >"$work/status.before"
cp "$project/.git/index" "$work/index.before"
objects_before="$(find "$project/.git/objects" -type f | wc -l)"

# -------------------------------------------------- one stage, no plan, no tree
# The model name is deliberately unknown. WorkflowAgentExecutor.resolve() refuses
# it before a session, a provider or a socket exists, which makes this the only
# way to reach the quick stage's agent call offline and still see what came
# before it -- and what did not come after it.
run_command quick \
  '"/quick {\"task\":\"rewrite src/app.txt\",\"model\":\"loom-quick-check-not-a-real-model\"}"' \
  '"customType":"workflow"'
delivery="$(cat "$work/quick.workflow.txt")"
case "$delivery" in
  *"Unknown model loom-quick-check-not-a-real-model"*) ;;
  *) fail_with "/quick did not pass the caller's model into its stage (got: '$delivery')" ;;
esac

state="$(find "$runs_root" -name state.json 2>/dev/null | head -1)"
[ -n "$state" ] || fail_with "/quick started no run"

jq -e '.state == "failed" and .error.code == "UNKNOWN_MODEL"' "$state" >/dev/null ||
  fail_with "/quick failed for a reason other than the unknown model" "$state"

jq -e '[.phaseHistory[].phase] == ["quick"]' "$state" >/dev/null ||
  fail_with "/quick entered a phase other than its own single stage" "$state"

worktrees="$(git -C "$project" worktree list --porcelain | grep -c '^worktree ' || true)"
[ "$worktrees" = "1" ] ||
  fail_with "/quick opened a worktree ($worktrees worktrees exist); it is meant to work in the user's own checkout"

snapshot="$(dirname "$state")/snapshot.json"
[ -f "$snapshot" ] || fail_with "the /quick run recorded no launch snapshot"
jq -e '.args.task == "rewrite src/app.txt"' "$snapshot" >/dev/null ||
  fail_with "the caller's task did not reach the /quick run" "$snapshot"

# ------------------------------- the snapshot happened, and changed nothing
objects_after="$(find "$project/.git/objects" -type f | wc -l)"
[ "$objects_after" -gt "$objects_before" ] ||
  fail_with "/quick wrote no objects, so it never snapshotted the working tree before its agent ($objects_before objects before, $objects_after after)"

cmp -s "$work/index.before" "$project/.git/index" ||
  fail_with "/quick modified the user's git index; the snapshot must use a throwaway index file"

git -C "$project" status --porcelain >"$work/status.after"
diff -u "$work/status.before" "$work/status.after" >"$work/status.diff" ||
  fail_with "/quick changed what git status reports about the user's tree" "$work/status.diff"

echo "quick-workflow: /quick is registered from the user workflows root, rejects a task-less launch with generated usage before any run exists, and reaches one stage -- no plan phase, no worktree, and a pre-agent working-tree snapshot that left the user's index and status untouched"
