# pi-sidebar

A Crush-style right-docked sidebar for [Pi](https://pi.dev), built as a native
extension. Inspired by [crush](https://github.com/charmbracelet/crush)'s chat
sidebar; split-pane mechanics adapted from
[`@extensions/michaelmjhhhh_pi-atelier/`](../michaelmjhhhh_pi-atelier/) (MIT,
© 2026 Michael).

## What it shows

- **Project** — directory name, cwd, current git branch
- **Model** — active model name, thinking level
- **Context** — tokens / window with usage percent, cumulative session cost
  and input/output tokens
- **Files** — files modified this session by `edit`/`write` tools
- **Activity** — live running tools with elapsed time, plus recently finished
  tools with status (✓/✗) and duration
- **Tools** — active/available tool counts

Unlike pi-atelier (fixed Midnight Spectrum palette), pi-sidebar is
**theme-native**: every color comes from the active Pi theme, so it follows
dark, light, and custom themes.

## Controls

- `/sidebar` — toggle the sidebar
- `/sidebar on|off` — explicit show/hide
- Drag the divider with the mouse to resize (SGR mouse is enabled while the
  sidebar is visible)

The sidebar hides automatically on terminals narrower than 96 columns.

## Layout

Like crush: the main chat + editor keep the left region, the sidebar docks to
the right edge, and Pi's own render runs at `terminal width − sidebar width`
so nothing overlaps.

## Notes

- Requires interactive TUI mode; in other modes the extension stays inert.
- Cost/token totals accumulate from assistant message usage for the current
  session.
