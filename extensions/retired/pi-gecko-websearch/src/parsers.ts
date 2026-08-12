export interface SearchResult { title: string; url: string; snippet: string }

function decode(s: string): string {
	return s
		.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&#x2F;/g, "/")
		.replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

const clean = (s: string) => decode(s.replace(/<[^>]*>/g, "").trim());

function dedup(r: SearchResult[]): SearchResult[] {
	const seen = new Set<string>();
	return r.filter((x) => !seen.has(x.url) && seen.add(x.url));
}

function firstMatch(html: string, pats: RegExp[]): string {
	for (const p of pats) { const m = html.match(p); if (m) return clean(m[1]); }
	return "";
}

function execAll(re: RegExp, html: string, fn: (m: RegExpExecArray) => void) {
	const r = new RegExp(re.source, re.flags);
	for (let m = r.exec(html); m; m = r.exec(html)) fn(m);
}

interface Engine {
	blockRegex?: RegExp;           // splits html into blocks (block mode)
	mainRegex?: RegExp;            // matches title+url directly (lookahead/generic mode)
	titleUrlPatterns?: RegExp[];   // tried inside each block; group1=url, group2=title
	snippetPatterns: RegExp[];     // group1=snippet; searched in block or lookahead window
	lookaheadChars?: number;       // if set, snippet search uses chars after mainRegex match
	cleanUrl?: (u: string) => string;
	filterUrl?: (u: string) => boolean;
}

const httpFilter = (u: string) => u.startsWith("http");
const googleUrl = (u: string) => { const m = u.match(/[?&]q=([^&]+)/); return m ? decodeURIComponent(m[1]) : u; };

const engines: Record<string, Engine> = {
	google: {
		mainRegex: /<a[^>]+href="([^"]*)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi,
		lookaheadChars: 3000,
		snippetPatterns: [
			/<div[^>]*class="[^"]*VwiC3b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
			/<span[^>]*class="[^"]*st[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
			/<div[^>]*data-sncf="[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
			/<span[^>]*>([\s\S]{30,300}?)<\/span>/i,
		],
		cleanUrl: googleUrl,
		filterUrl: (u) => u.startsWith("http") && !u.includes("google.com/search"),
	},
	duckduckgo: {
		blockRegex: /<div[^>]*class="[^"]*result\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*result\b|$)/gi,
		titleUrlPatterns: [/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i],
		snippetPatterns: [/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i],
		filterUrl: httpFilter,
	},
	brave: {
		mainRegex:
			/<a[^>]+href="(https?:\/\/[^"]*)"[^>]*class="[^"]*\bl1\b[^"]*"[^>]*>[\s\S]*?<div[^>]*class="[^"]*search-snippet-title[^"]*"[^>]*>([\s\S]*?)<\/div>[\s\S]*?<\/a>/gi,
		lookaheadChars: 2500,
		snippetPatterns: [
			/<div[^>]*class="[^"]*generic-snippet[^"]*"[^>]*>[\s\S]*?<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
			/<p[^>]*class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
			/<div[^>]*class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
		],
		filterUrl: httpFilter,
	},
};

function parse(cfg: Engine, html: string): SearchResult[] {
	const results: SearchResult[] = [];

	if (cfg.blockRegex) {
		execAll(cfg.blockRegex, html, (bm) => {
			const block = bm[1];
			let url = "", title = "";
			for (const p of cfg.titleUrlPatterns ?? []) {
				const m = block.match(p);
				if (m) { url = decode(m[1]); title = clean(m[2]); break; }
			}
			if (cfg.cleanUrl) url = cfg.cleanUrl(url);
			if (title && (!cfg.filterUrl || cfg.filterUrl(url))) {
				const snippet = firstMatch(block, cfg.snippetPatterns);
				results.push({ title, url, snippet });
			}
		});
	} else if (cfg.mainRegex) {
		execAll(cfg.mainRegex, html, (m) => {
			let url = decode(m[1]);
			const title = clean(m[2]);
			if (cfg.cleanUrl) url = cfg.cleanUrl(url);
			if (!title || title.length < 3 || (cfg.filterUrl && !cfg.filterUrl(url))) return;
			let snippet = "";
			if (cfg.lookaheadChars) {
				const after = html.substring(m.index + m[0].length, m.index + m[0].length + cfg.lookaheadChars);
				snippet = firstMatch(after, cfg.snippetPatterns).substring(0, 300);
			}
			results.push({ title, url, snippet });
		});
	}

	return dedup(results);
}

export function parseSearchResults(html: string, engine: string): SearchResult[] {
	const config = engines[engine.toLowerCase()];
	if (!config) throw new Error(`Unknown search engine: "${engine}"`);
	return parse(config, html);
}
