// Stage library (pi-loom DESIGN.md, P4a).
//
// A stage is a reviewed, reusable step of a workflow: it takes an input record,
// runs one agent under a fixed output contract, and returns a typed artifact.
// The point is that `/build`, `/quick` and every later workflow share one
// planning prompt and one review contract instead of each carrying a private
// copy that drifts.
//
// Delivery is unusual and worth reading once. A workflow script runs inside a
// `vm` sandbox with no module loader: no `import`, no `require`, no filesystem.
// So a shared library cannot be something a script imports; it can only arrive
// as source. The engine appends this source to every workflow body, and every
// binding in it is a *function declaration*:
//
//   - Function declarations hoist to the top of the enclosing function scope,
//     so `stage("plan", ...)` is callable from the script's first line even
//     though the definition sits after the author's `return`. A `const` here
//     would be in its temporal dead zone for the whole run and throw.
//   - Appending (rather than prepending) keeps the author's byte offsets
//     unchanged. `instrumentWorkflow` turns each `agent(...)` call's start/end
//     offsets into that agent's call-site identity, which retry and resume
//     match on, so a library edit must not renumber user code.
//
// The library is engine code, not user code: it is reviewed here and at build
// time, and it is deliberately not re-validated against the caller's model and
// role capabilities at launch. That is why no stage hardcodes a model or a
// role — both are passed in by the caller, whose script *is* preflighted.
//
// One stage is not just a prompt: `exec` writes code inside an isolated git
// worktree and reports the diff **git** recorded, never the diff the model says
// it made. An agent that forgets to mention an edit cannot hide it, because the
// artifact is assembled from `git diff` against the commit the worktree sat on
// before the agent started.
//
// Its sibling `quick` makes the opposite trade deliberately: one agent, no plan,
// no review and **no worktree**, so a one-line change lands where the user is
// already looking. It still assembles its artifact from git, by snapshotting the
// working tree into a throwaway index before and after the agent.
import type { JsonSchema } from "./types.js";

/** The single global a workflow script calls. Reserved: a script may not declare it. */
export const STAGE_ENTRY_POINT = "stage";
/** Internal helpers in the appended source share this prefix; also reserved. */
export const STAGE_INTERNAL_PREFIX = "__stage";

export interface StageDefinition {
  name: string;
  description: string;
  required: readonly string[];
  optional: readonly string[];
  /**
   * Shape this stage's agent must return. A stage may add engine-derived fields
   * on top of it -- `exec` appends git's own view of the change -- but never
   * returns fewer than these.
   */
  output: JsonSchema;
}

const PLAN_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One sentence naming the change as a whole" },
    items: {
      type: "array",
      minItems: 1,
      description: "Independently implementable, independently reviewable units of work",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Short kebab-case slug, unique within the plan" },
          title: { type: "string", description: "Imperative one-line summary" },
          detail: { type: "string", description: "What to change, and how to tell it worked" },
          files: { type: "array", items: { type: "string" }, description: "Paths the item is expected to touch" },
        },
        required: ["id", "title", "detail"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "items"],
  additionalProperties: false,
};

// What an implementing agent must return, and deliberately all of it: neither
// `exec` nor `quick` asks the model which files it touched, because git already
// knows and cannot be argued with. files/diff and the tree or branch identifiers
// are added by the stage. Both stages share this contract on purpose, so a caller
// can swap one for the other without changing how it reads the artifact.
const EXEC_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string", description: "What was implemented, in one or two sentences" },
    notes: { type: "string", description: "What a reviewer must know: assumptions, skipped work, checks that failed. May be empty" },
  },
  required: ["summary", "notes"],
  additionalProperties: false,
};

// Same vocabulary as HUMAN_REVIEW_VERDICTS on purpose: a workflow can switch on
// `.verdict` without knowing whether a model or a person produced it, which is
// what lets /build fall back to human.review for the same decision.
const REVIEW_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "changes", "reject"], description: "approve = done, changes = nearly done, reject = wrong or not done" },
    note: { type: "string", description: "Why; for changes/reject this is the only channel that says what to fix" },
  },
  required: ["verdict", "note"],
  additionalProperties: false,
};

