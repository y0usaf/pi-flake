#!/usr/bin/env bash
# Runtime acceptance for phase P6a of extensions/pi-loom/DESIGN.md: the
# `scaffold` stage, which writes a new workflow's three files and then checks
# them itself.
#
# Two legs, because two different things need proving and they have very
# different costs.
#
#   A. Node, milliseconds, no pi. Imports the built engine's src/stages.ts,
#      concatenates the appended stage library the way the engine does, and
#      drives `stage("scaffold", ...)` with stub agent/shell/prompt globals.
#      That is the only way to observe what the stage does *after* the agent
#      returns without paying for a model, and it is where the ordering claim
#      (validate, then mkdir, then agent, then verify) is actually checked.
#
#      This leg also proves the authoring contract is generated: it must carry
#      exactly one line per STAGE_LIBRARY entry, each naming that stage's own
#      required inputs. A hand-written contract passes today and rots the first
#      time a stage is added, which is the failure this stage exists to avoid.
#
#   B. The real `loom` wrapper, headless. Proves the stage reached the vm
#      sandbox at all -- that an unknown stage name now lists `scaffold`, that
#      the input contract is enforced inside the sandbox, and that a rejected
#      call creates no directory.
#
# Usage: loom-scaffold-stage.sh <path-to-loom-binary> <path-to-pi-loom-package>
# Runs offline with a throwaway HOME; no network, no real API key, no model.
set -euo pipefail

loom="${1:?usage: loom-scaffold-stage.sh <loom-binary> <pi-loom-package>}"
loom_package="${2:?usage: loom-scaffold-stage.sh <loom-binary> <pi-loom-package>}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail_with() {
  echo "scaffold-stage: $1" >&2
  shift
  for file in "$@"; do cat "$file" >&2; done
  exit 1
}

# =========================================================== leg A: the stage
# Node runs extension TypeScript directly (type stripping is default-on from
# 22.18), but only with a literal `.ts` specifier -- hence the explicit path.
cat >"$work/harness.mjs" <<'MJS'
const packageRoot = process.argv[2];
const stages = await import(`${packageRoot}/src/stages.ts`);

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail === undefined ? "" : `: ${detail}`}`);
};

// ------------------------------------------------- the contract is generated
const contract = stages.WORKFLOW_AUTHORING_CONTRACT;
check("the authoring contract is missing", typeof contract === "string" && contract.length > 0);

const stageLines = contract.split("\n").filter((line) => line.startsWith('- stage("'));
check(
  "the authoring contract is not generated from STAGE_LIBRARY",
  stageLines.length === stages.STAGE_LIBRARY.length,
  `${stageLines.length} contract lines for ${stages.STAGE_LIBRARY.length} stages`,
);
for (const definition of stages.STAGE_LIBRARY) {
  const line = stageLines.find((entry) => entry.startsWith(`- stage("${definition.name}"`));
  check(`the contract does not describe the ${definition.name} stage`, line !== undefined);
  if (line === undefined) continue;
  check(
    `the contract does not name ${definition.name}'s required inputs`,
    line.includes(`required: ${definition.required.join(", ")}`),
    line,
  );
}
for (const global of ["agent(", "shell(", "stage(name, input)", "human.ask", "withWorktree(", "args --"]) {
  check("the contract does not name a sandbox global", contract.includes(global), global);
}
check("scaffold is not in the stage library", stages.STAGE_NAMES.includes("scaffold"), stages.STAGE_NAMES.join(", "));

// ------------------------------------------- the appended library, exercised
// Same concatenation the engine performs, evaluated with the sandbox globals
// the host would install. No pi, no vm, no model: this is the stage's own
// decisions and nothing else.
const source = stages.stageLibrarySource();
const AsyncFunction = (async function () {}).constructor;
const build = new AsyncFunction("agent", "shell", "prompt", "withWorktree", `${source}\nreturn { stage: stage };`);

