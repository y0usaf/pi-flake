#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from statistics import mean, median
from typing import Any


def _duration_seconds(stage: dict[str, Any] | None) -> float | None:
    if not stage or not stage.get("started_at") or not stage.get("finished_at"):
        return None
    start = datetime.fromisoformat(stage["started_at"].replace("Z", "+00:00"))
    finish = datetime.fromisoformat(stage["finished_at"].replace("Z", "+00:00"))
    return (finish - start).total_seconds()


def _cell(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text())
    agent = data.get("agent_result") or {}
    metadata = agent.get("metadata") or {}
    rewards = (data.get("verifier_result") or {}).get("rewards") or {}
    input_tokens = agent.get("n_input_tokens")
    cache_tokens = agent.get("n_cache_tokens")
    output_tokens = agent.get("n_output_tokens")
    combined = metadata.get("combined_total_tokens")
    if combined is None and input_tokens is not None and output_tokens is not None:
        combined = input_tokens + output_tokens
    fresh = metadata.get("fresh_input_tokens")
    if fresh is None and input_tokens is not None and cache_tokens is not None:
        fresh = input_tokens - cache_tokens
    task = str(data.get("task_name") or path.parent.name).rsplit("/", 1)[-1]
    return {
        "task": task,
        "trial": path.parent.name,
        "started_at": data.get("started_at") or "",
        "reward": rewards.get("reward"),
        "partial": rewards.get("partial"),
        "tokens": combined,
        "fresh_tokens": fresh,
        "cache_tokens": cache_tokens,
        "output_tokens": output_tokens,
        "cost_usd": agent.get("cost_usd"),
        "peak_context_tokens": agent.get("peak_context_tokens"),
        "agent_wall_s": _duration_seconds(data.get("agent_execution")),
        "steps": agent.get("n_agent_steps"),
        "outer_calls": metadata.get("outer_tool_calls"),
        "nested_calls": metadata.get("nested_tool_calls"),
        "fabric_failures": metadata.get("fabric_failures"),
        "whole_reads": metadata.get("whole_file_reads"),
        "bounded_reads": metadata.get("bounded_reads"),
        "visible_result_chars": metadata.get("model_visible_result_chars"),
        "max_result_chars": metadata.get("max_result_chars"),
        "results_over_50kb": metadata.get("results_over_50kb"),
        "fabric_enabled": metadata.get("fabric_enabled"),
    }


def load_job(path: Path) -> list[dict[str, Any]]:
    cells = []
    for result in sorted(path.glob("*/result.json")):
        cells.append(_cell(result))
    if not cells:
        raise ValueError(f"No trial results found under {path}")
    by_task: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for cell in cells:
        by_task[cell["task"]].append(cell)
    for task_cells in by_task.values():
        task_cells.sort(key=lambda cell: (cell["started_at"], cell["trial"]))
        for rep, cell in enumerate(task_cells):
            cell["rep"] = rep
    return sorted(cells, key=lambda cell: (cell["task"], cell["rep"]))


def _values(cells: list[dict[str, Any]], key: str) -> list[float]:
    return [float(cell[key]) for cell in cells if isinstance(cell.get(key), (int, float))]


def summarize(cells: list[dict[str, Any]]) -> dict[str, Any]:
    whole = sum(_values(cells, "whole_reads"))
    bounded = sum(_values(cells, "bounded_reads"))
    reads = whole + bounded
    summary: dict[str, Any] = {
        "trials": len(cells),
        "tasks": len({cell["task"] for cell in cells}),
        "solves": sum(cell.get("reward") == 1 for cell in cells),
        "mean_partial": mean(_values(cells, "partial")),
        "whole_read_rate": whole / reads if reads else None,
        "fabric_failures": sum(_values(cells, "fabric_failures")),
        "results_over_50kb": sum(_values(cells, "results_over_50kb")),
        "total_cost_usd": sum(_values(cells, "cost_usd")),
    }
    for key in (
        "tokens",
        "fresh_tokens",
        "cache_tokens",
        "output_tokens",
        "cost_usd",
        "peak_context_tokens",
        "agent_wall_s",
        "steps",
        "outer_calls",
        "nested_calls",
        "visible_result_chars",
        "max_result_chars",
    ):
        values = _values(cells, key)
        summary[f"median_{key}"] = median(values) if values else None
    return summary


