## Locked decisions

- Rewriting is fail-open: a missing binary, failed subprocess, timeout, or abort notifies once per failure kind per session and always falls back to the original shell command. This preserves the best-effort extension contract and ensures a rewrite failure never blocks the agent's shell, deliberately diverging from canon:unix fail-loudly. (2026-07-30)
- Accept `rtk rewrite` exit 0 or 3; exit 1 means “no rewrite available” (ordinary passthrough), as documented by `rtk rewrite --help`; guard stdout to an anchored, single-line, control-free command and cite rtk-ai/rtk#1563, #1232, and #2200. (2026-07-31)
- Refuse the find family: rtk rewrites every find form, including `-delete` and `-exec`, but compound actions then do nothing; supported predicates also diverge by excluding hidden/gitignored files, truncating output, mishandling `-path`/`-L`, and changing path rendering. (2026-07-31)
- Pi has no built-in per-command bash approval (docs/security.md:33; `src/core/tools/bash.ts` has no confirmation logic); `tool_call` is the only pre-execution hook and docs/extensions.md:762-764 says mutation is not revalidated. A permission-gate extension must therefore load after pi-rtk, or approval covers the pre-rewrite command. (2026-07-31)
- The rewrite benchmark is now committed and records measured token savings below. (2026-07-31)

## Architecture

- `index.ts` is the extension boundary: it registers Pi events and the `/rtk` command.
- The `execFile`/`rtk rewrite` subprocess wrapper is machinery: it classifies failures, tracks status, and returns an optional rewritten command.
- The enable state, fail-open fallback, and once-per-session failure notifications are decision-making policy.
- The extension intentionally remains a single-file layout. Split the boundary, policy, and subprocess machinery when another independent integration or a second execution backend makes the module map materially harder to maintain.
- canon:unix fail-loudly is n/a for blocking execution because the locked fail-open decision requires continuation; reverse this exception if rewriting becomes mandatory for correctness or security.

## Deferred

- None.

## Benchmark

`bench/rewrite-bench.sh` measured rtk 0.44.0 with 5.19% net savings (644 bytes, 11,767 rewritten bytes from 12,411 original bytes); the total excludes find-family commands blocked by the guard. `ls -la` produces most of the saving (1,180 -> 537 bytes, saving 643 bytes). Empty, identical, and rejected rewrites are passthroughs, and failed rewrites are not credited as savings.

## Roadmap

- Phase 1 — failure visibility: tests must demonstrate one warning per failure kind per session and unchanged original-command fallback for missing, failed, and timed-out rewrites.
- Phase 2 — measurement: add the fixed-sample size comparison and record reproducible results before restoring any token-savings wording.
- Phase 3 — module extraction: split policy and machinery only when the single-file split condition in Architecture is met, with all extension-boundary tests passing.
