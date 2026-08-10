import { describe, expect, test } from "bun:test";
import { detectLoop } from "./detector";
import chronobreak from "./index";

// Real text from the session that motivated this extension.
const LOOP_TEXT = [
  "Let me check the system mtime and module import.",
  "Let me check the system mtime and module import now.",
  "I am trapped in a generation loop. Let me stop and think.",
  "Let me check the system mtime and module import.",
  "Let me check the system mtime and module import now.",
  "Let me check the system mtime and module import.",
  "Let me check the system mtime and module import.",
].join("\n\n");

const VARIED_TEXT = [
  "First we inspect the system generation to see when it was built.",
  "Then the module list tells us whether paseo is imported at all.",
  "If the system is stale, a rebuild fixes it; otherwise the import is missing.",
  "Finally we grep the activation script for the service unit.",
].join("\n\n");


// --- v2 fixtures: loose / out-of-distribution loops and legit cases --- //
const LOOSE_LOOP = [
  "While the full flake check runs, let me update the documentation to record this P3 wiring progress.",
  "Let me update the overnight-progress.md and check the git status is clean.",
  "Let me update the overnight-progress.md to reflect the new status.",
  "Let me update docs/overnight-progress.md with the current state.",
  "Let me update the progress doc.",
  "Let me record the progress in the overnight doc.",
  "Let me update the status section of docs/overnight-progress.md.",
  "Let me update the doc.",
  "Let me update the docs.",
  "Let me quickly update the overnight-progress doc to reflect this session's wiring work.",
  "Let me update docs/overnight-progress.md.",
  "Let me make the doc update.",
  "Let me update the doc and check git status.",
  "Let me update the overnight progress doc while the flake check runs.",
  "Let me update the progress doc.",
  "Let me update the docs file.",
  "Let me update the docs now.",
  "Let me update the overnight-progress.md.",
  "Let me update the doc decisively.",
  "Let me do it directly with a concise edit.",
  "Let me update the overnight progress doc.",
  "Let me look at the current status section and update it.",
  "Let me update the overnight-progress doc status.",
  "Let me make the doc update concisely.",
  "Let me update the docs now in one decisive step.",
  "Let me update the docs status section.",
  "Let me do the doc edit now.",
  "Let me update the overnight-progress doc to reflect the P3 wiring completion meanwhile.",
  "Let me check the current status block first, then edit concisely.",
].join("\n");

const OOD_CALC = [
  "The gradient is zero when the derivative vanishes at the critical point.",
  "Because the derivative vanishes there, the gradient is exactly zero.",
  "At the critical point the derivative vanishes so the gradient must be zero.",
  "The gradient is zero since the derivative vanishes at that point.",
  "We can see the gradient is zero because the derivative vanished.",
  "Thus the derivative vanishes and therefore the gradient is zero here.",
  "Given the vanishing derivative, the gradient evaluates to zero.",
  "The gradient equals zero wherever the derivative vanishes.",
  "Since the derivative vanishes, the gradient is zero at the point.",
  "The gradient is therefore zero, as the derivative vanished.",
  "Where the derivative vanishes the gradient is zero as well.",
  "The gradient being zero follows from the derivative vanishing.",
].join("\n");

const OOD_CODE = [
  "For each item we call process(item) and append to output.",
  "Calling process(item) on every element then appending to the list.",
  "We iterate all items calling process(item) and appending to output.",
  "Each item is processed by process(item), appending the result to output.",
  "Loop over items, invoke process(item), and push onto output.",
  "process(item) is called for each element and the result appended.",
  "We go through items, run process(item), and append to output.",
  "For every item call process(item) and append it to the output.",
  "Each element gets process(item) called and appended to output.",
  "We call process(item) for the items and append each to output.",
  "The loop runs process(item) on everything and appends it.",
  "process(item) runs on each item and the output accumulates.",
  "All items are sent through process(item) and appended.",
  "Every iteration invokes process(item) then appends to output.",
].join("\n");

const VERBLESS_LOOP = "42. 42. 42. 42. 42. 42. 42. 42. 42. 42. 42. 42. 42. 42. 42. 42. 42. 42. 42. 42.";

