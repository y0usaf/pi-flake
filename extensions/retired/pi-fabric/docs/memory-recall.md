# Memory & Recall

Pi Fabric's `memory` provider searches Pi session JSONL files. Session JSONL
forms the source of truth. The memory index holds derived, disposable state.

Structural extraction is the only indexing method. Regexes never classify
goals, preferences, errors, or other prose concepts. Roles, tool names,
timestamps, entry IDs, operation addresses, exact `ref`/`provider`/`action`
identities, execution outcomes, tool errors, and tool argument paths all come
from typed session fields.

## Active branches

`memory.recall`, `memory.sessions`, and `memory.expand` accept
`branches: "active" | "all"`. Every scope defaults to `"active"`, including
`project`, `global`, and explicit `session:<id-or-path>` scopes. Only records
carried on each session's active parent-linked path contribute to hot text,
cold vocabulary, structural addresses, segments, and entry counts, so an
abandoned sibling cannot match by default. `branches: "all"` asks explicitly
for every branch. Responses, segments, cold pointers, and session rows
identify their branch mode.

For the current live session, every memory action calls the extension
context's live `SessionManager.getBranch()` and `getLeafId()` getters.
These live reads observe `/tree` navigation even when no new record has
been appended. For another persisted session, Fabric follows Pi 0.80.6's
persisted semantics. The last persisted non-header entry serves as the
leaf, duplicate IDs resolve to the last record in the ID map, and Fabric
walks `parentId` links from that leaf to a root. Append order never counts as one transcript. When a parent
cycle occurs, Fabric stops defensively and marks coverage incomplete with
`invalid_parent_graph`.

Each derived record carries `branches` and a SHA-256 `lineageFingerprint`
over the selected branch mode, leaf, and active path IDs. Active and all
caches use separate filenames. Branch mode, lineage fingerprint, and privacy
settings all feed cache policy, so navigation, an append, or a policy change
rebuilds the relevant derived record without contaminating the other mode.
`sourceHash` still covers the complete JSONL source, including off-lineage
records.

## Cache V6

Cache records carry `cacheVersion: 6`. Fabric removes older or malformed
records and rebuilds them from source. Rebuilding from source replaces any
migration of old records into V6. Refresh also clears orphan records,
records whose encoded cache path fails to match their source identity, and
records for deleted source sessions.

Every cache record stores the exact session file path, branch mode, lineage
fingerprint, privacy policy, and a SHA-256 `sourceHash`, along with source
mtime and size. A same-size rewrite that preserves mtime still invalidates
the record. Fabric creates cache directories with `0700` permissions and
cache files with `0600` permissions on a best-effort basis.

A hot shard holds bounded normalized entry text plus `indexCoverage`. Each
cold digest contains:

```ts
{
  cacheVersion: 6,
  kind: "digest",
  sessionId, file, cwd,
  mtime, size, sourceHash,
  branches, lineageFingerprint, policy,
  firstTs, lastTs, entryCount,
  filesTouched, toolHistogram, errorCount,
  vocabulary,   // sorted unique canonical strings, no posting lists
  addresses,    // structural identity + ref/provider/action/outcome postings
  indexCoverage,
  cacheBytes, cacheSourceRatio
}
```

Cold vocabulary maps each exact lexical term only to the session that
contains it. The digest keeps no per-term entry indices. Structural address
tuples separately keep exact entry identity, role/tool/time, and persisted
`ref`/`provider`/`action`/`outcome` fields. A cold lexical result remains a
session pointer with exact `sessionFile` and `sourceHash`. It never appears
as an inferred lexical entry range. Exact lexical entry matches come back
only after explicit hydration.

`maxColdVocabularyBytes` bounds vocabulary construction for each session.
`maxColdCacheBytes` is a hard per-session cap on the persisted cache.
Reaching either cap sets `indexCoverage.complete` to false with an explicit
reason. The cache-size cap can force structural addresses or vocabulary to
persist as exact prefixes only. Fabric always reports this state as
`max_cold_cache_bytes` and never treats it as complete. `cacheSourceRatio`
divides persisted cache bytes by source bytes.

## Capability heads and exact structural retrieval

Fabric separates capability navigation from memory evidence.
`tools.catalog()` returns a deterministic current tree:

```text
Fabric capabilities
└── provider head
    └── action head
```

Provider/action names, descriptions, and descriptor hashes describe the
currently registered catalog. Full schemas stay available through
`tools.search()` and `tools.describe()`. A caller can use this metadata to
choose an action ref. Fabric never copies it into session entries.
Historical evidence comes from session records alone. Catalog descriptor
changes can shift discovery ranking. Historical structural membership stays
intact.

`memory.recall` accepts exact structural filters:

