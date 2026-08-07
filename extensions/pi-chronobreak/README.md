# pi-chronobreak

Cuts assistant **generation loops**: the model repeating the same output over
and over inside one turn, never settling (often while failing to emit a clean
tool call). Each repetition appends to the session, degrading context.

When chronobreak detects a repeated text segment (same normalized sentence /
line appears >= 3 times in one assistant message), it:

1. **Aborts** the run (ctx.abort()).
2. **Scrubs** the polluted assistant message down to a one-line marker, so the
   garbage never stays in context.
3. **Re-injects** a user message telling the model to take one decisive action
   (a single clean tool call or a direct answer), re-running the turn from a
   clean context.

It gives up after 3 strikes per user turn to avoid an abort/re-run spin loop.

chronobreak is a spectator: it never touches files or the JS kernel - it only
aborts generation, replaces one assistant message, and queues a user message.

## Development

Uses pi extension event API (message_start / message_update / message_end /
agent_end / input). See DESIGN.md.

Dev load: pi -e extensions/pi-chronobreak
Lint: biome lint extensions/pi-chronobreak/src/index.ts
Nix (once wired): nix build .#pi-chronobreak, nix flake check.
