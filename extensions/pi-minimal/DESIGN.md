# pi-minimal — design

**One sentence:** two halves that cannot substitute for each other — an
extension that only removes rows from pi's tool blocks, and a theme that only
quiets pi's colours.

That split is forced by pi, not chosen. A pi theme is 51 colour tokens and has
**no** control over spacing, padding, or line counts. An extension can reshape
rendered lines but has no business inventing colours. So "make it a theme" and
"make it an extension" are not alternatives; each reaches exactly what the other
cannot.

## The rule

The extension may **delete rendered rows** and may **emit blank rows**. It may
never emit a character.

Blank rows were added to the rule deliberately (see Locked decisions). Whitespace
has no content, so it cannot drift out of sync with pi the way a copied glyph,
label, or summary can.

### Why the rule exists

The previous version was 1013 lines and replaced `ToolExecutionComponent.render`,
`UserMessageComponent.render`, and `AssistantMessageComponent.render` with
substitutes. Three consequences, all bugs:

1. It carried a 13-entry table mapping tool name to argument summary. pi already
   ships `renderCall`/`renderResult` per tool, so the table was a stale copy and
   every new pi tool fell through to a generic formatter.
2. Replacing `render` outright discarded any *other* extension's `renderCall`. A
   third-party tool could not style its own row.
3. It painted user messages with a hardcoded `\x1b[93m`, which ignores the theme.

A substitutive extension must know everything the thing it replaced knew. A
subtractive one needs to know almost nothing.

## What the extension does

| Behaviour | Effect |
|---|---|
| layout invariant | every tool block renders as exactly one blank row plus its body |
| `DUMP_TOOLS` | `grep`, `ls`, `find`, `bash` show no result while collapsed |

A collapsed `grep` goes from roughly 19 rows to 2. Three stacked tool calls go
from about 14 rows to 8, and keep exactly one blank row between them.

`edit` and `write` are deliberately **not** in `DUMP_TOOLS`: their collapsed
previews are a diff and highlighted file content, which are the things worth
reading without expanding. `read` is absent because core already returns an empty
collapsed result for it (`core/tools/read.ts:173`).

### Why `leadingRun` is safe

Every built-in tool builds its result string starting with a newline —
`grep.ts:104`, `ls.ts:78`, `find.ts:92`, `bash.ts:265` all begin `text += "\n…"`.
So a rendered tool block is always `call lines`, one blank, `result lines`.
Cutting at the first blank keeps the entire call however many lines it grows to,
and drops the entire result. Nothing is parsed and no `... N more lines` count is
recomputed, which is what makes this different from slicing to a fixed height.

**Ordering matters and is the reason `toolRows` is one function rather than a
pipeline of filters.** `leadingRun` cuts at the first blank row, so pi's padding
rows must be trimmed *before* it runs. Run in the other order it cuts at row zero
and deletes the whole block. This was caught by test, not by review.

## What the theme does

`themes/quiet.json`. Three moves:

1. **Tool slabs removed.** `toolPendingBg`, `toolSuccessBg`, `toolErrorBg` are
   `""` (terminal default), so tool rows stop being coloured blocks and become
   plain text. `userMessageBg` is kept — it is the transcript separator.
2. **Palette collapsed** to three neutral tones (`ink`, `mid`, `low`) plus one
   accent. The nine syntax tokens and ten markdown tokens all resolve into that
   set, so colour carries meaning when it appears instead of being decoration.
3. **The thinking ramp is the one loud thing.** `thinkingOff` (`#2e2e2e`) is
   nearly invisible against a dark terminal and the ramp climbs to `thinkingMax`
   (`#e08ad0`). pi paints the editor's border from this
   (`interactive-mode.ts:3769-3774`), so the input frame is silent at rest and
   shouts only when thinking is cranked. `bashMode` stays green so bash mode is
   never confused with a thinking level.

## What core already ablates, with no code at all

Settings in `~/.pi/agent/settings.json`. pi-minimal deliberately does **not**
write them — editing a user's config as a side effect is the opposite of this
design.

| Setting | Removes |
|---|---|
| `"quietStartup": true` | the startup header block |
| `"hideThinkingBlock": true` | thinking bodies, leaving one italic line per run |
| `"outputPad": 0` | horizontal padding on user, assistant, and thinking messages |

## Conformance

| Rule | Status | Notes |
|---|---|---|
| `[[canon:least-code]]` | follows | 1013 lines to 128, one source file plus one theme file. Smaller thing rejected: theme only, no extension — rejected because a theme cannot delete a blank row, so the density problem is unreachable from it. |
| `[[canon:least-power]]` | follows | `DUMP_TOOLS` is a set (rung 2) and the theme is a config file (rung 3). The layout invariant is one pure function (rung 4): lines in, lines out, no I/O. Only `filterToolRows` is rung 5. |
| `[[canon:no-privileged-path]]` | n/a | pi-minimal *is* an extension and has no plugin surface of its own. Reversed if a second extension needs to contribute tools to `DUMP_TOOLS`, at which point it becomes a registry. |
| `[[canon:functional-core]]` | diverges | See "Prototype patch exemption". |
| `[[canon:daemon-thin-client]]` | n/a | No state outlives the TUI. One array of undo closures, nothing else. |
| `[[canon:unix]]` | follows, two rows n/a | See "Unix rows". |

### Prototype patch exemption

`filterToolRows` assigns to `ToolExecutionComponent.prototype.render`.

- **What it skips:** the extension boundary. pi exposes no API for tool-row
  chrome. `outputPad` covers user, assistant, and thinking messages only; tool
  rows get a hardcoded `Spacer(1)` in the `ToolExecutionComponent` constructor
  and a `Box(1, 1, bgFn)` whose `paddingY` has no setter.
