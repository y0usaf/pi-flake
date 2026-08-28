# ABLATION — removed paths (dead / unconsumed surface)

Companion to `DESIGN.md`. Records derivations removed during the pi-flake
surface ablation and the source paths removed with them.

## Removed derivations

| Removed package | Why dead | Before | After |
|-----------------|----------|--------|-------|
| `pi-ponytail`, `pi-caveman` | Retired by removing their upstream inputs and package wiring; no consumers remain. | built | removed |
| `pi-tools` | Retired in `extensions/registry.nix`; built as a package but excluded from `pi-full`/`extensionPackagesFor` (filter drops `retired`). Only reference was the package def itself. Grepped consumers: `flake.nix` only. | built | removed |
| `pi-unified-edit` | Same as pi-tools: retired stage, built but never bundled. Consumers: `flake.nix` only. | built | removed |
| `pi-batch` | Same as pi-tools: retired stage, built but never bundled. Consumers: `flake.nix` only. | built | removed |
| `prime-agent-full` | Composite fork variant (`prime-agent` + `chronobreak`). Not in the contract keep-list (`pi`, `pi-full`, `prime-agent`, `prime-bun`). Its only consumer was the flake's own `telemetry-disabled` check (a self-reference, not a real downstream user). Killed as the dead fork variant. | built | removed |

## Removed source paths

- `extensions/retired/pi-tools/`
- `extensions/retired/pi-unified-edit/`
- `extensions/retired/pi-batch/`

## Declarations updated

- `flake.nix`: deleted the `pi-ponytail` and `pi-caveman` package attrs and
  upstream inputs, plus the four earlier package attrs (`pi-tools`, `pi-unified-edit`,
  `pi-batch`, `prime-agent-full`); dropped `tools`/`unified-edit`/`batch` from
  `lib.extensionPackagesFor`; dropped the `prime-agent-full` grep line from the
  `telemetry-disabled` check.
- `extensions/registry.nix`: removed the `ponytail` and `caveman` entries, plus
  the `tools`, `batch`,
  `unified-edit` lifecycle entries (their sources are gone). The single
  declaration remains `extensions/registry.nix`.
- `README.md`: removed the `prime-agent-full`, `pi-ponytail`, and `pi-caveman` references.

## Removed source dirs kept as history (NOT removed in this pass)

Still-dead-but-unbuilt `extensions/retired/` trees with no flake derivation
(e.g. `pi-rlm`, `sting8k_pi-vcc`, `pi-hashline`, `pi-exec`, `pi-fleet`) are
retained per the registry contract ("retired source is history"); not part of
this ablation.

## Before/after exposed derivation sets (x86_64-linux)

- **Before (21):** `base` pi, pi-chronobreak, pi-agents, pi-webfetch,
  pi-yourshell, pi-fff, pi-gecko-websearch, pi-sentinel, pi-heartbeat,
  pi-tools, pi-unified-edit, pi-batch, pi-ponytail, pi-caveman, pi-recap,
  pi-aliases, prime-agent, prime-agent-full, prime-bun, pi-full, default.
- **After (15):** pi, pi-chronobreak, pi-agents, pi-webfetch, pi-yourshell,
  pi-fff, pi-gecko-websearch, pi-sentinel, pi-heartbeat, pi-recap, pi-aliases,
  prime-agent, prime-bun, pi-full, default.
- Checks unchanged (7 gates preserved): biome-lint, kernel-python-wired,
  patch-avoid-network-model-regeneration, patch-default-package-sources-env,
  pi-build, pi-fff-override, telemetry-disabled.
## Pass 2 — fabric-superseded extensions

Fabric (`pi-fabric`) captures bash, grep/find, web search, and shell
surface, so bundled extensions covering the same tools are retired.
Rationale per extension:

| Extension | Stage | Why |
|-----------|-------|-----|
| `pi-gecko-websearch` | deleted | 263M vendored Gecko browser; web search is captured by fabric as `extensions.web_search`. |
| `pi-autoprompt` | deleted | Zero derivation/registry references; dead tree deferred from pass 1. |
| `pi-yourshell` | retired | Shell wrapper superseded by fabric bash capture. |
| `pi-sentinel` | retired | Unused monitoring surface. |
| `pi-heartbeat` | retired | Unused liveness surface. |
| `pi-aliases` | retired | grep->rg / find->fd wrapping superseded by fabric's captured tools. |
| `pi-fff` | retired | FFF-backed grep/find override superseded by fabric's captured find/grep. |

Retired sources moved to `extensions/retired/` per the registry contract;
gecko-websearch and autoprompt sources removed entirely.

## Declarations updated (pass 2)

- `extensions/registry.nix`: yourshell, sentinel, heartbeat, aliases, fff
  flipped to `stage = "retired"` with `dir = "retired/..."`; gecko-websearch
  and autoprompt entries removed.
- `flake.nix`: removed package defs for pi-gecko-websearch, pi-sentinel,
  pi-heartbeat, pi-yourshell, pi-aliases, pi-fff; dropped their
  `extensionPackagesFor` entries; dropped the `pi-fff-override` check.

## Exposed derivation set after pass 2 (x86_64-linux)

pi, pi-chronobreak, pi-webfetch, pi-recap, pi-fabric, pi-vercel-ai-gateway,
prime-agent, prime-bun, pi-full, default.

Checks: 6 gates remain (biome-lint, kernel-python-wired,
patch-avoid-network-model-regeneration, patch-default-package-sources-env,
pi-build, telemetry-disabled); `pi-fff-override` removed with pi-fff.

Verification: `nix build .#pi-full` and `nix flake check` pass
("all checks passed!").

