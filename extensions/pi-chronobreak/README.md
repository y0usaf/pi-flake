# pi-chronobreak

Cuts assistant **generation loops**: the model repeating the same output over
and over inside one turn, never settling (often while failing to emit a clean
tool call). Each repetition appends to the session, degrading context.

The loop's real signature is **behavioural stall**, not any particular content
shape. So chronobreak is content-agnostic: a message that has emitted a tool
call is progressing and is never cut; only pure-prose output that is
lexically exhausted (redundant + low novelty) can be a loop.

Detection is three pure tiers, each recomputed from the full accumulated text
on every streaming update:

1. **exact** — a verbatim normalized segment appears >= 3 times.
2. **stall** — pairwise near-duplicate segments (paraphrase-tolerant) whose
   growing tail is redundant and introduces little new content. Catches the
   "loose" loop (same intent, slightly different wording each time) and
   out-of-distribution loops (calculus, code, "is-42").
3. **fragment** — verbless/utterance degeneracies ("42. 42." x many).

A redundant cluster that shares a large skeleton (one varying payload word per
item) is treated as a legitimate template enumeration, not a loop.

When a loop is detected:

1. **Aborts** the run (ctx.abort()).
2. **Truncates** the assistant message back to where the loop began, keeping the
   coherent lead-in and dropping the repeated tail, so the model never sees the
   looped garbage again.
3. **Re-injects** a user message telling the model to take one decisive action
   (a single clean tool call or a direct answer), re-running the turn from a
   clean context.

It gives up after 3 strikes per user turn to avoid an abort/re-run spin loop.

chronobreak is a spectator: it never touches files or the JS kernel - it only
aborts generation, replaces one assistant message, and queues a user message.

## Development

Uses pi extension event API (message_start / message_update / message_end /
agent_end / input). See DESIGN.md.

Tests: `bun test` (pure detector fixtures + extension flow incl. the toolCall
eligibility gate and enumeration exemption).

Dev load: pi -e extensions/pi-chronobreak
Lint: biome lint extensions/pi-chronobreak/src/index.ts
Nix (once wired): nix build .#pi-chronobreak, nix flake check.
