# pi-fusion

Devin Fusion-style orchestration for Pi: a selectable `fusion/<pair>` model
keeps the lead model in charge, while bounded implementation work is delegated
to a persistent sidekick running a second model.

This is a local approximation of the public Fusion architecture. It does not
reuse Cognition's private prompts, routing, accounting, or classifier.

## Configure

Create `~/.pi/agent/pi-fusion.json`, or project-scoped `.pi/pi-fusion.json`:

```json
{
  "pairs": [
    {
      "id": "fable-swe2",
      "name": "Fusion: Fable + SWE-2",
      "lead": "anthropic/claude-fable-5-1-medium",
      "sidekick": "openai/gpt-4o-mini"
    }
  ],
  "orchestrator": false,
  "maxSidekickTurns": 80,
  "sidekickTimeoutSeconds": 900,
  "maxSidekicks": 4
}
```

`lead` and `sidekick` are normal Pi model specs (`provider/model-id`, or a
unique bare model id). Project pairs override global pairs with the same `id`.

For a single pair, the top-level shorthand also works:

```json
{
  "lead": "anthropic/claude-fable-5-1-medium",
  "sidekick": "anthropic/claude-haiku-4-5"
}
```

## Use

Start Pi, then select the configured Fusion model:

```text
/model fusion/fable-swe2
```

The lead keeps normal Pi tools and gets a `fusion_sidekick` tool. Calls with
the same `sidekick_id` share one persistent sidekick transcript; calls with
different ids run independently.

Set `orchestrator: true` globally or per pair to remove `write`, `edit`, and
`bash` from the lead and route mutations through sidekicks.

Commands:

- `/fusion` — show the active pair, mode, and sidekick ids.
- `/fusion reset` — abort and clear all sidekick sessions.
- `/fusion orchestrator on|off` — toggle lead mutation-tool stripping.