const makeSandbox = (overrides = {}) => {
  const record = { commands: [], agentCalls: 0, promptText: "" };
  const manifest = overrides.manifest === undefined
    ? { name: "wf-new", description: "d", script: "wf-new.js" }
    : overrides.manifest;
  const missing = overrides.missing ?? [];
  const agent = async (text) => {
    record.agentCalls += 1;
    record.promptText = text;
    return { summary: "s", notes: "n" };
  };
  const shell = async (command) => {
    record.commands.push(command);
    if (command.startsWith("test -f ")) {
      const path = command.slice("test -f ".length).split(" ")[0];
      return { exitCode: 0, stdout: missing.includes(path) ? "missing\n" : "present\n", stderr: "" };
    }
    if (command.startsWith("cat ")) {
      return { exitCode: 0, stdout: typeof manifest === "string" ? manifest : JSON.stringify(manifest), stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const prompt = (template, values) => template.replace(/\{(\w+)\}/g, (whole, key) => (key in values ? String(values[key]) : whole));
  return { record, ready: build(agent, shell, prompt, null) };
};

const thrown = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error.message;
  }
};

// Rejection happens before anything else exists: no directory, no agent.
const rejections = [
  [{}, "stage scaffold: name is required"],
  [{ name: "Bad Name", task: "t" }, "must be a lowercase kebab-case slug"],
  [{ name: "ok-name" }, "stage scaffold: task is required"],
  [{ name: "ok-name", task: "t", directory: "../escape" }, "must stay inside the project"],
  [{ name: "ok-name", task: "t", directory: "/etc" }, "must stay inside the project"],
  [{ name: "ok-name", task: "t", directory: "has spaces" }, "must be a relative path"],
];
for (const [input, expected] of rejections) {
  const sandbox = makeSandbox();
  const { stage } = await sandbox.ready;
  const message = await thrown(() => stage("scaffold", input));
  check("bad input was accepted", message !== null, JSON.stringify(input));
  check("a rejection did not explain itself", message !== null && message.includes(expected), `${message} (wanted ${expected})`);
  check("a rejected scaffold still ran a command", sandbox.record.commands.length === 0, sandbox.record.commands.join(" | "));
  check("a rejected scaffold still launched an agent", sandbox.record.agentCalls === 0);
}

// The happy path, and the ordering claim inside it.
{
  const sandbox = makeSandbox();
  const { stage } = await sandbox.ready;
  const result = await stage("scaffold", { name: "wf-new", task: "interview then scaffold" });
  const commands = sandbox.record.commands;
  check("the target directory was not created", commands[0] === "mkdir -p .pi/workflows/wf-new", commands[0]);
  check("the agent never ran", sandbox.record.agentCalls === 1);
  check("the prompt does not carry the authoring contract", sandbox.record.promptText.includes('- stage("scaffold"'));
  check("the prompt leaked an unfilled placeholder", !/\{(directory|name|task|context)\}/.test(sandbox.record.promptText));
  check("the artifact does not report the directory", result.directory === ".pi/workflows/wf-new", result.directory);
  check("the artifact does not report the script from command.json", result.script === "wf-new.js", result.script);
  check("the artifact does not list the three files", Array.isArray(result.files) && result.files.length === 3, JSON.stringify(result.files));
  check("the artifact does not carry the parsed manifest", result.command?.name === "wf-new");
  for (const path of [".pi/workflows/wf-new/command.json", ".pi/workflows/wf-new/wf-new.js", ".pi/workflows/wf-new/README.md"]) {
    check("a written file was never verified", commands.some((command) => command.includes(`test -f ${path} `)), path);
  }
}

// Negative controls: what the engine catches that the model's own summary would not.
const controls = [
  [{ manifest: { name: "other", description: "d", script: "wf-new.js" } }, "declares name"],
  [{ manifest: { name: "wf-new", description: "d" } }, "declares no script"],
  [{ manifest: { name: "wf-new", description: "d", script: "../outside.js" } }, "outside its own directory"],
  [{ manifest: "not json at all" }, "is not valid JSON"],
  [{ missing: [".pi/workflows/wf-new/command.json"] }, "command.json was not written"],
  [{ missing: [".pi/workflows/wf-new/wf-new.js"] }, "wf-new.js was not written"],
  [{ missing: [".pi/workflows/wf-new/README.md"] }, "README.md was not written"],
];
for (const [overrides, expected] of controls) {
  const sandbox = makeSandbox(overrides);
  const { stage } = await sandbox.ready;
  const message = await thrown(() => stage("scaffold", { name: "wf-new", task: "t" }));
  check("an unloadable scaffold was returned as a success", message !== null, JSON.stringify(overrides));
  check("an unloadable scaffold was not explained", message !== null && message.includes(expected), `${message} (wanted ${expected})`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`scaffold-stage: ${failure}`);
  process.exit(1);
}
console.log("scaffold-stage: contract generated from STAGE_LIBRARY, input rejected before mkdir and before the agent, and every unloadable scaffold refused");
MJS

node "$work/harness.mjs" "$loom_package" || fail_with "the scaffold stage's own decisions are wrong (see above)"

# ============================================================ leg B: the sandbox
export HOME="$work/home"
agent_dir="$HOME/.pi/agent"
# Pi's agent dir defaults to $HOME/.pi/agent, which is what the nix sandbox
# gets. Pin it anyway: run this script by hand from a Pi session and the
# inherited PI_CODING_AGENT_DIR would point the user-scope scan at the real
# agent dir.
export PI_CODING_AGENT_DIR="$agent_dir"
project="$work/project"
project_root="$project/.pi/workflows"
mkdir -p "$agent_dir" "$project_root/scaffoldprobe"
cd "$project"

cat >"$project_root/scaffoldprobe/command.json" <<'JSON'
{
  "name": "scaffoldprobe",
  "description": "pi-loom scaffold stage probe.",
  "script": "probe.js"
}
JSON
cat >"$project_root/scaffoldprobe/probe.js" <<'JS'
let unknown = "";
try { await stage("nope", {}); } catch (error) { unknown = error.message; }
let missing = "";
try { await stage("scaffold", {}); } catch (error) { missing = error.message; }
let slug = "";
try { await stage("scaffold", { name: "Bad Name", task: "t" }); } catch (error) { slug = error.message; }
let escape = "";
try { await stage("scaffold", { name: "ok-name", task: "t", directory: "../escape" }); } catch (error) { escape = error.message; }
return { unknown: unknown, missing: missing, slug: slug, escape: escape };
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

probe_out="$work/probe.jsonl"
: >"$probe_out"
{
  printf '{"id":"probe","type":"prompt","message":"/scaffoldprobe"}\n'
  for _ in $(seq 1 180); do
    if grep -q '"customType":"workflow"' "$probe_out"; then break; fi
    sleep 1
  done
} | timeout 300 "$loom" "${loom_args[@]}" >"$probe_out"

# `jq -c` keeps a multi-line message escaped on one line: reading it with
# `head -1` after `jq -r` would silently cut it to its first line.
jq -r 'select(.type == "message_start" and .message.customType == "workflow") | .message.content' \
  "$probe_out" >"$work/probe.txt"
[ -s "$work/probe.txt" ] || fail_with "/scaffoldprobe never completed" "$probe_out"

sed -n 's/^Workflow scaffoldprobe completed: //p' "$work/probe.txt" >"$work/probe.json"
[ -s "$work/probe.json" ] || fail_with "/scaffoldprobe did not complete successfully" "$work/probe.txt"

field() { jq -r ".$1 // \"\"" "$work/probe.json"; }

case "$(field unknown)" in
  *"available stages: plan, exec, review, quick, scaffold"*) ;;
  *) fail_with "an unknown stage name did not list scaffold among the available stages (got: '$(field unknown)')" ;;
esac

case "$(field missing)" in
  *"stage scaffold: name is required"*) ;;
  *) fail_with "the scaffold stage did not reject a missing name (got: '$(field missing)')" ;;
esac

case "$(field slug)" in
  *"must be a lowercase kebab-case slug"*) ;;
  *) fail_with "the scaffold stage accepted a name that is not a slug (got: '$(field slug)')" ;;
esac

case "$(field escape)" in
  *"must stay inside the project"*) ;;
  *) fail_with "the scaffold stage accepted a directory outside the project (got: '$(field escape)')" ;;
esac

# Rejection happens before mkdir, so a refused call leaves nothing behind. This
# is the same claim leg A makes about the stub sandbox, re-made against a real
# filesystem.
[ ! -e "$project_root/ok-name" ] ||
  fail_with "a rejected scaffold created $project_root/ok-name anyway"

echo "scaffold-stage: the scaffold stage reached the sandbox, an unknown name listed it among the available stages, bad input was rejected inside the sandbox, and a rejected call left no directory behind"
