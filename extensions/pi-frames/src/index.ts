import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createWriteToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition } from "@earendil-works/pi-coding-agent";
import { skinDefinition } from "./skin";
import { renderCall, renderResult } from "./render";

export { skinDefinition } from "./skin";
export function definitions(cwd: string): any[] {
  return [createBashToolDefinition(cwd), createWriteToolDefinition(cwd), createGrepToolDefinition(cwd), createFindToolDefinition(cwd), createLsToolDefinition(cwd)].map((definition) => skinDefinition(definition, renderCall, renderResult));
}
export default function (pi: ExtensionAPI): void {
  for (const definition of definitions(process.cwd())) pi.registerTool(definition);
}
