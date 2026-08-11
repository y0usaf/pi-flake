import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";

const runeSchema = Type.Object({
  task: Type.String({
    description: "The task for the child agent to fulfill. Written as a plain prompt -- the child has all Pi tools (read, write, edit, bash, grep, find, ls) and its own system prompt. It reads context, performs the work, and returns the answer."
  }),
  model: Type.Optional(Type.String({
    description: 'Model for the child (e.g. "anthropic/claude-haiku-4.5"). When omitted, uses the parent\'s default.'
  })),
  cwd: Type.Optional(Type.String({
    description: "Working directory for the child. Parent pi cwd when omitted."
  })),
  timeout: Type.Optional(Type.Number({
    description: "Timeout in ms. Default is 600000 (10 min)."
  })),
});

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "recurse",
    label: "Recurse",
    description: [
      "Spawn a full Pi agent session to fulfill a task. The child is a literal pi -p (--print) subprocess with all built-in Pi tools (read, write, edit, bash, grep, find, ls) and whatever user extensions are configured.",
      "When the child also has this extension installed, it can recurse further -- this is the whole recursion primitive. The task is the contract.",
      "Each call spawns a fresh subprocess. No shared namespace, no persistent engine, no RPC orchestration -- just a child that knows how to do the job.",
      "Use for any separable piece of work: parallel scouting, file mutation, multi-perspective review, hypothesis checking."
    ].join(" "),
    parameters: runeSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const piBin = process.env.PI_BINARY || "pi";
      const args = ["--print", params.task];
      if (params.model) args.push("--model", params.model);
      const cwd = params.cwd || ctx.cwd;
      const timeoutMs = params.timeout || 600000;

      return new Promise((resolve) => {
        const child = spawn(piBin, args, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, PI_TELEMETRY: "0" },
        });
        let stdout = "";
        let err = "";
        let done = false;

        child.stdout!.on("data", (c: Buffer) => { stdout += c.toString(); });
        child.stderr!.on("data", (c: Buffer) => { err += c.toString(); });

        const settle = (text: string) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve({ content: [{ type: "text" as const, text }], details: {} });
        };

        const timer = setTimeout(() => {
          child.kill();
          settle("Timed out after " + (timeoutMs / 1000) + "s.\n" + (stdout || "") + (err ? "\nstderr:\n" + err : ""));
        }, timeoutMs);

        const onAbort = () => {
          child.kill();
          settle("Cancelled. Partial output:\n" + (stdout || "") + (err ? "\nstderr:\n" + err : ""));
        };
        signal.addEventListener("abort", onAbort, { once: true });

        child.on("close", (code) => {
          const out = stdout || err || "(no output)";
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
}