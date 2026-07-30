import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

// Direct SQLite access for aging entries and building legacy schemas in TTL
// tests. Resolved via createRequire so tsc needs no bun type declarations.
const nodeRequire = createRequire(import.meta.url);
const { Database } = nodeRequire("bun:sqlite") as {
  Database: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...params: unknown[]): unknown };
    close(): void;
  };
};

const BASH_OUTPUT = "line one of output\n" + "x".repeat(2048);

// Tests can swap what the fake local shell emits.
let localExecOutput = BASH_OUTPUT;

mock.module("@earendil-works/pi-coding-agent", () => ({
  createLocalBashOperations: () => ({
    exec: async (
      _command: string,
      _cwd: string,
      options: { onData: (data: Buffer) => void },
    ) => {
      options.onData(Buffer.from(localExecOutput));
      return { exitCode: 0 };
    },
  }),
  keyHint: (_binding: string, description: string) => `ctrl+o ${description}`,
}));

// Only `Text` is used, and only for its setText/instanceof contract.
class FakeText {
  constructor(public text = "") {}
  setText(value: string) {
    this.text = value;
  }
}

mock.module("@earendil-works/pi-tui", () => ({ Text: FakeText }));

// typebox is only used to declare tool parameters; stub it so tests run
// without node_modules (the Nix check sandbox has no network).
mock.module("typebox", () => ({
  Type: {
    Object: (value: unknown) => ({ type: "object", ...(value as object) }),
    String: (value?: unknown) => ({ type: "string", ...(value as object) }),
    Number: (value?: unknown) => ({ type: "number", ...(value as object) }),
    Optional: (value: unknown) => value,
  },
}));

const {
  buildPreview,
  createLocalAphroditeClient,
  detectType,
  engineCandidateRange,
  formatRetrieveResult,
  parseSkipTools,
  registerPiAphrodite,
} = await import("../index.ts");

type TestEvent = Record<string, unknown>;

type TestContext = {
  hasUI: boolean;
  signal?: AbortSignal;
  getContextUsage?: () => {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
  ui: {
    notify(message: string, level: string): void;
    setStatus(key: string, value: string | undefined): void;
    theme: {
      fg(color: string, value: string): string;
    };
  };
};

type Handler = (event: TestEvent, ctx: TestContext) => unknown;

type FakeCommand = {
  handler(args: string, ctx: TestContext): Promise<void>;
};

type FakeTool = {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: string; text: string }> }>;
  renderResult?(
    result: { content: unknown; details?: unknown },
    options: { expanded: boolean; isPartial: boolean },
    theme: { fg(color: string, value: string): string },
    context: { lastComponent?: unknown; isError: boolean },
  ): { text: string };
};

function makeCtx(
  hasUI = false,
  contextPercent: number | null | undefined = undefined,
): TestContext & {
  notifications: string[];
  statuses: Array<[string, string | undefined]>;
} {
  const notifications: string[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  return {
    hasUI,
    notifications,
    statuses,
    getContextUsage:
      contextPercent === undefined
        ? undefined
        : () => ({
            tokens: 1000,
            contextWindow: 10000,
            percent: contextPercent,
          }),
    ui: {
      notify(message) {
        notifications.push(message);
      },
      setStatus(key, value) {
        statuses.push([key, value]);
      },
      theme: { fg: (_color, value) => value },
    },
  };
}

function createFakePi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, FakeCommand>();
  const tools: FakeTool[] = [];

  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (name: string, def: FakeCommand) =>
      commands.set(name, def),
    registerTool: (def: FakeTool) => tools.push(def),
  };

  return { pi, handlers, commands, tools };
}

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-aphrodite-test-"));
  tempDirs.push(dir);
  return join(dir, "ccr.db");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("detectType", () => {
  test("classifies common shapes", () => {
    expect(detectType("Error: boom\nstack", "bash")).toBe("error");
    expect(detectType('{"a": 1}', "bash")).toBe("json");
    expect(detectType("diff --git a/x b/x\n@@ -1 +1 @@", "bash")).toBe("diff");
    expect(detectType("plain output", "bash")).toBe("terminal");
    expect(detectType("plain output", "read")).toBe("code");
    expect(detectType("plain output", undefined)).toBe("text");
  });
});

