import type { CompactionEvent } from "./normalize.js";
import type { Sections } from "./projections.js";

// Optional, isolated, format-specific annotation. The deterministic core
// never inspects prose (principle 2); anything that needs to — e.g. pulling a
// TypeScript compiler line number out of a bash `tsc` result, or annotating a
// test-failure section — plugs in here, behind this interface. The core ships
// ZERO built-in enrichers on purpose: the redistilled core is the minimal clean
// baseline, and prose understanding is an additive concern an extension can
// register later without touching the projections.
//
// An enricher is called once per compaction, AFTER the structural sections are
// computed. It may append to (or replace) any section. It must be deterministic:
// the same event stream must yield the same contribution, so the overall
// serialization stays byte-identical for a given input (principle 5).
export interface CompactionEnricher {
  readonly name: string;
  // Decide whether this enricher has anything to add for the given event
  // stream. Returning false lets the core skip contribute() cheaply.
  applies(events: CompactionEvent[]): boolean;
  // Mutate `sections` in place to add format-specific annotation. The full
  // event stream is available so the enricher can derive its own state without
  // re-walking the raw log differently from the core.
  contribute(events: CompactionEvent[], sections: Sections): void;
}

// No built-in enrichers. Kept explicit (and exported) so tests and docs can
// reference the empty set and so the registration path stays exercised.
export const NO_BUILTIN_ENRICHERS: readonly CompactionEnricher[] = Object.freeze([]);

export const runEnrichers = (
  enrichers: readonly CompactionEnricher[],
  events: CompactionEvent[],
  sections: Sections,
): void => {
  for (const enricher of enrichers) {
    if (!enricher.applies(events)) continue;
    enricher.contribute(events, sections);
  }
};
