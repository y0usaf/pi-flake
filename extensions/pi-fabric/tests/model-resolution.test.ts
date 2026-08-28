import { describe, expect, it } from "vitest";
import {
  normalizeModelAliases,
  resolveFabricModel,
  type FabricModelCandidate,
} from "../src/core/model-resolution.js";

const AVAILABLE: FabricModelCandidate[] = [
  { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  { provider: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  { provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  { provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini" },
];

const options = (overrides: Partial<Parameters<typeof resolveFabricModel>[1]> = {}) => ({
  aliases: {},
  available: AVAILABLE,
  ...overrides,
});

describe("normalizeModelAliases", () => {
  it("keeps valid string and chain aliases verbatim", () => {
    expect(
      normalizeModelAliases({
        cheap: "google/gemini-2.5-flash",
        budget: ["openai/gpt-5-mini", "google/gemini-2.5-flash"],
      }),
    ).toEqual({
      cheap: ["google/gemini-2.5-flash"],
      budget: ["openai/gpt-5-mini", "google/gemini-2.5-flash"],
    });
  });

  it("drops malformed names and targets", () => {
    expect(
      normalizeModelAliases({
        "": "google/gemini-2.5-flash",
        "  ": "anthropic/claude-opus-4-5",
        broken: "not-a-model",
        mixed: ["openai/gpt-5-mini", "also-not-a-model"],
        empty: [],
        wrong: 42,
        alsoWrong: null,
      }),
    ).toEqual({});
  });

  it("dedupes repeated targets within a chain but preserves order", () => {
    expect(
      normalizeModelAliases({
        chain: ["google/gemini-2.5-flash", "google/gemini-2.5-flash", "openai/gpt-5-mini"],
      }),
    ).toEqual({ chain: ["google/gemini-2.5-flash", "openai/gpt-5-mini"] });
  });

  it("treats non-object input as empty", () => {
    expect(normalizeModelAliases(undefined)).toEqual({});
    expect(normalizeModelAliases(null)).toEqual({});
    expect(normalizeModelAliases(["google/gemini-2.5-flash"])).toEqual({});
  });
});

describe("resolveFabricModel", () => {
  it("resolves an exact provider/id", () => {
    const resolution = resolveFabricModel("google/gemini-2.5-pro", options());
    expect(resolution).toEqual({
      kind: "resolved",
      model: { provider: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    });
  });

  it("resolves an exact bare model id", () => {
    const resolution = resolveFabricModel("gpt-5-mini", options());
    expect(resolution).toMatchObject({ kind: "resolved", model: { id: "gpt-5-mini" } });
  });

  it("resolves a single partial match across id, name, and provider", () => {
    expect(resolveFabricModel("sonnet", options())).toMatchObject({
      kind: "resolved",
      model: { id: "claude-sonnet-4-5" },
    });
    expect(resolveFabricModel("openai", options())).toMatchObject({
      kind: "resolved",
      model: { provider: "openai" },
    });
  });

  it("reports ambiguity when a partial term matches several models", () => {
    const resolution = resolveFabricModel("gemini", options());
    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind !== "ambiguous") return;
    expect(resolution.candidates.map((model) => model.id)).toEqual([
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ]);
  });

  it("narrows partial matches with a provider filter", () => {
    const resolution = resolveFabricModel("claude", options({ provider: "google" }));
    expect(resolution).toEqual({ kind: "not-found", query: "claude" });
    expect(resolveFabricModel("flash", options({ provider: "google" }))).toMatchObject({
      kind: "resolved",
      model: { id: "gemini-2.5-flash" },
    });
  });

  it("resolves aliases before id matching and records the alias name", () => {
    const resolution = resolveFabricModel(
      "cheap",
      options({ aliases: normalizeModelAliases({ cheap: "google/gemini-2.5-flash" }) }),
    );
    expect(resolution).toEqual({
      kind: "resolved",
      model: { provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
      via: "cheap",
    });
  });

  it("falls through an alias chain to the first available target", () => {
    const resolution = resolveFabricModel(
      "Budget",
      options({
        aliases: normalizeModelAliases({ budget: ["cohere/command-r", "openai/gpt-5-mini"] }),
      }),
    );
    expect(resolution).toMatchObject({
      kind: "resolved",
      model: { id: "gpt-5-mini" },
      via: "budget",
    });
  });

  it("reports the tried chain when no alias target is available", () => {
    const resolution = resolveFabricModel(
      "budget",
      options({
        aliases: normalizeModelAliases({ budget: ["cohere/command-r", "mistral/mistral-large"] }),
      }),
    );
    expect(resolution).toEqual({
      kind: "not-found",
      query: "budget",
      tried: ["cohere/command-r", "mistral/mistral-large"],
    });
  });

  it("reports already-active without resolving again", () => {
    const resolution = resolveFabricModel("anthropic/claude-opus-4-5", options({
      current: { provider: "anthropic", id: "claude-opus-4-5" },
    }));
    expect(resolution).toEqual({
      kind: "already-active",
      model: { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    });
  });

  it("reports empty selection sets and blank queries as not-found", () => {
    expect(resolveFabricModel("anything", options({ available: [] }))).toEqual({
      kind: "not-found",
      query: "anything",
    });
    expect(resolveFabricModel("   ", options())).toEqual({ kind: "not-found", query: "   " });
  });
});
