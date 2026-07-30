## Locked decisions
- The main-session model composes questions, never a secondary model, because it owns request context (2026-07-30).
- Durability uses message-array repair rather than a sidecar file, because persisted tool calls are authoritative (2026-07-30).
- The startup overlay path was removed in favour of model-driven re-ask: interruption feedback lets the model ask again mid-turn with a stable editor slot (2026-07-30).

## Architecture
- `src/index.ts` is the extension boundary and orchestration machinery.
- `config.ts`, `protocol.ts`, and `durability.ts` are pure decision-making modules.
- `questionnaire.ts` is machinery for tabbed and sequential UI.
- Sidecar persistence is n/a; reverse only if message-array repair cannot be supplied by the context hook.

## Deferred
- The tab UI stays because it carries per-question drafts and back-navigation. Replace it with the sequential `ctx.ui.select` loop already in `runRpcQuestionnaire` only if those affordances are no longer required.

## Roadmap
- Verify malformed config warnings are surfaced: run extension tests and Nix checks.
- Verify interrupted calls receive explicit re-ask guidance in the context hook.
