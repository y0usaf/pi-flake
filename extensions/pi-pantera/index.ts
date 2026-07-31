// Pi writes auto-detected "theme": "dark" before extensions load, so an absent
// setting cannot distinguish that from a user choice. The marker makes this
// default one-shot while still allowing the user's later theme selection.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function panteraTheme(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const configuredDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = configuredDir?.startsWith("~/")
      ? join(homedir(), configuredDir.slice(2))
      : configuredDir || join(homedir(), ".pi", "agent");
    const marker = join(agentDir, "pantera-default-applied");
    if (existsSync(marker)) return;

    let settings: { theme?: unknown } = {};
    try {
      settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    } catch {}
    const themeSetting = typeof settings.theme === "string" ? settings.theme : undefined;
    if (themeSetting !== undefined && themeSetting !== "dark" && themeSetting !== "light") return;

    if (!ctx.ui || typeof ctx.ui.setTheme !== "function") return;
    const result = ctx.ui.setTheme("pantera");
    if (result.success === true) {
      try {
        writeFileSync(marker, "");
      } catch {}
    }
  });
}
