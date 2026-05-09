import { execFile, spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import * as path from "node:path";

import { defineTool } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { ctxExtract, ctxGrep, ctxManifest, ctxPeek, ctxWriteText, contextSourceSummary, readFileSlice } from "./context-store.js";
import { dispatchRlmCall } from "./dispatcher.js";
import { CTX_TOOL_NAME, MAX_RESULT_CHARS, REPL_TOOL_NAME, RLM_TOOL_NAME } from "./constants.js";
import type { ContextStore, RunState } from "./constants.js";
import { ReplParams, REPL_PARAM_KEYS } from "./params.js";
import { clamp, clip, errorText, isRecord, rejectUnknownKeys, textOf } from "./utils.js";

const DEFAULT_REPL_TIMEOUT_MS = 30_000;
const HARD_REPL_TIMEOUT_MS = 120_000;
const DEFAULT_BASH_TIMEOUT_MS = 30_000;
const HARD_BASH_TIMEOUT_MS = 120_000;
const DEFAULT_BASH_MAX_BUFFER = 5_000_000;
const HARD_BASH_MAX_BUFFER = 20_000_000;

const PYTHON_WORKER = String.raw`
import ast
import builtins
import json
import os
import sys
import traceback

_ORIG_STDIN = sys.stdin
_ORIG_STDOUT = sys.stdout
_logs = []
_call_seq = 0
_final_called = False
_final_value = None
_last = None
last = None
state = {}
cwd = os.getcwd()

class _Capture:
    def __init__(self, name):
        self.name = name
    def write(self, text):
        if text:
            _logs.append(str(text))
        return len(text) if text else 0
    def flush(self):
        pass

sys.stdout = _Capture("stdout")
sys.stderr = _Capture("stderr")

def _send(obj):
    _ORIG_STDOUT.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")
    _ORIG_STDOUT.flush()

def _call(method, params=None):
    global _call_seq
    _call_seq += 1
    call_id = _call_seq
    _send({"type": "call", "id": call_id, "method": method, "params": params or {}})
    while True:
        line = _ORIG_STDIN.readline()
        if not line:
            raise RuntimeError("RLM REPL bridge closed")
        msg = json.loads(line)
        if msg.get("type") != "call_result" or msg.get("id") != call_id:
            raise RuntimeError("Unexpected bridge response: " + repr(msg))
        if msg.get("ok"):
            return msg.get("result")
        raise RuntimeError(msg.get("error") or "RLM REPL bridge call failed")

def _single_params(call, prompt_or_params=None, **kwargs):
    if isinstance(prompt_or_params, dict):
        params = dict(prompt_or_params)
        params["call"] = call
    elif isinstance(prompt_or_params, str):
        params = {"call": call, "prompt": prompt_or_params}
    else:
        raise TypeError(call + " expects a prompt string or params dict")
    params.update(kwargs)
    return params

def _batch_params(call, prompts_or_params=None, **kwargs):
    if isinstance(prompts_or_params, dict):
        params = dict(prompts_or_params)
        params["call"] = call
    elif isinstance(prompts_or_params, list):
        key = "prompts" if all(isinstance(x, str) for x in prompts_or_params) else "items"
        params = {"call": call, key: prompts_or_params}
    else:
        raise TypeError(call + " expects a list or params dict")
    params.update(kwargs)
    return params

def _batch_answers(result):
    details = result.get("details") if isinstance(result, dict) else None
    child_results = details.get("results") if isinstance(details, dict) else None
    if isinstance(child_results, list):
        return [d.get("answer", "") if isinstance(d, dict) else "" for d in child_results]
    return [result.get("text", "") if isinstance(result, dict) else str(result)]

def rlm(params):
    if not isinstance(params, dict):
        raise TypeError("rlm(params) expects a dict")
    return _call("rlm", params)

def llm_query(prompt_or_params, **kwargs):
    return rlm(_single_params("llm_query", prompt_or_params, **kwargs)).get("text", "")

def llm_query_batched(prompts_or_params, **kwargs):
    return _batch_answers(rlm(_batch_params("llm_query_batched", prompts_or_params, **kwargs)))

def rlm_query(prompt_or_params, **kwargs):
    return rlm(_single_params("rlm_query", prompt_or_params, **kwargs)).get("text", "")

def rlm_query_batched(prompts_or_params, **kwargs):
    return _batch_answers(rlm(_batch_params("rlm_query_batched", prompts_or_params, **kwargs)))

def bash(command, **kwargs):
    if not isinstance(command, str) or not command.strip():
        raise TypeError("bash(command) requires a non-empty string")
    params = dict(kwargs)
    params["command"] = command
    return _call("bash", params)

def read_file(file, **kwargs):
    params = dict(kwargs)
    params["path"] = file
    return _call("read_file", params)

def list_dir(directory="."):
    return _call("list_dir", {"path": directory})

def stat_file(file):
    return _call("stat_file", {"path": file})

class _Ctx:
    scratchDir = None
    notesDir = None
    artifactsDir = None
    sources = []

    def _update(self, info):
        info = info or {}
        self.scratchDir = info.get("scratchDir")
        self.notesDir = info.get("notesDir")
        self.artifactsDir = info.get("artifactsDir")
        self.sources = info.get("sources") or []

    def manifest(self, **kwargs):
        return _call("ctx_manifest", dict(kwargs))

    def grep(self, query=None, **kwargs):
        if isinstance(query, dict):
            params = dict(query)
        else:
            params = dict(kwargs)
            if query is not None:
                params["query"] = query
        return _call("ctx_grep", params)

    def peek(self, source=None, **kwargs):
        if isinstance(source, dict):
            params = dict(source)
        else:
            params = dict(kwargs)
            if source is not None:
                params["source"] = source
        return _call("ctx_peek", params)

    def extract(self, **kwargs):
        return _call("ctx_extract", dict(kwargs))

    def note(self, text, name=None):
        params = {"text": text}
        if name is not None:
            params["name"] = name
        return _call("ctx_note", params)

    def artifact(self, text, name=None):
        params = {"text": text}
        if name is not None:
            params["name"] = name
        return _call("ctx_artifact", params)

ctx = _Ctx()

def FINAL(value):
    global _final_called, _final_value, _last, last
    _final_called = True
    _final_value = value
    _last = value
    last = value
    raise _FinalSignal()

def FINAL_VAR(name):
    if not isinstance(name, str) or not name.strip():
        raise TypeError("FINAL_VAR(name) requires a variable/state key string")
    g = globals()
    if name in g and name not in _RESERVED:
        return FINAL(g[name])
    if name in state:
        return FINAL(state[name])
    raise KeyError(name + " is not defined")

def _safe_repr(value, limit=1000):
    try:
        text = repr(value)
    except Exception as exc:
        text = "<repr failed: " + str(exc) + ">"
    return text if len(text) <= limit else text[:limit] + "..."

def SHOW_VARS():
    keys = _user_var_keys()
    values = {key: _safe_repr(globals()[key]) for key in keys}
    values["state"] = {str(k): _safe_repr(v) for k, v in state.items()}
    print(json.dumps(values, indent=2, ensure_ascii=False, default=str))
    return values

class _FinalSignal(Exception):
    pass

def _user_var_keys():
    return sorted(k for k in globals().keys() if k not in _RESERVED and not k.startswith("_"))

def _compile_user(code):
    tree = ast.parse(code, filename="<pi-rlm-repl>", mode="exec")
    captures_expr = bool(tree.body and isinstance(tree.body[-1], ast.Expr))
    if captures_expr:
        expr = tree.body[-1]
        tree.body[-1] = ast.Assign(targets=[ast.Name(id="_last", ctx=ast.Store())], value=expr.value)
        ast.fix_missing_locations(tree)
    return compile(tree, "<pi-rlm-repl>", "exec"), captures_expr

_RESERVED = set(globals().keys()) | {"_RESERVED", "line", "msg"}

def _run_eval(msg):
    global _final_called, _final_value, _last, last, cwd
    eval_id = msg.get("id")
    code = msg.get("code") or ""
    cwd = msg.get("cwd") or cwd
    ctx._update(msg.get("context"))
    _logs.clear()
    _final_called = False
    _final_value = None
    try:
        compiled, captures_expr = _compile_user(code)
        try:
            exec(compiled, globals(), globals())
        except _FinalSignal:
            pass
        value = _final_value if _final_called else (_last if captures_expr else None)
        last = value
        _send({
            "type": "result",
            "id": eval_id,
            "ok": True,
            "final": _final_called,
            "value": value,
            "logs": "".join(_logs),
            "stateKeys": sorted(str(k) for k in state.keys()),
            "varKeys": _user_var_keys(),
        })
    except Exception as exc:
        _send({
            "type": "result",
            "id": eval_id,
            "ok": False,
            "error": str(exc),
            "traceback": traceback.format_exc(),
            "logs": "".join(_logs),
            "stateKeys": sorted(str(k) for k in state.keys()),
            "varKeys": _user_var_keys(),
        })

_send({"type": "ready"})

while True:
    line = _ORIG_STDIN.readline()
    if not line:
        break
    try:
        msg = json.loads(line)
        if msg.get("type") == "eval":
            _run_eval(msg)
        elif msg.get("type") == "shutdown":
            break
    except Exception:
        _send({"type": "worker_error", "error": traceback.format_exc()})
`;

interface PythonEvalResult {
  ok: boolean;
  final?: boolean;
  value?: unknown;
  logs?: string;
  error?: string;
  traceback?: string;
  stateKeys?: string[];
  varKeys?: string[];
}

interface BridgeContext {
  ctx: any;
  signal?: AbortSignal;
  onUpdate?: any;
  inherited?: RunState;
  parentDepth?: number;
  store?: ContextStore;
}

interface PendingEval {
  resolve: (value: PythonEvalResult) => void;
  reject: (err: Error) => void;
  timeoutMs: number;
  remainingMs: number;
  timerStartedAt?: number;
  timeout?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  controller?: AbortController;
}

function abortErrorText(signal?: AbortSignal): string {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason;
  return "Aborted.";
}

function composeAbortSignal(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  const signals = [a, b].filter(Boolean) as AbortSignal[];
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  const anyFn = (AbortSignal as any).any;
  if (typeof anyFn === "function") return anyFn(signals);

  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of signals) {
    if (signal.aborted) abort(signal);
    else signal.addEventListener("abort", () => abort(signal), { once: true });
  }
  return controller.signal;
}

