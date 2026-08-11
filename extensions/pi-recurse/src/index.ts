import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, unlinkSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";

const RUNE_SCHEMA = Type.Object({
  task: Type.String({ description: "The task for the child agent to fulfill." }),
  model: Type.Optional(Type.String({ description: 'Model override.' })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the child." })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in ms. Default 600000." })),
});

interface RecursionSummary {
  label: string;
  task: string;
  model: string | undefined;
  timestamp: string;
  lines: string[];
}

/** Write diagnostics to ~/recurse-diag.txt for debugging. */
const DIAG = join(homedir(), "recurse-diag.txt");
function diag(msg: string): void {
  try { appendFileSync(DIAG, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

function resolvePiBin(): string {
  if (process.env.PI_BINARY) return process.env.PI_BINARY;
  const arg0 = process.argv[0];
  if (arg0 && (arg0.endsWith("/pi") || arg0.endsWith(".pi-wrapped") || arg0.endsWith(".pi-real"))) {
    const base = arg0.replace(/\.pi-wrapped$/,"").replace(/\.pi-real$/,"").replace(/\/$/,"") + "/pi";
    const cand = base.replace(/\/\//,"/");
    if (existsSync(cand)) return cand;
    return "pi";
  }
  // Try walking up from argv[1] for non-SEA layout
  const entryScript = process.argv[1];
  if (entryScript && !entryScript.startsWith("-")) {
    for (let dir = dirname(entryScript); dir && dir !== "/"; dir = dirname(dir)) {
      const c = join(dir, "bin", "pi");
      if (existsSync(c)) return c;
      const dc = join(dir, ".bin", "pi");
      if (existsSync(dc)) return dc;
    }
  }
  return "pi";
}

export default function (pi: ExtensionAPI): void {
  const piBin = resolvePiBin();
  diag(`resolvePiBin() = ${piBin}`);

  pi.registerTool({
    name: "recurse",
    label: "Recurse",
    description: "Spawn a full Pi agent session. Child session is embedded into the parent session.",
    parameters: RUNE_SCHEMA,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const piModel = params.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
      const cwd = params.cwd || ctx.cwd;
      const timeoutMs = params.timeout || 600000;

      const sessionDir = mkdtempSync(join(tmpdir(), "pi-recurse-"));
      const sessionFile = join(sessionDir, "session.jsonl");
      diag(`sessionFile = ${sessionFile}`);
      const now = new Date().toISOString();
      writeFileSync(sessionFile,
        JSON.stringify({ type: "session", version: 3, id: crypto.randomUUID(), timestamp: now, cwd }) + "\n",
        "utf8",
      );
      diag(`header wrote, exists=${existsSync(sessionFile)} size=${readFileSync(sessionFile).length}`);

      const args = ["--print", "--session", sessionFile];
      if (piModel) args.push("--model", piModel);
      args.push(params.task);

      return new Promise((resolve) => {
        let sessionLineCount = -1;
        let stdout = "";
        let stderr = "";
        let settled = false;

        const finish = (text: string, count: number) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onInterrupt);
          diag(`finish: count=${count}`);
          try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
          resolve({
            content: [{ type: "text" as const, text }],
            details: { sessionLines: count },
          });
        };

        const child = spawn(piBin, args, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, PI_TELEMETRY: "0" },
        });
        diag(`child=${child.pid} piBin=${piBin} args=${JSON.stringify(args)}`);

        child.stdout!.on("data", (c: Buffer) => { stdout += c.toString(); });
        child.stderr!.on("data", (c: Buffer) => { stderr += c.toString(); });

        const timer = setTimeout(() => {
          child.kill();
          finish("Timed out.\n" + stdout + (stderr ? "\nstderr:\n" + stderr : ""), 0);
        }, timeoutMs);

        const onInterrupt = () => { child.kill(); finish("Cancelled.\n" + (stdout||"") + (stderr ? "\n"+stderr : ""), 0); };
        signal.addEventListener("interrupt", onInterrupt, { once: true });

        child.on("close", () => {
          diag(`close, exitCode=${child.exitCode}`);
          let count = 0;
          try {
            const raw = readFileSync(sessionFile, "utf8");
            diag(`readFileSync len=${raw.length} firstLine=${raw.split("\n")[0]?.slice(0, 50)}`);
            const trimmed = raw.trim();
            if (trimmed) {
              const allLines = trimmed.split("\n").filter(Boolean);
              count = allLines.length;
              diag(`count=${count}}`);
              if (count > 1) { // > 1 means child wrote events, not just our header
                pi.appendEntry("recurse", {
                  task: params.task,
                  model: piModel,
                  timestamp: now,
                  lines: allLines,
                });
                diag(`appendEntry OK`);
              }
            }
          } catch (e: any) {
            diag(`readFileSync error: ${e.message}`);
          }

          const out = stdout || stderr || "(no output)";
          const code = child.exitCode;
          if (code === 0 && stdout) finish(stdout.trim(), count);
          else if (code === 0) finish("(no output)", count);
          else finish("exit " + code + "\n" + out, count);
        });
        child.on("error", (e) => {
          diag(`error: ${e.message}`);
          finish("Failed: " + e.message, 0);
        });
      });
    },
  });

  pi.registerCommand("recurse-view", {
    description: "Browse embedded recursions and open one in an interactive Pi session.",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getEntries();
      diag(`recurse-view entries=${entries.length}`);
      const recursions: RecursionSummary[] = [];
      for (const entry of entries) {
        if (entry.type === "custom" && (entry as any).customType === "recurse" && (entry as any).data) {
          const d = (entry as any).data;
          diag(`found: ${(d.task ?? "").slice(0, 30)}`);
          recursions.push({
            label: `${(d.task ?? "(unknown)").slice(0, 60)}${d.task?.length > 60 ? "..." : ""} (${d.lines?.length ?? 0} events)`,
            task: d.task ?? "(unknown)",
            model: d.model,
            timestamp: d.timestamp ?? "(unknown)",
            lines: Array.isArray(d.lines) ? d.lines : [],
          });
        }
      }
      diag(`found ${recursions.length} entries`);
      if (recursions.length === 0) {
        ctx.ui.notify("No embedded recursions found in this session.", "info");
        return;
      }

      const labels = recursions.map(r => r.label);
      const chosenLabel = await ctx.ui.select("Recursion to open:", labels);
      if (chosenLabel === undefined) return;
      const chosen = recursions.find(r => r.label === chosenLabel);
      if (!chosen || chosen.lines.length === 0) {
        ctx.ui.notify("No session data for this recursion.", "info");
        return;
      }

      const tmpJsonl = join(tmpdir(), `pi-recurse-view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
      try {
        writeFileSync(tmpJsonl, chosen.lines.join("\n") + "\n", "utf8");
        const label = chosen.task.slice(0, 50);
        ctx.ui.notify(`Opening recursion: ${label}...`, "info");

        await new Promise<void>((rs, rj) => {
          const viewer = spawn(piBin, ["--session", tmpJsonl, "--name", `Recursion: ${label}`], {
            cwd: process.cwd(),
            stdio: "inherit",
            env: { ...process.env, PI_TELEMETRY: "0" },
          });
          viewer.on("close", () => rs());
          viewer.on("error", e => rj(e));
        });

        ctx.ui.notify("↑ Back to parent session.", "info");
      } finally {
        try { unlinkSync(tmpJsonl); } catch {}
      }
    },
  });
}
