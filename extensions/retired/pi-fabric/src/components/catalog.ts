import type {
  FabricComponentDefinition,
  FabricComponentDiscovery,
} from "./types.js";

export interface FabricComponentCatalogEntry {
  definition: FabricComponentDefinition;
  revision: number;
}

export interface FabricComponentCatalogEvent {
  name: string;
  current?: FabricComponentCatalogEntry;
  previous?: FabricComponentCatalogEntry;
}

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export class FabricComponentCatalog {
  readonly #definitions = new Map<string, FabricComponentCatalogEntry>();
  readonly #listeners = new Set<(event: FabricComponentCatalogEvent) => void>();

  readonly discovery: FabricComponentDiscovery = {
    version: 1,
    register: (component, options) => this.register(component, options),
  };

  register(
    definition: FabricComponentDefinition,
    options: { overwrite?: boolean } = {},
  ): void {
    if (!NAME_PATTERN.test(definition.name)) {
      throw new Error(`Invalid Fabric component name: ${definition.name}`);
    }
    if (typeof definition.activate !== "function") {
      throw new Error(`Fabric component ${definition.name} must define activate()`);
    }
    const previous = this.#definitions.get(definition.name);
    if (previous && !options.overwrite) {
      throw new Error(`Fabric component already registered: ${definition.name}`);
    }
    const current = {
      definition,
      revision: (previous?.revision ?? 0) + 1,
    };
    this.#definitions.set(definition.name, current);
    this.#emit({ name: definition.name, current, ...(previous ? { previous } : {}) });
  }

  unregister(name: string): FabricComponentDefinition | undefined {
    const previous = this.#definitions.get(name);
    if (!previous) return undefined;
    this.#definitions.delete(name);
    this.#emit({ name, previous });
    return previous.definition;
  }

  get(name: string): FabricComponentCatalogEntry | undefined {
    return this.#definitions.get(name);
  }

  list(): Array<FabricComponentCatalogEntry & { name: string }> {
    return [...this.#definitions.entries()]
      .map(([name, entry]) => ({ name, ...entry }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  clear(): void {
    for (const name of [...this.#definitions.keys()]) this.unregister(name);
  }

  subscribe(listener: (event: FabricComponentCatalogEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: FabricComponentCatalogEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Registration observers do not own the catalog mutation.
      }
    }
  }
}
