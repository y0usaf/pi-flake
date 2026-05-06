import { type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

const ANSI_FG_RESET = "\x1b[39m";
const WORK_FRAME_MS = 50;
const WORK_CYCLING_WIDTH = 15;
const WORK_MAX_BIRTH_OFFSET_MS = 1000;
const WORK_STARTUP_FRAMES = Math.ceil(WORK_MAX_BIRTH_OFFSET_MS / WORK_FRAME_MS) + 1;
const WORK_STARTUP_SWITCH_MS = WORK_MAX_BIRTH_OFFSET_MS;
const WORK_PRERENDERED_FRAMES = WORK_CYCLING_WIDTH * 2;
const WORK_GRADIENT_RAMP_WIDTH = WORK_CYCLING_WIDTH * 3;
const WORK_RUNES = "0123456789abcdefABCDEF~!@#$£€%^&*()+=_";
const WORK_INITIAL_CHAR = ".";
const WORK_HIDDEN_MESSAGE = "\u200B"; // zero-width: bypass pi's `||` fallback to "Working..."

type Theme = ExtensionContext["ui"]["theme"];
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type Rgb = { r: number; g: number; b: number };
type Hsl = { h: number; s: number; l: number };

const THINKING_COLOR: Record<ThinkingLevel, Parameters<Theme["fg"]>[0]> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
};

const CUBE_VALUES = [0, 95, 135, 175, 215, 255];
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

let workingIndicatorTimer: ReturnType<typeof setTimeout> | undefined;
let workingIndicatorGeneration = 0;

function currentThinkingLevel(pi: ExtensionAPI, ctx: ExtensionContext): ThinkingLevel | undefined {
	if (!ctx.model?.reasoning) return undefined;
	const level = pi.getThinkingLevel();
	return level && level in THINKING_COLOR ? (level as ThinkingLevel) : undefined;
}

function ansi256ToRgb(index: number): Rgb {
	if (index < 16) {
		const base: Rgb[] = [
			{ r: 0, g: 0, b: 0 },
			{ r: 128, g: 0, b: 0 },
			{ r: 0, g: 128, b: 0 },
			{ r: 128, g: 128, b: 0 },
			{ r: 0, g: 0, b: 128 },
			{ r: 128, g: 0, b: 128 },
			{ r: 0, g: 128, b: 128 },
			{ r: 192, g: 192, b: 192 },
			{ r: 128, g: 128, b: 128 },
			{ r: 255, g: 0, b: 0 },
			{ r: 0, g: 255, b: 0 },
			{ r: 255, g: 255, b: 0 },
			{ r: 0, g: 0, b: 255 },
			{ r: 255, g: 0, b: 255 },
			{ r: 0, g: 255, b: 255 },
			{ r: 255, g: 255, b: 255 },
		];
		return base[Math.max(0, Math.min(15, index))]!;
	}
	if (index >= 232) {
		const gray = GRAY_VALUES[Math.max(0, Math.min(GRAY_VALUES.length - 1, index - 232))]!;
		return { r: gray, g: gray, b: gray };
	}
	const offset = Math.max(0, Math.min(215, index - 16));
	return {
		r: CUBE_VALUES[Math.floor(offset / 36)]!,
		g: CUBE_VALUES[Math.floor(offset / 6) % 6]!,
		b: CUBE_VALUES[offset % 6]!,
	};
}

