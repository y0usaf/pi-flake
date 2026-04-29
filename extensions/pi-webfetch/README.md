# pi-webfetch

A pi coding agent extension that fetches URLs and returns their content as clean markdown.

## What it does

- Fetches any URL via HTTP GET
- Converts HTML to markdown (via Turndown)
- Returns raw text for non-HTML content
- 15-minute LRU cache (50 entries max)
- Auto-upgrades `http://` → `https://`
- Follows same-host redirects only (up to 5 hops)
- Truncates large output to stay within context limits

No secondary model summarization — the raw markdown goes straight to the main model so it can interpret the content with full conversation context.

## Usage

```bash
# Install as a pi package
pi install ~/Dev/pi-webfetch

# Or load directly
pi -e ~/Dev/pi-webfetch/src/index.ts
```

The LLM gets a `web_fetch` tool with parameters:
- `url` — Full URL to fetch
- `prompt` — Optional hint about what to look for (prepended to output)

## Dependencies

- `turndown` — HTML to markdown conversion
