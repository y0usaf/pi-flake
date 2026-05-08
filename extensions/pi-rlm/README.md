# pi-rlm

Pi-native RLM (Recursive Language Model) extension.

Pi mapping:

- Pi tools (`bash`, `read`, `edit`, `write`) are the REPL/toolkit.
- Paths + cwd + scratch files are the external context store.
- Child Pi sessions are recursive child RLM sub-calls.
- All RLM calls use the **same model as the parent Pi session**. No model override field.

## One tool

```ts
rlm({ call, prompt?, prompts?, items?, context?, contextMode?, paths?, ... })
```

Accepted `call` values only:

| `call` | RLM equivalent | What it does |
|---|---|---|
| `"llm_query"` | `llm_query()` | Single-shot LM completion. No tools. Include all context inline. |
| `"llm_query_batched"` | `llm_query_batched()` | Multiple independent single-shot LM completions, bounded concurrency. Results preserve order. |
| `"rlm_query"` | `rlm_query()` | Recursive child RLM sub-call. Child gets bash/read + `rlm` + `pi_return`; when paths/large context are supplied it also gets `ctx` for capped manifest/grep/peek over file-backed context. |
| `"rlm_query_batched"` | `rlm_query_batched()` | Multiple recursive child RLM sub-calls, bounded concurrency. |

Child-only finalization tool:

```ts
pi_return({ answer }) // FINAL(...)
```

Child-only context tool, present when a file-backed context store exists:

```ts
ctx({ action: "manifest" })
ctx({ action: "grep", query: "oauth", source: "s0", maxMatches: 50 })
ctx({ action: "peek", source: "s0", chars: 4000, offset: 0 })
```

Root tools:

```text
bash, read, edit, write, rlm
```

When `rlm` is active, pi-rlm replaces the root system prompt with an RLM-first coordinator prompt instead of appending guidance to Pi's default prompt. The replacement keeps core Pi tool/edit rules and makes broad exploration/decomposition delegate-first.

Child tools:

```text
bash, read, [ctx], rlm, pi_return
```

`edit`/`write` are added for children only when `allowWrites=true`. Temporary scratch writes inside the context store are allowed via bash.

## File-backed context mode

This is the RLM context-management distinction: large context stays outside model messages as files, while the child only pulls compact observations into chat.

- `paths` are always file-backed context sources.
- `contextMode: "auto"` (default): short `context` is inline; large `context` (>20k chars) is written to a temp file.
- `contextMode: "file_backed"`: force `context` into a temp file even if short.
- `contextMode: "inline"`: keep `context` inline (old behavior; still clipped for child prompts).

For recursive calls with file-backed context, the extension creates an ephemeral temp dir:

```text
/tmp/pi-rlm-*/
  README.md
  manifest.txt
  manifest.json
  inline-context.txt   # only when context was materialized
  scratch/             # child may write intermediate artifacts here
```

The child gets `ctx` for capped access:

```ts
ctx({ action: "manifest" })
ctx({ action: "grep", query: "needle", maxMatches: 20 })
ctx({ action: "peek", source: "s0", chars: 4000 })
```

The temp store is deleted after the child returns; final answers must include all needed findings.

## Examples

```ts
rlm({
  call: "llm_query",
  prompt: "Summarize this excerpt:\n...text..."
})
```

```ts
rlm({
  call: "llm_query_batched",
  prompts: [
    "Summarize chunk 1:\n...",
    "Summarize chunk 2:\n..."
  ],
  maxConcurrent: 4
})
```

```ts
rlm({
  call: "rlm_query",
  prompt: "Inspect these files for auth design claims.",
  paths: ["docs/auth.md", "src/auth/"]
})
```

```ts
rlm({
  call: "rlm_query_batched",
  items: [
    { prompt: "Analyze frontend routing", paths: ["src/frontend"] },
    { prompt: "Analyze backend auth", paths: ["src/backend/auth"] },
    { prompt: "Analyze migrations", paths: ["migrations"] }
  ],
  maxConcurrent: 3
})
```

```ts
rlm({
  call: "rlm_query",
  prompt: "Answer over this large pasted corpus without putting it all in chat.",
  context: hugeText,
  contextMode: "file_backed"
})
```

## Strict API

No compatibility aliases. No model routing.

Accepted fields:

- `call`
- `prompt`
- `context`
- `contextMode`
- `paths`
- `prompts`
- `items`
- `allowWrites`
- `maxDepth`
- `maxTurns`
- `maxCalls`
- `maxQueries`
- `maxConcurrent`

`llm_query` and `llm_query_batched` do not accept `paths` or `contextMode: "file_backed"`; they have no environment/tools. Extract text with `bash`/`read`, then pass that text in `prompt` or `context`, or use `rlm_query`.

## Defaults

- `maxDepth`: 4. At the cap, `rlm_query` falls back to a plain LM call.
- `maxTurns`: 20 per recursive child RLM
- `maxCalls`: 32 recursive child RLM calls across the tree
- `maxQueries`: 64 plain `llm_query` calls across the tree
- `maxConcurrent`: 4
- `contextMode`: `"auto"` (short inline context; large recursive context materialized to temp file; paths always file-backed)
