// pie workflow for pi-workflows: plan -> implement -> evaluate.
//
// Three responsibilities, three fresh contexts, so no agent grades its own
// homework: the planner never edits, the implementer never decides what the
// job was, the evaluator never sees the implementer's reasoning — only the
// repo, the plan, and the gate output.
//
// Stops at:
//   1. the evaluator passing with the gate green,
//   2. a rejected checkpoint (plan rejected, or a retry declined),
//   3. the attempt cap (args.maxAttempts, default 2, hard max 3).
//
// Launch args (a bare task string, or JSON):
//   task?: string          what to build (required unless sessionContext exists)
//   sessionContext?: string session transcript, injected by the slash command
//   gate?: string          shell command that must exit 0, or "none"
//   maxAttempts?: number   implement/evaluate attempts, default 2, max 3

const raw = args == null ? {} : typeof args === "string" ? { task: args } : args;
if (typeof raw !== "object" || Array.isArray(raw) || raw === null) {
  throw new Error('pie expects a task string or { "task": "...", "gate"?: "...", "maxAttempts"?: number }');
}

const task = typeof raw.task === "string" ? raw.task.trim() : "";
const sessionContext = typeof raw.sessionContext === "string" ? raw.sessionContext.trim() : "";
if (!task && !sessionContext) {
  throw new Error("pie needs a task: /pie <what to build>, or run it from a session that already discussed one");
}

const gateRaw = typeof raw.gate === "string" ? raw.gate.trim() : "";
const gate = gateRaw && gateRaw.toLowerCase() !== "none" ? gateRaw : "";

const attemptsParsed = Number(raw.maxAttempts);
const maxAttempts = Number.isFinite(attemptsParsed) && attemptsParsed > 0 ? Math.min(Math.floor(attemptsParsed), 3) : 2;

const clip = (text, max) => {
  const value = typeof text === "string" ? text : JSON.stringify(text ?? null);
  return value.length > max ? value.slice(0, max - 1) + "\u2026" : value;
};
const tail = (text, max) => {
  const value = typeof text === "string" ? text : "";
  return value.length > max ? "\u2026" + value.slice(value.length - max + 1) : value;
};

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    goal: { type: "string", description: "One sentence naming what will be true when this is done" },
    steps: {
      type: "array",
      description: "Ordered implementation steps, each a single bounded change",
      items: { type: "string" },
    },
    checks: {
      type: "array",
      description: "How each part of the goal can be verified after implementation, command-level where possible",
      items: { type: "string" },
    },
    rejected: { type: "string", description: "The smaller approach considered and why it was not enough" },
  },
  required: ["goal", "steps", "checks", "rejected"],
  additionalProperties: false,
};

const IMPLEMENT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "What was changed, in the order it was changed" },
    filesTouched: { type: "array", items: { type: "string" } },
    deviations: { type: "string", description: "Where the plan was wrong and what was done instead, or empty" },
    unfinished: { type: "array", description: "Plan steps not completed", items: { type: "string" } },
  },
  required: ["summary", "filesTouched", "deviations", "unfinished"],
  additionalProperties: false,
};

const EVALUATE_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    evidence: { type: "string", description: "What was inspected or run, and what it showed" },
    gaps: {
      type: "array",
      description: "Specific defects or missing pieces, empty when the verdict is pass",
      items: { type: "string" },
    },
  },
  required: ["verdict", "evidence", "gaps"],
  additionalProperties: false,
};

const brief = [
  task ? "Task: " + task : "Task: derive it from the session context below.",
  gate ? "Verification gate: " + gate : "Verification gate: none was given.",
  sessionContext ? "\nSession context (what the human was already discussing):\n" + sessionContext : "",
]
  .filter(Boolean)
  .join("\n");

await phase("plan");
const plan = await agent(
  prompt(
    [
      "You are planning a change to this repository. Do not edit any file.",
      "Read what you need first, then produce the smallest plan that achieves the task.",
      "",
      "{brief}",
      "",
      "Rules:",
      "- Each step is one bounded change a single agent can finish and verify.",
      "- Name the smaller approach you rejected and why; a plan with nothing rejected was not thought about.",
      "- Checks must be commands where a command exists, not 'review the code'.",
    ].join("\n"),
    { brief },
  ),
  { label: "plan", outputSchema: PLAN_SCHEMA },
);

