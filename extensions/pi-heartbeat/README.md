# pi-heartbeat

Paced re-prompting for the meta (boss) session. Work across projects and
subagents is driven by re-prompting; this repeats a prompt at a fixed cadence.

```
/heartbeat 60 continue the overnight ablation queue
/heartbeat stop
```

Every `interval_s` seconds, if the session is idle, the prompt is sent as a
follow-up that triggers a new turn. Restarting the timer replaces it. Stops
on `session_shutdown` and unmounts clean (no timers leak from the factory).

Not a replacement for pi-agents — it is the pacing layer on top. The default
decomposition nudge lives in `pi-agents`' `before_agent_start`, so a plain
`/heartbeat 60 continue` keeps the tree growing without bespoke prompts.

Callback lifecycle is intentional: a long-lived timer never holds a command
context; idle-state is tracked via `agent_start` / `agent_settled` events.
(pi's extension guide: no background timers spawned from the factory —
this extension only starts the timer from inside a command, and clears it on
shutdown.)