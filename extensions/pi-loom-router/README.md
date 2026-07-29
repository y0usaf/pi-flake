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

It also opens the session on what the stack *is* for: at startup a picker lists
the workflows you can run, and Esc drops straight to chat.

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

## The picker, because subtraction is invisible

Both mechanisms above only ever take something away, and a `loom` that opens on
an empty prompt looks exactly like a `pi` that has mysteriously lost its
editing tools. So at `session_start` with `reason: "startup"`, `src/picker.ts`
offers the workflows this session can actually run:

```
Start a workflow — or Esc to chat
→ /build — Plan a change, implement it item by item inside one git worktree,
          and review every item.
  /quick — Make one small change with a single agent: no plan, no review,
          no worktree.
  Chat instead (Esc)
```

Esc, or the last row, leaves the editor untouched and drops to chat. Choosing a
workflow puts `/build ` in the editor with the cursor after it — not a launched
run, for two reasons: no extension API dispatches a slash command
(`pi.sendUserMessage` sends text to the model instead), and every workflow's
first argument is a task description the picker cannot know. You type the task
and press Enter, with pi's own palette showing the usage hint.

The list comes from `pi.getCommands()` rather than a second copy of the
engine's discovery rules. The filter anchors itself on `/workflows`, which the
engine always registers: every other command sharing its `sourceInfo.path` is a
workflow, except `/workflow`, which controls runs.

Three conditions suppress the picker entirely, and each is deliberate:

- **Any mode but `tui`.** In RPC mode `ui.select` waits for a client response
  that a headless script never sends, so the dialog would hang rather than
  appear.
- **Text already in the editor.** `setEditorText` replaces the buffer, and no
  menu is worth losing a half-typed thought.
- **No workflows installed, or no engine loaded.** An empty menu is worse than
  no menu.

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

`checks.pi-loom-router-picker` (`nix/checks/loom-router-picker.sh`) uses the
same stub harness for the picker: startup must open exactly one dialog listing
`/build` and `/quick` and neither `/workflow` nor another extension's commands;
Esc and the chat row must both leave the editor empty; choosing `/build` must
leave exactly `/build `; and no dialog may open without workflows, without the
engine, outside `tui` mode, outside a startup, or over text the user typed. It
also asserts `edit` is already gone at the moment the dialog opens, which is
the registration-order claim rather than a restatement of the gate check.

The honest gap: emitting a real `tool_call` needs an assistant message, so no
offline check can prove pi *invokes* the handler. The gate check proves the
extension loads in a real session; this one proves what the handler decides.

The picker has the same shape of gap in reverse: rendering a dialog needs a
terminal. The check proves what the handler decides, `pi-loom-router-gate`
proves the extension does not wedge a live RPC session, and the visual half —
the overlay appearing, Esc dismissing it, Enter prefilling the editor — was
verified by hand through a pty and is not in CI.
