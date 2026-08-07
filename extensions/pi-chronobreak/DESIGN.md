## Locked decisions

- Detect the loop on the assistant TEXT stream, not tool calls. The failure is
  the model repeating the same prose/sentence inside one turn while never
  producing a settled action (seen live: "Let me check the system mtime and
  module import..." x many). Tool-call fingerprinting misses this (the model
  often abandons the call). (2026)
- Segment-level repetition is the signal: within one turn, the same text chunk
  (line/sentence) appearing >= 3 times flags a loop. Chunks are normalized
  (case/whitespace folded). A rolling window of recent chunks keeps it per-turn.
- "End the output" = ctx.abort(). "Checkpoint" granularity is the session entry
  (one per turn/message): chronobreak rolls back to the last stable entry before
  the looping turn and re-injects a nudge via pi.sendUserMessage.
- Rollback + re-inject only run when idle (agent_settled / lazy via message_end),
  mirroring pi-review: navigateTree is proven from idle, not mid-stream.
- chronobreak is a spectator: it never changes files, only aborts + navigates
  the session tree. It never runs kernel code. (canon:least-code, least-power)

## Architecture

- src/index.ts — the whole extension, decision-making: segmentize/scan (pure
  functions: text in, loop verdict out), plus the imperative shell of five
  event handlers (message_start reset, message_update detect+abort,
  message_end scrub, agent_end re-inject, input strike-reset). No extension
  boundary of its own: it is a spectator on pi's event API and never exposes
  state to the model.

## Deferred

- Cross-turn loop detection (same assistant message repeating across turns):
  the observed failure is within-turn; add a small LRU of final message
  fingerprints only if cross-turn loops show up in practice.
- Fuzzy/prefix matching (repeated phrase with varying tails): exact normalized
  segment match >= 3 catches the observed case; add fuzz only on evidence.
- navigateTree rollback (checkpoint before the looping turn): unnecessary while
  the loop is within one message — abort + scrub + re-inject already restarts
  the turn without tree surgery. Revisit if multi-turn loops appear.

## Roadmap

- Phase 1 — detection + termination: abort on >= 3 repeated normalized segments
  in one assistant message, scrub the aborted message, re-inject the nudge,
  3-strike give-up. Criterion: nix build .#pi-chronobreak and nix flake check
  green; a live loop gets cut and the session shows the scrub marker.
- Phase 2 — tuning: thresholds (repeat count, min chunk length) adjusted from
  real loops observed with the js-kernel sessions. Criterion: no false trigger
  across a week of normal use, and the next real loop is cut.
