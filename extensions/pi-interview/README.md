# pi-interview

Standard ask-user-question workflow for [Pi](https://github.com/earendil-works/pi).

The main-session model always composes the complete questionnaire and, outside strict mode, decides when clarification matters. The extension never delegates question generation and never calls a second model.

## Flow

```text
manual / strict
user request → main model investigates → interview_user({ questions })
             → questionnaire UI → user answers → same main-session tool call resumes

auto
user request → main model investigates → interview_user({ questions })
             → every question resolves to “Use your judgment”, returns immediately
             → decision points are on the record; the main model decides them itself
```

No Pi session, branch, or agent thread is created, and no secondary inference happens in any mode.

## Modes

| Mode | Behavior |
|---|---|
| `off` | Tool disabled. Default. |
| `manual` | Main model may ask when material clarification is needed; you answer. |
| `auto` | Main model asks the same questions; every answer is “Use your judgment”, with no UI and no wait. |
| `strict` | Main model must ask at least once every request; you answer. |

```text
/interview manual
/interview auto
/interview strict
/interview off
/interview config
/interview config maxQuestions=4
```

Configuration persists to `~/.pi/agent/interview.json`.

| Key | Default | Range |
|---|---:|---|
| `maxQuestions` | `3` | 1–5 |
| `maxOptions` | `5` | 2–7, including host-added “Use your judgment” |

## Durability

A questionnaire can stay open for minutes, so it is the tool most likely to be alive when a terminal closes.

**The failure it avoids.** Pi persists the assistant message that *contains* a tool call before the tool runs, and persists the result only when the tool returns. A questionnaire that is open when pi exits therefore leaves a tool call with no result in the session file, and nothing repairs that pairing on load. The next provider request carries a `tool_use` block with no matching `tool_result`, and the API rejects the whole turn.

**How it is repaired.** Extensions get a read-only SessionManager, so the session file cannot be edited. The `context` event is the one place a message list can be rewritten before it is sent, so `src/durability.ts` finds every unanswered `interview_user` call and splices a result in directly after the assistant message that made it. The repair is derived from the messages themselves, so there is no sidecar file that can rot.

**How answers survive.** On session start, if the branch ends in an unanswered questionnaire, it is presented again. The questions are not stored by this extension — pi already persisted them inside the tool call arguments, so they are read back out of the session. Submitting sends the answers as a pi custom message, which pi persists, which is what carries them through a second restart. Cancelling with Escape falls back to "interrupted, no answers recorded".

**Typed text.** Free text is kept per question in a draft map. Escape returns to the option list without discarding what was typed, and re-opening a question restores it. An option with saved text is marked `✎`.

## Reliability

- Main model supplies structured questions/options through a validated tool schema.
- Host caps and normalizes the questionnaire, adds “Use your judgment”, and optionally allows free text.
- Free-text answers are normalized and capped at 500 characters.
- TUI uses the multi-question tab UI. RPC falls back to sequential `select`/`input` dialogs.
- Without an interactive UI, every question resolves to “Use your judgment” rather than blocking.
- Answers are labelled by source: user-selected, judgment, or recovered after a restart.

## Layout

| File | Kind | Contents |
|---|---|---|
| `src/config.ts` | pure | field table, defaults, ranges, `key=value` validation |
| `src/protocol.ts` | pure | question normalization, judgment answers |
| `src/durability.ts` | pure | dangling-call detection, result synthesis, splicing |
| `src/questionnaire.ts` | UI | tab questionnaire, drafts, RPC fallback |
| `src/index.ts` | shell | pi hooks, tool, command, file I/O |

## Development

```bash
bun test
pi -e ./src/index.ts
```
