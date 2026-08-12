import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionCommands } from "./extensions";
import { registerToolCommands } from "./tools";

export default function managementExtension(pi: ExtensionAPI) {
	registerToolCommands(pi);
	registerExtensionCommands(pi);
}