const LEGIT_EIGEN = [
  "We begin by noting the matrix is real and symmetric.",
  "The spectral theorem guarantees an orthonormal basis of eigenvectors.",
  "We compute the characteristic polynomial to locate the eigenvalues.",
  "Applying the quadratic formula yields the two roots directly.",
  "The larger root corresponds to the maximal energy level physically.",
  "We then substitute back to find the associated eigenvectors.",
  "Each eigenvector is normalized to unit length for convenience.",
  "The trace check confirms the sum of eigenvalues matches the diagonal.",
  "Finally the determinant verifies the product of the eigenvalues.",
  "Thus the spectrum is fully determined and the problem solved.",
  "This completes the eigenvalue decomposition of the matrix.",
  "We conclude the largest eigenvalue governs the long-run behavior.",
  "The result is consistent across all three independent methods.",
  "A quick sanity test on a simple matrix confirms the formula.",
  "We note the method generalizes to any Hermitian operator.",
].join("\n");

const LEGIT_REUSE = [
  "Open the flake config and read the nixos module section.",
  "The config flags the service as disabled in the current setup.",
  "I edit the config to enable the service and save the file.",
  "Rebuilding the config triggers the activation script path.",
  "The config now enables the module, so confirm with a flake check.",
].join("\n");

const LEGIT_TEMPLATE = ["auth", "billing", "parser", "storage", "network", "cache", "logging", "scheduler", "search", "metrics", "events", "queue", "sync", "audit"]
  .map((m) => `I updated the docs for the ${m} module to reflect the new config key.`)
  .join("\n");


const LOOP_WITH_LEADIN = [
  "First we inspect the system generation to see when it was built.",
  "Then the module list tells us whether paseo is imported at all.",
  "Let me check the system mtime and module import.",
  "Let me check the system mtime and module import now.",
  "I am trapped. Let me check the system mtime and module import.",
  "Let me check the system mtime and module import.",
  "Let me check the system mtime and module import.",
  "Let me check the system mtime and module import.",
].join("\n\n");

type AnyHandler = (event: unknown, ctx: unknown) => unknown;

function makeExt() {
  const handlers = new Map<string, AnyHandler>();
  const sent: { text: string; options?: unknown }[] = [];
  const pi = {
    on(name: string, fn: AnyHandler) {
      handlers.set(name, fn);
    },
    sendUserMessage(text: string, options?: unknown) {
      sent.push({ text, options });
    },
  };
  chronobreak(pi as never);
  const calls = { abort: 0, notices: [] as string[] };
  const ctx = {
    abort() {
      calls.abort++;
    },
    ui: {
      notify(msg: string) {
        calls.notices.push(msg);
      },
    },
  };
  const fire = (name: string, event: unknown) => handlers.get(name)?.(event, ctx);
  return { fire, sent, calls };
}

