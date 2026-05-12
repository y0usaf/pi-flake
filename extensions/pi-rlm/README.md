# pi-rlm

Pi-hosted Recursive Language Model (RLM) extension using the upstream-style REPL contract from Alex Zhang's `rlm` implementation.

The model-visible surface is intentionally small:

```text
repl
```

Inside `repl`, the public Python namespace exposes only the RLM primitives and REPL state/context variables:

```python
llm_query(prompt, model=None)          # -> str
llm_query_batched(prompts, model=None) # -> list[str]
rlm_query(prompt, model=None)          # -> str
rlm_query_batched(prompts, model=None) # -> list[str]

FINAL_VAR("name")
SHOW_VARS()

state
history
context
context_0
context_N
# plus injected custom data/tools
```

The REPL does **not** expose Pi-specific helper APIs:

```text
rlm(...)
FINAL(...)
pi_return
ctx.*
bash
read_file
list_dir
stat_file
*_details helpers
```

Use normal Python capabilities instead: `import os`, `pathlib`, `json`, `subprocess`, `open()`, loops, slicing, regexes, etc.

## Behavior

- Root and child RLM sessions use the same REPL contract.
- `llm_query` / `llm_query_batched` are one-shot leaf LM calls.
- `rlm_query` / `rlm_query_batched` spawn hidden in-memory child Pi sessions constrained to the same REPL-only RLM contract.
- Child sessions receive the child RLM prompt as the actual provider system prompt/instructions payload, disable default Pi tools/extensions/skills/context-file discovery, and assert that `repl` is the only active tool.
- At the configured/default max depth, `rlm_query` falls back to a plain LM leaf call; setting `maxDepth` to `0` or a negative number disables that depth cap.
- Leaf calls are sent with an explicit system prompt/instructions payload so providers that require an `instructions` field (for example Codex Responses) work correctly.
- Finalization is done by assigning the answer to a variable or `state` key and calling `FINAL_VAR("name")`. The REPL tool result records the final variable name/value in structured `details` and only returns a small placeholder in visible tool content; it does not duplicate the answer as `FINAL:` text.
- In interactive/RPC UI contexts, a finalized root REPL answer is displayed as a visible custom message with `customType: "rlm_final"`. This keeps the final answer visible even when tool rows are compacted by UI extensions such as `pi-compact`; the custom message is filtered out of future LLM context, so the final answer lives in the REPL variable channel rather than normal chat history. The live renderer uses Pi's native Markdown component with the custom-message color family, so headings/lists/code blocks render normally while matching the VCC-style palette instead of looking like a generic tool-success row.
- Direct assistant prose is not a valid answer channel in root pi-rlm sessions. If a model emits text outside a REPL tool call, pi-rlm strips that text from the persisted/context message and only `repl`/`FINAL_VAR` output is accepted.

## Recursive-default policy

`pi-rlm` is intended to behave like the upstream RLM control loop, not like a normal chat agent that happens to have a REPL. The prompts and tool guidance make recursion the default path for broad work:

- Use `rlm_query` / `rlm_query_batched` for multi-file, multi-source, audit/review, uncertain, long-context, or naturally parallel subtasks.
- Use `llm_query` / `llm_query_batched` only for narrow one-shot leaf extraction/classification/summarization over already extracted text.
- Prefer batched recursive child calls for independent chunks/subtasks.
- Final answers must come through `FINAL_VAR`, not a direct chat answer. Direct assistant prose is suppressed from future context.

Example:

```python
chunks = ["...", "..."]
state["summaries"] = llm_query_batched([
    "Summarize this chunk:\n" + chunk for chunk in chunks
])
answer = "\n\n".join(state["summaries"])
FINAL_VAR("answer")
```

Recursive example:

```python
prompts = [
    "Analyze part A using the available context.",
    "Analyze part B using the available context.",
]
state["findings"] = rlm_query_batched(prompts)
answer = llm_query("Synthesize:\n" + repr(state["findings"]))
FINAL_VAR("answer")
```

## Context management

Pi may persist large user inputs and inherited sources outside model chat, but the REPL receives them as actual Python context variables:

```python
context      # alias for context_0
context_0
context_1
context_2
...
```

Use `SHOW_VARS()` to see what is loaded. For large strings, search/slice in Python and print compact observations only.

Externalized user input messages name the source id and corresponding `context_N` variable. Inspect that variable in `repl`; do not answer from the preview alone unless the preview fully contains the task.

## Tool policy

The active root Pi tool set is exactly:

```text
repl
```

Child RLM sessions also expose only `repl`. There is no separate public `rlm` tool, `ctx` tool, or `pi_return` tool.

## Configuration

Model selection defaults to the parent Pi session model unless `extensionSettings.pi-rlm` selects a model. When a selector is configured, pi-rlm enforces it for both the root coordinator session and recursive child calls so an expensive normal Pi default does not leak into RLM runs.

```json
{
  "extensionSettings": {
    "pi-rlm": {
      "models": {
        "root": "openai/gpt-5.4-mini",
        "llm": "openai/gpt-5.4-mini",
        "rlm": "openai/gpt-5.4-mini"
      },
      "maxConcurrent": 3,
      "maxDepth": 3
    }
  }
}
```

For simple installs, this is equivalent and applies to `root`, `llm`, and `rlm` unless a role-specific selector overrides it:

```json
{
  "extensionSettings": {
    "pi-rlm": {
      "models": ["openai/gpt-5.4-mini"]
    }
  }
}
```

If you use a role-object config and omit `root`, the root coordinator falls back to the `rlm` selector, then `llm`, so existing `llm`/`rlm` submodel configs also protect the root coordinator. Set `"enforceRootModel": false` only if you intentionally want the root RLM coordinator to keep the current Pi session model while child calls use the configured submodel.

The optional `model` argument to `llm_query(..., model=...)` / `rlm_query(..., model=...)` can select a Pi-known model by id/name or `provider/model-id`. The extension also accepts `maxConcurrent` and `maxDepth` in `extensionSettings.pi-rlm` as local defaults for this install, overridden by per-call params. Omitted limits use pi-rlm's guardrail defaults; set a limit to `0` or a negative number to disable that cap.

## Limits

Runtime controls are enforced internally. For recursion controls, omitted values use guardrail defaults and `0` or negative values disable the cap:

- `maxDepth` default `5`
- `maxTurns` / `maxIterations` default `30`
- `maxCalls` default `128`
- `maxQueries` default `256`
- `maxConcurrent` default `5`

Other budget controls default to unlimited/no explicit cap when omitted or `<=0`:

- `maxTimeoutMs` / `maxTimeout`
- `maxTokens`
- `maxBudget`
- `maxErrors`

These are internal dispatch parameters for recursive calls; the model-facing REPL API remains the upstream-style helper functions above.
