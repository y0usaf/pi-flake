# pi-gecko-websearch

A pi coding agent extension that searches and browses the web using a headless Gecko browser instance controlled via the Marionette protocol. Uses your real browser fingerprint and cookies.

## What it does

**`web_search`** — Search the web via Google, DuckDuckGo, or Brave
- Parses result titles, URLs, and snippets from the actual DOM
- Uses your browser fingerprint so search engines see a real session
- Default engine: DuckDuckGo (HTML version — fast, reliable parsing)

**`web_browse`** — Browse any URL and extract content
- Navigate to a page and get its full text content
- Optional JS extraction script for targeted data pulling
- Runs in a real browser — works with JS-heavy SPAs

## How it works

1. On first tool use, copies `cookies.sqlite` from your configured Gecko profile to a temp directory
2. Spawns a headless Gecko browser with `--marionette --headless --no-remote`
3. Connects via the Marionette TCP protocol (port 2828)
4. Executes search/browse commands, extracts results
5. Cleans up on session shutdown (kills browser, removes temp dir)

## Configuration

| Env var | Description | Default |
|---------|-------------|---------|
| `PI_GECKO_PROFILE` | Exact Gecko profile directory | Auto-detect from common roots |
| `PI_GECKO_PROFILE_ROOT` | Root containing `profiles.ini` / browser profiles | Auto-detect Firefox, then LibreWolf |
| `PI_GECKO_BINARY` | Gecko browser path or command name (e.g. `firefox`, `librewolf`) | Auto-detect Firefox, then LibreWolf |

Or configure either:
- `~/.pi/agent/settings.json`
- `.pi/settings.json`

Project settings override global settings.

```json
{
  "extensionSettings": {
    "gecko-websearch": {
      "binary": "firefox",
      "profileRoot": "/home/you/.mozilla/firefox"
    }
  }
}
```

Use `profile` instead of `profileRoot` when you want an exact profile directory.

## Requirements

- Any Gecko browser with Marionette support (e.g. Firefox, LibreWolf)
- No additional npm dependencies (Marionette client is built-in)

## Usage

```bash
# Install as a pi package
pi install ~/Dev/pi-gecko-websearch

# Or load directly
pi -e ~/Dev/pi-gecko-websearch/src/index.ts
```

## Profile locking

Gecko browsers can lock their profile directories while running. This extension avoids conflicts by copying only `cookies.sqlite` and `cert9.db` to a temp profile. Your main browser session is never affected.
