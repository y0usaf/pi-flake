# pi-codex-fast-flake

A pi coding agent extension that enables Codex fast mode from `extension-settings.json`.

## What it does

When enabled, this extension patches outgoing provider payloads for `openai-codex` and sets:

```json
{
  "service_tier": "priority"
}
```

That matches how upstream Codex currently routes its fast mode.

By default, the extension only enables fast mode for `gpt-5.4`, since that is the model currently advertising fast support in the upstream Codex model catalog.

## Configuration

Add this to either:

- `~/.pi/agent/extension-settings.json`
- `.pi/extension-settings.json`

Project settings override global settings.

Simple form:

```json
{
  "codex-fast": true
}
```

Advanced form:

```json
{
  "codex-fast": {
    "enabled": true,
    "supportedModels": ["gpt-5.4"],
    "showStatus": true
  }
}
```

## Usage

```bash
# Load directly from this repo
pi -e ./packages/pi-codex-fast-flake/src/index.ts

# Or install/load as a pi package path
pi -e ./packages/pi-codex-fast-flake
```

The extension also adds a `/codex-fast` command that shows whether fast mode is currently active for the selected model.

## Nix

Build the package:

```bash
nix build .#
```

Then load it directly in pi:

```bash
pi -e "$(nix build .# --print-out-paths)"
```
