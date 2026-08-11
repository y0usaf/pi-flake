import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const RUNE_SCHEMA = Type.Object({
  task: Type.String({
    description: "The task for the child agent to fulfill. Written as a plain prompt -- the child has all Pi tools (read, write, edit, bash, grep, find, ls) and its own system prompt. It reads context, performs the work, and returns the answer."
  }),
  model: Type.Optional(Type.String({
    description: 'Model for the child (e.g. "anthropic/claude-haiku-4.5"). When omitted, inherits from parent session.'
  })),
  cwd: Type.Optional(Type.String({
    description: "Working directory for the child. It omits cwd when omitted."
  })),
  timeout: Type.Optional(Type.Number({
    description: "Timeout in ms. Default is 600000 (10 min)."
  })),
});

interface RecursionSummary {
  label: string;
  task: string;
  model: string | undefined;
  timestamp: string;
  lines: string[];
}

export default function (pi: ExtensionAPI): void {
  // ── tool: recurse ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "recurse",
    label: "Recurse",
    description: [
      "Spawn a full Pi agent session to fulfill a task. The child is a literal pi -p (--print) subprocess with all built-in Pi tools (read, write, edit, bash, grep, find, ls) and whatever user extensions are configured.",
      "When the child also has this extension installed, it can recurse further -- this is the whole recursion primitive. The task is the contract.",
      "Each call spawns a fresh subprocess. No shared namespace, no persistent engine, no RPC orchestration.",
      "The child's session file is embedded into the parent session for durability and later inspection via /recurse-view."
    ].join(" "),
    parameters: RUNE_SCHEMA,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const piBin = process.env.PI_BINARY || "";
      const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const modelStr = params.model ?? parentModel;
      const cwd = params.cwd || ctx.cwd;
      const timeoutMs = params.timeout || 600000;

      // Create a known session file path for the child.
      // We write a minimal session header so --session works.
      const sessionDir = mkdtempSync(join(tmpdir(), "pi-recurse-"));
      const sessionFile = join(sessionDir, "session.jsonl");
      const now = new Date().toISOString();
      const header = JSON.stringify({
        type: "session",
        version: 3,
        id: crypto.randomUUID(),
        timestamp: now,
        cwd,
      });
      writeFileSync(sessionFile, header + "\n", "utf8");

      const args = ["--print", "--session", sessionFile];
      if (modelStr) args.push("--model", modelStr);
      args.push(params.task);

      return new Promise((resolve) => {
        const child = spawn(piBin, args, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            PI_TELEMETRY: "0",
          },
        });
        let stdout = "";
        let stderr = "";
        let done = false;

        child.stdout!.on("data", (c: Buffer) => { stdout += c.toString(); });
        child.stderr!.on("data", (c: Buffer) => { stderr += c.toString(); });

        const settle = (text: string) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          rmSync(sessionDir, { recursive: true, force: true });

          resolve({
            content: [{ type: "text" as const, text }],
            details: { sessionLines: 0 },
          });
        };

        const timer = setTimeout(() => {
          child.kill();
          const msg = "Timed out after " + (timeoutMs / 1000) + "s.\n" + (stdout || "") + (stderr ? "\nstderr:\n" + stderr : "");
          settle(msg);
        }, timeoutMs);

        const onAbort = () => {
          child.kill();
          settle("Cancelled. Partial output:\n" + (stdout || "") + (stderr ? "\nstderr:\n" + stderr : ""));
        };
        signal.addEventListener("abort", onAbort, { once: true });

        child.on("close", () => {
          // After child exits, read the session file and embed it
          let lines: string[] | undefined;
          try {
            const raw = readFileSync(sessionFile, "utf8").trim();
            if (raw) lines = raw.split("\n").filter(Boolean);
          } catch {}

          if (lines && lines.length > 0) {
            pi.appendEntry("recurse", {
              task: params.task,
              model: modelStr,
              timestamp: now,
              lines,
            });
          }

          const out = stdout || stderr || "(no output)";
          const code = child.exitCode;
          if (code === 0 && stdout) {
            settle(stdout.trim());
          } else if (code === 0) {
            settle("(no output)");
          } else {
            settle("exit " + code + "\n" + out);
          }
        });
        child.on("error", (e) => {
          settle("Failed to spawn child: " + e.message);
        });
      });
    },
  });

  // ── /recurse-view command ─────────────────────────────────────────────
  pi.registerCommand("recurse-view", {
    description: "Browse embedded recursions and open one in an interactive Pi session (takes over terminal).",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getEntries();
      const recursions: RecursionSummary[] = [];

      for (const entry of entries) {
        if (entry.type === "custom" && (entry as any).customType === "recurse" && (entry as any).data) {
          const d = (entry as any).data;
          recursions.push({
            label: `${(d.task ?? "(unknown)").slice(0, 60)}${d.task?.length > 60 ? "..." : ""} (${d.lines?.length ?? 0} events)`,
            task: d.task ?? "(unknown)",
            model: d.model,
            timestamp: d.timestamp ?? "(unknown)",
            lines: Array.isArray(d.lines) ? d.lines : [],
          });
        }
      }

      if (recursions.length === 0) {
        ctx.ui.notify("No embedded recursions found in this session.", "info");
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify("/recurse-view requires interactive mode", "error");
        return;
      }

      const labels = recursions.map((r) => r.label);
      const chosenLabel = await ctx.ui.select("Recursion to open:", labels);
      if (chosenLabel === undefined) return;

      const chosen = recursions.find((r) => r.label === chosenLabel);
      if (!chosen || chosen.lines.length === 0) {
        ctx.ui.notify("No session data for this recursion.", "info");
        return;
      }

      const piBin = process.env.PI_BINARY || "pi";
      const tmpJsonl = join(tmpdir(), `pi-recurse-view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
      try {
        writeFileSync(tmpJsonl, chosen.lines.join("\n") + "\n", "utf8");
        ctx.ui.notify(`Opening recursion session...`, "info");

        await new Promise<void>((resolve, reject) => {
          const viewer = spawn(piBin, ["--session", tmpJsonl], {
            cwd: process.cwd(),
            stdio: "inherit",
            env: { ...process.env, PI_TELEMETRY: "0" },
          });
          viewer.on("close", () => { resolve(); });
          viewer.on("error", (e) => { reject(e); });
        });
      } finally {
        try { unlinkSync(tmpJsonl); } catch {}
      }
    },
  });
}
