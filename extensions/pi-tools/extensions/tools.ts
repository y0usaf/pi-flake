import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("tools", {
    description: "/tools — list tools; /tools <name> toggles it",
    handler: async (args, ctx) => {
      const active = new Set(pi.getActiveTools());
      const all = pi.getAllTools();

      if (!args) {
        const line = all.map((t) => (active.has(t.name) ? "✓" : "○") + " " + t.name).join(", ");
        return ctx.ui.notify(line, "info");
      }

      if (!all.find((t) => t.name === args))
        return ctx.ui.notify("no such tool: " + args, "error");

      active.has(args) ? active.delete(args) : active.add(args);
      pi.setActiveTools([...active]);
      ctx.ui.notify(active.has(args) ? "✓ " + args : "✕ " + args, "info");
    },
  });
}