# pi-interview

Standard ask-user-question workflow for [Pi](https://github.com/earendil-works/pi), with optional automatic answers from a separate model context.

Main-session model always composes complete questionnaire and, outside strict mode, decides when clarification matters. Extension never delegates question generation.

## Flow

```text
manual
user request → main model investigates → interview_user({ questions })
             → questionnaire UI → user answers → same main-session tool call resumes

auto
user request → main model investigates → interview_user({ questions })
             → separate model answers same questionnaire from bounded session context
             → same main-session tool call resumes

strict
same as manual, but main model must call interview_user once for every request
```

No Pi session, branch, or agent thread is created. Auto mode uses isolated provider inference only for selecting answers.

## Modes

| Mode | Behavior |
|---|---|
| `off` | Tool disabled. Default. |
| `manual` | Main model may ask when material clarification is needed; user answers. |
| `auto` | Main model asks same questions; configured separate inference answers them. |
| `strict` | Main model must ask at least once every request; user answers. |

Enable manual/strict without secondary model:

```text
/interview manual
/interview strict
```

Enable auto with answer model:

```text
/interview auto anthropic/claude-haiku-4-5
/interview auto openai/gpt-5.4
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
/interview manual
/interview auto [provider/model]
/interview strict
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
| `maxOptions` | `5` | 2–7, including host-added “Use your judgment” |
| `maxContextMessages` | `8` | 0–30 recent session messages for auto-answer |
| `maxContextChars` | `24000` | 2000–100000 session-context chars; questionnaire excluded |
| `includeContextFiles` | `false` | Share loaded AGENTS.md/context files with auto-answer model |
| `timeoutMs` | `45000` | 5000–180000 |

Example:

```text
/interview config reasoning=medium
/interview config maxContextMessages=4
/interview config includeContextFiles=true
```

## Context and privacy

Manual/strict modes make no secondary model call.

Auto-answer model receives:

- Questionnaire composed by main-session model
- Expanded current request, including invoked skill or prompt-template text
- Bounded recent user/assistant/custom messages
- Prior `interview_user` answers
- Project context files only when explicitly enabled

Not sent:

- Primary system prompt
- General tool outputs
- Thinking blocks
- Image bytes

Choosing model on different provider sends request, questionnaire, and selected context to that provider. Use `includeContextFiles=false` and/or `maxContextMessages=0` to minimize additional sharing. `includeContextFiles=false` does not remove skill or prompt-template text expanded into current request.

Auto-answers are explicitly marked model-generated; direct user answers are marked user-selected.

## Reliability

- Main model supplies structured questions/options through validated tool schema.
- Host caps and normalizes questionnaire, adds “Use your judgment”, and optionally allows free text.
- Free-text answers are normalized and capped at 500 characters.
- Auto-answer output must match validated JSON answer schema.
- One malformed-output retry, then every question falls back to “Use your judgment”.
- Model/auth/timeouts fail open; primary agent continues.
- TUI uses multi-question tab UI. RPC falls back to sequential `select`/`input` dialogs.
- Manual/strict tool is unavailable without interactive UI; auto mode works without questionnaire UI.

## Development

```bash
bun test
pi -e ./src/index.ts
```
