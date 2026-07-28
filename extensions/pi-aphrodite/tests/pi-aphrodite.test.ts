import { describe, expect, mock, test } from "bun:test";

const BASH_OUTPUT = "line one of output\n" + "x".repeat(2048);

mock.module("@earendil-works/pi-coding-agent", () => ({
  createLocalBashOperations: () => ({
    exec: async () => ({
      output: BASH_OUTPUT,
      exitCode: 0,
      cancelled: false,
      truncated: false,
    }),
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
  createAphroditeClient,
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

type FetchHandler = (
  url: string,
  init: { method?: string; body?: string },
) => { status?: number; json?: unknown };

function makeFetch(handler: FetchHandler): typeof fetch {
  const impl = async (url: string | URL, init?: RequestInit) => {
    const result = handler(String(url), {
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(JSON.stringify(result.json ?? {}), {
      status: result.status ?? 200,
    });
  };
  return impl as unknown as typeof fetch;
}

function failingFetch(): typeof fetch {
  const impl = async () => {
    throw new TypeError("fetch failed");
  };
  return impl as unknown as typeof fetch;
}

function makeCtx(): TestContext & { notifications: string[] } {
  const notifications: string[] = [];
  return {
    hasUI: false,
    notifications,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      setStatus() {},
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

const HASH = "0123456789abcdef0123456789abcdef01234567";

function storeFetch(): ReturnType<typeof makeFetch> {
  return makeFetch((url) => {
    if (url.endsWith("/ccr/create")) {
      return {
        json: {
          hash: HASH,
          token_savings_ratio: 12.5,
          original_size: BASH_OUTPUT.length,
          compressed_size: 400,
          marker_size: 60,
        },
      };
    }
    if (url.endsWith("/ccr/list")) {
      return { json: { entries: 1, backend: "sqlite", mode: "token" } };
    }
    return { status: 404, json: {} };
  });
}

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

describe("createAphroditeClient", () => {
  test("stores content and tracks counters", async () => {
    const client = createAphroditeClient({ fetchImpl: storeFetch() });
    const stored = await client.store(BASH_OUTPUT);

    expect(stored?.hash).toBe(HASH);
    expect(client.getStatus()).toMatchObject({
      availability: "available",
      stored: 1,
      attempts: 1,
      originalBytes: BASH_OUTPUT.length,
    });
  });

  test("marks proxy unavailable on network failure and skips retries", async () => {
    const client = createAphroditeClient({ fetchImpl: failingFetch() });

    expect(await client.store(BASH_OUTPUT)).toBeUndefined();
    expect(await client.store(BASH_OUTPUT)).toBeUndefined();

    const status = client.getStatus();
    expect(status.availability).toBe("unavailable");
    expect(status.attempts).toBe(1);
    expect(status.unavailableSkips).toBe(1);
    expect(status.lastFailure).toBe("unavailable");
  });

  test("treats HTTP 503 as CCR disabled (unavailable)", async () => {
    const client = createAphroditeClient({
      fetchImpl: makeFetch(() => ({ status: 503, json: { error: "off" } })),
    });

    expect(await client.store(BASH_OUTPUT)).toBeUndefined();
    expect(client.getStatus().availability).toBe("unavailable");
  });
});

describe("registerPiAphrodite", () => {
  test("replaces oversized tool_result content with a CCR marker", async () => {
    const { pi, handlers } = createFakePi();
    const client = createAphroditeClient({ fetchImpl: storeFetch() });
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
    expect(text).toContain(`<<<CCR:${HASH}|terminal|`);
    expect(text).toContain("aphrodite_retrieve");
    expect(text).not.toContain(BASH_OUTPUT);
  });

  test("leaves small output untouched", async () => {
    const { pi, handlers } = createFakePi();
    const client = createAphroditeClient({ fetchImpl: storeFetch() });
    registerPiAphrodite(pi as never, client, 1024);

    const handler = handlers.get("tool_result");
    const result = await handler!(
      { toolName: "bash", content: [{ type: "text", text: "tiny" }] },
      makeCtx(),
    );

    expect(result).toBeUndefined();
    expect(client.getStatus().attempts).toBe(0);
  });

  test("passes through when the proxy is down", async () => {
    const { pi, handlers } = createFakePi();
    const client = createAphroditeClient({ fetchImpl: failingFetch() });
    registerPiAphrodite(pi as never, client, 1024);

    const handler = handlers.get("tool_result");
    const result = await handler!(
      {
        toolName: "bash",
        content: [{ type: "text", text: BASH_OUTPUT }],
      },
      makeCtx(),
    );

    expect(result).toBeUndefined();
  });

  test("aphrodite_retrieve returns stored content", async () => {
    const { pi, tools } = createFakePi();
    const client = createAphroditeClient({
      fetchImpl: makeFetch((url, init) => {
        if (url.endsWith("/retrieve")) {
          const body = JSON.parse(init.body ?? "{}") as { hash?: string };
          return body.hash === HASH
            ? {
                json: {
                  found: true,
                  content: BASH_OUTPUT,
                  source: "ccr",
                  truncated: false,
                },
              }
            : {
                status: 404,
                json: { found: false, error: "CCR entry not found" },
              };
        }
        return { json: {} };
      }),
    });
    registerPiAphrodite(pi as never, client, 1024);

    const tool = tools.find((t) => t.name === "aphrodite_retrieve");
    expect(tool).toBeDefined();

    const ok = await tool!.execute("id", { hash: HASH });
    expect(ok.content[0]?.text).toBe(BASH_OUTPUT);

    const missing = await tool!.execute("id", { hash: "nope" });
    expect(missing.content[0]?.text).toContain("aphrodite_retrieve failed");
  });

  test("/aphrodite off disables compression; status reports state", async () => {
    const { pi, handlers, commands } = createFakePi();
    const client = createAphroditeClient({ fetchImpl: storeFetch() });
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
  });
});
