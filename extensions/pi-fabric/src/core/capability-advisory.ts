import type { FabricCapabilityAdvisoryConfig } from "../config.js";
import type { FabricActionDescriptor } from "../protocol.js";
import {
  buildCapabilityIndex,
  capabilityPathOnlyTerms,
  capabilityWordCandidates,
  isMostlyNonLatinPrompt,
  splitCapabilityWords,
  tokenizeCapabilityText,
  truncateAdvisoryDescription,
  type CapabilityIndex,
  type CapabilitySourceFingerprint,
} from "./capability-fingerprint.js";

export const CAPABILITY_ADVISORY_CUSTOM_TYPE = "pi-fabric-capability";
const ADVISORY_REF_PREFIX = "extensions";
// MCP capability sources are namespaced "mcp:<server>" by the provider
// adapter; their refs render from the mcp root (mcp.<server>.<tool>).
const MCP_NAMESPACE_MARKER = "mcp:";
const MCP_REF_PREFIX = "mcp";

const refPrefixFor = (namespace: string): string =>
  namespace.startsWith(MCP_NAMESPACE_MARKER) ? MCP_REF_PREFIX : ADVISORY_REF_PREFIX;

// Transcript toolCall blocks have stored arguments under input/arguments/args
// across pi versions; normalize whichever is present.
const toolCallInput = (block: unknown): Record<string, unknown> | undefined => {
  if (typeof block !== "object" || block === null) return undefined;
  const record = block as Record<string, unknown>;
  const candidate = record.input ?? record.arguments ?? record.args;
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : undefined;
};

// Custom-message content has appeared as a plain string and as pi text blocks
// across transcript versions. Normalize only actual text; malformed or richer
// blocks carry no advisory vocabulary.
const customMessageText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type === "text" && typeof text === "string") parts.push(text);
  }
  return parts.join("\n");
};
// Score quantum: the weight of a source-unique term (df = 1 → 1/df = 1) — the
// smallest unit of unambiguous evidence the 1/df scorer can express. The weak
// band is exactly one quantum wide: strong = weak + one quantum of certainty.
const SCORE_QUANTUM = 1;
// Surface-form context discount: a term that only occurs inside a path, URL,
// or filename span denotes a local artifact, not capability intent — it earns
// half a quantum. Two such collisions (1 quantum total) still can't ignite the
// strong band; a lone one sits below the default 0.9 threshold entirely.
const PATH_ONLY_DISCOUNT = SCORE_QUANTUM / 2;
const WEAK_MATCH_BAND = SCORE_QUANTUM;
const MAX_ADVISORY_SOURCES = 2;
const MAX_NAMES_PER_SOURCE = 2;
const MAX_ADVISORY_NAMES = 3;
// pi-fovea pattern: the text is the message — no bracket label. Provenance
// rides the transcript entry's custom type (pi-fabric-capability, mirroring
// fovea's pi-fovea-sync); the headline verb carries the confidence spectrum
// instead (strong "… matched your prompt." vs. weak "… might match your prompt.").

