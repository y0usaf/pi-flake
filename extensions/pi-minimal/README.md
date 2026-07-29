# pi-minimal

Two halves that reach different things:

- **an extension** that removes rows from pi's tool blocks, and never emits a character
- **a theme** (`quiet`) that removes colour weight, and never touches spacing

pi forces this split. A theme is 51 colour tokens with no control over spacing;
an extension can reshape lines but has no business inventing colours. Neither can
do the other's job.

## The extension

| Behaviour | Effect |
|---|---|
| layout invariant | every tool block is exactly one blank row plus its body |
| collapsed dumps | `grep`, `ls`, `find`, `bash` show no result while collapsed |

A collapsed `grep` before — about 19 rows:

```text
                                  ← Spacer
                                  ← Box padding, background painted
 grep /TODO/ @ .                  ← call
                                  ← result begins
 src/a.ts:3: TODO
 …fifteen lines…
 ... (25 more lines, ctrl+o to expand)
                                  ← Box padding
```

After — 2 rows:

```text

 grep /TODO/ @ .
```

`ctrl+o` shows everything, unchanged. `edit` and `write` keep their collapsed
previews, because a diff and highlighted file content are worth reading without
expanding. `read` is untouched — core already hides its collapsed result.

Stacked tool calls keep exactly one blank row between them.

There is no command and no configuration. To stop hiding a tool's result, remove
its name from `DUMP_TOOLS` in `src/index.ts`.

## The theme

Select it with `/settings`, or in `settings.json`:

```json
{ "theme": "quiet" }
```

Three moves:

1. **Tool background slabs removed.** `toolPendingBg`, `toolSuccessBg`, and
   `toolErrorBg` fall back to your terminal background, so tool rows become plain
   text. The user-message background stays — it is what separates your turns from
   the transcript.
2. **Palette collapsed** to three neutral tones plus one accent. All nine syntax
   colours and all ten markdown colours resolve into that set.
3. **The thinking ramp is the one loud thing.** pi paints the editor's border
   from the current thinking level. `quiet` makes `off` and `minimal` nearly
   invisible and ramps up to a bright magenta at `max`, so the input frame is
   silent at rest and shouts only when thinking is cranked. Bash mode stays green
   so it is never mistaken for a thinking level.

## Also worth setting

These are pi's own settings and this package deliberately does not write them for
you. In `~/.pi/agent/settings.json`:

```json
{
  "quietStartup": true,
  "hideThinkingBlock": true,
  "outputPad": 0
}
```

| Setting | Removes |
|---|---|
| `quietStartup` | the startup header block |
| `hideThinkingBlock` | thinking bodies, leaving one italic line per run |
| `outputPad` | horizontal padding on user, assistant, and thinking messages |

`ctrl+t` toggles thinking visibility live. `ctrl+o` toggles tool expansion.

## Watch out

Collapsed `grep`, `ls`, and `find` also hide their `[Truncated: 200 matches
limit]` warning, since it lives inside the result block. A truncated search looks
identical to a complete one until you press `ctrl+o`.

## Usage

```bash
pi -e ./extensions/pi-minimal/src/index.ts
```

Or install as a pi package, which registers the extension and the theme together.

## Design

[DESIGN.md](DESIGN.md) has the reasoning, the conformance table, the one
documented divergence with the condition that ends it, and the rejected
alternatives — including why overriding built-in tools' renderers is a trap.
