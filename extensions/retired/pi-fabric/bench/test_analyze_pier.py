import json
import tempfile
import unittest
from pathlib import Path

from analyze_pier import load_job, pair_cells, paired_summary, summarize


class AnalyzePierTest(unittest.TestCase):
    def _write_cell(
        self,
        root: Path,
        trial: str,
        task: str,
        started: str,
        *,
        reward: int,
        tokens: int,
        outer_calls: int,
        fabric: bool,
    ) -> None:
        path = root / trial
        path.mkdir(parents=True)
        payload = {
            "task_name": f"datacurve/{task}",
            "started_at": started,
            "agent_execution": {
                "started_at": "2026-01-01T00:00:00Z",
                "finished_at": "2026-01-01T00:01:00Z",
            },
            "agent_result": {
                "n_input_tokens": tokens - 100,
                "n_cache_tokens": tokens - 200,
                "n_output_tokens": 100,
                "cost_usd": tokens / 1_000_000,
                "peak_context_tokens": 1_000,
                "n_agent_steps": 4,
                "metadata": {
                    "combined_total_tokens": tokens,
                    "fresh_input_tokens": 100,
                    "outer_tool_calls": outer_calls,
                    "nested_tool_calls": 5 if fabric else 0,
                    "fabric_failures": 1 if fabric else 0,
                    "whole_file_reads": 1,
                    "bounded_reads": 3,
                    "model_visible_result_chars": 2_000,
                    "max_result_chars": 500,
                    "results_over_50kb": 0,
                    "fabric_enabled": fabric,
                },
            },
            "verifier_result": {
                "rewards": {"reward": reward, "partial": float(reward)},
            },
        }
        (path / "result.json").write_text(json.dumps(payload))

    def test_pairs_attempts_by_task_start_order_and_summarizes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            left, right = root / "left", root / "right"
            self._write_cell(left, "a-late", "a", "2026-01-02", reward=1, tokens=400, outer_calls=3, fabric=False)
            self._write_cell(left, "a-early", "a", "2026-01-01", reward=0, tokens=300, outer_calls=4, fabric=False)
            self._write_cell(right, "a-1", "a", "2026-01-01", reward=1, tokens=280, outer_calls=2, fabric=True)
            self._write_cell(right, "a-2", "a", "2026-01-02", reward=1, tokens=360, outer_calls=2, fabric=True)

            left_cells, right_cells = load_job(left), load_job(right)
            pairs = pair_cells(left_cells, right_cells)
            self.assertEqual([cell["rep"] for cell in left_cells], [0, 1])
            self.assertEqual([pair["delta"]["tokens"] for pair in pairs], [-20, -40])
            self.assertEqual(summarize(right_cells)["solves"], 2)
            self.assertEqual(summarize(right_cells)["whole_read_rate"], 0.25)
            self.assertEqual(paired_summary(pairs)["median_delta_outer_calls"], -1.5)

    def test_rejects_unmatched_jobs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            left, right = root / "left", root / "right"
            self._write_cell(left, "a", "a", "2026-01-01", reward=1, tokens=100, outer_calls=2, fabric=False)
            self._write_cell(right, "b", "b", "2026-01-01", reward=1, tokens=100, outer_calls=2, fabric=True)
            with self.assertRaisesRegex(ValueError, "not matched"):
                pair_cells(load_job(left), load_job(right))


if __name__ == "__main__":
    unittest.main()
