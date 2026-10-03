import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook, type PromptInput, section } from "@earendil-works/pi-durable";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent/config.ts";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent/core/resource-loader.ts";
import type { SettingsManager } from "@earendil-works/pi-coding-agent/core/settings-manager.ts";
import { loadSkills, type Skill } from "@earendil-works/pi-coding-agent/core/skills.ts";
import { buildSystemPromptSections } from "@earendil-works/pi-coding-agent/core/system-prompt.ts";
import { bashToolSystemPromptContribution } from "@earendil-works/pi-coding-agent/core/tools/bash.ts";
import { editToolSystemPromptContribution } from "@earendil-works/pi-coding-agent/core/tools/edit.ts";
import { readToolSystemPromptContribution } from "@earendil-works/pi-coding-agent/core/tools/read.ts";
import { writeToolSystemPromptContribution } from "@earendil-works/pi-coding-agent/core/tools/write.ts";

const CONTRIBUTIONS = {
	read: readToolSystemPromptContribution,
	bash: bashToolSystemPromptContribution,
	edit: editToolSystemPromptContribution,
	write: writeToolSystemPromptContribution,
};

/** pi's section order; `buildSystemPromptSections()` omits the ones without content. */
const KEYS = ["preamble", "tools", "rules", "docs", "addendum", "project_context", "skills", "cwd"] as const;

function leadWithSystemPrompt(messages: readonly Message[]): { readonly messages: readonly Message[] } | undefined {
	const index = messages.findIndex((message) => message.role === "system");
	const system = messages[index];
	if (index <= 0 || system === undefined) return undefined;
	if (messages.slice(0, index).some((message) => message.role === "assistant")) return undefined;
	return { messages: [system, ...messages.slice(0, index), ...messages.slice(index + 1)] };
}

/**
 * pi's system prompt as one extension: the sections of `buildSystemPromptSections()` for the request's tools and the
 * conversation's directory. Context files and skills load once per directory, like pi at startup.
 */
export function createPiPrompt(settings: SettingsManager, fallbackCwd: string) {
	const resources = new Map<
		string,
		{
			contextFiles: { path: string; content: string }[];
			skills: Skill[];
			customPrompt?: string;
			appendSystemPrompt?: string;
		}
	>();
	const promptFile = (cwd: string, agentDir: string, name: string): string | undefined => {
		const project = join(cwd, CONFIG_DIR_NAME, name);
		const path = settings.isProjectTrusted() && existsSync(project) ? project : join(agentDir, name);
		return existsSync(path) ? readFileSync(path, "utf-8").replace(/^\uFEFF/u, "") : undefined;
	};
	const load = (cwd: string) => {
		let found = resources.get(cwd);
		if (found === undefined) {
			const agentDir = getAgentDir();
			const customPrompt = promptFile(cwd, agentDir, "SYSTEM.md");
			const appendSystemPrompt = promptFile(cwd, agentDir, "APPEND_SYSTEM.md");
			found = {
				contextFiles: loadProjectContextFiles({ cwd, agentDir }),
				skills: loadSkills({ cwd, agentDir, skillPaths: settings.getSkillPaths(), includeDefaults: true }).skills,
				...(customPrompt === undefined ? {} : { customPrompt }),
				...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
			};
			resources.set(cwd, found);
		}
		return found;
	};
	// The sections of one request render from one build.
	const built = new WeakMap<PromptInput, Record<string, string>>();
	const build = (input: PromptInput): Record<string, string> => {
		let sections = built.get(input);
		if (sections === undefined) {
			sections = buildSections(input);
			built.set(input, sections);
		}
		return sections;
	};
	const buildSections = (input: PromptInput): Record<string, string> => {
		const cwd = input.env?.cwd ?? input.agent.cwd ?? fallbackCwd;
		const selectedTools = input.agent.tools.map((tool) => tool.name);
		const snippets: Record<string, string> = {};
		const guidelines: Record<string, string[]> = {};
		for (const name of selectedTools) {
			const contribution = CONTRIBUTIONS[name as keyof typeof CONTRIBUTIONS];
			if (contribution === undefined) continue;
			snippets[name] = contribution.snippet;
			guidelines[name] = [...contribution.guidelines];
		}
		return buildSystemPromptSections({
			cwd,
			selectedTools,
			toolSnippets: snippets,
			toolGuidelines: guidelines,
			...load(cwd),
		});
	};
	return defineExtension({
		name: "pi-prompt",
		// The built sections carry their own tags.
		sections: KEYS.map((key) => section(key, (input) => build(input)[key], { tag: false })),
		hooks: [hook(GenerationTask, { beforeRequest: ({ messages }) => leadWithSystemPrompt(messages) })],
	});
}
