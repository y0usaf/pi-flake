# pi-absurd-sql

Autonomous durable memory for Pi — zero-dependency SQLite via `bun:sqlite`.

Inspired by [earendil-works/absurd](https://github.com/earendil-works/absurd), [Armin Ronacher's "Absurd Workflows"](https://lucumr.pocoo.org/2025/11/3/absurd-workflows/), and [Vercel's "Bash is All You Need"](https://vercel.com/blog/testing-if-bash-is-all-you-need).

## What it does

Runs autonomously with no user management. The agent learns, remembers, and recalls across sessions automatically.

### Automatic (no tools needed)

| Lifecycle hook | Behavior |
|---|---|
| `session_start` | Opens/creates `~/.pi/agent/absurd.db` |
| `before_agent_start` | Injects pinned core facts into system prompt + keyword-matched relevant facts as hidden message |
| `context` | Prunes stale memory injection messages (keeps last 2) |
| `agent_end` | Auto-extracts facts from tool usage: build commands, git remotes, project manifests |
| `session_before_compact` | Rescues `remember` calls from messages about to be compacted |

### Progressive disclosure

```
Layer 0 — System prompt: pinned facts (~600 tok budget, always present)
Layer 1 — Hidden message: prompt-relevant facts (~1500 tok budget, per-prompt)
Layer 2 — Context pruning: drop old memory messages (keep last 2)
Layer 3 — On-demand tools: LLM pulls when needed (zero cost until used)
Layer 4 — Auto-learning: extract facts from tool results (background)
Layer 5 — Compaction rescue: preserve facts before messages are discarded
```

### Tools (available to the LLM)

| Tool | Purpose |
|---|---|
| `remember` | Store a durable fact (used proactively, no permission needed) |
| `recall` | Look up facts by pattern |
| `forget` | Remove a fact |
| `memory_sql` | Raw SQL query on the memory database |

### Commands

```
/memory    Show memory stats and recent facts
```

## Zero dependencies

Uses `bun:sqlite` — built into Bun, which Pi already runs on. No `npm install`, no native bindings, no WASM.

## Schema

```sql
facts        (key, value, source, pinned, hits, created, updated)
events       (id, type, payload, session, ts)
checkpoints  (id, scope, state, created)
```

## Database location

`~/.pi/agent/absurd.db` — global, persists across all sessions and projects.
