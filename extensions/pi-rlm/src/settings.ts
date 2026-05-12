import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type RlmModelRole = "default" | "root" | "llm" | "rlm";

export interface RlmSettings {
  model?: string;
  provider?: string;
  modelId?: string;
  models?: string[];
  maxConcurrent?: number;
  maxDepth?: number;
  /** When true/default, root pi-rlm sessions are switched to the configured root/default model before each agent turn. */
  enforceRootModel?: boolean;
  roleModels?: Partial<Record<RlmModelRole, string>>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function integerLimit(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.trunc(v);
}

function providerModel(provider: unknown, model: unknown): string | undefined {
  const p = nonEmptyString(provider);
  const m = nonEmptyString(model);
  if (!m) return undefined;
  if (!p || m.includes("/")) return m;
  return `${p}/${m}`;
}

function parseModels(raw: unknown): { models?: string[]; roleModels?: Partial<Record<RlmModelRole, string>> } {
  if (Array.isArray(raw)) {
    const models = raw.map(nonEmptyString).filter((v): v is string => Boolean(v));
    return models.length ? { models } : {};
  }
  if (!isRecord(raw)) return {};

  const roleModels: Partial<Record<RlmModelRole, string>> = {};
  const def = nonEmptyString(raw.default) ?? providerModel(raw.provider, raw.modelId ?? raw.model) ?? nonEmptyString(raw.model) ?? nonEmptyString(raw.modelId);
  const root = nonEmptyString(raw.root) ?? nonEmptyString(raw.coordinator) ?? nonEmptyString(raw.orchestrator) ?? nonEmptyString(raw.rootModel) ?? nonEmptyString(raw.coordinatorModel) ?? nonEmptyString(raw.orchestratorModel);
  const llm = nonEmptyString(raw.llm) ?? nonEmptyString(raw.leaf) ?? nonEmptyString(raw.llmModel);
  const rlm = nonEmptyString(raw.rlm) ?? nonEmptyString(raw.child) ?? nonEmptyString(raw.rlmModel) ?? nonEmptyString(raw.childModel);
  if (def) roleModels.default = def;
  if (root) roleModels.root = root;
  if (llm) roleModels.llm = llm;
  if (rlm) roleModels.rlm = rlm;
  return Object.keys(roleModels).length ? { roleModels } : {};
}

export function parseRlmSettings(raw: unknown): RlmSettings {
  if (typeof raw === "string" && raw.trim()) return { models: [raw.trim()] };
  if (!isRecord(raw)) return {};

  const model = providerModel(raw.provider, raw.modelId ?? raw.model) ?? nonEmptyString(raw.model) ?? nonEmptyString(raw.modelId);
  const parsedModels = parseModels(raw.models);
  const roleModels: Partial<Record<RlmModelRole, string>> = { ...parsedModels.roleModels };

  const root = nonEmptyString(raw.root) ?? nonEmptyString(raw.coordinator) ?? nonEmptyString(raw.orchestrator) ?? nonEmptyString(raw.rootModel) ?? nonEmptyString(raw.coordinatorModel) ?? nonEmptyString(raw.orchestratorModel);
  const llm = nonEmptyString(raw.llmModel) ?? nonEmptyString(raw.leafModel);
  const rlm = nonEmptyString(raw.rlmModel) ?? nonEmptyString(raw.childModel);
  const maxConcurrent = integerLimit(raw.maxConcurrent ?? raw.max_concurrent ?? raw.max_concurrent_subcalls);
  const maxDepth = integerLimit(raw.maxDepth ?? raw.max_depth);
  const enforceRootModel = typeof raw.enforceRootModel === "boolean"
    ? raw.enforceRootModel
    : typeof raw.forceRootModel === "boolean"
      ? raw.forceRootModel
      : typeof raw.rootModelEnforced === "boolean"
        ? raw.rootModelEnforced
        : undefined;
  if (root) roleModels.root = root;
  if (llm) roleModels.llm = llm;
  if (rlm) roleModels.rlm = rlm;

  return {
    model,
    provider: nonEmptyString(raw.provider),
    modelId: nonEmptyString(raw.modelId),
    models: parsedModels.models,
    maxConcurrent,
    maxDepth,
    enforceRootModel,
    roleModels: Object.keys(roleModels).length ? roleModels : undefined,
  };
}

function pickSettings(parsed: Record<string, unknown>): unknown {
  const extensionSettings = parsed.extensionSettings;
  if (!isRecord(extensionSettings)) return undefined;
  return extensionSettings["pi-rlm"] ?? extensionSettings.rlm;
}

function readSettingsFile(path: string): RlmSettings {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!isRecord(parsed)) return {};
    return parseRlmSettings(pickSettings(parsed));
  } catch {
    return {};
  }
}

function mergeRoleModels(
  base?: Partial<Record<RlmModelRole, string>>,
  override?: Partial<Record<RlmModelRole, string>>,
): Partial<Record<RlmModelRole, string>> | undefined {
  const merged: Partial<Record<RlmModelRole, string>> = { ...(base ?? {}) };
  if (override) {
    for (const [role, model] of Object.entries(override) as Array<[RlmModelRole, string | undefined]>) {
      if (typeof model === "string" && model.trim()) {
        merged[role] = model.trim();
      }
    }
  }
  return Object.keys(merged).length ? merged : undefined;
}

function mergeRlmSettings(base: RlmSettings, override: RlmSettings): RlmSettings {
  const roleModels = mergeRoleModels(base.roleModels, override.roleModels);
  const overrideHasGeneralModel = override.model !== undefined || (override.models?.length ?? 0) > 0;
  if (roleModels && overrideHasGeneralModel) {
    for (const role of ["default", "root", "llm", "rlm"] as RlmModelRole[]) {
      if (override.roleModels?.[role] === undefined) delete roleModels[role];
    }
  }

  return {
    model: override.model !== undefined ? override.model : (override.models?.length ? undefined : base.model),
    provider: override.provider ?? base.provider,
    modelId: override.modelId ?? base.modelId,
    models: override.models?.length ? override.models : base.models,
    maxConcurrent: override.maxConcurrent ?? base.maxConcurrent,
    maxDepth: override.maxDepth ?? base.maxDepth,
    enforceRootModel: override.enforceRootModel ?? base.enforceRootModel,
    roleModels: roleModels && Object.keys(roleModels).length ? roleModels : undefined,
  };
}

export function loadRlmSettings(cwd: string): RlmSettings {
  return mergeRlmSettings(
    readSettingsFile(join(getAgentDir(), "settings.json")),
    readSettingsFile(join(cwd, ".pi", "settings.json")),
  );
}

export function modelSelectorForRole(settings: RlmSettings, role: RlmModelRole = "default"): string | undefined {
  if (role === "root") {
    return settings.roleModels?.root
      ?? settings.roleModels?.default
      ?? settings.model
      ?? settings.models?.[0]
      ?? settings.roleModels?.rlm
      ?? settings.roleModels?.llm
      ?? providerModel(settings.provider, settings.modelId);
  }

  return settings.roleModels?.[role]
    ?? settings.roleModels?.default
    ?? settings.model
    ?? settings.models?.[0]
    ?? providerModel(settings.provider, settings.modelId);
}