function assistant(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("detector", () => {
  test("flags the real session loop text", () => {
    const v = detectLoop(LOOP_TEXT);
    expect(v.looping).toBe(true);
    expect(v.sample).toContain("system mtime and module import");
    expect(v.count).toBeGreaterThanOrEqual(3);
  });

  test("passes varied prose", () => {
    expect(detectLoop(VARIED_TEXT).looping).toBe(false);
  });

  test("is pure per call: same text twice does not accumulate", () => {
    const once = "A single unique sentence about nothing in particular.";
    detectLoop(once);
    detectLoop(once);
    expect(detectLoop(once).looping).toBe(false);
  });
});

describe("v2 detector: loose & out-of-distribution loops", () => {
  test("loose loop (same intent, varied wording) is caught as stall", () => {
    const v = detectLoop(LOOSE_LOOP);
    expect(v.looping).toBe(true);
    expect(v.kind).toBe("stall");
    expect(v.count).toBeGreaterThanOrEqual(5);
  });

  test("out-of-distribution calculus loop is caught", () => {
    const v = detectLoop(OOD_CALC);
    expect(v.looping).toBe(true);
    expect(v.kind).toBe("stall");
  });

  test("out-of-distribution code loop is caught", () => {
    const v = detectLoop(OOD_CODE);
    expect(v.looping).toBe(true);
    expect(v.kind).toBe("stall");
  });

  test("verbless / utterance loop is caught by fragment tier", () => {
    const v = detectLoop(VERBLESS_LOOP);
    expect(v.looping).toBe(true);
    expect(v.kind).toBe("fragment");
  });

  test("legit heavy-topic analysis is not a loop", () => {
    expect(detectLoop(LEGIT_EIGEN).looping).toBe(false);
  });

  test("legit topic-reuse prose is not a loop", () => {
    expect(detectLoop(LEGIT_REUSE).looping).toBe(false);
  });

  test("template enumeration (one skeleton, many payloads) is NOT a loop", () => {
    expect(detectLoop(LEGIT_TEMPLATE).looping).toBe(false);
  });
});

describe("extension flow", () => {
  test("streaming updates with the same full text do not double-count", () => {
    const h = makeExt();
    h.fire("message_start", { message: assistant("") });
    const text = "A single unique sentence about nothing in particular.";
    for (let i = 0; i < 5; i++) {
      h.fire("message_update", { message: assistant(text) });
    }
    expect(h.calls.abort).toBe(0);
  });

  test("loop: aborts once, scrubs the message, re-injects a nudge", () => {
    const h = makeExt();
    h.fire("message_start", { message: assistant("") });
    h.fire("message_update", { message: assistant(LOOP_TEXT) });
    h.fire("message_update", { message: assistant(LOOP_TEXT) });
    expect(h.calls.abort).toBe(1);
    expect(h.calls.notices[0]).toContain("generation loop detected");

    const scrub = h.fire("message_end", { message: assistant(LOOP_TEXT) }) as {
      message: { content: Array<{ text: string }> };
    };
    expect(scrub.message.content[0].text).toContain("chronobreak");

    h.fire("agent_end", {});
    expect(h.sent.length).toBe(1);
    expect(h.sent[0].text).toContain("Repeat detected");
    expect(h.sent[0].options).toEqual({ deliverAs: "followUp" });
    expect(h.sent[0].text).toContain("ONE decisive action");
  });

  test("clean turn: message_end untouched, nothing re-injected", () => {
    const h = makeExt();
    h.fire("message_start", { message: assistant("") });
    h.fire("message_update", { message: assistant(VARIED_TEXT) });
    const res = h.fire("message_end", { message: assistant(VARIED_TEXT) });
    expect(res).toBeUndefined();
    h.fire("agent_end", {});
    expect(h.sent.length).toBe(0);
  });

  test("three strikes: third loop aborts without re-run", () => {
    const h = makeExt();
    for (let i = 0; i < 3; i++) {
      h.fire("message_start", { message: assistant("") });
      h.fire("message_update", { message: assistant(LOOP_TEXT) });
      h.fire("message_end", { message: assistant(LOOP_TEXT) });
      h.fire("agent_end", {});
    }
    expect(h.calls.abort).toBe(3);
    expect(h.sent.length).toBe(2);
    expect(h.calls.notices[2]).toContain("strike limit");
  });

  test("user input resets strikes", () => {
    const h = makeExt();
    for (let i = 0; i < 2; i++) {
      h.fire("message_start", { message: assistant("") });
      h.fire("message_update", { message: assistant(LOOP_TEXT) });
      h.fire("message_end", { message: assistant(LOOP_TEXT) });
      h.fire("agent_end", {});
    }
    h.fire("input", { source: "interactive", text: "new direction" });
    h.fire("message_start", { message: assistant("") });
    h.fire("message_update", { message: assistant(LOOP_TEXT) });
    h.fire("message_end", { message: assistant(LOOP_TEXT) });
    h.fire("agent_end", {});
    // strike counter restarted: this loop re-injects instead of giving up
    expect(h.sent.length).toBe(3);
  });

  test("loop with lead-in: keeps the coherent prefix, drops the repeated tail", () => {
    const h = makeExt();
    h.fire("message_start", { message: assistant("") });
    h.fire("message_update", { message: assistant(LOOP_WITH_LEADIN) });
    expect(h.calls.abort).toBe(1);
    const scrub = h.fire("message_end", { message: assistant(LOOP_WITH_LEADIN) }) as {
      message: { content: Array<{ text: string }> };
    };
    const kept = scrub.message.content.map((c) => c.text).join("\n");
    // lead-in survives, looped garbage does not
    expect(kept).toContain("system generation");
    expect(kept).not.toContain("system mtime and module import");
    expect(kept).toContain("truncated here");
  });

  test("toolCall gate: a message that emits a tool call is never cut even if redundant", () => {
    const h = makeExt();
    h.fire("message_start", { message: assistant("") });
    // A redundant/potentially-looping text BUT with a toolCall block present.
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: LOOSE_LOOP },
        { type: "toolCall", name: "read_file", arguments: { path: "x" } },
      ],
    };
    h.fire("message_update", { message: msg });
    expect(h.calls.abort).toBe(0); // progressing turn: eligible excludes toolCall
  });

  test("thinking-only message is never inspected", () => {
    const h = makeExt();
    h.fire("message_start", { message: assistant("") });
    const msg = { role: "assistant", content: [{ type: "thinking", thinking: LOOSE_LOOP }] };
    h.fire("message_update", { message: msg });
    expect(h.calls.abort).toBe(0);
  });

});
