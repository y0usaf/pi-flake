// Persistent Node.js REPL kernel — wire protocol v2.
//
// Speaks NDJSON over stdin/stdout. One JSON object per line in/out.
// stderr is reserved for diagnostics only — never protocol traffic.
//
// Host -> child:
//   {"type":"eval","id",code}                    evaluate in the persistent REPL
//   {"type":"host_response","id","result"}       answer to a host_request the child emitted
//   {"id","code"} (no type)                      legacy eval, treated as {"type":"eval",...}
//
// Child -> host:
//   {"type":"result","id","ok","stdout","stderr","result"?,"error"?}   eval finished
//   {"type":"host_request","id","request"}       child needs a host tool mid-eval
//
// Eval ids come from the host; host_request ids are child-generated from an
// independent counter. During evaluation, code may call kernel.host.request /
// kernel.read / kernel.edit / kernel.rlm.*, which emit a host_request line and
// return a Promise that resolves when the matching host_response arrives.
// kernel.bash runs a subshell in the child directly (node:child_process exec)
// and never crosses the bridge.
//
// Design notes (unchanged from v1):
//  - node:repl's eval is driven directly (replServer.eval(code, ctx, file, cb)),
//    which gives persistent let/const/class/function across requests and
//    built-in top-level await support.
//  - Thrown runtime errors never reach the eval callback: node:repl routes them
//    to its internal domain ('error' event) and displays them via the output
//    stream. We attach our own listener to that domain to capture the raw
//    error object and answer with ok:false. Whichever settles first — the eval
//    callback or the domain error — wins; the other is ignored.
//  - process stdout/stderr.write (and the console methods, which write through
//    those streams) are permanently patched to route into the *current*
//    request's capture buffers; when no request is active the bytes are
//    discarded so nothing can corrupt NDJSON framing. The patch stays in place
//    for the process lifetime on purpose: late async writes (e.g. a setTimeout
//    log) are safely swallowed instead of leaking to the real stdout.
//  - The REPL's own output stream is a silent Writable, so the REPL never
//    prints prompts/result text to the real stdout. Results are taken from the
//    eval callback and stringified ourselves.
//  - Responses and host_requests use the ORIGINAL (unpatched) stream writes.
//  - A host_response is handled immediately on receipt (it resolves the
//    pending host_request Promise inside an in-flight eval) — it is never
//    queued behind the busy-gated eval queue, or an awaited eval would
//    deadlock waiting for its own response. host_response never settles an
//    eval; the eval settles itself once the awaited Promise resolves.
//  - kernel.bash spawns a subshell via child_process.exec; its stdout/stderr
//    are captured and returned as data, never routed into the eval's capture
//    buffers (it is not part of the eval's own output).

import * as repl from "node:repl";
import { exec } from "node:child_process";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { Writable } from "node:stream";
import { inspect } from "node:util";

const MAX = 65536;
const TRUNC_SUFFIX = `\n[... output truncated at ${MAX} chars ...]`;

// ---------------------------------------------------------------------------
// Output capture
// ---------------------------------------------------------------------------

// The current request's buffers. Null when no request is being processed, in
// which case all writes are discarded (late async writes, stray bytes).
let current = null;

// Original writes, kept for sending responses + diagnostics.
const real = {};

function makeBuffer() {
  const chunks = [];
  let length = 0;
  let truncated = false;
  return {
    push(s) {
      if (truncated) return;
      if (s.length <= MAX - length) {
        chunks.push(s);
        length += s.length;
      } else {
        chunks.push(s.slice(0, MAX - length));
        chunks.push(TRUNC_SUFFIX);
        truncated = true;
      }
    },
    toString() {
      return chunks.join("");
    },
  };
}

// Route all writes (including those made by the console methods, which write
// through these streams) into the current request's capture buffer — or
// discard them when no request is active.
function patchStream(fieldname) {
  const stream = process[fieldname];
  real[fieldname] = stream.write.bind(stream);
  stream.write = (chunk, encoding, callback) => {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    let s = chunk;
    if (Buffer.isBuffer(s)) {
      s = s.toString(typeof encoding === "string" ? encoding : "utf8");
    } else {
      s = String(s);
    }
    if (current) current[fieldname].push(s);
    if (typeof callback === "function") callback();
    return true;
  };
}

patchStream("stdout");
patchStream("stderr");

// ---------------------------------------------------------------------------
// Result formatting (REPL-style: inspect for objects, plain for strings/numbers)
// ---------------------------------------------------------------------------

