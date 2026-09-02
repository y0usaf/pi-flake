import { FabricComponentLoader } from "../components/loader.js";
import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";

const descriptors: FabricActionDescriptor[] = [
  {
    name: "list",
    description: "List registered component definitions and configured component instances.",
    inputSchema: { type: "object", additionalProperties: false },
    risk: "read",
    effect: { kind: "none", resources: ["fabric:components"], ordering: "commutative" },
  },
  {
    name: "status",
    description: "Inspect one component's lifecycle state, committed capability target, and cleanup diagnostics.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1 } },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "read",
    effect: { kind: "none", resources: ["fabric:components"], ordering: "commutative" },
  },
  {
    name: "graph",
    description: "Inspect component requirement/provision edges and detected dependency cycles.",
    inputSchema: { type: "object", additionalProperties: false },
    risk: "read",
    effect: { kind: "none", resources: ["fabric:components"], ordering: "commutative" },
  },
  {
    name: "reload",
    description: "Restart one component, or all loaded components, with rollback to the previous revision on activation failure.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1 } },
      additionalProperties: false,
    },
    risk: "execute",
    effect: { kind: "transactional", resources: ["fabric:components"], ordering: "ordered" },
  },
];

export class ComponentsProvider implements FabricProvider {
  readonly name = "components";
  readonly description =
    "Supervised component lifecycle, exact capability dependencies, effect cleanup, and reload diagnostics.";

  constructor(readonly loader: FabricComponentLoader) {}

  async list(
    request: FabricProviderListRequest,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    const query = request.query?.normalize("NFKC").trim().toLowerCase();
    const filtered = query
      ? descriptors.filter((descriptor) =>
          `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query),
        )
      : descriptors;
    return filtered.slice(0, Math.max(1, Math.min(request.limit ?? 100, 100)));
  }

  async describe(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    return descriptors.find((descriptor) => descriptor.name === actionName);
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    _context: FabricInvocationContext,
  ): Promise<unknown> {
    switch (actionName) {
      case "list":
        return {
          definitions: this.loader.definitions(),
          components: this.loader.list(),
        };
      case "status": {
        const id = args.id;
        if (typeof id !== "string" || !id.trim()) throw new Error("components.status requires id");
        return this.loader.status(id);
      }
      case "graph":
        return this.loader.graph();
      case "reload": {
        const id = args.id;
        if (id !== undefined && (typeof id !== "string" || !id.trim())) {
          throw new Error("components.reload id must be a non-empty string");
        }
        return {
          components: await this.loader.reload(typeof id === "string" ? id : undefined),
        };
      }
      default:
        throw new Error(`Unknown components action: ${actionName}`);
    }
  }
}
