## Locked decisions

- Detect the loop on the assistant TEXT stream, not tool calls. The failure is
  the model repeating the same prose/sentence inside one turn while never
  producing a settled action (seen live: "Let me check the system mtime and
  module import..." x many). Tool-call fingerprinting misses this (the model
  often abandons the call). (2026)
- Thinking blocks are scanned as their own stream, separate from visible text.
  The observed degeneration ("Let me update the doc." restated ~20 ways) lives
  in thinking as often as in text; separate streams mean a loop in one is never
  diluted by variety in the other. When the loop is in thinking, the scrub
  drops all thinking and keeps the (non-looping) visible text plus the
  truncation marker — thinking has no lead-in worth preserving. (2026-08)
- The loop's real signature is behavioural STALL, not any content shape. So the
  primary discriminator is content-agnostic: a message that has emitted a tool
  call is by definition progressing and is NEVER eligible for cutting. Only
  pure-prose output that is lexically exhausted can be a loop.
- Three detection tiers, all pure and recomputed from the full text each update:
  - exact — verbatim normalized segment >= 3 times (unchanged).
  - stall — paraphrase-tolerant, distribution-free: pairwise near-duplication
    (Jaccard >= 0.5 OR containment >= 0.6) of a growing tail that is redundant
    and lexically exhausted (low novelty). Fires the loose loop (same intent,
    varied wording) and out-of-distribution loops (calculus, code, "is-42").
  - fragment — verbless/utterance degeneracies ("42. " x20) that evade the
    MIN_CHUNK_LEN floor.
- Enumeration exemption: a redundant cluster that shares a LARGE core (>= 60% of
  median member size — one skeleton, one varying payload word per item) is a
  legitimate template enumeration ("I updated docs for X module" x14), NOT a
  loop. A loop shares only a tiny intent core ("update doc") while rewordings
  diverge.
- "End the output" = ctx.abort(). Truncate the aborted assistant message back to
  where the loop began (keeping the coherent lead-in) and re-inject a nudge via
  pi.sendUserMessage.
- Truncate + re-inject run at message_end (idle), not mid-stream.
- chronobreak is a spectator: it never changes files, only aborts + replaces one
  assistant message's text. It never runs kernel code. (canon:least-code,
  least-power)

## Architecture

- src/detector.ts — pure loop-detection core: text in + loop verdict (kind,
  count, sample, loop-start offset) out. No I/O, no state. Re-scans the full
  text on every call so streaming updates never double-count.
- src/index.ts — the imperative shell: the toolCall eligibility gate, the five
  event handlers (message_start reset, message_update detect+abort on the text
  stream then the thinking stream, message_end truncate-and-keep-lead-in,
  agent_end re-inject, input strike-reset), and the per-stream extraction of
  text and thinking blocks.

## Deferred

- Cross-turn loop detection (same assistant message repeating across turns):
  deferred. Exact full-message fingerprints on completed, tool-free turns only
  if cross-turn loops show up in practice; never token-similarity fingerprints.
- navigateTree rollback (checkpoint before the looping turn): unnecessary while
  the loop is within one message — abort + truncate-at-loop-start + re-inject
  already restarts the turn without tree surgery. Revisit if multi-turn loops
  appear (the rollback would also be able to drop the lead-in, not just the tail).
- Pure synonym-rotation loops (update/refresh/modify x doc/file/record with
  near-zero shared vocabulary): an information-theoretic limit for string-only
  detection. Deliberately missed rather than risk stopping a legit long answer.

## Roadmap

- Phase 1 — detection + termination: abort on a tool-free, lexically-exhausted
  message, truncate back to the loop start (keeping the coherent lead-in),
  re-inject the nudge, 3-strike give-up. Criterion: nix build .#pi-chronobreak
  and nix flake check green; live loops get cut and the session keeps the
  pre-loop lead-in with a truncation marker.
- Phase 2 — tuning: thresholds tuned from real loops observed with the js-kernel
  sessions. Criterion: no false trigger across a week of normal use, and the
  next real loop is cut. Run in shadow mode first (notify-only, no abort).
