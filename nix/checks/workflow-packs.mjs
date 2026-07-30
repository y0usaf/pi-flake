// Static gate for the workflow packs in workflows/.
//
// Packs ship as raw .js that a consuming system flake copies into
// <agentDir>/workflows/<dir>/, so nothing compiles them and biome cannot lint
// them: the engine evaluates each file as an async *function body*, which makes
// top-level `return` and top-level `await` legal there and a parse error
// everywhere else. This check parses them the way the engine does and validates
// each command.json against the fields host.ts actually reads.
//
// Usage: node workflow-packs.mjs <workflows-dir>

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: node workflow-packs.mjs <workflows-dir>");
  process.exit(2);
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
// The engine's script scope (src/execution.ts). Declaring them makes an
// accidental reference to a non-existent primitive a parse-time failure here
// instead of a runtime failure mid-run.
const SCOPE = ["args", "agent", "phase", "shell", "checkpoint", "prompt", "parallel", "pipeline", "log", "withWorktree"];
const QUESTION_KEYS = ["key", "prompt", "options", "free", "placeholder"];
const SPEC_KEYS = ["name", "description", "script", "args", "argKey", "sessionContext", "questions"];

const failures = [];
const fail = (dir, message) => failures.push(`${dir}: ${message}`);

const dirs = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (!dirs.length) fail(root, "no pack directories found");

for (const dir of dirs) {
  const packPath = join(root, dir);
  const specPath = join(packPath, "command.json");

  let spec;
  try {
    spec = JSON.parse(readFileSync(specPath, "utf8"));
  } catch (error) {
    fail(dir, `command.json is unreadable or invalid JSON: ${error.message}`);
    continue;
  }

  for (const key of Object.keys(spec)) if (!SPEC_KEYS.includes(key)) fail(dir, `command.json has unknown field ${key}`);
  if (typeof spec.name !== "string" || !spec.name.trim()) fail(dir, "command.json name must be a non-empty string");
  if (typeof spec.script !== "string" || !spec.script.trim()) fail(dir, "command.json script must name the entry file");
  if (spec.argKey !== undefined && typeof spec.argKey !== "string") fail(dir, "command.json argKey must be a string");

  if (spec.questions !== undefined) {
    if (!Array.isArray(spec.questions) || spec.questions.length === 0) {
      fail(dir, "command.json questions must be a non-empty array");
    } else {
      spec.questions.forEach((question, index) => {
        const at = `questions[${index}]`;
        if (typeof question !== "object" || question === null || Array.isArray(question)) return fail(dir, `${at} must be an object`);
        for (const key of Object.keys(question)) if (!QUESTION_KEYS.includes(key)) fail(dir, `${at} has unknown field ${key}`);
        if (typeof question.key !== "string" || !/^[A-Za-z_$][\w$]*$/.test(question.key)) fail(dir, `${at}.key must be an identifier`);
        if (typeof question.prompt !== "string" || !question.prompt.trim()) fail(dir, `${at}.prompt must be a non-empty string`);
        if (question.options !== undefined && (!Array.isArray(question.options) || question.options.length === 0 || question.options.some((option) => typeof option !== "string" || !option.trim()))) {
          fail(dir, `${at}.options must be a non-empty array of non-empty strings`);
        }
        if (question.free !== undefined && typeof question.free !== "boolean") fail(dir, `${at}.free must be a boolean`);
        if (question.placeholder !== undefined && (typeof question.placeholder !== "string" || !question.placeholder.trim())) fail(dir, `${at}.placeholder must be a non-empty string`);
        if (question.options === undefined && question.free !== true) fail(dir, `${at} would be unanswerable: give options, free: true, or both`);
      });
    }
  }

  if (typeof spec.script !== "string") continue;
  const scriptPath = join(packPath, spec.script);
  let source;
  try {
    statSync(scriptPath);
    source = readFileSync(scriptPath, "utf8");
  } catch {
    fail(dir, `script ${spec.script} is missing`);
    continue;
  }

  try {
    new AsyncFunction(...SCOPE, source);
  } catch (error) {
    fail(dir, `${spec.script} does not parse as a workflow body: ${error.message}`);
    continue;
  }

  // Engine constraint (src/execution.ts:675): a checkpoint name must be a static
  // string, so `name: "retry-" + i` fails only once the run reaches it. The rule
  // enforced here is narrower and mechanical: `name` is the first field of the
  // checkpoint object and its value is a quoted literal.
  for (const opening of source.matchAll(/checkpoint\(\s*\{/g)) {
    const rest = source.slice(opening.index + opening[0].length, opening.index + opening[0].length + 120);
    if (!/^\s*name\s*:\s*["'`][^"'`]+["'`]/.test(rest)) fail(dir, `${spec.script} checkpoint at offset ${opening.index} must open with a literal name field`);
  }
  // No imports, filesystem, network, process or timers exist in the sandbox.
  for (const banned of ["require(", "import(", "process.", "setTimeout(", "setInterval("]) {
    if (source.includes(banned)) fail(dir, `${spec.script} uses ${banned} which the workflow sandbox does not provide`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log(`ok ${dirs.length} workflow pack(s): ${dirs.join(", ")}`);
