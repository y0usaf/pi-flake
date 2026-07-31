# pi-aphrodite design

## Locked decisions
- Use measured insertion thresholds of 32 KB for generic and terminal output. A three-model panel over 513 local session JSONL files measured the previous 16 KB / 8 KB pair: 191 CCR markers replaced 4,027,231 bytes; 170 `aphrodite_retrieve` calls retrieved 142 markers (74%); retrieval was 70.6% (60/85) at 8–16 KB, 84.9% (62/73) at 16–32 KB, and 60.6% (20/33) at 32–64 KB, with 157 of 190 compressions in the 8–32 KB range. The round-trips re-prefilled 7.5–8.8 million input plus cache-read tokens to keep about 1.94 MB (roughly 0.49 million tokens) out of context — about 15:1 in raw tokens, and still unfavorable at cache-read pricing. Only 32 KB+ earns its marker. (2026-07-31)
- **Superseded (2026-07-31):** Use measured insertion thresholds of 16 KB for generic tool output and 8 KB for terminal output, rather than upstream's 4 KB / 1 KB byte thresholds. An audit of 141 local Pi sessions (2,778 compressions and 2,495 retrievals) found that below roughly 16 KB the model immediately retrieved 83–90% of markers, making the extra request cost more than the marker saved; `read` was retrieved 97% of the time at every size and remains skipped. (2026-07-30)
- Keep a deliberate silent-degradation fallback when the SQLite store cannot open or a write fails: preserve the original output and let `/aphrodite on` retry. This is a knowing divergence from canon:unix fail-loudly because losing a local optimization must not lose tool output or kill a session. Reverse this decision if store failures can make retrieval correctness or data integrity unsafe rather than merely disabling compression. (2026-07-30)
- Compress at insertion conservatively, and compress aged context separately. The context engine trades prompt-cache stability for reclamation: replacing a message invalidates the provider's cached prefix from that point, but protecting the first two and last five messages limits churn; idempotence lets the prefix re-stabilize on the following turn. (2026-07-30)

## Architecture
- `index.ts` is the extension boundary: it registers the `tool_result`, `context`, `user_bash`, `session_start`, command, and retrieval-tool handlers with Pi.
- Decision-making: the regex classifier, insertion thresholds, skip-list policy, and context-engine threshold/protected-window policy decide whether output should be replaced.
- Machinery: the SQLite CCR store, hashing, TTL purge, previews, marker rendering, retrieval pagination, and event handlers execute those decisions.
- The extension owns its own SQLite store state, availability, counters, and lifecycle; it does not mutate host state. Context handling returns replacement messages rather than editing Pi's message array. A store-wide measurement found the context engine firing at most 68 times: 68 of 3,617 rows never appear in session logs, so it is not currently carrying the value the earlier design assumed.
- The SQLite fallback is intentionally the exception to canon:unix fail-loudly; reverse it when a store error can compromise correctness or integrity instead of only preventing an optional compression.

## Deferred
- Upstream enriched previews, classifier polling, and the `code_multiplier` are not ported. The default `read` skip list covers the principal code path, while the context engine closes the load-bearing gap.

## Roadmap
- Phase 1 — Keep insertion compression conservative: generic output at 16 KB, terminal output at 8 KB, and `read` skipped by default. Check: oversized output produces a CCR marker and retrieval returns the original.
- Phase 2 — Reclaim aged context at 45% usage while protecting the first 2 and last 5 messages. Check: eligible middle tool results become markers, marked results are skipped, and unknown usage idles.
- Phase 3 — Maintain local retention and operational fallback. Check: TTL purge is lazy/debounced, expired rows are hidden, and SQLite failures preserve raw output.
