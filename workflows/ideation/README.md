# Ideation workflow

Multi-model debate for [pi-loom](../../extensions/pi-loom/DESIGN.md), the
workflow engine at `@extensions/pi-loom/` (forked from
pi-extensible-workflows 3.4.2).

Every participant is a plain **ideator** — no personas. Diversity comes from
different model weights/corpora, not role prompts. Default ideators are cheap
models served via vercel-ai-gateway (`zai/glm-5.2-fast`,
`deepseek/deepseek-v4-flash`); the judge defaults to
`moonshotai/kimi-k3-fast` for reliable structured verdicts.

Each round runs in two passes:

1. **chain** — ideators speak sequentially; each sees everything said before
   them this round and must engage it (attack, defend, concede, merge).
2. **open floor** — everyone sees the full chain and answers the strongest
   objection to their own position.

A Consensus Judge agent with a structured `outputSchema` verdict checks after
every round; the loop runs **until agreement**, stopping only at:

1. **consensus** (judge: `converged: true`),
2. a **human checkpoint** after round 3 (approve to continue, reject to stop),
3. the **round cap** (`maxRounds`, default 5, hard max 10),
4. the **run budget** if one is set (tokens/cost/duration — resumable via
   `workflow_resume` after a budget bump).

The discussion is script-mediated: agents never talk peer-to-peer; the
workflow passes the growing transcript to each participant. Token cost grows
with rounds — keep `maxRounds` low or set a budget for open-ended topics.
With the default cheap models a converging 1-round run costs ~$0.10.

## Prerequisites

Enable the extension in your system flake and rebuild:

```nix
programs.pi.extensions.loom = true;
```

The system flake (`modules/dev/pi/workflows.nix`) places this directory into
`~/.local/share/pi/agent/workflows/ideation/`, which the engine scans for
`command.json` — that registers the slash command. The files here are the
source of truth; the home-dir copy is a store symlink, never edited in place.

## Invoke

Slash command:

```
/ideate '{ "topic": "a local-first sync engine for my notes" }'
```

Or via the `workflow` tool (adds a budget backstop):

```json
{
  "name": "ideate",
  "scriptPath": "/home/y0usaf/dev/pi-flake/workflows/ideation/ideate.js",
  "args": { "topic": "a local-first sync engine for my notes" }
}
```

Optional args:

- `context` — background info fed to every participant.
- `maxRounds` — 1–10, default 5. Raise for hard topics, lower to save tokens.
- `models` — ideator model ids (default: glm-5.2-fast + deepseek-v4-flash via
  vercel-ai-gateway). Must be available models (credentials configured).
- `judgeModel` — defaults to `vercel-ai-gateway/moonshotai/kimi-k3-fast`.

Runs are backgrounded by default; completion arrives as a follow-up message.
Add `"foreground": true` when the caller must wait for the final synthesis in
the same turn.

Useful extras:

- Launch with a budget, e.g. `"budget": { "tokens": { "hard": 1000000 } }`,
  as a backstop against a discussion that never converges.
- `workflow_status({ runId })` inspects a running or finished run;
  `workflow_retry({ runId })` replays a failed run without rerunning
  completed agents.

## Model ids and providers

Model ids must include the provider prefix of an *available* model (one with
credentials), e.g. `vercel-ai-gateway/zai/glm-5.2-fast`. A bare id like
`moonshotai/kimi-k3-fast` resolves against the native provider and fails
availability when only the gateway has credentials for it.
