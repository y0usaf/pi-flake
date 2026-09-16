/**
 * TypeSafe Jev client - slim, self-contained copy.
 *
 * This package installs independently of any other Jev extension, so it cannot
 * import their code. That means a second copy of the protocol, which is the
 * deliberate cost of zero coupling: either extension can be removed without
 * touching the other's load path.
 *
 * Kept to the minimum the auditor needs: one request, retries, typed answers,
 * and key redaction for notification text.
 */

export const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_RETRIES = 2;

export type JevState = string | Record<string, unknown> | unknown[];

/** Yes/no question. Returns the probability that the answer is yes. */
export interface NoulQuestion {
	type: "noul";
	instructions: string;
	criteria?: {
		true?: string;
		false?: string;
	};
}

export interface ChoiceQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
	type: "score";
	instructions: string;
	criteria: string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
	type: "noul";
	noul: number;
}

export interface ChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface ScoreAnswer {
	type: "score";
	score: number;
	legend: Record<string, string>;
	probabilities: Record<string, number>;
	confidence: number;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevUsage {
	input_tokens?: number;
	output_tokens?: number;
}

export interface JevResponse {
	model: string;
	answers: Record<string, JevAnswer>;
	usage?: JevUsage;
}

export interface JevCall {
	state: JevState;
	questions: Record<string, JevQuestion>;
	apiKey: string;
	model?: string;
	endpoint?: string;
	timeoutMs?: number;
	retries?: number;
	signal?: AbortSignal;
}

export class JevError extends Error {
	readonly status: number | undefined;
	readonly retryable: boolean;

	constructor(message: string, status?: number, retryable = false) {
		super(message);
		this.name = "JevError";
		this.status = status;
		this.retryable = retryable;
	}
}

export async function askJev(call: JevCall): Promise<JevResponse> {
	const endpoint = call.endpoint ?? DEFAULT_ENDPOINT;
	const body = JSON.stringify({
		state: call.state,
		model: call.model ?? DEFAULT_MODEL,
		questions: call.questions,
	});
	const retries = call.retries ?? DEFAULT_RETRIES;
	let lastError: JevError | undefined;

	for (let attempt = 0; attempt <= retries; attempt += 1) {
		if (call.signal?.aborted) break;
		if (attempt > 0) await delay(backoffMs(attempt), call.signal);
		try {
			return await postOnce(endpoint, body, call);
		} catch (error) {
			const failure = asJevError(error);
			lastError = failure;
			if (!failure.retryable) throw failure;
		}
	}

	throw lastError ?? new JevError("request aborted", undefined, false);
}

async function postOnce(
	endpoint: string,
	body: string,
	call: JevCall,
): Promise<JevResponse> {
	const timeoutMs = call.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const timeout = new AbortController();
	const timer = setTimeout(
		() =>
			timeout.abort(
				new JevError(`request timed out after ${timeoutMs}ms`, undefined, true),
			),
		timeoutMs,
	);

	try {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${call.apiKey}`,
				"Content-Type": "application/json",
			},
			body,
			signal: combineSignals([timeout.signal, ...(call.signal ? [call.signal] : [])]),
		});
		const text = await response.text();

		if (!response.ok) {
			const retryable =
				response.status === 429 || response.status === 529 || response.status >= 500;
			throw new JevError(
				`HTTP ${response.status}: ${truncate(text, 400)}`,
				response.status,
				retryable,
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new JevError(`response was not JSON: ${truncate(text, 200)}`);
		}
		return normalizeResponse(parsed);
	} finally {
		clearTimeout(timer);
	}
}

function normalizeResponse(value: unknown): JevResponse {
	if (typeof value !== "object" || value === null) {
		throw new JevError("response was not an object");
	}
	const answers = Reflect.get(value, "answers");
	if (typeof answers !== "object" || answers === null) {
		throw new JevError("response is missing the answers map");
	}
	for (const [id, answer] of Object.entries(answers)) {
		if (!isJevAnswer(answer)) {
			throw new JevError(`answer "${id}" has an unknown shape`);
		}
	}
	const model = Reflect.get(value, "model");
	const usage = Reflect.get(value, "usage");
	// Invariant: every entry above passed isJevAnswer, so the map is typed.
	return {
		model: typeof model === "string" ? model : DEFAULT_MODEL,
		answers: answers as Record<string, JevAnswer>,
		usage: isUsage(usage) ? usage : undefined,
	};
}

function isJevAnswer(value: unknown): value is JevAnswer {
	if (typeof value !== "object" || value === null) return false;
	const type: unknown = Reflect.get(value, "type");
	if (type === "noul") return typeof Reflect.get(value, "noul") === "number";
	if (type === "choice") return typeof Reflect.get(value, "choice") === "string";
	if (type === "score") return typeof Reflect.get(value, "score") === "number";
	return false;
}

function isUsage(value: unknown): value is JevUsage {
	if (typeof value !== "object" || value === null) return false;
	const input = Reflect.get(value, "input_tokens");
	const output = Reflect.get(value, "output_tokens");
	return (
		(input === undefined || typeof input === "number") &&
		(output === undefined || typeof output === "number")
	);
}

/** Abort when any source aborts. Local helper: no dependency on AbortSignal.any. */
function combineSignals(sources: AbortSignal[]): AbortSignal {
	const controller = new AbortController();
	for (const source of sources) {
		if (source.aborted) {
			controller.abort(source.reason);
			break;
		}
		source.addEventListener(
			"abort",
			() => {
				if (!controller.signal.aborted) controller.abort(source.reason);
			},
			{ once: true },
		);
	}
	return controller.signal;
}

function asJevError(error: unknown): JevError {
	if (error instanceof JevError) return error;
	/** fetch() surfaces a caller or deadline abort as the abort reason. */
	if (
		error instanceof Error &&
		(error.name === "AbortError" || error.name === "TimeoutError")
	) {
		const reason = Reflect.get(error, "cause");
		return reason instanceof JevError
			? reason
			: new JevError("request aborted", undefined, false);
	}
	return new JevError(
		error instanceof Error ? error.message : String(error),
		undefined,
		true,
	);
}

function backoffMs(attempt: number): number {
	const base = Math.min(1000 * 2 ** (attempt - 1), 8000);
	return base + Math.floor(Math.random() * 250);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			resolve();
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function truncate(text: string, max: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max)}\u2026` : collapsed;
}

export function answerFor(
	response: JevResponse,
	id: string,
): JevAnswer | undefined {
	return response.answers[id];
}

/** Probability that a noul answered yes, or undefined if the id is not a noul. */
export function noulValue(
	response: JevResponse,
	id: string,
): number | undefined {
	const answer = response.answers[id];
	return answer?.type === "noul" ? answer.noul : undefined;
}

/** Noul answers carry no confidence; only choice and score do. */
export function confidenceFor(
	response: JevResponse,
	id: string,
): number | undefined {
	const answer = response.answers[id];
	return answer && answer.type !== "noul" ? answer.confidence : undefined;
}

/**
 * Secrets observed this process, so no notification can leak the API key back
 * into the session transcript.
 */
const secrets = new Set<string>();

export function rememberSecret(secret: string | undefined): void {
	if (secret && secret.trim().length >= 8) secrets.add(secret.trim());
}

export function redact(text: string): string {
	let out = text;
	for (const secret of secrets) out = out.split(secret).join("[redacted]");
	return out;
}
