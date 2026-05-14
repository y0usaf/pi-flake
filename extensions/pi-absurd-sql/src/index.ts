/**
 * absurd-sql — Autonomous durable memory for Pi
 *
 * Zero-dependency SQLite-backed agent memory that runs itself.
 * Uses bun:sqlite (built-in to Bun, no npm install needed).
 *
 * Automatic behavior (no user management):
 * - Learns facts from every conversation
 * - Injects relevant memories into each prompt
 * - Preserves knowledge through compaction
 * - Manages its own context budget
 *
 * Tools exposed to the LLM (used when needed, not required):
 * - remember: store a fact
 * - recall: look up facts by pattern
 * - forget: remove a fact
 * - memory_sql: raw SQL query for power use
 */

import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Constants ────────────────────────────────────────────────

const DB_NAME = "absurd.db";
const CORE_BUDGET = 600;
const RELEVANT_BUDGET = 1500;
const MAX_MEMORY_MSGS = 2;
const FACT_MAX_LEN = 2000;

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "was",
  "one", "our", "out", "has", "had", "this", "that", "with", "have",
  "from", "they", "been", "said", "each", "which", "their", "will",
  "about", "many", "then", "them", "would", "make", "like", "could",
  "into", "time", "very", "when", "what", "your", "how", "use", "using",
  "used", "does", "also", "just", "let", "please", "want", "need",
  "help", "show", "tell", "give", "way", "her",
]);

// ── Helpers ──────────────────────────────────────────────────

function tokEst(s: string): number {
  return Math.ceil(s.length / 4);
}

function keywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_.\/]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function scoreFact(key: string, val: string, kws: string[]): number {
  const k = key.toLowerCase();
  const v = val.toLowerCase();
  let s = 0;
  for (const w of kws) {
    if (k.includes(w)) s += 3;
    if (v.includes(w)) s += 1;
  }
  return s;
}

function textOf(msg: any): string {
  if (!msg?.content) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c: any) => c.type === "text" && c.text)
      .map((c: any) => c.text)
      .join("\n");
  }
  return "";
}

