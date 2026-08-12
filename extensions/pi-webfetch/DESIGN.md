## Locked decisions
- No secondary-model summarization: raw markdown goes directly to the main model, preserving full conversation context. (2026-07-30)
- Public `http://` URLs are tried as `https://` first; localhost and private hosts remain on HTTP, and an HTTPS failure falls back to the original HTTP URL. Reverse this only if public HTTP compatibility or the private/local host exemption is shown to require a different policy. (2026-07-30)
- Use the custom `renderCollapsibleText` renderer because pi's fallback renderer floods collapsed rows with all content. (2026-07-30)
- Remove the fetch cache: it had no benchmark evidence under the work-then-measure rule and exposed no observable state. Reintroduce a cache only after measurement shows repeat fetches impose a meaningful cost. (2026-07-30)

## Architecture
- `src/index.ts` is the extension boundary module: it registers `web_fetch`, validates URLs, applies the HTTP-to-HTTPS policy, fetches and converts content, and builds tool results.
- Decision-making lives in URL validation, `isLocalOrPrivateHost`, HTTPS upgrade/fallback, and the result/rendering policy. Fetching, Turndown conversion, truncation, and TUI rendering are machinery.
- `renderCollapsibleText` is the custom output-rendering machinery at the pi result boundary; it preserves collapsed-row usability where the fallback renderer does not.
- With the cache gone, the extension holds no live fetch-result state at all; this is intentional. The cache-related canon rules are therefore n/a. Reverse that choice only when repeat-fetch measurement demonstrates a meaningful cost and the state can have an inspectable lifecycle.

## Deferred
None.

## Roadmap
- Phase 1 — Fetch policy: check that public HTTP upgrades to HTTPS, local/private HTTP does not, and failed HTTPS retries the original URL.
- Phase 2 — Content handling: check that HTML becomes markdown, other content remains raw, and output truncation is bounded.
- Phase 3 — UI and maintenance: check collapsed output uses the custom renderer; measure repeat-fetch cost before considering any stateful optimization.
