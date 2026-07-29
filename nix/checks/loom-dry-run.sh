#!/usr/bin/env bash
# Runtime acceptance for the first half of phase P6c in
# extensions/pi-loom/DESIGN.md: `dryRun({ directory })`, the sandbox capability
# that loads a workflow directory the way Pi registers slash commands and
# launches it once with deliberately invalid arguments -- without a model, an
# API key, or a run.
#
# One leg, not two, and the reason is worth recording. The sibling stage checks
# import the built engine's TypeScript straight into Node, which is
# milliseconds. That is impossible here: dryRunWorkflowCommand reaches
# src/validation.ts for the launch-time script guard, and validation.ts imports
# @earendil-works/pi-coding-agent -- a peer dependency that only exists inside a
# real Pi process, so a plain `node` import dies with ERR_MODULE_NOT_FOUND. So
# the whole check runs inside one real `loom` run instead, which is a stronger
# claim anyway: it proves the global exists in the vm sandbox, the RPC
# round-trips, paths resolve against the run's cwd, and the path rule is
# enforced. Ten scenarios share one run, so the run is the only fixed cost.
#
# Every fixture lives in its own parent directory. `dryRunWorkflowCommand` scans
# the *parent* of the directory it is handed (that is how Pi scans a workflows
# root), so co-locating fixtures would let one broken case shadow or pollute
# another.
#
# Usage: loom-dry-run.sh <path-to-loom-binary>
# Runs offline with a throwaway HOME; no network, no real API key, no model.
set -euo pipefail

loom="${1:?usage: loom-dry-run.sh <loom-binary>}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail_with() {
  echo "dry-run: $1" >&2
  shift
  for file in "$@"; do cat "$file" >&2; done
  exit 1
}

export HOME="$work/home"
agent_dir="$HOME/.pi/agent"
# Pi's agent dir defaults to $HOME/.pi/agent, which is what the nix sandbox
# gets. Pin it anyway: run this script by hand from a Pi session and the
# inherited PI_CODING_AGENT_DIR would point the user-scope scan at the real
# agent dir.
export PI_CODING_AGENT_DIR="$agent_dir"
project="$work/project"
project_root="$project/.pi/workflows"
targets="$project/targets"
mkdir -p "$agent_dir" "$project_root/dryrunprobe"
cd "$project"

fixture() {
  local case_name="$1"
  local workflow_name="$2"
  mkdir -p "$targets/$case_name/$workflow_name"
  printf '%s' "$targets/$case_name/$workflow_name"
}

# ------------------------------------------------------------ good: registers
good="$(fixture good dryrungood)"
cat >"$good/command.json" <<'JSON'
{
  "name": "dryrungood",
  "description": "A workflow that would register.",
  "script": "dryrungood.js",
  "argKey": "task",
  "argsSchema": {
    "type": "object",
    "properties": { "task": { "type": "string", "description": "What to do" } },
    "required": ["task"],
    "additionalProperties": false
  }
}
JSON
cat >"$good/dryrungood.js" <<'JS'
await phase("work");
return { task: args.task };
JS

# --------------------------------- no argsSchema: nothing to reject, and fine
anyargs="$(fixture anyargs dryrunanyargs)"
cat >"$anyargs/command.json" <<'JSON'
{ "name": "dryrunanyargs", "description": "Declares no argument schema.", "script": "run.js" }
JSON
printf 'return { ok: true };\n' >"$anyargs/run.js"

# --------------------------------------------------- command.json is not JSON
nojson="$(fixture nojson dryrunbadjson)"
printf '{ "name": "dryrunbadjson",\n' >"$nojson/command.json"
printf 'return { ok: true };\n' >"$nojson/run.js"

# ------------------------------------------------------ command.json has no name
noname="$(fixture noname dryrunnoname)"
cat >"$noname/command.json" <<'JSON'
{ "description": "No name at all.", "script": "run.js" }
JSON
printf 'return { ok: true };\n' >"$noname/run.js"

# ------------------------------------------- command.json names a missing script
noscript="$(fixture noscript dryrunnoscript)"
cat >"$noscript/command.json" <<'JSON'
{ "name": "dryrunnoscript", "description": "Names a script nobody wrote.", "script": "missing.js" }
JSON

