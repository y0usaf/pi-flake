import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function panteraTheme(pi: ExtensionAPI): void {
  pi.on("resources_discover", async () => ({
    themePaths: [fileURLToPath(new URL("./themes", import.meta.url))],
  }));
}
