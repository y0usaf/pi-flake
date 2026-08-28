import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

type AliasMap = Record<string, string>;

function resolveAliases(): AliasMap {
  const raw = process.env.PI_ALIASES;
  if (raw) {
    try { return JSON.parse(raw); } catch {
      // fall through to defaults
    }
  }
  return { grep: "rg", find: "fd" };
}

export default function (pi: ExtensionAPI) {
  const aliases = resolveAliases();
  const entries = Object.entries(aliases);
  if (entries.length === 0) return;

  pi.on("tool_call", async (event) => {
    if (isToolCallEventType("bash", event)) {
      event.input.command =
        entries.map(([from, to]) => `${from}() { ${to} "$@"; }`).join("; ") +
        `;\n${event.input.command}`;
    }
  });
}