# ------------------------------------- the script collides with the stage library
collide="$(fixture collide dryruncollide)"
cat >"$collide/command.json" <<'JSON'
{ "name": "dryruncollide", "description": "Redeclares stage.", "script": "run.js" }
JSON
cat >"$collide/run.js" <<'JS'
const stage = "mine";
return { stage: stage };
JS

# ------------------------------------------------- the script does not even parse
syntaxcase="$(fixture syntax dryrunsyntax)"
cat >"$syntaxcase/command.json" <<'JSON'
{ "name": "dryrunsyntax", "description": "Does not parse.", "script": "run.js" }
JSON
printf 'return {\n' >"$syntaxcase/run.js"

# ------------------------------- the name is already claimed by an installed root
shadow="$(fixture shadow dryrunprobe)"
cat >"$shadow/command.json" <<'JSON'
{ "name": "dryrunprobe", "description": "Steals the probe's own name.", "script": "run.js" }
JSON
printf 'return { ok: true };\n' >"$shadow/run.js"

# `targets/absent/dryrunabsent` is deliberately never created.

# ------------------------------------------------------------------ the driver
cat >"$project_root/dryrunprobe/command.json" <<'JSON'
{
  "name": "dryrunprobe",
  "description": "pi-loom dryRun probe.",
  "script": "probe.js"
}
JSON

# No agent call anywhere in this script: the whole point of a dry run is that it
# needs no model, so the run completes offline and every assertion below is made
# against the artifact it returns.
cat >"$project_root/dryrunprobe/probe.js" <<'JS'
const probe = async directory => {
  try {
    const result = await dryRun({ directory: directory });
    return { ok: true, result: result, message: "" };
  } catch (error) {
    return { ok: false, result: null, message: error.message };
  }
};

const good = await probe("targets/good/dryrungood");
const anyargs = await probe("targets/anyargs/dryrunanyargs");
const badjson = await probe("targets/nojson/dryrunbadjson");
const noname = await probe("targets/noname/dryrunnoname");
const noscript = await probe("targets/noscript/dryrunnoscript");
const collide = await probe("targets/collide/dryruncollide");
const syntax = await probe("targets/syntax/dryrunsyntax");
const shadow = await probe("targets/shadow/dryrunprobe");
const absent = await probe("targets/absent/dryrunabsent");
const escape = await probe("../outside");
const absolute = await probe("/etc");

let shape = "";
try { await dryRun({}); } catch (error) { shape = error.message; }

return {
  goodOk: good.ok,
  goodName: good.ok ? good.result.name : good.message,
  goodSignature: good.ok ? good.result.signature : "",
  goodUsage: good.ok ? good.result.usage : "",
  goodRequired: good.ok ? good.result.requiredArgs.join(",") : "",
  goodRejected: good.ok ? good.result.rejectedInvalidArguments : false,
  goodRejection: good.ok ? good.result.rejection : "",
  goodScript: good.ok ? good.result.scriptPath : "",
  anyargsOk: anyargs.ok,
  anyargsRejected: anyargs.ok ? anyargs.result.rejectedInvalidArguments : true,
  anyargsSignature: anyargs.ok ? anyargs.result.signature : anyargs.message,
  badjson: badjson.message,
  noname: noname.message,
  noscript: noscript.message,
  collide: collide.message,
  syntax: syntax.message,
  shadow: shadow.message,
  absent: absent.message,
  escape: escape.message,
  absolute: absolute.message,
  shape: shape,
};
JS

# A prompt is refused before command dispatch unless a model resolves with a
# key, so pass a throwaway one. --offline keeps startup off the network; the key
# is never used because extension commands run locally and this workflow never
# launches an agent.
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

probe_out="$work/probe.jsonl"
: >"$probe_out"
{
  printf '{"id":"probe","type":"prompt","message":"/dryrunprobe"}\n'
  for _ in $(seq 1 180); do
    if grep -q '"customType":"workflow"' "$probe_out"; then break; fi
    sleep 1
  done
} | timeout 300 "$loom" "${loom_args[@]}" >"$probe_out"

# `jq -c` keeps a multi-line message escaped on one line: reading it with
# `head -1` after `jq -r` would silently cut it to its first line.
jq -r 'select(.type == "message_start" and .message.customType == "workflow") | .message.content' \
  "$probe_out" >"$work/probe.txt"
