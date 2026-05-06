# pi-pomodoro

Synced, non-blocking pomodoro timer for Pi.

- Shared state file → every active Pi process running the extension stays in sync.
- Break time indicator → red status/title/widget.
- No input blocking → purely visual + notifications.

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
      "showWidgetDuringWork": false,
      "notifyTransitions": true,
      "syncFile": "/run/user/1000/pi-pomodoro-1000.json"
    }
  }
}
```

`syncFile` defaults to `${XDG_RUNTIME_DIR}/pi-pomodoro-<uid>.json`, falling back to your OS temp dir (for example `/tmp/pi-pomodoro-1000.json`). Override it to a cache path or shared storage if you want persistence across reboots or sync across machines.
