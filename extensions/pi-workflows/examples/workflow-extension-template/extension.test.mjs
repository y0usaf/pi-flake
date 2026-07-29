import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { beginWorkflowExtensionLoading, loadingRegistry, registeredWorkflowFunctions, registeredWorkflowRoleDirectoryRegistrations, resetWorkflowRegistry, workflowCatalog } from "pi-extensible-workflows";

test("discovers the copied directory as a trusted Pi extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-extension-template-"));
  try {
    const destination = join(root, ".pi", "extensions", "workflow-extension-template");
    await mkdir(join(root, "node_modules"), { recursive: true });
    const packageEntry = fileURLToPath(import.meta.resolve("pi-extensible-workflows"));
    const packageRoot = join(dirname(packageEntry), "..", "..");
    await symlink(packageRoot, join(root, "node_modules", "pi-extensible-workflows"), "dir");
    await cp(dirname(fileURLToPath(import.meta.url)), destination, { recursive: true });
    const result = await discoverAndLoadExtensions([], root, join(root, ".pi", "agent"));
    assert.equal(result.errors.length, 0);
    assert.equal(result.extensions.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  resetWorkflowRegistry();
  const { default: extension } = await import("./index.js");
  beginWorkflowExtensionLoading();
  extension();

  const catalog = workflowCatalog();
  assert.deepEqual(catalog.functions.map(({ name }) => name), ["greet"]);
  assert.deepEqual(catalog.modelAliasEntries?.filter(({ name }) => name === "template-model").map(({ name, kind }) => ({ name, kind })), [{ name: "template-model", kind: "dynamic" }]);
  assert.equal(await registeredWorkflowFunctions().greet.run({ name: "Ada" }, {}), "Hello, Ada!");

  const registration = registeredWorkflowRoleDirectoryRegistrations()[0];
  assert.ok(registration);
  assert.match(readFileSync(join(registration.path, "reviewer.md"), "utf8"), /Packaged reviewer role/);

  const resolved = await loadingRegistry().resolveModelAliases({
    cwd: process.cwd(),
    projectTrusted: true,
    rootModel: { provider: "example", model: "root" },
    knownModels: new Set(["example/root", "example/available"]),
    availableModels: new Set(["example/available"]),
    signal: new AbortController().signal,
  });
  assert.deepEqual(resolved, { "template-model": "example/available" });

  const hook = loadingRegistry().agentSetupHooks().find(({ name }) => name === "templateAdvisor");
  assert.ok(hook);
  const agent = { prompt: "Review this", options: {}, sessionInput: {} };
  await hook.setup(agent, { signal: new AbortController().signal });
  assert.equal(agent.sessionInput.systemPromptAppend, undefined);
  agent.options.templateAdvisor = true;
  await hook.setup(agent, { signal: new AbortController().signal });
  assert.match(agent.sessionInput.systemPromptAppend, /one concrete risk/);
});
