import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * heartbeat — paced re-prompting for the meta session.
 *
 * The boss session (the one you interact with) fans work down to worker
 * sessions and subagents. Work is driven by re-prompting; this just repeats
 * a prompt at a fixed cadence, letting the driver decide what each beat
 * does. Not a replacement for pi-agents — it is the pacing layer on top.
 *
 * `/heartbeat [interval_s] [prompt...]` — every interval, if the session is
 * idle, send the prompt as a follow-up that triggers a turn. Running the
 * command again restarts the timer. `/heartbeat stop` cancels.
 *
 * The prompt defaults to a decomposition nudge so beats keep the tree
 * growing when there is more work than the current agent consumed.
 */

const DEFAULT_INTERVAL = 60; // one minute between beats

export default function (pi: ExtensionAPI): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let idle = true;

  pi.on("agent_start", () => {
    idle = false;
  });

  pi.on("agent_settled", () => {
    idle = true;
  });

  pi.registerCommand("heartbeat", {
    description:
      "Paced re-prompting: every interval_ms, if idle, send prompt as a follow-up turn. option: stop",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "stop") {
        if (timer) clearInterval(timer);
        timer = undefined;
        return "heartbeat stopped";
      }

      const m = /^(\d+)\s+(.*)$/s.exec(arg);
      const intervalSec = m ? Number(m[1]) : DEFAULT_INTERVAL;
      const nextPrompt = m ? m[2] : arg;
      if (!nextPrompt.trim()) return "usage: /heartbeat [interval_s] [prompt] | stop";

      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        if (!idle) return; // a run is mid-flight — skip this beat
        void pi.sendUserMessage(nextPrompt, { deliverAs: "followUp" });
      }, intervalSec * 1000);

      if (ctx.hasUI) {
        ctx.ui.notify(`heartbeat: every ${intervalSec}s → "${nextPrompt.slice(0, 40)}"`, "info");
      }
      return "heartbeat started";
    },
  });

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  });
}