function stringifyResult(value) {
  if (value === undefined) return null;
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    typeof value === "symbol"
  ) {
    return String(value);
  }
  return inspect(value);
}

function truncateString(s) {
  if (s.length <= MAX) return s;
  return s.slice(0, MAX) + TRUNC_SUFFIX;
}

function formatError(err) {
  return {
    name: String((err && err.name) || "Error"),
    message: String((err && err.message) || String(err)),
    stack: String((err && err.stack) || ""),
  };
}

function send(obj) {
  real.stdout(`${JSON.stringify(obj)}\n`);
}

// ---------------------------------------------------------------------------
// Host bridge (kernel.host.request & friends)
// ---------------------------------------------------------------------------

// host_request ids: child-owned counter, independent of eval ids.
let hostRequestCounter = 0;
const pendingHostRequests = new Map();

function buildHostError(err) {
  const raw = err || {};
  const e = new Error(raw.message !== undefined ? String(raw.message) : "host request failed");
  if (raw.name !== undefined) e.name = String(raw.name);
  if (raw.stack !== undefined) e.stack = String(raw.stack);
  return e;
}

function hostRequest(type, payload) {
  const id = ++hostRequestCounter;
  return new Promise((resolve, reject) => {
    pendingHostRequests.set(id, { resolve, reject });
    // Protocol traffic — always via the ORIGINAL unpatched stdout write, so a
    // host_request emitted mid-eval is never captured or corrupted.
    send({ type: "host_request", id, request: { type, ...(payload || {}) } });
  });
}

// Resolves/rejects the pending host_request Promise. Never settles the eval:
// the eval settles itself once its awaited Promise resolves.
function handleHostResponse(req) {
  const pending = pendingHostRequests.get(req.id);
  if (!pending) return; // stale or unknown id — ignore
  pendingHostRequests.delete(req.id);
  const result = (req && req.result) || {};
  if (result.ok === true) {
    pending.resolve(result.value);
  } else {
    pending.reject(buildHostError(result.error));
  }
}

// Exposed on the REPL context as globalThis.kernel.
const kernel = {
  host: {
    request: hostRequest, // raw bridge: resolves to the host's value, rejects with Error on ok:false
  },
  read(path, opts) {
    return hostRequest("read", { path, ...(opts || {}) });
  },
  edit(args) {
    // args = {path, edits}
    return hostRequest("edit", args || {});
  },
  write(args) {
    // args = {path, content} — create or overwrite a file (host-side, mutation-queued)
    return hostRequest("write", args || {});
  },
  bash(cmd, options) {
    // CHILD-SIDE subshell: node child_process.exec, never crosses the host bridge.
    const { timeoutMs = 60000 } = options || {};
    return new Promise((resolve) => {
      exec(cmd, { timeout: timeoutMs, maxBuffer: MAX }, (err, stdout, stderr) => {
        resolve({
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        });
      });
    });
  },
  rlm: {
    run(task, opts) {
      return hostRequest("rlm.run", { task, ...(opts || {}) });
    },
    panel(task, opts) {
      return hostRequest("rlm.panel", { task, ...(opts || {}) });
    },
    loop(workflow, opts) {
      return hostRequest("rlm.loop", { workflow, ...(opts || {}) });
    },
    answer(id, answers, opts) {
      return hostRequest("rlm.answer", { id, answers, ...(opts || {}) });
    },
    peek(id) {
      return hostRequest("rlm.peek", { id });
    },
    list() {
      return hostRequest("rlm.list", {});
    },
    kill(id) {
      return hostRequest("rlm.kill", { id });
    },
  },
};

// ---------------------------------------------------------------------------
// REPL server (silent output, direct-eval driven)
// ---------------------------------------------------------------------------

const inputStream = new PassThrough();
const outputStream = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

const server = repl.start({
  input: inputStream,
  output: outputStream,
  prompt: "",
  terminal: false,
  useGlobal: true,
  ignoreUndefined: true,
});

// Preload the kernel API onto the REPL context (useGlobal => server.context is
// the global object, so this is globalThis.kernel for evaluated code).
server.context.kernel = kernel;
globalThis.kernel = kernel;

// ---------------------------------------------------------------------------
// Request queue (one request at a time, FIFO)
// ---------------------------------------------------------------------------

const queue = [];
let busy = false;
let stdinClosed = false;

// Set while a request is in flight; the domain error handler checks it so
// unrelated domain errors don't produce spurious responses.
let activeRequest = null;

