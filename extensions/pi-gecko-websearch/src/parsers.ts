export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

/**
 * Dispatch to the appropriate parser based on search engine.
 */
export function parseSearchResults(html: string, engine: string): SearchResult[] {
	switch (engine.toLowerCase()) {
		case "google":
			return parseGoogle(html);
		case "duckduckgo":
			return parseDuckDuckGo(html);
		case "brave":
			return parseBrave(html);
		default:
			return parseGeneric(html);
	}
}

/**
 * Decode HTML entities in a string.
 */
function decodeEntities(str: string): string {
	return str
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&#x2F;/g, "/")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

/**
 * Strip all HTML tags from a string.
 */
function stripTags(str: string): string {
	return str.replace(/<[^>]*>/g, "").trim();
}

/**
 * Extract a clean URL from a Google redirect link or raw href.
 */
function cleanGoogleUrl(rawUrl: string): string {
	// Google wraps URLs: /url?q=https://example.com&sa=...
	const match = rawUrl.match(/[?&]q=([^&]+)/);
	if (match) {
		return decodeURIComponent(match[1]);
	}
	return rawUrl;
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

function parseGoogle(html: string): SearchResult[] {
	const results: SearchResult[] = [];

	// Strategy 1: Look for <a href="..."><h3>...</h3></a> patterns
	// Google's organic results typically have an <a> wrapping an <h3>.
	const linkH3Regex = /<a[^>]+href="([^"]*)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi;
	let match: RegExpExecArray | null = linkH3Regex.exec(html);

	while (match !== null) {
		const rawUrl = decodeEntities(match[1]);
		const url = cleanGoogleUrl(rawUrl);
		const title = decodeEntities(stripTags(match[2]));

		if (url.startsWith("http") && !url.includes("google.com/search")) {
			// Try to grab a snippet: look for text in a nearby <span> or <div> after the </h3>
			// We'll search in the next ~2000 chars after this match for snippet-like content.
			const afterMatch = html.substring(match.index + match[0].length, match.index + match[0].length + 3000);

			let snippet = "";

			// Look for <span> blocks that contain the snippet text
			// Google often uses <div class="VwiC3b ..."><span>...</span></div> or similar
			const spanPatterns = [
				/<div[^>]*class="[^"]*VwiC3b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
				/<span[^>]*class="[^"]*st[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
				/<div[^>]*data-sncf="[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
			];

			for (const pattern of spanPatterns) {
				const snippetMatch = afterMatch.match(pattern);
				if (snippetMatch) {
					snippet = decodeEntities(stripTags(snippetMatch[1])).substring(0, 300);
					break;
				}
			}

			// Fallback: grab text from the first substantial <span> after </h3>
			if (!snippet) {
				const spanMatch = afterMatch.match(/<span[^>]*>([\s\S]{30,300}?)<\/span>/i);
				if (spanMatch) {
					snippet = decodeEntities(stripTags(spanMatch[1])).substring(0, 300);
				}
			}

			if (title) {
				results.push({ title, url, snippet });
			}
		}

		match = linkH3Regex.exec(html);
	}

	// Deduplicate by URL
	return dedup(results);
}

// ---------------------------------------------------------------------------
// DuckDuckGo (HTML-only version)
// ---------------------------------------------------------------------------

function parseDuckDuckGo(html: string): SearchResult[] {
	const results: SearchResult[] = [];

	// The HTML-only DDG version uses <div class="result ..."> blocks.
	// Each contains:
	//   <a class="result__a" href="...">title</a>
	//   <a class="result__snippet" href="...">snippet text</a>

	const resultBlockRegex =
		/<div[^>]*class="[^"]*result\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*result\b|$)/gi;
	let blockMatch: RegExpExecArray | null = resultBlockRegex.exec(html);

	while (blockMatch !== null) {
		const block = blockMatch[1];

		// Extract title and URL
		const titleMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
		if (titleMatch) {
			const url = decodeEntities(titleMatch[1]);
			const title = decodeEntities(stripTags(titleMatch[2]));

			// Extract snippet
			let snippet = "";
			const snippetMatch = block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
			if (snippetMatch) {
				snippet = decodeEntities(stripTags(snippetMatch[1]));
			}

			if (title && url.startsWith("http")) {
				results.push({ title, url, snippet });
			}
		}

		blockMatch = resultBlockRegex.exec(html);
	}

	// Fallback: simpler link-based extraction if the block approach got nothing
	if (results.length === 0) {
		const linkRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
		let linkMatch: RegExpExecArray | null = linkRegex.exec(html);
		while (linkMatch !== null) {
			const url = decodeEntities(linkMatch[1]);
			const title = decodeEntities(stripTags(linkMatch[2]));
			if (title && url.startsWith("http")) {
				results.push({ title, url, snippet: "" });
			}
			linkMatch = linkRegex.exec(html);
		}
	}

	return dedup(results);
}

