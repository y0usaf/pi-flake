# pi-interview

Secondary-model requirements interviewer for [Pi](https://github.com/earendil-works/pi). Before primary agent starts, separate model decides whether clarification matters and generates structured multiple-choice questions.

## Flow

```text
user request
  → secondary interviewer: proceed | ask
  → questionnaire UI when needed
  → user answers injected as requirements
  → primary model starts
```

Primary model remains unchanged. Secondary call uses configured provider/model directly through Pi model registry. Later uncertainty discovered during repository inspection routes through `interview_user` tool and same questionnaire UI.

## Modes

| Mode | Behavior |
|---|---|
| `off` | No preflight or interview tool. Default. |
| `auto` | Secondary model asks only when user-owned choice materially changes path. |
| `strict` | Every request receives at least one questionnaire before primary model starts. |

Enable with model:

```text
/interview auto anthropic/claude-haiku-4-5
/interview strict openai/gpt-5.4
```

Omit model to use saved model or open authenticated-model selector:

```text
/interview auto
```

Disable/status:

```text
/interview off
/interview
```

## Commands

```text
/interview auto [provider/model]
/interview strict [provider/model]
/interview off
/interview model [provider/model]
/interview config
/interview config key=value
```

Configuration persists to `~/.pi/agent/interview.json`.

| Key | Default | Range / meaning |
|---|---:|---|
| `reasoning` | `low` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `maxTokens` | `4096` | 256–16384 |
| `maxQuestions` | `3` | 1–5 |
| `maxOptions` | `5` | 2–7, including injected “Use your judgment” option |
| `maxContextMessages` | `8` | 0–30 recent user/assistant/custom messages |
| `maxContextChars` | `24000` | 2000–100000 |
| `includeContextFiles` | `false` | Share loaded AGENTS.md/context files with interviewer |
| `timeoutMs` | `45000` | 5000–180000 |

Example:

```text
/interview config reasoning=medium
/interview config maxContextMessages=4
/interview config includeContextFiles=true
```

## Context and privacy

Secondary model receives:

- Current user request
- Bounded recent user/assistant/custom messages
- Primary agent findings passed to `interview_user`
- Project context files only when explicitly enabled

Not sent:

- Primary system prompt
- Tool outputs
- Image bytes

Choosing model on different provider sends selected context to that provider. Keep `includeContextFiles=false` or `maxContextMessages=0` when cross-provider sharing is unwanted.

## Reliability

- Output must match validated JSON questionnaire schema.
- One malformed-output retry, then fail open with warning.
- Model/auth/timeouts fail open; primary agent continues.
- “Use your judgment” and optional free-text answer are host-added.
- TUI uses multi-question tab UI. RPC falls back to sequential `select`/`input` dialogs.
- Print/JSON modes skip preflight because no interactive UI exists.

## Development

```bash
bun test
pi -e ./src/index.ts
```
