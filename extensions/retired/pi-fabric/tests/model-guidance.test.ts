import { describe, expect, it } from "vitest";
import {
  FABRIC_EXECUTION_GUIDANCE_SLOT,
  normalizeFabricModelGuidance,
  parseFabricOwnedModelGuidance,
  resolveFabricModelGuidance,
  type FabricOwnedModelGuidance,
} from "../src/components/model-guidance.js";

const owned = (
  componentId: string,
  label: string,
  content: string,
  overrides: Partial<FabricOwnedModelGuidance> = {},
): FabricOwnedModelGuidance => ({
  componentId,
  component: componentId,
  revision: 1,
  label,
  models: ["deepseek/deepseek-*"],
  targets: ["main", "participant"],
  placement: "append",
  content,
  ...overrides,
});

describe("Fabric model guidance", () => {
  it("resolves a model-specific slot replacement and deterministic appends", () => {
    const result = resolveFabricModelGuidance([
      owned("zeta", "last", "Zeta addition"),
      owned("alpha", "z-last", "Alpha last addition"),
      owned("alpha", "a-first", "Alpha first addition"),
      owned("profile", "deepseek-profile", "Custom execution profile", {
        placement: "replace",
        slot: FABRIC_EXECUTION_GUIDANCE_SLOT,
        targets: ["main"],
      }),
    ], {
      model: "deepseek/deepseek-chat",
      target: "main",
      defaults: [{ slot: FABRIC_EXECUTION_GUIDANCE_SLOT, content: "Default execution profile" }],
    });

    expect(result.slotText).toBe("Custom execution profile");
    expect(result.appendText).toBe(
      "Alpha first addition\n\nAlpha last addition\n\nZeta addition",
    );
    expect(result.sources.map((source) => source.componentId)).toEqual([
      "profile",
      "alpha",
      "alpha",
      "zeta",
    ]);
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps the default slot for mismatched models and filters targets", () => {
    const guidance = [owned("flash", "flash", "Participant addition", {
      targets: ["participant"],
    })];
    expect(resolveFabricModelGuidance(guidance, {
      model: "anthropic/claude-sonnet",
      target: "main",
      defaults: [{ slot: FABRIC_EXECUTION_GUIDANCE_SLOT, content: "Default" }],
    })).toMatchObject({ slotText: "Default", appendText: "" });
    expect(resolveFabricModelGuidance(guidance, {
      model: "deepseek/deepseek-chat",
      target: "main",
      includeSlots: false,
    }).appendText).toBe("");
    expect(resolveFabricModelGuidance(guidance, {
      model: "deepseek/deepseek-chat",
      target: "participant",
      includeSlots: false,
    }).appendText).toBe("Participant addition");
  });

  it("fails loudly when two active components replace the same slot", () => {
    const guidance = ["first", "second"].map((componentId) => owned(
      componentId,
      "profile",
      componentId,
      { placement: "replace", slot: FABRIC_EXECUTION_GUIDANCE_SLOT },
    ));
    expect(() => resolveFabricModelGuidance(guidance, {
      model: "deepseek/deepseek-chat",
      target: "main",
      defaults: [{ slot: FABRIC_EXECUTION_GUIDANCE_SLOT, content: "Default" }],
    })).toThrow("multiple replacements");
  });

  it("validates bounded registrations and rejects malformed resident snapshots", () => {
    expect(() => normalizeFabricModelGuidance({
      label: "invalid",
      models: ["model-without-provider"],
      content: "content",
    })).toThrow("provider/model glob");
    expect(() => normalizeFabricModelGuidance({
      label: "invalid replacement",
      models: ["provider/*"],
      content: "content",
      placement: "replace",
    })).toThrow("requires a slot");
    expect(parseFabricOwnedModelGuidance([{ content: "injected" }])).toEqual([]);
    expect(parseFabricOwnedModelGuidance([
      owned("safe", "safe", "Safe guidance"),
    ])).toHaveLength(1);
  });
});
