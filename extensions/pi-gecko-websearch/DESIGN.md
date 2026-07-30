## Locked decisions
- Hand-rolled Marionette client instead of an npm dependency, because the extension documents zero extra dependencies (2026-07-30).
- Per-engine regex table in `src/parsers.ts` is the rung-2 data form, keeping engine-specific parsing explicit (2026-07-30).
- Firefox profile and cookie reuse copies browser session data into a temporary profile so the user's live profile is not locked (2026-07-30).
- A browser pool leases exclusive browser instances for concurrent operations (2026-07-30).

## Architecture
- `src/index.ts` is the extension boundary and makes tool decisions.
- `src/parsers.ts` is decision-making: it selects and applies the per-engine parsing rules.
- `src/browser.ts` is machinery: it manages the browser pool, profiles, processes, and leases.
- `src/marionette.ts` is machinery: it implements the protocol client.
- The browser pool has no inspect path; this is n/a unless observable pool state is needed for diagnosing stuck or contended operations.

## Deferred
- An inspect path for browser-pool state was left out to keep the operational surface minimal; add it if pool contention or stuck leases need diagnosis.

## Roadmap
- Phase 1: keep engine parsers explicit; criterion: each supported engine has its own parser configuration.
- Phase 2: preserve isolated profile reuse; criterion: browser operations copy cookies without locking the user's profile.
- Phase 3: improve pool observability if needed; criterion: expose inspectable state when diagnosing contention becomes necessary.
