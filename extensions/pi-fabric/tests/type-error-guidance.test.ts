import { describe, expect, it } from "vitest";
import { typeErrorRecoveryHint } from "../src/type-error-guidance.js";

describe("typeErrorRecoveryHint", () => {
  it("guides malformed edit payloads toward named strings", () => {
    expect(typeErrorRecoveryHint(
      'await pi.edit({ path: "x", oldText: "a", newText: "broken });',
      [{ line: 1, column: 55, message: "Unterminated string literal." }],
    )).toContain("top-level `strings`");
  });

  it("stays absent for semantic errors and unrelated code", () => {
    expect(typeErrorRecoveryHint(
      'await pi.edit({ path: "x", all: true });',
      [{ line: 1, column: 15, message: "Property oldText is missing." }],
    )).toBeUndefined();
    expect(typeErrorRecoveryHint(
      "return missingValue;",
      [{ line: 1, column: 8, message: "':' expected." }],
    )).toBeUndefined();
  });
});
