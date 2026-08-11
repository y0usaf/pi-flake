# pi-sentinel — design

## Locked decisions

- **2025-08 — judge classifies ABRUPT vs COMPLETE, nudge is "continue".** A
  context-free completion (one-shot on the session model) inspects the user
  request and tail of the final assistant message. ABRUPT → send "continue"
  as follow-up. COMPLETE → no-op. Cap: 3 continuations per user input.
  stopReason "aborted" (user pressed Esc) is always respected.

## Architecture

- `src/index.ts` — ~150 lines. Judge fn + event wiring.
- No extension boundary of its own.

## Deferred

- None.

## Roadmap

- **Phase 1 (done):** Judge decides ABRUPT/COMPLETE, sends "continue".
  Criterion: `nix flake check` passes.