// Combustion dynamics. The advisory is a finite battery: every fire spends a
// namespace permanently (ash), so ignition is gated. Two primitives determine
// everything (see docs/capability-combustion.md):
//   q   = 1 — the score quantum above.
//   τ   = 2 turns — the patience/memory scale. Warmth W is the convolution of
//   the score signal with the exponential kernel K_τ (an EWMA with retention
//   1 − 1/τ, half-life one turn at τ=2): first-order evidence averages over
//   τ turns. The phrase window projects the same scale: 2τ survivors.
//   Smoke feedback estimates a bias, a second-order signal, so it
//   calibrates over τ² events: step θ/τ², ceiling τ² — keeping the maximum
//   furnace raise at exactly θ regardless of τ.
// Strong band ignites instantly; weak band fires when W breaches the ignition
// point, so single-turn collisions cool before they get there.
const TAU = 2;
const WARM_ALPHA = 1 - 1 / TAU; // 0.5
// Phrase locality window: two matched written words earn phrased evidence
// when they stand within 2τ survivors of each other in the prompt AND
// co-occur on one tool surface of the source (the MRF sequential-dependence
// clause). Words matched far apart, or across different tools of one
// namespace, are scatter — vocabulary collision, never phrasing.
const PHRASE_WINDOW = 2 * TAU; // 4
// Topic saturation for the script-boundary lane: a lone cross-script word
// certifies itself when it saturates the source's identity surfaces the way
// the brand does — at most one omission per τ cycle, share ≥ 1 − 1/τ.
const TOPIC_SHARE = 1 - 1 / TAU; // 1/2
// Episode gap for habituation: a written word earns an ambient-vocabulary
// episode (and rareness damping 1/(1 + e)) when it reappears at least τ²
// turns after its previous mention. Within-patience repetition stays one
// episode, so sustained intent never damps. Complete session relapse after
// τ³ turns forgives a word entirely.
const SESSION_GAP = TAU * TAU; // 4
const SESSION_RELAPSE = SESSION_GAP * TAU; // 8
const SMOKE_STEP = 1 / (TAU * TAU); // 0.25
const SMOKE_MAX = TAU * TAU; // 4
const WARM_FLOOR = 1e-3;

export interface CapabilityAdvisoryMatch {
  namespace: string;
  label: string;
  score: number;
  matchedTerms: string[];
  names: string[];
  descriptions: string[];
  omitted: number;
}

export interface CapabilityAdvisoryResult {
  content: string;
  display: boolean;
  details: { matches: CapabilityAdvisoryMatch[] };
}

type CapabilityBurnOrigin = "fired" | "organic";

// Ash record: the irreversible residue of a capability's information
// potential. origin records how the potential was spent — a hint fired vs the
// model discovering the namespace on its own — and the record is append-only:
// misfires are never reclaimed (you don't unburn paper).
export interface CapabilityBurn {
  namespace: string;
  origin: CapabilityBurnOrigin;
  at?: string;
}

const STEER_LINE =
  "Steer: prefer these captured tools over re-implementing the capability; skip if irrelevant.";

// pi's prompt expansion wraps loaded skills in an XML envelope
// (<available_skills><skill>…</skill></available_skills>; an invoked skill
// lands as <skill>…<name>…<location>…). That content is ambient context, not
// user intent — letting it through poisons the fingerprint with the skill's
// own vocabulary (e.g. a websearch skill alone fires the web-search hint).
const SKILL_REGION =
  /<available_skills\b[^>]*>[\s\S]*?(?:<\/available_skills\s*>|$)|<skill\b[^>]*>[\s\S]*?(?:<\/skill\s*>|$)/g;

const stripSkillRegions = (prompt: string): string => prompt.replace(SKILL_REGION, " ");

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

interface SourceBlock {
  namespace: string;
  label: string;
  names: string[];
  descriptions: string[];
  leftoverNames: string[];
}

// One matched written word: where it sits in the prompt's survivor stream
// (pos) and which corpus reading claimed it (term).
interface CapabilityMatchedTerm {
  pos: number;
  term: string;
}

// One advisory event can name up to two namespaces. Feedback belongs to the
// event, not to each namespace independently: using either recommendation is
// clean combustion. turnsLeft spans the firing turn plus the following turn.
interface PendingCapabilityFire {
  namespaces: ReadonlySet<string>;
  turnsLeft: number;
  used: boolean;
}

// Brand tokens of a source's label: the words that name the capability
// itself ("pi-fovea" → {fovea}; "mcp:fal-ai" → {fal}). Two-letter tokens are
// excluded — "ai", "pi" are ambient vocabulary, not a deliberate reach.
const sourceBrandTokens = (label: string): ReadonlySet<string> => {
  // The terminal namespace segment names the capability ("mcp:fal-ai" →
  // "fal-ai"); a leading "mcp:" is a structural prefix, not a brand.
  const terminal = label.includes(":") ? label.slice(label.lastIndexOf(":") + 1) : label;
  const tokens = new Set<string>();
  for (const token of tokenizeCapabilityText(terminal)) {
    if (token.length >= 3) tokens.add(token);
  }
  return tokens;
};

