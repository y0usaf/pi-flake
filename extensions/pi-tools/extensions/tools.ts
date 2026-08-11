/**
 * Tools Extension
 *
 * /tools — interactive tool toggles, same TUI as /settings.
 * State is persisted to ~/.pi/agent/pi-tools.json and restored on session start.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STORE_FILE = "pi-tools.json";

function storePath(): string {
  return join(getAgentDir(), STORE_FILE);
}

function loadSaved(): string[] | null {
  const path = storePath();
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (Array.isArray(data.enabledTools)) return data.enabledTools;
  } catch {
    // corrupt file — ignore, fall through to defaults
  }
  return null;
}

function saveTools(names: string[]): void {
  const path = storePath();
  try {
    writeFileSync(path, JSON.stringify({ enabledTools: names }, null, 2) + "\n");
  } catch {
    // best-effort; storage unavailable is not a user-facing error
  }
}

export default function (pi: ExtensionAPI) {
  let active = new Set<string>();

  pi.registerCommand("tools", {
    description: "Open interactive tool toggles (same UI as /settings)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/tools requires TUI mode", "error");
        return;
      }

      const allTools = pi.getAllTools();

      await ctx.ui.custom((tui, theme, _kb, done) => {
        const items: SettingItem[] = allTools.map((tool) => ({
          id: tool.name,
          label: tool.name,
          currentValue: active.has(tool.name) ? "enabled" : "disabled",
          values: ["enabled", "disabled"],
        }));

        const container = new Container();
        container.addChild(new Text(theme.fg("accent", theme.bold("Tool Configuration")), 1, 1));

        const settingsList = new SettingsList(
          items,
          Math.min(items.length + 2, 15),
          getSettingsListTheme(),
          (id, newValue) => {
            newValue === "enabled" ? active.add(id) : active.delete(id);
            pi.setActiveTools([...active]);
            saveTools([...active]);
          },
          () => done(undefined),
        );

        container.addChild(settingsList);

        return {
          render: (w) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data) => {
            settingsList.handleInput?.(data);
            tui.requestRender();
          },
        };
      });
    },
  });

  // Restore saved selection on every session start (startup, reload, resume, fork)
  pi.on("session_start", () => {
    const saved = loadSaved();
    if (saved) {
      const allNames = new Set(pi.getAllTools().map((t) => t.name));
      const valid = saved.filter((n) => allNames.has(n));
      active = new Set(valid);
      pi.setActiveTools(valid);
    } else {
      active = new Set(pi.getActiveTools());
      saveTools([...active]);
    }
  });
}
