# Ideation workflow

Panel ideation for [pi-extensible-workflows](https://github.com/vekexasia/pi-extensible-workflows)
(vendored at `@extensions/vekexasia_pi-extensible-workflows/`).

Three persona agents — Advocate, Skeptic, Pragmatist — debate a topic in
rounds. A Consensus Judge agent with a structured `outputSchema` verdict
checks after every round; the loop runs **until agreement**, stopping only at:

1. **consensus** (judge: `converged: true`),
2. a **human checkpoint** after round 3 (approve to continue, reject to stop),
3. the **round cap** (`maxRounds`, default 5, hard max 10),
4. the **run budget** if one is set (tokens/cost/duration — resumable via
   `workflow_resume` after a budget bump).

The discussion is script-mediated: agents never talk peer-to-peer; the
workflow passes the growing transcript to each participant every round.
Token cost therefore grows with rounds — keep `maxRounds` low or set a budget
for open-ended topics.

## Prerequisites

Enable the extension in your system flake and rebuild:

```nix
programs.pi.extensions.extensible-workflows = true;
```

## Invoke

From any pi session, ask in plain language, e.g.:

> Run the ideation workflow at `~/dev/pi-flake/workflows/ideation/ideate.js`
> on the topic "a local-first sync engine for my notes".

The agent launches it with the `workflow` tool:

```json
{
  "name": "ideate",
  "scriptPath": "/home/y0usaf/dev/pi-flake/workflows/ideation/ideate.js",
  "args": { "topic": "a local-first sync engine for my notes" }
}
```

Optional args: `context` (background info fed to every participant) and
`maxRounds` (1–10, default 5). Runs are backgrounded by default; completion
arrives as a follow-up message. Add `"foreground": true` when the caller must
wait for the final synthesis in the same turn.

Useful extras:

- `args.maxRounds` — raise for hard topics, lower to save tokens.
- Launch with a budget, e.g. `"budget": { "tokens": { "hard": 2000000 } }`,
  as a backstop against a discussion that never converges.
- `workflow_status({ runId })` inspects a running or finished run;
  `workflow_retry({ runId })` replays a failed run without rerunning
  completed agents.

## Customizing personas

Personas are inline strings in `ideate.js` (`PERSONAS`). For per-persona
model selection, convert them to role files under
`~/.pi/agent/pi-extensible-workflows/roles/` (or a project-local
`.pi/pi-extensible-workflows/roles/`) and pass `{ role: "name" }` in the
`agent(..., options)` calls. See the vendored
`@extensions/vekexasia_pi-extensible-workflows/examples/workflow-extension-template/`.
