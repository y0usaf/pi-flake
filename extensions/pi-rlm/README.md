# pi-rlm

Pi-native RLM (Recursive Language Model) conversion extension.

Pi mapping:

- `rlm_repl` is the upstream-style programmable REPL/control plane.
- `rlm` exposes the four RLM primitives directly.
- Paths + cwd + scratch files are the external context store.
- Child Pi sessions are recursive child RLM sub-calls.
- RLM calls default to the parent Pi session model, or to models configured under `extensionSettings.pi-rlm`.

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

Child RLM sessions are isolated from normal extensions/skills and get an explicit tool whitelist. Default child profile is `childMode: "pure-rlm"`:

```text
rlm_repl, pi_return
```

In pure-RLM mode, context/files/process access goes through REPL helpers (`bash()`, `read_file()`, `ctx.*()`, `llm_query()`, `rlm_query()`), not direct Pi agent tools. `rlm_repl` `FINAL(...)`/`FINAL_VAR(...)` also completes the child.

Use `childMode: "pi-agent"` to preserve the previous broader child behavior:

```text
bash, read, [ctx], rlm_repl, rlm, pi_return
```

`edit`/`write` are added for `pi-agent` children only when `allowWrites=true`. Temporary scratch writes inside the context store are always possible through REPL/bash helpers.

## REPL tool

```ts
rlm_repl({ code, reset?, timeoutMs?, data?, setup?, resetHistory? })
```

The REPL runs Python in a persistent worker process. Helpers are synchronous; do **not** use `await`. Persist cross-call variables as Python globals or in the `state` dict. The worker also exposes upstream-style `history`, `context`, and `context_N` variables when a context store is attached.
`timeoutMs` limits local Python execution time only; it is paused while synchronous bridge helpers such as `rlm_query()`, `llm_query()`, `bash()`, `read_file()`, or `ctx.*()` are running, so long child RLM calls are governed by their own budgets instead of being cut off by the REPL wrapper. `data` injects JSON-serializable variables; `setup` runs Python setup code before the main eval; `resetHistory` clears REPL history.

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
rlm_details(params)                  # dict: rich result, same as rlm(params)
llm_query_details(prompt_or_params)  # dict with text/content/details
rlm_query_details(prompt_or_params)  # dict with text/content/details
llm_query_batched_details(...)       # dict with batch details
rlm_query_batched_details(...)       # dict with batch details

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
ctx.sources        # compact source summaries
ctx.sourceObjects  # structured source metadata including paths
ctx.inlineInputs   # recent small inputs mirrored into the local REPL
ctx.latestInput
ctx.latestInputText
latest_input       # top-level alias for ctx.latestInput
latest_input_text  # top-level alias for ctx.latestInputText
inline_inputs      # top-level alias for ctx.inlineInputs
```

The Python executable is resolved as `PI_RLM_PYTHON` if set, otherwise `python3`. The repo's `pi-full` wrapper sets this to its Nix `python3`.
This is a power tool, not a sandbox: Python code can access the local filesystem/process environment just like a normal local REPL.

## Direct RLM tool

```ts
rlm({ call, prompt?, rootPrompt?, prompts?, items?, context?, contextMode?, childMode?, paths?, sources?, contextName?, logPath?, logDir?, ...budgets })
```

Accepted `call` values only:

| `call` | RLM equivalent | What it does |
|---|---|---|
| `"llm_query"` | `llm_query()` | Single-shot LM completion. No tools. Include all context inline. |
| `"llm_query_batched"` | `llm_query_batched()` | Multiple independent single-shot LM completions, bounded concurrency. Results preserve order. |
| `"rlm_query"` | `rlm_query()` | Recursive child RLM sub-call. Default `childMode:"pure-rlm"` exposes `rlm_repl` + `pi_return`; context access is via REPL helpers (`ctx.*` when file-backed context exists). `childMode:"pi-agent"` restores direct bash/read + `rlm_repl` + `rlm` + `pi_return` and direct `ctx` for file-backed context. |
| `"rlm_query_batched"` | `rlm_query_batched()` | Multiple recursive child RLM sub-calls, bounded concurrency. |

Common optional fields:
- `rootPrompt`: small visible question/instruction analogous to upstream `root_prompt`, kept separate from large `context`.

- `logPath` / `logDir`: write JSONL trajectory events (`dispatch_start`, `dispatch_end`, `dispatch_error`) for replay/debugging.
- Budgets: `maxDepth`, `maxTurns`, `maxCalls`, `maxQueries`, `maxConcurrent`, plus `maxTimeoutMs`/`maxTimeout`, `maxTokens`, `maxBudget`, `maxErrors`. Upstream-style aliases are accepted for common names (`max_depth`, `max_timeout`, `max_tokens`, `max_budget`, `max_errors`, `max_iterations`, `max_concurrent_subcalls`).

Model selection is configuration-only, not per-call. In `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "extensionSettings": {
    "pi-rlm": {
      "models": ["openai/gpt-5.4-mini"]
    }
  }
}
```

Accepted shapes include a string (`"pi-rlm": "openai/gpt-5.4-mini"`), `{ "model": "openai/gpt-5.4-mini" }`, `{ "provider": "openai", "model": "gpt-5.4-mini" }`, or role-specific `{ "models": { "llm": "...", "rlm": "..." } }`.

Child-only finalization tool:

```ts
pi_return({ answer }) // equivalent to rlm_repl FINAL(...)
```

Child-only context tool, present when a file-backed context store exists and `childMode:"pi-agent"` is used. In default `pure-rlm`, use the same actions through REPL `ctx.*` helpers:

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


## Root/session RLM context store

`pi-rlm` now creates a persistent context store for the active Pi session and attaches it to the root `rlm_repl`. This makes the root closer to the RLM paper/article design: large inputs live outside the model prompt, while the model explores them through Python.

What changes at the root:

- `rlm_repl` usually has `ctx.manifest()`, `ctx.grep(...)`, `ctx.peek(...)`, `ctx.extract(...)`, `ctx.note(...)`, and `ctx.artifact(...)` even outside child RLM calls.
- User inputs are saved as file-backed session context sources.
- Very large user inputs are externalized before the agent turn by default (`PI_RLM_ROOT_EXTERNALIZE_CHARS`, default `20000`). The model receives a compact replacement message naming the source id/path plus a small preview.
- Smaller inputs remain in the normal user message but are also mirrored into the local REPL when under `PI_RLM_ROOT_INLINE_REPL_CHARS` (default `20000`) as `latest_input_text`, `latest_input`, `inline_inputs`, and `ctx.latestInputText`.
- The full saved input is written under the session context store; externalized large inputs are not copied into the model context.
- Root `rlm` calls and `rlm_repl` calls to `rlm_query` / `rlm_query_batched` inherit session context sources when the call does not provide explicit `context`, `paths`, or `sources`.

Example after a large prompt is externalized:

```python
print(ctx.manifest())
print(latest_input_text[:1000] if latest_input_text else "large input: use ctx.peek")
print(ctx.peek("s0", chars=4000))
print(ctx.grep("festival", source="s0", maxMatches=20))