// A scaffold's real artifact is files on disk, so the model is asked only for
// prose. Everything the engine can check itself -- which files exist, what
// command.json declares -- is read back from disk after the agent returns and
// added to the artifact there, never taken on the model's word. Same principle
// as exec reporting git's diff instead of the model's summary of it.
const SCAFFOLD_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string", description: "What the new workflow does, in one or two sentences" },
    notes: { type: "string", description: "What its author must know: arguments left out, stages chosen, anything unverified. May be empty" },
  },
  required: ["summary", "notes"],
  additionalProperties: false,
};

/** Every stage the appended source defines. Order is the order `stage()` reports. */
export const STAGE_LIBRARY: readonly StageDefinition[] = Object.freeze([
  Object.freeze({
    name: "plan",
    description: "Turn a task into a numbered plan whose items can be implemented and reviewed one at a time.",
    required: ["task"],
    optional: ["context", "maxItems", "model", "role", "label"],
    output: PLAN_OUTPUT,
  }),
  Object.freeze({
    name: "exec",
    description: "Implement one plan item inside an isolated git worktree and return the diff git recorded.",
    required: ["item"],
    optional: ["context", "worktree", "model", "role", "label"],
    output: EXEC_OUTPUT,
  }),
  Object.freeze({
    name: "review",
    description: "Judge one plan item's result and return a fixed verdict plus a note.",
    required: ["item", "result"],
    optional: ["criteria", "model", "role", "label"],
    output: REVIEW_OUTPUT,
  }),
  Object.freeze({
    name: "quick",
    description: "Make one small, self-contained change directly in the project working tree with a single agent -- no plan, no review, no worktree.",
    required: ["task"],
    optional: ["context", "model", "role", "label"],
    output: EXEC_OUTPUT,
  }),
  Object.freeze({
    name: "scaffold",
    description: "Write a new workflow -- command.json, script and README -- into a workflows root, then verify the manifest parses and names a script that exists.",
    required: ["name", "task"],
    optional: ["context", "directory", "model", "role", "label"],
    output: SCAFFOLD_OUTPUT,
  }),
]) as readonly StageDefinition[];

export const STAGE_NAMES: readonly string[] = Object.freeze(STAGE_LIBRARY.map((stage) => stage.name));

// Built once: the names appear in three error messages inside the sandbox, and
// a stale hand-written list is exactly the drift this module exists to remove.
const STAGE_NAME_LIST = STAGE_NAMES.join(", ");

// The sandbox surface, in the order a workflow author meets it. This is the one
// hand-maintained half of the authoring contract, because these globals are
// installed by the host (src/execution.ts) and this module cannot enumerate
// them. The stage half below is generated.
const SANDBOX_GLOBALS: readonly string[] = Object.freeze([
  "args -- the launch arguments, already validated against command.json's argsSchema",
  "phase(name) -- declare the phase the run is entering; it shows up in state.json",
  "agent(promptText, { outputSchema, model, role, label }) -- run one sub-agent and get its structured answer",
  "prompt(template, values) -- fill {placeholder} slots in a template string",
  "shell(command, { timeoutMs }) -- run a command; returns { exitCode, stdout, stderr }",
  "stage(name, input) -- run a reviewed, shared step; the list follows",
  "dryRun({ directory }) -- load a workflow directory the way Pi registers slash commands, without running it; returns { name, signature, usage, requiredArgs, rejectedInvalidArguments, rejection } and throws with the reason when it would not register",
  "human.ask / human.edit / human.review -- park the run until a person answers",
  "checkpoint(name, value) -- record a resumable point",
  "parallel(tasks) / pipeline(steps) -- fan out, or chain",
  "withWorktree(name, fn) -- run fn inside an isolated git worktree",
  "log(...) -- write to the run journal",
]);

// One line per stage, built from the definitions above rather than written out.
const AUTHORING_CONTRACT_STAGE_LINES: readonly string[] = Object.freeze(
  STAGE_LIBRARY.map((stage) => {
    const properties = stage.output.properties as Record<string, unknown> | undefined;
    const returns = properties && typeof properties === "object" ? Object.keys(properties) : [];
    const required = stage.required.length ? stage.required.join(", ") : "(none)";
    const optional = stage.optional.length ? stage.optional.join(", ") : "(none)";
    return `- stage("${stage.name}", { ... }) -- ${stage.description} required: ${required}; optional: ${optional}; returns: ${returns.join(", ") || "(nothing)"}`;
  }),
);

