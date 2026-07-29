// /wf-new workflow for pi-loom (DESIGN.md P6b).
//
// The meta-workflow: a workflow that writes workflows. It asks the author three
// questions through human.ask, and every answer becomes one input of
// stage("scaffold", ...):
//
//   question "name"   -> the stage's `name`      -> the command it registers
//   question "scope"  -> the stage's `directory` -> which workflows root it lands in
//   question "shape"  -> the stage's `context`   -> which stages the script uses
//
// One question per scaffold input is the whole design. The interview is not
// decoration in front of a prompt: nothing here is inferred from prose, so a
// run with no answers parks in the `interview` phase and stays parked. That is
// the point — a scaffold written from a guessed name lands in a directory the
// author did not choose, under a command name they have to rename afterwards.
//
// human.ask offers choices, never a text field, so the candidate names are
// derived from the task's own words and the author picks one. If none of them
// fit, cancel and pass the name yourself:
//
//   /wf-new '{"task": "audit flake inputs for staleness", "name": "audit-inputs"}'
//
// which skips the naming question entirely.
//
// The scaffold stage itself lives in the engine's stage library
// (extensions/pi-loom/src/stages.ts), appended to this script at launch: it
// creates the directory, prompts one agent under an authoring contract
// generated from STAGE_LIBRARY, and then reads command.json back off disk and
// throws unless it parses, declares the name that was asked for, and names a
// script that exists beside it.
//
// Launch args (a bare task string, or JSON):
//   task: string (required)
//   name?: string      kebab-case; skips the naming question
//   context?: string   repository background handed to the scaffolding agent
//   model?: string     defaults to the session model

const raw = args == null ? {} : typeof args === "string" ? { task: args } : args;
if (typeof raw !== "object" || Array.isArray(raw) || raw === null) {
  throw new Error('wf-new expects a task string or { "task": "<what the new workflow must do>" }');
}

const task = typeof raw.task === "string" ? raw.task.trim() : "";
if (!task) throw new Error('wf-new requires a task: /wf-new "<what the new workflow must do>"');

const declaredName = typeof raw.name === "string" ? raw.name.trim() : "";
const background = typeof raw.context === "string" ? raw.context.trim() : "";
// Empty string means "not given": the stage library omits an empty model rather
// than validating "" as a model name, so the session default survives.
const model = typeof raw.model === "string" ? raw.model : "";

// human.ask caps its context at 4096 UTF-8 bytes of JSON, so a long task would
// fail the call rather than the schema. Clamp what is quoted back to the human;
// the stage still receives the whole task.
const QUOTED_TASK_LIMIT = 600;
const quotedTask = task.length <= QUOTED_TASK_LIMIT ? task : task.slice(0, QUOTED_TASK_LIMIT) + "...";

// Words that name nothing. Dropping them is what turns "a workflow that audits
// flake inputs" into `audits-flake` instead of `a-workflow`.
const FILLER = [
  "a", "an", "and", "the", "for", "of", "to", "in", "on", "or", "that", "with",
  "into", "from", "this", "it", "its", "new", "every", "all", "workflow", "command",
];

const SLUG = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

// Deterministic on purpose: the same task always offers the same candidates, so
// the interview is reproducible and checks can assert the exact list.
const slugCandidates = text => {
  const words = (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(word => word.length > 1 && FILLER.indexOf(word) === -1);
  const derived = [words.slice(0, 2).join("-"), words.slice(0, 3).join("-"), words.length ? "wf-" + words[0] : ""];
  const offered = [];
  for (const candidate of derived) {
    // A leading digit is legal in a word and illegal in a slug; prefixing is
    // cheaper than dropping an otherwise good name.
    const slug = SLUG.test(candidate) ? candidate : SLUG.test("wf-" + candidate) ? "wf-" + candidate : "";
    if (slug && offered.indexOf(slug) === -1) offered.push(slug);
  }
  // A floor, not a suggestion: human.ask requires at least two choices, and a
  // task made entirely of filler words derives none.
  for (const fallback of ["wf-new-workflow", "custom-workflow"]) {
    if (offered.length >= 2) break;
    if (offered.indexOf(fallback) === -1) offered.push(fallback);
  }
  return offered.slice(0, 12);
};

// Each answer carries the value it maps to, so the mapping is one lookup rather
// than string matching spread through the script.
const SCOPES = [
  { choice: "project (.pi/workflows, committed with the repository)", directory: ".pi/workflows" },
  { choice: "repository workflow set (workflows/, installed by the flake)", directory: "workflows" },
];

const SHAPES = [
  {
    choice: "one agent, no plan and no review",
    guidance: 'Shape: one stage("quick", { task, context, model }) call inside a single phase. No plan, no review, no worktree — the agent edits the user\'s own checkout and the stage reports git\'s diff.',
  },
  {
    choice: "plan, then implement each item, then review each item",
    guidance: 'Shape: stage("plan", ...) once, then for each returned item stage("exec", ...) inside one withWorktree scope and stage("review", ...) on its result, feeding a "changes" verdict back into a repair pass.',
  },
  {
    choice: "plan only, no implementation",
    guidance: 'Shape: a single stage("plan", { task, context, maxItems }) call; return the plan as the artifact and implement nothing.',
  },
  {
    choice: "no stages: the workflow writes its own agent prompts",
    guidance: "Shape: no stage(...) calls. Write agent(promptText, { outputSchema, model }) directly, and declare an outputSchema so the artifact is structured rather than prose.",
  },
];

const answerFrom = (options, answer, kind) => {
  const match = options.find(option => option.choice === answer);
  if (!match) throw new Error("wf-new: " + kind + " answer is not one of the offered choices: " + answer);
  return match;
};

await phase("interview");

// Parking, not guessing: each of these suspends the run until a person answers.
// A cancelled interview leaves the run in `awaiting_input` with the question in
// the journal, and nothing has been written to disk.
const name = declaredName || await human.ask({
  name: "name",
  prompt: "Name the new workflow. It will be launched as /<name>.",
  choices: slugCandidates(task),
  context: { task: quotedTask, note: "Cancel and pass {\"name\": \"...\"} to /wf-new if none of these fit." },
});

const scope = answerFrom(SCOPES, await human.ask({
  name: "scope",
  prompt: "Where should /" + name + " be written?",
  choices: SCOPES.map(option => option.choice),
  context: { name: name, task: quotedTask },
}), "scope");

const shape = answerFrom(SHAPES, await human.ask({
  name: "shape",
  prompt: "What shape should /" + name + " have?",
  choices: SHAPES.map(option => option.choice),
  context: { name: name, task: quotedTask },
}), "shape");

log("interview: name=" + name + "; scope=" + scope.directory + "; shape=" + shape.choice);

// The transcript is the scaffold stage's `context`, so the scaffolding agent
// reads the author's own answers rather than a paraphrase of them.
const contextText = [
  background,
  shape.guidance,
  "Scope: this workflow is being written into " + scope.directory + "/" + name + ".",
].filter(line => line).join("\n\n");

await phase("scaffold");
const result = await stage("scaffold", {
  name: name,
  task: task,
  context: contextText,
  directory: scope.directory,
  model: model,
  label: "scaffold",
});

return {
  name: result.name,
  directory: result.directory,
  script: result.script,
  files: result.files,
  command: result.command,
  summary: result.summary,
  notes: result.notes,
  // The interview, kept in the artifact: which answers produced this scaffold is
  // the first thing anyone asks when the result is wrong.
  interview: {
    name: declaredName ? "declared in launch arguments" : "chosen from derived candidates",
    scope: scope.choice,
    shape: shape.choice,
  },
};
