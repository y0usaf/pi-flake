# pi-continue

`/continue` (or **ctrl+g**) resumes a lagged-out assistant stream by starting a fresh provider request with the previous assistant message as a prefill. The short custom marker is hidden from the TUI and stripped by the `context` hook, so it is absent from the provider payload.

The extension refuses to send unless pi is idle and the transcript ends with a completed assistant message without tool calls; it reports the reason in a notification.

Provider caveats: Anthropic provides true prefill semantics. OpenAI Chat Completions accepts a trailing assistant message but starts a new message. OpenAI Responses API has no prefill semantics. Anthropic prefill breaks with extended thinking enabled.
