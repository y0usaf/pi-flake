# pi-context-janitor

A Pi extension that asks a lightweight sidecar model which completed tool outputs can be truncated from future model context.

Flow:

1. Capture completed tool-result JSON objects after a turn.
2. Assign each object a stable hash.
3. Send only those id/hash objects + bounded previews to a lightweight model.
4. Accept only hash-matching `truncate` decisions.
5. Keep the raw session log untouched.
6. Project future context with an invisible placeholder instead of the raw tool output.
7. Store janitor run metadata as hidden custom entries.
8. Restore selected janitor runs with `/janitor undo`.

Janitor has hysteresis: it waits for a small backlog before asking the sidecar model. By default it runs after ≥6 pending tool results, ≥16k raw chars, or when the oldest pending batch is ≥60s old.

Successful janitor runs are intentionally silent: no transcript messages are injected. Future LLM context gets only a zero-width placeholder for each cleaned tool result so the tool-call protocol stays valid without bloating context. Legacy visible janitor summary messages from older versions are suppressed by a hidden renderer.

## Install / test

```bash
# From repo root
pi -e ./extensions/pi-context-janitor

# Or build the package
nix build .#pi-context-janitor
```

## Commands

| Command | Description |
|---|---|
| `/janitor on` | Enable janitor projection |
| `/janitor off` | Disable janitor projection + cancel pending background work |
| `/janitor undo` | Open the restore picker |

`/janitor off` makes raw tool outputs visible to future model context again. It does not delete janitor history.

## Undo UX

```text
/janitor undo

Restore janitor actions

› [ ] 05/04, 12:31  truncated 6 tool output(s)
      cj-abc123 · read×3, bash×2, edit · saved ≈18.2kch
  [ ] 05/04, 12:38  truncated 4 tool output(s)

Space = toggle · a = all · Enter = restore selected · Esc = cancel
```

Restoring appends a restore marker. It does not rewrite or delete history; future context projection simply stops truncating those runs.

## Sidecar model

There are no model/settings commands. The extension picks a lightweight model automatically:

| Provider | Preferred model |
|---|---|
| OpenAI | `gpt-5.4-mini` |
| Anthropic | `claude-haiku-4-5` |
| Vercel AI Gateway | `openai/gpt-5-nano` |

If none are available, it falls back to the active Pi model.

## Persistence

Only the on/off switch is persisted:

```json
{
  "enabled": true
}
```

Path:

```text
~/.pi/agent/context-janitor/settings.json
```

Janitor run metadata + restore markers are stored as custom session entries. Raw tool output remains in the original session messages.
