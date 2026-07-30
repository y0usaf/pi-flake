import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEditTool } from "./edit-tool";
import { registerReadTool } from "./read-tool";

export default function (pi: ExtensionAPI): void {
  registerReadTool(pi);
  registerEditTool(pi);
}
