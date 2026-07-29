# pi-chrono-break

A model-callable rewind. When a line of work has failed, the model calls
`chrono_break` and the failed turns stop being part of its context — for the
rest of the session, not just for one request.

Lifecycle stage: **testing** (see `extensions/registry.nix`). Opt in with
`programs.pi.extensions.chrono-break = true;`.

## Why this exists

Pi already has `/tree`, `/fork`, and `/clone`, but all three are driven by a
human. Nothing lets the model itself say "that approach was wrong, forget I
tried it". Left alone, an abandoned approach keeps sitting in context, and the
model keeps being drawn back to it. Token cost is the smaller half of the
problem; misdirected attention is the larger half.

## Tool surface

```jsonc
chrono_break({ action: "preview" })
// → turn map, newest first:
//   cb-3f9a  1 turn back      ≈2.1k tok  try the regex approach instead
//   cb-1c22  2 turns back     ≈8.7k tok  ok now wire it into the parser

chrono_break({ action: "rewind", anchor: "cb-1c22", reason: "the regex approach could not handle nested quotes" })

chrono_break({ action: "undo" })   // restore the most recent rewind
```

`turns: N` works as a shorthand for `anchor`, counting 1 as the most recent
user turn. `preview` first is the documented path: models count turns badly and
pick anchors well.

## Manual cut: `/chrono cut`

Opens **pi's own tree view** — the exported `TreeSelectorComponent`, the same
widget `/tree` mounts, not a copy — inside `ctx.ui.custom()`. Pick a point, say
what went wrong, done. Search, folding, labels, and filter modes all work,
because it is the real component.

The difference from `/tree` is only what happens after you press Enter. `/tree`
asks its 3-way summary question and calls a model to write prose. `/chrono cut`
asks one thing — a frozen note you type, or pi's LLM summary — and then commits
a real leaf move through `ctx.navigateTree`.

Three things are matched to `/tree` on purpose, because any drift makes this
feel like a different program:

- **Placement.** `ctx.ui.custom()` is called with no `overlay` option, so the
  component swaps into the editor container the way pi's own `showSelector`
  does. Passing `overlay: true` is what made it float mid-screen.
- **Escape.** Escape in the note editor returns to the choice menu; escape at
  the choice menu re-opens the tree with the same row selected. This mirrors
  the loop in pi's `showTreeSelector`, where cancelling the summary prompt
  calls `showTreeSelector(entryId)` rather than aborting.
- **Filter mode.** `treeFilterMode` is read from project then global
  `settings.json`, so the tree opens on the same rows `/tree` would show.
  Project settings are honoured only when `ctx.isProjectTrusted()`.

This is a **genuinely different mechanism from the tool's**, and the split is
forced, not chosen:

- `navigateTree` lives on `ExtensionCommandContext`, not on the base context a
  tool's `execute` receives. pi's own comment: *"session control methods only
  safe in user-initiated commands"*.
- `agent-session.ts` throws `"Wait for the current response to finish before
  navigating the session tree."` whenever `isStreaming` is true — which is
  precisely when a tool runs.

So the model can never take this route from inside a tool call, and the context
filter is not redundant with it. A manual cut records a `chrono-break-manual`
ledger entry, never a `CutMarker`: those turns are already off the active
branch, and filtering them a second time would misapply the timestamp window to
the new branch.

`session_before_tree` supplies the frozen note, but **only for navigation this
extension started**, matched by target id. Tree navigation you start by hand is
untouched and keeps pi's normal branch summary.

Other `/chrono` subcommands: `list` shows active rewinds, `undo` restores the
last one, `clear` restores all of them. `cut` is TUI-only.

## How it works

The tool cannot delete anything by itself. A tool in pi may only *append* its
result to the transcript, and `ctx.sessionManager` is a read-only projection —
`ReadonlySessionManager` in `src/core/session-manager.ts` is a `Pick<>` that
deliberately omits `branch()`, the leaf-move primitive `/tree` uses. So the
work is split:

- **The tool** records a `CutMarker` (cut timestamp, closing timestamp, frozen
  breadcrumb text) and persists it with `pi.appendEntry`.
- **The `context` hook** runs before every LLM call, receives the outgoing
  `AgentMessage[]`, and returns that array minus every message covered by a
  marker, with the breadcrumb spliced in at the cut point.

Nothing is deleted from disk. The session JSONL keeps the full transcript, so
`/tree` and `/export` still show the path that was abandoned. The rewind is a
view, and `session_start` replays the markers from the session's own entries so
`pi -c` and `/resume` stay rewound.

## Two invariants worth knowing

**Cuts land on user messages only.** Anthropic rejects any request where a
`tool_use` block has no `tool_result` immediately after it. Cutting at an
arbitrary message could split that pair. A cut at a user message cannot, and
`filter.ts` additionally drops results whose caller was removed — including the
`chrono_break` result itself, which is written a moment *after* the cut window
closes.

**The breadcrumb is frozen at creation.** It is stored as a string on the
marker and replayed byte-for-byte. Provider prompt caches are prefix-keyed: a
breadcrumb that recomputed anything at render time — a clock, an elapsed
duration, a live counter — would shift the cached prefix and force a full
uncached re-read of the conversation on every subsequent request.
`tests/state.test.ts` pins this.

## Cache behaviour

Rewinding is prefix-preserving, so it is cache-neutral on the turn it happens
and cheaper on every turn after:

- Messages before the cut are byte-identical, and that exact prefix was already
  written as a cache breakpoint at the turn it was current, so the first
  post-rewind request should hit it. (Whether Anthropic refreshes the TTL of a
  *shorter* prefix when a longer one is read is not documented; worst case is
  one cold read.)
- Everything after the cut is new content and is written once, as usual.
- Every later turn re-reads a shorter prefix than it would have.

The pattern that *would* wreck the cache is deleting messages from the middle
while keeping later ones. This extension never does that: a cut always extends
to the end of the transcript as it stood when the tool ran.

## Development

```bash
nix flake check ./extensions/pi-chrono-break   # runs bun test ./tests
```

Pure modules (`turns.ts`, `filter.ts`, `state.ts`) import nothing from
`@earendil-works/*`, so the tests run in the Nix sandbox without node_modules.
