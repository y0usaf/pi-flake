# pi-morph

Morph Fast Apply-style edit tool for Pi using Vercel AI Gateway.

This extension adds `morph_edit`, a standalone file-editing tool for large, scattered, or ambiguous edits inside existing files. It does not replace Pi's normal `edit`/`write` tools.

## Authentication

By default, `pi-morph` uses Pi's normal Vercel AI Gateway credential lookup for provider `vercel-ai-gateway`:

```bash
export AI_GATEWAY_API_KEY="vck_..."
pi -e ./extensions/pi-morph
```

Or store the key with Pi's normal `/login` flow for Vercel AI Gateway. Credentials in `~/.pi/agent/auth.json` are resolved by Pi's model registry, the same way normal Pi Vercel Gateway support works.

## Configuration

Add settings to `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "extensionSettings": {
    "morph": {
      "enabled": true,
      "model": "morph/morph-v3-large",
      "baseUrl": "https://ai-gateway.vercel.sh/v1",
      "apiKeyProvider": "vercel-ai-gateway",
      "showStatus": true
    }
  }
}
```

Defaults:

| Setting | Default | Description |
|---|---:|---|
| `enabled` | `true` | Register `morph_edit` |
| `model` | `morph/morph-v3-large` | AI Gateway model id |
| `baseUrl` | `https://ai-gateway.vercel.sh/v1` | OpenAI-compatible base URL |
| `apiKeyProvider` | `vercel-ai-gateway` | Pi provider key lookup name |
| `maxFileBytes` | `2097152` | Max file size sent to the gateway |
| `maxOutputBytes` | `2097152` | Max merged output size written |
| `allowFullReplacement` | `false` | Allow markerless full-file replacement for files over 10 lines |
| `showStatus` | `true` | Show footer status when loaded |

Advanced: `provider` and `providerOptions` objects are passed through to the AI Gateway request when present.

## Tool

### `morph_edit`

Input:

```json
{
  "target_filepath": "src/app.ts",
  "instructions": "I am adding request logging middleware before route registration.",
  "code_edit": "// ... existing code ...\napp.use(requestLogger)\n// ... existing code ..."
}
```

Guidelines:

- use `morph_edit` for large files, scattered edits, repeated structures, or ambiguous merge locations
- use Pi's `edit` for small exact replacements
- use Pi's `write` for new files
- include `// ... existing code ...` at start and end of `code_edit`
- include 1-2 unique context lines around each changed region

Safety checks block writes when Morph returns placeholder markers, unexpectedly truncates the file, or exceeds configured output limits.

## Commands

```text
/morph-status
```

Shows active config and whether a Vercel AI Gateway key is available through Pi's provider auth lookup.