// ---------------------------------------------------------------------------
// Brave Search
// ---------------------------------------------------------------------------

function parseBrave(html: string): SearchResult[] {
	const results: SearchResult[] = [];

	// Brave search results are in <div class="snippet ..."> blocks
	// containing <a class="result-header" href="..."><span class="snippet-title">...</span></a>
	// and <p class="snippet-description">...</p>

	const snippetBlockRegex =
		/<div[^>]*class="[^"]*snippet\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*snippet\b|<footer|$)/gi;
	let blockMatch: RegExpExecArray | null = snippetBlockRegex.exec(html);

	while (blockMatch !== null) {
		const block = blockMatch[1];

		// Title and URL
		const headerMatch = block.match(
			/<a[^>]*class="[^"]*result-header[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i,
		);
		if (!headerMatch) {
			// Alternate: any <a> with an href containing http
			const altMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
			if (altMatch) {
				const url = decodeEntities(altMatch[1]);
				const title = decodeEntities(stripTags(altMatch[2]));

				let snippet = "";
				const descMatch = block.match(/<p[^>]*class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
				if (descMatch) snippet = decodeEntities(stripTags(descMatch[1]));

				if (title && url.startsWith("http")) {
					results.push({ title, url, snippet });
				}
			}

			blockMatch = snippetBlockRegex.exec(html);
			continue;
		}

		const url = decodeEntities(headerMatch[1]);
		const title = decodeEntities(stripTags(headerMatch[2]));

		// Snippet
		let snippet = "";
		const descMatch = block.match(/<p[^>]*class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
		if (descMatch) {
			snippet = decodeEntities(stripTags(descMatch[1]));
		}
		// Fallback: description div
		if (!snippet) {
			const descDiv = block.match(/<div[^>]*class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
			if (descDiv) snippet = decodeEntities(stripTags(descDiv[1]));
		}

		if (title && url.startsWith("http")) {
			results.push({ title, url, snippet });
		}

		blockMatch = snippetBlockRegex.exec(html);
	}

	// Fallback to generic if nothing found
	if (results.length === 0) {
		return parseGeneric(html);
	}

	return dedup(results);
}

// ---------------------------------------------------------------------------
// Generic fallback
// ---------------------------------------------------------------------------

function parseGeneric(html: string): SearchResult[] {
	const results: SearchResult[] = [];
	const linkRegex = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	let match: RegExpExecArray | null = linkRegex.exec(html);

	while (match !== null) {
		const url = decodeEntities(match[1]);
		const title = decodeEntities(stripTags(match[2]));

		if (title && title.length >= 3 && !url.includes("google.com") && !url.includes("duckduckgo.com")) {
			const contextStart = Math.max(0, match.index - 200);
			const contextEnd = Math.min(html.length, match.index + match[0].length + 500);
			const context = html.substring(contextStart, contextEnd);
			const snippet = decodeEntities(stripTags(context)).substring(0, 200).trim();

			results.push({ title, url, snippet });
		}

		match = linkRegex.exec(html);
	}

	return dedup(results).slice(0, 20);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dedup(results: SearchResult[]): SearchResult[] {
	const seen = new Set<string>();
	return results.filter((r) => {
		if (seen.has(r.url)) return false;
		seen.add(r.url);
		return true;
	});
}
