import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	pi.on("agent_settled", () => {
		pi.sendUserMessage("continue", { deliverAs: "followUp" });
	});
}