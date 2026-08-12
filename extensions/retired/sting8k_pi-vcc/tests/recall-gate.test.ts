import { describe, it, expect } from "bun:test";
import { hasPiVccCompaction } from "../src/tools/recall-gate";

describe("hasPiVccCompaction", () => {
  it("returns false for empty branch", () => {
    expect(hasPiVccCompaction([])).toBe(false);
  });

  it("returns false for branch without compaction entries", () => {
    expect(hasPiVccCompaction([{ type: "message" }, { type: "message" }])).toBe(false);
  });

  it("returns false for core (non-pi-vcc) compaction entries", () => {
    expect(hasPiVccCompaction([{ type: "compaction" }])).toBe(false);
    expect(hasPiVccCompaction([{ type: "compaction", details: null }])).toBe(false);
    expect(hasPiVccCompaction([{ type: "compaction", details: {} }])).toBe(false);
  });

  it("returns true for pi-vcc compaction entries", () => {
    expect(
      hasPiVccCompaction([
        { type: "message" },
        { type: "compaction", details: { compactor: "pi-vcc" } },
      ]),
    ).toBe(true);
  });
});
