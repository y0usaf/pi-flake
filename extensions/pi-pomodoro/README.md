# pi-pomodoro

Synced, non-blocking pomodoro timer for Pi.

- Footer-only ANSI background progress bar with the tomato, phase, and countdown drawn on top.
- Shared state file → every active Pi process running the extension stays in sync.
- No widget, title mutation, theme override, glyph bar, or blocking UI.
- Optional transition notifications.
## Commands

```text
/pomodoro start [minutes]   # start/resume a work session, default 25
/pomodoro break [minutes]   # switch to break, default 5 or long-break cadence
/pomodoro work [minutes]    # switch to work
/pomodoro pause
/pomodoro resume
/pomodoro stop              # idle/reset
/pomodoro status
```

## Settings

Global: `~/.pi/agent/settings.json`  
Project: `.pi/settings.json`

```json
{
  "extensionSettings": {
    "pi-pomodoro": {
      "workMinutes": 25,
      "breakMinutes": 5,
      "longBreakMinutes": 15,
      "longBreakEvery": 4,
      "notifyTransitions": true,
      "syncFile": "/run/user/1000/pi-pomodoro-1000.json"
    }
  }
}
```

`syncFile` defaults to `${XDG_RUNTIME_DIR}/pi-pomodoro-<uid>.json`, falling back to your OS temp dir (for example `/tmp/pi-pomodoro-1000.json`). Override it to a cache path or shared storage if you want persistence across reboots or sync across machines.