- `ref`, for example `pi.grep`.
- `provider`, for example `pi`.
- `action`, for example `grep`.
- `outcome`: one of `succeeded | failed | aborted | timed_out`.
- the existing `role`, `tool`, `since`, and `until` filters.

With no `query` present, these filters produce `matchMode: "structural"`,
and persisted typed fields alone decide membership. A `query` value
constrains the normal lexical or explicit-regex search and produces
`matchMode: "combined"`. Responses echo the exact `structuralFilters`.
Catalog description text never becomes a lexical match.

```ts
const heads = await tools.search({ query: "search source files" });
const history = await memory.recall({
  scope: "project",
  ref: heads[0]?.ref,
});
const failures = await memory.recall({
  scope: "project",
  query: "timeout",
  ref: "agents.run",
  outcome: "failed",
});
```

A complete cold structural posting proves that the selected session contains
a matching typed entry. The cold response remains an integrity-bound
session pointer. A combined cold lexical + structural
candidate cannot prove that both conditions occur on the same entry, because
cold vocabulary has no posting lists. The response reports
`cold_structural_filter_requires_hydration`. The caller must hydrate the
session before claiming entry-level co-location.

## Exact lexical queries

Callers choose `queryMode` explicitly:

- `"literal"` serves as the default.
- `"regex"` requires an explicit opt-in.

Literal mode does not inspect punctuation to guess whether the input looks
like a regular expression. It never compiles the input with `RegExp`. A path
such as `src/foo.ts` stays literal input.

`tokenize.ts` works as the single canonical tokenizer for literal queries,
hot BM25 scoring, and cold vocabulary creation. It applies Unicode NFKC
normalization, extracts Unicode letters, numbers, and `_` characters, then
lowercases them. Literal terms match through exact canonical-token equality.
Matching runs as a lexical OR across the unique query terms. Fabric applies
no stemming, synonym expansion, phrase inference, or semantic regex
classification.

In a cold session with complete coverage, every unique canonical token of
the normalized source text occurs exactly once in the sorted vocabulary.
Rare terms stay exactly discoverable as long as the configured vocabulary
and cache bounds hold. Exceeding a bound makes an empty result explicitly
non-authoritative.

Unicode scalar count sets the hot-text limit. Raw UTF-16 code units play no
part. A cut cannot split a surrogate pair, and the shard text remains
valid UTF-8. Hot shards retain no separate complete tail vocabulary, so
truncating any normalized entry sets shard `indexCoverage.complete:
false` with reason `max_entry_chars`. A token that occurs only after the
cut cannot yield an authoritative no-match. Recall says `No indexed
matches` and includes that reason. Expansion still re-reads the complete
source record.

## Bounded regular expressions

Regex mode runs JavaScript regex inside a disposable worker thread. The host
never evaluates an untrusted pattern. Fabric terminates the worker forcibly
at the hard timeout, so catastrophic backtracking cannot continue on the
host thread. Four limits bound regex execution:

- UTF-8 pattern byte count.
- haystack item count.
- aggregate UTF-8 haystack bytes.
- wall-clock worker timeout.

A hot haystack is normalized entry text. A cold haystack is one bounded
canonical vocabulary term. Transcript prose never serves as a cold
haystack. Invalid patterns, oversized patterns, haystack truncation,
worker failures, and timeouts each return structured query coverage. A timeout, for example, returns `coverage.complete: false`, the
reason `regex_timeout`, and a structured `coverage.error`. An incomplete
regex result never counts as an authoritative no-match.

## Tiers, refresh, and work budgets

The `memory.hotSessions` most recently modified sessions stay hot. Every
older session is cold. Once a session crosses the boundary, Fabric drops
the old derived tier record after building the replacement. Explicit
hydration re-reads source without promoting a cold session.

Session count and aggregate source bytes bound cache synchronization.
Cache cleanup follows budgets on inspected cache files and aggregate
cache bytes. The cleanup byte budget is shared with
`maxSyncSourceBytes`. Reaching a work budget stops additional indexing
and sets `coverage.complete: false`. All eligible sessions remain
counted. Fabric bounds every background job, and the index needs no
database dependency.

Query mode and no-query browse mode both discover every eligible session.
`memory.maxSessions` limits session listing only. Search materialization
works under explicit deterministic per-call budgets: 50,000 filtered hot
entry candidates, 10,000 cold digest candidates, and 10,000 grouped result
items. Hitting one of these marks coverage incomplete with
`candidate_entry_budget`, `candidate_digest_budget`, or
`candidate_item_budget`. Totals then describe the retained deterministic
candidate set. Unknown omitted candidates stay outside those totals.
Coverage reports:

