# pi-loom-router

The policy gate of the workflow-first `loom` stack: the agent you chat with
routes, it does not edit.

At `session_start` the extension removes `edit`, `write` and `bash` from the
active tool set and switches `grep`, `find` and `ls` on, so the chat model is
never offered a way to mutate the tree and always has a way to read it.
Mutation happens inside a workflow run instead, where a sub-agent holds the
tool, a git worktree bounds the blast radius, and the diff reported is the one
git recorded.

## Scope

Shipped **only** in `loom` (`packages.pi-loom-router`, wired into the loom
stack in `flake.nix`). It has no entry in `extensions/registry.nix`, so plain
`pi` and the `pi-full` bundle cannot enable it through an extension flag —
your normal `pi` sessions keep every tool they had.

## Invariants

- **In memory, never persisted.** The gate is recomputed on every session
  start and nothing is written to disk, so a killed `loom` cannot leave a
  plain `pi` session crippled. `pi-tool-management` is excluded from the loom
  stack for the opposite reason: it persists a global disabled-tools list.
- **Visibility, not the launch boundary.** A workflow run's tool ceiling comes
  from `pi.getAllTools()` (what the session was configured with). This
  extension moves only `pi.getActiveTools()` (what the model may call now), so
  a gated chat agent can still launch a workflow whose executor sub-agent
  writes code. See the *Launch boundary* section of
  `extensions/pi-loom/DESIGN.md` before touching either side.
- **Name matching covers overrides.** `pi-hashline` registers its own `edit`
  under the builtin name, so a single `edit` entry gates both.

## Why `bash` goes entirely, and why the gate is a swap

`pi.setActiveTools` addresses tool names, not invocations, and a gate that
leaves `bash` reachable is not a gate — `bash` can write any file `edit`
could. Read-only shell is a genuine loss and is tracked as **P5b-ii** in
`extensions/pi-loom/DESIGN.md`, which re-admits `bash` behind a `tool_call`
classifier.

Subtraction alone would have been too harsh, which is measurable rather than a
matter of taste: pi's default active set is `read`, `bash`, `edit`, `write`,
while `grep`, `find` and `ls` are configured but inactive. Removing the
mutating three from that default leaves the chat agent holding `read` alone —
no directory listing, no symbol search — and `DESIGN.md` rejects that under
*Hard router (no file access at all)*. So the gate trades capability rather
than only taking it away. The restored tools are intersected with
`pi.getAllTools()`, so `loom --tools read` stays narrower than the policy
instead of being widened by it.

## Acceptance

`checks.pi-loom-router-gate` (`nix/checks/loom-router-gate.sh`) proves, with no
model contacted:

1. In `loom`, the chat agent's active tools contain none of `edit`, `write`,
   `bash`, and do contain `read`, `grep`, `find` and `ls`.
2. In plain `pi`, all three mutating tools are active.
3. `pi-full` ships no copy of this package.
4. A workflow launched inside a gated `loom` session still records `edit`,
   `write` and `bash` in its launch snapshot.