[ -s "$work/probe.txt" ] || fail_with "/dryrunprobe never completed" "$probe_out"

sed -n 's/^Workflow dryrunprobe completed: //p' "$work/probe.txt" >"$work/probe.json"
[ -s "$work/probe.json" ] || fail_with "/dryrunprobe did not complete successfully" "$work/probe.txt"

field() { jq -r ".$1 // \"\"" "$work/probe.json"; }
# Booleans need their own accessor: jq's `//` is the alternative operator, and
# it treats `false` as empty, so `.flag // ""` turns a real `false` into the
# empty string and an assertion against "false" can never pass.
flag() { jq -r "(.$1 | tostring)" "$work/probe.json"; }

expect_contains() {
  local label="$1" key="$2" wanted="$3" got
  got="$(field "$key")"
  case "$got" in
    *"$wanted"*) ;;
    *) fail_with "$label (wanted '$wanted', got: '$got')" ;;
  esac
}

# ----------------------------------------------- a directory that would register
[ "$(flag goodOk)" = "true" ] ||
  fail_with "a valid workflow directory was refused by the dry run (got: '$(field goodName)')"
[ "$(field goodName)" = "dryrungood" ] ||
  fail_with "the dry run reported the wrong command name (got: '$(field goodName)')"
[ "$(field goodSignature)" = "Usage: /dryrungood <task>" ] ||
  fail_with "the dry run did not generate the command signature (got: '$(field goodSignature)')"
[ "$(field goodRequired)" = "task" ] ||
  fail_with "the dry run did not report the declared required arguments (got: '$(field goodRequired)')"
expect_contains "the generated usage does not describe the declared argument" goodUsage "What to do"
expect_contains "the dry run did not report the script it read" goodScript "targets/good/dryrungood/dryrungood.js"

# The launch with deliberately invalid arguments. This is the gate a real slash
# command passes before a run exists, so a rejection here is proof that
# registration and usage generation both work, with no model involved.
[ "$(flag goodRejected)" = "true" ] ||
  fail_with "deliberately invalid arguments were accepted by a command that declares a required argument"
expect_contains "the rejection did not carry the generated usage" goodRejection "Usage: /dryrungood <task>"

# A command that declares no schema genuinely accepts anything. That is reported,
# not treated as a failure: it is a fact about the scaffold, not an error in it.
[ "$(flag anyargsOk)" = "true" ] ||
  fail_with "a schema-less workflow was refused by the dry run (got: '$(field anyargsSignature)')"
[ "$(flag anyargsRejected)" = "false" ] ||
  fail_with "a workflow with no argsSchema was reported as rejecting invalid arguments"
[ "$(field anyargsSignature)" = "Usage: /dryrunanyargs" ] ||
  fail_with "the dry run did not generate a signature without a schema (got: '$(field anyargsSignature)')"

# ------------------------------------- every way a scaffold would fail to register
expect_contains "a command.json that is not JSON was accepted" badjson "Invalid workflow command JSON"
expect_contains "a command.json with no name was accepted" noname "requires a name matching"
expect_contains "a command.json naming a missing script was accepted" noscript "script not found"
expect_contains "a directory with no command.json was accepted" absent "does not exist"
# The two script failures are the launch-time guards, run without launching.
expect_contains "a script that redeclares stage was accepted" collide "would not load"
expect_contains "a script that redeclares stage was not explained" collide "provided by the loom stage library"
expect_contains "a script that does not parse was accepted" syntax "would not load"
# A shadowed command registers and can still never run, so it is a failure.
expect_contains "a name already claimed by an installed root was accepted" shadow "already provided by project scope"
expect_contains "a shadowed command was not explained" shadow "never run"

# ------------------------------------------------------------- the path contract
expect_contains "a relative escape out of the project was accepted" escape "must stay inside the project"
expect_contains "an absolute path was accepted" absolute "must stay inside the project"
expect_contains "dryRun accepted input without a directory" shape "requires only a directory string"

echo "dry-run: dryRun reached the vm sandbox, registered a valid workflow directory and generated its usage, refused deliberately invalid arguments with that usage, reported a schema-less command honestly, and failed a scaffold that would not register for each of six reasons -- all with no model and no run"
