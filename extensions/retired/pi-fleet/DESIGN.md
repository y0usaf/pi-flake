# pi-fleet — design & text contracts

Supersedes `pi-agent`. Absorbs its manager-recursion machinery (spawn a pi
child, contract, registry, kill-subtree) and adds a **reasonix worker layer**
with durable, resumable fleet state.

## Locked decisions

- **2026-08-13 — Roles are reasonix subagent profiles.** A worker is
  `reasonix subagent run <profile> --dir <worktree> --max-steps N <task>`.
  Profile = declarative role (prompt, model, effort, allowed tools), already
  stored/managed by reasonix. We do not invent a second role format.
- **2026-08-13 — State lives on disk, not in a daemon.** Fleet state
  (`fleet.log` + per-slice markers/logs) survives the pi session. `[[canon:daemon-thin-client]]`
  "not when": a fleet is a run-and-exit artifact like orchestra; files are the
  observable state (`[[canon:unix]]`), no daemon.
- **2026-08-13 — Manager recursion reuses pi-agent's spawn machinery as-is.**
  Tool names `agent`/`agent_answer`/`agent_kill`/`agent_list`/`agent_output`
  unchanged; children are still `pi --mode rpc` subprocesses with a contract.
  Only user-facing identity changes: package/config rename.
- **2026-08-13 — Two registries, not one union.** pi-agent's `Registry`
  tracks pi children (`ChildState`: engine, contract, nudges). Reasonix workers
  are dumber (process handle, stdout tail, no contract) → separate worker table
  in `fleet.ts`. Generalizing one registry for two leaf types is premature.

## Architecture

```
supervisor (pi session)           rx_fleet / rx_* tools + agent* tools
  └── fleet-manager (pi child)    one per project, spawned via agent tool
        └── worker (reasonix)     one per slice, `reasonix subagent run`
```

| Module | Role |
|---|---|
| `index.ts` | composition root (decision-making): registers agent* + rx_* tools |
| `spawn.ts` / `rpc-child.ts` / `state.ts` / `registry.ts` / `contract.ts` | manager recursion machinery (absorbed, machinery) |
| `fleet.ts` | NEW worker layer: spawn/loop/supervise reasonix workers + durable state |
| `config.ts` | config load (`pi-fleet.json`) + model resolution (decision-making) |

## Text contracts

### Fleet manifest (JSON)

```json
{
  "project": "ekko",
  "repo": "/home/y0usaf/dev/ekko",
  "base": "main",
  "stateDir": "/home/y0usaf/.pi/fleets/ekko",
  "noGit": false,
  "slices": [
    {"id": "proto", "profile": "worker", "task": "do X", "deps": "_",
     "worktree": "/tmp/fleet-ekko-proto", "model": "provider/id", "maxSteps": 0}
  ]
}
```

- `deps` = whitespace slice ids or `_` (none). A slice waits on `DONE` markers.
- `noGit: true` → slices run in `repo` as cwd, no worktree; clean exit = done.

### Slice state (under `stateDir/<slice>/`)

| Marker | Meaning |
|---|---|
| `RUNNING` | loop iteration in flight |
| `READY_FOR_REVIEW` | worker committed closure work (git) / clean exit (noGit) |
| `DONE` | merged into base (git) / complete (noGit) |

Logs: `fleet.log` (timeline), `run.log` (worker stdout), `metrics-<tag>.json`,
`trajectory-<tag>.jsonl`.

### Worker exit contract

`reasonix subagent run` exits 0 on success (answer printed), non-zero on
error. Loop relaunches with exponential backoff until `READY_FOR_REVIEW` or
`MAX_ITERS`.

## Deferred

- **Auto review/merge gate.** Deferred: manager is a full pi session with git;
  it merges `READY_FOR_REVIEW` slices itself. Revisit when the manager keeps
  merging broken work.
- **Panel over reasonix workers.** pi-agent's panel runs pi children; no
  reasonix panel until a concrete need.

## Roadmap

- [x] Absorb pi-agent → pi-fleet (rename package/config, keep machinery)
- [ ] `fleet.ts`: rx_run / rx_fleet / rx_list / rx_kill / rx_output + durable state
- [ ] Wire flake.nix + registry.nix; `nix build` + `nix flake check` pass
- [ ] Self-check: demo() exercising spawn+kill against a stubbed reasonix
