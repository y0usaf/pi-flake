# pi-rtk

[Pi](https://github.com/earendil-works/pi) coding agent extension that uses [rtk](https://github.com/rtk-ai/rtk) for best-effort shell command rewriting.

When `pi-rtk` is loaded, it participates in two Pi shell paths:

- agent-initiated `bash` tool calls
- user-issued `!<cmd>` shell commands whose output is included in model context

In both cases, `pi-rtk` asynchronously attempts to rewrite the command with:

```shell
rtk rewrite "<original command>"
```

If rewrite succeeds and returns a different, non-empty command, Pi executes the rewritten command. If rewrite fails for any reason, `pi-rtk` notifies once per failure kind per session, then falls back so normal Pi shell behavior continues.

Commands entered with `!!<cmd>` are intentionally not intercepted. They continue through Pi's normal context-excluded shell execution path unchanged.

## Prerequisites

- Pi v0.60.0 or later
- [rtk](https://github.com/rtk-ai/rtk), installed and available on your `PATH`

If `rtk` is unavailable, `pi-rtk` preserves normal shell behavior by falling back to the original command. After an unavailable binary is detected, rewrite attempts are skipped for the rest of the session unless `/rtk on` is used to retry discovery.

## Install

Make sure your Pi installation is v0.60.0 or later before installing this package.

### npm

```shell
pi install npm:@sherif-fanous/pi-rtk
```

Or try without installing:

```shell
pi -e npm:@sherif-fanous/pi-rtk
```

To uninstall:

```shell
pi remove npm:@sherif-fanous/pi-rtk
```

### Nix

This repository also includes a flake that packages `pi-rtk` as a local Pi package and bakes in `rtk` from `nixpkgs`.

Build the package:

```shell
nix build .#pi-rtk
```

Then load it directly in Pi:

```shell
pi -e "$(nix build .#pi-rtk --print-out-paths)"
```

Or install the built store path as a local package:

```shell
pi install "$(nix build .#pi-rtk --print-out-paths)"
```

For development, enter the dev shell:

```shell
nix develop
```

## Runtime control

`pi-rtk` is enabled by default for each session. Use `/rtk` to control it without reloading Pi:

```text
/rtk          Toggle rewriting on or off
/rtk on       Enable rewriting and retry unavailable-binary discovery
/rtk off      Disable rewriting
/rtk status   Show runtime state
```

The setting is session-scoped. It is not persisted to Pi settings.

`/rtk status` reports only operational metadata:

- enabled state
- `rtk` binary availability
- rewrite attempts and applied rewrites
- empty and unchanged rewrite counts
- unavailable-binary skips
- last failure category

It does not include shell command contents.

When disabled, both agent `bash` calls and user `!<cmd>` commands pass through unchanged. `!!<cmd>` always bypasses `pi-rtk`, even while enabled.

## How It Works

### Agent `bash` tool calls

`pi-rtk` hooks Pi's mutable `tool_call` event for the built-in `bash` tool. Before Pi executes the tool, the extension asynchronously attempts an `rtk rewrite` and mutates the command only when rewrite returns a usable replacement.

This keeps Pi's built-in `bash` tool as the execution owner. `pi-rtk` does not register a replacement tool, override tool rendering, or change the tool schema exposed to the model.

#### Behavior summary

```text
Agent bash tool call
        │
        ▼
pi-rtk tool_call hook
        │
        ├─ try: rtk rewrite "<command>"
        │      │
        │      ├─ usable rewrite -> mutate bash input command
        │      └─ failure/empty/unchanged -> keep original command
        │
        ▼
Pi built-in bash tool executes normally
```

### User `!<cmd>` shell commands

`pi-rtk` also hooks Pi's `user_bash` event for context-visible user shell commands entered with `!<cmd>`.

For these commands, the extension asynchronously probes rewrite eligibility before claiming the event. If rewrite succeeds, it returns custom bash operations so Pi can keep owning the normal execution lifecycle and UI behavior. If rewrite does not succeed, the extension falls through and Pi handles the command normally.

#### Behavior summary

```text
User !<cmd>
        │
        ├─ try: rtk rewrite "<command>"
        │      │
        │      ├─ usable rewrite -> return custom bash operations
        │      └─ failure/empty/unchanged -> fall through to normal Pi handling
        │
        ▼
    same user shell experience in Pi
```

### User `!!<cmd>` shell commands

Commands entered with `!!<cmd>` are excluded from model context by design, so `pi-rtk` does not intercept them.

They bypass `pi-rtk` completely and continue through Pi's normal context-excluded shell handling.

#### Behavior summary

```text
User !!<cmd>
        │
        ▼
    bypass pi-rtk and use normal Pi context-excluded shell handling
```

## Fallback behavior

Rewrite is best-effort. The original command is preserved when:

- rewriting is disabled with `/rtk off`
- `rtk` is missing or not executable
- `rtk rewrite` exits unsuccessfully
- rewrite exceeds the 5-second timeout
- Pi aborts the rewrite operation
- rewrite returns empty output
- rewrite returns the original command unchanged
- `rtk` was previously unavailable and discovery has not been retried with `/rtk on`

Rewrite subprocesses are asynchronous and abort-aware, so they do not block Pi's UI or agent event loop.

## Development

Run tests:

```shell
bun test
```

Run package checks:

```shell
npm run type-check
npm run lint
npm run format-check
```

Validate through Nix:

```shell
nix build .#pi-rtk
nix flake check
```
