# pi-statusline

Minimal Pi extension that hides the default footer and renders footer-style info as a one-line statusline above the editor.

Statusline data includes:

- active directory, git branch, and session name
- token/cache/cost totals
- context usage
- provider/model and thinking level
- extension status icons from `ctx.ui.setStatus()` — e.g. `pi-codex-fast`'s `⚡`

## Usage

```bash
pi -e ./extensions/pi-statusline
```

Or install/load as a bundled package via this flake.
