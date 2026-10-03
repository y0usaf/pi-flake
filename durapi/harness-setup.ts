import { pathToFileURL } from "node:url";
import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	createRegistry,
	type EnvTarget,
	type Extension,
	type HarnessSettings,
	type ModelRef,
	type Registry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { applyHttpProxySettings, configureHttpDispatcher } from "@earendil-works/pi-coding-agent/core/http-dispatcher.ts";
import { findInitialModel, resolveCliModel } from "@earendil-works/pi-coding-agent/core/model-resolver.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent/core/model-runtime.ts";
import type { SettingsManager } from "@earendil-works/pi-coding-agent/core/settings-manager.ts";
import { createPiPrompt } from "./prompt.ts";

/** pi's HTTP setup: proxy, idle timeouts, and one undici for fetch. Without it, some provider streams break off. */
export function configureHarnessHttp(settingsManager: SettingsManager): void {
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
}

/** Harness settings read at every use from pi's settings as loaded at startup. */
export function createHarnessSettings(settingsManager: SettingsManager): HarnessSettings {
	return {
		get stream() {
			const provider = settingsManager.getProviderRetrySettings();
			const idle = settingsManager.getHttpIdleTimeoutMs();
			return {
				timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
				maxRetryDelayMs: provider.maxRetryDelayMs,
				...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
			};
		},
		get compaction() {
			return settingsManager.getCompactionSettings();
		},
		get retry() {
			return settingsManager.getRetrySettings();
		},
		get steeringMode() {
			return settingsManager.getSteeringMode();
		},
		get followUpMode() {
			return settingsManager.getFollowUpMode();
		},
	};
}

/** A registry with pi's coding tools and system prompt. */
export function createCodingRegistry(settingsManager: SettingsManager, cwd: string): Registry {
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(
		createPiPrompt(settingsManager, cwd, () =>
			registry
				.snapshot()
				.tools()
				.map(({ tool }) => tool.name),
		),
	);
	return registry;
}

export interface ExtensionHost {
	readonly cwd: string;
	readonly settingsManager: SettingsManager;
	readonly modelRuntime: ModelRuntime;
	onClose(cleanup: () => void | Promise<void>): void;
}

export type ExtensionFactory = (host: ExtensionHost) => Extension | Promise<Extension>;

export async function loadExtensions(paths: readonly string[], host: ExtensionHost): Promise<Extension[]> {
	const extensions: Extension[] = [];
	for (const path of paths) {
		const loaded: { readonly default?: unknown } = await import(pathToFileURL(path).href);
		if (typeof loaded.default !== "function") {
			throw new Error(`Extension ${path} must default-export a factory function`);
		}
		extensions.push(await (loaded.default as ExtensionFactory)(host));
	}
	return extensions;
}

export async function closeAll(cleanups: readonly (() => void | Promise<void>)[]): Promise<void> {
	const errors: unknown[] = [];
	for (const cleanup of cleanups.toReversed()) {
		try {
			await cleanup();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length > 0) throw new AggregateError(errors, "Extension cleanup failed");
}

/** One execution environment per directory, shared by every conversation in it. */
export class ExecutionEnvs {
	readonly #defaultCwd: string;
	readonly #envs = new Map<string, NodeExecutionEnv>();

	constructor(defaultCwd: string) {
		this.#defaultCwd = defaultCwd;
	}

	readonly env = ({ cwd = this.#defaultCwd }: EnvTarget): NodeExecutionEnv => {
		let env = this.#envs.get(cwd);
		if (env === undefined) {
			env = new NodeExecutionEnv({ cwd });
			this.#envs.set(cwd, env);
		}
		return env;
	};

	async cleanup(context: Context): Promise<void> {
		const envs = [...this.#envs.values()];
		this.#envs.clear();
		for (const env of envs) await env.cleanup(context);
	}
}

export interface InitialModel {
	readonly model?: ModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
	readonly fallbackMessage?: string;
}

/** The model a new root conversation starts with: an explicit `--provider`/`--model`, or pi's default resolution. */
export async function findInitialAgentModel(
	settingsManager: SettingsManager,
	modelRuntime: ModelRuntime,
	cli?: { readonly provider?: string; readonly model: string },
): Promise<InitialModel> {
	if (cli !== undefined) {
		const resolved = resolveCliModel({ cliProvider: cli.provider, cliModel: cli.model, modelRuntime });
		if (resolved.error !== undefined || resolved.model === undefined) {
			throw new Error(`Could not resolve model: ${resolved.error ?? cli.model}`);
		}
		return {
			model: { provider: resolved.model.provider, modelId: resolved.model.id },
			...(resolved.thinkingLevel === undefined ? {} : { thinkingLevel: resolved.thinkingLevel }),
		};
	}
	const initial = await findInitialModel({
		scopedModels: [],
		isContinuing: false,
		defaultProvider: settingsManager.getDefaultProvider(),
		defaultModelId: settingsManager.getDefaultModel(),
		defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
		modelRuntime,
	});
	return {
		...(initial.model === undefined
			? {}
			: {
					model: { provider: initial.model.provider, modelId: initial.model.id },
					thinkingLevel: initial.thinkingLevel,
				}),
		...(initial.fallbackMessage === undefined ? {} : { fallbackMessage: initial.fallbackMessage }),
	};
}
