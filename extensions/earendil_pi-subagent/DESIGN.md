# pi-subagent — design

Vendored from upstream pi, `packages/coding-agent/examples/extensions/subagent`
(MIT, Copyright 2025 Mario Zechner — see `LICENSE`). Upstream's own README is
kept verbatim as `README.upstream.md`; this file records only what pi-flake
decided.

## Locked decisions

- **2026-08-12 — vendor the upstream example, not `nicobailon/pi-subagents`.**
  The goal is one thing: an expensive planner handing work to a cheap executor.
  The upstream example is 1141 LOC of TypeScript across two files and expresses
  per-agent model choice as one frontmatter key. `nicobailon/pi-subagents`
  (measured at clone time: 327 files, 55,435 src LOC, 58,438 test LOC, 120 KB
  README) delivers the same three delegation modes plus an adversarial watchdog
  reviewer gated on `typescript-language-server` diagnostics, artifact
  directories, session sharing, a fleet TUI, per-child git worktrees, and a
  six-level model-resolution precedence chain. None of that is needed to route
  two roles at two price points, and all of it is surface to understand before
  changing anything. `[[canon:least-code]]`. Reversed if we ever want child
  worktrees or an automatic post-turn reviewer — both are real features, and
  reimplementing them here would be worse than adopting the bigger package.

- **2026-08-12 — bundled agents are discovered from `../agents`, relative to
  the extension file.** The tool otherwise reads agents only from
  `getAgentDir()/agents` and project `.pi/agents`, and pi-flake manages nothing
  under `$HOME`. On this machine `PI_CODING_AGENT_DIR` points at
  `~/.local/share/pi/agent`, which has no `agents/` directory, so without this
  hunk the derivation ships a `subagent` tool with zero agents. The change is
  ~12 lines in `extensions/agents.ts`, marked in-file as a local change.
  Bundled agents are labelled `source: "user"` so upstream's
  `"user" | "project" | "unknown"` union and every `.source` consumer in
  `index.ts` stay untouched, and they load at the lowest precedence: a
  same-named file in the user agents directory or
  `.pi/agents` replaces the bundled one via `Map.set` ordering.
  Rejected smaller-looking things: a home-manager `home.file` symlink from the
  derivation into the user agents directory — zero lines in this repo, but it moves
  the "does this extension work" answer into a downstream config file, so the
  package alone is no longer testable; and a `programs.pi.agents` module option
  — a NixOS module cannot write to `$HOME` without an activation script, which
  is a mechanism `nix/modules/nixos.nix` does not use anywhere today.
  Reversed if upstream adds package-relative agent discovery, at which point
  this hunk is deleted rather than re-applied.

- **2026-08-12 — bundled agents load regardless of `agentScope`.** Upstream
  drops user agents when `agentScope: "project"`. Bundled agents are read from
  the Nix store, not from a repo, so excluding them would buy no safety and
  would let a legitimate scope choice leave the tool with nothing to run.

- **2026-08-12 — `agentScope` default stays `"user"`.** A project `.pi/agents/*.md`
  is a repo-controlled system prompt that can instruct a child to read files and
  run bash. Opting in stays an explicit per-call argument, and the interactive
  confirmation upstream added for project agents stays on.

- **2026-08-12 — model split rides on chain mode, not on parent orchestration.**
  `planner` is `claude-opus-4-8` ($5/$25 per Mtok), `worker` is
  `openai/gpt-5.6-luna` on `vercel-ai-gateway` ($1/$6, cache read $0.10, 1.05M
  context), `scout` stays `claude-haiku-4-5` ($1/$5), `reviewer` stays
  `claude-sonnet-4-5` ($3/$15). This is only affordable because chain mode returns
  *one* blob to the parent: `extensions/index.ts:578` sends
  `getFinalOutput(results[results.length - 1].messages)` as tool `content` and
  parks every intermediate step in `details`, which renders in the TUI and never
  enters the model's context. Issuing three separate `subagent` calls instead
  pushes all three outputs into the expensive parent's transcript, which is
  re-billed as input on every subsequent turn.

