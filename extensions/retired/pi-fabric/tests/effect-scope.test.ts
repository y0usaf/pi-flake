import { describe, expect, it, vi } from "vitest";
import { FabricEffectScope } from "../src/components/effect-scope.js";

describe("FabricEffectScope", () => {
  it("disposes effects once in reverse registration order", async () => {
    const scope = new FabricEffectScope();
    const calls: string[] = [];
    const first = await scope.effect(() => () => { calls.push("first"); }, "first");
    await scope.effect(function* () {
      yield () => { calls.push("second-a"); };
      yield () => { calls.push("second-b"); };
    }, "second");

    expect(await scope.dispose()).toEqual({ status: "disposed", failures: [] });
    expect(calls).toEqual(["second-b", "second-a", "first"]);
    await first();
    await scope.dispose();
    expect(calls).toEqual(["second-b", "second-a", "first"]);
  });

  it("collects multiple disposers resolved by async setup", async () => {
    const scope = new FabricEffectScope();
    const calls: string[] = [];
    await scope.effect(async () => [
      () => { calls.push("first"); },
      () => { calls.push("second"); },
    ]);
    await scope.dispose();
    expect(calls).toEqual(["second", "first"]);
  });

  it("orders an effect's returned cleanup after nested registrations", async () => {
    const scope = new FabricEffectScope();
    const calls: string[] = [];
    await scope.effect(async () => {
      scope.defer(() => { calls.push("resource"); }, "resource");
      return () => { calls.push("owner"); };
    }, "owner");

    await scope.dispose();
    expect(calls).toEqual(["owner", "resource"]);
  });

  it("rolls back collected cleanup when setup fails", async () => {
    const scope = new FabricEffectScope();
    const cleanup = vi.fn();
    await expect(scope.effect(async function* () {
      yield cleanup;
      throw new Error("setup failed");
    }, "broken")).rejects.toThrow("setup failed");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(await scope.dispose()).toEqual({ status: "disposed", failures: [] });
  });

  it("reports cleanup failure encountered while rolling back setup", async () => {
    const scope = new FabricEffectScope();
    await expect(scope.effect(async function* () {
      yield () => { throw new Error("rollback leaked"); };
      throw new Error("setup failed");
    }, "broken-setup")).rejects.toThrow("setup and rollback failed");

    expect(await scope.dispose()).toEqual({
      status: "quarantined",
      failures: [{ label: "broken-setup", error: "rollback leaked" }],
    });
  });

  it("awaits in-flight setup when disposal starts reentrantly", async () => {
    const scope = new FabricEffectScope();
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const setup = scope.effect(async () => {
      await gate;
      return () => { calls.push("cleanup"); };
    }, "async");
    const disposal = scope.dispose();
    release();
    await setup;
    expect(await disposal).toEqual({ status: "disposed", failures: [] });
    expect(calls).toEqual(["cleanup"]);
  });

  it("continues cleanup and reports quarantine after disposer failures", async () => {
    const scope = new FabricEffectScope();
    const later = vi.fn();
    scope.defer(later, "later");
    scope.defer(() => { throw new Error("cannot release"); }, "broken");

    expect(await scope.dispose()).toEqual({
      status: "quarantined",
      failures: [{ label: "broken", error: "cannot release" }],
    });
    expect(later).toHaveBeenCalledOnce();
    expect(() => scope.defer(() => {})).toThrow(/disposing Fabric scope/);
  });

  it("diverts at a yield boundary and rolls back only landed iterations", async () => {
    let targetCurrent = true;
    const scope = new FabricEffectScope({ guard: () => targetCurrent });
    const calls: string[] = [];

    await expect(scope.effect(function* () {
      calls.push("first");
      targetCurrent = false;
      try {
        yield () => { calls.push("undo-first"); };
        calls.push("stale-continuation");
        yield () => { calls.push("undo-stale"); };
      } finally {
        calls.push("closed");
      }
    }, "guarded")).rejects.toThrow("target changed");

    expect(calls).toEqual(["first", "closed", "undo-first"]);
    expect(await scope.dispose()).toEqual({ status: "disposed", failures: [] });
  });

  it("lets an in-flight async iteration land before diversion", async () => {
    let targetCurrent = true;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = new Promise<void>((resolve) => { started = resolve; });
    const cleanup = vi.fn();
    const after = vi.fn();
    const scope = new FabricEffectScope({ guard: () => targetCurrent });

    const setup = scope.effect(async function* () {
      started();
      await gate;
      yield cleanup;
      after();
    }, "inertial");
    await active;
    targetCurrent = false;
    release();

    await expect(setup).rejects.toThrow("target changed");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(after).not.toHaveBeenCalled();
  });

  it("preserves diversion identity when iterator finalization fails", async () => {
    let targetCurrent = true;
    const cleanup = vi.fn();
    const scope = new FabricEffectScope({ guard: () => targetCurrent });
    let failure: unknown;
    try {
      await scope.effect(function* () {
        targetCurrent = false;
        try {
          yield cleanup;
        } finally {
          throw new Error("close failed");
        }
      }, "closing");
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: "FabricEffectDivertedError",
      cleanupError: expect.objectContaining({ message: "close failed" }),
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("reports declared installed effect footprints until disposal", async () => {
    const scope = new FabricEffectScope();
    await scope.effect(() => () => {}, {
      label: "workspace mutation",
      resources: ["workspace:a", "workspace:a"],
      ordering: "ordered",
    });

    expect(scope.footprint()).toEqual([{
      label: "workspace mutation",
      kind: "transactional",
      resources: ["workspace:a"],
      ordering: "ordered",
    }]);
    await scope.dispose();
    expect(scope.footprint()).toEqual([]);
  });
});
