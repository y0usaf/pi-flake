# pi-multi-agent

Multi-agent extension for pi. Root agents get four orchestration tools — `spawn_agent`, `delegate`, `kill_agent`, `list_agents` — plus every spawned child gets `read`, `write`, `edit`, `bash`, `report`, and descendant-scoped orchestration tools of its own.

Children are in-process `Agent` instances that persist across interactions with their full conversation history. Recursive spawning is bounded by `pi-agents.json` via `maxDepth` and `maxLiveAgents`.

## Prerequisites

- **Node.js ≥ 18** (uses native `Promise.race`, `AbortSignal`, etc.)
- **npm** (for installing dependencies)
- **pi** installed and on your `$PATH`

## Install

```bash
# Run directly for this session only (-e loads an extension without installing it)
pi -e ~/Dev/pi-dev/index.ts

# Or register permanently via package.json auto-discovery.
# pi reads the "pi": { "extensions": [...] } field and loads listed entry points.
# Add this repo's path to your pi config, or place it where pi scans for extensions.
cd ~/Dev/pi-dev && npm install

# NOTE: symlinking index.ts alone won't work — module resolution requires the
# package directory to be present alongside the file. Either:
#   (a) copy the entire directory, or
#   (b) use the -e flag pointing to the original location (recommended), or
#   (c) configure pi's extension auto-discovery to load from this directory
#       by setting "pi": { "extensions": ["./index.ts"] } in its package.json.
pi
```

### Install from a package source

Once this repo is pushed to GitHub, pi can install it directly as a pi package:

```bash
pi install https://github.com/<owner>/pi-multi-agent
# or pinned to a ref/tag
pi install git:github.com/<owner>/pi-multi-agent@v0.1.0
```

Because the repo includes a `package.json` with a `pi` manifest, pi can treat the repository itself as a package source.

### The `-e` flag

`pi -e <path>` loads an extension **for this session only** without permanently installing it. Useful for development and testing. The path can be relative or absolute, and may point to a `.ts` file (pi compiles it on the fly).

### The `"pi"` field in `package.json`

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

This tells pi's extension auto-discovery to load `./index.ts` as an extension when pi starts from (or scans) this directory.

This repo also includes the `pi-package` keyword so it can be shared as a normal pi package via git or npm.

## Configuration

Extension config is loaded from:

- Global (default): `~/.pi/agent/pi-agents.json`
- Project: `.pi/pi-agents.json`

Project settings override global settings.

Example:

```json
{
  "maxDepth": 1,
  "maxLiveAgents": 6
}
```

Depth is counted from the root session at depth `0`:

- `maxDepth: 0` → no spawned agents
- `maxDepth: 1` → root can spawn children, children cannot spawn descendants
- `maxDepth: 2` → grandchildren allowed

`maxLiveAgents` caps the total number of live agents kept in the in-memory registry at once.

## Tools

### `spawn_agent(id, system_prompt, task, [timeout_seconds])`

Creates a new child agent with its own system prompt. The child gets `read`, `write`, `edit`, `bash`, `report`, and descendant-scoped `spawn_agent`/`delegate`/`kill_agent`/`list_agents` tools. Blocks until the child finishes.

Multiple `spawn_agent` calls in one turn run concurrently (parallel tool execution). Spawning is rejected when it would exceed configured `maxDepth` or `maxLiveAgents`.

- `timeout_seconds` — optional, must be a finite number greater than 0. If the child is still running when the deadline expires it is aborted, removed from the registry, and an error is thrown.

**File-system confinement:** `read`, `write`, and `edit` are restricted to the child’s inherited working directory. Any path that resolves outside that tree — via `../` traversal, an absolute path to a different location, or a symlink escape — is rejected with `Path traversal denied`. Absolute paths that stay within that working directory are accepted. `bash` is **not** confined in the same way: it starts in the working directory, but it can still access the rest of the file system and execute arbitrary shell commands.

### `delegate(id, message, [timeout_seconds])`

Sends follow-up work to an **existing** child (must have been previously spawned with `spawn_agent`). The child keeps its full conversation history from previous runs. Blocks until done.

