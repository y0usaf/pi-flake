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
});
