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
(e.g. `pi-rlm`, `sting8k_pi-vcc`, `pi-hashline`, `pi-exec`, `pi-fleet`) were
retained at the time per the registry contract ("retired source is history");
not part of this ablation. Pass 5 later wiped them.

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

## Pass 4 — pi-fabric

Fabric is retired from the default bundle; its source is preserved under
`extensions/retired/pi-fabric/`. No active in-tree extension consumes Fabric.

## Declarations updated (pass 4)

- `extensions/registry.nix`: `fabric` moved to `stage = "retired"` with
  `dir = "retired/pi-fabric"`.
- `flake.nix`: removed the `pi-fabric` package, Fabric checks, and its
  `extensionPackagesFor` entry; the generic nested-bundle check now uses
  active `chronobreak`.
- `biome.jsonc`: removed the obsolete active-source exclusion.
- `nix/fabric-package-lock.json`: removed with its only consumer.

## Exposed derivation set after pass 4 (x86_64-linux)

pi, pi-chronobreak, pi-recap, pi-vercel-ai-gateway, prime-agent, prime-bun,
pi-full, default, donsetch, pi-donsetch.

Checks: 8 gates remain (pi-build, pi-nested-bundle, biome-lint,
telemetry-disabled, kernel-python-wired, patch-avoid-network-model-regeneration,
patch-default-package-sources-env, donsetch-built).

Verification: `nix build .#pi-full --no-link` and `nix flake check` pass.

## Pass 5 — retired/ wiped

All of `extensions/retired/` (219M on disk, 735 tracked files across 26
trees) was deleted. Git history is now the only archive of retired sources.

- `extensions/registry.nix`: dropped the 11 `stage = "retired"` entries
  (aliases, fabric, webfetch, yourshell, z-exec, fleet, sentinel,
  sentinel-audit, heartbeat, hashline, fff); the `retired` stage stays
  documented for future use.
- `flake.nix`: dropped the now-dead `retired` exclusion from the biome-lint
  source filter.
- `README.md`: the lifecycle table now points at git history instead of
  `extensions/retired/`.

Verification: `nix flake check --no-build` passes ("all checks passed!").

## Pass 6 — pi-vercel-ai-gateway retired

The vendored gateway provider (Kushalkhemka/pi-vercel-ai-gateway v1.2.1) is
deleted: 8 tracked files plus ignored `node_modules` (211M on disk). Git
history is the archive.

It was not a catalog override: it registered provider `vercel-ai-gateway` with
its own `api` (`vercel-ai-gateway-native`, an AI SDK `streamText` bridge to
`https://ai-gateway.vercel.sh/v1/ai`) and one model per Gateway endpoint. Deltas
the built-in provider does not carry:

| Extension behaviour | Built-in `vercel-ai-gateway` provider |
| --- | --- |
| `<model>@<slug>` ids pinning `providerOptions.gateway.only` | not present; core's catalog has no `@` ids |
| AI SDK transport with `gateway: { caching: "auto", tags }` | `anthropic-messages` against `https://ai-gateway.vercel.sh` |
| Per-generation exact Gateway cost from the response | catalog-estimate costs only |
| Live endpoint discovery + 24h catalog cache | catalog refreshed into `nix/model-data/` at build time |

### Declarations updated (pass 6)

- `extensions/pi-vercel-ai-gateway/`: deleted (LICENSE, README.md,
  package.json, package-lock.json, src/{catalog,index,messages,usage}.ts).
- `extensions/registry.nix`: dropped the `vercel-ai-gateway` entry; the registry
  is now chronobreak, donsetch, fusion, jev, recap.
- `flake.nix`: removed the `pi-vercel-ai-gateway` `buildNpmPackage` def
  (npmDepsHash and the node_modules assertions with it) and its
  `lib.extensionPackagesFor` entry.
- `biome.jsonc`: removed the dead vendored-source exclusion.
- `nix/model-data/vercel-ai-gateway.json`: kept — it is pi's own provider
  catalog for the built-in provider, not the extension's.

### Consumers outside this repo

`~/finix` lists the deleted source path in three `settings.json` `packages`
lists (`modules/dev/ai/pi/default.nix:100`, `modules/dev/ai/omp.nix:58`,
`modules/dev/ai/prime-agent.nix:23`) and selects `@`-suffixed models in
`enabledModels` plus a `compat.vercelGatewayRouting` override for
`zai/glm-5.3-flash`. Those entries need the path dropped and the model ids
retargeted at core's catalog.

### Exposed derivation set after pass 6 (x86_64-linux)

donsetch, omp, omp-full, pi, pi-chronobreak, pi-donsetch, pi-full, pi-fusion,
pi-jev, pi-recap, prime-agent, prime-bun, default.

Checks: 8 gates (biome-lint, donsetch-built, kernel-python-wired,
omp-full-built, patch-default-package-sources-env, pi-build, pi-nested-bundle,
telemetry-disabled).

Verification: `nix flake check` passes ("all checks passed!"); `pi-full` now
bundles chronobreak, donsetch, jev, recap.

## Pass 7 — pi-jev retired

Pass 7 deletes the first-party TypeSafe Jev extension, `@y0usaf/pi-jev` 0.1.0.
It was 8 tracked files with no ignored build output, and `3133c3e` is the last
commit that has it.

Jev stays reachable. Pi core ships a `typesafe` provider that serves the
`jev-latest` classifier with `TYPESAFE_API_KEY`, and codemode's
`models.classify` reaches it. These go with the extension:

| Extension behaviour | After pass 7 |
| --- | --- |
| `tool_call` gate on `bash`/`write`/`edit`, four questions per call, shadow mode by default | calls run unjudged |
| `tool_result` judge on `bash` output: secret leak, failure class, one advice line | output passes through unchanged |
| `jev_ask` tool | codemode's `models.classify` against `typesafe/jev-latest` |
| `/jev` command and `jev:` footer status | none |

### Declarations updated (pass 7)

- `extensions/pi-jev/`: deleted (LICENSE, README.md, package.json,
  src/{client,config,gate,index,output}.ts).
- `extensions/registry.nix`: dropped the `jev` entry; the registry is now
  chronobreak, donsetch, fusion, recap.
- `flake.nix`: removed the `pi-jev` `mkPiExtension` def and its
  `lib.extensionPackagesFor` entry.
- `README.md`: dropped the `pi-jev` extension-table row and package line.
- `nix/model-data/typesafe.json` and the `typesafe/jev` entry in
  `nix/model-data/cloudflare-workers-ai.json`: kept. Both are pi's own
  provider catalogs.

### Consumers outside this repo

`~/finix` never names jev. It gets the extension only through `pi-full`
(`modules/dev/packages.nix:7`), so the next `pi-flake` input update drops it
without a finix edit. One file stays behind. `~/.pi/agent/pi-jev.json` is the
extension's user config and only sets `apiKeyFile` to
`~/Tokens/TYPESAFE_API_KEY.txt`. `.pi` is on the finix persistence allowlist,
so the file survives reboots with nothing left to read it. Delete it after the
switch. Until then the running `pi-full` still reads it.

### Exposed derivation set after pass 7 (x86_64-linux)

donsetch, omp, omp-full, pi, pi-chronobreak, pi-donsetch, pi-full, pi-fusion,
pi-recap, prime-agent, prime-bun, default.

Checks: 8 gates, unchanged from pass 6.

Verification: `nix flake check` passes ("all checks passed!"); `pi-full` now
bundles chronobreak, donsetch, recap.
