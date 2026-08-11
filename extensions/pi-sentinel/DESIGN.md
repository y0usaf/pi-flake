# pi-sentinel — design

## Locked decisions

- **2025-06 — Judge is a raw completion, not a subagent.** The verdict needs
  one bit (proper stop vs cutoff), so it uses
  `ctx.modelRegistry.complete()` on the session model with a sparse excerpt
  (request head + final-message tail). A `pi --print` child was rejected:
  cold start, full session overhead, and it still could only report back to
  the same hook. [[canon:least-code]]
- **2025-06 — Judge sees a sparse excerpt, never the session context.**
  "Did this end abruptly" is visible in the tail alone; sending full context
  would multiply token cost for no verdict accuracy on that question.
- **2025-06 — Fail toward silence.** No model, judge error, empty or
  unparseable reply → treated as COMPLETE. A missed continuation costs one
  manual "continue"; a false continuation loop costs tokens forever.
- **2025-06 — `stopReason` short-circuits.** `aborted` (user Esc) never
  continues; `length`/`error` continue without asking the judge.
- **2025-06 — Cap of 3 continuations per user input,** reset only by
  non-extension input, so extension-sourced nudges (ours or another
  extension's) cannot re-arm the loop.

## Architecture

- `src/index.ts` — the whole extension. Decision-making: verdict routing
  (stopReason short-circuits, judge fallback) and the judge prompt.
  Machinery: text extraction, event capture, the nudge send. No extension
  boundary of its own: it is itself a plugin on pi's public ExtensionAPI, so
  [[canon:functional-core]] and [[canon:no-privileged-path]] are n/a here;
  they would apply only if sentinel grew its own plugin surface.

## Deferred

- **Turn-level tool-call excerpts in the judge prompt** (names of tools run
  in the final turn). Left out until a real transcript shows the text tail
  alone misjudging; adding context before seeing the failure is speculation.
- **Configurable cap / char budgets.** Constants until a second user exists.
- **Judging on a cheaper fixed model.** The session model is the simplest
  correct default ("same model the session uses"); a `judgeModel` setting
  can be added if cost shows up in practice.

## Roadmap

- **Phase 1 (done):** judge + continuation behind the `testing` lifecycle
  stage; criterion: `nix flake check` passes with sentinel built and linted.
- **Phase 2 (done):** promoted to `active` 2025-08-08 after owner review;
  the `testing` lifecycle gate served only the shared-registry use case and
  was unnecessary for a single-user flake.
