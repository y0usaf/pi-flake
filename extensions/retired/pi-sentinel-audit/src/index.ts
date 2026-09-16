import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	applyStage2,
	buildAuditState,
	evaluateStage1,
	locateQuestions,
	reminderText,
	STAGE1_QUESTIONS,
	summarizeAudit,
	type AuditVerdict,
	type TranscriptMessage,
} from "./audit";
import { askJev, JevError, redact, rememberSecret } from "./client";
import {
	API_KEY_ENV,
	loadSentinelConfig,
	type LoadedSentinelConfig,
	type SentinelConfig,
} from "./config";

/**
 * pi-sentinel - detects where the agent goes off the rails.
 *
 * At turn end it hands the recent transcript to Jev and asks whether the work
 * still matches the user's request, whether any claim outruns the tool output
 * behind it, and whether the agent is repeating a failed approach. Only when
 * one of those trips does it pay for a second call that locates the first
 * deviating message and scores severity.
 *
 * The audit deliberately does not block. Jev cannot see the future and cannot
 * explain itself, so this is a watchtower, not a gate: it reports, and does not
 * rewrite the model's words. Enforcement lives in pi-jev, at tool_call, where
 * prevention is actually possible.
 */

const STATUS_KEY = "sentinel";
const ENTRY_TYPE = "sentinel-verdict";
const ERROR_NOTIFY_INTERVAL_MS = 60_000;
/** Do not remind about a finding older than this many turns. */
const REMINDER_FRESHNESS_TURNS = 2;
const MAX_LOCATION_CANDIDATES = 16;

export default function sentinelExtension(pi: ExtensionAPI): void {
	let loaded: LoadedSentinelConfig = loadSentinelConfig(process.cwd());
	let config: SentinelConfig = loaded.config;
	rememberSecret(config.apiKey);

	let enabled = config.enabled;
	let injecting = config.inject;
	let audits = 0;
	let turns = 0;
	let running = false;
	let last: AuditVerdict | undefined;
	let lastTurn = -1;
	let remindedFor: string | undefined;
	let lastErrorAt = 0;
	let missingKeyWarned = false;

	function reload(cwd: string): void {
		loaded = loadSentinelConfig(cwd);
		config = loaded.config;
		rememberSecret(config.apiKey);
		enabled = config.enabled;
		injecting = config.inject;
	}

	pi.on("session_start", async (_event, ctx) => {
		reload(ctx.cwd);
		for (const warning of loaded.warnings) {
			ctx.ui.notify(`pi-sentinel: ${redact(warning)}`, "warning");
		}
		if (!config.apiKey) {
			if (!missingKeyWarned) {
				missingKeyWarned = true;
				ctx.ui.notify(
					`pi-sentinel: no key. Set ${API_KEY_ENV} or apiKeyFile in pi-sentinel.json; the auditor is inactive until then.`,
					"warning",
				);
			}
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, "sentinel: idle");
	});

	// Not awaited: turn_end handlers run inside the agent loop, and a 300ms API
	// call there taxes every turn. The verdict lands during the next one.
	pi.on("turn_end", (_event, ctx) => {
		if (!enabled || !config.apiKey) return;
		turns += 1;
		if (turns % config.everyTurns !== 0) return;
		if (audits >= config.maxAudits) return;
		if (running || ctx.signal?.aborted) return;

		running = true;
		const run = auditTurn(ctx);
		void run
			.catch(() => {})
			.finally(() => {
				running = false;
			});
	});

	pi.on("before_agent_start", async () => {
		if (!enabled || !injecting || !last?.drifted) return;
		if (turns - lastTurn > REMINDER_FRESHNESS_TURNS) return;

		// One reminder per distinct finding: repeating it every turn would be
		// noise, and the model already has the previous one in context.
		const marker = last.firstDeviation ?? `severity-${last.severity ?? "unknown"}`;
		if (remindedFor === marker) return;
		remindedFor = marker;

		return {
			message: {
				customType: "pi-sentinel",
				content: reminderText(last),
				display: true,
			},
		};
	});

	async function auditTurn(ctx: ExtensionContext): Promise<void> {
		const apiKey = config.apiKey;
		if (!apiKey) return;

		const messages = collectMessages(ctx);
		if (messages.length < config.minMessages) return;

		const window = messages.slice(-config.windowMessages);
		const standings = collectStandings(
			messages.slice(0, Math.max(0, messages.length - window.length)),
		);

		try {
			const stage1 = await askJev({
				state: buildAuditState({
					cwd: ctx.cwd,
					messages: window,
					standings,
					maxStateChars: config.maxStateChars,
				}),
				questions: STAGE1_QUESTIONS,
				apiKey,
				model: config.model,
				endpoint: config.endpoint,
				timeoutMs: config.timeoutMs,
				retries: config.retries,
			});
			audits += 1;

			let verdict = evaluateStage1(stage1, config.thresholds, window.length);
			if (verdict.drifted) {
				const stage2 = await askJev({
					state: buildAuditState({
						cwd: ctx.cwd,
						messages: window,
						standings,
						maxStateChars: config.maxStateChars,
					}),
					questions: locateQuestions(locationLabels(window)),
					apiKey,
					model: config.model,
					endpoint: config.endpoint,
					timeoutMs: config.timeoutMs,
					retries: config.retries,
				});
				verdict = applyStage2(verdict, stage2);
			}

			last = verdict;
			lastTurn = turns;
			report(ctx, verdict);
		} catch (error) {
			notifyError(ctx, error);
		}
	}

	function report(ctx: ExtensionContext, verdict: AuditVerdict): void {
		if (!verdict.drifted) {
			ctx.ui.setStatus(STATUS_KEY, "sentinel: on task");
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, `sentinel: ${summarizeAudit(verdict)}`);
		ctx.ui.notify(`pi-sentinel: ${summarizeAudit(verdict)}`, "warning");
		pi.appendEntry(ENTRY_TYPE, {
			at: Date.now(),
			reasons: verdict.reasons,
			onTask: verdict.onTask,
			unsupportedClaim: verdict.unsupportedClaim,
			repeating: verdict.repeating,
			firstDeviation: verdict.firstDeviation,
			severity: verdict.severity,
			model: verdict.model,
		});
	}

	function notifyError(ctx: ExtensionContext, error: unknown): void {
		const at = Date.now();
		if (at - lastErrorAt < ERROR_NOTIFY_INTERVAL_MS) return;
		lastErrorAt = at;
		ctx.ui.setStatus(STATUS_KEY, "sentinel: error");
		ctx.ui.notify(
			`pi-sentinel: ${redact(error instanceof JevError ? error.message : String(error))}`,
			"error",
		);
	}

	pi.registerCommand("sentinel", {
		description: "Transcript drift auditor: status, on/off, inject, last, audit",
		handler: async (args, ctx) => {
			const [sub, value] = args.trim().toLowerCase().split(/\s+/);

			if (sub === "on" || sub === "off") {
				enabled = sub === "on";
				ctx.ui.setStatus(STATUS_KEY, enabled ? "sentinel: idle" : "sentinel: off");
				ctx.ui.notify(`pi-sentinel: ${sub}`, "info");
				return;
			}
			if (sub === "inject") {
				if (value !== "on" && value !== "off") {
					ctx.ui.notify(
						`pi-sentinel: inject is ${injecting ? "on" : "off"} (usage: /sentinel inject on|off)`,
						"warning",
					);
					return;
				}
				injecting = value === "on";
				ctx.ui.notify(`pi-sentinel: inject ${value}`, "info");
				return;
			}
			if (sub === "audit") {
				if (!config.apiKey) {
					ctx.ui.notify(`pi-sentinel: no key (${API_KEY_ENV} unset)`, "warning");
					return;
				}
				ctx.ui.notify("pi-sentinel: auditing…", "info");
				turns += 1;
				await auditTurn(ctx);
				if (!last) {
					ctx.ui.notify("pi-sentinel: no verdict", "info");
				} else {
					ctx.ui.notify(
						`pi-sentinel: ${last.drifted ? summarizeAudit(last) : "on task"} | on_task ${last.onTask.toFixed(2)}, unsupported_claim ${last.unsupportedClaim.toFixed(2)}, repeating ${last.repeating.toFixed(2)}`,
						"info",
					);
				}
				return;
			}
			if (sub === "last") {
				if (!last) {
					ctx.ui.notify("pi-sentinel: nothing audited yet", "info");
					return;
				}
				ctx.ui.notify(
					`pi-sentinel: ${last.drifted ? summarizeAudit(last) : "on task"} (${last.auditedMessages} messages, ${last.model})`,
					"info",
				);
				return;
			}

			const key = config.apiKey
				? config.apiKeyFile
					? `apiKeyFile ${config.apiKeyFile}`
					: "apiKey (inline)"
				: `missing (${API_KEY_ENV})`;
			ctx.ui.notify(
				`pi-sentinel: ${enabled ? "on" : "off"}, model ${config.model}, key ${key}, every ${config.everyTurns} turn(s), window ${config.windowMessages}, audits ${audits}/${config.maxAudits}, inject ${injecting ? "on" : "off"}`,
				"info",
			);
		},
	});
}

