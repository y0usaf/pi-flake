import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const localExecCalls: Array<{
  command: string;
  cwd: string;
  options: unknown;
}> = [];

mock.module("@earendil-works/pi-coding-agent", () => ({
  createLocalBashOperations: () => ({
    exec: async (command: string, cwd: string, options: unknown) => {
      localExecCalls.push({ command, cwd, options });
      return { output: "", exitCode: 0, cancelled: false, truncated: false };
    },
  }),
  isToolCallEventType: (toolName: string, event: { toolName: string }) =>
    event.toolName === toolName,
}));

const { createRtkRewriter, registerPiRtk } = await import("../index.ts");

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
  getArgumentCompletions?: (
    prefix: string,
  ) => Array<{ value: string; label: string }> | null;
  handler(args: string, ctx: TestContext): Promise<void>;
};

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-rtk-"));
  tempDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFakeRtk(dir: string): { command: string; log: string } {
  const command = join(dir, "rtk");
  const log = join(dir, "rtk.log");
  writeFileSync(
    command,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'rtk test\\n'
  exit 0
fi
if [ "$1" != "rewrite" ]; then
  exit 64
fi
printf '%s\\n' "$2" >> "\${RTK_LOG:-/dev/null}"
case "$2" in
  empty)
    exit 1
    ;;
  same)
    printf 'same\\n'
    exit 0
    ;;
  slow)
    sleep 1
    printf 'rtk slow\\n'
    exit 3
    ;;
  timeout)
    sleep 1
    ;;
  fail)
    exit 42
    ;;
  0)
    printf 'rtk ls -la\\n'
    exit 0
    ;;
  3)
    printf 'rtk ls -la\\n'
    exit 3
    ;;
  sudo)
    printf 'sudo rtk ls -la\\n'
    exit 3
    ;;
  malicious)
    printf 'rtk-malicious ls\\n'
    exit 3
    ;;
  pwned)
    printf 'echo pwned\\n'
    exit 3
    ;;
  two-line)
    printf 'rtk ls\\nsecond\\n'
    exit 3
    ;;
  control)
    printf 'rtk ls\\033[31m\\n'
    exit 3
    ;;
  run)
    printf 'rtk run sh -c x\\n'
    exit 3
    ;;
  find)
    printf 'rtk find . -name "*.ts"\\n'
    exit 3
    ;;
  sudo-find)
    printf 'sudo rtk find . -name "*.ts"\\n'
    exit 3
    ;;
  long)
    printf 'rtk'
    i=0
    while [ "$i" -lt 1100 ]; do printf 'x'; i=$((i + 1)); done
    printf '\\n'
    exit 3
    ;;
  *)
    printf 'rtk %s\\n' "$2"
    exit 3
    ;;