```ts
coverage: {
  complete: boolean,
  indexedSessions: number,
  eligibleSessions: number,
  staleSessions: number,
  incompleteSessions: number,
  reasons: string[],
  error?: { code: string, message: string }
}
```

`No matches` counts as authoritative only when cache/index coverage and
query execution coverage are both complete. In every other case the response
reads `No indexed matches` and names reasons such as source unavailability,
`max_entry_chars`, duplicate identities, vocabulary/cache caps, candidate or
synchronization budgets, or regex limits.

## Scopes

| Scope | Meaning |
| --- | --- |
| `session` | The current session, or the newest session for the current cwd. |
| `project` | All sessions in the current cwd's Pi session directory. |
| `global` | Sessions under the agent directory. This scope requires an explicit request and can never be the default. |
| `session:<id-or-path>` | One source session, hydrated explicitly without promotion. |

Duplicate session IDs are ambiguous. `session:<id>` and `memory.expand`
reject an ambiguous ID with `ambiguous_session` and list the candidate
paths. Pass the exact session file path from the cold pointer.
Duplicate normalized entry IDs and operation addresses also mark index
coverage incomplete, with `duplicate_entry_id` or
`duplicate_operation_address`. Stable-address expansion demands exactly one
record. Zero matches return `address_not_found`. More than one match
returns `ambiguous_address`. Fabric returns no source records in either case.

## Pointers, hydration, and expansion

A cold result carries session identity alone:

```ts
{
  tier: "cold",
  sessionId,
  sessionFile,
  sourceHash,
  branches,
  lineageFingerprint,
  matchedTerms,
  matchedStructuralEntries
}
```

The pointer keeps disjoint term occurrences distinct. It never merges them
into one misleading inclusive range, and its list of exact matches stays
complete. Hydrate the exact path and pass the pointer hash:

```ts
memory.recall({
  scope: `session:${pointer.sessionFile}`,
  branches: pointer.branches,
  expectedSourceHash: pointer.sourceHash,
  expectedLineageFingerprint: pointer.lineageFingerprint,
  query: "rare_token"
})
```

Hydrated and hot segments include `exactMatches` with the exact normalized
entry index, entry ID, and operation address. Recall first groups every
retained hot match into entry segments, merges those segments with cold
pointers, ranks the combined item stream globally, and applies
`page`/`pageSize` only at the end. Several matches inside one segment
count as one paginated item. Responses expose stable `totalItems`,
`totalMatches`, and `hasNext` for that retained stream. No-query browse
takes the same pagination path, and no earlier 25-entry or `maxSessions`
cap applies. An optional inclusive `entryRange` can bound hydration. Both
endpoints must be valid session indices. Out-of-range or negative
addresses return structured `index_out_of_bounds` errors. Clamping and
silent dropping never occur.

`memory.expand` re-reads full, untruncated source text. It accepts indices,
stable entry IDs, operation addresses, or an inclusive range:

```ts
memory.expand({
  session: pointer.sessionFile,
  branches: pointer.branches,
  expectedSourceHash: pointer.sourceHash,
  expectedLineageFingerprint: pointer.lineageFingerprint,
  indices: [12, 14]
})
memory.expand({ session: pointer.sessionFile, entryIds: ["entry-uuid"] })
memory.expand({ session: pointer.sessionFile, operationAddresses: ["entry-uuid/7"] })
```

During hydration and expansion, Fabric compares `expectedSourceHash` with
the current source and `expectedLineageFingerprint` with the selected live
or persisted lineage. If a rewrite, an append, or active-leaf navigation
changes an expected binding, the call returns a structured `stale_pointer`
and no source content. Results carry source hash, branch mode, and lineage
fingerprint, so callers can retain pointer integrity. Under active mode, an
off-lineage stable address returns `address_not_found`. An explicit
`branches: "all"` request is the only way to expand that address.

A valid `FabricExecutionTraceV1` on an outer `fabric_exec` result emits one
child record per operation, placed immediately after the outer normalized
entry. Each child keeps `parentEntryId`, `operationAddress`, the exact
`toolName`, `ref`, `provider`, `action`, typed `filesTouched`, `outcome`,
and a bounded structured `operation` object. Expansion re-reads and
re-normalizes source. Fabric never reconstructs operations from output
prose.

