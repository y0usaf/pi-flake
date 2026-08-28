import { describe, expect, it } from "vitest";
import type { FabricActionDescriptor } from "../src/protocol.js";
import {
  buildCapabilityIndex,
  capabilityFirstSentence,
  capabilityPathOnlyTerms,
  capabilitySourceLabel,
  capabilityWordCandidates,
  isMostlyNonLatinPrompt,
  type CapabilitySourceFingerprint,
  splitCapabilityWords,
  tokenizeCapabilityText,
  truncateAdvisoryDescription,
} from "../src/core/capability-fingerprint.js";

const descriptor = (
  name: string,
  description: string,
  namespace: string,
): FabricActionDescriptor => ({
  name,
  description,
  inputSchema: {},
  risk: "read",
  namespace,
});

describe("tokenizeCapabilityText", () => {
  it("splits camelCase, snake_case, and punctuation-separated identifiers", () => {
    expect(tokenizeCapabilityText("openaiWebSearch_v2.run-now/the thing")).toEqual([
      "openai",
      "web",
      "search",
      "v2",
      "run",
      "now",
      "thing",
    ]);
  });

  it("drops stopwords and single-character tokens", () => {
    expect(tokenizeCapabilityText("a run with the B tool")).toEqual(["run", "tool"]);
  });
});

describe("splitCapabilityWords", () => {
  it("keeps written words whole and dedupes them case-insensitively", () => {
    expect(splitCapabilityWords("GitHub github deepWiki")).toEqual(["GitHub", "deepWiki"]);
  });

  it("splits on non-alphanumerics and drops non-latin text", () => {
    expect(splitCapabilityWords("看看 github_repo.run 仓库 v2")).toEqual(["github", "repo", "run", "v2"]);
    expect(splitCapabilityWords("看看仓库")).toEqual([]);
  });
});

describe("capabilityWordCandidates", () => {
  it("exposes camelCase atoms plus the written word itself", () => {
    expect(new Set(capabilityWordCandidates("GitHub"))).toEqual(new Set(["git", "hub", "github"]));
    expect(new Set(capabilityWordCandidates("deepWiki"))).toEqual(new Set(["deep", "wiki", "deepwiki"]));
  });

  it("holds the joined reading to the same token rules", () => {
    expect(capabilityWordCandidates("the")).toEqual([]);
    expect(capabilityWordCandidates("v2")).toEqual(["v2"]);
  });
});

describe("isMostlyNonLatinPrompt", () => {
  // The script-boundary exception keys on prose, not any single language:
  // script by script, non-latin letters must outnumber the latin words.
  it.each([
    ["Chinese", "看看 GitHub 仓库"],
    ["Japanese", "GitHub のリポジトリを見せて"],
    ["Korean", "GitHub 저장소를 열어줘"],
    ["Russian", "Открой репозиторий GitHub в браузере"],
    ["Arabic", "افتح مستودع GitHub من فضلك"],
    ["Thai", "เปิดรีโพ GitHub ให้หน่อย"],
    ["Hebrew", "תפתח את המאגר של GitHub"],
    ["digit-bearing", "2024 年度 GitHub 总结"],
  ])("reads %s prose as mostly non-latin", (_script, prompt) => {
    expect(isMostlyNonLatinPrompt(prompt)).toBe(true);
  });

  it.each([
    ["plain english", "check the GitHub repo please"],
    ["accented latin", "résumé café français"],
    ["Vietnamese (latin script)", "mở repo GitHub giúp tôi"],
    ["latin words not outnumbered", "GitHub v2 仓库"],
    ["pure latin-with-digit", "wait 60 seconds then retry"],
  ])("reads %s as latin-dominant", (_script, prompt) => {
    expect(isMostlyNonLatinPrompt(prompt)).toBe(false);
  });
});

describe("capabilityFirstSentence", () => {
  it("cuts at the first sentence boundary, not inside domains", () => {
    expect(
      capabilityFirstSentence(
        "Upload a file to fal.ai's CDN so it can be used as input to models. Returns a fal.ai CDN URL.",
      ),
    ).toBe("Upload a file to fal.ai's CDN so it can be used as input to models.");
  });

  it("passes terse descriptions through whole", () => {
    expect(capabilityFirstSentence("Cancel subscription")).toBe("Cancel subscription");
  });
});

