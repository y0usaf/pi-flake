import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { runBatch } from "./batch.js";
import { runRlmQuery } from "./child-session.js";
import type { RunState } from "./constants.js";
import { runLlmQuery } from "./llm.js";
import {
  childDepth,
  currentDepth,
  normalizeCall,
  rejectUnknownParams,
  singleItemFromParams,
  stateFor,
} from "./utils.js";

export async function dispatchRlmCall(
  ctx: ExtensionContext,
  params: any,
  inherited?: RunState,
  parentDepth?: number,
  signal?: AbortSignal,
  onUpdate?: any,
) {
  rejectUnknownParams(params);
  const state = stateFor(params, inherited, ctx.model);
  const call = normalizeCall(params.call);

  if (call === "llm_query") {
    return runLlmQuery(ctx, singleItemFromParams(params), state.budget, currentDepth(parentDepth), state, signal, onUpdate, "llm_query");
  }
  if (call === "llm_query_batched") {
    return runBatch(ctx, params, "llm_query_batched", currentDepth(parentDepth), state, signal, onUpdate);
  }
  if (call === "rlm_query") {
    return runRlmQuery(ctx, singleItemFromParams(params), childDepth(parentDepth), state, signal, onUpdate);
  }
  return runBatch(ctx, params, "rlm_query_batched", childDepth(parentDepth), state, signal, onUpdate);
}