// Topic saturation: the share of a source's tool identity surfaces a term
// lives on. Brand words saturate their namespace ("fovea" in every pi-fovea
// tool name); glue vocabulary covers less than half of a big catalog
// ("model" in 5/11 fal tools). The cutoff lives with the engine constants.
const topicShare = (term: string, source: CapabilitySourceFingerprint): number => {
  const total = source.names.length;
  if (total === 0) return 0;
  let hits = 0;
  for (const terms of source.toolTerms) {
    if (terms?.has(term)) hits += 1;
  }
  return hits / total;
};

// Prompt locality is evaluated only after scoring one tool surface. The caller
// therefore supplies the co-surface clause by construction; this helper owns
// only the sequential-dependence clause. Keeping those operations together at
// the call site prevents one valid pair from certifying namespace-wide mass.
const hasPromptLocality = (matched: CapabilityMatchedTerm[]): boolean => {
  for (let a = 0; a < matched.length; a++) {
    for (let b = a + 1; b < matched.length; b++) {
      const first = matched[a];
      const second = matched[b];
      if (first === undefined || second === undefined) continue;
      if (second.pos - first.pos > PHRASE_WINDOW) break; // positions ascend
      return true;
    }
  }
  return false;
};

// pi-fovea icon/indent pattern: one flat ▪ bullet per shown tool with the
// fully-qualified ref, a source tag in parentheses when more than one source
// is in play, and the truncated description after an em dash on the rich
// rung. Leftover tools collapse into an indented "~ +N more in <source>"
// counter line, mirroring fovea's "~ +N more in <file>".
const renderCandidates = (blocks: SourceBlock[], withDescriptions: boolean): string[] => {
  const multiSource = blocks.length > 1;
  const lines: string[] = [];
  for (const block of blocks) {
    const refPrefix = refPrefixFor(block.namespace);
    block.names.forEach((name, index) => {
      const ref = `${refPrefix}.${name}`;
      const sourceTag = multiSource ? ` (${block.label})` : "";
      const description = block.descriptions[index] ?? "";
      const tail =
        withDescriptions && description
          ? ` — ${truncateAdvisoryDescription(description)}`
          : "";
      lines.push(`▪ ${ref}${sourceTag}${tail}`);
    });
    if (block.leftoverNames.length > 0) {
      const listed = block.leftoverNames.slice(0, 3).join(", ");
      lines.push(
        `  ~ +${block.leftoverNames.length} more in ${block.label}: ${listed}${block.leftoverNames.length > 3 ? ", …" : ""}`,
      );
    }
  }
  return lines;
};

// Leanest non-trivial rung: one bullet per source, bare refs with leftovers
// inline — the actionable identity of each capability, no prose.
const renderFlat = (blocks: SourceBlock[]): string[] =>
  blocks.map((block) => {
    const refs = block.names.map((name) => `${refPrefixFor(block.namespace)}.${name}`);
    const listed = block.leftoverNames.slice(0, 3).join(", ");
    const leftover =
      block.leftoverNames.length > 0
        ? `, ~ +${block.leftoverNames.length} more: ${listed}${block.leftoverNames.length > 3 ? ", …" : ""}`
        : "";
    return `▪ ${block.label} · ${refs.join(", ")}${leftover}`;
  });

export class CapabilityAdvisor {
  #index: CapabilityIndex = buildCapabilityIndex([]);
  readonly #slices = new Map<string, FabricActionDescriptor[]>();
  #ash = new Map<string, CapabilityBurn>();
  #warmth = new Map<string, number>();
  #pendingFires: PendingCapabilityFire[] = [];
  #smokeStreak = 0;
  // Habituation ledger: word → last turn seen + completed episodes. A word the
  // user keeps returning to across long pauses is ambient vocabulary, not
  // intent. Consecutive-turn repetition NEVER counts (sustained presence IS
  // the weak band's ignition signature); a pause of τ² turns between
  // appearances starts a fresh episode. Like warmth, it resets with the
  // session ledger — ash alone is permanent.
  #turnNo = 0;
  #mentions = new Map<string, { last: number; extra: number }>();
  // Echo ledger: every latin word we ourselves rendered in advisory content.
  // Our own utterances must never score as intent — quoting or parroting the
  // advisory back cannot re-derive intent from our own voice. Like ash and
  // the fire count, this is branch-derived: reset clears it and transcript
  // replay reconstructs exactly the current history.
  #emitted = new Set<string>();
  #firedTotal = 0;

