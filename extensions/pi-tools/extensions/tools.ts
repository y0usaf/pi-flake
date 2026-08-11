import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("tools", {
    description: "Open interactive tool toggles (same UI as /settings)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/tools requires TUI mode", "error");
        return;
      }

      const active = new Set(pi.getActiveTools());
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
          },
          () => done(undefined),
        );

        container.addChild(settingsList);

        return {
          render: (w) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data) => { settingsList.handleInput?.(data); tui.requestRender(); },
        };
      });
    },
  });
}