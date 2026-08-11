# pi-sentinel — design

## Locked decisions

- **2025-08 — "continue" on every settle, no judge, no cap.** Earlier
  version used a context-free completion to decide ABRUPT vs COMPLETE and
  capped at 3. Removed: the extension now sends "continue" unconditionally
  on every `agent_settled`. The agent's own termination logic (aborted stop,
  exhaustion) controls loop exit. [[ponytail: unconditional loop, agent
  decides when done. Upgrade: add settle-quiescence guard if agent loops
  without producing visible output.]]

## Architecture

- `src/index.ts` — 6 lines. No extension boundary of its own.

## Deferred

- None.

## Roadmap

- **Phase 1 (done):** `agent_settled` → pi.sendUserMessage("continue").
  Criterion: `nix flake check` passes.