function ansiToRgb(ansi: string): Rgb | undefined {
	const truecolor = ansi.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
	if (truecolor) return { r: Number(truecolor[1]), g: Number(truecolor[2]), b: Number(truecolor[3]) };
	const color256 = ansi.match(/\x1b\[38;5;(\d+)m/);
	return color256 ? ansi256ToRgb(Number(color256[1])) : undefined;
}

function rgbToHsl({ r, g, b }: Rgb): Hsl {
	r /= 255;
	g /= 255;
	b /= 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return { h: 0, s: 0, l };
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h = 0;
	if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
	else if (max === g) h = (b - r) / d + 2;
	else h = (r - g) / d + 4;
	return { h: h * 60, s, l };
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const hp = (((h % 360) + 360) % 360) / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	const m = l - c / 2;
	let [r, g, b] = [0, 0, 0];
	if (hp < 1) [r, g, b] = [c, x, 0];
	else if (hp < 2) [r, g, b] = [x, c, 0];
	else if (hp < 3) [r, g, b] = [0, c, x];
	else if (hp < 4) [r, g, b] = [0, x, c];
	else if (hp < 5) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

function gradientAnsi(start: Rgb, end: Rgb, index: number, total: number): string {
	const t = Math.min(1, total <= 1 ? 0 : index / (total - 1));
	const a = rgbToHsl(start);
	const b = rgbToHsl(end);
	if (a.s < 0.05) a.h = b.h;
	if (b.s < 0.05) b.h = a.h;
	const hueDelta = ((((b.h - a.h) % 360) + 540) % 360) - 180;
	const saturation = a.s + (b.s - a.s) * t;
	const rgb = hslToRgb({
		h: a.h + hueDelta * t,
		s: Math.min(1, t === 0 || t === 1 ? saturation : Math.max(0.4, saturation * 1.25)),
		l: a.l + (b.l - a.l) * t,
	});
	return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`;
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g, "");
}

function clearWorkingIndicatorTimer(): void {
	workingIndicatorGeneration++;
	if (workingIndicatorTimer) {
		clearTimeout(workingIndicatorTimer);
		workingIndicatorTimer = undefined;
	}
}

function workingGradient(theme: Theme, thinking: ThinkingLevel | undefined): { accentAnsi: string; accentRgb: Rgb | undefined; endRgb: Rgb | undefined } {
	const accentAnsi = theme.getFgAnsi("accent");
	const accentRgb = ansiToRgb(accentAnsi);
	const endAnsi = theme.getFgAnsi(THINKING_COLOR[thinking ?? "high"]);
	const endRgb = ansiToRgb(endAnsi);
	return { accentAnsi, accentRgb, endRgb };
}

function workingGradientAnsi(gradient: ReturnType<typeof workingGradient>, index: number): string {
	if (!gradient.accentRgb || !gradient.endRgb) return gradient.accentAnsi;
	const wrapped = ((index % WORK_GRADIENT_RAMP_WIDTH) + WORK_GRADIENT_RAMP_WIDTH) % WORK_GRADIENT_RAMP_WIDTH;
	const segment = Math.floor(wrapped / WORK_CYCLING_WIDTH);
	const localIndex = wrapped % WORK_CYCLING_WIDTH;
	return segment === 1
		? gradientAnsi(gradient.endRgb, gradient.accentRgb, localIndex, WORK_CYCLING_WIDTH)
		: gradientAnsi(gradient.accentRgb, gradient.endRgb, localIndex, WORK_CYCLING_WIDTH);
}

function workingCellColors(gradient: ReturnType<typeof workingGradient>, offset: number): string[] {
	return Array.from({ length: WORK_CYCLING_WIDTH }, (_, i) => workingGradientAnsi(gradient, i + offset));
}

function renderWorkingFrame(colors: string[], chars: string[]): string {
	let out = "";
	for (let i = 0; i < WORK_CYCLING_WIDTH; i++) out += `${colors[i] ?? ""}${chars[i] ?? WORK_INITIAL_CHAR}`;
	return `${out}${ANSI_FG_RESET}`;
}

function randomWorkingChars(): string[] {
	return Array.from({ length: WORK_CYCLING_WIDTH }, () => WORK_RUNES[Math.floor(Math.random() * WORK_RUNES.length)] ?? WORK_INITIAL_CHAR);
}

function buildWorkingInitialFrames(gradient: ReturnType<typeof workingGradient>): string[] {
	return Array.from({ length: WORK_PRERENDERED_FRAMES }, (_, frame) =>
		renderWorkingFrame(workingCellColors(gradient, frame), Array.from({ length: WORK_CYCLING_WIDTH }, () => WORK_INITIAL_CHAR)),
	);
}

function buildWorkingLoopFrames(gradient: ReturnType<typeof workingGradient>): string[] {
	return Array.from({ length: WORK_PRERENDERED_FRAMES }, (_, frame) => renderWorkingFrame(workingCellColors(gradient, frame), randomWorkingChars()));
}

function visibleChars(frame: string): string[] {
	return stripAnsi(frame).slice(0, WORK_CYCLING_WIDTH).split("");
}

function buildWorkingStartupFrames(gradient: ReturnType<typeof workingGradient>, initialFrames: string[], loopFrames: string[]): string[] {
	const birthOffsets = Array.from({ length: WORK_CYCLING_WIDTH }, () => Math.random() * WORK_MAX_BIRTH_OFFSET_MS);
	return Array.from({ length: WORK_STARTUP_FRAMES }, (_, frame) => {
		const elapsedMs = frame * WORK_FRAME_MS;
		const initialChars = visibleChars(initialFrames[frame % initialFrames.length] ?? "");
		const cyclingChars = visibleChars(loopFrames[frame % loopFrames.length] ?? "");
		const chars = Array.from({ length: WORK_CYCLING_WIDTH }, (_, index) =>
			elapsedMs < (birthOffsets[index] ?? 0) ? (initialChars[index] ?? WORK_INITIAL_CHAR) : (cyclingChars[index] ?? WORK_INITIAL_CHAR),
		);
		return renderWorkingFrame(workingCellColors(gradient, frame), chars);
	});
}

function applyWorkingIndicator(pi: ExtensionAPI, ctx: ExtensionContext, startup = false): void {
	clearWorkingIndicatorTimer();
	const gradient = workingGradient(ctx.ui.theme, currentThinkingLevel(pi, ctx));
	const initialFrames = buildWorkingInitialFrames(gradient);
	const loopFrames = buildWorkingLoopFrames(gradient);
	ctx.ui.setWorkingMessage(WORK_HIDDEN_MESSAGE);

	if (startup) {
		ctx.ui.setWorkingIndicator({ frames: buildWorkingStartupFrames(gradient, initialFrames, loopFrames), intervalMs: WORK_FRAME_MS });
		const generation = workingIndicatorGeneration;
		workingIndicatorTimer = setTimeout(() => {
			if (generation !== workingIndicatorGeneration) return;
			workingIndicatorTimer = undefined;
			ctx.ui.setWorkingIndicator({ frames: loopFrames, intervalMs: WORK_FRAME_MS });
		}, WORK_STARTUP_SWITCH_MS);
		return;
	}

	ctx.ui.setWorkingIndicator({ frames: loopFrames, intervalMs: WORK_FRAME_MS });
}

export default function workingIndicator(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => applyWorkingIndicator(pi, ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		clearWorkingIndicatorTimer();
		ctx.ui.setWorkingIndicator();
		ctx.ui.setWorkingMessage();
	});
	pi.on("before_agent_start", (_event, ctx) => applyWorkingIndicator(pi, ctx, true));
	pi.on("model_select", (_event, ctx) => applyWorkingIndicator(pi, ctx));
}
