/** Tracks rendered fabric_exec cards so a display preference switch redraws the current transcript. */
export class FabricToolDisplayController {
  readonly #invalidators = new Map<string, {
    call?: () => void;
    result?: () => void;
  }>();

  observe(
    toolCallId: string,
    kind: "call" | "result",
    invalidate: () => void,
  ): void {
    const invalidators = this.#invalidators.get(toolCallId) ?? {};
    invalidators[kind] = invalidate;
    this.#invalidators.set(toolCallId, invalidators);
  }

  refresh(): void {
    for (const { call, result } of this.#invalidators.values()) {
      for (const invalidate of [call, result]) {
        if (!invalidate) continue;
        try {
          invalidate();
        } catch {
          // A transcript component may already have been disposed.
        }
      }
    }
  }

  clear(): void {
    this.#invalidators.clear();
  }
}