  // Descriptor sources refresh independently (captured tools on pi tool
  // catalog changes, MCP on descriptor-cache updates) without clobbering each
  // other; the matching index is rebuilt from the union.
  setSource(source: string, descriptors: FabricActionDescriptor[]): void {
    if (descriptors.length === 0) this.#slices.delete(source);
    else this.#slices.set(source, descriptors);
    this.#index = buildCapabilityIndex([...this.#slices.values()].flat());
  }

  refresh(descriptors: FabricActionDescriptor[]): void {
    this.setSource("captured", descriptors);
  }

  hasSources(): boolean {
    return this.#index.sourceCount > 0;
  }

  reset(): void {
    this.#warmth.clear();
    this.#pendingFires = [];
    this.#turnNo = 0;
    this.#mentions.clear();
    this.#emitted.clear();
    this.#smokeStreak = 0;
    this.#firedTotal = 0;
  }

  // Durable advisory state derives from the session transcript, never a side
  // store: fired hints ARE custom messages (their content is the echo ledger
  // and each entry spends one cap unit), while organic use IS the tool calls
  // that name captured tools. Replay rebuilds ash, echoes, and fire count at
  // the current branch leaf. Warmth, smoke, and habituation stay transient.
  restoreAshFromEntries(
    entries: Iterable<unknown>,
    nameToNamespace: (
      toolName: string,
      input?: Record<string, unknown>,
    ) => string | string[] | undefined,
  ): void {
    // Transcript-derived state is replaced, never merged: both branch rewinds
    // and process reloads must reproduce exactly the current history.
    this.#ash.clear();
    this.#emitted.clear();
    this.#firedTotal = 0;
    for (const entryUnknown of entries) {
      const entry = entryUnknown as {
        type?: unknown;
        customType?: unknown;
        timestamp?: unknown;
        content?: unknown;
        details?: unknown;
        message?: unknown;
      };
      const at =
        typeof entry.timestamp === "string" ? entry.timestamp : "";
      if (
        entry.type === "custom_message" &&
        entry.customType === CAPABILITY_ADVISORY_CUSTOM_TYPE
      ) {
        this.#firedTotal += 1;
        this.#rememberEmission(customMessageText(entry.content));
        const matches = (entry.details as { matches?: unknown } | undefined)
          ?.matches;
        if (Array.isArray(matches)) {
          for (const match of matches) {
            const namespace = (match as { namespace?: unknown } | undefined)
              ?.namespace;
            if (typeof namespace === "string" && namespace.length > 0) {
              this.#burn(namespace, "fired", at);
            }
          }
        }
        continue;
      }
      if (entry.type === "message") {
        const message = entry.message as
          | { role?: unknown; content?: unknown }
          | undefined;
        if (message?.role !== "assistant" || !Array.isArray(message.content)) {
          continue;
        }
        for (const block of message.content) {
          const { type, name } = block as { type?: unknown; name?: unknown };
          if (type !== "toolCall" || typeof name !== "string") continue;
          const resolved = nameToNamespace(name, toolCallInput(block));
          if (resolved === undefined) continue;
          const namespaces = Array.isArray(resolved) ? resolved : [resolved];
          for (const namespace of namespaces) {
            if (typeof namespace === "string" && namespace.length > 0) {
              this.#burn(namespace, "organic", at);
            }
          }
        }
      }
    }
  }