describe("buildPreview", () => {
  test("summarizes size and first meaningful line", () => {
    const preview = buildPreview("\nhello world\nmore", "bash", "terminal");
    expect(preview).toContain("bash:terminal");
    expect(preview).toContain("3L");
    expect(preview).toContain("hello world");
  });
});

describe("parseSkipTools", () => {
  test("splits, trims and drops empty entries", () => {
    expect([...parseSkipTools("read")]).toEqual(["read"]);
    expect([...parseSkipTools(" read , edit ,,")]).toEqual(["read", "edit"]);
    expect(parseSkipTools("").size).toBe(0);
  });
});

describe("createLocalAphroditeClient", () => {
  test("stores content and tracks counters", async () => {
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    const stored = await client.store(BASH_OUTPUT, "terminal");

    expect(stored?.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(stored?.originalSize).toBe(BASH_OUTPUT.length);
    expect(stored?.markerSize).toBeGreaterThan(0);
    expect(stored?.ratio).toBeGreaterThan(1);
    expect(client.getStatus()).toMatchObject({
      availability: "available",
      stored: 1,
      attempts: 1,
      originalBytes: BASH_OUTPUT.length,
    });
    client.close();
  });

  test("retrieves stored content with query, offset, and limit", async () => {
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    const text = "alpha\nbeta\ngamma\nBeta two\ndelta";
    const stored = await client.store(text, "text");

    expect(await client.retrieve(stored!.hash, {})).toBe(text);
    expect(await client.retrieve(stored!.hash, { query: "beta" })).toBe(
      "beta\nBeta two",
    );
    expect(await client.retrieve(stored!.hash, { offset: 1, limit: 2 })).toBe(
      "beta\ngamma",
    );
    expect(client.getStatus().retrieves).toBe(3);
    client.close();
  });

  test("throws on missing hash", async () => {
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    await expect(client.retrieve("nope", {})).rejects.toThrow(
      "CCR entry not found: nope",
    );
    client.close();
  });

  test("persists entries across client instances", async () => {
    const dbPath = tempDbPath();
    const writer = createLocalAphroditeClient({ dbPath });
    const stored = await writer.store(BASH_OUTPUT, "terminal");
    writer.close();

    const reader = createLocalAphroditeClient({ dbPath });
    expect(await reader.retrieve(stored!.hash, {})).toBe(BASH_OUTPUT);
    reader.close();
  });

  test("expires entries past their TTL and counts the purge", async () => {
    const dbPath = tempDbPath();
    const writer = createLocalAphroditeClient({ dbPath, ttlSeconds: 60 });
    const stored = await writer.store(BASH_OUTPUT, "terminal");
    writer.close();

    // Age the entry beyond its 60s TTL.
    const db = new Database(dbPath);
    db.exec("UPDATE ccr SET created_at = created_at - 120");
    db.close();

    // Fresh client: purge is debounced per instance, so its first access
    // sweeps the expired row and the read then misses.
    const reader = createLocalAphroditeClient({ dbPath, ttlSeconds: 60 });
    await expect(reader.retrieve(stored!.hash, {})).rejects.toThrow(
      "CCR entry not found",
    );
    expect(reader.getStatus().purged).toBe(1);
    reader.close();
  });

  test("re-storing the same content refreshes its TTL", async () => {
    const dbPath = tempDbPath();
    const client = createLocalAphroditeClient({ dbPath, ttlSeconds: 60 });
    const stored = await client.store(BASH_OUTPUT, "terminal");

    const db = new Database(dbPath);
    db.exec("UPDATE ccr SET created_at = created_at - 50");
    db.close();

    // Upsert resets created_at to now, so the entry survives the next read.
    const restored = await client.store(BASH_OUTPUT, "terminal");
    expect(restored?.hash).toBe(stored?.hash);
    expect(await client.retrieve(stored!.hash, {})).toBe(BASH_OUTPUT);
    client.close();
  });

  test("ttlSeconds 0 disables expiry", async () => {
    const dbPath = tempDbPath();
    const client = createLocalAphroditeClient({ dbPath, ttlSeconds: 0 });
    const stored = await client.store(BASH_OUTPUT, "terminal");

    const db = new Database(dbPath);
    db.exec("UPDATE ccr SET created_at = created_at - 999999999");
    db.close();

    expect(await client.retrieve(stored!.hash, {})).toBe(BASH_OUTPUT);
    expect(client.getStatus().purged).toBe(0);
    client.close();
  });

  test("migrates a pre-TTL database by stamping legacy rows", async () => {
    const dbPath = tempDbPath();
    const legacy = new Database(dbPath);
    legacy.exec(
      "CREATE TABLE ccr (hash TEXT PRIMARY KEY, content TEXT NOT NULL, original_size INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()))",
    );
    legacy
      .prepare(
        "INSERT INTO ccr (hash, content, original_size, created_at) VALUES (?, ?, ?, unixepoch() - 100)",
      )
      .run("legacyhash0000000", "legacy content", 14);
    legacy.close();

    // Opening with a 60s TTL stamps the legacy row; aged 100s, it is purged
    // on first access and the read misses.
    const client = createLocalAphroditeClient({ dbPath, ttlSeconds: 60 });
    await expect(client.retrieve("legacyhash0000000", {})).rejects.toThrow(
      "CCR entry not found",
    );
    expect(client.getStatus().purged).toBe(1);
    client.close();
  });

  test("marks store unavailable when the database cannot be opened", async () => {
    // A directory path is not a valid SQLite database file.
    const dir = mkdtempSync(join(tmpdir(), "pi-aphrodite-test-"));
    tempDirs.push(dir);
    const client = createLocalAphroditeClient({ dbPath: dir });

    expect(await client.store(BASH_OUTPUT, "terminal")).toBeUndefined();
    expect(await client.store(BASH_OUTPUT, "terminal")).toBeUndefined();

    const status = client.getStatus();
    expect(status.availability).toBe("unavailable");
    expect(status.attempts).toBe(1);
    expect(status.unavailableSkips).toBe(1);
    expect(status.lastFailure).toBe("unavailable");

    client.resetAvailability();
    expect(await client.probe()).toBe("unavailable");
    client.close();
  });
});

describe("registerPiAphrodite", () => {
  test("replaces oversized tool_result content with a CCR marker", async () => {
    const { pi, handlers } = createFakePi();
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    registerPiAphrodite(pi as never, client, { tool: 1024, terminal: 1024 });

    const handler = handlers.get("tool_result");
    expect(handler).toBeDefined();

    const result = (await handler!(
      {
        toolName: "bash",
        content: [{ type: "text", text: BASH_OUTPUT }],
      },
      makeCtx(),
    )) as { content: Array<{ text: string }> } | undefined;

    const text = result?.content[0]?.text ?? "";
    expect(text).toMatch(/<<<CCR:[0-9a-f]{16}\|terminal\|\d+>>>/);
    expect(text).toContain("aphrodite_retrieve");
    expect(text).not.toContain(BASH_OUTPUT);
    client.close();
  });

  test("never compresses aphrodite_retrieve output", async () => {
    const { pi, handlers } = createFakePi();
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    registerPiAphrodite(pi as never, client, { tool: 1024, terminal: 1024 });

    const handler = handlers.get("tool_result");
    const big = "x".repeat(4096);
    const result = await handler!(
      { toolName: "aphrodite_retrieve", content: [{ type: "text", text: big }] },
      makeCtx(),
    );

    expect(result).toBeUndefined();
    expect(client.getStatus().attempts).toBe(0);
    client.close();
  });

  test("leaves small output untouched", async () => {
    const { pi, handlers } = createFakePi();
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    registerPiAphrodite(pi as never, client, { tool: 1024, terminal: 1024 });

    const handler = handlers.get("tool_result");
    const result = await handler!(
      { toolName: "bash", content: [{ type: "text", text: "tiny" }] },
      makeCtx(),
    );

    expect(result).toBeUndefined();
    expect(client.getStatus().attempts).toBe(0);
    client.close();
  });
  test("routes bash output to the terminal threshold, other tools to the tool threshold", async () => {
    const { pi, handlers } = createFakePi();
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    registerPiAphrodite(
      pi as never,
      client,
      { tool: 4096, terminal: 1024 },
      new Set(),
    );

    const handler = handlers.get("tool_result");

    // 2KB bash output: above terminal threshold (1024), below tool (4096).
    const bashResult = (await handler!(
      { toolName: "bash", content: [{ type: "text", text: BASH_OUTPUT }] },
      makeCtx(),
    )) as { content: Array<{ text: string }> } | undefined;
    expect(bashResult?.content[0]?.text).toMatch(/<<<CCR:[0-9a-f]{16}\|/);

    // Same 2KB from a generic tool: below the tool threshold, untouched.
    const fetchResult = await handler!(
      { toolName: "web_fetch", content: [{ type: "text", text: BASH_OUTPUT }] },
      makeCtx(),
    );
    expect(fetchResult).toBeUndefined();
    expect(client.getStatus().stored).toBe(1);
    client.close();
  });

  test("skips tools on the skip list, which contains read by default", async () => {
    delete process.env.APHRODITE_SKIP_TOOLS;
    const { pi, handlers } = createFakePi();
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    registerPiAphrodite(pi as never, client, { tool: 1024, terminal: 1024 });

    const handler = handlers.get("tool_result");
    const result = await handler!(
      { toolName: "read", content: [{ type: "text", text: BASH_OUTPUT }] },
      makeCtx(),
    );

    expect(result).toBeUndefined();
    expect(client.getStatus().attempts).toBe(0);
    client.close();
  });

  test("compresses read output when the skip list is empty", async () => {
    const { pi, handlers } = createFakePi();
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    registerPiAphrodite(
      pi as never,
      client,
      { tool: 1024, terminal: 1024 },
      new Set(),
    );

    const handler = handlers.get("tool_result");
    const result = (await handler!(
      { toolName: "read", content: [{ type: "text", text: BASH_OUTPUT }] },
      makeCtx(),
    )) as { content: Array<{ text: string }> } | undefined;

    expect(result?.content[0]?.text).toMatch(/<<<CCR:[0-9a-f]{16}\|code\|/);
    expect(client.getStatus().stored).toBe(1);
    client.close();
  });

  test("aphrodite_retrieve returns stored content", async () => {
    const { pi, handlers, tools } = createFakePi();
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    registerPiAphrodite(pi as never, client, { tool: 1024, terminal: 1024 });

    const handler = handlers.get("tool_result");
    const result = (await handler!(
      {
        toolName: "bash",
        content: [{ type: "text", text: BASH_OUTPUT }],
      },
      makeCtx(),
    )) as { content: Array<{ text: string }> } | undefined;

    const hash =
      result?.content[0]?.text.match(/<<<CCR:([0-9a-f]{16})\|/)?.[1] ?? "";
    expect(hash).not.toBe("");

    const tool = tools.find((t) => t.name === "aphrodite_retrieve");
    expect(tool).toBeDefined();

    const ok = await tool!.execute("id", { hash });
    expect(ok.content[0]?.text).toBe(BASH_OUTPUT);

    const missing = await tool!.execute("id", { hash: "nope" });
    expect(missing.content[0]?.text).toContain("aphrodite_retrieve failed");
    client.close();
  });

  test("aphrodite_retrieve collapses to one summary line and expands to full text", () => {
    const { pi, tools } = createFakePi();
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    registerPiAphrodite(pi as never, client, { tool: 1024, terminal: 1024 });

    const tool = tools.find((t) => t.name === "aphrodite_retrieve");
    expect(tool?.renderResult).toBeDefined();

    const body = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const theme = { fg: (_color: string, value: string) => value };
    const result = {
      content: [{ type: "text", text: body }],
      details: { hash: "a".repeat(16) },
    };

    const collapsed = tool!.renderResult!(
      result,
      { expanded: false, isPartial: false },
      theme,
      { isError: false },
    );
    expect(collapsed.text).toBe("300L 2.5KB · ctrl+o to expand");
    expect(collapsed.text).not.toContain("line 42");

    const expanded = tool!.renderResult!(
      result,
      { expanded: true, isPartial: false },
      theme,
      { isError: false },
    );
    expect(expanded.text).toContain("line 42");
    client.close();
  });

  test("aphrodite_retrieve renders failures in full while collapsed", () => {
    const { pi, tools } = createFakePi();
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    registerPiAphrodite(pi as never, client, { tool: 1024, terminal: 1024 });

    const tool = tools.find((t) => t.name === "aphrodite_retrieve");
    const rendered = tool!.renderResult!(
      {
        content: [{ type: "text", text: "aphrodite_retrieve failed: nope" }],
        details: { hash: "nope", error: "CCR entry not found: nope" },
      },
      { expanded: false, isPartial: false },
      { fg: (_color: string, value: string) => value },
      { isError: false },
    );

    expect(rendered.text).toBe("aphrodite_retrieve failed: nope");
    client.close();
  });

  test("formatRetrieveResult keeps the collapsed body to a single line", () => {
    const theme = { fg: (_color: string, value: string) => value };
    const collapsed = formatRetrieveResult(
      "a\nb\nc",
      { expanded: false, isError: false },
      theme,
      "hint",
    );

    expect(collapsed.split("\n")).toHaveLength(1);
    expect(collapsed).toBe("3L 5B · hint");
  });

  test("/aphrodite off disables compression; status reports state", async () => {
    const { pi, handlers, commands } = createFakePi();
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    registerPiAphrodite(pi as never, client, { tool: 1024, terminal: 1024 });

    const command = commands.get("aphrodite");
    expect(command).toBeDefined();

    const ctx = makeCtx();
    await command!.handler("off", ctx);
    expect(ctx.notifications.at(-1)).toContain("off");

    const handler = handlers.get("tool_result");
    const result = await handler!(
      {
        toolName: "bash",
        content: [{ type: "text", text: BASH_OUTPUT }],
      },
      ctx,
    );
    expect(result).toBeUndefined();

    await command!.handler("status", ctx);
    expect(ctx.notifications.at(-1)).toContain("aphrodite — state: off");
    client.close();
  });

  test("publishes up state to the footer once the store opens", async () => {
    const { pi, handlers } = createFakePi();
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    registerPiAphrodite(pi as never, client, { tool: 1024, terminal: 1024 });

    const ctx = makeCtx(true);
    await handlers.get("session_start")!({}, ctx);
    // session_start fires an async probe; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const handler = handlers.get("tool_result");
    await handler!(
      { toolName: "bash", content: [{ type: "text", text: BASH_OUTPUT }] },
      ctx,
    );

    const values = ctx.statuses.filter(([key]) => key === "pi-aphrodite").map(([, value]) => value);
    expect(values.length).toBeGreaterThan(0);
    expect(values.at(-1)).toBe("aphrodite");
    client.close();
  });

  test("compresses user_bash output (default on), buffering then emitting once", async () => {
    localExecOutput = BASH_OUTPUT;
    const { pi, handlers } = createFakePi();
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    registerPiAphrodite(pi as never, client, { tool: 1024, terminal: 1024 });

    const handler = handlers.get("user_bash");
    const wrapped = (await handler!(
      { command: "make build", excludeFromContext: false },
      makeCtx(),
    )) as {
      operations: {
        exec: (
          command: string,
          cwd: string,
          options: { onData: (data: Buffer) => void },
        ) => Promise<{ exitCode: number | null }>;
      };
    };

    const received: string[] = [];
    const result = await wrapped.operations.exec("make build", "/tmp", {
      onData: (data: Buffer) => received.push(data.toString()),
    });

    expect(result.exitCode).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatch(/<<<CCR:[0-9a-f]{16}\|terminal\|/);
    expect(received[0]).not.toContain(BASH_OUTPUT);
    client.close();
  });

  test("passes small user_bash output through raw", async () => {
    localExecOutput = "tiny output";
    const { pi, handlers } = createFakePi();
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    registerPiAphrodite(pi as never, client, { tool: 1024, terminal: 1024 });

    const handler = handlers.get("user_bash");
    const wrapped = (await handler!(
      { command: "ls", excludeFromContext: false },
      makeCtx(),
    )) as {
      operations: {
        exec: (
          command: string,
          cwd: string,
          options: { onData: (data: Buffer) => void },
        ) => Promise<{ exitCode: number | null }>;
      };
    };

    const received: string[] = [];
    await wrapped.operations.exec("ls", "/tmp", {
      onData: (data: Buffer) => received.push(data.toString()),
    });

    expect(received.join("")).toBe("tiny output");
    expect(client.getStatus().attempts).toBe(0);
    localExecOutput = BASH_OUTPUT;
    client.close();
  });

  test("skips !! commands and respects /aphrodite bash off", async () => {
    localExecOutput = BASH_OUTPUT;
    const { pi, handlers, commands } = createFakePi();
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    registerPiAphrodite(pi as never, client, { tool: 1024, terminal: 1024 });

    const handler = handlers.get("user_bash");

    // !! never intercepted
    const skipped = await handler!(
      { command: "make build", excludeFromContext: true },
      makeCtx(),
    );
    expect(skipped).toBeUndefined();

    // /aphrodite bash off disables interception
    const ctx = makeCtx();
    await commands.get("aphrodite")!.handler("bash off", ctx);
    expect(ctx.notifications.at(-1)).toContain("user-bash compression off");
    const disabled = await handler!(
      { command: "make build", excludeFromContext: false },
      ctx,
    );
    expect(disabled).toBeUndefined();

    // /aphrodite bash re-enables (toggle)
    await commands.get("aphrodite")!.handler("bash", ctx);
    expect(ctx.notifications.at(-1)).toContain("user-bash compression on");
    client.close();
  });
});

const ENGINE = {
  percent: 45,
  protectFirst: 2,
  protectLast: 5,
  minMessages: 8,
  minBytes: 1024,
};

describe("engineCandidateRange", () => {
  test("protects head and tail, and idles on short conversations", () => {
    // 12 messages, protect 2 + 5 => candidates are indices 2..6 inclusive.
    expect(engineCandidateRange(12, ENGINE)).toEqual({ start: 2, end: 7 });
    // Below minMessages: empty range.
    expect(engineCandidateRange(7, ENGINE)).toEqual({ start: 0, end: 0 });
    // Protected windows overlap: empty range.
    expect(engineCandidateRange(8, { ...ENGINE, protectLast: 6 })).toEqual({
      start: 0,
      end: 0,
    });
  });
});

describe("context engine", () => {
  function makeMessages(): Array<Record<string, unknown>> {
    return Array.from({ length: 12 }, (_value, index) => ({
      role: "toolResult",
      toolName: "read",
      content: [{ type: "text", text: `${index}:${BASH_OUTPUT}` }],
    }));
  }

  test("compresses aged tool results and leaves the protected window verbatim", async () => {
    const { pi, handlers } = createFakePi();
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    registerPiAphrodite(pi as never, client, { tool: 1024, terminal: 1024 }, new Set(["read"]), ENGINE);

    const messages = makeMessages();
    const before = messages.map((m) => JSON.stringify(m.content));
    const result = (await handlers.get("context")!(
      { messages },
      makeCtx(false, 60),
    )) as { messages: Array<Record<string, unknown>> } | undefined;

    expect(result).toBeDefined();
    // Protected head (0,1) and tail (7..11) untouched.
    for (const index of [0, 1, 7, 8, 9, 10, 11]) {
      expect(JSON.stringify(messages[index]!.content)).toBe(before[index]);
    }
    // Candidates 2..6 replaced by markers, despite `read` being on the
    // insertion-time skip list.
    for (const index of [2, 3, 4, 5, 6]) {
      const text = (messages[index]!.content as Array<{ text: string }>)[0]!.text;
      expect(text).toMatch(/<<<CCR:[0-9a-f]{16}\|code\|/);
    }
    expect(client.getStatus().stored).toBe(5);
    client.close();
  });

  test("idles below the trigger percentage and when usage is unknown", async () => {
    const { pi, handlers } = createFakePi();
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    registerPiAphrodite(pi as never, client, { tool: 1024, terminal: 1024 }, new Set(), ENGINE);
    const handler = handlers.get("context")!;

    expect(await handler({ messages: makeMessages() }, makeCtx(false, 20))).toBeUndefined();
    expect(await handler({ messages: makeMessages() }, makeCtx(false, null))).toBeUndefined();
    expect(await handler({ messages: makeMessages() }, makeCtx())).toBeUndefined();
    expect(client.getStatus().attempts).toBe(0);
    client.close();
  });

  test("is idempotent: a second pass re-stores nothing", async () => {
    const { pi, handlers } = createFakePi();
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    registerPiAphrodite(pi as never, client, { tool: 1024, terminal: 1024 }, new Set(), ENGINE);
    const handler = handlers.get("context")!;

    const messages = makeMessages();
    await handler({ messages }, makeCtx(false, 60));
    const afterFirst = messages.map((m) => JSON.stringify(m.content));
    const second = await handler({ messages }, makeCtx(false, 60));

    expect(second).toBeUndefined();
    expect(messages.map((m) => JSON.stringify(m.content))).toEqual(afterFirst);
    expect(client.getStatus().attempts).toBe(5);
    client.close();
  });

  test("skips small results, non-tool-result roles, and stays off at percent 0", async () => {
    const { pi, handlers } = createFakePi();
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    registerPiAphrodite(pi as never, client, { tool: 1024, terminal: 1024 }, new Set(), ENGINE);
    const handler = handlers.get("context")!;

    const messages = makeMessages();
    messages[2] = { role: "assistant", content: [{ type: "text", text: BASH_OUTPUT }] };
    messages[3] = { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "tiny" }] };
    await handler({ messages }, makeCtx(false, 60));

    const assistantText = (messages[2]!.content as Array<{ text: string }>)[0]!
      .text;
    const smallText = (messages[3]!.content as Array<{ text: string }>)[0]!.text;
    expect(assistantText).toBe(BASH_OUTPUT);
    expect(smallText).toBe("tiny");
    expect(client.getStatus().stored).toBe(3);
    client.close();

    const off = createLocalAphroditeClient({ dbPath: tempDbPath() });
    const second = createFakePi();
    registerPiAphrodite(second.pi as never, off, { tool: 1024, terminal: 1024 }, new Set(), {
      ...ENGINE,
      percent: 0,
    });
    expect(
      await second.handlers.get("context")!({ messages: makeMessages() }, makeCtx(false, 90)),
    ).toBeUndefined();
    expect(off.getStatus().attempts).toBe(0);
    off.close();
  });
});
