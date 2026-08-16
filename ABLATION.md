# ABLATION — removed paths (dead / unconsumed surface)

Companion to `DESIGN.md`. Records derivations removed during the pi-flake
surface ablation and the source paths removed with them.

## Removed derivations

| Removed package | Why dead | Before | After |
|-----------------|----------|--------|-------|
| `pi-tools` | Retired in `extensions/registry.nix`; built as a package but excluded from `pi-full`/`extensionPackagesFor` (filter drops `retired`). Only reference was the package def itself. Grepped consumers: `flake.nix` only. | built | removed |
| `pi-unified-edit` | Same as pi-tools: retired stage, built but never bundled. Consumers: `flake.nix` only. | built | removed |
| `pi-batch` | Same as pi-tools: retired stage, built but never bundled. Consumers: `flake.nix` only. | built | removed |
| `prime-agent-full` | Composite fork variant (`prime-agent` + `chronobreak`). Not in the contract keep-list (`pi`, `pi-full`, `prime-agent`, `prime-bun`). Its only consumer was the flake's own `telemetry-disabled` check (a self-reference, not a real downstream user). Killed as the dead fork variant. | built | removed |

## Removed source paths

- `extensions/retired/pi-tools/`
- `extensions/retired/pi-unified-edit/`
- `extensions/retired/pi-batch/`

## Declarations updated

- `flake.nix`: deleted the four package attrs (`pi-tools`, `pi-unified-edit`,
  `pi-batch`, `prime-agent-full`); dropped `tools`/`unified-edit`/`batch` from
  `lib.extensionPackagesFor`; dropped the `prime-agent-full` grep line from the
  `telemetry-disabled` check.
- `extensions/registry.nix`: removed the `tools`, `batch`,
  `unified-edit` lifecycle entries (their sources are gone). The single
  declaration remains `extensions/registry.nix`.
- `README.md`: removed the `prime-agent-full` variant references.

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
- **After (17):** pi, pi-chronobreak, pi-agents, pi-webfetch, pi-yourshell,
  pi-fff, pi-gecko-websearch, pi-sentinel, pi-heartbeat, pi-ponytail,
  pi-caveman, pi-recap, pi-aliases, prime-agent, prime-bun, pi-full, default.
- Checks unchanged (7 gates preserved): biome-lint, kernel-python-wired,
  patch-avoid-network-model-regeneration, patch-default-package-sources-env,
  pi-build, pi-fff-override, telemetry-disabled.