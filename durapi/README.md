# durapi

A durable coding agent: pi's terminal UI, models, settings and system prompt on
[pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable), so
a turn cut off by a crash or a lost terminal resumes with `--continue`. It loads
no pi extensions or pi packages and is not a drop-in `pi`: no session picker,
`/tree`, forks, prompt templates, images or `/login` (log in with `pi`; the
credentials are shared).

Forked from pi's experimental durable demo
(`packages/coding-agent/src/experimental/durable`, pi 1.0.0, `a13d35a`), MIT,
Copyright (c) 2025 Mario Zechner; see [LICENSE](LICENSE).

## Run

```bash
nix run .#durapi             # pi-durable's read/write/edit/bash and a subagent tool
durapi --continue            # resume the newest session for this directory
```

Sessions live in `~/.pi/agent/durapi/sessions/<cwd-hash>/<session>/session.sqlite`.
One process owns a session; a lock left by a killed process goes stale after 10 s.

## Changes from upstream's demo

- `SYSTEM.md` and `APPEND_SYSTEM.md` apply as in pi: the project's `.pi/` when
  trusted, else `~/.pi/agent/`.
- The first system message leads every request. pi-durable stores it after the
  first user message, and Anthropic models then read the whole prompt as a
  mid-conversation update.
- Extensions load from `DURAPI_EXTENSIONS`.
- Imports go through the `@earendil-works/*` source aliases instead of relative
  paths, so the fork lives outside pi's tree.

## Extensions

`DURAPI_EXTENSIONS` is a colon-separated list of module paths. Each module
default-exports an `ExtensionFactory` (`harness-setup.ts`) that returns a
pi-durable extension: tools, prompt sections, hooks. The factory gets `cwd`,
`settingsManager`, `modelRuntime` and `onClose(cleanup)`; cleanups run in
reverse order when durapi exits. A module that fails to load stops startup;
`durapi` without extensions still runs.

State that has to survive a crash belongs in pi-durable documents, committed
with the transcript, not in module variables.

## Layout

| File | Role |
| --- | --- |
| `main.ts` | arguments, open, run, close |
| `runtime.ts` | Harness, registry, extensions, view and controller |
| `harness-setup.ts` | settings, coding registry, extension loading, environments, initial model |
| `prompt.ts` | pi's system prompt sections plus SYSTEM.md, leading every request |
| `sessions.ts` | session directories and the lock |
| `subagent.ts` | the foreground subagent tool |
| `tui.ts` | rendering with pi's interactive components |
| `extensions/` | durapi extensions |