def pair_cells(
    left: list[dict[str, Any]],
    right: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    left_index = {(cell["task"], cell["rep"]): cell for cell in left}
    right_index = {(cell["task"], cell["rep"]): cell for cell in right}
    if left_index.keys() != right_index.keys():
        missing_left = sorted(right_index.keys() - left_index.keys())
        missing_right = sorted(left_index.keys() - right_index.keys())
        raise ValueError(
            f"Jobs are not matched; missing left={missing_left[:5]}, missing right={missing_right[:5]}"
        )
    pairs = []
    for key in sorted(left_index):
        a, b = left_index[key], right_index[key]
        delta = {}
        for metric in (
            "reward",
            "partial",
            "tokens",
            "cost_usd",
            "agent_wall_s",
            "steps",
            "outer_calls",
            "peak_context_tokens",
        ):
            if isinstance(a.get(metric), (int, float)) and isinstance(b.get(metric), (int, float)):
                delta[metric] = b[metric] - a[metric]
        pairs.append({"task": key[0], "rep": key[1], "left": a, "right": b, "delta": delta})
    return pairs


def paired_summary(pairs: list[dict[str, Any]]) -> dict[str, Any]:
    result = {"pairs": len(pairs)}
    for metric in (
        "reward",
        "partial",
        "tokens",
        "cost_usd",
        "agent_wall_s",
        "steps",
        "outer_calls",
        "peak_context_tokens",
    ):
        values = [pair["delta"][metric] for pair in pairs if metric in pair["delta"]]
        result[f"median_delta_{metric}"] = median(values) if values else None
        result[f"mean_delta_{metric}"] = mean(values) if values else None
    return result


def _fmt(value: Any, digits: int = 1) -> str:
    if value is None:
        return "n/a"
    if isinstance(value, int):
        return f"{value:,}"
    return f"{value:,.{digits}f}"


def print_report(labels: tuple[str, str], summaries: tuple[dict[str, Any], dict[str, Any]], paired: dict[str, Any]) -> None:
    print("| Metric | " + " | ".join(labels) + " |")
    print("|---|---:|---:|")
    rows = [
        ("Full solves", lambda s: f"{s['solves']}/{s['trials']}"),
        ("Mean partial", lambda s: _fmt(s["mean_partial"], 4)),
        ("Median tokens", lambda s: _fmt(s["median_tokens"], 0)),
        ("Median cost", lambda s: "$" + _fmt(s["median_cost_usd"], 3)),
        ("Total cost", lambda s: "$" + _fmt(s["total_cost_usd"], 2)),
        ("Median agent wall", lambda s: _fmt(s["median_agent_wall_s"], 1) + "s"),
        ("Median steps", lambda s: _fmt(s["median_steps"], 1)),
        ("Median outer calls", lambda s: _fmt(s["median_outer_calls"], 1)),
        ("Median peak context", lambda s: _fmt(s["median_peak_context_tokens"], 0)),
        ("Whole-read rate", lambda s: _fmt(100 * s["whole_read_rate"], 1) + "%" if s["whole_read_rate"] is not None else "n/a"),
        ("Fabric failures", lambda s: _fmt(s["fabric_failures"], 0)),
        ("Results over 50KB", lambda s: _fmt(s["results_over_50kb"], 0)),
    ]
    for name, render in rows:
        print(f"| {name} | {render(summaries[0])} | {render(summaries[1])} |")
    print()
    print("Paired median deltas (right − left):")
    for metric in ("reward", "partial", "tokens", "cost_usd", "agent_wall_s", "steps", "outer_calls", "peak_context_tokens"):
        print(f"- {metric}: {_fmt(paired.get('median_delta_' + metric), 3)}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare two matched Pier DeepSWE jobs")
    parser.add_argument("left", type=Path)
    parser.add_argument("right", type=Path)
    parser.add_argument("--left-label", default="baseline")
    parser.add_argument("--right-label", default="fabric")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    left = load_job(args.left)
    right = load_job(args.right)
    pairs = pair_cells(left, right)
    summaries = (summarize(left), summarize(right))
    paired = paired_summary(pairs)
    print_report((args.left_label, args.right_label), summaries, paired)
    if args.output:
        payload = {
            "labels": [args.left_label, args.right_label],
            "summaries": {args.left_label: summaries[0], args.right_label: summaries[1]},
            "paired": paired,
            "cells": pairs,
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(payload, indent=2) + "\n")


if __name__ == "__main__":
    main()
