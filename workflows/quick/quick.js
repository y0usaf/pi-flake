// /quick workflow for pi-loom (DESIGN.md P4c).
//
// One agent. No plan stage, no review stage, no worktree.
//
// This is the counterweight to /build, and the reason it exists is adoption:
// plan -> exec -> review on a typo is ceremony, and ceremony is what makes a
// workflow engine something people route around by week two. /quick is the
// escape hatch that stays inside the engine — still a run, still budgeted,
// still checkpointed, still auditable — while costing exactly one agent.
//
// Two consequences of "no worktree" worth knowing before you use it:
//
//   1. The agent edits your actual checkout. Nothing is isolated and nothing
//      is committed for you; the change is sitting in your working tree when
//      the run returns, exactly as if you had made it.
//   2. The diff is still git's, not the model's. The quick stage snapshots the
//      whole working tree into a throwaway index before and after the agent,
//      so an edit the model forgot to mention is still in the report. Because
//      both snapshots are taken the same way, whatever was already dirty when
//      you launched cancels out instead of being blamed on the agent.
//
// The prompt lives in the engine's stage library (extensions/pi-loom/src/stages.ts),
// which the engine appends to this script at launch: `stage(...)` needs no import
// and this file owns no prompt of its own.
//
// Launch args (a bare task string, or JSON):
//   task: string (required)
//   context?: string   background handed to the agent
//   model?: string     defaults to the session model

const raw = args == null ? {} : typeof args === "string" ? { task: args } : args;
if (typeof raw !== "object" || Array.isArray(raw) || raw === null) {
  throw new Error('quick expects a task string or { "task": "<the small change>" }');
}

const task = typeof raw.task === "string" ? raw.task.trim() : "";
if (!task) throw new Error('quick requires a task: /quick "<the small change>"');

const context = typeof raw.context === "string" ? raw.context : "";
// Empty string means "not given": the stage library omits an empty model rather
// than validating "" as a model name, so the session default survives.
const model = typeof raw.model === "string" ? raw.model : "";

// The quick stage already caps its own diff at 200000 characters. This second,
// much smaller cap applies to the returned report, which is echoed into the
// session. Nothing is lost by clipping it: unlike /build, the change is in the
// working tree, so `git diff` shows the whole thing.
const REPORT_DIFF_LIMIT = 20000;

await phase("quick");
const result = await stage("quick", { task: task, context: context, model: model, label: "quick" });

const diff = typeof result.diff === "string" ? result.diff : "";
const files = Array.isArray(result.files) ? result.files : [];

return {
  task: task,
  summary: result.summary,
  notes: result.notes,
  changed: files.length > 0,
  files: files,
  diff: diff.length <= REPORT_DIFF_LIMIT ? diff : diff.slice(0, REPORT_DIFF_LIMIT) + "\n... diff truncated by /quick; run git diff to read all of it ...\n",
  diffChars: diff.length,
  diffTruncated: diff.length > REPORT_DIFF_LIMIT || result.diffTruncated === true,
  // Dangling tree objects: `git diff <baseTree> <resultTree>` replays exactly
  // what the agent did, until git gc prunes them.
  trees: { base: result.baseTree, result: result.resultTree },
};
