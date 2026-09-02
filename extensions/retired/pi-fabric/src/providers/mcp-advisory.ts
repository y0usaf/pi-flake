import path from "node:path";
import type { FabricMcpConfig } from "../config.js";
import type { FabricActionDescriptor, FabricToolAnnotations } from "../protocol.js";
import { sanitizeMcpRefPart } from "../ref-names.js";
import {
  McpDescriptorCacheStore,
  parseCachedServer,
  sameConfigLayers,
  statConfigLayers,
} from "./mcp-descriptor-cache.js";

const emptyObjectSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const normalizeSchema = (schema: unknown): Record<string, unknown> =>
  typeof schema === "object" && schema !== null && !Array.isArray(schema)
    ? schema as Record<string, unknown>
    : emptyObjectSchema;

export interface McpAdvisoryCacheOptions {
  cwd: string;
  projectRoot: string;
  config: FabricMcpConfig;
}

// Bootstrap-only cache read. It fingerprints files but never parses live MCP
// config, constructs a provider/runtime, imports mcporter, or contacts a server.
export const loadCachedMcpDescriptors = async (
  options: McpAdvisoryCacheOptions,
): Promise<FabricActionDescriptor[]> => {
  if (!options.config.enabled || !options.config.cache.enabled || !options.config.advisory) return [];
  const store = new McpDescriptorCacheStore(
    path.join(options.projectRoot, ".pi", "fabric", "mcp-cache.json"),
  );
  const [snapshot, layers] = await Promise.all([
    store.load(),
    statConfigLayers(options.cwd, options.config.configPath),
  ]);
  if (!snapshot || !sameConfigLayers(snapshot.layers, layers)) return [];

  const descriptors: FabricActionDescriptor[] = [];
  for (const [server, raw] of Object.entries(snapshot.servers)) {
    const cached = parseCachedServer(raw);
    if (!cached) continue;
    for (const tool of cached.tools) {
      const annotations = (tool as { annotations?: FabricToolAnnotations }).annotations;
      descriptors.push({
        name: `${server}.${tool.name}`,
        description: tool.description ?? `${tool.name} on MCP server ${server}`,
        inputSchema: normalizeSchema(tool.inputSchema),
        ...(tool.outputSchema ? { outputSchema: normalizeSchema(tool.outputSchema) } : {}),
        risk: "network",
        namespace: server,
        ...(annotations ? { annotations: { ...annotations } } : {}),
      });
    }
  }
  return descriptors;
};

// Advisory-facing view of an MCP descriptor: namespace gains the "mcp:"
// marker (distinct from extension source namespaces) and the action name uses
// the sanitized call path the model actually types in fabric_exec.
export const toMcpAdvisoryDescriptor = (
  descriptor: FabricActionDescriptor,
): FabricActionDescriptor => {
  const server = descriptor.namespace ?? "";
  const prefix = `${server}.`;
  const toolName = descriptor.name.startsWith(prefix)
    ? descriptor.name.slice(prefix.length)
    : descriptor.name;
  const safeServer = sanitizeMcpRefPart(server);
  return {
    ...descriptor,
    name: `${safeServer}.${sanitizeMcpRefPart(toolName)}`,
    namespace: `mcp:${safeServer}`,
  };
};
