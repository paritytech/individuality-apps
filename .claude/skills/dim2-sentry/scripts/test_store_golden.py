# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""Tests for the store/live golden gate.  python3 -m unittest test_store_golden -v"""
import importlib.util
import contextlib
import io
import json
import os
import tempfile
import types
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    "store_golden", os.path.join(os.path.dirname(__file__), "store_golden.py"))
golden = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(golden)


class GoldenComparisonTest(unittest.TestCase):
    def write(self, root, name, value):
        path = os.path.join(root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(value, fh, separators=(",", ":"))

    def test_golden_has_no_normalisation_outside_case_C(self):
        with tempfile.TemporaryDirectory() as left, tempfile.TemporaryDirectory() as right:
            # Object key order is the one G1 exception for sentry-pull; list order is evidence.
            self.write(left, "sentry-pull.json", {"b": 1, "a": [2, 1]})
            self.write(right, "sentry-pull.json", {"a": [2, 1], "b": 1})
            self.assertEqual(golden.compare_json_files(
                os.path.join(left, "sentry-pull.json"), os.path.join(right, "sentry-pull.json")), [])
            self.write(right, "sentry-pull.json", {"a": [1, 2], "b": 1})
            self.assertEqual(golden.compare_json_files(
                os.path.join(left, "sentry-pull.json"), os.path.join(right, "sentry-pull.json")), ["$.a[0]", "$.a[1]"])
            self.assertEqual(golden.PERCENTILE_CASE, "B")
            self.assertEqual(golden.PERCENTILE_PATHS, ())

    def test_report_links_and_usernames_are_byte_exact(self):
        with tempfile.TemporaryDirectory() as left, tempfile.TemporaryDirectory() as right:
            for name in golden.BYTE_EXACT:
                self.write(left, name, {"a": 1, "b": 2})
                self.write(right, name, {"b": 2, "a": 1})
            self.assertEqual(golden.compare_legs(left, right), [
                "links.json:$ (bytes)", "report.json:$ (bytes)", "usernames.json:$ (bytes)"])

    def test_live_store_report_comparison_removes_only_top_level_data_as_of(self):
        with tempfile.TemporaryDirectory() as stored, tempfile.TemporaryDirectory() as live:
            for root in (stored, live):
                for name in ("links.json", "usernames.json", "sentry-pull.json"):
                    self.write(root, name, {"same": True})
            self.write(stored, "report.json", {
                "game": 7, "dataAsOf": "17 Oct 2026, 09:00 CEST",
                "nested": {"dataAsOf": "evidence"},
            })
            self.write(live, "report.json", {
                "game": 7, "nested": {"dataAsOf": "evidence"},
            })
            self.assertEqual(golden.compare_legs(stored, live), [])

            self.write(live, "report.json", {
                "game": 7, "nested": {"dataAsOf": "changed"},
            })
            self.assertEqual(golden.compare_legs(stored, live), [
                "report.json:$.nested.dataAsOf",
            ])

    def test_data_as_of_normalisation_keeps_report_key_order_byte_exact(self):
        with tempfile.TemporaryDirectory() as stored, tempfile.TemporaryDirectory() as live:
            for root in (stored, live):
                for name in ("links.json", "usernames.json", "sentry-pull.json"):
                    self.write(root, name, {"same": True})
            self.write(stored, "report.json", {
                "game": 7,
                "dataAsOf": "17 Oct 2026, 09:00 CEST",
                "nested": {"same": True},
            })
            self.write(live, "report.json", {
                "nested": {"same": True},
                "game": 7,
            })
            self.assertEqual(golden.compare_legs(stored, live), [
                "report.json:$ (bytes)",
            ])

    def test_determinism_checks_bytes_before_live_comparison(self):
        with tempfile.TemporaryDirectory() as one, tempfile.TemporaryDirectory() as two:
            for name in golden.ARTIFACTS:
                self.write(one, name, {"same": True})
                self.write(two, name, {"same": True})
            self.assertEqual(golden.compare_determinism(one, two), [])
            self.write(two, "sentry-pull.json", {"same": True, "extra": 1})
            self.assertEqual(golden.compare_determinism(one, two), ["sentry-pull.json:$"])


class GoldenRunnerTest(unittest.TestCase):
    def store(self, root, late_complete=True):
        folder = os.path.join(root, "paseo", "g7")
        os.makedirs(folder)
        golden._write_json(os.path.join(folder, "manifest.json"), {
            "pass": True, "late_complete": late_complete,
            "data_as_of_local": "17 Oct 2026, 09:00 CEST",
            "projects": {"jollity-next": "1", "dim2-testing": "2"},
        })
        golden._write_json(os.path.join(folder, "inputs.json"), {
            "usernames": {"5A": "alice"}, "siblingUsernames": {"5B": "bob"},
        })
        golden._write_json(os.path.join(folder, "chain.json"), {"game": 7})
        return folder

    def test_refuses_before_running_a_leg_when_late_is_incomplete(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.object(golden, "run_leg") as run:
            self.store(root, late_complete=False)
            self.assertEqual(golden.main(["7", "--store-root", root]), 1)
            run.assert_not_called()

    def test_runs_two_store_processes_before_live_with_every_frozen_input(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as evidence:
            folder = self.store(root)
            calls = []
            def run(label, command, directory, seed=None):
                calls.append((label, command, directory, seed))
                return True
            with mock.patch.object(golden, "run_leg", side_effect=run), \
                 mock.patch.object(golden, "compare_determinism", return_value=[]), \
                 mock.patch.object(golden, "compare_legs", return_value=[]), \
                 mock.patch.object(golden.subprocess, "run", return_value=types.SimpleNamespace(stdout="abc123\n")):
                self.assertEqual(golden.main([
                    "7", "--store-root", root, "--evidence-dir", evidence]), 0)
            self.assertEqual([(label, seed) for label, _, _, seed in calls], [
                ("store seed 1", 1), ("store seed 2", 2), ("live", None)])
            for _, command, directory, _ in calls:
                for flag in ("--usernames", "--sibling-usernames", "--chain-json", "--logs-dir", "--no-log-cache"):
                    self.assertIn(flag, command)
                self.assertEqual(command[command.index("--chain-json") + 1], os.path.join(folder, "chain.json"))
                self.assertTrue(command[command.index("--usernames") + 1].startswith(directory))
                self.assertTrue(command[command.index("--sibling-usernames") + 1].startswith(directory))
            self.assertIn("--from-store", calls[0][1])
            self.assertIn("--from-store", calls[1][1])
            self.assertNotIn("--from-store", calls[2][1])
            self.assertEqual(calls[2][1][calls[2][1].index("--project") + 1],
                             "jollity-next,dim2-testing")

    def test_prints_evidence_root_before_a_leg_crashes(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as parent:
            self.store(root)
            evidence = os.path.join(parent, "preserved")
            output = io.StringIO()
            with mock.patch.object(golden, "run_leg", side_effect=RuntimeError("crash")), \
                 contextlib.redirect_stdout(output), self.assertRaisesRegex(RuntimeError, "crash"):
                golden.main(["7", "--store-root", root, "--evidence-dir", evidence])
            self.assertIn("evidence: %s" % evidence, output.getvalue())


if __name__ == "__main__":
    unittest.main()
