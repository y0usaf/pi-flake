import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const markdownFiles = [
  path.join(root, "README.md"),
  ...fs.readdirSync(path.join(root, "docs"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(root, "docs", name)),
].sort();

const rules = [
  { name: "em dash", pattern: /—/u },
  {
    name: "filler intensifier",
    pattern: /\b(?:genuinely|really|truly|actually)\b/iu,
  },
  {
    name: "corporate-register verb",
    pattern: /\b(?:leverage|leverages|leveraged|leveraging|underscore|underscores|underscored|underscoring|reflect|reflects|reflected|reflecting)\b/iu,
  },
  {
    name: "rhetorical transition",
    pattern: /\b(?:rather than|instead of|however|nevertheless|nonetheless|on the other hand|in short|in summary|to summarize|note that|it is important|of course|not only|but also|by contrast|in contrast|as opposed to|even so|altogether|ultimately|obviously|clearly)\b/iu,
  },
  {
    name: "direct antithesis",
    pattern: /\b(?:not|no)\b[^.\n]{0,120}\bbut\b/iu,
  },
] as const;

describe("documentation writing style", () => {
  for (const file of markdownFiles) {
    const relative = path.relative(root, file);
    const source = fs.readFileSync(file, "utf8");
    for (const rule of rules) {
      it(`${relative} passes the ${rule.name} check`, () => {
        expect(source.match(rule.pattern)?.[0]).toBeUndefined();
      });
    }
  }
});
