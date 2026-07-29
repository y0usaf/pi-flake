# pi-loom-router

The policy gate of the workflow-first `loom` stack: the agent you chat with
routes, it does not edit.

At `session_start` the extension removes `edit` and `write` from the active
tool set and switches `grep`, `find` and `ls` on. `bash` stays active and is
judged one invocation at a time by a `tool_call` handler, so the chat model
keeps a shell it can look around with and is refused the commands that write.
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

## Two mechanisms, because the tools differ in kind

`pi.setActiveTools` addresses tool *names*. That is the right instrument for
`edit` and `write`, which exist to mutate: removing the name means the model is
never offered them. It is the wrong instrument for `bash`, whose invocation is
what decides — `ls -la` and `rm -rf src` are the same tool. P5b-i hid `bash`
for want of a second mechanism and the router lost `git status`, `rg -n` and
`nix flake metadata` with it.

P5b-ii adds that second mechanism: `src/shell-policy.ts` classifies the command
string and the `tool_call` handler returns `{ block: true, reason }` for
anything that could write. The policy is default-deny — an allowlist of command
names with no writing mode, plus argument rules for the few that grow one with
a flag (`sed -i`, `find -delete`, `sort -o`), plus per-subcommand narrowing for
`git` and `nix` (so `git log` runs and `git commit` does not, `nix eval` runs
and `nix build` does not, because it drops a `./result` symlink into the tree).
Constructs the parser cannot judge — command substitution, heredocs, output
redirects to a real path — are refused rather than guessed at.

Every refusal names `/quick` and `/build`, because a refusal that does not say
what to do instead just produces a second, sneakier attempt.

**It is a guardrail, not a sandbox.** Any string-level shell classifier can be
beaten by an adversary willing to obfuscate; the answer to a hostile model is
not a better regex but the worktree isolation an exec stage already gives you.
What this buys is that a cooperative model cannot casually mutate your checkout
from the chat seat.

The handler is scoped to the chat session. Workflow sub-agents are separate
sessions created with explicit `extensionFactories`
(`extensions/pi-loom/src/agent-execution.ts`), so an exec stage keeps its full
shell inside its worktree.

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

1. In `loom`, the chat agent's active tools contain neither `edit` nor `write`,
   and do contain `read`, `bash`, `grep`, `find` and `ls`.
2. In plain `pi`, all three mutating tools are active.
3. `pi-full` ships no copy of this package.
4. A workflow launched inside a gated `loom` session still records `edit`,
   `write` and `bash` in its launch snapshot.

`checks.pi-loom-router-shell` (`nix/checks/loom-router-shell.sh`) covers the
classifier by importing this extension, handing it a stub `ExtensionAPI` and
driving the handlers it registered — the same shape upstream uses in
`packages/coding-agent/test/plan-mode-extension.test.ts`. Thirteen read-only
commands must run and twenty mutating ones must come back blocked with a reason
naming `/quick` and `/build`.

The honest gap: emitting a real `tool_call` needs an assistant message, so no
offline check can prove pi *invokes* the handler. The gate check proves the
extension loads in a real session; this one proves what the handler decides.
