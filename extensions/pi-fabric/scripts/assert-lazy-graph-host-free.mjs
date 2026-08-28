#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const chunks = join(dist, "chunks");
const hostPackage = "@earendil-works/pi-coding-agent";
const entries = existsSync(chunks)
  ? readdirSync(chunks)
      .filter((file) => /^(dashboard|model-picker)-.*\.js$/.test(file))
      .map((file) => join(chunks, file))
  : [];
if (entries.length === 0) throw new Error("Lazy dashboard chunks were not built");

const importRe = /(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g;
const visited = new Set();
const stack = [...entries];
while (stack.length > 0) {
  const file = stack.pop();
  if (!file || visited.has(file)) continue;
  visited.add(file);
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(importRe)) {
    const specifier = match[1];
    if (specifier?.startsWith(".")) stack.push(resolve(dirname(file), specifier));
  }
}
const offenders = [...visited].filter((file) => {
  const source = readFileSync(file, "utf8");
  return source.includes(`from \"${hostPackage}\"`) || source.includes(`from '${hostPackage}'`);
});
if (offenders.length > 0) {
  throw new Error(
    `Lazy dashboard graph must not import ${hostPackage}:\n${offenders.join("\n")}`,
  );
}
console.log(`lazy dashboard graph is host-package-free (${visited.size} files checked)`);