const planText = [
  "Goal: " + plan.goal,
  "",
  "Steps:",
  ...plan.steps.map((step, index) => String(index + 1) + ". " + step),
  "",
  "Checks:",
  ...plan.checks.map((check) => "- " + check),
  "",
  "Rejected: " + plan.rejected,
].join("\n");

const planApproved = await checkpoint({
  name: "plan",
  prompt: clip("Approve this plan before anything is implemented?\n\n" + planText, 1000),
  context: { goal: plan.goal, steps: plan.steps.slice(0, 12) },
});
if (planApproved !== "approved") {
  return "Plan rejected; nothing was implemented.\n\n" + planText;
}

const history = [];
let feedback = "";

for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  await phase("implement-" + String(attempt));
  const implementation = await agent(
    prompt(
      [
        "Implement this approved plan in the repository. Make the changes; do not ask for permission.",
        "",
        "{brief}",
        "",
        "Plan:",
        "{planText}",
        "",
        "{feedback}",
        "",
        "Report honestly: unfinished steps stay unfinished in your report, not hidden in prose.",
      ].join("\n"),
      { brief, planText, feedback: feedback ? "Findings from the previous evaluation you must fix:\n" + feedback : "This is the first attempt." },
    ),
    { label: "implement-" + String(attempt), outputSchema: IMPLEMENT_SCHEMA },
  );

  await phase("evaluate-" + String(attempt));
  const gateResult = gate ? await shell(gate) : null;
  const gateReport = gateResult
    ? "Gate `" + gate + "` exited " + String(gateResult.exitCode) + ".\nstdout tail:\n" + tail(gateResult.stdout, 2000) + "\nstderr tail:\n" + tail(gateResult.stderr, 2000)
    : "No gate command was configured; verify by inspection and by any test command you find in the repo.";

  const evaluation = await agent(
    prompt(
      [
        "Evaluate whether the repository now satisfies this task. You did not write this code.",
        "Inspect the actual files and run whatever read-only commands you need. Do not fix anything.",
        "",
        "{brief}",
        "",
        "Plan that was approved:",
        "{planText}",
        "",
        "What the implementer claims it did:",
        "{claim}",
        "",
        "Deterministic gate result:",
        "{gateReport}",
        "",
        "A nonzero gate exit is a fail. A claim you cannot confirm in the files is a fail.",
      ].join("\n"),
      {
        brief,
        planText,
        claim: implementation.summary + (implementation.deviations ? "\nDeviations: " + implementation.deviations : "") + (implementation.unfinished.length ? "\nUnfinished: " + implementation.unfinished.join("; ") : ""),
        gateReport,
      },
    ),
    { label: "evaluate-" + String(attempt), outputSchema: EVALUATE_SCHEMA },
  );

  const gateOk = !gateResult || gateResult.exitCode === 0;
  history.push(
    "attempt " + String(attempt) + ": " + implementation.summary + "\n  files: " + (implementation.filesTouched.join(", ") || "(none reported)") + "\n  verdict: " + evaluation.verdict + (gateResult ? " (gate exit " + String(gateResult.exitCode) + ")" : "") + "\n  evidence: " + evaluation.evidence,
  );

  if (evaluation.verdict === "pass" && gateOk) {
    return ["pie passed on attempt " + String(attempt) + ".", "", planText, "", history.join("\n\n")].join("\n");
  }

  feedback = [...evaluation.gaps.map((gap) => "- " + gap), gateOk ? "" : "- gate `" + gate + "` still fails: " + tail(gateResult.stderr || gateResult.stdout, 800)].filter(Boolean).join("\n");

  if (attempt < maxAttempts) {
    const retry = await checkpoint({
      name: "retry",
      prompt: clip("Attempt " + String(attempt) + " failed evaluation. Retry with these findings?\n\n" + feedback, 1000),
      context: { attempt, gaps: evaluation.gaps.slice(0, 10) },
    });
    if (retry !== "approved") {
      return ["pie stopped after attempt " + String(attempt) + " (retry declined).", "", "Open findings:", feedback, "", history.join("\n\n")].join("\n");
    }
  }
}

return ["pie hit the " + String(maxAttempts) + "-attempt cap without passing evaluation.", "", "Open findings:", feedback, "", history.join("\n\n")].join("\n");
