import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ExtensionFactory } from "../../harness-setup.ts";

const INIT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 2_000;

type Pending = { resolve: (result: unknown) => void; reject: (error: unknown) => void };

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

const donsetch: ExtensionFactory = async (host) => {
	const bin = process.env.DONSETCH_BIN;
	if (!bin) throw new Error("donsetch: DONSETCH_BIN is not set");
	const child = spawn(bin, ["mcp", "--supervised"], { stdio: ["pipe", "pipe", "ignore"] });
	const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
	const pending = new Map<number, Pending>();
	let nextId = 1;
	let failure: Error | undefined;
	const fail = (error: Error) => {
		failure ??= error;
		for (const entry of pending.values()) entry.reject(failure);
		pending.clear();
	};
	child.once("error", fail);
	child.once("exit", (code, signal) => fail(new Error(`donsetch: MCP server exited (${signal ?? code})`)));
	child.stdin.on("error", fail);
	createInterface({ input: child.stdout }).on("line", (line) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		const message = record(parsed);
		const id = message?.id;
		if (message === undefined || typeof id !== "number") return;
		const entry = pending.get(id);
		if (entry === undefined) return;
		pending.delete(id);
		const error = record(message.error);
		if (error) entry.reject(new Error(`donsetch: ${typeof error.message === "string" ? error.message : "MCP error"}`));
		else entry.resolve(message.result);
	});

	const send = (message: object) => {
		if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	};
	const request = (method: string, params: object, signal: AbortSignal): Promise<unknown> =>
		new Promise((resolve, reject) => {
			if (failure) return reject(failure);
			if (signal.aborted) return reject(signal.reason);
			const id = nextId++;
			const onAbort = () => {
				pending.delete(id);
				send({ method: "notifications/cancelled", params: { requestId: id, reason: String(signal.reason) } });
				reject(signal.reason);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			const settle = <T>(finish: (value: T) => void) => (value: T) => {
				signal.removeEventListener("abort", onAbort);
				finish(value);
			};
			pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
			send({ id, method, params });
		});

	host.onClose(async () => {
		child.stdin.end();
		child.kill("SIGTERM");
		const timer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
		await closed;
		clearTimeout(timer);
	});

	const init = AbortSignal.timeout(INIT_TIMEOUT_MS);
	await request(
		"initialize",
		{ protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "durapi-donsetch", version: "1.0.0" } },
		init,
	);
	send({ method: "notifications/initialized", params: {} });
	const listed = record(await request("tools/list", {}, init));
	const mcpTools = (Array.isArray(listed?.tools) ? listed.tools : []).flatMap((value: unknown) => {
		const tool = record(value);
		if (tool === undefined || typeof tool.name !== "string") return [];
		const description = typeof tool.description === "string" ? tool.description : tool.name;
		return [{ name: tool.name, description, inputSchema: record(tool.inputSchema) ?? { type: "object", properties: {} } }];
	});
	if (mcpTools.length === 0) throw new Error("donsetch: MCP server listed no tools");

	return defineExtension({
		name: "donsetch",
		tools: mcpTools.map((tool) =>
			defineTool({
				name: tool.name,
				description: tool.description,
				parameters: Type.Unsafe(tool.inputSchema),
				replay: "safe",
				execute: async (args, _api, context) => {
					const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
					const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, timeout]) : timeout;
					const result = record(await request("tools/call", { name: tool.name, arguments: args ?? {} }, signal));
					const blocks: unknown[] = Array.isArray(result?.content) ? result.content : [];
					const content = blocks.flatMap((block) => {
						const text = record(block)?.text;
						return typeof text === "string" ? [{ type: "text" as const, text }] : [];
					});
					return { content, isError: result?.isError === true, details: null };
				},
			}),
		),
	});
};

export default donsetch;
