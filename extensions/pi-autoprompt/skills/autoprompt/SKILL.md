---
name: autoprompt
description: "Explicit-only multi-agent orchestration for Pi. Invoke /skill:autoprompt with a mission to scope, implement, test, review, repair, and verify it through the bundled pi-agents runtime. Never infer invocation from an ordinary request and never resume without an explicit resume instruction."
license: "MIT; see ../../LICENSE"
compatibility: "Earendil Pi with pi-agents; maxDepth >= 4. Vendored from Spielewoy/autoprompt-skill 1.0.4 and adapted to spawn_agent contracts."
disable-model-invocation: true
---

# Autoprompt for Pi

This package vendors the Autoprompt 1.0.4 OMP doctrine, 25 named roles, and 18 frameworks. Pi does not provide OMP's native `task` tool or installed agent profiles, so this adapter dispatches the same named personas through the `pi-agents` extension.

## Explicit start contract

Only this explicit `/skill:autoprompt <mission>` invocation starts a run. Do not infer Autoprompt from ordinary requests. Loading the skill without a mission does not start or resume work; perform only the frontier check described under Resume and stop.

The invocation authorizes the stated mission. Ask only once for undefined operator knobs:

- `mode=tokensaver` (default): at most six live workers.
- `mode=wide`: all ready disjoint work, bounded by the host ceiling.
- `mode=custom max_subs=N`: caller-selected live-worker ceiling.
- `agents=off`: workers inherit the model selected by `pi-agents`; per-role routing is unavailable.

In an unattended run, use `mode=tokensaver agents=off` and record those assumptions.

## Required host capability

Before repository work, call `list_agents`. If `list_agents`, `spawn_agent`, or `kill_agent` is unavailable, stop with `CAPABILITY-FAILURE`: the `pi-agents` extension is required.

Autoprompt requires recursive dispatch through four hierarchy levels. The host must be configured with `maxDepth >= 4`; a depth denial is a hard capability failure, never permission to flatten or skip a coordinator. `maxLiveAgents` must be at least the selected mode ceiling. The normal flake integration supplies the package and skill, but the operator remains responsible for compatible `pi-agents.json` limits.

## Vendored resources

Read these references as needed, relative to this skill directory:

- [GATES.md](GATES.md): gate and evidence contracts.
- [MODES.md](MODES.md): concurrency and run controls.
- [PLAYBOOKS.md](PLAYBOOKS.md): task playbooks.
- `frameworks/*.md`: task/gate frameworks.
- `agents/ap-*.md`: the canonical named worker personas.

The persona files' YAML `tools` and `spawns` fields describe upstream OMP capabilities. Pi does not load those files as native profiles. Enforce them when constructing each spawn as described below.

## Pi named-role adapter

Every dispatch of role `<role>` MUST:

1. Read `agents/<role>.md` in full.
2. Use `spawn_agent` with `id` beginning `<role>-` and a unique run-local suffix.
3. Put the full persona file body in `system_prompt`, followed by the Pi adapter contract below.
4. Put only the compact dispatch envelope in `task`.
5. Supply a non-empty typed `contract` matching the role's required report shape. At minimum ask for `status`, `summary`, `evidence`, `artifacts`, and `blockers`; use enumerated options for status where possible.
6. Set a bounded `timeout_seconds` appropriate to the work.
7. For a ready parallel group, issue all `spawn_agent` calls in one assistant turn before collecting pushed results.
8. Treat the returned contract answers as the worker's final report. Completed children are removed automatically; use `kill_agent` only to abort a live or timed-out subtree.

Append this host contract to every worker `system_prompt`:

```text
PI-AUTOPROMPT ADAPTER CONTRACT
You are the named persona in the preceding vendored definition. OMP's `task` tool is represented here by `spawn_agent`; `kill_agent` and `list_agents` manage your descendant subtree. To dispatch a named child, read its canonical persona from the same Autoprompt skill directory, pass that full persona plus this adapter contract as system_prompt, and bind the intended registered name in the child id. Dispatch only roles listed in your persona's `spawns` allowlist. Never invent an anonymous or general-purpose role. Use read/write/edit/bash only when your persona's `tools` allow the corresponding OMP capability. Finish by calling submit_answers exactly once with every contract field; report is progress-only. A spawn denial, timeout, tool error, or child failure must be returned to your dispatcher as a blocker. Do not load or invoke the Autoprompt skill and do not start a nested Autoprompt run.
```

The child contract mechanism replaces OMP's profile registration and result channel; it does not relax role boundaries, spawn allowlists, recursion depth, independence, or evidence requirements.

## Run governance

Store governance outside the mission target repository, under a run-specific directory in `${TMPDIR:-/tmp}/pi-autoprompt/<run-nonce>/` unless the user explicitly supplies another external artifact root. Never put governance files in the target worktree.

New-run governance is exactly:

1. `PROMPTS.txt` — exact append-only prompt blocks.
2. `ROADMAP.md` — canonical executable roadmap.
3. `GATELOG.md` — append-only transitions, persona/model provenance, verdicts, hashes, elapsed time, and resume frontier.

Create a cryptographically random RUN-NONCE and an `AUTOPROMPT-RUN-MARKER`. Include both plus the mission pointer (path, SHA-256, UTF-8 byte length) in every task brief. Workers fail closed on missing or mismatched bindings.

## Hierarchy and workflow

Preserve the vendored hierarchy:

- L0 conductor: this skill invocation; dispatches only `ap-scope-coordinator`, `ap-feature-coordinator`, and `ap-sweep-coordinator` during ordinary work.
- L1 coordinators: dispatch only; a single bounded lane may go directly to a named L3 worker, while multi-lane slices use `ap-manager`.
- L2 `ap-manager`: optional dispatcher for multi-lane slices.
- L3 executors: perform scope, planning, implementation, review, verification, and sweep work.
- L4 leaves: perform independent terminal checks and support duties.

Start with `ap-scope-coordinator`. It must produce one independently approved executable `ROADMAP.md` using the adaptive topology in the vendored doctrine. After approval, dispatch `ap-feature-coordinator` for dependency-safe build lanes, then `ap-sweep-coordinator` for convergence and final independent checks.

No agent reviews its own work. Blind reviewers receive mission, candidate, repository, and raw evidence pointers, not another reviewer's verdict. Preserve dependency order, dispatch disjoint ready lanes concurrently, retain accepted evidence across repairs, and never flatten the topology merely to avoid a host limit.

## Build and completion

Follow [GATES.md](GATES.md), [MODES.md](MODES.md), [PLAYBOOKS.md](PLAYBOOKS.md), and the selected framework files. Require strict red-to-green evidence, real runners and systems, direct-dependent checks, and at least 95% changed-line/touched-module coverage where the repository can measure it.

DONE requires mission and roadmap coverage, zero open findings, no green-to-red regressions, real end-to-end exercise, successful ledger validation, zero live descendants according to `list_agents`, and cleanup when enabled. Do not claim unavailable checks passed.

Do not commit, push, publish, deploy, spend money, delete user data, force-push, reset, or clean the worktree without explicit user authorization.

## Resume

Resume only on an explicit `resume` instruction. A bare invocation checks only the tail of the designated `GATELOG.md`, reports the active frontier in at most 150 words, and stops. On explicit resume, verify the mission pointer hash, byte length, and nonce before dispatching the open frontier. Leftover, empty, malformed, or contradictory artifacts never authorize work.
