/**
 * Batch Tool Extension
 *
 * Registers a single `batch` tool: accepts read/write/edit/bash ops in one call.
 * Dynamic tool names from pi.getAllTools(). Inline executors for the four built-in
 * tools; others fall back to "call individually".
 *
 * Saves N-1 round-trips: instead of read → wait → edit → wait, all results
 * come in one turn. Each saved turn skips a full attention pass.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

// ─── Helpers ────────────────────────────────────────────────────────────────

function getLastStr(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}

function opOut(idx: number, tool: string, ok: boolean, text: string): string {
  const tag = ok ? "OK" : "FAIL";
  let out = `--- Op ${idx}: ${tool} (${tag}) ---`;
  if (text) out += `\n${text}`;
  return out;
}

function execRead(fp: string): string {
  const raw = readFileSync(fp, "utf-8");
  const lines = raw.split("\n");
  const cap = 2000;
  const body = lines.length > cap
    ? lines.slice(0, cap).join("\n") + `\n... (${lines.length - cap} more lines)`
    : raw;
  return `${fp} (${lines.length} lines):\n${body}`;
}

function execWrite(fp: string, text: string): string {
  writeFileSync(fp, text, "utf-8");
  return `Wrote ${fp} (${text.length} chars)`;
}

function execBash(cmd: string): string {
  const r = execSync(cmd, { encoding: "utf-8", maxBuffer: 10_485_760 });
  const stdout = (r.stdout ?? "").trimEnd();
  const stderr = (r.stderr ?? "").trimEnd();
  let merged = stdout;
  if (stderr) merged += "\nstderr:\n" + stderr;
  const cap = 10_000;
  if (merged.length > cap)
    return merged.slice(0, cap) + `\n... (${merged.length} total, capped at ${cap})`;
  return merged || "(no output)";
}

function execEdit(fp: string, edits: Array<{ oldText: string; newText: string }> | undefined): string {
  if (!existsSync(fp)) return `File not found: ${fp}`;
  if (!Array.isArray(edits) || edits.length === 0) return "No edits provided.";

  const original = readFileSync(fp, "utf-8");
  let content = original;
  const msgs: string[] = [`Edited ${fp}:`];

  for (const e of edits) {
    if (typeof e.oldText !== "string") { msgs.push("  oldText must be string"); continue; }
    if (typeof e.newText !== "string") { msgs.push("  newText must be string"); continue; }
    const i = content.indexOf(e.oldText);
    if (i === -1) { msgs.push("  not found: " + JSON.stringify(e.oldText.slice(0, 60))); continue; }
    const j = content.indexOf(e.oldText, i + 1);
    if (j !== -1) { msgs.push(`  "${e.oldText.slice(0, 50)}..." not unique`); continue; }
    content = content.slice(0, i) + e.newText + content.slice(i + e.oldText.length);
    const show = e.oldText.length > 40 ? e.oldText.slice(0, 40) + "..." : e.oldText;
    msgs.push("  replaced " + JSON.stringify(show));
  }

  writeFileSync(fp, content, "utf-8");
  return msgs.join("\n");
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const register = () => {
    const allNames = pi.getAllTools().map((t) => t.name);

    pi.registerTool({
      name: "batch",
      label: "Batch",
      description:
        "Multiple tool calls in one turn: read, write, edit, bash. " +
        "Saves model re-processing — all operations in one turn. " +
        `All registered tools: ${allNames.join(", ")}. ` +
        "Inline executors: read, write, edit, bash. Call others individually.",
      promptSnippet: "batch — multiple tool calls in one turn",
      parameters: {
        type: "object",
        properties: {
          operations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                tool: { type: "string", enum: allNames },
                params: { type: "object" },
              },
              required: ["tool"],
            },
          },
        },
        required: ["operations"],
      },
      execute(
        _id: string,
        args: Record<string, unknown>,
      ): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
        const ops = (args["operations"] ?? []) as Array<{ tool: string; params?: Record<string, unknown> }>;
        const lines: string[] = [];
        let ok = 0;

        for (let i = 0; i < ops.length; i++) {
          const op = ops[i];
          const p = op.params ?? {};
          let body = "";
          let success = false;

          try {
            switch (op.tool) {
              case "read": {
                const fp = getLastStr(p, ["filePath", "path"]);
                if (!fp) { body = "missing filePath/path"; break; }
                body = execRead(fp);
                success = true;
                break;
              }
              case "write": {
                const fp = getLastStr(p, ["filePath", "path"]);
                const text = getLastStr(p, ["content", "text"]);
                if (!fp) { body = "missing filePath/path"; break; }
                if (text == null) { body = "missing content/text"; break; }
                body = execWrite(fp, text);
                success = true;
                break;
              }
              case "bash": {
                const cmd = getLastStr(p, ["command", "cmd"]);
                if (!cmd) { body = "missing command"; break; }
                body = execBash(cmd);
                success = true;
                break;
              }
              case "edit": {
                const fp = getLastStr(p, ["filePath", "path"]);
                const editsArr = p["edits"] as Array<Record<string, unknown>> | undefined;
                if (!fp) { body = "missing filePath/path"; break; }
                body = execEdit(fp, editsArr as Array<{ oldText: string; newText: string }>);
                success = true;
                break;
              }
              default:
                body = `"${op.tool}" not inline in batch. Call individually.`;
            }
          } catch (err) {
            body = err instanceof Error ? err.message : String(err);
          }

          lines.push(opOut(i + 1, op.tool, success, body));
          if (success) ok++;
        }

        return Promise.resolve({
          content: [{ type: "text", text: `Batch: ${ops.length} ops, ${ok} OK\n${lines.join("\n")}` }],
          details: { total: ops.length, ok },
        });
      },
    });
  };

  register();
  pi.on("session_start", register);
}