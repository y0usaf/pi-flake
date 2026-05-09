# pi-rlm

Pi-native RLM (Recursive Language Model) conversion extension.

Pi mapping:

- `rlm_repl` is the upstream-style programmable REPL/control plane.
- `rlm` exposes the four RLM primitives directly.
- Paths + cwd + scratch files are the external context store.
- Child Pi sessions are recursive child RLM sub-calls.
- All RLM calls use the **same model as the parent Pi session**. No model override field.

## Root conversion mode

By default, pi-rlm now disables Pi's default root tools and activates only this extension's RLM tools:

```text
rlm_repl, rlm
```

The root system prompt is replaced with an RLM-first coordinator prompt. The extension re-applies its root tool set on session start, session tree changes, before agent start, and before provider requests, similar to `pi-tool-management`.

This is a practical tool-set conversion, not a security sandbox: another extension that runs later can still rewrite active tools depending on hook order.

Configure root mode with `PI_RLM_ROOT_MODE`:

| Mode | Active root tools |
|---|---|
| unset / `hybrid` | `rlm_repl`, `rlm` |
| `repl` / `repl-only` | `rlm_repl` |
| `rlm` / `rlm-only` | `rlm` |
| `classic` / `tools` / `default` | `bash`, `read`, `edit`, `write`, `rlm_repl`, `rlm` |

Child RLM sessions are isolated from normal extensions/skills and get an explicit tool whitelist:

```text
bash, read, [ctx], rlm_repl, rlm, pi_return
```

`edit`/`write` are added for children only when `allowWrites=true`. Temporary scratch writes inside the context store are allowed via bash.

## REPL tool

```ts
rlm_repl({ code, reset?, timeoutMs? })
```

The REPL runs Python in a persistent worker process. Helpers are synchronous; do **not** use `await`. Persist cross-call variables as Python globals or in the `state` dict:
`timeoutMs` limits local Python execution time only; it is paused while synchronous bridge helpers such as `rlm_query()`, `llm_query()`, `bash()`, `read_file()`, or `ctx.*()` are running, so long child RLM calls are governed by their own budgets instead of being cut off by the REPL wrapper.

```python
import json
state["results"] = rlm_query_batched([
    {"prompt": "Analyze frontend routing", "paths": ["src/frontend"]},
    {"prompt": "Analyze backend auth", "paths": ["src/backend/auth"]},
])

summary = llm_query(
    "Synthesize these results:\n" + json.dumps(state["results"], indent=2)
)
FINAL(summary)
```

Available helpers:

```python
llm_query(prompt_or_params)          # str
llm_query_batched(prompts_or_params) # list[str]
rlm_query(prompt_or_params)          # str
rlm_query_batched(items_or_params)   # list[str]
rlm(params)                          # dict: {"text", "content", "details"}

bash(command, timeoutMs=..., maxBuffer=...)
read_file(path, offset=..., chars=...)
list_dir(path)
stat_file(path)

SHOW_VARS()
FINAL(value)
FINAL_VAR("name")
```

When a recursive child has a file-backed context store, the REPL also has:

```python
ctx.manifest(format="json")
ctx.grep("needle", source="s0", maxMatches=50, before=1, after=1)
ctx.peek("s0", offset=0, chars=4000)
ctx.peek("docs", file="guide.md", line=10, lines=40)
ctx.extract(source="s0", line=20, endLine=60)
ctx.note("compact findings", name="findings.md")
ctx.artifact(json_text, name="data.json")
ctx.scratchDir
ctx.notesDir
ctx.artifactsDir
ctx.sources
```

The Python executable is resolved as `PI_RLM_PYTHON` if set, otherwise `python3`. The repo's `pi-full` wrapper sets this to its Nix `python3`.
This is a power tool, not a sandbox: Python code can access the local filesystem/process environment just like a normal local REPL.

## Direct RLM tool

```ts
rlm({ call, prompt?, prompts?, items?, context?, contextMode?, paths?, sources?, contextName?, ... })
```

Accepted `call` values only:

| `call` | RLM equivalent | What it does |
|---|---|---|
| `"llm_query"` | `llm_query()` | Single-shot LM completion. No tools. Include all context inline. |
| `"llm_query_batched"` | `llm_query_batched()` | Multiple independent single-shot LM completions, bounded concurrency. Results preserve order. |
| `"rlm_query"` | `rlm_query()` | Recursive child RLM sub-call. Child gets bash/read + `rlm_repl` + `rlm` + `pi_return`; when paths/large context are supplied it also gets `ctx` for capped manifest/grep/peek/extract over file-backed context. |
| `"rlm_query_batched"` | `rlm_query_batched()` | Multiple recursive child RLM sub-calls, bounded concurrency. |

