import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Publish a tool definition to pi-exec's shared route registry.
 *
 * The registry is a Map on globalThis keyed by Symbol.for("pi-exec.routes").
 * All extensions load into one process, so this needs no dependency on
 * pi-exec. If pi-exec is not installed, the map is simply never read.
 */
export function publishExecRoute(def: ToolDefinition<any, any>): void {
  const g = globalThis as any;
  const routes: Map<string, ToolDefinition<any, any>> = (g[Symbol.for("pi-exec.routes")] ??= new Map());
  routes.set(def.name, def);
}