- **2026-08-12 — agents may name a `provider`, and it is passed as `--provider`.**
  Upstream passes only `--model` (`extensions/index.ts:295`). The id
  `openai/gpt-5.6-luna` exists under both `openrouter` and `vercel-ai-gateway`
  in `nix/model-data`, and both are authenticated here (`OPENROUTER_API_KEY` and
  `AI_GATEWAY_API_KEY` are both in the environment), so a bare `--model` pattern
  could resolve to the wrong account and bill the wrong key with no error. Two
  lines in `agents.ts` plus one in `index.ts` make the choice explicit.
  `[[canon:unix]]` row "fail loudly on the first bad input": silent provider
  fallback is exactly the failure mode that row forbids. Reversed if upstream
  adds provider-qualified `--model` parsing that handles ids containing a slash.

## Architecture

| Module | Kind | Responsibility |
|---|---|---|
| `agents/*.md` | decision (data) | Which model, which tools, which system prompt per role. Rung 2–3 of the least-power ladder: readable without running anything. |
| `prompts/*.md` | decision (data) | Chain shapes (`scout → planner → worker`). Inert here; pi reads prompt templates from the user prompts directory (`$PI_CODING_AGENT_DIR/prompts`). |
| `extensions/agents.ts` | decision | Agent discovery and precedence: bundled, then user, then project. Holds the local hunk. |
| `extensions/index.ts` | machinery | Tool schema, mode dispatch (single / parallel / chain), child `pi` spawn via `process.execPath`, JSON-mode stream parsing, TUI rendering, abort propagation. Vendored with one 1-line local hunk (`--provider`). |

`[[canon:no-privileged-path]]` is `n/a`: this is one tool with no plugin story
of its own, and there are not three units of any kind to declare. Reversed if a
second delegation surface appears here.

`[[canon:functional-core]]` is `n/a`: the extension exposes no extension
boundary. Children are OS processes with their own context, not handlers
running against host state.

`[[canon:daemon-thin-client]]` is `n/a`: background runs are not implemented in
this vendored version, and nothing outlives the parent session.

## Deferred

- **Cerebras as the `worker` model** (`gpt-oss-120b` at $0.35/$0.75 per Mtok, or
  `zai-glm-4.7` at $2.25/$2.75, both 131k context and much faster than Haiku).
  Not chosen because `openai/gpt-5.6-luna` on `vercel-ai-gateway` is cheaper per
  output token than GLM, has a 1.05M context, and bills the key already used for
  everything else. Revisit if latency, not price, becomes the complaint.
- **Placing `prompts/*.md` into the user prompts directory.** Same `$HOME` problem as
  agents, but prompt templates are pure convenience: the chain can be requested
  in a sentence. Not worth a second mechanism yet.
- **Upstream re-sync automation.** One hunk in one file is cheap to re-apply by
  hand. Revisit if the local diff grows past ~30 lines.
- **Background runs, resume, watchdog review, child worktrees.** Present in
  `nicobailon/pi-subagents` and partly in the paused `pi-kimi`; not needed for
  the planner/executor split.

## Roadmap

- **Phase 1 — builds and loads.** `nix build .#pi-subagent` succeeds and
  `nix flake check` passes, including `biome-lint` over the vendored TypeScript.
- **Phase 2 — agents resolve from the store.** With the extension bundled,
  invoking the tool with an unknown agent name lists `scout`, `planner`,
  `worker`, `reviewer` as available, proving `bundledAgentsDir()` resolves
  inside the Nix store.
- **Phase 3 — one real chain.** A `scout → planner → worker` chain completes on
  a real task, and the parent's tool result contains only the worker's output.
- **Phase 4 — promote or drop.** After a week of use, either flip
  `extensions/registry.nix` `subagent.stage` to `"active"`, or record here why
  hand-driven model switching won.