answer = rlm_query("Answer the user's question by inspecting the inherited session context.")
FINAL(answer)
```

Notes:

- The Python variable `context` is still metadata, not the whole document string. Use `latest_input_text` for the latest small input and `ctx.peek`/`ctx.grep`/`ctx.extract` for file-backed content.
- Set `PI_RLM_ROOT_EXTERNALIZE_CHARS=0` to disable root input replacement while still saving inputs to the session store.
- Set `PI_RLM_ROOT_INLINE_REPL_CHARS=0` to disable mirroring small inputs into REPL variables.
- Session context stores are kept under Pi's session directory (`.../rlm-context/<session-id>/`) so transformed session history can be replayed with its externalized sources.

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

The default pure-RLM child gets REPL `ctx.*` helpers for capped access (`pi-agent` exposes the same `ctx` as a direct tool):

```ts
ctx({ action: "manifest", format: "json" })
ctx({ action: "grep", query: "needle", maxMatches: 20, before: 1, after: 2 })
ctx({ action: "peek", source: "s0", chars: 4000 })
ctx({ action: "extract", ranges: [{ source: "s0", line: 5, lines: 25 }] })
```

The temp store is deleted after the child returns; final answers must include all needed findings.

`ctx.grep` skips very large, binary-looking, and unreadable files while reporting the skipped count; direct `ctx.peek`/`ctx.extract` remain explicit capped reads.

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

## API fields and compatibility

The API remains strict about unknown fields, but now accepts a small set of upstream-style aliases for runtime controls. Model selection lives in `extensionSettings.pi-rlm`, not in tool call params.

Accepted `rlm` fields:

- `call`
- `prompt`
- `rootPrompt`

- `context`
- `contextMode`
- `childMode` (`"pure-rlm"` default, or `"pi-agent"`)
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
- `maxTimeoutMs` / `maxTimeout` / `max_timeout`
- `maxTokens` / `max_tokens`
- `maxBudget` / `max_budget`
- `maxErrors` / `max_errors`
- `maxIterations` / `max_iterations` (alias for `maxTurns`)
- `max_depth` (alias for `maxDepth`)
- `max_concurrent_subcalls` (alias for `maxConcurrent`)
- `logPath`
- `logDir`

Accepted `rlm_repl` fields:

- `code`
- `reset`
- `timeoutMs`
- `data`
- `setup`
- `resetHistory`

`llm_query` and `llm_query_batched` do not accept `paths`, `sources`, or `contextMode: "file_backed"`; they have no environment/tools. Extract text first, pass it as `prompt`/`context`, or use `rlm_query`.

## Defaults

- `maxDepth`: 4. At the cap, `rlm_query` falls back to a plain LM call.
- `maxTurns`: 20 per recursive child RLM
- `maxCalls`: 32 recursive child RLM calls across the tree
- `maxQueries`: 64 plain `llm_query` calls across the tree
- `maxConcurrent`: 4
- `maxTimeoutMs`, `maxTokens`, `maxBudget`, `maxErrors`: unset/0 = unlimited (tracked token/cost data depends on provider usage metadata)
- `contextMode`: `"auto"` (short inline context; large recursive context materialized to temp file; paths always file-backed)
- `childMode`: `"pure-rlm"` (only `rlm_repl` + `pi_return` exposed directly); use `"pi-agent"` for previous broader child tool whitelist
- `rlm_repl.timeoutMs`: 30s default, 120s hard cap for local Python execution; paused while bridge helpers run