/**
 * What a workflow script may call, as text an agent can be handed.
 *
 * Generated, not written: the one thing a scaffolding prompt must never do is
 * describe a stage library that no longer exists. Adding a stage to
 * STAGE_LIBRARY changes this string and no prose anywhere needs editing;
 * `checks.pi-loom-scaffold-stage` asserts the generated line count still
 * matches STAGE_LIBRARY, so a hand-written replacement would fail.
 */
export const WORKFLOW_AUTHORING_CONTRACT: string = [
  "Globals already in scope. There is no module loader in the sandbox: no import, no require, no fs.",
  ...SANDBOX_GLOBALS.map((entry) => `- ${entry}`),
  "",
  "Stages available through stage(name, input):",
  ...AUTHORING_CONTRACT_STAGE_LINES,
].join("\n");

const STAGE_LIBRARY_SOURCE = `
// ---------------------------------------------------------------------------
// pi-loom stage library. Appended by the engine (src/stages.ts); not authored
// by this workflow. Function declarations only: they hoist, so the script above
// can call stage(...) before this point in the source.
// ---------------------------------------------------------------------------
async function stage(name, input) {
  if (typeof name !== "string" || !name.trim()) throw new Error("stage(name, input) requires a stage name; available stages: ${STAGE_NAME_LIST}");
  var given = input === undefined || input === null ? {} : input;
  if (typeof given !== "object" || Array.isArray(given)) throw new Error("stage " + name + ": input must be an object");
  if (name === "plan") return await __stagePlan(given);
  if (name === "exec") return await __stageExec(given);
  if (name === "review") return await __stageReview(given);
  if (name === "quick") return await __stageQuick(given);
  if (name === "scaffold") return await __stageScaffold(given);
  throw new Error("Unknown stage: " + name + "; available stages: ${STAGE_NAME_LIST}");
}
function __stageText(input, stageName, key, required) {
  var value = input[key];
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error("stage " + stageName + ": " + key + " is required");
    return "";
  }
  if (typeof value === "string") return value;
  if (required || typeof value === "object") return JSON.stringify(value, null, 2);
  throw new Error("stage " + stageName + ": " + key + " must be a string");
}
// Model and role are caller-supplied and omitted when absent: an option that is
// present but empty would be validated as a real model name and fail the launch.
function __stageAgentOptions(input, stageName, outputSchema) {
  var options = { outputSchema: outputSchema };
  var label = __stageText(input, stageName, "label", false);
  options.label = label ? label : stageName;
  var model = __stageText(input, stageName, "model", false);
  if (model) options.model = model;
  var role = __stageText(input, stageName, "role", false);
  if (role) options.role = role;
  return options;
}
async function __stagePlan(input) {
  var task = __stageText(input, "plan", "task", true);
  var context = __stageText(input, "plan", "context", false);
  var maxItems = input.maxItems === undefined ? 8 : input.maxItems;
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 20) throw new Error("stage plan: maxItems must be an integer between 1 and 20");
  var template = [
    "You are planning a code change. Produce a plan; implement nothing.",
    "",
    "Task:",
    "{task}",
    "",
    "Repository context (may be empty):",
    "{context}",
    "",
    "Rules:",
    "- At most {maxItems} items, ordered so each one can land on its own.",
    "- Each item must be independently implementable and independently reviewable.",
    "- id is a short kebab-case slug, unique within the plan.",
    "- detail says what to change and how to tell it worked.",
    "- Read whatever you need, but edit no files.",
  ].join("\\n");
  return await agent(prompt(template, { task: task, context: context, maxItems: maxItems }), __stageAgentOptions(input, "plan", ${JSON.stringify(PLAN_OUTPUT)}));
}
// Diff text is capped in characters: a runaway diff would otherwise bury the
// review prompt that consumes it, and a truly enormous one would breach the
// engine's 10 MB RPC boundary before this code ever sees it. Truncation is
// reported so a caller can tell a small change from a clipped one.
function __stageDiffLimit() { return 200000; }
// The one command runner every stage uses. Non-zero exit is a stage failure, not
// a value to inspect: a stage that silently continued past a failed git or a
// failed mkdir would report an artifact it never produced.
async function __stageShell(stageName, command) {
  var result = await shell(command, { timeoutMs: 120000 });
  if (result.exitCode !== 0) throw new Error("stage " + stageName + ": " + command + " failed (exit " + result.exitCode + "): " + (result.stderr || result.stdout || "no output"));
  return result.stdout;
}
async function __stageExec(input) {
  var item = __stageText(input, "exec", "item", true);
  var context = __stageText(input, "exec", "context", false);
  var worktreeName = __stageText(input, "exec", "worktree", false) || "exec";
  var options = __stageAgentOptions(input, "exec", ${JSON.stringify(EXEC_OUTPUT)});
  var template = [
    "You are implementing one item of a plan inside an isolated git worktree.",
    "",
    "Item:",
    "{item}",
    "",
    "Repository context (may be empty):",
    "{context}",
    "",
    "Rules:",
    "- Your working directory is a scratch worktree of this repository. Edit files there.",
    "- Implement this item and nothing else; leave unrelated code alone.",
    "- Verify the way the item says to; if it says nothing, use the repository's own checks.",
    "- Never run git commit, git push or git checkout: the engine snapshots the worktree for you.",
    "- summary says what you implemented; notes says what a reviewer must know, including what you could not do.",
    "- The diff a reviewer reads is taken from git, not from your summary, so an unreported edit still shows up.",
  ].join("\\n");
  return await withWorktree(worktreeName, async function (tree) {
    // Base commit first, before the agent exists. Everything the agent does lands
    // after it, so several exec calls sharing one worktree still each report only
    // their own item's diff.
    var base = (await __stageShell("exec", "git rev-parse HEAD")).trim();
    if (!/^[0-9a-f]{7,64}$/.test(base)) throw new Error("stage exec: the worktree has no base commit to diff against");
    var result = await agent(prompt(template, { item: item, context: context }), options);
    // The engine commits the worktree as the agent returns; "git add -A" picks
    // up anything left unstaged so that new files appear in the diff too.
    await __stageShell("exec", "git add -A");
    var names = (await __stageShell("exec", "git diff --name-only " + base + " --")).split("\\n");
    var files = [];
    for (var index = 0; index < names.length; index += 1) if (names[index]) files.push(names[index]);
    var full = await __stageShell("exec", "git diff --no-color " + base + " --");
    var truncated = full.length > __stageDiffLimit();
    return {
      summary: result.summary,
      notes: result.notes,
      files: files,
      diff: truncated ? full.slice(0, __stageDiffLimit()) + "\\n... diff truncated by the exec stage ..." : full,
      diffTruncated: truncated,
      branch: tree.branch,
      path: tree.path,
    };
  });
}
async function __stageReview(input) {
  var item = __stageText(input, "review", "item", true);
  var result = __stageText(input, "review", "result", true);
  var criteria = __stageText(input, "review", "criteria", false);
  var template = [
    "You are reviewing one item of a plan that another agent implemented.",
    "",
    "Plan item:",
    "{item}",
    "",
    "What the implementer produced:",
    "{result}",
    "",
    "Acceptance criteria (may be empty; fall back to the plan item):",
    "{criteria}",
    "",
    "Verify before judging: read the files the item claims to touch.",
    "Return exactly one verdict:",
    "- approve: the item is done and correct.",
    "- changes: the item is nearly done; the note says precisely what to change.",
    "- reject: the item was not done, or the approach is wrong.",
    "The note is the only channel by which changes and reject explain themselves.",
  ].join("\\n");
  return await agent(prompt(template, { item: item, result: result, criteria: criteria }), __stageAgentOptions(input, "review", ${JSON.stringify(REVIEW_OUTPUT)}));
}
// Snapshots the whole working tree -- tracked edits and new untracked files --
// as a git tree object, through a throwaway index file. The user's own index,
// working tree and refs are never touched; the only trace left behind is
// unreferenced objects in the object database, which git gc prunes.
//
// Two snapshots taken this way are directly diffable, and because both sides are
// captured the same way, whatever was already dirty when /quick launched cancels
// out instead of being attributed to the agent.
function __stageTreeSnapshotCommand() {
  return 'dir="$(mktemp -d)"; GIT_INDEX_FILE="$dir/index" git add -A && GIT_INDEX_FILE="$dir/index" git write-tree; status=$?; rm -rf "$dir"; exit $status';
}
async function __stageQuick(input) {
  var task = __stageText(input, "quick", "task", true);
  var context = __stageText(input, "quick", "context", false);
  var options = __stageAgentOptions(input, "quick", ${JSON.stringify(EXEC_OUTPUT)});
  var template = [
    "You are making one small, self-contained change in this repository.",
    "",
    "Task:",
    "{task}",
    "",
    "Repository context (may be empty):",
    "{context}",
    "",
    "Rules:",
    "- Your working directory is the user's own checkout, not a scratch copy. Change only what the task names.",
    "- No planner precedes you and no reviewer follows you. If the task is too large to finish in one pass, change nothing and say so in notes.",
    "- Verify the way this repository verifies; if you cannot, say so in notes.",
    "- Never run git commit, git push, git checkout or git stash: the change is left in the working tree for the user to inspect.",
    "- summary says what you changed; notes says what the user must know, including anything you skipped.",
    "- The diff the user reads is taken from git, not from your summary, so an unreported edit still shows up.",
  ].join("\\n");
  // Base snapshot first, before the agent exists: everything the agent does lands
  // after it.
  var base = (await __stageShell("quick", __stageTreeSnapshotCommand())).trim();
  if (!/^[0-9a-f]{7,64}$/.test(base)) throw new Error("stage quick: could not snapshot the working tree; is this a git repository?");
  var result = await agent(prompt(template, { task: task, context: context }), options);
  var after = (await __stageShell("quick", __stageTreeSnapshotCommand())).trim();
  var names = (await __stageShell("quick", "git diff --name-only " + base + " " + after + " --")).split("\\n");
  var files = [];
  for (var index = 0; index < names.length; index += 1) if (names[index]) files.push(names[index]);
  var full = await __stageShell("quick", "git diff --no-color " + base + " " + after + " --");
  var truncated = full.length > __stageDiffLimit();
  return {
    summary: result.summary,
    notes: result.notes,
    files: files,
    diff: truncated ? full.slice(0, __stageDiffLimit()) + "\\n... diff truncated by the quick stage ..." : full,
    diffTruncated: truncated,
    baseTree: base,
    resultTree: after,
  };
}
// A scaffold writes into the user's own checkout -- like quick, unlike exec --
// because the new workflow directory *is* the artifact. Hiding it in a scratch
// worktree would mean the user cannot run the thing that was just written.
//
// Nothing the model produced is ever interpolated into a shell command. Both
// paths that reach the shell are validated against an allowlist regex first, so
// no quoting is needed and no quoting bug can exist. RegExp is built from a
// string rather than a literal: this source is a template literal in
// src/stages.ts and a regex literal's slashes and backslashes are a trap there.
function __stageSlugArg(input, stageName, key) {
  var value = __stageText(input, stageName, key, true).trim();
  if (!new RegExp("^[a-z][a-z0-9]*(-[a-z0-9]+)*$").test(value)) throw new Error("stage " + stageName + ": " + key + " must be a lowercase kebab-case slug like wf-new (got: " + value + ")");
  return value;
}
function __stagePathArg(input, stageName, key, fallback) {
  var value = __stageText(input, stageName, key, false).trim() || fallback;
  if (!new RegExp("^[A-Za-z0-9._/-]+$").test(value)) throw new Error("stage " + stageName + ": " + key + " must be a relative path of letters, digits, dot, dash, underscore and slash (got: " + value + ")");
  if (value.charAt(0) === "/" || value.split("/").indexOf("..") !== -1) throw new Error("stage " + stageName + ": " + key + " must stay inside the project (got: " + value + ")");
  return value;
}
async function __stageRequireFile(stageName, path) {
  var probe = await shell("test -f " + path + " && echo present || echo missing", { timeoutMs: 30000 });
  if (probe.stdout.indexOf("present") === -1) throw new Error("stage " + stageName + ": " + path + " was not written");
}
// Generated in src/stages.ts from STAGE_LIBRARY, so this prompt cannot describe
// a stage that no longer exists.
function __stageAuthoringContract() { return ${JSON.stringify(WORKFLOW_AUTHORING_CONTRACT)}; }
function __stageScaffoldRules() {
  return [
    "Rules:",
    "- Reach for stage(...) before writing your own agent(...) prompt: stages are shared and already reviewed.",
    "- Validate args at the top and throw a message naming the command, before any agent runs.",
    "- Never declare a top-level binding named stage, agent, shell, prompt, human, phase, checkpoint, parallel, pipeline, withWorktree, log or args: the launch is refused by name.",
    "- Write those three files and nothing else. Do not run the workflow, and do not commit.",
    "- summary says what the workflow does; notes says what its author must know.",
  ].join("\\n");
}
async function __stageScaffold(input) {
  var name = __stageSlugArg(input, "scaffold", "name");
  var task = __stageText(input, "scaffold", "task", true);
  var context = __stageText(input, "scaffold", "context", false);
  var root = __stagePathArg(input, "scaffold", "directory", ".pi/workflows");
  var directory = root + "/" + name;
  var options = __stageAgentOptions(input, "scaffold", ${JSON.stringify(SCAFFOLD_OUTPUT)});
  var template = [
    "You are writing a new pi-loom workflow. Create exactly three files:",
    "",
    "  {directory}/command.json   the manifest that registers /{name}",
    "  {directory}/<script>.js    the workflow script, named by command.json",
    "  {directory}/README.md      what it does, how to run it, what it returns",
    "",
    "The workflow to write:",
    "  name: {name}",
    "  it must: {task}",
    "",
    "Repository context (may be empty):",
    "{context}",
    "",
    "command.json is a JSON object with: name (exactly {name}), description (one line),",
    "script (the script filename inside this directory), argKey (the property a bare",
    "string argument fills, so /{name} \\"...\\" works) and argsSchema (a JSON Schema object).",
    "The engine generates the command usage from argsSchema and rejects a bad invocation",
    "before a run exists, so declare every argument there instead of parsing prose.",
    "",
    "The script is a module body, not a function: top-level await is allowed and the last",
    "statement returns the artifact. What it may call:",
  ].join("\\n");
  var promptText = [
    prompt(template, { directory: directory, name: name, task: task, context: context }),
    __stageAuthoringContract(),
    __stageScaffoldRules(),
  ].join("\\n\\n");
  // The directory exists before the agent does, so "write into {directory}" is a
  // true statement rather than an instruction the model has to act on first.
  await __stageShell("scaffold", "mkdir -p " + directory);
  var result = await agent(promptText, options);
  // Everything below is the engine checking the model's homework. A scaffold
  // that does not load is worse than no scaffold: the user finds out at the
  // next launch, far from here.
  var manifestPath = directory + "/command.json";
  await __stageRequireFile("scaffold", manifestPath);
  var manifestText = await __stageShell("scaffold", "cat " + manifestPath);
  var manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    throw new Error("stage scaffold: " + manifestPath + " is not valid JSON (" + error.message + "); the workflow would not load");
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("stage scaffold: " + manifestPath + " must be a JSON object");
  if (manifest.name !== name) throw new Error("stage scaffold: " + manifestPath + " declares name " + JSON.stringify(manifest.name) + ", not " + JSON.stringify(name));
  var script = typeof manifest.script === "string" ? manifest.script.trim() : "";
  if (!script) throw new Error("stage scaffold: " + manifestPath + " declares no script");
  if (!new RegExp("^[A-Za-z0-9._-]+$").test(script)) throw new Error("stage scaffold: " + manifestPath + " names a script outside its own directory: " + script);
  var scriptPath = directory + "/" + script;
  var readmePath = directory + "/README.md";
  await __stageRequireFile("scaffold", scriptPath);
  await __stageRequireFile("scaffold", readmePath);
  return {
    summary: result.summary,
    notes: result.notes,
    name: name,
    directory: directory,
    script: script,
    files: [manifestPath, scriptPath, readmePath],
    command: manifest,
  };
}
`;

/** The JavaScript the engine appends to every workflow body. */
export function stageLibrarySource(): string {
  return STAGE_LIBRARY_SOURCE;
}

/**
 * Append the stage library to an authored workflow body.
 *
 * After, never before: prepending would shift every `agent(...)` call-site
 * offset in the author's code, and those offsets are the identities retry and
 * resume match runs against.
 */
export function withStageLibrary(script: string): string {
  return `${script}\n${STAGE_LIBRARY_SOURCE}`;
}
