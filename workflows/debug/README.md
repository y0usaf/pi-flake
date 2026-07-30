# debug — hypothesise, test one at a time, fix what was confirmed

Root-cause hunting for [pi-workflows](../../extensions/pi-workflows/).

One context enumerates falsifiable causes without touching the code. Each cause
is then handed to a separate context that sees exactly one claim and is told to
answer `confirmed`, `refuted` or `inconclusive`. An agent that has already
decided what the bug is reads every file as confirmation; giving each hypothesis
its own context means a refutation costs one context and leaves no residue in
the next one.

Nothing is edited until a confirmed cause clears the fix checkpoint.

## Invoke

```
/debug pi drops the last line of piped stdin
/debug                     # uses the failure this session was already discussing
/debug '{ "symptom": "...", "repro": "nix flake check", "maxHypotheses": 5 }'
```

## Args

- `symptom` — what is going wrong. Required unless the session discussed one.
- `repro` — command whose nonzero exit is the failure. Optional; when given it
  runs first, and a zero exit ends the run before any agent starts.
- `maxHypotheses` — candidates tested before giving up. Default 3, hard max 5.

## Shape

```
reproduce (shell) ──▶ hypotheses ──▶ test-1 ──▶ test-2 ─ … ─▶ checkpoint("fix") ──▶ fix ──▶ repro again
                                        │ confirmed ────────────▲
                                        └ all refuted ──▶ report what was ruled out
```

The repro command runs twice when it is given: once before the hunt to prove the
failure is real, once after the fix to prove it is gone.

## Cost

Two agent calls in the lucky case (hypotheses plus one confirming test), five
when three hypotheses are tested and a fix is approved. Each test context is
cheap because it carries one claim, not the whole investigation.
