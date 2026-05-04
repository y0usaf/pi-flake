# pi-context-janitor

A Pi extension that runs a lightweight **sidecar summarizer** in the background while a session is running.

It watches completed tool-call turns, summarizes them with a cheap/fast model, injects a compact summary, and prunes the original tool-result messages from future LLM context only after the summary is visible.

The raw tool outputs are never deleted. They are stored in a session index and can be recovered with `context_janitor_query`.

By default it is hands-off: `enabled=true`, `summarizerModel="auto"`, and pruning starts only after enough pending tool output accumulates or context usage gets high.

## Why this shape?

Literal constant prompt rewriting can thrash provider prefix caches. This extension instead does:

1. Capture completed tool-result batches on `turn_end`
2. Debounce + summarize in the background
3. Commit only at future safe context boundaries
4. Filter old tool-result messages only when their summary is already in the active context
5. Keep exact raw outputs queryable by `toolCallId`

## Install / test

```bash
pi -e ./extensions/pi-context-janitor
```

Or bundle via this flake:

```bash
nix build .#pi-context-janitor
nix build .#pi-full
```

## Commands

| Command | Effect |
|---|---|
| `/janitor` or `/janitor status` | Show state, settings, pending work, savings |
| `/janitor auto` | Enable + reset hands-off defaults (`model=auto`, `thinking=off`, balanced thresholds) |
| `/janitor on` | Enable capture/pruning |
| `/janitor off` | Disable capture/pruning and abort active background summarization |
| `/janitor now` | Force-flush pending batches now |
| `/janitor model` | Show summarizer model |
| `/janitor model auto` | Auto-pick a cheap/fast available model, falling back to the active Pi model |
| `/janitor model <provider/model>` | Use explicit lightweight model |
| `/janitor model default` | Reuse the active Pi model |
| `/janitor model <provider/model>:<thinking>` | Set model + thinking level |
| `/janitor thinking <level>` | `default`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `/janitor threshold <chars> [toolCalls]` | Minimum pending raw chars/tool calls before auto flush |
| `/janitor usage <percent>` | Flush when context usage is at/above this percent; `0` disables this trigger |
| `/janitor debounce <ms>` | Delay before background summarizer starts |
| `/janitor help` | Help text |

Settings persist to:

```text
~/.pi/agent/context-janitor/settings.json
```

Default settings:

```json
{
  "enabled": true,
  "summarizerModel": "auto",
  "summarizerThinking": "off",
  "minRawChars": 8000,
  "minToolCalls": 8,
  "contextUsagePercent": 55,
  "debounceMs": 900,
  "maxInputChars": 60000,
  "maxSummaryTokens": 1200,
  "maxSummaryRatio": 0.7,
  "showStatus": true
}
```

## Tool: `context_janitor_query`

When a summary is inserted, it ends with the summarized IDs:

```text
Summarized toolCallIds: `abc123`, `def456`
Use `context_janitor_query` with these IDs to retrieve original outputs.
```

The model can call:

```json
{
  "toolCallIds": ["abc123"],
  "maxChars": 12000
}
```

## Recommended model

The default `summarizerModel: "auto"` does **no broad scoring**. It only tries these three fixed candidates:

| Provider | Auto model |
|---|---|
| OpenAI | `openai/gpt-5.4-mini` |
| Anthropic | `anthropic/claude-haiku-4-5` |
| Vercel AI Gateway | `vercel-ai-gateway/openai/gpt-5-nano` |

If the active provider is one of those three and that model is available, it uses that provider's candidate first. Otherwise it tries the list in order, then falls back to the active Pi model.

You can still pin a model:

```text
/janitor model openai/gpt-5.4-mini:low
/janitor model anthropic/claude-haiku-4-5:low
/janitor model vercel-ai-gateway/openai/gpt-5-nano:low
```

## Safety rules

- Summaries are committed only if they are smaller than raw tool results by `maxSummaryRatio`.
- Raw outputs stay in a session custom-entry index.
- The `context` filter prunes tool results only when the corresponding summary message is present in the active context.
- Session files still contain the original tool-result messages.
