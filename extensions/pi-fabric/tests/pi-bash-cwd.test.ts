import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { afterAll, describe, expect, it } from "vitest";
import {
  BashCwdDefinitions,
  resolveBashCwdArgument,
  resolvePiBashCwd,
  withBashCwdSchema,
} from "../src/providers/pi-bash-cwd.js";

const roots: string[] = [];

const makeTree = (): { root: string; nested: string } => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-cwd-")));
  roots.push(root);
  const nested = path.join(root, "services", "link");
  fs.mkdirSync(nested, { recursive: true });
  return { root, nested };
};

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("resolvePiBashCwd", () => {
  it("resolves a relative path against the session cwd", () => {
    const { root, nested } = makeTree();
    expect(resolvePiBashCwd(root, "services/link")).toBe(nested);
  });

  it("accepts an absolute path outside the session cwd", () => {
    const { root } = makeTree();
    const { nested: elsewhere } = makeTree();
    expect(resolvePiBashCwd(root, elsewhere)).toBe(elsewhere);
  });

  it("normalizes parent traversal without rejecting it", () => {
    const { root, nested } = makeTree();
    expect(resolvePiBashCwd(nested, "../..")).toBe(root);
  });

  // Worktree paths are frequently symlinks. Keep the requested lexical path
  // available to Fabric's audit/approval surfaces; the spawned shell may still
  // report the physical target from `pwd`, so this is not a logical-PWD guarantee.
  it("preserves a symlinked directory instead of canonicalizing it", () => {
    const { root, nested } = makeTree();
    const link = path.join(root, "worktree-link");
    fs.symlinkSync(nested, link, "dir");
    expect(resolvePiBashCwd(root, "worktree-link")).toBe(link);
    expect(resolvePiBashCwd(root, "worktree-link")).not.toBe(nested);
  });

  it("executes through a symlink without promising the shell's pwd spelling", async () => {
    const { root, nested } = makeTree();
    const link = path.join(root, "worktree-link");
    fs.symlinkSync(nested, link, "dir");
    const result = await new BashCwdDefinitions().get(link).execute(
      "pi-bash-cwd-symlink-test",
      { command: "pwd" },
      undefined,
      () => {},
      undefined as never,
    );
    const reported = (result.content[0] as { text: string }).text.trim();
    expect(fs.realpathSync(reported)).toBe(fs.realpathSync(link));
  });

  it("names the resolved path when the directory is missing", () => {
    const { root } = makeTree();
    expect(() => resolvePiBashCwd(root, "nope")).toThrowError(
      new RegExp(`Invalid pi\\.bash cwd "nope" \\(${root}/nope\\)`),
    );
  });

  it("rejects a file", () => {
    const { root } = makeTree();
    const file = path.join(root, "README.md");
    fs.writeFileSync(file, "test\n");
    expect(() => resolvePiBashCwd(root, file)).toThrowError(/path is not a directory/);
  });

  it("rejects an empty or non-string path", () => {
    const { root } = makeTree();
    expect(() => resolvePiBashCwd(root, "   ")).toThrowError(/must be a non-empty string/);
    expect(() => resolvePiBashCwd(root, 5)).toThrowError(/must be a non-empty string/);
    expect(() => resolvePiBashCwd(root, undefined)).toThrowError(/must be a non-empty string/);
  });
});

describe("resolveBashCwdArgument", () => {
  it("returns the same object when no cwd is present", () => {
    const { root } = makeTree();
    const args = { command: "pwd" };
    expect(resolveBashCwdArgument(root, args)).toBe(args);
  });

  it("rewrites cwd in place and leaves other arguments untouched", () => {
    const { root, nested } = makeTree();
    expect(resolveBashCwdArgument(root, { command: "pwd", timeout: 5, cwd: "services/link" }))
      .toEqual({ command: "pwd", timeout: 5, cwd: nested });
  });

  it("fails before execution when the directory is unusable", () => {
    const { root } = makeTree();
    expect(() => resolveBashCwdArgument(root, { command: "pwd", cwd: "nope" })).toThrow();
  });
});

describe("withBashCwdSchema", () => {
  const schema = withBashCwdSchema(
    createBashToolDefinition("/").parameters,
  ) as Record<string, unknown>;

  it("declares cwd on the descriptor", () => {
    expect(Object.keys((schema as { properties: object }).properties)).toContain("cwd");
  });

  it("stays a working TypeBox schema", () => {
    expect(Value.Check(schema, { command: "pwd" })).toBe(true);
    expect(Value.Check(schema, { command: "pwd", cwd: "/tmp" })).toBe(true);
    expect(Value.Check(schema, { command: "pwd", cwd: 5 })).toBe(false);
    expect(Value.Check(schema, { cwd: "/tmp" })).toBe(false);
  });

  it("is idempotent", () => {
    expect(withBashCwdSchema(schema)).toBe(schema);
  });
});

describe("BashCwdDefinitions", () => {
  it("reuses the definition for a repeated directory", () => {
    const definitions = new BashCwdDefinitions();
    expect(definitions.get("/tmp")).toBe(definitions.get("/tmp"));
  });

  it("keeps distinct directories distinct", () => {
    const definitions = new BashCwdDefinitions();
    expect(definitions.get("/tmp")).not.toBe(definitions.get("/"));
  });

  // The whole point of binding a definition: the factory argument is what
  // reaches spawn context and then the shell backend.
  it("runs the command in the bound directory", async () => {
    const { nested } = makeTree();
    const definitions = new BashCwdDefinitions();
    const result = await definitions.get(nested).execute(
      "pi-bash-cwd-test",
      { command: "pwd" },
      undefined,
      () => {},
      undefined as never,
    );
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(nested) });
  });

  // Guards the regression this change exists to prevent: declaring cwd in the
  // guest types without honoring it would turn a type rejection into a command
  // silently running in the session directory.
  it("is required — pi's stock definition ignores a cwd argument", async () => {
    const { root, nested } = makeTree();
    const result = await createBashToolDefinition(root).execute(
      "pi-bash-cwd-test",
      { command: "pwd", cwd: nested } as never,
      undefined,
      () => {},
      undefined as never,
    );
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(root) });
    expect((result.content[0] as { text: string }).text).not.toContain(nested);
  });
});
