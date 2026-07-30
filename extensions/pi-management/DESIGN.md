# Design record

## Locked decisions

- **PI_EXT_DISABLED gate — keep the workaround (2026-07-30).** The root flake generates the same `.pi-gate.ts` shim for every bundled extension in `bundledExtensions`; each shim reads the caller-process `PI_EXT_DISABLED` value and skips its named factories. The variable is genuinely settable by any extension or the user, and the generated gate is uniform rather than a first-party-only code path. Therefore this is **not** a `canon:no-privileged-path` violation. It is a documented workaround for pi having no public extension-disable API. If upstream pi ships a public extension-disable API, replace this projection and remove the workaround.
- **Bundle identity coupling (2026-07-30).** `SELF_NAME = "management"` in `src/extensions.ts` must match the root flake `bundledExtensions` attribute name. Drift makes the manager appear as a toggleable extension; disabling it locks the user out of both menus, as the README admits, and recovery requires hand-editing `extension-settings.json`.
- **Two stores, not one (2026-07-30).** Keep separate `tool-settings.json`/`disabledTools` and `extension-settings.json`/`disabledExtensions` stores. Their independent files and keys preserve existing on-disk data and keep tool and extension policy domains separate; `src/store.ts` is shared machinery parameterized for those distinct shapes.
- **Preserve `removedByUs` tracking (2026-07-30).** `src/tools.ts` records tools this extension removed so later `setActiveTools` enforcement can restore only its own removals. This prevents clobbering tool additions made by other extensions or runtime modes.

## Architecture

- `src/index.ts` is the **extension boundary**: it registers the tool and extension command/hook surfaces with pi.
- `src/store.ts` is **machinery**: versioned JSON parsing, atomic serialized persistence, warning diagnostics, and shared status severity.
- `src/tools.ts` is **decision-making plus UI**: tool discovery/category decisions, active-set reconciliation (including ownership tracking), and `/tools` plus `/tools-status` presentation.
- `src/extensions.ts` is **decision-making plus UI**: discovery-source and projection decisions, bundle gating/settings writes, and `/extensions` plus `/extensions-status` presentation.
- The status commands currently emit human-formatted notification text rather than a stable machine-readable format. A parseable mode is n/a for this small interactive extension boundary; it would reverse if another program needs a supported status interface, at which point add an explicit JSON output contract (rather than making existing prose accidental API).

## Deferred

- **Generate `SELF_NAME` instead of hand-maintaining it.** The root Nix gate generator should inject the bundle attribute name into the extension source (or a generated module/config consumed by it). That prevents attribute/source drift that can make the manager disable itself and lock the user out of both menus. This extension cannot implement it without editing the root `flake.nix`, which is outside this change's ownership.
- **Machine-readable status output.** `/tools-status` and `/extensions-status` are formatted text in `ctx.ui.notify`; no small no-code-addition change makes them a stable parseable interface. Revisit when a consumer and output contract exist.

## Roadmap

- **Phase 1 — Discovery diagnostics:** malformed manifests and unreadable discovery directories warn through the shared store channel; check that warnings appear in the matching status diagnostics.
- **Phase 2 — Policy projections:** check that bundle toggles update `PI_EXT_DISABLED`, user/project toggles update pi settings patterns, and reload re-reads persisted state.
- **Phase 3 — Tool ownership:** check that disabling removes a tool, re-enabling restores only tools tracked in `removedByUs`, and externally removed tools remain marked external.
- **Phase 4 — Release verification:** run the extension flake's Nix build/check and confirm the four-heading design invariant with `rg '^## (Locked decisions|Architecture|Deferred|Roadmap)' DESIGN.md`.
