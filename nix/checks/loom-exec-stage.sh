#!/usr/bin/env bash
# Runtime acceptance for phase P4b-i of extensions/pi-loom/DESIGN.md: the `exec`
# stage. exec is the stage that writes code, so the thing worth proving is not
# the prompt but the machinery around it: an isolated git worktree exists and is
# populated *before* the implementing agent is launched, and the base commit the
# diff is measured against is read from inside that worktree.
#
# Boots the real `loom` wrapper headlessly against a throwaway git repository
# and proves:
#
#   1. exec is a stage: it appears in the available-stage list, rejects a missing
#      `item`, and rejects a non-string `worktree` name -- all inside the sandbox,
#      with no worktree created and no agent launched.
#   2. exec opens the worktree before it launches the agent. The probe asks for a
#      model that does not exist, so the agent call is refused by the executor
#      before any network access; the git worktree is nonetheless on disk, checked
#      out on its own branch, carrying the repository's files.
#   3. The base commit really is read inside that worktree: the run journal holds
#      a completed shell operation whose stdout is the worktree's own HEAD.
#
# What this cannot prove offline: the diff itself. Every command after the agent
# call needs the agent to have returned, and there is no network and no real key
# in the nix sandbox. The diff path is exercised by P4b-ii's /build workflow
# against a real model, not here.
#
# Usage: loom-exec-stage.sh <path-to-loom-binary>
set -euo pipefail

loom="${1:?usage: loom-exec-stage.sh <path-to-loom-binary>}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export HOME="$work/home"
agent_dir="$HOME/.pi/agent"
# Pi's agent dir defaults to $HOME/.pi/agent, which is what the nix sandbox gets.
# Pin it anyway: run this by hand from a Pi session and the inherited
# PI_CODING_AGENT_DIR would point the user-scope scan at the real agent dir.
export PI_CODING_AGENT_DIR="$agent_dir"
export GIT_AUTHOR_NAME="loom-exec-check"
export GIT_AUTHOR_EMAIL="loom-exec-check@localhost"
export GIT_COMMITTER_NAME="loom-exec-check"
export GIT_COMMITTER_EMAIL="loom-exec-check@localhost"
project="$work/project"
project_root="$project/.pi/workflows"
mkdir -p "$agent_dir" "$project_root/execinput" "$project_root/execworktree" "$project/src"
cd "$project"

# The worktree the engine builds is a snapshot of HEAD plus the working tree, so
# the repository needs a real commit before any of this works.
printf 'original content\n' >"$project/src/app.txt"
git init --quiet -b main "$project"
git -C "$project" add -A
git -C "$project" commit --quiet -m "loom exec stage check fixture"

# --- input contract: rejected before a worktree or an agent exists ------------
cat >"$project_root/execinput/command.json" <<'JSON'
{
  "name": "execinput",
  "description": "pi-loom exec stage input-contract probe.",
  "script": "probe.js"
}
JSON
cat >"$project_root/execinput/probe.js" <<'JS'
let unknown = "";
try { await stage("nope", {}); } catch (error) { unknown = error.message; }
let missing = "";
try { await stage("exec", {}); } catch (error) { missing = error.message; }
let named = "";
try { await stage("exec", { item: "anything", worktree: 7 }); } catch (error) { named = error.message; }
return { unknown: unknown, missing: missing, named: named };
JS

# --- ordering: worktree first, agent second ----------------------------------
# The model name is deliberately unknown. WorkflowAgentExecutor.resolve() refuses
# it before a session, a provider or a socket exists, which makes this the only
# way to reach exec's agent call offline and still see what came before it.
cat >"$project_root/execworktree/command.json" <<'JSON'
{
  "name": "execworktree",
  "description": "pi-loom exec stage worktree-ordering probe.",
  "script": "probe.js"
}
JSON
cat >"$project_root/execworktree/probe.js" <<'JS'
let failure = "";
try {
  await stage("exec", { item: "Rewrite src/app.txt", worktree: "probe", model: "loom-exec-check-not-a-real-model" });
} catch (error) { failure = error.message; }
return { failure: failure };
JS

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
  --api-key exec-stage-check-not-a-real-key
)

fail_with() {
  echo "exec-stage: $1" >&2
  shift
  for file in "$@"; do cat "$file" >&2; done
  exit 1
}

