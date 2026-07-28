export type PresetName = "editorial" | "minimal" | "classic";
export type ActivityState = "ready" | "working" | "warning" | "error";
export type SegmentId = "brand" | "activity" | "metrics" | "context" | "model" | "git" | "menu";
export type Density = "comfortable" | "compact";
export type Ornament = "none" | "restrained";

export interface AtelierConfig {
	preset: PresetName;
	shortcut: string;
	segments: SegmentId[];
	density: Density;
	ornament: Ornament;
	contextWarning: number;
	contextDanger: number;
	currencyDecimals: number;
	showSessionActions: boolean;
	showSidebarToolNames: boolean;
	completionNotifications: boolean;
}

export interface AtelierMetrics {
	usageAvailable: boolean;
	costAvailable: boolean;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheHitPercent?: number;
	cost: number;
	subscription: boolean;
	contextTokens: number | null;
	contextWindow: number;
	contextPercent: number | null;
	autoCompact: boolean | null;
}

export interface ExtensionStatus {
	key: string;
	text: string;
}

export interface AtelierState {
	activity: ActivityState;
	workingLabel?: string;
	modelId?: string;
	provider?: string;
	thinkingLevel?: string;
	branch?: string;
	dirty: boolean;
	metrics: AtelierMetrics;
	extensionStatuses: readonly ExtensionStatus[];
}

export const DEFAULT_CONFIG: AtelierConfig = {
	preset: "editorial",
	shortcut: "alt+a",
	segments: ["brand", "activity", "metrics", "context", "model", "git", "menu"],
	density: "comfortable",
	ornament: "none",
	contextWarning: 70,
	contextDanger: 90,
	currencyDecimals: 3,
	showSessionActions: true,
	showSidebarToolNames: false,
	completionNotifications: true,
};
