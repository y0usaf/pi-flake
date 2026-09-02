import { describe, expect, it } from "vitest";
import { extensionToolRosterGuidance } from "../src/core/system-guidance.js";

const entry = (name: string, description?: string) => ({
  name,
  ...(description === undefined ? { definition: {} } : { definition: { description } }),
});

describe("extensionToolRosterGuidance", () => {
  it("lists extension tools with first-line descriptions", () => {
    const roster = extensionToolRosterGuidance(
      [entry("deploy_release", "Deploys the release.\nSecond line"), entry("ctx_read", "Reads context")],
      new Set(["read", "bash"]),
    );
    expect(roster).toContain("`extensions.deploy_release()`: Deploys the release.");
    expect(roster).toContain("`extensions.ctx_read()`");
    expect(roster).not.toContain("Second line");
    expect(roster).toContain("extensions.list");
  });

  it("excludes captured core overrides and empty catalogs", () => {
    expect(extensionToolRosterGuidance([entry("read", "core override")], new Set(["read"]))).toBeUndefined();
    expect(extensionToolRosterGuidance([], new Set())).toBeUndefined();
  });

  it("truncates overly long descriptions", () => {
    const roster = extensionToolRosterGuidance(
      [entry("big", "x".repeat(300))],
      new Set(),
    );
    expect(roster).not.toContain("x".repeat(121));
    expect(roster).toContain("x".repeat(120));
  });
});
