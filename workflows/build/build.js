// /build workflow for pi-loom (DESIGN.md P4b-ii).
//
// plan -> exec -> review, chained over ONE git worktree, keyed per plan item.
//
// Every stage comes from the engine's stage library (extensions/pi-loom/src/stages.ts),
// which the engine appends to this script at launch: `stage(...)` needs no import
// and this file owns no prompt of its own. That is the point of the library —
// /build, /quick and every later workflow share one planning prompt and one
// review contract instead of each carrying a private copy that drifts.
//
// Two properties worth knowing before reading the loop:
//
//   1. All exec calls pass the same worktree name, so the engine hands them the
//      same worktree: item 2 sees item 1's code. The engine commits the worktree
//      as each implementing agent returns, and exec reads its diff base *before*
//      launching its agent, so each item still reports only its own diff.
//   2. Nothing here asks a model which files it touched. exec's `files` and
//      `diff` come from git, so an unreported edit still lands in the report and
//      in front of the reviewer.
//
// Launch args (a bare task string, or JSON):
//   task: string (required)
//   context?: string      background handed to every stage
//   maxItems?: 1..20      plan size, default 5
//   maxFixes?: 0..3       repair passes per item after a "changes" verdict, default 1
//   model?: string        plan + exec model; defaults to the session model
//   reviewModel?: string  review model; defaults to model

const raw = args == null ? {} : typeof args === "string" ? { task: args } : args;
if (typeof raw !== "object" || Array.isArray(raw) || raw === null) {
  throw new Error('build expects a task string or { "task": "<what to build>" }');
}

const task = typeof raw.task === "string" ? raw.task.trim() : "";
if (!task) throw new Error('build requires a task: /build "<what to build>"');

const context = typeof raw.context === "string" ? raw.context : "";
const maxItems = Number.isInteger(raw.maxItems) ? Math.min(Math.max(raw.maxItems, 1), 20) : 5;
const maxFixes = Number.isInteger(raw.maxFixes) ? Math.min(Math.max(raw.maxFixes, 0), 3) : 1;
// Empty string means "not given": the stage library omits an empty model rather
// than validating "" as a model name, so the session default survives.
const model = typeof raw.model === "string" ? raw.model : "";
const reviewModel = typeof raw.reviewModel === "string" && raw.reviewModel ? raw.reviewModel : model;

// One worktree for the whole run: the exec stage keys worktrees by name.
const WORKTREE = "build";
// exec already caps its own diff at 200000 characters. This second, much smaller
// cap applies to the returned report, which is echoed into the session and
// written whole to the run's result artifact. Full diffs stay reachable: the
// report names the engine-owned branch every item was committed on.
const REPORT_DIFF_LIMIT = 20000;

function clipDiff(diff) {
  const text = typeof diff === "string" ? diff : "";
  if (text.length <= REPORT_DIFF_LIMIT) return text;
  return text.slice(0, REPORT_DIFF_LIMIT) + "\n... diff truncated by /build; read the full diff on the run branch ...\n";
}

// What the reviewer is shown. The full (exec-capped) diff goes in deliberately:
// a review of a summary is a review of a claim, not of a change.
function reviewSubject(result) {
  return JSON.stringify(
    {
      summary: result.summary,
      notes: result.notes,
      files: result.files,
      diff: result.diff,
      diffTruncated: result.diffTruncated,
    },
    null,
    2,
  );
}

await phase("plan");
const planned = await stage("plan", { task: task, context: context, maxItems: maxItems, model: model, label: "plan" });

const planItems = Array.isArray(planned.items) ? planned.items : [];
if (planItems.length === 0) {
  return { task: task, plan: { summary: planned.summary, items: [] }, items: [], verdicts: {}, counts: { total: 0, approve: 0, changes: 0, reject: 0 }, note: "The plan stage returned no items; nothing was implemented." };
}

const results = [];
const verdicts = {};
const counts = { total: 0, approve: 0, changes: 0, reject: 0 };
let branch = "";
let worktreePath = "";

for (const item of planItems) {
  const id = typeof item.id === "string" && item.id ? item.id : "item-" + String(results.length + 1);
  const itemText = JSON.stringify(item, null, 2);
  await phase("item-" + id);
  await log("build: implementing " + id);

  let exec = await stage("exec", { item: itemText, context: context, worktree: WORKTREE, model: model, label: "exec:" + id });
  let review = await stage("review", { item: itemText, result: reviewSubject(exec), model: reviewModel, label: "review:" + id });

  const files = [];
  const diffs = [];
  const passes = [];
  let attempts = 0;

  // A "changes" verdict is the one verdict a repair pass can act on: the review
  // note says precisely what to change, so it is handed to the next exec as
  // context. "reject" means the approach is wrong, which another blind pass
  // would only entrench, so it stops the item and leaves the verdict standing.
  for (;;) {
    attempts += 1;
    branch = exec.branch || branch;
    worktreePath = exec.path || worktreePath;
    for (const file of exec.files || []) if (!files.includes(file)) files.push(file);
    diffs.push(exec.diff || "");
    passes.push({ attempt: attempts, summary: exec.summary, notes: exec.notes, files: exec.files || [], diffTruncated: exec.diffTruncated === true, verdict: review.verdict, note: review.note });
    if (review.verdict !== "changes" || attempts > maxFixes) break;

    await log("build: " + id + " needs changes; repair pass " + String(attempts));
    const fixContext = [context, "A reviewer asked for changes to your previous pass. Address exactly this:", review.note].filter(Boolean).join("\n\n");
    exec = await stage("exec", { item: itemText, context: fixContext, worktree: WORKTREE, model: model, label: "fix:" + id + ":" + String(attempts) });
    review = await stage("review", { item: itemText, result: reviewSubject(exec), model: reviewModel, label: "review:" + id + ":" + String(attempts + 1) });
  }

  const diff = diffs.join("\n");
  verdicts[id] = review.verdict;
  counts.total += 1;
  if (review.verdict === "approve") counts.approve += 1;
  else if (review.verdict === "changes") counts.changes += 1;
  else counts.reject += 1;

  results.push({
    id: id,
    title: item.title || "",
    verdict: review.verdict,
    note: review.note,
    summary: exec.summary,
    notes: exec.notes,
    files: files,
    diff: clipDiff(diff),
    diffChars: diff.length,
    diffTruncated: diff.length > REPORT_DIFF_LIMIT || passes.some((pass) => pass.diffTruncated === true),
    attempts: attempts,
    passes: passes,
  });
}

return {
  task: task,
  plan: { summary: planned.summary, items: planItems },
  worktree: { name: WORKTREE, branch: branch, path: worktreePath },
  items: results,
  verdicts: verdicts,
  counts: counts,
};