function pythonCommand(): string {
  return process.env.PI_RLM_PYTHON?.trim() || "python3";
}

function absPath(cwd: string, input: string): string {
  return path.isAbsolute(input) ? input : path.join(cwd, input);
}

function objectExtra(extra: unknown): Record<string, unknown> {
  return isRecord(extra) ? extra : {};
}

function rejectUnknownReplParams(params: unknown): void {
  rejectUnknownKeys("rlm_repl params", params, REPL_PARAM_KEYS);
}

function renderCodePreview(code: unknown): string {
  if (typeof code !== "string" || !code.trim()) return "...";
  const first = code.trim().split("\n").find((line) => line.trim().length > 0) ?? code.trim();
  return clip(first.replace(/\s+/g, " "), 100);
}

function formatPythonValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

class PythonReplWorker {
  private proc: any;
  private rl: any;
  private nextEvalId = 1;
  private pending = new Map<number, PendingEval>();
  private current?: BridgeContext;
  private currentEvalId?: number;
  private stderr = "";
  private exited = false;

  constructor(private cwd: string) {
    const cmd = pythonCommand();
    this.proc = spawn(cmd, ["-u", "-c", PYTHON_WORKER], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line: string) => this.handleLine(line));
    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.stderr = clip(this.stderr + chunk.toString("utf8"), MAX_RESULT_CHARS);
    });
    this.proc.stdin?.on?.("error", (err: any) => {
      if (err?.code === "EPIPE" || err?.code === "ERR_STREAM_DESTROYED") {
        this.exited = true;
        this.failAll(new Error("Python REPL stdin closed."));
        return;
      }
      this.failAll(err instanceof Error ? err : new Error(errorText(err)));
    });
    this.proc.on("error", (err: Error) => this.failAll(err));
    this.proc.on("exit", (code: number | null, signal: string | null) => {
      this.exited = true;
      this.failAll(new Error(`Python REPL exited (${signal ?? code ?? "unknown"}).${this.stderr ? ` stderr: ${this.stderr}` : ""}`));
    });
  }

  isAlive(): boolean {
    return !this.exited && !this.proc.killed && !this.proc.stdin?.destroyed;
  }

  async eval(code: string, timeoutMs: number, bridge: BridgeContext): Promise<PythonEvalResult> {
    if (!this.isAlive()) throw new Error("Python REPL is not running.");
    if (this.current) throw new Error("Python REPL is already evaluating code.");
    if (bridge.signal?.aborted) {
      this.kill();
      throw new Error(abortErrorText(bridge.signal));
    }

    const id = this.nextEvalId++;
    const evalController = new AbortController();
    const evalSignal = composeAbortSignal(bridge.signal, evalController.signal);
    const evalBridge: BridgeContext = { ...bridge, signal: evalSignal };
    this.current = evalBridge;
    this.currentEvalId = id;

    const context = bridge.store
      ? {
          scratchDir: bridge.store.scratchDir,
          notesDir: bridge.store.notesDir,
          artifactsDir: bridge.store.artifactsDir,
          sources: bridge.store.sources.map(contextSourceSummary),
        }
      : undefined;

    let pendingForCleanup: PendingEval | undefined;
    return await new Promise<PythonEvalResult>((resolve, reject) => {
      const pending: PendingEval = {
        resolve,
        reject,
        timeoutMs,
        remainingMs: timeoutMs,
        controller: evalController,
      };
      pendingForCleanup = pending;
      const onAbort = () => {
        evalController.abort(bridge.signal?.reason ?? new Error("Aborted."));
        this.kill();
        reject(new Error(abortErrorText(bridge.signal)));
      };
      pending.onAbort = onAbort;

      bridge.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, pending);
      this.armEvalTimeout(id, pending);
      if (!this.write({ type: "eval", id, code, cwd: bridge.ctx.cwd, context })) {
        this.failAll(new Error("Python REPL stdin is closed."));
      }
    }).finally(() => {
      const pending = this.pending.get(id) ?? pendingForCleanup;
      if (pending?.timeout) clearTimeout(pending.timeout);
      if (pending) pending.timeout = undefined;
      if (pending?.onAbort) bridge.signal?.removeEventListener("abort", pending.onAbort);
      this.pending.delete(id);
      if (this.current === evalBridge) this.current = undefined;
      if (this.currentEvalId === id) this.currentEvalId = undefined;
    });
  }

  kill(): void {
    if (this.isAlive()) this.proc.kill("SIGKILL");
    this.exited = true;
  }

  shutdown(): void {
    if (!this.isAlive()) return;
    this.write({ type: "shutdown" });
    this.proc.kill();
  }

  private timeoutError(pending: PendingEval): Error {
    return new Error(
      `Python REPL local evaluation timed out after ${pending.timeoutMs}ms (time spent inside bridge helper calls is excluded).`,
    );
  }

  private armEvalTimeout(id: number, pending?: PendingEval): void {
    if (!pending || !this.pending.has(id)) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    const delay = Math.max(1, pending.remainingMs);
    pending.timerStartedAt = Date.now();
    pending.timeout = setTimeout(() => {
      if (!this.pending.has(id)) return;
      pending.timeout = undefined;
      const err = this.timeoutError(pending);
      pending.controller?.abort(err);
      this.kill();
      pending.reject(err);
    }, delay);
  }

  private pauseEvalTimeout(pending?: PendingEval): void {
    if (!pending?.timeout) return;
    clearTimeout(pending.timeout);
    pending.timeout = undefined;
    if (pending.timerStartedAt !== undefined) {
      pending.remainingMs = Math.max(0, pending.remainingMs - (Date.now() - pending.timerStartedAt));
      pending.timerStartedAt = undefined;
    }
  }

  private write(obj: unknown): boolean {
    if (!this.isAlive()) return false;
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    try {
      stdin.write(`${JSON.stringify(obj)}\n`);
      return true;
    } catch (e: any) {
      if (e?.code === "EPIPE" || e?.code === "ERR_STREAM_DESTROYED") {
        this.exited = true;
        return false;
      }
      throw e;
    }
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.stderr = clip(`${this.stderr}\n[non-json stdout] ${line}`, MAX_RESULT_CHARS);
      return;
    }

    if (msg?.type === "ready") return;
    if (msg?.type === "call") {
      void this.handleBridgeCall(msg);
      return;
    }
    if (msg?.type === "result") {
      const pending = this.pending.get(Number(msg.id));
      if (!pending) return;
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.timeout = undefined;
      pending.timerStartedAt = undefined;
      pending.resolve(msg as PythonEvalResult);
      return;
    }
    if (msg?.type === "worker_error") {
      this.stderr = clip(`${this.stderr}\n${msg.error ?? "worker_error"}`, MAX_RESULT_CHARS);
    }
  }

  private async handleBridgeCall(msg: any): Promise<void> {
    const bridge = this.current;
    const evalId = this.currentEvalId;
    const pending = evalId === undefined ? undefined : this.pending.get(evalId);
    if (!bridge || !this.isAlive()) return;

    this.pauseEvalTimeout(pending);
    let response: { ok: true; result: unknown } | { ok: false; error: string };
    try {
      response = { ok: true, result: await handleBridgeCall(msg.method, msg.params, bridge) };
    } catch (e) {
      response = { ok: false, error: errorText(e) };
    }

    if (this.current !== bridge || !this.isAlive() || bridge.signal?.aborted) return;
    if (!this.write({ type: "call_result", id: msg.id, ...response })) {
      this.failAll(new Error("Python REPL stdin is closed."));
      return;
    }
    if (evalId !== undefined) this.armEvalTimeout(evalId, pending);
  }


  private failAll(err: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.controller?.abort(err);
      pending.reject(err);
    }
    this.pending.clear();
    this.current = undefined;
    this.currentEvalId = undefined;
  }
}