  #rememberEmission(content: string): void {
    for (const token of splitCapabilityWords(content)) {
      this.#emitted.add(token);
      this.#emitted.add(token.toLowerCase());
    }
  }

  // Idempotent append: a namespace burns at most once per session history.
  #burn(namespace: string, origin: CapabilityBurn["origin"], at: string): boolean {
    if (this.#ash.has(namespace)) return false;
    this.#ash.set(namespace, {
      namespace,
      origin,
      at: at.length > 0 ? at : new Date().toISOString(),
    });
    return true;
  }

  ashRecords(): CapabilityBurn[] {
    return [...this.#ash.values()];
  }

  // Organic poisoning: the model reached this namespace without a hint, so
  // the capability's information potential is already spent. Burn it as ash
  // with origin "organic". Returns true when the ash set changed (persist it).
  observeToolUse(namespace: string): boolean {
    // Attribution has a τ-turn grace window. A model that follows the hint on
    // the next turn still used the advisory; closing the event at the first
    // turn boundary manufactured smoke and needlessly hardened the furnace.
    for (const fire of this.#pendingFires) {
      if (fire.namespaces.has(namespace)) fire.used = true;
    }
    return this.#burn(namespace, "organic", new Date().toISOString());
  }

  // Resolve feedback in event order. Each fire spans its firing turn and the
  // following turn (τ checkpoints): use anywhere in that window is clean;
  // only an expired unused event emits one smoke quantum. Overlapping events
  // stay independent, and the latest resolved outcome owns the final streak.
  endTurn(): void {
    const pending: PendingCapabilityFire[] = [];
    for (const fire of this.#pendingFires) {
      if (fire.used) {
        this.#smokeStreak = 0;
        continue;
      }
      fire.turnsLeft -= 1;
      if (fire.turnsLeft <= 0) {
        this.#smokeStreak = Math.min(this.#smokeStreak + 1, SMOKE_MAX);
      } else {
        pending.push(fire);
      }
    }
    this.#pendingFires = pending;
  }

  evaluate(
    prompt: string,
    config: FabricCapabilityAdvisoryConfig,
  ): CapabilityAdvisoryResult | undefined {
    if (config.mode === "disabled") return undefined;
    if (this.#firedTotal >= config.maxPerSession) return undefined;

    // Warmth retention α·W applies every evaluated turn, matched or not.
    for (const [namespace, current] of this.#warmth) {
      const decayed = current * WARM_ALPHA;
      if (decayed < WARM_FLOOR) this.#warmth.delete(namespace);
      else this.#warmth.set(namespace, decayed);
    }
    // Smoke raises the weak-band ignition point: the furnace demands more
    // sustained evidence after a streak of ignored fires.
    const ignitionPoint = config.threshold * (1 + SMOKE_STEP * this.#smokeStreak);

    const stripped = stripSkillRegions(prompt);
    const mostlyNonLatin = isMostlyNonLatinPrompt(stripped);
    // Written words before camelCase atomization, each with its corpus
    // candidate readings (camelCase atoms plus the word itself). One written
    // word is one unit of intent and of evidence: the scorer and the overlap
    // gate below both count these, so casing a word differently never changes
    // either count. Words with no surviving candidates drop out. Echo ledger
    // words — anything we ourselves rendered in an earlier advisory — never
    // enter the stream: our utterances are evidence of nothing.
    const promptWords: { key: string; candidates: Set<string> }[] = [];
    for (const word of splitCapabilityWords(stripped)) {
      const key = word.toLowerCase();
      if (this.#emitted.has(word) || this.#emitted.has(key)) continue;
      const candidates = new Set(capabilityWordCandidates(word));
      if (candidates.size > 0) promptWords.push({ key, candidates });
    }
    if (promptWords.length === 0 || this.#index.sourceCount === 0) return undefined;

    // Habituation ledger. Turn bump, then record: brand terms never accrue
    // (typing a source's name is a claim, not vocabulary — it keeps its full
    // rarity). Episodes complete only across a τ²-turn pause; consecutive
    // repetition stays one episode, so the weak band's sustained-presence
    // signature never damps itself. Absence of τ³ turns relapses a word to
    // fresh: long-dead chatter is forgiven rather than fossilized.
    this.#turnNo += 1;
    const brandWords = new Set<string>();
    for (const source of this.#index.sources) {
      for (const token of sourceBrandTokens(source.label)) brandWords.add(token);
    }
    for (const { key } of promptWords) {
      if (brandWords.has(key)) continue;
      const mention = this.#mentions.get(key);
      if (mention === undefined) {
        this.#mentions.set(key, { last: this.#turnNo, extra: 0 });
        continue;
      }
      const gap = this.#turnNo - mention.last;
      mention.last = this.#turnNo;
      if (gap >= SESSION_RELAPSE) mention.extra = 0;
      else if (gap >= SESSION_GAP) mention.extra += 1;
    }

    const pathOnlyTerms = capabilityPathOnlyTerms(stripped);
    // Each matched written word contributes the rarity of its rarest matched
    // reading (weight = 1/df is monotone, so max weight = min df): exactly
    // one quantum per word, whichever way the word was cased — halved when the
    // matched reading only ever occurs inside a path/URL/filename span.
    const scoreWords = (hasTerm: (term: string) => boolean) => {
      let score = 0;
      let matchedWords = 0;
      const contributingTerms: string[] = [];
      const matched: CapabilityMatchedTerm[] = [];
      promptWords.forEach(({ key, candidates }, pos) => {
        let bestWeight = 0;
        let bestTerm: string | undefined;
        for (const term of candidates) {
          if (!hasTerm(term)) continue;
          const frequency = this.#index.docFrequency(term);
          if (frequency === 0) continue;
          const weight = (1 / frequency) * (pathOnlyTerms.has(term) ? PATH_ONLY_DISCOUNT : 1);
          if (weight > bestWeight) {
            bestWeight = weight;
            bestTerm = term;
          }
        }
        if (bestTerm === undefined) return;
        // Habituation damping: each completed episode (a return across a
        // τ²-turn pause) discounts the word's rarity by one more count —
        // weight 1/(1 + e). The matched-word count and every structural gate
        // are untouched; only the arithmetic claim decays.
        const extra = this.#mentions.get(key)?.extra ?? 0;
        matchedWords += 1;
        score += bestWeight / (1 + extra);
        contributingTerms.push(bestTerm);
        matched.push({ pos, term: bestTerm });
      });
      return { score, matchedWords, contributingTerms, matched };
    };

    const matches: CapabilityAdvisoryMatch[] = [];
    // Per-source record of how today's fire ignited: true when this turn's
    // evidence alone carried it (strong band), false for warmth arrivals.
    const fireBands = new Map<string, boolean>();
    for (const source of this.#index.sources) {
      if (this.#ash.has(source.namespace)) continue;
      // Score with 1/df term weights, not raw idf: idf magnitude collapses on
      // small captured catalogs (ln(4/2) < 1), silently starving matches below
      // the threshold, while 1/df keeps "two distinctive words ≈ one source"
      // meaningful at any catalog size.
      const unit = scoreWords((term) => source.tf.has(term));
      const namespaceScore = unit.score;
      if (namespaceScore < config.threshold) continue;
      // Script-boundary exception: inside non-latin prose a lone latin word
      // cannot be a vocabulary collision — the writer had to leave their
      // input method to type it. But switching input methods is only proof
      // of deliberateness, not of intent: a teaching question about the
      // host software ("model とは何ですか") reaches across the boundary the
      // same way a brand does. The boundary word must therefore certify
      // itself against the source it names: either it IS the source's brand
      // (a ≥3-letter token of the label's terminal segment) or it saturates
      // the source's identity surfaces at brand level (TOPIC_SHARE = 1 − 1/τ —
      // brand shape, not glue shape). Only the gate moves; the score (and
      // the might-match register it draws) stays.
      const scriptSwitched =
        mostlyNonLatin &&
        unit.matchedWords === 1 &&
        unit.contributingTerms.some(
          (term) =>
            this.#index.docFrequency(term) === 1 &&
            (sourceBrandTokens(source.label).has(term) ||
              topicShare(term, source) >= TOPIC_SHARE),
        );
      // Lone-word starvation: one matched written word is never intent, in
      // any latin prose. A source-unique word (df = 1) used to earn the weak
      // band on its own, but interrogative filler ("what", "project") is
      // source-unique in small catalogs too, and warmed fal-style namespaces
      // to ignition inside four ordinary questions. Lone words now neither
      // fire nor warm — with two narrow exceptions: the script boundary
      // above, and a word that names its own source. Typing the source's
      // brand ("fovea", "github") unaccompanied is a deliberate reach, so it
      // keeps the weak trickle path (never instant). Ambiguous short label
      // tokens ("ai", "pi") do not qualify.
      const namesItself = unit.contributingTerms.some((term) =>
        sourceBrandTokens(source.label).has(term),
      );
      if (unit.matchedWords < 2 && !scriptSwitched && !namesItself) continue;

      // A phrase and its mass must come from the SAME tool surface. The old
      // Boolean locality certificate was attached to namespaceScore, so one
      // weak local pair could launder arbitrarily many words scattered across
      // a wide server into a strong fire. Score every surface independently
      // and retain the strongest threshold-clearing local one. If no surface
      // certifies, namespace-wide overlap is scatter and is bounded to q.
      let phrasedUnit: ReturnType<typeof scoreWords> | undefined;
      for (const toolTerms of source.toolTerms) {
        if (toolTerms === undefined) continue;
        const candidate = scoreWords((term) => toolTerms.has(term));
        if (candidate.score < config.threshold || !hasPromptLocality(candidate.matched)) {
          continue;
        }
        if (phrasedUnit === undefined || candidate.score > phrasedUnit.score) {
          phrasedUnit = candidate;
        }
      }
      const phrased = phrasedUnit !== undefined;
      const score = scriptSwitched
        ? namespaceScore
        : (phrasedUnit?.score ?? Math.min(namespaceScore, SCORE_QUANTUM));
      // The strong band ignites on one surface's phrased mass only: sφ ≥ θ + B
      // buys instant fire. Catalog breadth cannot alter sφ; scatter remains q.
      const strong = phrased && score >= config.threshold + WEAK_MATCH_BAND;
      if (!strong && !scriptSwitched) {
        // Weak band: accumulate the effective score this turn. Same-surface
        // phrases feed their own mass; scatter has already been capped at q,
        // so one smoke raises θ_i above its asymptote for the session.
        const warmth = (this.#warmth.get(source.namespace) ?? 0) + (1 - WARM_ALPHA) * score;
        this.#warmth.set(source.namespace, warmth);
        if (warmth < ignitionPoint) continue;
      }

      fireBands.set(source.namespace, strong);
      // Rank this source's tools by their own prompt-word overlap so the
      // most relevant refs lead (e.g. openai_websearch before openai_image on
      // a web-search prompt) instead of inherited catalog order.
      const order = source.names.map((_, index) => index).sort((a, b) => {
        const scoreAt = (index: number): number => {
          const terms = source.toolTerms[index];
          return terms === undefined ? 0 : scoreWords((term) => terms.has(term)).score;
        };
        return scoreAt(b) - scoreAt(a) || a - b;
      });
      matches.push({
        namespace: source.namespace,
        label: source.label,
        score,
        matchedTerms: (phrasedUnit ?? unit).contributingTerms.sort(
          (a, b) => this.#index.docFrequency(a) - this.#index.docFrequency(b),
        ),
        names: order.map((index) => source.names[index] ?? "").filter((name) => name !== ""),
        descriptions: order.map((index) => source.descriptions[index] ?? ""),
        omitted: 0,
      });
    }
    if (matches.length === 0) return undefined;
    matches.sort(
      (a, b) => b.score - a.score || a.namespace.localeCompare(b.namespace),
    );
    const included = matches.slice(0, MAX_ADVISORY_SOURCES);
    // The register reports HOW the fire ignited, not how big the score was:
    // "matched" only when this turn's evidence alone would have ignited on
    // its own (phrased, above the strong bar). A fire that arrived through
    // sustained warmth — trickle, brand reach, script boundary — reads
    // "might match", however large the accumulated raw mass. The headline
    // carries the fire's confidence, not its arithmetic.
    const strong =
      included[0] !== undefined &&
      (fireBands.get(included[0].namespace) ?? false);

    // Structured like fovea's sync advisories: a compact headline naming
    // the matched sources, flat ▪ bullet rows, a Next: action pointing at
    // the top ref, and a Steer: directive.
    const headerSources = included.map((match) => match.label).join(", ");
    const headerTools = included.reduce((sum, match) => sum + match.names.length, 0);
    const headerLine = strong
      ? `${headerSources} · ${headerTools} tool${headerTools === 1 ? "" : "s"} matched your prompt.`
      : `${headerSources} · ${headerTools} tool${headerTools === 1 ? "" : "s"} might match your prompt.`;
    const blocks: SourceBlock[] = [];
    let shown = 0;
    for (const match of included) {
      const cappedNames: string[] = [];
      const cappedDescriptions: string[] = [];
      for (let index = 0; index < match.names.length; index++) {
        const name = match.names[index];
        if (
          name !== undefined &&
          cappedNames.length < MAX_NAMES_PER_SOURCE &&
          shown < MAX_ADVISORY_NAMES
        ) {
          cappedNames.push(name);
          cappedDescriptions.push(match.descriptions[index] ?? "");
          shown++;
        }
      }
      match.omitted = match.names.length - cappedNames.length;
      const leftoverNames = match.names.slice(cappedNames.length);
      match.names = cappedNames;
      match.descriptions = cappedDescriptions;
      blocks.push({
        namespace: match.namespace,
        label: match.label,
        names: cappedNames,
        descriptions: cappedDescriptions,
        leftoverNames,
      });
    }

    const topName = blocks[0]?.names[0];
    const topRefPrefix =
      blocks[0] === undefined ? ADVISORY_REF_PREFIX : refPrefixFor(blocks[0].namespace);
    const nextLine =
      topName === undefined
        ? ""
        : `Next: tools.describe({ref: "${topRefPrefix}.${topName}"}) for its schema, then ${topRefPrefix}.${topName}({…}) inside fabric_exec.`;

    // Budget squeeze (fovea pattern): walk the ladder until a rung fits —
    // bullets with descriptions → bullets, names only → one bullet per
    // source (dropping Next: alongside the collapse) → header + steer as the
    // floor. Details keep the full (pre-squeeze) picture regardless.
    const rungs: string[][] = [
      [...renderCandidates(blocks, true), ...(nextLine ? [nextLine] : [])],
      [...renderCandidates(blocks, false), ...(nextLine ? [nextLine] : [])],
      renderFlat(blocks),
    ];
    let content = "";
    for (const rung of rungs) {
      const candidate = [headerLine, ...rung, STEER_LINE].join("\n");
      if (estimateTokens(candidate) <= config.budget) {
        content = candidate;
        break;
      }
    }
    if (!content) {
      // Pathological budget: header + steer only, refs survive in details.
      content = `${headerLine}\n${STEER_LINE}`;
    }

    // Echo ledger: every written word we are about to render enters the echo
    // set. Quoting or parroting this advisory next turn cannot score — the
    // sentences we speak must not count as the user's intent. Both surface
    // and lowercase forms are kept, mirroring extraction's casing tolerance.
    for (const token of splitCapabilityWords(content)) {
      this.#emitted.add(token);
      this.#emitted.add(token.toLowerCase());
    }

    for (const match of included) {
      this.#burn(match.namespace, "fired", new Date().toISOString());
      this.#warmth.delete(match.namespace);
    }
    this.#pendingFires.push({
      namespaces: new Set(included.map((match) => match.namespace)),
      turnsLeft: TAU,
      used: false,
    });
    this.#firedTotal += 1;
    return {
      content,
      display: config.mode === "enabled",
      details: { matches: roundScores(included) },
    };
  }
}

const roundScores = (matches: CapabilityAdvisoryMatch[]): CapabilityAdvisoryMatch[] =>
  matches.map((match) => ({ ...match, score: Math.round(match.score * 100) / 100 }));