Descendant agents can only delegate to agents in their own subtree.

- `timeout_seconds` — optional, must be a finite number greater than 0. If the child is still running when the deadline expires it is aborted, removed from the registry, and an error is thrown. If you still need that worker after a timeout, spawn a new child.

### `report(message)` (child-only)

Children call this to send intermediate results back to the parent. Reports stream to the parent via `tool_execution_update` during execution. All reports are collected in the final tool result.

**`report` vs implicit output contract:** if a child never calls `report`, its final assistant message is returned as the result instead. So you always get _something_ back even if the child doesn't explicitly report.

### `kill_agent(id)`

Kills a child agent and frees its resources. Aborts the child if it's still running. If the target has descendants, the whole subtree is killed recursively.

### `list_agents()`

Lists currently active child agent IDs and their status. The root agent sees the full registry. Descendant agents only see their own subtree. Output includes depth and parent metadata.

Example output:
```
• worker — idle, depth 1, root child, 3 reports
• reviewer — running, depth 2, parent worker, 0 reports
```

## Nix

This repo includes a `flake.nix` for reproducible development and packaging.

```bash
# Enter a dev shell with node + npm
nix develop

# Run the extension directly from the working tree
pi -e ./index.ts

# Build a store-backed package directory
nix build

# Then load the built package or extension from ./result
pi -e ./result/index.ts
# or install the package path into pi settings
pi install ./result
```

The flake's default package is just this repository packaged as a local pi package path, so pi can load it the same way it loads any other local directory package.

## TUI

While a child is running, you see a live activity feed with a braille spinner:

```
⠹ worker (5 actions)
  → read src/auth.ts
  ✓ read done
  → edit src/auth.ts
  ✓ edit done
  ↑ report "Refactored auth to use tokens"
```

When done, the result shows a summary (Ctrl+O to expand for full activity log and reports):

```
✓ worker (5 actions, 1 reports)
  ... 2 earlier
  ✓ edit done
  ↑ report "Refactored auth to use tokens"
```

## Flow

```
Parent: "Refactor auth and write tests in parallel"
├─ spawn_agent("refactor", "You refactor code.", "Refactor the auth module")
│   ├─ child reads files, edits code
│   ├─ report("Refactored 3 files")      ← streamed to parent
│   └─ report("Updated imports")          ← streamed to parent
│
└─ spawn_agent("tests", "You write tests.", "Write tests for auth")
    ├─ child reads code, writes test files
    └─ report("12 tests passing")         ← streamed to parent

// Both run concurrently. Parent gets both results.

Parent: "The refactor agent should also update the docs"
└─ delegate("refactor", "Update the migration docs too")
    └─ child resumes with full history, updates docs

Parent: "Done with the test agent"
└─ kill_agent("tests")
    └─ child freed, resources released

Parent: "Which agents are still alive?"
└─ list_agents()
    └─ • refactor — idle, depth 1, root child, 2 reports
```

## Caveats / Known Limitations

- **Children share the parent's model** — there is no per-child model selection; all children use whatever model the parent session has active.
- **Children run in-process** — they are not isolated processes; a crash or infinite loop in a child can affect the parent session.
- **Recursive spawning is config-bounded** — descendants may spawn more descendants only while doing so stays within configured `maxDepth` and `maxLiveAgents`.
- **Subtree-scoped control** — descendant agents can only manage agents in their own subtree; they cannot delegate to or kill arbitrary siblings from other branches.
- **`bash` is not file-system confined** — unlike `read`/`write`/`edit`, the `bash` tool can access paths outside the working directory. Treat child agents with `bash` as having the same OS-level file and network access as the user running pi.
- **Minimal allowlisted env for `bash`** — child shell commands receive only a small allowlisted environment (`PATH`, `HOME`, locale/terminal basics, temp-dir basics, and a few standard identity variables). Secret variables are not forwarded by default. If a command genuinely needs something additional, pass it inline for that command invocation instead of relying on inherited environment state.

## License

MIT
