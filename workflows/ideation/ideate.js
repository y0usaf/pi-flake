// Ideation workflow for pi-extensible-workflows.
// Three persona agents debate a topic in rounds; a judge agent with a
// structured verdict decides each round whether consensus was reached.
// The loop stops at consensus, a hard round cap, or a human checkpoint.
//
// Launch args (JSON): { topic: string, context?: string, maxRounds?: 1-10 }

if (!args || typeof args.topic !== "string" || !args.topic.trim()) {
  throw new Error('ideate requires args.topic (non-empty string), e.g. { topic: "local-first sync engine" }');
}

const topic = args.topic.trim();
const context = typeof args.context === "string" ? args.context.trim() : "";
const maxRounds = Number.isInteger(args.maxRounds) && args.maxRounds > 0 ? Math.min(args.maxRounds, 10) : 5;

const PERSONAS = {
  advocate:
    "You are the Advocate. Generate bold angles, steelman promising ideas, and build on the other participants' points. Be concrete; no platitudes.",
  skeptic:
    "You are the Skeptic. Expose failure modes, hidden costs, and second-order effects. Attack ideas, not people. Concede explicitly when an objection has been answered.",
  pragmatist:
    "You are the Pragmatist. Ground the discussion in feasibility, effort, and what actually ships. Merge positions when a synthesis is possible.",
};

const contextBlock = context ? "\n\nBackground context: " + context : "";

const transcript = [];
let verdict = null;

for (let round = 1; round <= maxRounds; round++) {
  await phase("round-" + String(round));

  const discussion = transcript.length
    ? transcript
    : "(opening round — state your initial position)";

  const replies = await parallel("round-" + String(round), {
    advocate: () =>
      agent(
        prompt(
          "{persona}\n\nTopic under ideation: {topic}{context}\n\nDiscussion so far:\n{discussion}\n\nRespond to the other participants' latest points and state your position for this round. Under 200 words.",
          { persona: PERSONAS.advocate, topic, context: contextBlock, discussion },
        ),
        { label: "advocate-round-" + String(round) },
      ),
    skeptic: () =>
      agent(
        prompt(
          "{persona}\n\nTopic under ideation: {topic}{context}\n\nDiscussion so far:\n{discussion}\n\nRespond to the other participants' latest points and state your position for this round. Under 200 words.",
          { persona: PERSONAS.skeptic, topic, context: contextBlock, discussion },
        ),
        { label: "skeptic-round-" + String(round) },
      ),
    pragmatist: () =>
      agent(
        prompt(
          "{persona}\n\nTopic under ideation: {topic}{context}\n\nDiscussion so far:\n{discussion}\n\nRespond to the other participants' latest points and state your position for this round. Under 200 words.",
          { persona: PERSONAS.pragmatist, topic, context: contextBlock, discussion },
        ),
        { label: "pragmatist-round-" + String(round) },
      ),
  });

  transcript.push({ round, ...replies });

  verdict = await agent(
    prompt(
      "You are the Consensus Judge. Topic: {topic}\n\nFull discussion:\n{discussion}\n\nDecide whether the participants have converged on a shared position with no substantive unresolved disagreement. Different wording of the same position counts as converged. Open issues must be concrete disagreements, not stylistic notes.",
      { topic, discussion: transcript },
    ),
    {
      label: "judge-round-" + String(round),
      outputSchema: {
        type: "object",
        properties: {
          converged: { type: "boolean" },
          sharedPosition: { type: "string", description: "The agreed position in one paragraph, or the closest overlap if not converged." },
          openIssues: { type: "array", items: { type: "string" }, description: "Concrete unresolved disagreements; empty when converged." },
        },
        required: ["converged", "sharedPosition", "openIssues"],
        additionalProperties: false,
      },
    },
  );

  transcript.push({ round, judge: verdict.sharedPosition, openIssues: verdict.openIssues });

  if (verdict.converged) break;

  if (round === 3 && maxRounds > 3) {
    await checkpoint({
      name: "ideation-midpoint",
      prompt:
        "No consensus after 3 rounds on: " +
        topic.slice(0, 400) +
        ". Open issues: " +
        verdict.openIssues.slice(0, 5).join("; ").slice(0, 500) +
        ". Approve to continue, reject to stop and synthesize as-is.",
      context: { topic: topic.slice(0, 200), round, openIssues: verdict.openIssues.slice(0, 5).map((issue) => issue.slice(0, 300)) },
    });
  }
}

return await agent(
  prompt(
    "You are the Synthesizer. Topic: {topic}\n\nFull discussion:\n{discussion}\n\nFinal judge verdict: {verdict}\n\nProduce: 1) the agreed concept (or, if the judge never confirmed consensus, the strongest positions and why they diverge), 2) the key trade-offs, 3) concrete next steps. Be crisp.",
    { topic, discussion: transcript, verdict },
  ),
  { label: "synthesis" },
);