esac
`,
  );
  chmodSync(command, 0o755);
  process.env.RTK_LOG = log;
  return { command, log };
}

function readLog(log: string): string[] {
  if (!existsSync(log)) {
    return [];
  }

  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
}

function createFakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, FakeCommand>();

  return {
    handlers,
    commands,
    pi: {
      on(event: string, handler: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerCommand(name: string, command: FakeCommand) {
        commands.set(name, command);
      },
    },
  };
}

function createCtx() {
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];

  return {
    notifications,
    statuses,
    ctx: {
      hasUI: true,
      signal: undefined,
      ui: {
        theme: {
          fg(color: string, value: string) {
            return `<${color}>${value}</${color}>`;
          },
        },
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        setStatus(key: string, value: string | undefined) {
          statuses.push({ key, value });
        },
      },
    },
  };
}

function getHandler(
  fake: ReturnType<typeof createFakePi>,
  event: string,
): Handler {
  const handler = fake.handlers.get(event)?.[0];
  if (!handler) {
    throw new Error(`missing ${event} handler`);
  }

  return handler;
}

function getCommand(
  fake: ReturnType<typeof createFakePi>,
  name: string,
): FakeCommand {
  const command = fake.commands.get(name);
  if (!command) {
    throw new Error(`missing /${name} command`);
  }

  return command;
}
function register(
  fake: ReturnType<typeof createFakePi>,
  command: string,
  timeoutMs = 100,
) {
  const rewriter = createRtkRewriter({
    command,
    timeoutMs,
    probeTimeoutMs: timeoutMs,
  });
  registerPiRtk(
    fake.pi as unknown as Parameters<typeof registerPiRtk>[0],
    rewriter,
  );
  return rewriter;
}

afterEach(() => {
  localExecCalls.length = 0;
  delete process.env.RTK_LOG;

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

describe("pi-rtk extension wiring", () => {
  test("agent bash rewrite is async and mutates the bash command", async () => {
    const dir = makeTempDir();
    const { command } = writeFakeRtk(dir);
    const fake = createFakePi();
    register(fake, command, 2000);
    const { ctx } = createCtx();
    const event = {
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "slow" },
    };

    const started = performance.now();
    const pending = getHandler(fake, "tool_call")(event, ctx);
    expect(performance.now() - started).toBeLessThan(100);
    await pending;

    expect(event.input.command).toBe("rtk slow");
  });

  test("disabling during a pending rewrite prevents bash mutation", async () => {
    const dir = makeTempDir();
    const { command } = writeFakeRtk(dir);
    const fake = createFakePi();
    register(fake, command, 2000);
    const { ctx } = createCtx();
    const event = {
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "slow" },
    };

    const pending = getHandler(fake, "tool_call")(event, ctx);
    await getCommand(fake, "rtk").handler("off", ctx);
    await pending;

    expect(event.input.command).toBe("slow");
  });

  test("disabled state passes agent and user commands through without invoking rtk", async () => {
    const dir = makeTempDir();
    const { command, log } = writeFakeRtk(dir);
    const fake = createFakePi();
    register(fake, command);
    const { ctx, notifications, statuses } = createCtx();

    await getCommand(fake, "rtk").handler("off", ctx);

    const toolEvent = {
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "echo agent" },
    };
    await getHandler(fake, "tool_call")(toolEvent, ctx);
    const userResult = await getHandler(fake, "user_bash")(
      {
        type: "user_bash",
        command: "echo user",
        excludeFromContext: false,
        cwd: dir,
      },
      ctx,
    );

    expect(toolEvent.input.command).toBe("echo agent");
    expect(userResult).toBeUndefined();
    expect(readLog(log)).toEqual([]);
    expect(notifications).toEqual([{ message: "rtk off", level: "warning" }]);
    expect(statuses).toEqual([{ key: "pi-rtk", value: "<muted>rtk</muted>" }]);
  });

  test("!<cmd> executes the rewritten command through Pi local bash operations", async () => {
    const dir = makeTempDir();
    const { command } = writeFakeRtk(dir);
    const fake = createFakePi();
    register(fake, command);
    const { ctx } = createCtx();

    const result = (await getHandler(fake, "user_bash")(
      {
        type: "user_bash",
        command: "echo user",
        excludeFromContext: false,
        cwd: dir,
      },
      ctx,
    )) as
      | {
          operations?: {
            exec(command: string, cwd: string, options: unknown): unknown;
          };
        }
      | undefined;

    if (!result?.operations) {
      throw new Error("missing user_bash operations");
    }

    await result.operations.exec("echo user", dir, { timeout: 1 });
    expect(localExecCalls).toEqual([
      { command: "rtk echo user", cwd: dir, options: { timeout: 1 } },
    ]);
  });

  test("!!<cmd> bypasses rtk", async () => {
    const dir = makeTempDir();
    const { command, log } = writeFakeRtk(dir);
    const fake = createFakePi();
    register(fake, command);
    const { ctx } = createCtx();

    const result = await getHandler(fake, "user_bash")(
      {
        type: "user_bash",
        command: "echo hidden",
        excludeFromContext: true,
        cwd: dir,
      },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(readLog(log)).toEqual([]);
  });

  test("/rtk toggles state and /rtk status reports sanitized runtime state", async () => {
    const dir = makeTempDir();
    const { command } = writeFakeRtk(dir);
    const fake = createFakePi();
    register(fake, command);
    const { ctx, notifications, statuses } = createCtx();
    const rtkCommand = getCommand(fake, "rtk");

    await rtkCommand.handler("", ctx);
    await rtkCommand.handler("", ctx);
    await rtkCommand.handler("status", ctx);

    expect(notifications[0]).toEqual({ message: "rtk off", level: "warning" });
    expect(notifications[1]).toEqual({ message: "rtk on", level: "info" });
    expect(notifications[2]?.level).toBe("info");
    expect(notifications[2]?.message).toContain("state: on");
    expect(notifications[2]?.message).toContain("binary: available");
    expect(notifications[2]?.message).toContain("rewrites: 0/0");
    expect(notifications[2]?.message).not.toContain("echo");
    expect(statuses.map((status) => status.value)).toEqual([
      "<muted>rtk</muted>",
      "<success>rtk</success>",
    ]);

    expect(rtkCommand.getArgumentCompletions?.("s")).toEqual([
      { value: "status", label: "status" },
    ]);
  });

  test("invalid /rtk arguments show usage", async () => {
    const dir = makeTempDir();
    const { command } = writeFakeRtk(dir);
    const fake = createFakePi();
    register(fake, command);
    const { ctx, notifications } = createCtx();

    await getCommand(fake, "rtk").handler("wat", ctx);

    expect(notifications).toEqual([
      { message: "Usage: /rtk [on|off|status]", level: "warning" },
    ]);
  });
});

describe("rtk rewriter", () => {
  test("exit 1 means no rewrite without counting as a failure", async () => {
    const dir = makeTempDir();
    const { command } = writeFakeRtk(dir);
    const rewriter = createRtkRewriter({ command, timeoutMs: 100 });

    expect(await rewriter.rewrite("empty")).toBeUndefined();

    expect(rewriter.getStatus()).toMatchObject({
      availability: "available",
      attempts: 1,
      applied: 0,
      empty: 1,
      failures: 0,
      lastFailure: undefined,
    });
  });

  test("identical rewrites fall back without counting as failures", async () => {
    const dir = makeTempDir();
    const { command } = writeFakeRtk(dir);
    const rewriter = createRtkRewriter({ command, timeoutMs: 100 });

    expect(await rewriter.rewrite("same")).toBeUndefined();

    expect(rewriter.getStatus()).toMatchObject({
      availability: "available",
      attempts: 1,
      applied: 0,
      empty: 0,
      unchanged: 1,
      failures: 0,
      lastFailure: undefined,
    });
  });

  test("exit 3 and exit 0 rewrites apply", async () => {
    const dir = makeTempDir();
    const { command } = writeFakeRtk(dir);
    const rewriter = createRtkRewriter({ command, timeoutMs: 100 });

    expect(await rewriter.rewrite("3")).toBe("rtk ls -la");
    expect(await rewriter.rewrite("0")).toBe("rtk ls -la");
    expect(await rewriter.rewrite("sudo")).toBe("sudo rtk ls -la");
    expect(rewriter.getStatus()).toMatchObject({ applied: 3, failures: 0 });
  });

  test("guard rejects unsafe rewrites without failures", async () => {
    const dir = makeTempDir();
    const { command } = writeFakeRtk(dir);
    const rewriter = createRtkRewriter({ command, timeoutMs: 100 });

    for (const input of ["pwned", "malicious", "two-line", "control", "run", "long"]) {
      expect(await rewriter.rewrite(input)).toBeUndefined();
    }
    expect(rewriter.getStatus()).toMatchObject({ rejected: 6, failures: 0 });
  });

  test("status reports rejected rewrites", async () => {
    const dir = makeTempDir();
    const { command } = writeFakeRtk(dir);
    const fake = createFakePi();
    register(fake, command);
    const { ctx, notifications } = createCtx();

    await getHandler(fake, "tool_call")(
      { type: "tool_call", toolName: "bash", input: { command: "pwned" } },
      ctx,
    );
    await getCommand(fake, "rtk").handler("status", ctx);

    expect(notifications.at(-1)?.message).toContain("rejected: 1");
  });

  test("find rewrites are rejected", async () => {
    const dir = makeTempDir();
    const { command } = writeFakeRtk(dir);
    const rewriter = createRtkRewriter({ command, timeoutMs: 100 });

    expect(await rewriter.rewrite("find . -name '*.ts'")).toBeUndefined();
    expect(await rewriter.rewrite("sudo find . -name '*.ts'")).toBeUndefined();
    expect(rewriter.getStatus()).toMatchObject({ rejected: 2, failures: 0 });
  });

  test("non-zero rewrite exits fall back", async () => {
    const dir = makeTempDir();
    const { command } = writeFakeRtk(dir);
    const rewriter = createRtkRewriter({ command, timeoutMs: 100 });

    expect(await rewriter.rewrite("fail")).toBeUndefined();
    expect(rewriter.getStatus()).toMatchObject({
      availability: "available",
      attempts: 1,
      applied: 0,
      failures: 1,
      lastFailure: "failed",
    });
  });

  test("missing binary falls back and negative-caches until availability reset", async () => {
    const dir = makeTempDir();
    const rewriter = createRtkRewriter({
      command: join(dir, "missing-rtk"),
      timeoutMs: 100,
    });

    expect(await rewriter.rewrite("echo one")).toBeUndefined();
    expect(await rewriter.rewrite("echo two")).toBeUndefined();
    expect(rewriter.getStatus()).toMatchObject({
      availability: "unavailable",
      attempts: 1,
      failures: 1,
      unavailableSkips: 1,
      lastFailure: "unavailable",
    });

    rewriter.resetAvailability();
    expect(await rewriter.rewrite("echo three")).toBeUndefined();
    expect(rewriter.getStatus()).toMatchObject({
      attempts: 2,
      unavailableSkips: 1,
    });
  });

  test("timeout falls back without blocking for the full child lifetime", async () => {
    const dir = makeTempDir();
    const { command } = writeFakeRtk(dir);
    const rewriter = createRtkRewriter({ command, timeoutMs: 50 });

    const started = performance.now();
    expect(await rewriter.rewrite("timeout")).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(500);
    expect(rewriter.getStatus()).toMatchObject({
      availability: "available",
      attempts: 1,
      failures: 1,
      lastFailure: "timeout",
    });
  });

  test("abort signal cancels rewrite and falls back", async () => {
    const dir = makeTempDir();
    const { command } = writeFakeRtk(dir);
    const rewriter = createRtkRewriter({ command, timeoutMs: 2000 });
    const controller = new AbortController();

    const pending = rewriter.rewrite("timeout", controller.signal);
    setTimeout(() => controller.abort(), 10);

    expect(await pending).toBeUndefined();
    expect(rewriter.getStatus()).toMatchObject({
      attempts: 1,
      failures: 1,
      lastFailure: "aborted",
    });
  });

  test("parallel rewrites are independent", async () => {
    const dir = makeTempDir();
    const { command } = writeFakeRtk(dir);
    const rewriter = createRtkRewriter({ command, timeoutMs: 100 });

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) => rewriter.rewrite(`cmd-${index}`)),
    );

    expect(results).toEqual(
      Array.from({ length: 5 }, (_, index) => `rtk cmd-${index}`),
    );
    expect(rewriter.getStatus()).toMatchObject({
      attempts: 5,
      applied: 5,
      failures: 0,
    });
  });
});
