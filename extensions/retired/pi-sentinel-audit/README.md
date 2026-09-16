# pi-sentinel

Detects where the agent goes off the rails.

At the end of each turn the recent transcript goes to TypeSafe
[Jev](https://docs.typesafe.ai) as `state`, with typed questions asked against
it. Jev does not generate text — it answers probabilities — so the verdict is a
number your code branches on, not a paragraph you have to trust.

## What it asks

**Stage 1** (three nouls, every audited turn):

| Question | Flags when |
|---|---|
| Still doing what the user asked, without unrequested extra work? | probability ≤ `thresholds.onTask` |
| Claims a result no tool output in the transcript supports? | probability ≥ `thresholds.unsupportedClaim` |
| Repeating an approach that already failed in this transcript? | probability ≥ `thresholds.repeating` |

**Stage 2** runs only when stage 1 trips. It asks which message is the first
point of deviation (a `choice` over the assistant messages, so the answer is a
message id) and how severe the drift is (a 4-level `score`). Most turns never
pay for stage 2.

```
pi-sentinel: on_task 0.03 | severity 2.0/3 | first at a1b2c3d4
```

## Design constraints

**It reports; it does not block.** Jev cannot see the future and cannot explain
itself. Prevention belongs at `tool_call` in pi-jev, where an action can still
be stopped. This extension is a watchtower.

**The audit does not run inside the turn.** `turn_end` handlers are awaited by
the agent loop, so the call is fired without awaiting; the verdict lands during
the next turn. Cost is roughly 900 tokens per audit on a short transcript.

**Standing instructions are re-sent even when they scroll out of the window.**
Drift means "off the original request", so the original request has to survive
windowing. The oldest user messages are pinned and sent alongside the window.

**Injection is off by default.** When enabled, a finding injects a short
reminder into the next turn as a system-level fact rather than rewriting the
assistant's own words. The design review was a coin flip on whether that helps,
so it is opt-in and fires once per distinct finding.

**No key, no auditing.** Nothing is sent anywhere without `TYPESAFE_API_KEY` or
`apiKeyFile`. With a key, the audited window — up to `windowMessages` of recent
role/content pairs, plus any standing instructions that scrolled out of it —
leaves the machine to be scored. That is the recent conversation, in the clear.

## Configure

`~/.pi/agent/pi-sentinel.json`, or project-scoped `.pi/pi-sentinel.json`.

```json
{
  "apiKeyFile": "~/Tokens/JEV_DEV_KEY.txt",
  "enabled": true,
  "everyTurns": 1,
  "windowMessages": 24,
  "minMessages": 6,
  "maxAudits": 40,
  "inject": false,
  "maxStateChars": 12000,
  "thresholds": { "onTask": 0.35, "unsupportedClaim": 0.7, "repeating": 0.7 }
}
```

`maxAudits` is a per-session ceiling so a long run cannot spend without bound.

The API key resolves in this order: `TYPESAFE_API_KEY` (env), `apiKey` (inline),
`apiKeyFile` (path, `~/` expanded).

## Commands

- `/sentinel` — status: model, key source, cadence, window, audits used.
- `/sentinel on` / `/sentinel off`
- `/sentinel inject on|off`
- `/sentinel audit` — audit right now and print every score.
- `/sentinel last` — the last verdict.

## Independently installable

This package carries its own copy of the Jev HTTP client instead of importing
pi-jev's. That duplicates about 150 lines of stable protocol code, and it is
deliberate: neither extension can break the other's load path, and either can
be installed alone. Coupling them would have meant an extension that fails to
load when its neighbour is absent.