describe("capabilityPathOnlyTerms", () => {
  it("marks tokens that live only inside paths and filenames", () => {
    expect(
      capabilityPathOnlyTerms("Help me understand the mathematics behind docs/heat-diffusion.md"),
    ).toEqual(new Set(["docs", "heat", "diffusion", "md"]));
  });

  it("keeps tokens that also appear as free prose at full weight", () => {
    const terms = capabilityPathOnlyTerms("read docs/heat-diffusion.md then explain diffusion");
    expect(terms.has("diffusion")).toBe(false);
    expect(terms.has("docs")).toBe(true);
  });

  it("does not brand prose domains as filenames", () => {
    expect(capabilityPathOnlyTerms("use fal.ai to render a video").size).toBe(0);
  });

  it("marks URL tokens without touching the prose around them", () => {
    const terms = capabilityPathOnlyTerms("fetch https://example.com/spec.toml for me");
    expect(terms.has("example")).toBe(true);
    expect(terms.has("fetch")).toBe(false);
  });
});

describe("identity-surface corpus", () => {
  it("indexes tool names and leading sentences, never instructional tails", () => {
    const index = buildCapabilityIndex([
      descriptor(
        "search_docs",
        "Search the fal.ai documentation for guides. Use this when you need to understand how fal.ai works.",
        "mcp:fal_ai",
      ),
      descriptor("run_model", "Run a fal.ai model.", "mcp:fal_ai"),
    ]);
    const fal = index.sources.find((source) => source.namespace === "mcp:fal_ai");
    expect(fal?.tf.has("docs")).toBe(true);
    expect(fal?.tf.has("documentation")).toBe(true);
    expect(fal?.tf.has("understand")).toBe(false);
    expect(fal?.tf.has("works")).toBe(false);
  });
});

describe("buildCapabilityIndex", () => {
  it("groups descriptors by source namespace and counts tools", () => {
    const index = buildCapabilityIndex([
      descriptor("one_tool", "first tool of alpha", "extension:alpha"),
      descriptor("two_tool", "second tool of alpha", "extension:alpha"),
      descriptor("beta_tool", "only tool of beta", "extension:beta"),
    ]);
    expect(index.sourceCount).toBe(2);
    const alpha: CapabilitySourceFingerprint | undefined = index.sources.find(
      (source) => source.namespace === "extension:alpha",
    );
    expect(alpha?.toolCount).toBe(2);
    expect(alpha?.label).toBe("alpha");
  });

  it("scores rare terms above shared terms in idf", () => {
    const index = buildCapabilityIndex([
      descriptor("a", "alpha unicorn shared", "extension:a"),
      descriptor("b", "beta unicorn shared", "extension:b"),
      descriptor("c", "gamma shared", "extension:c"),
    ]);
    expect(index.idf("unicorn")).toBeGreaterThan(index.idf("shared"));
    expect(index.idf("missing")).toBe(0);
  });

  it("handles an empty descriptor list", () => {
    const index = buildCapabilityIndex([]);
    expect(index.sourceCount).toBe(0);
    expect(index.idf("anything")).toBe(0);
  });
});

describe("capabilitySourceLabel", () => {
  it("strips the extension prefix and tolerates missing namespaces", () => {
    expect(capabilitySourceLabel("extension:pi-fovea")).toBe("pi-fovea");
    expect(capabilitySourceLabel("mcp:server")).toBe("mcp:server");
    expect(capabilitySourceLabel(undefined)).toBe("unscoped");
  });
});

describe("truncateAdvisoryDescription", () => {
  it("keeps the first sentence when it fits", () => {
    const text =
      "Search the web using Synthetic's zero-data-retention API. Returns a long detail dump that far exceeds the advisory budget per ref.";
    expect(truncateAdvisoryDescription(text)).toBe(
      "Search the web using Synthetic's zero-data-retention API.",
    );
  });

  it("strips capture provenance suffixes", () => {
    expect(truncateAdvisoryDescription("Focus the code graph. (captured from pi-fovea)")).toBe(
      "Focus the code graph.",
    );
  });

  it("truncates long sentence-less text with an ellipsis within budget", () => {
    const text = "x".repeat(200);
    const truncated = truncateAdvisoryDescription(text);
    expect(truncated.length).toBeLessThanOrEqual(64);
    expect(truncated.endsWith("…")).toBe(true);
  });
});
