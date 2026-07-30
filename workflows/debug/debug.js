// debug workflow for pi-workflows: hypothesise, test one at a time in fresh
// contexts, fix only what was confirmed.
//
// The shape exists to kill one failure mode: an agent that has already decided
// what the bug is reads every file as confirmation. Here one context enumerates
// candidate causes without touching the code, and each candidate is then tested
// by an agent that sees exactly one claim, so a refutation costs one context and
// nothing else.
//
// Stops at:
//   1. a confirmed root cause plus (after a checkpoint) a minimal fix,
//   2. every hypothesis refuted — the report says what was ruled out,
//   3. the hypothesis cap (args.maxHypotheses, default 3, hard max 5).
//
// Launch args (a bare symptom string, or JSON):
//   symptom?: string        what is going wrong (required unless sessionContext)
//   sessionContext?: string session transcript, injected by the slash command
//   repro?: string          command whose nonzero exit is the failure
//   maxHypotheses?: number  default 3, max 5

const raw = args == null ? {} : typeof args === "string" ? { symptom: args } : args;
if (typeof raw !== "object" || Array.isArray(raw) || raw === null) {
  throw new Error('debug expects a symptom string or { "symptom": "...", "repro"?: "...", "maxHypotheses"?: number }');
}

const symptom = typeof raw.symptom === "string" ? raw.symptom.trim() : "";
const sessionContext = typeof raw.sessionContext === "string" ? raw.sessionContext.trim() : "";
if (!symptom && !sessionContext) {
  throw new Error("debug needs a symptom: /debug <what is going wrong>");
}
const repro = typeof raw.repro === "string" ? raw.repro.trim() : "";
const capParsed = Number(raw.maxHypotheses);
const maxHypotheses = Number.isFinite(capParsed) && capParsed > 0 ? Math.min(Math.floor(capParsed), 5) : 3;

const clip = (text, max) => {
  const value = typeof text === "string" ? text : "";
  return value.length > max ? value.slice(0, max - 1) + "\u2026" : value;
};
const tail = (text, max) => {
  const value = typeof text === "string" ? text : "";
  return value.length > max ? "\u2026" + value.slice(value.length - max + 1) : value;
};

const HYPOTHESES_SCHEMA = {
  type: "object",
  properties: {
    hypotheses: {
      type: "array",
      description: "Candidate causes, most likely first, each independently testable",
      items: {
        type: "object",
        properties: {
          claim: { type: "string", description: "The cause, stated so that it can be false" },
          test: { type: "string", description: "The cheapest read-only check that would refute it" },
          why: { type: "string", description: "Evidence from the repo that makes it plausible" },
        },
        required: ["claim", "test", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["hypotheses"],
  additionalProperties: false,
};

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["confirmed", "refuted", "inconclusive"] },
    evidence: { type: "string", description: "What was inspected or run, and the exact result" },
    location: { type: "string", description: "file:line of the cause when confirmed, else empty" },
  },
  required: ["status", "evidence", "location"],
  additionalProperties: false,
};

let reproReport = "";
if (repro) {
  await phase("reproduce");
  const first = await shell(repro);
  reproReport = "Repro `" + repro + "` exited " + String(first.exitCode) + ".\nstdout tail:\n" + tail(first.stdout, 1500) + "\nstderr tail:\n" + tail(first.stderr, 1500);
  if (first.exitCode === 0) {
    return "Repro `" + repro + "` exited 0, so the failure did not reproduce. Nothing was investigated.\n\n" + reproReport;
  }
}

const brief = [
  symptom ? "Symptom: " + symptom : "Symptom: derive it from the session context below.",
  repro ? "Repro command: " + repro : "No repro command was given.",
  reproReport ? "\n" + reproReport : "",
  sessionContext ? "\nSession context:\n" + sessionContext : "",
]
  .filter(Boolean)
  .join("\n");

await phase("hypotheses");
const ranked = await agent(
  prompt(
    [
      "Find candidate causes for this failure. Read the code and any output shown; change nothing.",
      "Produce at most {maxHypotheses} hypotheses, most likely first.",
      "",
      "{brief}",
      "",
      "Each hypothesis must be falsifiable and must name the cheapest check that would refute it.",
      "Do not propose a fix.",
    ].join("\n"),
    { brief, maxHypotheses: String(maxHypotheses) },
  ),
  { label: "hypotheses", outputSchema: HYPOTHESES_SCHEMA },
);

const candidates = ranked.hypotheses.slice(0, maxHypotheses);
if (!candidates.length) {
  return "No hypotheses were produced. Add a repro command or narrow the symptom.\n\n" + brief;
}

const ruledOut = [];
let confirmed;

for (let index = 0; index < candidates.length; index++) {
  const candidate = candidates[index];
  await phase("test-" + String(index + 1));
  const verdict = await agent(
    prompt(
      [
        "Test exactly one hypothesis about a failure. You have no opinion about any other cause.",
        "Inspect the code and run read-only commands. Do not edit anything, do not fix anything.",
        "",
        "{brief}",
        "",
        "Hypothesis: {claim}",
        "Suggested check: {test}",
        "",
        "Answer confirmed only with evidence that rules out coincidence. If the check is impossible",
        "or the result is ambiguous, answer inconclusive rather than guessing.",
      ].join("\n"),
      { brief, claim: candidate.claim, test: candidate.test },
    ),
    { label: "test-" + String(index + 1), outputSchema: VERDICT_SCHEMA },
  );

  if (verdict.status === "confirmed") {
    confirmed = { candidate, verdict };
    break;
  }
  ruledOut.push("- " + candidate.claim + "\n  " + verdict.status + ": " + verdict.evidence);
}

if (!confirmed) {
  return ["No hypothesis was confirmed after " + String(candidates.length) + " test(s).", "", "Ruled out:", ruledOut.join("\n"), "", "Next: widen the symptom, add logging, or give a repro command."].join("\n");
}

const causeText = "Cause: " + confirmed.candidate.claim + (confirmed.verdict.location ? "\nLocation: " + confirmed.verdict.location : "") + "\nEvidence: " + confirmed.verdict.evidence;

const fixApproved = await checkpoint({
  name: "fix",
  prompt: clip("Root cause confirmed. Apply the minimal fix?\n\n" + causeText, 1000),
  context: { claim: confirmed.candidate.claim, location: confirmed.verdict.location },
});
if (fixApproved !== "approved") {
  return ["Root cause found; fix declined.", "", causeText, ruledOut.length ? "\nRuled out:\n" + ruledOut.join("\n") : ""].join("\n");
}

await phase("fix");
const fix = await agent(
  prompt(
    [
      "Fix this confirmed root cause with the smallest change that removes it. No refactors, no",
      "unrelated cleanup. If the fix needs a decision the evidence does not settle, stop and say so",
      "instead of guessing.",
      "",
      "{causeText}",
      "",
      "{reproInstruction}",
    ].join("\n"),
    {
      causeText,
      reproInstruction: repro ? "After the change, run `" + repro + "` and report its exit code." : "Verify the fix the cheapest way the repo allows and report what you ran.",
    },
  ),
  { label: "fix" },
);

let verification = "";
if (repro) {
  const after = await shell(repro);
  verification = "\nRepro `" + repro + "` now exits " + String(after.exitCode) + (after.exitCode === 0 ? " (fixed)." : ".\nstderr tail:\n" + tail(after.stderr, 1000));
}

return [causeText, "", "Fix:", typeof fix === "string" ? fix : JSON.stringify(fix), verification, ruledOut.length ? "\nRuled out on the way:\n" + ruledOut.join("\n") : ""].join("\n");
