/**
 * pi-rtk — Pi extension that uses `rtk rewrite` to optimize shell commands.
 *
 * The extension participates in two Pi execution paths:
 * - agent-initiated `bash` tool calls via the mutable `tool_call` event
 * - user-issued `!<cmd>` shell commands via the `user_bash` event
 *
 * In both paths, optimization is best-effort and asynchronous: when `rtk
 * rewrite` succeeds, Pi executes the rewritten command; when rewrite fails,
 * times out, or `rtk` is unavailable, execution falls back to Pi's normal
 * shell behavior.
 *
 * Commands entered with `!!<cmd>` are intentionally not intercepted so the
 * user's choice to exclude shell output from model context is preserved.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createLocalBashOperations,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const RTK_COMMAND = "rtk";
const REWRITE_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export type RtkAvailability = "unknown" | "available" | "unavailable";
export type RtkFailureKind = "aborted" | "failed" | "timeout" | "unavailable";

export interface RtkStatus {
  availability: RtkAvailability;
  attempts: number;
  applied: number;
  empty: number;
  unchanged: number;
  failures: number;
  unavailableSkips: number;
  lastFailure?: RtkFailureKind;
}

export interface RtkRewriter {
  rewrite(command: string, signal?: AbortSignal): Promise<string | undefined>;
  probe(signal?: AbortSignal): Promise<RtkAvailability>;
  resetAvailability(): void;
  getStatus(): RtkStatus;
}

export interface RtkRewriterOptions {
  command?: string;
  timeoutMs?: number;
  probeTimeoutMs?: number;
}

const execFileAsync = promisify(execFile);

async function execFileText(
  file: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    encoding: "utf8",
    killSignal: "SIGTERM",
    maxBuffer: MAX_OUTPUT_BYTES,
    signal: options.signal,
    timeout: options.timeoutMs,
  });
  return String(stdout).trimEnd();
}

function classifyError(error: unknown): RtkFailureKind {
  const err = error as {
    code?: unknown;
    killed?: unknown;
    name?: unknown;
  } | null;

  if (err?.name === "AbortError" || err?.code === "ABORT_ERR") {
    return "aborted";
  }

  if (err?.code === "ENOENT" || err?.code === "EACCES") {
    return "unavailable";
  }

  if (err?.killed === true || err?.code === "ETIMEDOUT") {
    return "timeout";
  }

  return "failed";
}

export function createRtkRewriter(
  options: RtkRewriterOptions = {},
): RtkRewriter {
  const command = options.command ?? RTK_COMMAND;
  const timeoutMs = options.timeoutMs ?? REWRITE_TIMEOUT_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;

  let availability: RtkAvailability = "unknown";
  const counters: Omit<RtkStatus, "availability"> = {
    attempts: 0,
    applied: 0,
    empty: 0,
    unchanged: 0,
    failures: 0,
    unavailableSkips: 0,
    lastFailure: undefined,
  };

  function recordFailure(failure: RtkFailureKind): void {
    counters.failures += 1;
    counters.lastFailure = failure;

    if (failure === "unavailable") {
      availability = "unavailable";
    } else if (failure !== "aborted") {
      // Timeouts and non-zero exits prove that the binary itself spawned.
      availability = "available";
    }
  }

  return {
    async rewrite(shellCommand, signal) {
      if (availability === "unavailable") {
        counters.unavailableSkips += 1;
        return undefined;
      }

      counters.attempts += 1;

      try {
        const rewritten = await execFileText(
          command,
          ["rewrite", shellCommand],
          { timeoutMs, signal },
        );
        availability = "available";

        if (!rewritten) {
          counters.empty += 1;
          return undefined;
        }

        if (rewritten === shellCommand) {
          counters.unchanged += 1;
          return undefined;
        }

        counters.applied += 1;
        return rewritten;
      } catch (error) {
        recordFailure(classifyError(error));
        return undefined;
      }
    },

    async probe(signal) {
      try {
        await execFileText(command, ["--version"], {
          timeoutMs: probeTimeoutMs,
          signal,
        });
        availability = "available";
      } catch (error) {
        recordFailure(classifyError(error));
      }

      return availability;
    },

    resetAvailability() {
      if (availability === "unavailable") {
        availability = "unknown";
      }
    },

    getStatus() {
      return {
        ...counters,
        availability,
      };
    },
  };
}

function formatStatus(enabled: boolean, status: RtkStatus): string {
  return [
    `rtk — state: ${enabled ? "on" : "off"}`,
    `binary: ${status.availability}`,
    `rewrites: ${status.applied}/${status.attempts}`,
    `empty: ${status.empty}`,
    `unchanged: ${status.unchanged}`,
    `unavailable skips: ${status.unavailableSkips}`,
    `last failure: ${status.lastFailure ?? "none"}`,
  ].join(" · ");
}

function updateFooter(ctx: ExtensionContext, enabled: boolean): void {
  if (!ctx.hasUI) {
    return;
  }

  ctx.ui.setStatus(
    "pi-rtk",
    ctx.ui.theme.fg(enabled ? "success" : "muted", "rtk"),
  );
}

export function registerPiRtk(
  pi: ExtensionAPI,
  rewriter: RtkRewriter = createRtkRewriter(),
): void {
  const localBashOperations = createLocalBashOperations();
  let enabled = true;
  const notifiedFailures = new Set<RtkFailureKind>();

  function notifyFailure(ctx: ExtensionContext, failure: RtkFailureKind): void {
    if (!ctx.hasUI || notifiedFailures.has(failure)) {
      return;
    }

    notifiedFailures.add(failure);
    ctx.ui.notify(
      `rtk rewrite ${failure}; using the original command`,
      "warning",
    );
  }

  async function rewriteIfEnabled(
    command: string,
    ctx: ExtensionContext,
  ): Promise<string | undefined> {
    if (!enabled) {
      return undefined;
    }

    const failures = rewriter.getStatus().failures;
    const rewritten = await rewriter.rewrite(command, ctx.signal);
    const status = rewriter.getStatus();
    if (status.failures > failures && status.lastFailure) {
      notifyFailure(ctx, status.lastFailure);
    }
    return rewritten;
  }

  pi.registerCommand("rtk", {
    description: "Toggle or inspect rtk shell command rewriting",
    getArgumentCompletions(prefix) {
      const items = ["on", "off", "status"].map((value) => ({
        value,
        label: value,
      }));
      const matches = items.filter((item) => item.value.startsWith(prefix));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();

      if (action === "status") {
        const failures = rewriter.getStatus().failures;
        const availability = await rewriter.probe(ctx.signal);
        const status = rewriter.getStatus();
        if (status.failures > failures && status.lastFailure) {
          notifyFailure(ctx, status.lastFailure);
        }
        ctx.ui.notify(
          formatStatus(enabled, { ...rewriter.getStatus(), availability }),
          "info",
        );
        return;
      }

      if (action === "" || action === "on" || action === "off") {
        enabled = action === "" ? !enabled : action === "on";

        if (enabled) {
          rewriter.resetAvailability();
        }

        updateFooter(ctx, enabled);
        ctx.ui.notify(
          `rtk ${enabled ? "on" : "off"}`,
          enabled ? "info" : "warning",
        );
        return;
      }

      ctx.ui.notify("Usage: /rtk [on|off|status]", "warning");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    updateFooter(ctx, enabled);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) {
      return;
    }

    const rewritten = await rewriteIfEnabled(event.input.command, ctx);
    if (rewritten && enabled) {
      event.input.command = rewritten;
    }
  });

  pi.on("user_bash", async (event, ctx) => {
    if (event.excludeFromContext) {
      return;
    }

    const rewritten = await rewriteIfEnabled(event.command, ctx);
    if (!rewritten || !enabled) {
      return;
    }

    return {
      operations: {
        exec: (_command, cwd, options) => {
          return localBashOperations.exec(rewritten, cwd, options);
        },
      },
    };
  });
}

export default function (pi: ExtensionAPI) {
  registerPiRtk(pi);
}