- **What it may touch:** it calls the original, reads exactly two fields
  (`toolName`, `expanded`), and returns a shortened array. It writes no component
  state. `expanded` falls back to the public `ctx.ui.getToolsExpanded()` if that
  field is ever renamed, so a rename degrades to globally-correct rather than
  silently always-hiding.
- **Rejected alternative:** overriding the built-in tools' `renderResult` via
  `pi.registerTool` is public API and was the obvious move. It is a trap.
  `docs/extensions.md:2046` states `promptSnippet` and `promptGuidelines` are
  **not** inherited by an override, so it would silently change what the model is
  told about `grep`, `ls`, `find`, and `bash`. That converts a display change
  into a behaviour change and breaks this extension's display-only scope.
- **What ends it:** pi gaining a settings key for tool-row padding, or any public
  API reporting tool-row chrome. Either deletes `filterToolRows` and changes this
  row to n/a.

### Unix rows

| Rule | Status |
|---|---|
| Keep decisions out of machinery | follows — `DUMP_TOOLS` and `quiet.json` hold the decisions; `trimEdges`, `leadingRun`, `filterToolRows` hold the how. |
| Small parts, narrow interfaces | follows — one default export, no other public surface. |
| Be usable by other programs | n/a — the extension emits no output. Nothing to make machine-readable. |
| Make state observable without a debugger | follows — the only state is the undo array, derived one-to-one from the single patch. |
| Fail loudly on the first bad input | follows — if `ToolExecutionComponent.render` is missing, it throws and the failure is reported through `ctx.ui.notify(..., "error")`. |
| Say nothing when nothing went wrong | follows — no startup notification, no status line, no command. |
| Generate what you'd hand-maintain | n/a — nothing is generated. |
| Work, then measure, then optimize | follows — no optimization landed. `trimEdges` returns its input unchanged when nothing trims, which is the simple implementation rather than a measured one. |

## Locked decisions

**No commands, no settings, no runtime toggles.** The previous version spent 216
lines on a four-feature by five-state command grammar plus a bespoke
`settings.json` reader, for preferences you set once. Reversed only if a
behaviour turns out to need flipping mid-session.

**Blank rows are allowed; characters are not.** Originally the rule was pure
removal. It was relaxed once, deliberately, because normalising the gap between
stacked tool calls requires emitting a blank row. The boundary is checkable:
`rg '"[^"]' src/index.ts` should find no string literal containing a visible
character that reaches the output. Widening this again to permit drawn characters
is how the 1013-line version happened — it did not begin by deciding to
reimplement every tool renderer, it began with one small justified drawing.

**The editor frame is not ablated.** An earlier iteration removed both horizontal
rules around the input. That was wrong twice over: the rules are the only
separation between input and transcript, and pi paints them from the
thinking-level colour, so removing them deletes a live signal. The frame is now a
theme concern instead — quiet at rest, loud at high thinking.

**pi-minimal never writes to `settings.json`.** The three core ablations are
documented and left for the user to apply.

**Colour and spacing never mix.** The extension has no colour constants; the
theme has no layout. If a change needs both, it is two changes.

## Architecture map

| Unit | Kind | Contents |
|---|---|---|
| `src/index.ts` predicates | machinery | `ANSI`, `bare`, `isBlank`, `trimEdges`, `leadingRun` |
| `src/index.ts` layout | **decision-making** | `DUMP_TOOLS`, `toolRows` |
| `src/index.ts` mechanism | machinery | `readRow`, `filterToolRows` |
| `src/index.ts` extension | machinery | `session_start` installs, `session_shutdown` reverts |
| `themes/quiet.json` | **decision-making** | all 52 colour tokens |

## Deferred

**Repeated expand hints.** Every collapsed tool that truncates appends
`... (12 more lines, ctrl+o to expand)`. Hiding dump-tool results removes most of
these as a side effect; the rest sit on `edit` and `write`, whose previews are
being kept on purpose. Revisit if they still read as noise.

**Footer removal.** `ctx.ui.setFooter(factory)` accepts a component rendering
zero lines. Deferred because the footer carries live state — model, context
percentage, token counts, cost, branch, thinking level — not chrome. Note that
the footer is also where thinking level is stated in words, which is what makes
the editor border safe to treat as decoration.

**Working-indicator removal.** `ctx.ui.setWorkingVisible(false)` deletes the
streaming loader row, which also carries the `esc to interrupt` hint.

**A light variant of `quiet`.** The current theme assumes a dark terminal;
`thinkingOff` at `#2e2e2e` is invisible on dark and would be a harsh dark line on
light.

## Known limits

**Truncation warnings are hidden with the result.** `grep`, `ls`, and `find`
append `[Truncated: 200 matches limit]` inside the result block, so a collapsed
dump tool no longer shows it. `ctrl+o` reveals it. This is the same trade core
already makes for `read`, but it is a real loss: a truncated search now looks
identical to a complete one until expanded.

**A tool whose result does not start with a newline would be kept, not hidden.**
`leadingRun` relies on that blank separator. The failure mode is safe — the
result stays visible rather than the call disappearing.

## Roadmap

| Phase | Criterion |
|---|---|
| 1 — land the rewrite | `nix flake check` exits zero; a collapsed `grep` occupies 2 rows and three stacked tool calls have exactly one blank row between each. |
| 2 — live the theme | Run a week on `quiet`. Criterion: you can name what each remaining colour means without looking it up. If not, the palette is still too wide. |
| 3 — confirm the boundary holds | Load an extension registering a tool with its own `renderCall`; confirm its row renders in its own style, unlike under the old version. |
| 4 — upstream the padding gap | File an issue for a `settings.json` key covering tool-row padding. When it lands, delete `filterToolRows` and change `[[canon:functional-core]]` above from diverges to n/a. |