Valid `FabricBranchSummaryDetailsV1` and V2 envelopes emit typed child
records for user, phase, and operation facts. Under V2, they also emit
children for named `fabricRun` facts. Run children keep the bounded declared
name and description, the paired aggregate outcome, and the original call
address. They index as `fabric_exec` and expand by that operation address.
Other children keep the original fact address, the
ref/provider/action/tool/outcome/arguments values, and the structurally
derived paths, plus `carrierEntryId`, `carrierParentId`, and
`carrierFromId`. Operation facts expand by their original operation address.
User and phase facts use that address as their stable entry ID. Fabric
deduplicates repeated nested summaries by exact fact address in source
order, which keeps the earliest carrier deterministic. Inside each consumed
details envelope, addresses must be unique. Fabric rejects an envelope with
a duplicate address and marks coverage incomplete. Unknown or malformed
details and all branch-summary prose remain non-semantic.

## Local-cache privacy and deletion

Treat the memory index as local derived state. It sets no encryption or
semantic-privacy boundary. Depending on configuration and tier, cache JSON
can retain plaintext lexical vocabulary, cwd and file paths, source
pointers and hashes, structural tool and capability metadata, selected
user/assistant/custom-message content, tool arguments, and selected tool
output when the default `indexToolOutput: true` applies. Cold vocabulary
holds no posting lists. The exact words still appear in it as plaintext.
Thinking text stays excluded by default. Enabling it explicitly stores it
as plaintext. Fabric runs no secret scanning. Privacy here comes from
structural inclusion or exclusion, and regex classification plays no
part.

Fabric requests `0700` for cache directories and `0600` for cache files.
These permissions are best effort and inherit the host filesystem, account,
backup, and administrative trust model. The cache stays unencrypted. Fabric
reads project configuration only for a project that Pi has marked trusted.
Otherwise, only global Fabric configuration applies. A `global` memory
search is an explicit scope, never the default. Under that explicit scope,
global indexing still creates local derived records for the sessions that
the call selects.

Deleting a Pi session removes the source of truth. A later memory refresh
removes the orphaned cache records on a best-effort basis. When immediate
cache removal is required, delete the configured `memory.indexDir` as
well.
Removing that directory is safe, because every record is disposable and
rebuilt from the remaining session JSONL. Cache deletion leaves source
sessions, filesystem backups, and copies outside the index directory
untouched.

## Benchmarking capability-head retrieval

After changes to discovery, structural postings, ranking, or cache layout,
run the deterministic synthetic benchmark:

```sh
pnpm benchmark:memory-heads
```

The benchmark reports catalog head selection separately from source
retrieval, hot exact operation-address recall, cold session recall, combined
lexical + structural retrieval, negative controls, the cold digest/source
ratio, and p50/p95/p99 search latency. The command fails when catalog
description text leaks into lexical matches, structural provenance is lost,
cold combined candidates omit the hydration requirement, or a nonexistent
ref returns history. Repository tests cover source JSONL, branches, staleness, and cache generation.
The synthetic timing corpus covers the measured search paths.

## Configuration

```json
{
  "memory": {
    "enabled": true,
    "indexDir": "~/.pi/agent/fabric/memory-index",
    "maxSessions": 500,
    "maxEntryChars": 2000,
    "indexThinking": false,
    "indexToolOutput": true,
    "hotSessions": 50,
    "maxColdVocabularyBytes": 524288,
    "maxColdCacheBytes": 1048576,
    "maxSyncSessions": 10000,
    "maxSyncSourceBytes": 536870912,
    "maxCacheCleanupFiles": 100000,
    "regexMaxPatternBytes": 1024,
    "regexMaxHaystackTerms": 20000,
    "regexMaxHaystackBytes": 2097152,
    "regexTimeoutMs": 250
  }
}
```

- `maxSessions`: limits session-list discovery only. Candidate and indexing
  budgets control recall.
- `maxEntryChars`: Unicode-scalar limit for persisted hot entry text. Any
  cut marks lexical coverage incomplete, and expand still re-reads full
  source.
- `indexThinking`: when true, assistant thinking blocks enter normalized
  text and lexical vocabulary. Default: false.
- `indexToolOutput`: when true, tool-result bodies, bash output, and typed
  Fabric operation results enter derived text. Default: true. Coding recall then includes tool outputs. When false, typed tool name/ref/action,
  error/outcome, and structurally extracted path metadata stay searchable.
  Output bodies do not.
- `hotSessions`: count of globally newest sessions that keep hot shards.
- `maxColdVocabularyBytes`: per-session bound on the canonical vocabulary.
- `maxColdCacheBytes`: hard per-session bound on the cold cache file.
- `maxSyncSessions` / `maxSyncSourceBytes`: work budgets for synchronous
  indexing.
- `maxCacheCleanupFiles`: count budget for synchronous cache-file cleanup.
  Cleanup bytes draw on `maxSyncSourceBytes`.
- `regexMaxPatternBytes`, `regexMaxHaystackTerms`,
  `regexMaxHaystackBytes`, `regexTimeoutMs`: bounds on isolated regex
  execution.
