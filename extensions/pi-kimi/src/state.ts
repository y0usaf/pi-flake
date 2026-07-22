/**
 * Shared pi-kimi state: the permission mode toggled by /yolo and /auto.
 *
 * - "manual": "ask" rules prompt the user (block when non-interactive).
 * - "yolo":   "ask" rules auto-approve; plan-mode exit approval is NOT bypassed.
 * - "auto":   "ask" rules auto-approve; plan-mode exit approval is also skipped.
 */

export type PermissionMode = "manual" | "yolo" | "auto";

let permissionMode: PermissionMode = "manual";

export function getPermissionMode(): PermissionMode {
	return permissionMode;
}

export function setPermissionMode(mode: PermissionMode): void {
	permissionMode = mode;
}
