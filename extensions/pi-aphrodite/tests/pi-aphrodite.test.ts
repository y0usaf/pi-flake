import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
}));

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
  registerPiAphrodite,
} = await import("../index.ts");

type TestEvent = Record<string, unknown>;

type TestContext = {
  hasUI: boolean;
  signal?: AbortSignal;
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
};

function makeCtx(hasUI = false): TestContext & {
  notifications: string[];
  statuses: Array<[string, string | undefined]>;
} {
  const notifications: string[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  return {
    hasUI,
    notifications,
    statuses,
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
    registerPiAphrodite(pi as never, client, 1024);

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
    registerPiAphrodite(pi as never, client, 1024);

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
    registerPiAphrodite(pi as never, client, 1024);

    const handler = handlers.get("tool_result");
    const result = await handler!(
      { toolName: "bash", content: [{ type: "text", text: "tiny" }] },
      makeCtx(),
    );

    expect(result).toBeUndefined();
    expect(client.getStatus().attempts).toBe(0);
    client.close();
  });

  test("aphrodite_retrieve returns stored content", async () => {
    const { pi, handlers, tools } = createFakePi();
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    registerPiAphrodite(pi as never, client, 1024);

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

  test("/aphrodite off disables compression; status reports state", async () => {
    const { pi, handlers, commands } = createFakePi();
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    registerPiAphrodite(pi as never, client, 1024);

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
    registerPiAphrodite(pi as never, client, 1024);

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
    expect(values.at(-1)).toBe("aphrodite:on·up");
    client.close();
  });

  test("compresses user_bash output (default on), buffering then emitting once", async () => {
    localExecOutput = BASH_OUTPUT;
    const { pi, handlers } = createFakePi();
    const client = createLocalAphroditeClient({ dbPath: tempDbPath() });
    registerPiAphrodite(pi as never, client, 1024);

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
    registerPiAphrodite(pi as never, client, 1024);

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
    registerPiAphrodite(pi as never, client, 1024);

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
