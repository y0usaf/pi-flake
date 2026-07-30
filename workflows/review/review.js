// review workflow for pi-workflows: two independent reviewers, one merge,
// optional fix pass gated by a checkpoint.
//
// Why two contexts instead of one: a single agent asked for "everything wrong"
// anchors on the first defect it finds. One context looks only for behaviour
// that is wrong, the other only for what the change makes risky to operate;
// neither sees the other's list until the merge, so they cannot converge early.
//
// Stops at:
//   1. an empty diff (nothing to review),
//   2. the merged findings, when mode is "review only",
//   3. a rejected fix checkpoint,
//   4. the fix report.
//
// Launch args (a bare scope string, or JSON):
//   scope?: string  "working tree" | "staged" | "last commit" | "vs main" |
//                   any git revision range, default "working tree"
//   mode?: string   "review only" (default) | "offer fixes"

const raw = args == null ? {} : typeof args === "string" ? { scope: args } : args;
if (typeof raw !== "object" || Array.isArray(raw) || raw === null) {
  throw new Error('review expects a scope string or { "scope": "...", "mode"?: "offer fixes" }');
}

const SCOPES = {
  "working tree": "git diff",
  staged: "git diff --cached",
  "last commit": "git diff HEAD~1..HEAD",
  "vs main": "git diff main...HEAD",
};

const scope = (typeof raw.scope === "string" && raw.scope.trim()) || "working tree";
const diffCommand = SCOPES[scope] ?? "git diff " + scope;
const offerFixes = typeof raw.mode === "string" && raw.mode.trim().toLowerCase().startsWith("offer");

const DIFF_BUDGET = 30000;
const clip = (text, max) => {
  const value = typeof text === "string" ? text : "";
  return value.length > max ? value.slice(0, max - 1) + "\u2026" : value;
};

const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      description: "One entry per real problem; an empty array is a valid answer",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["blocking", "should-fix", "nit"] },
          where: { type: "string", description: "file:line or file, from the diff" },
          problem: { type: "string", description: "What is wrong, stated as cause and consequence" },
          fix: { type: "string", description: "The smallest change that removes the problem" },
        },
        required: ["severity", "where", "problem", "fix"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
};

await phase("collect");
const diffResult = await shell(diffCommand);
if (diffResult.exitCode !== 0) {
  throw new Error("`" + diffCommand + "` exited " + String(diffResult.exitCode) + ": " + clip(diffResult.stderr, 500));
}
const diff = diffResult.stdout.trim();
if (!diff) {
  return "Nothing to review: `" + diffCommand + "` produced an empty diff.";
}
const diffText = clip(diff, DIFF_BUDGET);
const truncated = diff.length > DIFF_BUDGET ? "\n\n(diff truncated at " + String(DIFF_BUDGET) + " characters; read the files for the rest)" : "";

await phase("review");
const reviews = await parallel("review", {
  correctness: () =>
    agent(
      prompt(
        [
          "Review this diff for behaviour that is wrong: logic errors, wrong conditions, unhandled",
          "cases, broken invariants, misuse of an API. Read the surrounding files before judging;",
          "the diff alone hides context. Do not comment on style, naming, or formatting.",
          "",
          "Command: {diffCommand}",
          "",
          "{diffText}{truncated}",
        ].join("\n"),
        { diffCommand, diffText, truncated },
      ),
      { label: "correctness", outputSchema: FINDINGS_SCHEMA },
    ),
  risk: () =>
    agent(
      prompt(
        [
          "Review this diff for what it makes risky to run: silent failure paths, data loss,",
          "irreversible operations, missing verification, unbounded resource use, secrets or",
          "credentials, and behaviour that changes for existing callers. Do not restate logic bugs.",
          "",
          "Command: {diffCommand}",
          "",
          "{diffText}{truncated}",
        ].join("\n"),
        { diffCommand, diffText, truncated },
      ),
      { label: "risk", outputSchema: FINDINGS_SCHEMA },
    ),
});

const rendered = (label, findings) =>
  findings.length
    ? [label + ":", ...findings.map((f) => "- [" + f.severity + "] " + f.where + " \u2014 " + f.problem + "\n  fix: " + f.fix)].join("\n")
    : label + ": no findings";

await phase("merge");
const merged = await agent(
  prompt(
    [
      "Merge two independent reviews of the same diff into one ranked list.",
      "Drop duplicates, drop anything the diff does not actually show, and keep severities honest:",
      "blocking means it is wrong or unsafe as written, not that you would have done it differently.",
      "",
      "{correctness}",
      "",
      "{risk}",
      "",
      "Command: {diffCommand}",
      "",
      "{diffText}{truncated}",
    ].join("\n"),
    {
      correctness: rendered("Correctness review", reviews.correctness.findings),
      risk: rendered("Risk review", reviews.risk.findings),
      diffCommand,
      diffText,
      truncated,
    },
  ),
  { label: "merge", outputSchema: FINDINGS_SCHEMA },
);

const report = merged.findings.length
  ? merged.findings.map((f) => "[" + f.severity + "] " + f.where + "\n  " + f.problem + "\n  fix: " + f.fix).join("\n\n")
  : "No findings: both reviewers came back clean on `" + diffCommand + "`.";

const blocking = merged.findings.filter((f) => f.severity === "blocking");
if (!offerFixes || !blocking.length) {
  return ["Review of `" + diffCommand + "`", "", report, offerFixes && !blocking.length ? "\nNothing blocking, so no fix pass ran." : ""].join("\n");
}

const fixApproved = await checkpoint({
  name: "fix",
  prompt: clip("Apply fixes for " + String(blocking.length) + " blocking finding(s)?\n\n" + blocking.map((f) => "- " + f.where + ": " + f.problem).join("\n"), 1000),
  context: { blocking: blocking.slice(0, 8) },
});
if (fixApproved !== "approved") {
  return ["Review of `" + diffCommand + "` (fixes declined)", "", report].join("\n");
}

await phase("fix");
const fixed = await agent(
  prompt(
    [
      "Fix exactly these blocking findings in the repository. Change nothing else: no drive-by",
      "refactors, no style edits, no new abstractions. If a finding turns out to be wrong, say so",
      "and leave the code alone.",
      "",
      "{blocking}",
    ].join("\n"),
    { blocking: blocking.map((f) => "- " + f.where + ": " + f.problem + "\n  proposed fix: " + f.fix).join("\n") },
  ),
  { label: "fix" },
);

return ["Review of `" + diffCommand + "`", "", report, "", "Fix pass:", typeof fixed === "string" ? fixed : JSON.stringify(fixed)].join("\n");