Child-only finalization tool:

```ts
pi_return({ answer }) // FINAL(...)
```

Child-only context tool, present when a file-backed context store exists:

```ts
ctx({ action: "manifest" })                       // text
ctx({ action: "manifest", format: "json" })       // JSON string
ctx({ action: "grep", query: "oauth", source: "s0", maxMatches: 50, contextLines: 2 })
ctx({ action: "peek", source: "s0", chars: 4000, offset: 0 })
ctx({ action: "peek", source: "docs", file: "guide.md", line: 10, lines: 40 })
ctx({ action: "extract", source: "s0", line: 20, endLine: 60 })
ctx({ action: "note", name: "findings.md", text: "..." })
ctx({ action: "artifact", name: "data.json", text: "..." })
```

## File-backed context mode

This is the RLM context-management distinction: large context stays outside model messages as files, while the child only pulls compact observations into chat.

- `paths` are always file-backed context sources (backwards compatible).
- `sources: [{ name?, path }]` adds named file-backed sources; selectors match id, name, label, input/path/relPath/basename.
- `contextName` names materialized inline context in the manifest.
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
  notes/               # ctx note outputs
  artifacts/           # ctx artifact outputs
```

The child gets `ctx` for capped access:

```ts
ctx({ action: "manifest", format: "json" })
ctx({ action: "grep", query: "needle", maxMatches: 20, before: 1, after: 2 })
ctx({ action: "peek", source: "s0", chars: 4000 })
ctx({ action: "extract", ranges: [{ source: "s0", line: 5, lines: 25 }] })
```

The temp store is deleted after the child returns; final answers must include all needed findings.

## Examples

Direct one-shot:

```ts
rlm({
  call: "llm_query",
  prompt: "Summarize this excerpt:\n...text..."
})
```

Direct batched one-shots:

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

Recursive child with file-backed paths/named sources:

```ts
rlm({
  call: "rlm_query",
  prompt: "Inspect these files for auth design claims.",
  paths: ["docs/auth.md"],
  sources: [{ name: "auth-src", path: "src/auth/" }]
})
```

REPL fan-out and synthesis:

```ts
rlm_repl({
  code: `
import json

state["results"] = rlm_query_batched([
    {"prompt": "Analyze frontend routing", "paths": ["src/frontend"]},
    {"prompt": "Analyze backend auth", "paths": ["src/backend/auth"]},
    {"prompt": "Analyze migrations", "paths": ["migrations"]},
], maxConcurrent=3)

summary = llm_query("Synthesize these findings:\\n" + json.dumps(state["results"], indent=2))
FINAL(summary)
`
})
```

Large pasted corpus via file-backed context:

```ts
rlm({
  call: "rlm_query",
  prompt: "Answer over this large pasted corpus without putting it all in chat.",
  context: hugeText,
  contextMode: "file_backed"
})
```

## Strict APIs

No compatibility aliases. No model routing.

Accepted `rlm` fields:

- `call`
- `prompt`
- `context`
- `contextMode`
- `paths`
- `sources`
- `contextName`
- `prompts`
- `items`
- `allowWrites`
- `maxDepth`
- `maxTurns`
- `maxCalls`
- `maxQueries`
- `maxConcurrent`

Accepted `rlm_repl` fields:

- `code`
- `reset`
- `timeoutMs`

`llm_query` and `llm_query_batched` do not accept `paths`, `sources`, or `contextMode: "file_backed"`; they have no environment/tools. Extract text first, pass it as `prompt`/`context`, or use `rlm_query`.

## Defaults

- `maxDepth`: 4. At the cap, `rlm_query` falls back to a plain LM call.
- `maxTurns`: 20 per recursive child RLM
- `maxCalls`: 32 recursive child RLM calls across the tree
- `maxQueries`: 64 plain `llm_query` calls across the tree
- `maxConcurrent`: 4
- `contextMode`: `"auto"` (short inline context; large recursive context materialized to temp file; paths always file-backed)
- `rlm_repl.timeoutMs`: 30s default, 120s hard cap for local Python execution; paused while bridge helpers run
