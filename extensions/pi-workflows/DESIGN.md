# pi-workflow-transcript — design

Renders `pi-extensible-workflows` runs into the Pi transcript, so a workflow
is readable from the conversation itself instead of a modal navigator.

Consumes the `workflow:*` event stream published on Pi's shared `EventBus`.
Writes nothing back. The engine does not know this extension exists.

## Locked decisions

**2026-07-29 — Separate extension, never a patch to the vendored engine.**
`@extensions/vekexasia_pi-extensible-workflows/` is a vendored third-party
reference tree and stays byte-identical to upstream 3.4.2, so it remains a
clean diff base for taking upstream fixes. Everything this extension needs
is public: `pi.events`, `pi.appendEntry`, `pi.registerEntryRenderer`,
`ctx.ui.setWidget`. An earlier draft added 440 lines and a two-line hook
inside that tree; it was reverted. `[[canon:no-privileged-path]]`.

**2026-07-29 — Event names and payload shapes are declared locally, not imported.**
The engine publishes them and also exports them from its `./types` entry, so
importing was possible. Declared locally instead: the runtime coupling is ten
string literals, and depending on the engine package to obtain them would add
npm resolution, a lockfile and a version pin for strings. Declaring what we
consume also keeps the arrow pointing the right way — a consumer describing a
wire format it reads, not borrowing the producer's internal types. Cost: a
renamed event or changed payload field is caught at runtime, not compile time,
which `WORKFLOW_EVENT_NAMES` and the shape guards in `index.ts` exist to make
loud rather than silent. `[[canon:least-code]]`, `[[canon:daemon-thin-client]]`.

**2026-07-29 — Two render surfaces, split by what Pi's primitives can do.**
Finished phases become custom session entries (`pi.appendEntry`): durable,
scrollable, survive `/resume`, invisible to the LLM. The single in-flight phase
is a widget (`ctx.ui.setWidget`): animates, ephemeral. This is not a preference.
`EntryRenderer` is `(entry, { expanded }, theme) => Component` with no
`invalidate()`, and `pi.appendEntry` returns `void`, so an entry can neither
animate nor be updated after it is written.

**2026-07-29 — Group by `phaseHistory`, not `structuralPath`.**
Measured across every run in `~/.pi/workflows/projects`: `phaseHistory` is
populated in all of them, `structuralPath` in one. Phases are also hard
barriers, because the engine's `phaseBridge` calls `scheduler.flush()` before
recording one, so no agent can straddle a phase boundary and grouping is never
ambiguous. `structuralPath` still drives extra indentation where it is present.

**2026-07-29 — One entry per phase, not per agent.**
A 28-agent run writes six entries. Per-agent entries would be a wall of rows and
a much larger session file, for the same information.

## Architecture

Single module, `src/index.ts`.

| Section | Kind | Responsibility |
|---|---|---|
| event names, payload types | decision | the wire contract this extension reads |
| `agentGlyph`, `formatDuration`, `agentLine`, `indent` | machinery | pure formatting, no I/O |
| `linesBlock` | machinery | structural `Component`; `pi-tui` is not a dependency |
| `PhaseAccumulator`, `RunTracker` | machinery | in-memory state for live runs |
| `registerWorkflowTranscript` | decision | subscriptions, when a phase commits, what renders |

`linesBlock` satisfies `{ render(width): string[]; invalidate(): void }` directly.
Pi types component slots as an interface, so no component library is needed.

## Deferred

- **Subtree collapse.** `EntryRenderOptions` is `{ expanded }` only, so a row
  expands but a phase group cannot fold. Fine at 3–12 agents. Revisit if runs
  routinely exceed ~30 agents.
- **Themed widget lines.** `ctx.ui.setWidget` takes plain strings and receives no
  `Theme`. Only transcript entries are themed.
- **Replacing `/workflow`.** The engine's modal navigator is untouched. Whether
  it stays is the engine's call, not this extension's.
- **Repaint coalescing.** `paintWidget()` runs on every agent state change.
  Unmeasured under a large fan-out; deferred until a real run shows a problem.

## Roadmap

| Phase | Done when |
|---|---|
| 1 — build | `nix build .#pi-workflows` exits 0 and `nix flake check` passes — **done 2026-07-29** |
| 2 — live | A real workflow shows an animating widget, and finished phases appear as grouped transcript rows — **done 2026-07-29** |
| 3 — durable | Those rows are still present and correctly grouped after `/resume` |
| 4 — coverage | Checkpoint, budget and worktree events verified against a run that produces each |
