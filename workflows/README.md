# workflows — the packs the picker offers

Each directory here is a **workflow pack**: a `command.json` describing the pack
and a `.js` file the [pi-workflows](../extensions/pi-workflows/) engine runs.
A consuming system flake copies these directories into
`~/.local/share/pi/agent/workflows/<dir>/`, which the engine scans, so each pack
registers a slash command and appears in the pack picker at session start.

| Pack | Shape | Use it when |
|---|---|---|
| [`pie`](pie/) | plan → implement → evaluate, checkpoint after the plan | you know what you want built and want it verified by someone who did not build it |
| [`review`](review/) | correctness + risk in parallel → merge → optional fix | a diff exists and you want findings ranked, not prose |
| [`debug`](debug/) | hypotheses → one context per test → fix after checkpoint | something fails and the cause is unknown |

Packs shipped here are **generic**: they assume a git repository and nothing
else. Personal packs — ones that name your plan file, your skills, your model
aliases — belong in your own flake, not in this one; the engine scans one
directory, so both sources land in the same place at runtime.

## Writing a pack

A pack is a function body, not a module. The engine evaluates the `.js` file
inside an async function whose scope holds `args`, `agent`, `phase`, `shell`,
`checkpoint`, `prompt`, `parallel`, `pipeline`, `log` and `withWorktree`. That
is why top-level `await` and top-level `return` are legal here and why nothing
imports anything: there is no module system, no filesystem, no network and no
timers in that sandbox. Delegate all of that to `agent()` or `shell()`.

Three engine constraints that only bite at runtime, so the check below catches
them earlier:

- `checkpoint({ name, prompt, context })` needs a **literal** name — a computed
  one fails mid-run. `prompt` is capped at 1024 bytes, `context` at 4096.
- `checkpoint()` resolves to the string `"approved"` or `"rejected"`, not a
  boolean.
- `phase()` names may be computed; agent `label`s may too.

Validate before shipping:

```
nix build .#checks.x86_64-linux.workflow-packs
```

That parses every pack the way the engine does and checks every `command.json`
field the picker reads, including that each question is answerable (`options`,
`free: true`, or both).
