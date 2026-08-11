# pi-sentinel

Detects abrupt run endings and continues them.

## The failure it fixes

A run settles but the final assistant message is a cutoff: mid-sentence,
mid-plan, or an announced action that never happened. The session just sits
there looking finished.

## How it works

On `agent_settled`:

1. **Free verdicts first.** `stopReason: "aborted"` (user pressed Esc) is
   always respected — no continuation. `"length"` / `"error"` are abrupt by
   definition — no judge call needed.
2. **Sparse judge.** Otherwise, a one-shot completion on the *session model*
   sees only the user's request (first 1200 chars) and the tail of the final
   assistant message (last 1600 chars) — no session context, ~700 tokens.
   It replies one word: `COMPLETE` or `ABRUPT`.
3. **Continue.** `ABRUPT` queues a follow-up user message telling the agent
   to resume from where it stopped. Capped at 3 continuations per user
   input; the cap resets only on real (non-extension) input.

Fail-safe direction: any ambiguity (no model, judge error, empty reply)
counts as `COMPLETE`. The extension can under-fire but never loop.

## Spectator

Never touches files or host state. Only reads settled messages, makes one
side completion call, and queues a user message.
