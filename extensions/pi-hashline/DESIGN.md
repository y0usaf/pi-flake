## Locked decisions
- Hashline v3 is a clean break from v2: anchors use the stable v3 line-number/hash format, and stale anchors never relocate or use fuzzy matching. This makes edits fail loudly instead of silently changing a nearby line. (2026-07-30)
- The generated 647-bigram table is byte-stable and not user-configurable: changing its order or contents silently invalidates every stored anchor. Its regression test pins the table and representative hashes. (2026-07-30)
- Writes are atomic temp-file-plus-rename operations, serialized through the host's public `withFileMutationQueue`; this is the single write path. (2026-07-30)
- `edit` retains a narrow compatibility normalization for legacy v2 request shapes (`op`/`pos`/`end`/`lines` and legacy text-key spellings), because existing Pi sessions and callers can still emit them even though v2 anchors themselves are rejected. The rewrite is documented rather than hidden as a v2 protocol. Remove it once the supported Pi host/session compatibility window no longer emits or forwards these shapes and the compatibility tests are removed. (2026-07-30)

## Architecture
- `src/index.ts` is the extension boundary: it registers the read and edit overrides with Pi.
- Pure decision-making functional core: `src/hashline.ts` (anchor validation, edit resolution, content transformation and diff metrics), `src/text-file.ts` (text/line-ending model), `src/constants.ts` (hash alphabet), and `src/snapshot.ts` (snapshot identity).
- Imperative shell: `src/edit-tool.ts` and `src/read-tool.ts` (Pi tool protocol and UI), `src/fs-write.ts` (filesystem checks and atomic persistence). The shell delegates decisions to the core and uses the host mutation queue for serialization.
- Canon rules are n/a for fuzzy relocation and user-configurable hash alphabets: reversal condition is an explicit future protocol version that changes anchor identity and invalidates or migrates all stored anchors.

## Deferred
- Remove legacy request-shape normalization after the host/session compatibility window ends and repository-wide searches plus tests confirm no v2-shaped requests are emitted.
- `computeEditLineMetrics` remains because its requested-edit totals differ from the changed-range totals produced for response/diff reporting; deleting it would change the `details.metrics` contract or require new derivation code.

## Roadmap
- Phase 1 — v3 correctness: check that full v3 anchors validate, stale/v2 anchors fail loudly, and no relocation or fuzzy matching occurs; covered by the hashline tests.
- Phase 2 — stable identity: check that the generated table has 647 entries and pinned hashes remain unchanged; covered by the constants regression test.
- Phase 3 — safe persistence: check that edits use the queued atomic write path and reject concurrent or hardlinked mutations; covered by the filesystem and edit-tool tests.
- Phase 4 — compatibility retirement: check that the supported host emits only `{loc,content}`/`{oldText,newText}`, then delete normalization and its tests.