async function handleBridgeCall(method: unknown, params: unknown, bridge: BridgeContext): Promise<unknown> {
  const p = objectExtra(params);
  if (method === "rlm") {
    const result = await dispatchRlmCall(bridge.ctx, p, bridge.inherited, bridge.parentDepth, bridge.signal, bridge.onUpdate);
    return { text: textOf(result.content).trim(), content: result.content, details: result.details };
  }

  if (method === "bash") {
    const command = typeof p.command === "string" ? p.command : "";
    if (!command.trim()) throw new Error("bash(command) requires a non-empty string.");
    const timeout = clamp(p.timeoutMs, DEFAULT_BASH_TIMEOUT_MS, 100, HARD_BASH_TIMEOUT_MS);
    const maxBuffer = clamp(p.maxBuffer, DEFAULT_BASH_MAX_BUFFER, 10_000, HARD_BASH_MAX_BUFFER);
    return await new Promise((resolve) => {
      execFile("bash", ["-lc", command], { cwd: bridge.ctx.cwd, timeout, maxBuffer, signal: bridge.signal }, (error: any, stdout: string, stderr: string) => {
        resolve({
          ok: !error,
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          signal: typeof error?.signal === "string" ? error.signal : null,
          stdout: clip(stdout || "", MAX_RESULT_CHARS),
          stderr: clip(stderr || error?.message || "", MAX_RESULT_CHARS),
        });
      });
    });
  }

  if (method === "read_file") {
    const file = typeof p.path === "string" ? p.path : "";
    if (!file.trim()) throw new Error("read_file(path) requires a non-empty path string.");
    const target = absPath(bridge.ctx.cwd, file);
    const s = await stat(target);
    if (!s.isFile()) throw new Error("read_file(path) only supports regular files.");
    const offset = clamp(p.offset, 0, 0, s.size);
    const chars = clamp(p.chars, Math.min(s.size - offset, MAX_RESULT_CHARS), 1, MAX_RESULT_CHARS);
    return await readFileSlice(target, chars, offset);
  }

  if (method === "list_dir") {
    const dir = typeof p.path === "string" && p.path.trim() ? p.path : ".";
    const entries = await readdir(absPath(bridge.ctx.cwd, dir), { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
    }));
  }

  if (method === "stat_file") {
    const file = typeof p.path === "string" ? p.path : "";
    if (!file.trim()) throw new Error("stat_file(path) requires a non-empty path string.");
    const s = await stat(absPath(bridge.ctx.cwd, file));
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs, mode: s.mode };
  }

  if (!bridge.store && String(method).startsWith("ctx_")) {
    throw new Error("No file-backed RLM context store is attached to this Python REPL.");
  }
  if (method === "ctx_manifest") return await ctxManifest(bridge.store!, p);
  if (method === "ctx_grep") return await ctxGrep(bridge.ctx.cwd, bridge.store!, p);
  if (method === "ctx_peek") return await ctxPeek(bridge.ctx.cwd, bridge.store!, p);
  if (method === "ctx_extract") return await ctxExtract(bridge.ctx.cwd, bridge.store!, p);
  if (method === "ctx_note") return await ctxWriteText(bridge.store!, "note", p);
  if (method === "ctx_artifact") return await ctxWriteText(bridge.store!, "artifact", p);

  throw new Error(`Unknown Python REPL bridge method: ${String(method)}.`);
}

