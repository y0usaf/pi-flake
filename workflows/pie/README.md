# pie — plan, implement, evaluate

Three responsibilities, three fresh contexts, for [pi-workflows](../../extensions/pi-workflows/)
(forked from `@extensions/vekexasia_pi-extensible-workflows/`).

The planner reads and plans but never edits. The implementer edits but never
decides what the job was. The evaluator sees the repo, the approved plan, and
the gate output — never the implementer's reasoning — so nobody grades their own
homework. That separation is the whole point: one context that plans, implements
and then judges will confirm whatever it already did.

Two checkpoints put you in the loop: one after the plan, before any file is
touched, and one before every retry.

## Invoke

```
/pie add --json output to the status command
/pie                       # derives the task from what this session discussed
/pie '{ "task": "...", "gate": "nix flake check", "maxAttempts": 3 }'
```

Picking `pie` from the startup list asks the same three questions the slash
command takes as args.

## Args

- `task` — what to build. Required unless the session already discussed one;
  a bare `/pie` in an empty session is refused.
- `gate` — shell command that must exit 0 for a pass. Default from the picker
  list: `nix flake check`, `nix build`, `cargo test`, `npm test`, or `none`.
  A nonzero exit is a fail no matter what the evaluator says.
- `maxAttempts` — implement/evaluate rounds, default 2, hard max 3.

## Shape

```
plan ──▶ checkpoint("plan") ──▶ implement-N ──▶ gate (shell) ──▶ evaluate-N
                 │ reject                                          │ fail
                 ▼                                                 ▼
            stop, keep plan                          checkpoint("retry") ──▶ implement-N+1
```

Each `implement-N` and `evaluate-N` is a phase, so the transcript renders one
row per stage rather than one per agent.

## Cost

Three to seven agent calls depending on retries, plus one gate run per attempt.
A one-attempt pass on a small task is three calls; the cap of three attempts is
seven. The gate runs in the workflow's cwd, so a slow `nix flake check` is paid
once per attempt.