// Thrown runtime errors never reach the eval callback — node:repl emits them
// on its internal domain and displays them via the output stream. Capture the
// raw error here instead.
function logDiagnostic(err) {
  real.stderr('[kernel] unhandledRejection: ' + (err && err.stack ? err.stack : String(err)) + '\n');
}

server._domain.on("error", (err) => {
  if (!activeRequest || activeRequest.settled) {
    // No in-flight request, or it already settled: stray async rejection.
    logDiagnostic(err);
    return;
  }
  if (activeRequest.cbFired) {
    // The eval callback already produced a result; this domain error is an
    // asynchronous unhandled rejection alongside it (e.g. an un-awaited
    // Promise.reject). Keep the request's success and log to stderr instead.
    logDiagnostic(err);
    return;
  }
  // First settling signal and the callback never fired: the request itself
  // threw, or its top-level await rejected. Report ok:false.
  activeRequest.settled = true;
  settle(activeRequest, { err });
});

function maybeExit() {
  if (stdinClosed && !busy && queue.length === 0) process.exit(0);
}

function pump() {
  if (busy) return;
  const line = queue.shift();
  if (line === undefined) {
    maybeExit();
    return;
  }
  busy = true;
  handleLine(line);
}

function settle(req, outcome) {
  // Called exactly once per request (guarded by req.settled).
  const stdout = req.current.stdout.toString();
  const stderr = req.current.stderr.toString();
  current = null;

  if (outcome.err) {
    send({
      type: "result",
      id: req.id,
      ok: false,
      stdout,
      stderr,
      error: formatError(outcome.err),
    });
  } else {
    const resultString = stringifyResult(outcome.result);
    send({
      type: "result",
      id: req.id,
      ok: true,
      stdout: truncateString(stdout),
      stderr: truncateString(stderr),
      result: resultString === null ? null : truncateString(resultString),
    });
  }
  busy = false;
  activeRequest = null;
  pump();
}

function handleLine(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch (e) {
    busy = false;
    send({
      type: "result",
      id: "unknown",
      ok: false,
      stdout: "",
      stderr: "",
      error: formatError(new SyntaxError(`Malformed request: ${e.message}`)),
    });
    pump();
    return;
  }

  // Only eval requests (type "eval", or legacy no-type {id, code}) pass
  // through here; host_response is intercepted at line receipt and resolved
  // immediately (see the stdin wiring below).
  const id = String(req && req.id !== undefined ? req.id : "unknown");
  const code = String((req && req.code) ?? "");

  const request = {
    id,
    current: { stdout: makeBuffer(), stderr: makeBuffer() },
    settled: false,
    cbFired: false,
  };
  current = request.current;
  activeRequest = request;

  try {
    server.eval(code, server.context, "eval", (err, result) => {
      if (request.settled) return;
      request.cbFired = true;
      if (err) {
        request.settled = true;
        settle(request, { err });
        return;
      }
      // Wait one macrotask so microtask console writes (e.g. in a .then) are
      // still folded into the current request's buffers before we respond.
      setImmediate(() => {
        if (request.settled) return;
        request.settled = true;
        settle(request, { result });
      });
    });
  } catch (e) {
    // Defensive: eval should never throw synchronously, but if it does we
    // must still answer with valid NDJSON so framing is preserved.
    if (!request.settled) {
      request.settled = true;
      settle(request, { err: e });
    }
  }
}

// ---------------------------------------------------------------------------
// Process hygiene — log async crashes to real stderr, never crash.
// ---------------------------------------------------------------------------

process.on("uncaughtException", (err) => {
  real.stderr(`[kernel] uncaughtException: ${err.stack || err}\n`);
});
process.on("unhandledRejection", (reason) => {
  real.stderr(
    `[kernel] unhandledRejection: ${reason && reason.stack ? reason.stack : String(reason)}\n`,
  );
});

// ---------------------------------------------------------------------------
// Wire in stdin
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (line.trim() === "") return;

  // A host_response must be handled NOW, not queued behind the busy-gated
  // eval queue: the in-flight eval is awaiting the Promise this resolves, so
  // deferring it would deadlock the kernel. It resolves a pending
  // host_request and never settles the eval itself.
  let parsed = null;
  try {
    parsed = JSON.parse(line);
  } catch {
    parsed = null;
  }
  if (parsed && parsed.type === "host_response") {
    handleHostResponse(parsed);
    return;
  }

  queue.push(line);
  pump();
});
rl.on("close", () => {
  stdinClosed = true;
  maybeExit();
});