export function createRlmReplTool(inherited?: RunState, parentDepth?: number, store?: ContextStore) {
  let worker: PythonReplWorker | undefined;
  let workerCwd: string | undefined;
  let evals = 0;

  return defineTool({
    name: REPL_TOOL_NAME,
    label: "RLM Python REPL",
    description:
      "Python RLM-aware REPL. Use it as a programmable control plane with persistent state, bash/read helpers, ctx helpers when present, and llm_query/rlm_query functions.",
    promptSnippet: "Python RLM REPL with llm_query/rlm_query/batching, state, bash/read helpers, FINAL/FINAL_VAR",
    promptGuidelines: [
      `Use ${REPL_TOOL_NAME} for non-trivial orchestration: loops, batching, state, synthesis, and finalization.`,
      `Write Python code. Helpers are synchronous: llm_query(...), llm_query_batched(...), rlm_query(...), rlm_query_batched(...), or rlm({...}). Batched helpers return list[str]; rlm({...}) returns { text, content, details }.`,
      `Persist cross-call variables in Python globals or in state, e.g. state["results"] = rlm_query_batched([...]). SHOW_VARS() summarizes variables/state.`,
      `Call FINAL(value) or FINAL_VAR("name") when the REPL result is the final answer.`,
      `Use bash(command), read_file(path), list_dir(path) for focused local inspection. Prefer recursive ${RLM_TOOL_NAME} calls for broad exploration.`,
      store ? `Use ctx.manifest(), ctx.grep(...), ctx.peek(...), ctx.extract(...), ctx.note(...), ctx.artifact(...) for file-backed RLM context.` : `No file-backed ${CTX_TOOL_NAME} context is attached to this REPL call unless a recursive RLM child supplied one.`,
    ],
    parameters: ReplParams,
    async execute(_id, params, signal, onUpdate, ctx) {
      rejectUnknownReplParams(params);
      if (params.reset === true) {
        worker?.shutdown();
        worker = undefined;
        workerCwd = undefined;
      }
      if (typeof params.code !== "string" || !params.code.trim()) throw new Error("Missing required code.");

      const timeoutMs = clamp(params.timeoutMs, DEFAULT_REPL_TIMEOUT_MS, 100, HARD_REPL_TIMEOUT_MS);
      if (!worker || !worker.isAlive() || workerCwd !== ctx.cwd) {
        worker?.shutdown();
        worker = new PythonReplWorker(ctx.cwd);
        workerCwd = ctx.cwd;
      }
      evals++;

      onUpdate?.({ content: [{ type: "text", text: `${REPL_TOOL_NAME}: evaluating Python via ${pythonCommand()} (${timeoutMs}ms local timeout; bridge calls excluded)...` }] });

      const result = await worker.eval(params.code, timeoutMs, { ctx, signal, onUpdate, inherited, parentDepth, store });
      if (!result.ok) {
        const text = clip([result.logs?.trim(), result.traceback || result.error].filter(Boolean).join("\n\n"), MAX_RESULT_CHARS);
        return {
          content: [{ type: "text", text }],
          details: {
            kind: "repl",
            language: "python",
            evals,
            final: false,
            timeoutMs,
            cwd: ctx.cwd,
            stateKeys: result.stateKeys ?? [],
            varKeys: result.varKeys ?? [],
            error: result.error,
            scratchDir: store?.scratchDir,
            contextSources: store?.sources.map(contextSourceSummary),
          },
        };
      }

      const sections: string[] = [];
      if (result.logs?.trim()) sections.push(`Console:\n${result.logs.trim()}`);
      if (result.final) sections.push(`FINAL:\n${formatPythonValue(result.value)}`);
      else if (result.value !== undefined && result.value !== null) sections.push(`Result:\n${formatPythonValue(result.value)}`);
      if (sections.length === 0) sections.push("(no output)");

      const text = clip(sections.join("\n\n"), MAX_RESULT_CHARS);
      return {
        content: [{ type: "text", text }],
        details: {
          kind: "repl",
          language: "python",
          evals,
          final: result.final === true,
          timeoutMs,
          cwd: ctx.cwd,
          stateKeys: result.stateKeys ?? [],
          varKeys: result.varKeys ?? [],
          scratchDir: store?.scratchDir,
          contextSources: store?.sources.map(contextSourceSummary),
        },
        terminate: result.final === true,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold(REPL_TOOL_NAME))} ${theme.fg("muted", renderCodePreview(args?.code))}`,
        0,
        0,
      );
    },
    renderResult(result, { isPartial }: any, theme) {
      const text = textOf(result.content).trim();
      if (isPartial) return new Text(theme.fg("warning", text || "running..."), 0, 0);
      const final = result.details?.final ? theme.fg("success", " FINAL") : "";
      const vars = Array.isArray(result.details?.varKeys) && result.details.varKeys.length
        ? ` vars=${result.details.varKeys.join(",")}`
        : Array.isArray(result.details?.stateKeys) && result.details.stateKeys.length
          ? ` state=${result.details.stateKeys.join(",")}`
          : "";
      const err = result.details?.error ? theme.fg("error", " error") : "";
      return new Text(
        `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold(REPL_TOOL_NAME))}${final}${err}${theme.fg("muted", vars)}\n${theme.fg("toolOutput", clip(text.replace(/\s+/g, " "), 800))}`,
        0,
        0,
      );
    },
  });
}
