# Pi Atelier

Pi Atelier presents calm, session-scoped visibility into Pi without taking control away from the terminal workspace.

## Language

**Turn settled**:
The point at which Pi has no automatic retry, compaction retry, or queued continuation left and is waiting for the next user action.
_Avoid_: Task completed, session ended, agent ended

**Input requested**:
A state explicitly signaled by an interactive question tool that cannot continue until the user answers.
_Avoid_: Waiting, question detected

**Completion notification**:
A user-facing notice emitted when a Turn settles or Input is requested. It contains operational status only, never prompt or assistant-response content.
_Avoid_: Alert, task-complete notification
