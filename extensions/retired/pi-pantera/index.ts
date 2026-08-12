// The marker makes the default one-shot where pi can persist a later user choice.
// With read-only settings (such as Nix), pi cannot persist anything, so dark/light
// is not a user choice: re-apply each session unless a pinned theme or opt-out wins.
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function panteraTheme(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const configuredDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = configuredDir?.startsWith("~/")
      ? join(homedir(), configuredDir.slice(2))
      : configuredDir || join(homedir(), ".pi", "agent");
    if (process.env.PI_PANTERA === "0") return;

    const settingsPath = join(agentDir, "settings.json");
    let settings: { theme?: unknown } = {};
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {}
    const themeSetting = typeof settings.theme === "string" ? settings.theme : undefined;
    if (themeSetting !== undefined && themeSetting !== "dark" && themeSetting !== "light") return;

    let canPersist = false;
    try {
      accessSync(existsSync(settingsPath) ? settingsPath : agentDir, constants.W_OK);
      canPersist = true;
    } catch {}

    const marker = join(agentDir, "pantera-default-applied");
    if (canPersist && existsSync(marker)) return;

    if (!ctx.ui || typeof ctx.ui.setTheme !== "function") return;
    const result = ctx.ui.setTheme("pantera");
    if (result.success === true && canPersist) {
      try {
        writeFileSync(marker, "");
      } catch {}
    }
  });
}
