# pi-js-kernel

[Pi](https://github.com/earendil-works/pi) coding agent extension that gives pi a persistent JavaScript REPL tool: `js`.

The `js` tool runs code in a long-lived Node.js kernel child process. Variables, imports, and functions persist across `js` calls within the session — a scratchpad for computations, data exploration, and quick scripts. State dies with the session; a new session starts fresh.

## Usage

Call the `js` tool from pi:

```
js code: "const x = 21 * 2; x"         → 42 (x is now defined)
js code: "x + 1"                        → 43 (x persisted)
```

Parameters:

- `code` (required) — JavaScript source to evaluate in the persistent REPL.
- `timeoutMs` (optional) — per-call timeout in ms. Default `60000`, clamped to `1000..300000`.

## Kernel API

Inside the REPL, the `kernel` object exposes the bidirectional host bridge (protocol v2):

- `kernel.read(path, {offset, limit})` — read a file with hashline v3 LINEID anchors.
- `kernel.edit({path, edits})` — apply edits by LINEID anchor. Accepts strict `{loc,content}` (e.g. `{loc:{range:{pos,end}}}`), the naive top-level shape `{range:{pos,end},content}` / `{append:LINEID,content}` / `{prepend:LINEID,content}`, legacy v2 `{op,pos,end,lines}` shapes, and `{oldText,newText}` — same normalizer as the host edit tool.
- `kernel.bash(cmd, {timeoutMs})` — run a command in a node `child_process.exec` subshell (child-side, never crosses the bridge).
- `kernel.rlm.run(task, {contract, model, timeoutSeconds, background})` — async by default: spawns a child agent in the background and returns an admission handle `{childId, done, background, sessionFile}` immediately; the child's contract answers arrive later as an injected follow-up message (the agent_message delivery), so the parent keeps prompting while children run. Pass `{background: false}` to block and get the answers in-cell.
- `kernel.rlm.panel(task, {contract, models, size})` — blocking: 2-5 independent children on different models answer the same contract; the result is an agreement tally (`{text, panel: {members, tally}, details}`). Model diversity is the point — N clones of one model agree because they are the same function. No background mode (pi-agents hard-errors on panel + background).
- `kernel.rlm.loop(workflow, {timeoutSeconds})` — blocking: run a declarative agent_loop workflow (goal / doer / check / strategy / converge / budget), the same JSON shape `~/.pi/workflows/` files use. Bounded by the workflow's own budget (maxGenerations / maxSpawns); optional `timeoutSeconds` aborts the loop's children via an internal AbortController — pi-agents' `agent_loop` declares timeout_seconds but never enforces it.
- `kernel.rlm.answer(id, answers)` — resume a child suspended on ask_parent. `answers` is one `{id, value}` per pending question (validate against `kernel.rlm.peek` output). Background children go detached again and report via an injected follow-up; blocking ones resolve in-cell.
- `kernel.rlm.peek(id)` — inspect a child: status (running / awaiting answers / idle), pending questions, reports, recent activity, session file.
- `kernel.rlm.list()` — list running child agents.
- `kernel.rlm.kill(id)` — kill a child agent.

The RLM bridge supersedes `pi-agents` and `pi-hashline`, which are retired from pi-full; both are vendored into this package at build time. Tool-stripping (a config-gated strip of main-session `write`/`edit`/`bash` in the RLM child) is not enabled yet.

## What persists

- `let`/`const`/`var` declarations, function declarations, and class declarations
- `import`/`require` bindings
- Anything assigned to the REPL global

The kernel runs single-threaded and executes calls sequentially (`executionMode: "sequential"`).

## Caveat: timeout restarts the kernel

Long-running or never-settling code hits the per-call timeout and the kernel is **killed and restarted** — all REPL state is lost. The result text says so explicitly (`[kernel restarted: REPL state lost]` appears on the next call), so the model knows state vanished. Aborting a call does the same.

## Requirements

- Pi (bundled in pi-flake, or load standalone)
- Node.js for the kernel child. The nix-built extension substitutes in the store node at build time; a dev/standalone load falls back to `node` from `PATH`. If node is missing, the tool reports a clear error and tells you to use the nix-built extension.

## Development

From the flake root, load the extension directly:

```shell
pi -e extensions/pi-js-kernel
```

The extension registers the `js` tool; state persists across calls for the session.

Lint and type-check:

```shell
biome lint extensions/pi-js-kernel/index.ts
cd extensions/pi-js-kernel && npx tsc --noEmit --skipLibCheck index.ts   # needs pi types resolvable
```

Validate through Nix (once the flake wiring lands):

```shell
nix build .#pi-js-kernel
nix flake check
```
