## Locked decisions

- Rewriting is fail-open: a missing binary, failed subprocess, timeout, or abort notifies once per failure kind per session and always falls back to the original shell command. This preserves the best-effort extension contract and ensures a rewrite failure never blocks the agent's shell, deliberately diverging from canon:unix fail-loudly. (2026-07-30)
- Token-savings claims are not treated as measured performance claims until a reproducible benchmark exists; README describes best-effort rewriting instead. (2026-07-30)

## Architecture

- `index.ts` is the extension boundary: it registers Pi events and the `/rtk` command.
- The `execFile`/`rtk rewrite` subprocess wrapper is machinery: it classifies failures, tracks status, and returns an optional rewritten command.
- The enable state, fail-open fallback, and once-per-session failure notifications are decision-making policy.
- The extension intentionally remains a single-file layout. Split the boundary, policy, and subprocess machinery when another independent integration or a second execution backend makes the module map materially harder to maintain.
- canon:unix fail-loudly is n/a for blocking execution because the locked fail-open decision requires continuation; reverse this exception if rewriting becomes mandatory for correctness or security.

## Deferred

- Token savings remain unmeasured. A fixed representative command sample, a pinned `rtk` version, and a script comparing original versus rewritten output sizes would settle the claim; add that benchmark before making quantitative savings claims.

## Roadmap

- Phase 1 — failure visibility: tests must demonstrate one warning per failure kind per session and unchanged original-command fallback for missing, failed, and timed-out rewrites.
- Phase 2 — measurement: add the fixed-sample size comparison and record reproducible results before restoring any token-savings wording.
- Phase 3 — module extraction: split policy and machinery only when the single-file split condition in Architecture is met, with all extension-boundary tests passing.
