# pi-claudish-to-english

Display-only plain-English rewrite of the final assistant message each turn,
ported from [gvzdv/claudish-to-english](https://github.com/gvzdv/claudish-to-english).

After each turn ends, the extension rewrites the final assistant message into
plain English and appends it as a `💬 In plain English: …` block. The original
message stays in the transcript and the model context — the agent keeps seeing
the original text; only what you read on screen changes.

## How it works

```
agent_end ─► last assistant message in branch
              │
              ├─ no text? (else skip)
              ├─ same text as last rewrite? (auto-retry guard, else skip)
              ├─ rewrite via the session model
              └─ append "💬 In plain English: …" custom entry
```

Custom entries never enter the LLM context, so the rewrite is display-only by
construction. Fail-open: no usable model, an empty rewrite, or a failed call
simply leaves the original message untouched.

## Install

Drop `extensions/claudish-to-english.ts` into `~/.pi/agent/extensions/` and run
`/reload`, or build it as part of this flake (`pi-claudish-to-english`).

## Configuration

None required — it uses the current session model. Set a different model for
rewrites by switching the session model.

## License

MIT.