# Runs one workflow slash command and leaves its JSON result in $work/<name>.json.
run_probe() {
  local name="$1"
  local out="$work/$name.jsonl"
  : >"$out"
  {
    printf '{"id":"%s","type":"prompt","message":"/%s"}\n' "$name" "$name"
    for _ in $(seq 1 180); do
      if grep -q '"customType":"workflow"' "$out"; then break; fi
      sleep 1
    done
  } | timeout 300 "$loom" "${loom_args[@]}" >"$out"

  # `jq -c` keeps a multi-line message escaped on one line: reading it with
  # `head -1` after `jq -r` would silently cut it to its first line.
  jq -r 'select(.type == "message_start" and .message.customType == "workflow") | .message.content' \
    "$out" >"$work/$name.txt"
  [ -s "$work/$name.txt" ] || fail_with "/$name never completed" "$out"
  sed -n "s/^Workflow $name completed: //p" "$work/$name.txt" >"$work/$name.json"
  [ -s "$work/$name.json" ] || fail_with "/$name did not complete successfully" "$work/$name.txt"
}

# --------------------------------------------------------- input contract
run_probe execinput
field() { jq -r ".$1 // \"\"" "$work/execinput.json"; }

case "$(field unknown)" in
  *"available stages: plan, exec, review, quick"*) ;;
  *) fail_with "exec is missing from the available-stage list (got: '$(field unknown)')" ;;
esac

case "$(field missing)" in
  *"stage exec: item is required"*) ;;
  *) fail_with "exec did not reject a missing plan item (got: '$(field missing)')" ;;
esac

case "$(field named)" in
  *"stage exec: worktree must be a string"*) ;;
  *) fail_with "exec did not reject a non-string worktree name (got: '$(field named)')" ;;
esac

worktrees="$(git -C "$project" worktree list --porcelain | grep -c '^worktree ' || true)"
[ "$worktrees" = "1" ] ||
  fail_with "rejected exec input still created a worktree ($worktrees worktrees exist)"

# ------------------------------------------------ worktree before the agent
run_probe execworktree

failure="$(jq -r '.failure // ""' "$work/execworktree.json")"
case "$failure" in
  *"Unknown model"*) ;;
  *) fail_with "exec did not reach its agent call (got: '$failure')" "$work/execworktree.json" ;;
esac

worktrees="$(git -C "$project" worktree list --porcelain | grep -c '^worktree ' || true)"
[ "$worktrees" = "2" ] ||
  fail_with "exec did not create exactly one worktree before launching its agent ($worktrees worktrees exist)"

worktree_path="$(git -C "$project" worktree list --porcelain | awk '/^worktree /{print $2}' | grep -v "^$project\$" | head -1)"
[ -n "$worktree_path" ] || fail_with "the exec worktree has no path"
[ -f "$worktree_path/src/app.txt" ] ||
  fail_with "the exec worktree is empty: an implementing agent would have had nothing to edit"
grep -q 'original content' "$worktree_path/src/app.txt" ||
  fail_with "the exec worktree does not carry the repository's content"

branch="$(git -C "$worktree_path" rev-parse --abbrev-ref HEAD)"
case "$branch" in
  pi-extensible-workflows/*) ;;
  *) fail_with "the exec worktree is not on its own engine-owned branch (got: '$branch')" ;;
esac

# ------------------------------------------------------- base commit capture
head_commit="$(git -C "$worktree_path" rev-parse HEAD)"
journal=""
while IFS= read -r candidate; do
  if jq -e '[.completed // {} | to_entries[] | select(.key | startswith("shell/"))] | length > 0' "$candidate" >/dev/null; then
    journal="$candidate"
    break
  fi
done < <(find "$HOME/.pi/workflows" -name journal.json 2>/dev/null)
[ -n "$journal" ] || fail_with "no run journal recorded a shell operation; exec never read its base commit"

jq -e --arg head "$head_commit" \
  '[.completed | to_entries[] | select(.key | startswith("shell/")) | .value.value.stdout | rtrimstr("\n")] | index($head) != null' \
  "$journal" >/dev/null ||
  fail_with "exec read its base commit outside the worktree (expected $head_commit)" "$journal"

echo "exec-stage: exec is listed among the stages, rejected missing and mistyped input before any worktree existed, opened a populated worktree on its own branch before its agent was launched, and read that worktree's own HEAD as the diff base"
