/**
 * pi-agents registry module: the per-session child registry created by
 * createRegistry() inside multiAgent() — the children map, reservedIds, all
 * subtree operations (getCallerState, isInSubtree, getSubtreeIds,
 * getScopedEntries, formatScopedAgentIds, getAccessibleTarget, killSubtree,
 * removeStateIfCurrent, listAgentsResult), and the session-shutdown teardown.
 * Per DESIGN.md: "The registry owns child lifecycle."
 *
 * No module-level state: every multiAgent() call creates its own registry via
 * createRegistry(), so multiple sessions stay isolated.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { modelLabel, settleWithGrace, type ChildState } from "./state.js";

export interface Registry {
	children: Map<string, ChildState>;
	/** IDs reserved by in-flight spawns that have not yet inserted into `children`. */
	reservedIds: Set<string>;
	getCallerState(callerId: string): ChildState;
	isInSubtree(targetId: string, ancestorId: string, allowSelf?: boolean): boolean;
	/** Depth-first preorder: root, then each child's subtree in id order. */
	getSubtreeIds(rootId: string): string[];
	getScopedEntries(callerId?: string): Array<[string, ChildState]>;
	formatScopedAgentIds(callerId?: string): string;
	getAccessibleTarget(callerId: string | undefined, targetId: string, action: string, allowSelf?: boolean): ChildState;
	killSubtree(rootId: string): { killedIds: string[]; reportCount: number };
	/** Remove exactly this state if it is still the registered one and has no active run. */
	removeStateIfCurrent(state: ChildState): void;
	listAgentsResult(callerId?: string): AgentToolResult<unknown>;
	/** session_shutdown teardown: mark all states killed, abort, settle with grace, clear. */
	shutdown(): Promise<void>;
}

export function createRegistry(): Registry {
	const children = new Map<string, ChildState>();
	/** IDs reserved by in-flight spawns that have not yet inserted into `children`. */
	const reservedIds = new Set<string>();

	function getCallerState(callerId: string): ChildState {
		const state = children.get(callerId);
		if (!state) throw new Error(`Caller agent "${callerId}" is no longer active.`);
		return state;
	}

	function isInSubtree(targetId: string, ancestorId: string, allowSelf = true): boolean {
		let current: string | undefined = targetId;
		while (current) {
			if (current === ancestorId) return allowSelf || current !== targetId;
			current = children.get(current)?.parentId;
		}
		return false;
	}

	/** Depth-first preorder: root, then each child's subtree in id order. */
	function getSubtreeIds(rootId: string): string[] {
		if (!children.has(rootId)) return [];
		const childIds = [...children.entries()]
			.filter(([, state]) => state.parentId === rootId)
			.map(([id]) => id)
			.sort((a, b) => a.localeCompare(b));
		return [rootId, ...childIds.flatMap((id) => getSubtreeIds(id))];
	}

	function getScopedEntries(callerId?: string): Array<[string, ChildState]> {
		const entries = [...children.entries()].filter(([id]) => !callerId || isInSubtree(id, callerId, true));
		entries.sort((a, b) => a[1].depth - b[1].depth || a[0].localeCompare(b[0]));
		return entries;
	}

	function formatScopedAgentIds(callerId?: string): string {
		const ids = getScopedEntries(callerId).map(([id]) => id);
		return ids.length > 0 ? ids.join(", ") : "(none)";
	}

	function getAccessibleTarget(callerId: string | undefined, targetId: string, action: string, allowSelf = false): ChildState {
		if (callerId) getCallerState(callerId);
		const state = children.get(targetId);
		if (!state || state.killed) {
			throw new Error(
				`Child agent "${targetId}" not found. Visible agents: ${formatScopedAgentIds(callerId)}. ` +
				`Call agent_list() for full status.`,
			);
		}
		if (!callerId) return state;
		if (!isInSubtree(targetId, callerId, allowSelf)) {
			throw new Error(
				`Agent "${callerId}" may only ${action} descendant agents in its own subtree. ` +
				`"${targetId}" is outside that subtree.`,
			);
		}
		return state;
	}

	/**
	 * Mark the subtree killed and abort its agents. States with no active run
	 * are removed immediately; a state whose run is in flight stays registered
	 * (as a killed tombstone) and is removed by that run's finally block once
	 * the prompt settles, so no work continues against an unregistered agent.
	 */
	function killSubtree(rootId: string): { killedIds: string[]; reportCount: number } {
		const ids = getSubtreeIds(rootId);
		let reportCount = 0;
		for (const id of ids) {
			const state = children.get(id);
			if (!state) continue;
			state.killed = true;
			reportCount += state.reports.length;
			state.agent.abort();
		}
		for (const id of ids) {
			const state = children.get(id);
			if (state && !state.locked) children.delete(id);
		}
		return { killedIds: ids, reportCount };
	}

	/** Remove exactly this state if it is still the registered one and has no active run. */
	function removeStateIfCurrent(state: ChildState): void {
		if (!state.locked && children.get(state.id) === state) {
			children.delete(state.id);
		}
	}

	function listAgentsResult(callerId?: string): AgentToolResult<unknown> {
		if (callerId) getCallerState(callerId);
		const agents = getScopedEntries(callerId).map(([id, state]) => ({
			id,
			status: state.agent.state.isStreaming || state.locked ? "running" : state.contract.pendingAsk ? `awaiting answers (${state.contract.pendingAsk.length}q, ${Math.round((Date.now() - (state.awaitingSince ?? Date.now())) / 1000)}s)` : "idle",
			model: modelLabel(state.agent),
			parentId: state.parentId,
			rootId: state.rootId,
			depth: state.depth,
			cwd: state.cwd,
			isRunning: state.agent.state.isStreaming || state.locked,
			pendingQuestionCount: state.contract.pendingAsk?.length ?? 0,
			awaitingSince: state.awaitingSince,
			contractFulfilled: state.contract.answers !== undefined,
			nudges: state.nudges,
			reportCount: state.reports.length,
			activityCount: state.activity.length,
			createdAt: state.createdAt,
		}));
		const text = agents.length === 0
			? "No active child agents."
			: agents.map((agent) =>
				`• ${agent.id} — ${agent.status}, depth ${agent.depth}, ` +
				`${agent.parentId ? `parent ${agent.parentId}` : "root child"}, ${agent.model}, ${agent.reportCount} reports` +
				`${agent.nudges > 0 ? `, ${agent.nudges} nudges` : ""}, contract ${agent.contractFulfilled ? "fulfilled" : "pending"}`,
			).join("\n");
		return { content: [{ type: "text", text }], details: { agents } };
	}

	async function shutdown(): Promise<void> {
		const states = [...children.values()];
		for (const state of states) {
			state.killed = true;
			state.agent.abort();
		}
		await settleWithGrace(states.map((state) => state.agent.waitForIdle()));
		children.clear();
	}

	return {
		children,
		reservedIds,
		getCallerState,
		isInSubtree,
		getSubtreeIds,
		getScopedEntries,
		formatScopedAgentIds,
		getAccessibleTarget,
		killSubtree,
		removeStateIfCurrent,
		listAgentsResult,
		shutdown,
	};
}