// ── Schema ───────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS facts (
    key       TEXT PRIMARY KEY,
    value     TEXT NOT NULL,
    source    TEXT DEFAULT 'manual',
    pinned    INTEGER DEFAULT 0,
    hits      INTEGER DEFAULT 0,
    created   TEXT DEFAULT (datetime('now')),
    updated   TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    type      TEXT NOT NULL,
    payload   TEXT DEFAULT '{}',
    session   TEXT,
    ts        TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS checkpoints (
    id        TEXT PRIMARY KEY,
    scope     TEXT DEFAULT 'default',
    state     TEXT NOT NULL,
    created   TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_facts_pinned ON facts(pinned);
  CREATE INDEX IF NOT EXISTS idx_facts_hits   ON facts(hits DESC);
  CREATE INDEX IF NOT EXISTS idx_events_type  ON events(type);
  CREATE INDEX IF NOT EXISTS idx_events_ts    ON events(ts);
`;

// ── Extension ────────────────────────────────────────────────

export default function absurdSql(pi: ExtensionAPI) {
  let db: Database;
  let q: {
    upsertFact: ReturnType<Database["prepare"]>;
    getFact: ReturnType<Database["prepare"]>;
    searchFacts: ReturnType<Database["prepare"]>;
    allFacts: ReturnType<Database["prepare"]>;
    pinnedFacts: ReturnType<Database["prepare"]>;
    deleteFact: ReturnType<Database["prepare"]>;
    bumpHits: ReturnType<Database["prepare"]>;
    logEvent: ReturnType<Database["prepare"]>;
    upsertCkpt: ReturnType<Database["prepare"]>;
    getCkpt: ReturnType<Database["prepare"]>;
  };

  function open() {
    const dbPath = join(getAgentDir(), DB_NAME);
    db = new Database(dbPath, { create: true });
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA busy_timeout=3000");
    db.exec(SCHEMA);
    q = {
      upsertFact: db.prepare(`
        INSERT INTO facts (key, value, source, pinned)
        VALUES ($key, $value, $source, $pinned)
        ON CONFLICT(key) DO UPDATE SET
          value=excluded.value, source=excluded.source, updated=datetime('now')
      `),
      getFact: db.prepare("SELECT * FROM facts WHERE key = ?"),
      searchFacts: db.prepare(
        "SELECT key, value, hits FROM facts WHERE key LIKE ? OR value LIKE ? ORDER BY hits DESC LIMIT ?"
      ),
      allFacts: db.prepare(
        "SELECT key, value, pinned, hits, source FROM facts ORDER BY pinned DESC, hits DESC"
      ),
      pinnedFacts: db.prepare(
        "SELECT key, value FROM facts WHERE pinned = 1 ORDER BY key"
      ),
      deleteFact: db.prepare("DELETE FROM facts WHERE key = ?"),
      bumpHits: db.prepare("UPDATE facts SET hits = hits + 1 WHERE key = ?"),
      logEvent: db.prepare(
        "INSERT INTO events (type, payload, session) VALUES (?, ?, ?)"
      ),
      upsertCkpt: db.prepare(`
        INSERT INTO checkpoints (id, scope, state)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET state=excluded.state, created=datetime('now')
      `),
      getCkpt: db.prepare("SELECT state FROM checkpoints WHERE id = ?"),
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────

  pi.on("session_start", async () => {
    open();
  });

  pi.on("session_shutdown", async () => {
    try { db?.close(); } catch { /* ok */ }
  });

  // ── Layer 0+1: Memory injection ────────────────────────────

  pi.on("before_agent_start", async (event) => {
    if (!db) return;

    const result: {
      systemPrompt?: string;
      message?: { customType: string; content: string; display: boolean };
    } = {};

    // Layer 0: pinned facts → system prompt
    const pinned = q.pinnedFacts.all() as { key: string; value: string }[];
    if (pinned.length > 0) {
      let lines = pinned.map((f) => `- ${f.key}: ${f.value}`);
      let block = lines.join("\n");
      while (tokEst(block) > CORE_BUDGET && lines.length > 1) {
        lines.pop();
        block = lines.join("\n");
      }
      result.systemPrompt =
        event.systemPrompt +
        "\n\n<agent-memory type=\"core\" note=\"Durable facts. Reference naturally — never announce you are reading memory.\">\n" +
        block +
        "\n</agent-memory>";
    }

    // Layer 1: keyword-matched facts → hidden message
    const kws = keywords(event.prompt);
    if (kws.length > 0) {
      const all = q.allFacts.all() as {
        key: string; value: string; pinned: number; hits: number;
      }[];
      const scored = all
        .filter((f) => !f.pinned)
        .map((f) => ({ ...f, score: scoreFact(f.key, f.value, kws) }))
        .filter((f) => f.score > 0)
        .sort((a, b) => b.score - a.score);

      if (scored.length > 0) {
        const picked: string[] = [];
        let budget = RELEVANT_BUDGET;
        for (const f of scored) {
          const line = `- ${f.key}: ${f.value}`;
          const cost = tokEst(line);
          if (budget - cost < 0) break;
          picked.push(line);
          budget -= cost;
          q.bumpHits.run(f.key);
        }
        if (picked.length > 0) {
          result.message = {
            customType: "absurd-memory-context",
            content:
              "<agent-memory type=\"relevant\" note=\"Facts matching this prompt. Use naturally.\">\n" +
              picked.join("\n") +
              "\n</agent-memory>",
            display: false,
          };
        }
      }
    }

    if (result.systemPrompt || result.message) return result;
  });

  // ── Layer 2: Context pruning ───────────────────────────────

  pi.on("context", async (event) => {
    if (!db) return;
    const msgs = event.messages;
    const memIdx: number[] = [];
    for (let i = 0; i < msgs.length; i++) {
      if ((msgs[i] as any).customType === "absurd-memory-context") {
        memIdx.push(i);
      }
    }
    if (memIdx.length > MAX_MEMORY_MSGS) {
      const drop = new Set(memIdx.slice(0, memIdx.length - MAX_MEMORY_MSGS));
      return { messages: msgs.filter((_, i) => !drop.has(i)) };
    }
  });

  // ── Layer 4: Auto-learning ─────────────────────────────────

  pi.on("agent_end", async (event) => {
    if (!db) return;
    const msgs = event.messages || [];
    if (msgs.length === 0) return;

    // Log turn event
    const userText = textOf(msgs.find((m: any) => m.role === "user"));
    const asstText = msgs
      .filter((m: any) => m.role === "assistant")
      .map(textOf)
      .join("\n");

    q.logEvent.run(
      "turn",
      JSON.stringify({
        promptPreview: userText.slice(0, 300),
        responsePreview: asstText.slice(0, 300),
        messages: msgs.length,
      }),
      null
    );

    // Auto-extract from tool calls
    for (const msg of msgs) {
      const content = (msg as any).content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type !== "toolCall") continue;

        // Build commands
        if (block.name === "bash" && block.arguments?.command) {
          const cmd = String(block.arguments.command).split("\n")[0].trim();
          if (
            /^(npm|yarn|pnpm|bun|cargo|make|nix|gradle|mvn|go|zig|cmake)\s+(build|run|test|dev|start|install|check)/.test(cmd)
          ) {
            q.upsertFact.run({
              $key: "project.build_command",
              $value: cmd,
              $source: "auto",
              $pinned: 0,
            });
          }
        }

        // Project manifests
        if (
          (block.name === "write" || block.name === "edit") &&
          block.arguments?.file_path
        ) {
          const fp = String(block.arguments.file_path);
          if (
            /\/(package\.json|Cargo\.toml|flake\.nix|pyproject\.toml|go\.mod|pom\.xml|build\.gradle)$/.test(
              fp
            )
          ) {
            q.upsertFact.run({
              $key: "project.manifest",
              $value: fp,
              $source: "auto",
              $pinned: 0,
            });
          }
        }
      }
    }

    // Auto-extract from tool results
    for (const msg of msgs) {
      if ((msg as any).role !== "toolResult") continue;
      const text = textOf(msg);

      // Git remote
      const remote = text.match(/origin\s+(https?:\/\/[^\s]+|git@[^\s]+)/);
      if (remote) {
        q.upsertFact.run({
          $key: "project.git_remote",
          $value: remote[1],
          $source: "auto",
          $pinned: 0,
        });
      }
    }
  });

  // ── Layer 5: Compaction rescue ─────────────────────────────

  pi.on("session_before_compact", async (event) => {
    if (!db) return;

    for (const msg of event.preparation.messagesToSummarize) {
      const content = (msg as any).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (
          block.type === "toolCall" &&
          block.name === "remember" &&
          block.arguments
        ) {
          const { key, value } = block.arguments as { key: string; value: string };
          if (key && value) {
            q.upsertFact.run({
              $key: key,
              $value: value.slice(0, FACT_MAX_LEN),
              $source: "compaction-rescue",
              $pinned: 0,
            });
          }
        }
      }
    }

    q.logEvent.run(
      "compaction",
      JSON.stringify({
        summarized: event.preparation.messagesToSummarize.length,
        tokensBefore: event.preparation.tokensBefore,
      }),
      null
    );
  });

  // ── Tools ──────────────────────────────────────────────────

  pi.registerTool({
    name: "remember",
    label: "Remember",
    description:
      "Store a fact in durable memory that persists across sessions. " +
      "Use for user preferences, project knowledge, key decisions, " +
      "or anything worth keeping. Keys should be dot-namespaced " +
      "(e.g., 'user.name', 'project.lang', 'decision.auth_approach').",
    promptSnippet: "remember — save a durable fact (key + value)",
    promptGuidelines: [
      "Use `remember` proactively when you learn something useful for future sessions — don't ask permission.",
      "Use dot-namespaced keys: user.*, project.*, preference.*, decision.*, context.*",
    ],
    parameters: Type.Object({
      key: Type.String({
        description: "Dot-namespaced key, e.g. 'user.name', 'project.language'",
      }),
      value: Type.String({ description: "The fact to remember" }),
      pinned: Type.Optional(
        Type.Boolean({
          description: "Pin to always appear in system prompt (use sparingly)",
        })
      ),
    }),
    async execute(_id, params) {
      q.upsertFact.run({
        $key: params.key,
        $value: params.value.slice(0, FACT_MAX_LEN),
        $source: "manual",
        $pinned: params.pinned ? 1 : 0,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Remembered: ${params.key} = ${params.value}${params.pinned ? " [pinned]" : ""}`,
          },
        ],
        details: { key: params.key, pinned: !!params.pinned },
      };
    },
  });

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Look up facts from durable memory by key/value pattern. " +
      "Supports SQL LIKE patterns (% = wildcard). " +
      "Use when you need info from a previous session.",
    promptSnippet: "recall — look up durable facts by key pattern",
    parameters: Type.Object({
      pattern: Type.String({
        description: "SQL LIKE pattern, e.g. 'project.%' or '%typescript%'",
      }),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default 20)", default: 20 })
      ),
    }),
    async execute(_id, params) {
      const limit = params.limit ?? 20;
      const rows = q.searchFacts.all(
        params.pattern, params.pattern, limit
      ) as { key: string; value: string; hits: number }[];
      for (const r of rows) q.bumpHits.run(r.key);

      const text =
        rows.length > 0
          ? rows.map((r) => `${r.key}: ${r.value}`).join("\n")
          : "No matching facts.";

      return {
        content: [{ type: "text" as const, text }],
        details: { count: rows.length, pattern: params.pattern },
      };
    },
  });

  pi.registerTool({
    name: "forget",
    label: "Forget",
    description: "Remove a fact from durable memory by exact key.",
    promptSnippet: "forget — delete a stored fact by key",
    parameters: Type.Object({
      key: Type.String({ description: "Exact key to delete" }),
    }),
    async execute(_id, params) {
      const existing = q.getFact.get(params.key) as any;
      if (!existing) {
        return {
          content: [{ type: "text" as const, text: `No fact: ${params.key}` }],
          details: { found: false },
        };
      }
      q.deleteFact.run(params.key);
      return {
        content: [
          { type: "text" as const, text: `Forgot: ${params.key} (was: ${existing.value})` },
        ],
        details: { key: params.key, was: existing.value },
      };
    },
  });

  pi.registerTool({
    name: "memory_sql",
    label: "Memory SQL",
    description:
      "Run raw SQL against the durable memory database. " +
      "Tables: facts(key,value,source,pinned,hits), " +
      "events(type,payload,ts), checkpoints(id,scope,state). " +
      "Use for analytics, bulk ops, or complex queries.",
    promptSnippet: "memory_sql — raw SQL on the memory database",
    parameters: Type.Object({
      query: Type.String({ description: "SQL to execute" }),
    }),
    async execute(_id, params) {
      try {
        const up = params.query.trim().toUpperCase();
        if (up.startsWith("SELECT") || up.startsWith("EXPLAIN") || up.startsWith("PRAGMA")) {
          const rows = db.query(params.query).all();
          return {
            content: [
              {
                type: "text" as const,
                text: rows.length > 0 ? JSON.stringify(rows, null, 2) : "No results.",
              },
            ],
            details: { rows: rows.length, type: "read" },
          };
        }
        const info = db.run(params.query);
        return {
          content: [
            { type: "text" as const, text: `OK — ${info.changes} row(s) changed.` },
          ],
          details: { changes: info.changes, type: "write" },
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `SQL error: ${e.message}` }],
          details: { error: e.message },
        };
      }
    },
  });

  // ── Commands ───────────────────────────────────────────────

  pi.registerCommand("memory", {
    description: "Show durable memory stats and recent facts",
    handler: async (_args, ctx) => {
      if (!db) {
        ctx.ui.notify("Memory DB not ready", "warning");
        return;
      }

      const n = (sql: string) =>
        (db.query(sql).get() as any)?.n ?? 0;

      const factCount = n("SELECT COUNT(*) as n FROM facts");
      const pinnedCount = n("SELECT COUNT(*) as n FROM facts WHERE pinned=1");
      const eventCount = n("SELECT COUNT(*) as n FROM events");
      const ckptCount = n("SELECT COUNT(*) as n FROM checkpoints");

      const recent = db
        .query(
          "SELECT key, value, source, pinned FROM facts ORDER BY updated DESC LIMIT 10"
        )
        .all() as { key: string; value: string; source: string; pinned: number }[];

      let msg = `📊 ${factCount} facts (${pinnedCount} pinned) · ${eventCount} events · ${ckptCount} checkpoints\n`;
      if (recent.length > 0) {
        msg += "\nRecent:\n";
        for (const f of recent) {
          const pin = f.pinned ? "📌 " : "   ";
          const src = f.source !== "manual" ? ` [${f.source}]` : "";
          msg += `${pin}${f.key}: ${f.value.slice(0, 80)}${src}\n`;
        }
      }

      ctx.ui.notify(msg, "info");
    },
  });
}
