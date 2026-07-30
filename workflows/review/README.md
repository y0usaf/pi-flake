# review — two reviewers, one merge, optional fix

Diff review for [pi-workflows](../../extensions/pi-workflows/).

One agent looks only for behaviour that is **wrong**; a second looks only for
what the change makes **risky to operate**. Neither sees the other's list until
a third context merges them. A single agent asked for "everything wrong" anchors
on the first defect it finds and reports variations of it; splitting the
question by kind is what stops that.

Fixes are opt-in and gated: only findings the merge marks `blocking` are
offered, and only after a checkpoint.

## Invoke

```
/review                    # working tree
/review main...HEAD        # any git revision range
/review '{ "scope": "staged", "mode": "offer fixes" }'
```

## Args

- `scope` — `working tree` (default), `staged`, `last commit`, `vs main`, or any
  git revision range, which is appended to `git diff`.
- `mode` — `review only` (default) or `offer fixes`.

## Shape

```
collect (git diff) ──▶ review ┬ correctness ┐
                              └ risk        ┴─▶ merge ──▶ checkpoint("fix") ──▶ fix
```

An empty diff returns immediately without spending a single agent call. The
diff is clipped at 30 000 characters and the reviewers are told to read the
files for anything past that.

## Cost

Three agent calls for a review, four when fixes are approved. Two of the three
run in parallel, so wall time is roughly two calls.