function collectMessages(ctx: ExtensionContext): TranscriptMessage[] {
	const messages: TranscriptMessage[] = [];
	for (const entry of ctx.sessionManager.buildContextEntries()) {
		if (entry.type !== "message") continue;
		const text = messageText(entry.message.content);
		if (!text) continue;
		messages.push({ id: entry.id, role: entry.message.role, content: text });
	}
	return messages;
}

/**
 * User instructions that fell out of the window. Without these, drift gets
 * measured against whatever is still visible instead of against the request.
 */
function collectStandings(older: TranscriptMessage[]): string[] {
	const standings: string[] = [];
	for (const message of older) {
		if (message.role !== "user") continue;
		if (message.content.length < 24) continue;
		standings.push(preview(message.content, 400));
	}
	// The earliest instructions define the task; cap so ancient chatter cannot
	// crowd out the state budget.
	return standings.slice(0, 3);
}

/**
 * Candidate messages for "where did it start going wrong". Only assistant
 * messages are offered: a deviation is something the agent did.
 */
function locationLabels(window: TranscriptMessage[]): Record<string, string> {
	const assistants = window.filter((message) => message.role === "assistant");
	const candidates = assistants.slice(-MAX_LOCATION_CANDIDATES);
	const labels: Record<string, string> = {};
	for (const message of candidates) {
		labels[message.id] = preview(message.content, 80);
	}
	return labels;
}

function messageText(content: unknown): string | undefined {
	if (typeof content === "string") return content.trim() || undefined;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const type = Reflect.get(block, "type");
		const text = Reflect.get(block, "text");
		if (type === "text" && typeof text === "string") parts.push(text);
	}
	const joined = parts.join("\n").trim();
	return joined || undefined;
}

function preview(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}\u2026` : oneLine;
}
