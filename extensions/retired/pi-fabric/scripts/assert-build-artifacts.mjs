#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const stable = [
  "index.js",
  "protocol.js",
  "worker.js",
  "residency/host.js",
  "compaction/hook.js",
  "core/action-registry.js",
  "memory/digest.js",
  "memory/search.js",
  "memory/discovery.js",
  "memory/normalize.js",
  "providers/memory-provider.js",
];
const declarations = stable.map((file) => file.replace(/\.js$/, ".d.ts"));
const required = [
  ...stable,
  ...stable.map((file) => `${file}.map`),
  ...declarations,
  ...declarations.map((file) => `${file}.map`),
];
const missing = required.filter((file) => !existsSync(join(dist, file)));
if (missing.length > 0) throw new Error(`Missing build artifacts:\n${missing.join("\n")}`);

const chunks = join(dist, "chunks");
const chunkFiles = existsSync(chunks)
  ? readdirSync(chunks).filter((file) => file.endsWith(".js"))
  : [];
if (chunkFiles.length === 0) throw new Error("Build did not produce dynamic chunks");
for (const chunk of chunkFiles) {
  if (!existsSync(join(chunks, `${chunk}.map`))) {
    throw new Error(`Missing source map for chunk ${chunk}`);
  }
}

const staticImport = /(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g;
const visited = new Set();
const stack = [join(dist, "index.js")];
while (stack.length > 0) {
  const file = stack.pop();
  if (!file || visited.has(file)) continue;
  visited.add(file);
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(staticImport)) {
    const specifier = match[1];
    if (specifier?.startsWith(".")) stack.push(resolve(dirname(file), specifier));
  }
}
const initialSource = [...visited].map((file) => readFileSync(file, "utf8")).join("\n");
for (const forbidden of ["src/fabric-runtime-state.ts", "src/ui/settings.ts", 'from "mcporter"']) {
  if (initialSource.includes(forbidden)) {
    throw new Error(`Startup static graph contains lazy module marker: ${forbidden}`);
  }
}
const allChunks = chunkFiles.map((file) => readFileSync(join(chunks, file), "utf8")).join("\n");
for (const expected of ["src/fabric-runtime-state.ts", "src/ui/settings.ts", 'import("mcporter")']) {
  if (!allChunks.includes(expected)) throw new Error(`Expected lazy chunk marker not found: ${expected}`);
}

for (const file of stable) {
  const checked = spawnSync(process.execPath, ["--check", join(dist, file)], { encoding: "utf8" });
  if (checked.status !== 0) throw new Error(checked.stderr || `Syntax check failed: ${file}`);
}
await Promise.all(
  stable.filter((file) => file !== "worker.js").map((file) =>
    import(new URL(`../dist/${file}`, import.meta.url)),
  ),
);
console.log(`build artifacts and lazy startup graph verified (${visited.size} startup files, ${chunkFiles.length} chunks)`);
