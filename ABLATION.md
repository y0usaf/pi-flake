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

## Pass 3 — pi-vercel-ai-gateway (activated, not retired)

An earlier draft of this section recorded the gateway extension as retired.
That did not happen: the extension was **vendored and activated** instead.
Sources live at `extensions/pi-vercel-ai-gateway/` (package.json + src/ +
vendored package-lock.json), the package def was added to `flake.nix`, and
`pi-vercel-ai-gateway` is present in `lib.extensionPackagesFor`.

Rationale for activation rather than retirement:

| Aspect | Why active |
|--------|-----------|
| Runtime deps | Imports `@ai-sdk/gateway`, `ai` (with `zod` transitively) — none provided by pi or pi-ai, so it needs its own node_modules. |
| Build | `buildNpmPackage` with `fetchNpmDeps` over the vendored lockfile; `dontNpmBuild` (TS source is loaded by pi's jiti, no build step needed). |
| Consumers | Registered in `extensionPackagesFor`; bundled by `pi-full` via `defaultExtensionPackagesFor`. |
| Verification | `nix build .#pi-vercel-ai-gateway` and `nix flake check` pass ("all checks passed!"). |

## Declarations updated (pass 3, corrected)

- `extensions/pi-vercel-ai-gateway/`: vendored verbatim from upstream
  (Kushalkhemka/pi-vercel-ai-gateway) — package.json, src/ (index.ts,
  catalog.ts, messages.ts, usage.ts), README.md, LICENSE, package-lock.json.
- `flake.nix`: added the `pi-vercel-ai-gateway` package def (buildNpmPackage)
  and its `lib.extensionPackagesFor` entry.

## Exposed derivation set after pass 3 (x86_64-linux)

pi, pi-chronobreak, pi-webfetch, pi-recap, pi-fabric, pi-vercel-ai-gateway,
prime-agent, prime-bun, pi-full, default.

Checks: 7 gates (biome-lint, kernel-python-wired,
patch-avoid-network-model-regeneration, patch-default-package-sources-env,
pi-build, telemetry-disabled, pi-vercel-ai-gateway-build).

Verification: `nix build .#pi-vercel-ai-gateway` and `nix flake check` pass
("all checks passed!").

## Pass 3 — historical draft (SUPERSEDED)

The draft below claimed `pi-vercel-ai-gateway` was retired in this pass
(registry moved to `stage = "retired"`, package def removed). That never
shipped: the extension was **activated** instead — vendored, built via
`buildNpmPackage`, registered in `extensionPackagesFor`, and verified by
`nix build .#pi-vercel-ai-gateway` + `nix flake check` ("all checks passed!").
The corrected record is in "Pass 3 — pi-vercel-ai-gateway (activated, not
retired)" above; the draft text is preserved verbatim for history only.

<details><summary>Superseded draft (inactive — do not act on)</summary>



## Declarations updated (pass 3 — superseded draft)

- `extensions/registry.nix`: `vercel-ai-gateway` moved below the active
  block to `stage = "retired"` with `dir = "retired/pi-vercel-ai-gateway"`.
- `flake.nix`: removed the `pi-vercel-ai-gateway` package def and its
  `extensionPackagesFor` entry.

## Exposed derivation set after pass 3 (x86_64-linux) — superseded draft

pi, pi-chronobreak, pi-webfetch, pi-recap, pi-fabric, prime-agent, prime-bun,
pi-full, default.

Checks: 6 gates (unchanged from pass 2).

Verification: `nix flake check` passes ("all checks passed!").

</details>
