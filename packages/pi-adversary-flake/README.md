# pi-adversary-flake

Always-on read-only reviewer extension for pi.

It runs a separate reviewer agent over the current session branch, gives that reviewer read-only repo tools (`read`, `grep`, `find`, `ls`) plus internal adversary decision tools, and when it sees a material problem it retries from the best checkpoint in the same session tree with new user input: usually a corrective interjection from the latest safe tool-result checkpoint, or a rewritten original user prompt if the issue starts there.

## What it does

- Reviews every assistant turn while enabled
- Uses a separate reviewer model (or the current model by default)
- Lets the reviewer inspect the repo with read-only tools and finish with a structured approve/retry decision
- Automatically branches within the current session instead of opening a new session
- Runs one synchronous review pass at the end of every assistant turn
- Retries from the latest safe checkpoint in the current session tree with new user input
- Can interject from a tool-result checkpoint to change what happens next
- Rewrites the originating user prompt only when that text actually needs to change

## What it does not do yet

- No automatic workspace/file rollback
- No tool-result checkpoint insertion
- No direct write/edit/bash access for the reviewer
- No direct session-tree controls exposed to the reviewer model

This is an opinionated actor/critic layer: detect material problems, branch to the best checkpoint, and inject corrective user input.

## Configuration

Add this to either:

- `~/.pi/agent/extension-settings.json`
- `.pi/extension-settings.json`

Project settings override global settings.

Simple form:

```json
{
  "adversary": true
}
```

Advanced form:

```json
{
  "adversary": {
    "enabled": true,
    "reviewerModel": "openai/gpt-5-mini",
    "reviewerThinkingLevel": "low",
    "minConfidence": "medium",
    "maxReviewRounds": 1,
    "showStatus": true,
    "maxRecentEntries": 10,
    "maxContextChars": 1200,
    "maxToolChars": 2000
  }
}
```

### Settings

- `enabled`: master on/off switch, default `false`
- `reviewerModel`: reviewer model as `provider/model`; default = current model
- `reviewerThinkingLevel`: `off|minimal|low|medium|high|xhigh`; default `low`
- `minConfidence`: minimum confidence required before an automatic rewrite/rerun is triggered; default `medium`
- `maxReviewRounds`: max automatic rewrite rounds chained from one manually submitted prompt; default `1`
- `showStatus`: show footer status while enabled; default `true`
- `maxRecentEntries`: recent branch entries included in reviewer context; default `10`
- `maxContextChars`: max chars per recent entry snippet; default `1200`
- `maxToolChars`: max chars for tool/result snippets; default `2000`

## Usage

```bash
# Load directly from this repo
pi -e ./packages/pi-adversary-flake/src/index.ts

# Or load as a package path
pi -e ./packages/pi-adversary-flake
```

The extension also adds a `/adversary` command:

- `/adversary` or `/adversary status` → show effective config/status, active review state, and last review result
- `/adversary on` → enable for the current session only
- `/adversary off` → disable for the current session only

## Behavior notes

- The extension replaces the built-in footer while enabled so adversary status appears right-aligned on the top footer line, above the actor model line, instead of as a separate status row.
- The top-right shows the reviewer model/provider + thinking level, with a braille spinner while the reviewer is actively running.
- The reviewer runs synchronously at `turn_end`, so every completed assistant turn is reviewed before the session continues.
- When it decides to retry, it branches to the latest completed tool-result checkpoint or original user prompt and always sends new user input from there.
- For tool-result checkpoints, that user input acts as an interjection between tool phases; for the original prompt checkpoint, it acts as a full rewritten prompt.
- Original branches stay in the same session tree, so bad retries are reversible via `/tree`.
- Automatic retry loops are bounded by `maxReviewRounds` per manually submitted prompt.

## Nix

Build the package:

```bash
nix build .#
```

Then load it directly in pi:

```bash
pi -e "$(nix build .# --print-out-paths)"
```
