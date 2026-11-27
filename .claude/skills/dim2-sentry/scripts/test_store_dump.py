"""Tests for store_dump.py's dataset capture and completeness checks."""
import os
import sys
import json
import datetime
import importlib.util
import re
import tempfile
import threading
import time
import types
import unittest
from unittest import mock

try:
    import pyarrow, duckdb  # noqa: F401
except ImportError:
    raise unittest.SkipTest(
        "store tests need the skill venv: .claude/skills/dim2-sentry/.venv/bin/python -m pytest")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sentry  # noqa: E402
import store_dump  # noqa: E402
sentry_logs = store_dump._load_script("sentry_logs")


class DiscoveryAndGroups(unittest.TestCase):
    def test_report_transaction_subset_and_refresh_preservation(self):
        transactions = [
            {"id": "old", "timestamp": "1", "user.id": "alice", "host.kind": "ios"},
            {"id": "new", "timestamp": "2", "user.id": "alice", "host.kind": "ios"},
            {"id": "payoff", "timestamp": "1", "transaction": "journey.payoff"},
            {"id": "other", "timestamp": "3", "transaction": "journey.other"},
        ]
        self.assertEqual(
            [row["id"] for row in store_dump._report_transaction_sources(transactions)],
            ["new", "payoff"],
        )
        old_rows = [
            {"id": "new", "dataset": "transactions", "status": 404},
            {"id": "gone", "dataset": "transactions", "status": 200},
            {"id": "error", "dataset": "errors", "status": 200},
        ]
        self.assertEqual(
            store_dump._preserved_transaction_rows(old_rows, {"new"}),
            [old_rows[0]],
        )

    def test_base_covers_section_6_and_store_source_consumer_fields(self):
        """Built-in and typed fields are not guaranteed by attribute discovery."""
        spec = importlib.util.spec_from_file_location(
            "store_field_audit_game_report_pull", os.path.join(HERE, "game-report-pull.py"))
        puller = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(puller)

        def raw_fields(fields):
            raw = set()
            for field in fields:
                match = re.fullmatch(r"(?:count|sum|min|max|p50)\(([^)]*)\)", field)
                if match:
                    if match.group(1):
                        raw.add(match.group(1))
                else:
                    raw.add(field)
            return raw

        required = {
            # Section 6 plus game-report-pull ROOT_FIELDS and STEP_FIELDS.
            "spans": set(puller.ROOT_FIELDS) | set(puller.STEP_FIELDS) | {"user.id"},
            "errors": {
                # Game-report events, legacy game-log attachments, usernames and reminders.
                "project", "user.id", "user.username", "received", "title", "level",
                "environment", "game.index", "test.tag", "game_log.stage",
                "game_log.checkpoint", "game_log.seq", "sdk.name", "chat.count",
                "outcome", "complete",
            },
            "transactions": set(puller.SEND_RUNG_FIELDS) | {
                # Device/payoff detail routing and the send-adaptation transaction.
                "project", "user.id", "transaction", "host.kind", "game.index",
                "measurement_set",
            },
            "tracemetrics": raw_fields(
                puller.METRIC_FIELDS + puller.COVERAGE_METRIC_FIELDS
                + puller.LINK_PAIR_FIELDS + puller.LINK_KIND_FIELDS) | {
                # Section 6 and every grouping/filter dependency of metric_groups.
                "metric.name", "value", "rtc.path", "stat", "release", "session.id",
                "game.index",
            },
            # sentry_logs.LOG_FIELDS, used by fetch_logs through T10/T11.
            "logs": set(sentry_logs.LOG_FIELDS),
        }
        for dataset, fields in required.items():
            with self.subTest(dataset=dataset):
                missing = fields - set(store_dump.KEY_FIELDS) - set(store_dump.BASE[dataset])
                self.assertEqual(missing, set())
        numeric = {
            "tags[game_log.first_ts_ms,number]", "tags[game_log.captured_ms,number]",
        } | {field for field in puller.SEND_RUNG_FIELDS if field.startswith("measurements.")}
        self.assertEqual(
            {field: store_dump._kind(field) for field in numeric},
            dict.fromkeys(numeric, "number"),
        )
        self.assertEqual(store_dump._kind("sentry.observed_timestamp_nanos"), "int")

    def test_observed_timestamp_nanos_round_trips_exactly_for_log_reader(self):
        nanos = "1792010400800848123"
        row = {
            "id": "log-1", "timestamp": "2026-10-15T12:00:00Z",
            "user.id": "5Exact", "session.id": "session-1", "game.index": "1",
            "game_log.stage": "chunk", "game_log.item": "item-1",
            "game_log.record": "0", "game_log.records": "1",
            "message": "2026-10-15T12:00:00Z INFO app: ready",
            sentry_logs.OBSERVED_FIELD: nanos,
        }
        columns = [(field, store_dump._kind(field)) for field in sentry_logs.LOG_FIELDS]
        table, _json_columns = store_dump.store_write.rows_to_table([row], columns, {})
        stored = table.to_pylist()[0]
        self.assertEqual(stored[sentry_logs.OBSERVED_FIELD], int(nanos))
        restored = sentry_logs.records_to_items([stored])
        self.assertEqual(restored["5Exact"]["chunks"][0]["_receivedAt"], int(nanos) // 1_000_000)

    def test_groups_never_exceed_the_cap_and_all_carry_id_timestamp(self):
        columns = [("id", "string"), ("timestamp", "string")] + [
            (f"tags[k{i}]", "string") for i in range(117)]
        groups = store_dump.field_groups(columns)
        self.assertGreater(len(groups), 1)
        self.assertTrue(all(len(group) <= store_dump.MAX_FIELDS for group in groups))
        self.assertTrue(all(group[:2] == store_dump.KEY_FIELDS for group in groups))
        self.assertEqual(
            [field for group in groups for field in group[2:]],
            [field for field, _kind in columns[2:]],
        )

    def test_discover_uses_dataset_specific_sources_and_dedupes(self):
        attrs = [
            {"field": "project", "name": "project", "type": "string"},
            {"field": "tags[n,number]", "name": "n", "type": "number"},
        ]
        with mock.patch.object(sentry, "attribute_keys", return_value=attrs) as keys:
            got = store_dump.discover("spans", "s", "e", "p1")
        keys.assert_called_once_with("spans", "s", "e", pids=["p1"])
        self.assertEqual(got[:2], [("id", "string"), ("timestamp", "string")])
        self.assertEqual(got.count(("project", "string")), 1)
        self.assertIn(("tags[n,number]", "number"), got)

        with (mock.patch.object(sentry, "tag_keys", return_value=["release", "custom"]) as tags,
              mock.patch.object(sentry, "measurement_keys", return_value=["measurements.foo"]) as measures):
            got = store_dump.discover("transactions", "s", "e", "p2")
        tags.assert_called_once_with("transactions", "s", "e", pids=["p2"])
        measures.assert_called_once_with("s", "e", pids=["p2"])
        self.assertEqual(got.count(("release", "string")), 1)
        self.assertNotIn(("tags[release]", "string"), got)
        self.assertIn(("tags[custom]", "string"), got)
        self.assertIn(("measurements.foo", "number"), got)


class DatasetDump(unittest.TestCase):
    COLUMNS = [
        ("id", "string"),
        ("timestamp", "string"),
        ("title", "string"),
        ("tags[extra]", "string"),
    ]

    @staticmethod
    def _page(fields, reverse=False):
        rows = []
        ids = ["a", "b"]
        if reverse:
            ids.reverse()
        for event_id in ids:
            row = {"id": event_id, "timestamp": "2026-10-15T10:00:00Z"}
            for field in fields:
                if field not in row:
                    row[field] = f"{field}-{event_id}"
            rows.append(row)
        return [rows]

    def _run(self, page_side_effect=None, count_side_effect=None, dataset="errors"):
        if page_side_effect is None:
            page_side_effect = lambda _dataset, _query, fields, **_kwargs: self._page(fields)
        if count_side_effect is None:
            count_side_effect = [2, 2]
        with (mock.patch.object(sentry, "pages", side_effect=page_side_effect) as pages,
              mock.patch.object(sentry, "count", side_effect=count_side_effect) as count):
            rows, check = store_dump.dump_dataset(
                dataset, "game.index:254", "s", "e", "pid", self.COLUMNS)
        return rows, check, pages, count

    def test_merge_by_id_across_groups(self):
        old_cap = store_dump.MAX_FIELDS
        store_dump.MAX_FIELDS = 3
        self.addCleanup(setattr, store_dump, "MAX_FIELDS", old_cap)

        calls = 0
        def pages(_dataset, _query, fields, **_kwargs):
            nonlocal calls
            calls += 1
            return self._page(fields, reverse=calls == 2)

        rows, check, _pages, _count = self._run(page_side_effect=pages)
        self.assertEqual([row["id"] for row in rows], ["a", "b"])
        self.assertEqual(rows[0]["title"], "title-a")
        self.assertEqual(rows[0]["tags[extra]"], "tags[extra]-a")
        self.assertTrue(check["group_id_sets_equal"])
        self.assertTrue(check["pass"])

    def test_mismatched_group_is_reread_against_a_stable_id_spine(self):
        old_cap = store_dump.MAX_FIELDS
        store_dump.MAX_FIELDS = 3
        self.addCleanup(setattr, store_dump, "MAX_FIELDS", old_cap)
        extra_reads = 0

        def pages(_dataset, _query, fields, **_kwargs):
            nonlocal extra_reads
            ids = ["a", "b"]
            if "tags[extra]" in fields:
                extra_reads += 1
                if extra_reads <= 2:
                    ids = ["a", "c"]
            rows = []
            for event_id in ids:
                row = {"id": event_id, "timestamp": "2026-10-15T10:00:00Z"}
                row.update({field: "%s-%s" % (field, event_id)
                            for field in fields if field not in row})
                rows.append(row)
            return [rows]

        with (mock.patch.object(sentry, "pages", side_effect=pages),
              mock.patch.object(sentry, "count", return_value=2)):
            rows, check = store_dump.dump_dataset(
                "errors", "game.index:254", "s", "e", "pid", self.COLUMNS)
        self.assertEqual([row["id"] for row in rows], ["a", "b"])
        self.assertEqual(extra_reads, 3)
        self.assertEqual(check["group_retries"], [0, 2])
        self.assertTrue(check["group_id_sets_equal"])

    def test_persistent_group_mismatch_still_fails_closed(self):
        old_cap = store_dump.MAX_FIELDS
        store_dump.MAX_FIELDS = 3
        self.addCleanup(setattr, store_dump, "MAX_FIELDS", old_cap)

        def pages(_dataset, _query, fields, **_kwargs):
            ids = ["a", "c"] if "tags[extra]" in fields else ["a", "b"]
            return [[{"id": event_id, "timestamp": "2026-10-15T10:00:00Z"}
                     for event_id in ids]]

        with (mock.patch.object(sentry, "pages", side_effect=pages),
              mock.patch.object(sentry, "count", return_value=2)):
            with self.assertRaises(store_dump.DumpFailed) as caught:
                store_dump.dump_dataset(
                    "errors", "game.index:254", "s", "e", "pid", self.COLUMNS)
        self.assertFalse(caught.exception.check["pass"])
        self.assertEqual(caught.exception.check["group_retries"], [0, 2])
        self.assertEqual(caught.exception.check["rows_stored"], 0)

    def test_group_id_sets_differ_retries_then_fails(self):
        old_cap = store_dump.MAX_FIELDS
        store_dump.MAX_FIELDS = 3
        self.addCleanup(setattr, store_dump, "MAX_FIELDS", old_cap)

        calls = 0
        def pages(_dataset, _query, fields, **_kwargs):
            nonlocal calls
            calls += 1
            rows = self._page(fields)[0]
            return [[rows[0]]] if "tags[extra]" in fields else [rows]

        with (mock.patch.object(sentry, "pages", side_effect=pages),
              mock.patch.object(sentry, "count", side_effect=[2, 2, 2, 2])):
            with self.assertRaises(store_dump.DumpFailed) as caught:
                store_dump.dump_dataset("errors", "q", "s", "e", "pid", self.COLUMNS)
        self.assertFalse(caught.exception.check["group_id_sets_equal"])
        self.assertEqual(calls, 10)

    def test_differ_once_then_pass(self):
        old_cap = store_dump.MAX_FIELDS
        store_dump.MAX_FIELDS = 3
        self.addCleanup(setattr, store_dump, "MAX_FIELDS", old_cap)

        calls = 0
        def pages(_dataset, _query, fields, **_kwargs):
            nonlocal calls
            calls += 1
            rows = self._page(fields)[0]
            return [[rows[0]]] if calls == 2 else [rows]

        with (mock.patch.object(sentry, "pages", side_effect=pages),
              mock.patch.object(sentry, "count", side_effect=[2, 2, 2, 2])):
            rows, check = store_dump.dump_dataset("errors", "q", "s", "e", "pid", self.COLUMNS)
        self.assertEqual(len(rows), 2)
        self.assertTrue(check["pass"])
        self.assertEqual(calls, 4)

    def test_page_two_failure_retries_the_entire_dataset(self):
        calls = 0

        def pages(_dataset, _query, fields, **_kwargs):
            nonlocal calls
            calls += 1
            yield self._page(fields)[0]
            if calls == 1:
                raise ValueError("page 2 was not JSON")

        with (mock.patch.object(sentry, "pages", side_effect=pages),
              mock.patch.object(sentry, "count", side_effect=[2, 2, 2])):
            rows, check = store_dump.dump_dataset(
                "errors", "q", "s", "e", "pid", self.COLUMNS)
        self.assertEqual([row["id"] for row in rows], ["a", "b"])
        self.assertTrue(check["pass"])
        self.assertEqual(calls, 2)

    def test_count_moved_during_paging_fails(self):
        with (mock.patch.object(sentry, "pages", side_effect=lambda _d, _q, f, **_k: self._page(f)),
              mock.patch.object(sentry, "count", side_effect=[2, 3, 2, 3])):
            with self.assertRaises(store_dump.DumpFailed) as caught:
                store_dump.dump_dataset("errors", "q", "s", "e", "pid", self.COLUMNS)
        self.assertEqual(caught.exception.check["sentry_count"], 2)
        self.assertEqual(caught.exception.check["sentry_count_after"], 3)

    def test_duplicate_id_at_page_boundary_is_deduped(self):
        def pages(_dataset, _query, fields, **_kwargs):
            first, second = self._page(fields)[0]
            return [[first, second], [dict(second)]]
        with (mock.patch.object(sentry, "pages", side_effect=pages),
              mock.patch.object(sentry, "count", side_effect=[2, 2]) as count):
            rows, check = store_dump.dump_dataset(
                "errors", "q", "s", "e", "pid", self.COLUMNS)
        self.assertEqual([row["id"] for row in rows], ["a", "b"])
        self.assertEqual(check["rows_stored"], 2)
        self.assertEqual(check["duplicates"], 1)
        self.assertTrue(check["pass"])
        self.assertTrue(all(
            call.kwargs["field"] == "count_unique(id)"
            for call in count.call_args_list
        ))

    def test_unique_count_still_detects_a_missing_event(self):
        with (mock.patch.object(
                sentry, "pages", side_effect=lambda _d, _q, f, **_k: self._page(f)),
              mock.patch.object(sentry, "count", side_effect=[3, 3, 3, 3])):
            with self.assertRaises(store_dump.DumpFailed) as caught:
                store_dump.dump_dataset("errors", "q", "s", "e", "pid", self.COLUMNS)
        self.assertEqual(caught.exception.check["sentry_count"], 3)
        self.assertEqual(caught.exception.check["rows_stored"], 2)

    def test_zero_rows_passes_only_with_successful_count(self):
        with (mock.patch.object(sentry, "pages", return_value=[]),
              mock.patch.object(sentry, "count", side_effect=sentry.SentryQueryError("bad count"))):
            with self.assertRaises(store_dump.DumpFailed) as caught:
                store_dump.dump_dataset("errors", "q", "s", "e", "pid", self.COLUMNS)
        self.assertIn("bad count", caught.exception.check["query_error"])

        with (mock.patch.object(sentry, "pages", return_value=[]),
              mock.patch.object(sentry, "count", side_effect=[0, 0])):
            rows, check = store_dump.dump_dataset("errors", "q", "s", "e", "pid", self.COLUMNS)
        self.assertEqual(rows, [])
        self.assertTrue(check["pass"])

    def test_per_page_is_the_dataset_cap(self):
        _rows, check, pages, _count = self._run()
        self.assertEqual(pages.call_args.kwargs["per_page"], sentry.PER_PAGE_MAX["errors"])
        self.assertNotIn("count_extrapolated", check)
        self.assertNotIn("sampled", check)

    def test_pid_is_explicit(self):
        _rows, _check, pages, count = self._run()
        self.assertEqual(pages.call_args.kwargs["pids"], ["pid"])
        self.assertTrue(all(call.kwargs["pids"] == ["pid"] for call in count.call_args_list))

    def test_spans_records_count_extrapolated_and_flags_sampled(self):
        rows, check, _pages, count = self._run(dataset="spans", count_side_effect=[2, 5, 2])
        self.assertEqual(len(rows), 2)
        self.assertEqual(check["count_fn"], "count_sample()")
        self.assertEqual(check["count_extrapolated"], 5)
        self.assertTrue(check["sampled"])
        self.assertEqual(count.call_args_list[1].kwargs["field"], "count()")

    def test_grouped_duplicate_tuple_fails(self):
        rows = [
            {"user.id": "u1", "user.username": "alice", "count()": 2},
            {"user.id": "u1", "user.username": "alice", "count()": 3},
        ]
        with mock.patch.object(sentry, "pages", return_value=[rows]):
            with self.assertRaises(store_dump.DumpFailed) as caught:
                store_dump.dump_grouped(
                    "errors", "has:user.username", ["user.id", "user.username", "count()"],
                    "s", "e", "pid")
        self.assertEqual(caught.exception.check["duplicates"], 1)

    def test_grouped_page_failure_retries_the_whole_query(self):
        rows = [[{"user.id": "u1", "count()": 1}]]
        with mock.patch.object(sentry, "pages", side_effect=[ValueError("not json"), rows]) as pages:
            got, check = store_dump.dump_grouped("errors", "q", ["user.id", "count()"], "s", "e", "pid")
        self.assertEqual(got, rows[0])
        self.assertTrue(check["pass"])
        self.assertEqual(pages.call_count, 2)

    def test_grouped_page_failure_twice_is_a_dump_failure(self):
        with mock.patch.object(sentry, "pages", side_effect=ValueError("not json")) as pages:
            with self.assertRaises(store_dump.DumpFailed) as caught:
                store_dump.dump_grouped("errors", "q", ["user.id", "count()"], "s", "e", "pid")
        self.assertIn("unusable", caught.exception.check["query_error"])
        self.assertEqual(pages.call_count, 2)


class GameDump(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = self.temp.name
        self.w0 = datetime.datetime(2026, 9, 1, tzinfo=datetime.timezone.utc)
        self.w1 = self.w0 + datetime.timedelta(hours=1)
        raw_patcher = mock.patch.object(sentry, "raw_get", side_effect=self._raw_answer)
        self.raw_get = raw_patcher.start()
        self.addCleanup(raw_patcher.stop)
        request_patcher = mock.patch.object(
            sentry, "_request", return_value=(200, b"[]", {}))
        self.request = request_patcher.start()
        self.addCleanup(request_patcher.stop)
        host_patcher = mock.patch.object(sentry, "host_reminder_events", return_value=[])
        host_patcher.start()
        self.addCleanup(host_patcher.stop)
        grouped_patcher = mock.patch.object(
            store_dump, "dump_grouped", side_effect=self._grouped_answer)
        self.grouped = grouped_patcher.start()
        self.addCleanup(grouped_patcher.stop)
        self.bulk_impl = store_dump._bulk_error_json_rows
        bulk_patcher = mock.patch.object(
            store_dump, "_bulk_error_json_rows", side_effect=self._bulk_answer)
        self.bulk = bulk_patcher.start()
        self.addCleanup(bulk_patcher.stop)

    @staticmethod
    def _raw_answer(path):
        if path.endswith("/attachments/"):
            return 200, b"[]"
        return 200, b'{"ok":true}'

    @staticmethod
    def _grouped_answer(dataset, query, fields, start, end, pid):
        return [], {"query": query, "start": start, "end": end,
                    "fields": list(fields), "rows_stored": 0,
                    "duplicates": 0, "pass": True}

    @staticmethod
    def _bulk_answer(error_rows, _windows, _game, _allow_missing):
        return ([{"id": row["id"], "project": row["__store_project"],
                  "dataset": "errors", "status": 200, "json": '{"ok":true}'}
                 for row in error_rows], [])

    def modules(self, fail=False, settled=True, interim_seen=None):
        def run_chain(_game, out, _ws, interim=False):
            if interim_seen is not None:
                interim_seen.append(interim)
            if fail:
                raise RuntimeError("chain failed")
            chain = {"kickoff": self.w0.isoformat()}
            if settled:
                chain["settlement"] = {"time": self.w1.isoformat()}
            with open(out, "w", encoding="utf-8") as fh:
                json.dump(chain, fh)
            return chain
        report = types.SimpleNamespace(run_chain=run_chain, chain_window=lambda _c, _p: (self.w0, self.w1))
        links = types.SimpleNamespace(usernames_under=lambda _root: {"5Fake": "sibling"})
        logs = types.SimpleNamespace(log_rows=lambda _game, start, _end, pids=None: [{
            "id": "late-log-%s-%s" % ((pids or ["default"])[0], start), "timestamp": start,
        }])
        return lambda name: {"game-report": report, "game-links": links, "sentry_logs": logs}[name]

    @staticmethod
    def checked(dataset, query, start, end, pid, columns):
        row = {"id": "%s-%s-%s" % (dataset, pid, start), "timestamp": start}
        check = {"query": query, "start": start, "end": end, "fields": [c[0] for c in columns],
                 "field_groups": 1, "count_fn": sentry.COUNT_FIELD[dataset], "sentry_count": 1,
                 "sentry_count_after": 1, "rows_stored": 1, "duplicates": 0,
                 "group_id_sets_equal": True, "pass": True}
        return [row], check

    def patches(self, **kwargs):
        return (mock.patch.object(store_dump, "_load_script", side_effect=kwargs.get("loader", self.modules())),
                mock.patch.object(store_dump, "discover", return_value=[("id", "string"), ("timestamp", "string")]),
                mock.patch.object(store_dump, "dump_dataset", side_effect=kwargs.get("dump", self.checked)),
                mock.patch.object(sentry, "count", return_value=kwargs.get("guard", 1)))

    def test_host_reminders_are_stored_and_a_failure_is_only_recorded(self):
        events = [{"title": "host.reminder.fired", "user": "phone-1"}]
        for name, side, expect in (("ok", dict(return_value=events), {"file": "host_reminders.json", "events": 1}),
                                   ("err", dict(side_effect=RuntimeError("boom")), {"error": "boom"})):
            with self.subTest(name), mock.patch.object(sentry, "host_reminder_events", **side):
                patches = self.patches()
                with patches[0], patches[1], patches[2], patches[3]:
                    folder = store_dump.dump_game(7, root=self.root, refresh=True)
                manifest = json.load(open(os.path.join(folder, "manifest.json")))
                self.assertEqual(manifest["host_reminders"], expect)
                path = os.path.join(folder, "host_reminders.json")
                self.assertEqual(os.path.exists(path), name == "ok")
                if name == "ok":
                    self.assertEqual(json.load(open(path)), events)

    def test_interim_reads_the_chain_as_interim_and_marks_the_store_early(self):
        seen = []
        p = self.patches(loader=self.modules(settled=False, interim_seen=seen))
        with p[0], p[1], p[2], p[3]:
            folder = store_dump.dump_game(7, root=self.root, interim=True)
        manifest = json.load(open(os.path.join(folder, "manifest.json")))
        self.assertEqual(seen, [True])
        self.assertTrue(manifest["early"])
        self.assertFalse(manifest["report_window_closed"])

    def test_interim_cannot_be_a_report_run(self):
        with mock.patch.object(store_dump, "_load_script") as load:
            with self.assertRaises(store_dump.store_write.DumpRefused):
                store_dump.dump_game(7, root=self.root, interim=True, report_on_window_close=True)
        load.assert_not_called()

    def test_existing_folder_refused_before_any_call(self):
        os.makedirs(os.path.join(self.root, "paseo", "g1"))
        with mock.patch.object(store_dump, "_load_script") as load:
            with self.assertRaises(store_dump.store_write.DumpRefused):
                store_dump.dump_game(1, root=self.root)
        load.assert_not_called()

    def test_recovery_finishes_before_existing_folder_refusal(self):
        base = os.path.join(self.root, "paseo")
        os.makedirs(os.path.join(base, ".old-g2-1"))
        with mock.patch.object(store_dump, "_load_script") as load:
            with self.assertRaises(store_dump.store_write.DumpRefused):
                store_dump.dump_game(2, root=self.root)
        self.assertTrue(os.path.isdir(os.path.join(base, "g2")))
        load.assert_not_called()

    def test_failure_writes_nothing(self):
        with self.patches(loader=self.modules(fail=True))[0]:
            with self.assertRaises(RuntimeError):
                store_dump.dump_game(1, root=self.root)
        base = os.path.join(self.root, "paseo")
        self.assertFalse(os.path.exists(os.path.join(base, "g1")))
        self.assertFalse(any(name.startswith(".tmp-g1-") for name in os.listdir(base)))

    def test_dataset_failure_writes_no_game_or_tmp(self):
        p = self.patches(dump=store_dump.DumpFailed({"pass": False, "query": "q"}))
        with p[0], p[1], p[2], p[3]:
            with self.assertRaises(store_dump.DumpFailed):
                store_dump.dump_game(1, root=self.root)
        base = os.path.join(self.root, "paseo")
        self.assertFalse(os.path.exists(os.path.join(base, "g1")))
        self.assertFalse(any(name.startswith(".tmp-g1-") for name in os.listdir(base)))

    def test_stale_tmp_is_removed_before_new_tmp_is_made(self):
        base = os.path.join(self.root, "paseo")
        os.makedirs(os.path.join(base, ".tmp-g1-123-1"))
        with self.patches(loader=self.modules(fail=True))[0]:
            with self.assertRaises(RuntimeError):
                store_dump.dump_game(1, root=self.root)
        self.assertFalse(any(name.startswith(".tmp-g1-") for name in os.listdir(base)))

    def test_keyboard_interrupt_cleans_tmp(self):
        loader = self.modules()
        loader("game-report").run_chain = mock.Mock(side_effect=KeyboardInterrupt())
        with mock.patch.object(store_dump, "_load_script", side_effect=loader):
            with self.assertRaises(KeyboardInterrupt):
                store_dump.dump_game(1, root=self.root)
        self.assertFalse(any(name.startswith(".tmp-g1-") for name in os.listdir(os.path.join(self.root, "paseo"))))

    def test_failed_cleanup_warns_with_the_tmp_folder(self):
        loader = self.modules()
        loader("game-report").run_chain = mock.Mock(side_effect=RuntimeError("chain failed"))
        with (mock.patch.object(store_dump, "_load_script", side_effect=loader),
              mock.patch.object(store_dump.shutil, "rmtree", side_effect=OSError("busy")),
              mock.patch("sys.stderr", new_callable=__import__("io").StringIO) as stderr):
            with self.assertRaises(RuntimeError):
                store_dump.dump_game(1, root=self.root)
        self.assertIn("could not clean", stderr.getvalue())
        self.assertIn(".tmp-g1-", stderr.getvalue())

    def test_network_guard_refuses_previewnet_number(self):
        p = self.patches(guard=0)
        with p[0], p[1], p[2], p[3]:
            with self.assertRaises(store_dump.NoPaseoTelemetry):
                store_dump.dump_game(1, root=self.root)

    def test_early_dump_refused_without_force(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        self.w0, self.w1 = now - datetime.timedelta(minutes=5), now
        p = self.patches()
        with p[0], p[1], p[2], p[3]:
            with self.assertRaises(store_dump.store_write.DumpRefused):
                store_dump.dump_game(1, root=self.root)

    def test_forced_immediate_dump_is_marked_early(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        self.w0, self.w1 = now - datetime.timedelta(minutes=5), now
        p = self.patches()
        with p[0], p[1], p[2], p[3]:
            out = store_dump.dump_game(1, root=self.root, force_early=True)
        manifest = store_dump._read_json(os.path.join(out, "manifest.json"))
        self.assertTrue(manifest["early"])

    def test_report_flow_refuses_without_a_real_settlement(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        self.w0, self.w1 = now - datetime.timedelta(minutes=5), now
        p = self.patches(loader=self.modules(settled=False))
        with p[0], p[1], p[2], p[3]:
            with self.assertRaisesRegex(store_dump.store_write.DumpRefused, "has not settled"):
                store_dump.dump_game(1, root=self.root, report_on_window_close=True)

    def test_report_flow_waits_through_window_margin_then_skips_ingest_guard(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        self.w0, self.w1 = now - datetime.timedelta(minutes=5), now + datetime.timedelta(minutes=1)
        p = self.patches()
        with (p[0], p[1], p[2], p[3],
              mock.patch.object(store_dump.time, "sleep") as sleep):
            out = store_dump.dump_game(1, root=self.root, report_on_window_close=True)
        self.assertGreaterEqual(sleep.call_args.args[0], 89)
        manifest = store_dump._read_json(os.path.join(out, "manifest.json"))
        self.assertFalse(manifest["early"])
        self.assertTrue(manifest["report_window_closed"])

    def test_late_parts_only_for_errors_and_logs_and_filtered_by_game(self):
        calls = []
        def dumped(*args):
            calls.append(args)
            return self.checked(*args)
        p = self.patches(dump=dumped)
        with p[0], p[1], p[2], p[3]:
            store_dump.dump_game(1, root=self.root)
        late = [(d, q, s) for d, q, s, _e, _pid, _c in calls
                if q and s.endswith("01:00:00Z")]
        # The merged Logs reader owns the late Logs query; dump_dataset still owns errors.
        self.assertEqual([d for d, _q, _s in late], ["errors"])
        self.assertTrue(all(q == "game.index:1" for _d, q, _s in late))
        self.assertTrue(all(s.endswith("01:00:00Z") for _d, _q, s in late))

    def test_logs_window_is_unfiltered_and_pre_window_is_padded_and_game_scoped(self):
        calls = []
        def dumped(*args):
            calls.append(args)
            return self.checked(*args)
        p = self.patches(dump=dumped)
        with p[0], p[1], p[2], p[3]:
            store_dump.dump_game(1, root=self.root)
        logs = [call for call in calls if call[0] == "logs"]
        window = next(call for call in logs if call[1] == "" and
                      call[2] == "2026-09-01T00:00:00Z" and call[3] == "2026-09-01T01:00:00Z")
        pre_window = next(call for call in logs if call[1] == "game.index:1" and
                          call[3] == "2026-09-01T00:00:00Z")
        self.assertEqual(pre_window[2], "2026-08-31T12:00:00Z")

        manifest = store_dump._read_json(os.path.join(self.root, "paseo", "g1", "manifest.json"))
        part = manifest["datasets"]["logs"]["per_project"][
            sentry.PROJECTS["jollity-next"]]["pre_window"]
        self.assertEqual((part["start"], part["end"]),
                         ("2026-08-31T12:00:00Z", "2026-09-01T00:00:00Z"))

    def test_late_logs_use_sentry_logs_when_present(self):
        log_rows = mock.Mock(return_value=[{"id": "late-log", "timestamp": self.w1.isoformat()}])
        modules = {"game_report": self.modules()("game-report"),
                   "game_links": self.modules()("game-links"),
                   "sentry_logs": types.SimpleNamespace(log_rows=log_rows)}
        old = {name: sys.modules.get(name) for name in modules}
        sys.modules.update(modules)
        self.addCleanup(lambda: [sys.modules.pop(name, None) if value is None else sys.modules.__setitem__(name, value)
                                 for name, value in old.items()])
        with (mock.patch.object(store_dump, "discover", return_value=[("id", "string"), ("timestamp", "string")]),
              mock.patch.object(store_dump, "dump_dataset", side_effect=self.checked),
              mock.patch.object(sentry, "count", side_effect=[1, 1, 1]) as count):
            out = store_dump.dump_game(1, root=self.root)
        log_rows.assert_called_once_with(1, "2026-09-01T01:00:00Z", "2026-09-08T01:00:00Z",
                                         pids=[sentry.PROJECTS["jollity-next"]])
        manifest = store_dump._read_json(os.path.join(out, "manifest.json"))
        self.assertEqual(manifest["late_logs_source"], "sentry_logs")
        late = manifest["datasets"]["logs"]["per_project"][sentry.PROJECTS["jollity-next"]]["late"]
        self.assertEqual((late["sentry_count"], late["sentry_count_after"], late["rows_stored"]), (1, 1, 1))
        self.assertTrue(late["pass"])
        self.assertEqual(count.call_count, 3)

    def test_late_logs_completeness_uses_exact_packed_log_query_and_window(self):
        module = types.SimpleNamespace(
            log_request=lambda game, start: (
                "game.index:%d has:game_log.item" % game, "2026-08-31T13:00:00"),
            log_rows=mock.Mock(return_value=[]),
        )

        def counted(_dataset, query, start, _end, pids=None):
            self.assertEqual(pids, ["pid"])
            if query == "game.index:1":
                return 1  # A non-packed log must not enter this completeness check.
            self.assertEqual(query, "game.index:1 has:game_log.item")
            self.assertEqual(start, "2026-08-31T13:00:00")
            return 0

        with mock.patch.object(sentry, "count", side_effect=counted):
            rows, check = store_dump._dump_late_logs(
                module, 1, "game.index:1", "2026-09-01T01:00:00Z",
                "2026-09-08T01:00:00Z", "pid", [("id", "string")])

        self.assertEqual(rows, [])
        self.assertTrue(check["pass"])
        self.assertEqual(check["query"], "game.index:1 has:game_log.item")
        self.assertEqual(check["start"], "2026-08-31T13:00:00")

    def test_late_logs_generic_when_absent(self):
        p = self.patches()
        loaded = sys.modules.pop("sentry_logs", None)
        try:
            with p[0], p[1], p[2], p[3], mock.patch.object(store_dump.os.path, "exists", return_value=False):
                out = store_dump.dump_game(1, root=self.root)
        finally:
            if loaded is not None:
                sys.modules["sentry_logs"] = loaded
        manifest = store_dump._read_json(os.path.join(out, "manifest.json"))
        self.assertEqual(manifest["late_logs_source"], "generic")

    def test_late_boundary_row_is_written_once_and_recorded(self):
        def overlapping(dataset, query, start, end, pid, columns):
            event_id = "%s-boundary" % dataset
            row = {"id": event_id, "timestamp": self.w1.isoformat()}
            check = {"query": query, "start": start, "end": end,
                     "fields": [c[0] for c in columns], "field_groups": 1,
                     "count_fn": sentry.COUNT_FIELD[dataset], "sentry_count": 1,
                     "sentry_count_after": 1, "rows_stored": 1, "duplicates": 0,
                     "group_id_sets_equal": True, "pass": True}
            return [row], check
        loader = self.modules()
        loader("sentry_logs").log_rows = lambda _game, _start, _end, pids=None: [
            {"id": "logs-boundary", "timestamp": self.w1.isoformat()}]
        p = self.patches(dump=overlapping, loader=loader)
        with p[0], p[1], p[2], p[3]:
            out = store_dump.dump_game(1, root=self.root)
        import pyarrow.parquet as pq
        for dataset in ("errors", "logs"):
            rows = pq.read_table(os.path.join(out, dataset + ".parquet")).to_pylist()
            self.assertEqual([row["id"] for row in rows], [dataset + "-boundary"])
        manifest = store_dump._read_json(os.path.join(out, "manifest.json"))
        for dataset in ("errors", "logs"):
            late = manifest["datasets"][dataset]["per_project"][sentry.PROJECTS["jollity-next"]]["late"]
            self.assertEqual(late["overlap_rows_dropped"], 1)

    def test_sentry_logs_retries_non_sentry_exception(self):
        module = types.SimpleNamespace(log_rows=mock.Mock(side_effect=[RuntimeError("bad json"),
            [{"id": "log-1", "timestamp": self.w1.isoformat()}]]))
        with mock.patch.object(sentry, "count", side_effect=[1, 1, 1]):
            rows, check = store_dump._dump_late_logs(
                module, 1, "game.index:1", "s", "e", "pid", [("id", "string")])
        self.assertEqual([row["id"] for row in rows], ["log-1"])
        self.assertTrue(check["pass"])
        self.assertEqual(module.log_rows.call_count, 2)

    def test_sentry_logs_missing_id_fails_after_retry(self):
        module = types.SimpleNamespace(log_rows=mock.Mock(return_value=[{"timestamp": "t"}]))
        with mock.patch.object(sentry, "count", side_effect=[1, 1, 1, 1]):
            with self.assertRaises(store_dump.DumpFailed) as caught:
                store_dump._dump_late_logs(
                    module, 1, "game.index:1", "s", "e", "pid", [("id", "string")])
        self.assertEqual(caught.exception.check["missing_ids"], 1)
        self.assertEqual(module.log_rows.call_count, 2)

    def test_with_test_project_dumps_each_pid_separately_and_tags_rows(self):
        p = self.patches()
        with p[0], p[1], p[2], p[3]:
            out = store_dump.dump_game(1, root=self.root, with_test=True)
        import pyarrow.parquet as pq
        rows = pq.read_table(os.path.join(out, "spans.parquet")).to_pylist()
        self.assertEqual({r["_project"] for r in rows}, {"jollity-next", "dim2-testing"})

    def test_report_ready_store_defers_transaction_json_then_resumes_it(self):
        def rows(dataset, query, start, end, pid, columns):
            ids = {
                ("errors", ""): ["error-window"],
                ("errors", "game.index:1"): ["error-late"],
                ("transactions", ""): ["transaction-window"],
            }.get((dataset, query), [])
            answer = [{"id": event_id, "timestamp": start, "title": "other"}
                      for event_id in ids]
            check = {"query": query, "start": start, "end": end,
                     "fields": [c[0] for c in columns], "field_groups": 1,
                     "count_fn": sentry.COUNT_FIELD[dataset], "sentry_count": len(answer),
                     "sentry_count_after": len(answer), "rows_stored": len(answer),
                     "duplicates": 0, "group_id_sets_equal": True, "pass": True}
            return answer, check

        p = self.patches(dump=rows)
        with p[0], p[1], p[2], p[3]:
            out = store_dump.dump_game(1, root=self.root)
        import pyarrow.parquet as pq
        stored = pq.read_table(os.path.join(out, "events_json.parquet")).to_pylist()
        self.assertEqual([row["id"] for row in stored], ["error-window", "error-late"])
        manifest = store_dump._read_json(os.path.join(out, "manifest.json"))
        self.assertTrue(manifest["report_ready"])
        self.assertFalse(manifest["raw_complete"])

        store_dump.complete_raw_details(1, root=self.root)
        stored = pq.read_table(os.path.join(out, "events_json.parquet")).to_pylist()
        self.assertEqual([row["id"] for row in stored],
                         ["error-window", "error-late", "transaction-window"])
        manifest = store_dump._read_json(os.path.join(out, "manifest.json"))
        self.assertTrue(manifest["raw_complete"])
        self.assertEqual(manifest["datasets"]["events_json"]["pending_transactions"], 0)
        self.assertEqual(manifest["bytes"], store_dump._file_bytes(out))
        self.assertTrue(all(isinstance(row["json"], str) for row in stored))

    def test_report_ready_fetches_only_transaction_details_used_by_report(self):
        def rows(dataset, query, start, end, pid, columns):
            answer = []
            if dataset == "transactions":
                answer = [
                    {"id": "host-old", "timestamp": start, "user.id": "alice",
                     "host.kind": "ios", "transaction": "journey.game"},
                    {"id": "host-new", "timestamp": end, "user.id": "alice",
                     "host.kind": "ios", "transaction": "journey.game"},
                    {"id": "payoff", "timestamp": end, "user.id": "alice",
                     "transaction": "journey.payoff"},
                    {"id": "deferred", "timestamp": end, "user.id": "alice",
                     "transaction": "journey.other"},
                ]
            check = {"query": query, "start": start, "end": end,
                     "fields": [c[0] for c in columns], "field_groups": 1,
                     "count_fn": sentry.COUNT_FIELD[dataset], "sentry_count": len(answer),
                     "sentry_count_after": len(answer), "rows_stored": len(answer),
                     "duplicates": 0, "group_id_sets_equal": True, "pass": True}
            return answer, check

        def detail(path):
            event_id = path.rstrip("/").split("/")[-1]
            return 200, json.dumps({"id": event_id, "contexts": {
                "device_profile": {"model": "phone"},
                "trace": {"data": {"payoff.kind": "shown"}},
            }}).encode()

        self.raw_get.side_effect = detail
        p = self.patches(dump=rows)
        with p[0], p[1], p[2], p[3]:
            out = store_dump.dump_game(1, root=self.root)
        import pyarrow.parquet as pq
        before = pq.read_table(os.path.join(out, "events_json.parquet")).to_pylist()
        before_by_id = {row["id"]: row["json"] for row in before}
        self.assertEqual(set(before_by_id), {"host-new", "payoff"})
        self.assertTrue(store_dump._read_json(os.path.join(out, "manifest.json"))["report_ready"])

        store_dump.complete_raw_details(1, root=self.root)
        after = pq.read_table(os.path.join(out, "events_json.parquet")).to_pylist()
        after_by_id = {row["id"]: row["json"] for row in after}
        self.assertEqual(after_by_id["host-new"], before_by_id["host-new"])
        self.assertEqual(after_by_id["payoff"], before_by_id["payoff"])
        self.assertEqual(set(after_by_id), {"host-old", "host-new", "payoff", "deferred"})

    def test_raw_completion_checkpoints_and_resumes_after_a_later_failure(self):
        def rows(dataset, query, start, end, pid, columns):
            answer = ([{"id": "tx-%03d" % index, "timestamp": start}
                       for index in range(251)] if dataset == "transactions" else [])
            check = {"query": query, "start": start, "end": end,
                     "fields": [c[0] for c in columns], "field_groups": 1,
                     "count_fn": sentry.COUNT_FIELD[dataset], "sentry_count": len(answer),
                     "sentry_count_after": len(answer), "rows_stored": len(answer),
                     "duplicates": 0, "group_id_sets_equal": True, "pass": True}
            return answer, check

        p = self.patches(dump=rows)
        with p[0], p[1], p[2], p[3]:
            out = store_dump.dump_game(1, root=self.root)

        self.raw_get.side_effect = lambda path: (
            (403, b"") if "tx-250" in path else (200, b'{"ok":true}'))
        with self.assertRaises(store_dump.DumpFailed):
            store_dump.complete_raw_details(1, root=self.root)

        import pyarrow.parquet as pq
        stored = pq.read_table(os.path.join(out, "events_json.parquet")).to_pylist()
        manifest = store_dump._read_json(os.path.join(out, "manifest.json"))
        self.assertEqual(len(stored), 250)
        self.assertEqual(manifest["datasets"]["events_json"]["pending_transactions"], 1)
        self.assertFalse(manifest["raw_complete"])

        self.raw_get.side_effect = lambda _path: (200, b'{"ok":true}')
        store_dump.complete_raw_details(1, root=self.root)
        stored = pq.read_table(os.path.join(out, "events_json.parquet")).to_pylist()
        manifest = store_dump._read_json(os.path.join(out, "manifest.json"))
        self.assertEqual(len(stored), 251)
        self.assertTrue(manifest["raw_complete"])

    def test_missing_deferred_event_fails_unless_allowed(self):
        self.raw_get.side_effect = lambda path: (404, b"") if not path.endswith("/attachments/") else (200, b"[]")
        with mock.patch.object(store_dump.time, "sleep") as sleep:
            p = self.patches()
            with p[0], p[1], p[2], p[3]:
                store_dump.dump_game(1, root=self.root)
            with self.assertRaises(store_dump.DumpFailed):
                store_dump.complete_raw_details(1, root=self.root)
        self.assertGreaterEqual(sleep.call_count, 1)

        self.raw_get.reset_mock()
        with mock.patch.object(store_dump.time, "sleep"):
            p = self.patches()
            with p[0], p[1], p[2], p[3]:
                with self.assertRaisesRegex(
                        store_dump.store_write.DumpRefused, "raw details remain incomplete"):
                    store_dump.complete_raw_details(
                        1, root=self.root, allow_missing_events=True)
        out = os.path.join(self.root, "paseo", "g1")
        manifest = store_dump._read_json(os.path.join(out, "manifest.json"))
        self.assertTrue(manifest["datasets"]["events_json"]["missing"])
        import pyarrow.parquet as pq
        rows = pq.read_table(os.path.join(out, "events_json.parquet")).to_pylist()
        self.assertTrue(any(row["status"] == 404 and row["json"] is None for row in rows))

    def test_allowed_missing_game_log_skips_attachment_listing(self):
        def game_log(dataset, query, start, end, pid, columns):
            rows, check = self.checked(dataset, query, start, end, pid, columns)
            if dataset == "errors" and not query:
                rows[0]["title"] = "game-log"
            return rows, check

        self.bulk.side_effect = lambda error_rows, _windows, _game, _allow: (
            [{"id": row["id"], "project": row["__store_project"], "dataset": "errors",
              "status": 404, "json": None} for row in error_rows],
            [row["id"] for row in error_rows])
        with mock.patch.object(store_dump.time, "sleep"):
            p = self.patches(dump=game_log)
            with p[0], p[1], p[2], p[3]:
                out = store_dump.dump_game(
                    1, root=self.root, allow_missing_events=True)
        self.request.assert_not_called()
        manifest = store_dump._read_json(os.path.join(out, "manifest.json"))
        self.assertEqual(manifest["datasets"]["attachments"]["events"], 0)

    def test_raw_completion_retries_missing_error_details(self):
        self.bulk.side_effect = lambda error_rows, _windows, _game, _allow: (
            [{"id": row["id"], "project": row["__store_project"], "dataset": "errors",
              "status": 404, "json": None} for row in error_rows],
            [row["id"] for row in error_rows],
        )
        p = self.patches()
        with p[0], p[1], p[2], p[3]:
            out = store_dump.dump_game(1, root=self.root, allow_missing_events=True)
        self.raw_get.side_effect = lambda _path: (200, b'{"recovered":true}')
        store_dump.complete_raw_details(1, root=self.root)

        import pyarrow.parquet as pq
        rows = pq.read_table(os.path.join(out, "events_json.parquet")).to_pylist()
        errors = [row for row in rows if row["dataset"] == "errors"]
        self.assertTrue(errors)
        self.assertTrue(all(row["status"] == 200 for row in errors))
        manifest = store_dump._read_json(os.path.join(out, "manifest.json"))
        self.assertTrue(manifest["datasets"]["events_json"]["errors_complete"])
        self.assertTrue(manifest["raw_complete"])

    def test_non_utf8_deferred_event_json_is_a_named_dump_failure(self):
        self.raw_get.side_effect = lambda _path: (200, b"\xff")
        with self.assertRaises(store_dump.DumpFailed) as caught:
            store_dump._detail_json_rows(
                [{"id": "bad-event", "__store_project": "jollity-next"}],
                "transactions", False)
        self.assertEqual(caught.exception.check["id"], "bad-event")
        self.assertIn("UTF-8", caught.exception.check["reason"])

    def test_event_details_run_concurrently_but_keep_source_order(self):
        active = 0
        most_active = 0
        lock = threading.Lock()
        sources = [
            {"id": "event-%d" % index, "__store_project": "jollity-next"}
            for index in range(8)
        ]

        def answer(path):
            nonlocal active, most_active
            index = int(re.search(r"event-(\d+)", path).group(1))
            with lock:
                active += 1
                most_active = max(most_active, active)
            time.sleep((8 - index) * 0.002)
            with lock:
                active -= 1
            return 200, ('{"index":%d}' % index).encode()

        self.raw_get.side_effect = answer
        rows, missing = store_dump._event_json_rows(
            {"errors": sources, "transactions": []}, False)
        self.assertGreater(most_active, 1)
        self.assertEqual([row["id"] for row in rows], [source["id"] for source in sources])
        self.assertEqual(missing, [])

    def test_parallel_detail_failure_is_strict_and_names_the_event(self):
        def answer(path):
            if "event-bad" in path:
                return 403, b""
            time.sleep(0.01)
            return 200, b"{}"

        self.raw_get.side_effect = answer
        captured = {"errors": [
            {"id": "event-ok", "__store_project": "jollity-next"},
            {"id": "event-bad", "__store_project": "jollity-next"},
            {"id": "event-later", "__store_project": "jollity-next"},
        ], "transactions": []}
        with self.assertRaises(store_dump.DumpFailed) as caught:
            store_dump._event_json_rows(captured, False)
        self.assertEqual(caught.exception.check["id"], "event-bad")
        self.assertEqual(caught.exception.check["status"], 403)

    def test_bulk_error_details_follow_pages_and_keep_captured_order(self):
        errors = [
            {"id": "window-2", "__store_project": "jollity-next", "__store_part": "window"},
            {"id": "window-1", "__store_project": "jollity-next", "__store_part": "window"},
            {"id": "late-1", "__store_project": "jollity-next", "__store_part": "late"},
        ]
        pages = mock.Mock(side_effect=[
            [[{"eventID": "window-1", "entries": [1]}],
             [{"eventID": "window-2", "entries": [2]}]],
            [[{"eventID": "late-1", "entries": [3]}]],
        ])
        with mock.patch.object(sentry, "project_event_pages", side_effect=pages):
            rows, missing = self.bulk_impl(
                errors, {"window": (self.w0, self.w1),
                         "late": (self.w1, self.w1 + datetime.timedelta(days=7))},
                1, False)
        self.assertEqual([row["id"] for row in rows], ["window-2", "window-1", "late-1"])
        self.assertEqual(missing, [])
        self.assertIn('"entries":[2]', rows[0]["json"])
        self.assertEqual(pages.call_args_list[1].args[3], "game.index:1")

    def test_bulk_error_details_fall_back_for_ids_absent_from_pages(self):
        errors = [
            {"id": "in-page", "__store_project": "jollity-next", "__store_part": "window"},
            {"id": "fallback", "__store_project": "jollity-next", "__store_part": "window"},
        ]
        with mock.patch.object(sentry, "project_event_pages", return_value=[[
                {"eventID": "in-page", "entries": [1]}]]):
            rows, missing = self.bulk_impl(
                errors, {"window": (self.w0, self.w1)}, 1, False)
        self.assertEqual([row["id"] for row in rows], ["in-page", "fallback"])
        self.assertEqual(missing, [])
        self.assertEqual(json.loads(rows[1]["json"]), {"ok": True})

    def test_attachment_listing_follows_every_page(self):
        self.request.side_effect = [
            (200, b'[{"id":"a1","name":"one.bin","size":1}]', {
                "Link": '<https://de.sentry.io/api/0/next>; rel="next"; results="true"',
            }),
            (200, b'[{"id":"a2","name":"two.bin","size":1}]', {}),
        ]
        self.raw_get.side_effect = lambda _path: (200, b"x")
        rows, events, files, byte_count = store_dump._attachment_rows([
            {"id": "event-1", "title": "game-log", "__store_project": "jollity-next"},
        ])
        self.assertEqual([row["attachment_id"] for row in rows], ["a1", "a2"])
        self.assertEqual((events, files, byte_count), (1, 2, 2))
        self.assertEqual(self.request.call_count, 2)

    def test_context_refresh_may_legitimately_store_fewer_rows(self):
        phase = {"rows": 1}

        def grouped(dataset, query, fields, start, end, pid):
            if not phase["rows"]:
                rows = []
            elif dataset == "tracemetrics":
                rows = [{"release": "r1", "count(value)": 1}]
            else:
                rows = [{"user.id": "u1", "user.username": "alice", "count()": 1}]
            return rows, {"query": query, "start": start, "end": end,
                          "fields": list(fields), "rows_stored": len(rows),
                          "duplicates": 0, "pass": True}

        self.grouped.side_effect = grouped
        p = self.patches()
        with p[0], p[1], p[2], p[3]:
            store_dump.dump_game(1, root=self.root)
        phase["rows"] = 0
        p = self.patches()
        with p[0], p[1], p[2], p[3]:
            out = store_dump.dump_game(1, root=self.root, refresh=True)
        manifest = store_dump._read_json(os.path.join(out, "manifest.json"))
        for name in ("context_usernames", "context_releases"):
            self.assertEqual(manifest["datasets"][name]["rows"], 0)
            self.assertNotIn("rows_stored", manifest["datasets"][name])

    def test_attachment_size_mismatch_fails(self):
        def game_log(dataset, query, start, end, pid, columns):
            rows, check = self.checked(dataset, query, start, end, pid, columns)
            if dataset == "errors" and not query:
                rows[0]["title"] = "game-log"
            return rows, check
        def answer(path):
            if "/attachments/a1/" in path:
                return 200, b"abc"
            return 200, b'{"ok":true}'
        self.request.return_value = (
            200, b'[{"id":"a1","name":"log.json","size":4}]', {})
        self.raw_get.side_effect = answer
        p = self.patches(dump=game_log)
        with p[0], p[1], p[2], p[3]:
            with self.assertRaises(store_dump.DumpFailed) as caught:
                store_dump.dump_game(1, root=self.root)
        self.assertIn("size", caught.exception.check["reason"])

    def test_event_without_attachments_gets_a_null_row(self):
        def game_log(dataset, query, start, end, pid, columns):
            rows, check = self.checked(dataset, query, start, end, pid, columns)
            if dataset == "errors" and not query:
                rows[0]["title"] = "game-log-chunk"
            return rows, check
        p = self.patches(dump=game_log)
        with p[0], p[1], p[2], p[3]:
            out = store_dump.dump_game(1, root=self.root)
        import pyarrow.parquet as pq
        rows = pq.read_table(os.path.join(out, "attachments.parquet")).to_pylist()
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["attachment_id"])
        self.assertEqual(rows[0]["list_json"], "[]")

    def test_attachment_body_remains_binary(self):
        def game_log(dataset, query, start, end, pid, columns):
            rows, check = self.checked(dataset, query, start, end, pid, columns)
            if dataset == "errors" and not query:
                rows[0]["title"] = "game-log"
            return rows, check
        body = b"\xff\x00\xfe"
        def answer(path):
            if "/attachments/a1/" in path:
                return 200, body
            return 200, b'{"ok":true}'
        self.request.return_value = (
            200, b'[{"id":"a1","name":"log.bin","size":3}]', {})
        self.raw_get.side_effect = answer
        p = self.patches(dump=game_log)
        with p[0], p[1], p[2], p[3]:
            out = store_dump.dump_game(1, root=self.root)
        import pyarrow.parquet as pq
        table = pq.read_table(os.path.join(out, "attachments.parquet"))
        self.assertEqual(table.schema.field("body").type, pyarrow.binary())
        self.assertEqual(table.to_pylist()[0]["body"], body)

    def test_context_windows_match_the_report_format(self):
        p = self.patches()
        with p[0], p[1], p[2], p[3]:
            out = store_dump.dump_game(1, root=self.root)
        self.assertEqual(self.grouped.call_count, 3)
        for call in self.grouped.call_args_list:
            self.assertEqual(call.args[3], "2026-08-02T01:00:00")
            self.assertEqual(call.args[4], "2026-09-01T01:00:00")
        manifest = store_dump._read_json(os.path.join(out, "manifest.json"))
        self.assertEqual(manifest["datasets"]["context_usernames"]["start"],
                         "2026-08-02T01:00:00")
        self.assertEqual(manifest["datasets"]["context_releases"]["end"],
                         "2026-09-01T01:00:00")
        import pyarrow.parquet as pq
        for name in ("context_usernames", "context_releases"):
            self.assertIn("_project", pq.read_schema(os.path.join(out, name + ".parquet")).names)

    def test_context_duplicate_group_fails(self):
        self.grouped.side_effect = store_dump.DumpFailed({"duplicates": 1, "pass": False})
        p = self.patches()
        with p[0], p[1], p[2], p[3]:
            with self.assertRaises(store_dump.DumpFailed):
                store_dump.dump_game(1, root=self.root)
        self.assertFalse(os.path.exists(os.path.join(self.root, "paseo", "g1")))

    def test_manifest_has_every_section_M_key_of_this_task(self):
        p = self.patches()
        with p[0], p[1], p[2], p[3]:
            out = store_dump.dump_game(1, root=self.root)
        manifest = store_dump._read_json(os.path.join(out, "manifest.json"))
        for key in ("store_schema", "tool", "tool_version", "scripts_sha", "scripts_dirty", "network",
                    "game", "pulled_at_utc", "pulled_at_local", "data_as_of_utc", "data_as_of_local",
                    "window", "late_complete", "late_logs_source", "early", "projects", "datasets", "inputs",
                    "chain", "api_calls", "performance", "minutes", "bytes", "pass"):
            self.assertIn(key, manifest)
        self.assertEqual(set(manifest["performance"]["phase_seconds"]), {
            "chain", "spans", "errors", "transactions", "tracemetrics", "logs",
            "events_json", "attachments", "context",
        })
        self.assertIn("attempts", manifest["performance"]["requests"])
        self.assertEqual(set(manifest["datasets"]), {
            "spans", "errors", "transactions", "tracemetrics", "logs",
            "events_json", "attachments", "context_usernames", "context_releases",
        })
        self.assertFalse(manifest["early"])
        self.assertEqual(manifest["bytes"], store_dump._file_bytes(out))

    def test_shared_usernames_file_is_never_written(self):
        path = os.path.join(self.root, "usernames.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"account": "player-name-66"}, handle)
        before = os.stat(path).st_mtime_ns
        p = self.patches()
        with p[0], p[1], p[2], p[3], mock.patch.object(store_dump.store_paths, "usernames_path", return_value=path):
            store_dump.dump_game(1, root=self.root)
        self.assertEqual(os.stat(path).st_mtime_ns, before)

    def test_git_metadata_is_read_from_this_worktree(self):
        answer = types.SimpleNamespace(stdout="head\n")
        with mock.patch.object(store_dump.subprocess, "run", return_value=answer) as run:
            self.assertEqual(store_dump._git("rev-parse", "HEAD"), "head")
        self.assertEqual(
            run.call_args.kwargs["cwd"],
            os.path.abspath(os.path.join(os.path.dirname(store_dump.__file__), "../../../..")),
        )


class ReportFlow(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = self.temp.name
        self.directory = store_dump.store_paths.game_dir(7, root=self.root)

    def write_manifest(self, **values):
        os.makedirs(self.directory, exist_ok=True)
        manifest = {"pass": True, "report_ready": True, "raw_complete": False, **values}
        store_dump.store_paths.write_json(
            os.path.join(self.directory, "manifest.json"), manifest)
        store_dump.store_paths.write_json(
            os.path.join(self.directory, "chain.json"),
            {"settlement": {"time": "2026-10-23T12:00:00Z"}},
        )

    def test_report_runs_at_readiness_before_raw_completion(self):
        calls = []

        def dumped(*_args, **kwargs):
            calls.append(("dump", kwargs))
            self.write_manifest()
            return self.directory

        def reported(command, **kwargs):
            manifest = store_dump._read_json(os.path.join(self.directory, "manifest.json"))
            self.assertTrue(manifest["report_ready"])
            self.assertFalse(manifest["raw_complete"])
            calls.append(("report", command, kwargs))
            return types.SimpleNamespace(returncode=0)

        def completed(*_args, **_kwargs):
            calls.append(("complete",))
            self.write_manifest(raw_complete=True)
            return self.directory

        with (mock.patch.object(store_dump, "dump_game", side_effect=dumped),
              mock.patch.object(store_dump.subprocess, "run", side_effect=reported),
              mock.patch.object(store_dump, "complete_raw_details", side_effect=completed)):
            self.assertEqual(store_dump.run_report_flow(7, root=self.root), 0)

        self.assertEqual([call[0] for call in calls], ["dump", "report", "complete"])
        self.assertNotIn("force_early", calls[0][1])
        self.assertTrue(calls[0][1]["report_on_window_close"])
        self.assertIn("--from-store", calls[1][1])
        self.assertEqual(calls[1][1][-2:], ["--store-root", os.path.abspath(self.root)])

    def test_resume_skips_dump_when_store_is_already_report_ready(self):
        self.write_manifest()
        with (mock.patch.object(store_dump, "dump_game") as dump,
              mock.patch.object(store_dump.subprocess, "run",
                                return_value=types.SimpleNamespace(returncode=0)),
              mock.patch.object(store_dump, "complete_raw_details",
                                return_value=self.directory) as complete):
            self.assertEqual(store_dump.run_report_flow(7, root=self.root), 0)
        dump.assert_not_called()
        complete.assert_called_once_with(7, root=os.path.abspath(self.root),
                                         allow_missing_events=False)

    def test_raw_completion_still_runs_when_report_generation_fails(self):
        self.write_manifest()
        with (mock.patch.object(store_dump.subprocess, "run",
                                return_value=types.SimpleNamespace(returncode=9)),
              mock.patch.object(store_dump, "complete_raw_details",
                                return_value=self.directory) as complete):
            self.assertEqual(store_dump.run_report_flow(7, root=self.root), 9)
        complete.assert_called_once()

    def test_report_and_raw_completion_failures_are_both_reported(self):
        self.write_manifest()
        with (mock.patch.object(store_dump.subprocess, "run",
                                return_value=types.SimpleNamespace(returncode=9)),
              mock.patch.object(store_dump, "complete_raw_details",
                                side_effect=store_dump.store_write.DumpRefused("raw pending")),
              mock.patch("sys.stderr", new_callable=__import__("io").StringIO) as stderr):
            self.assertEqual(store_dump.run_report_flow(7, root=self.root), 9)
        self.assertIn("report failed with exit 9", stderr.getvalue())
        self.assertIn("raw completion also failed: raw pending", stderr.getvalue())

    def test_raw_completion_failure_surfaces_when_report_succeeds(self):
        self.write_manifest()
        with (mock.patch.object(store_dump.subprocess, "run",
                                return_value=types.SimpleNamespace(returncode=0)),
              mock.patch.object(store_dump, "complete_raw_details",
                                side_effect=store_dump.store_write.DumpRefused("raw pending"))):
            with self.assertRaisesRegex(store_dump.store_write.DumpRefused, "raw pending"):
                store_dump.run_report_flow(7, root=self.root)

    def test_flow_refuses_a_non_passing_existing_store(self):
        self.write_manifest(**{"pass": False})
        with self.assertRaisesRegex(store_dump.store_write.DumpRefused, "not report-ready"):
            store_dump.run_report_flow(7, root=self.root)

    def test_flow_refuses_an_early_existing_store_with_refresh_hint(self):
        self.write_manifest(early=True)
        with self.assertRaisesRegex(store_dump.store_write.DumpRefused,
                                    "early; rerun --report --refresh"):
            store_dump.run_report_flow(7, root=self.root)

    def test_flow_refuses_a_fallback_window_existing_store(self):
        self.write_manifest()
        store_dump.store_paths.write_json(
            os.path.join(self.directory, "chain.json"), {"kickoff": "2026-10-23T12:00:00Z"})
        with self.assertRaisesRegex(store_dump.store_write.DumpRefused,
                                    "fallback window; rerun --report --refresh"):
            store_dump.run_report_flow(7, root=self.root)

    def test_flow_explains_how_to_refresh_a_legacy_store(self):
        self.write_manifest()
        manifest_path = os.path.join(self.directory, "manifest.json")
        manifest = store_dump._read_json(manifest_path)
        manifest.pop("report_ready")
        store_dump.store_paths.write_json(manifest_path, manifest)
        with self.assertRaisesRegex(store_dump.store_write.DumpRefused,
                                    "not report-ready; rerun --report --refresh"):
            store_dump.run_report_flow(7, root=self.root)

    def test_flow_recovers_before_deciding_whether_to_dump(self):
        def recovered(_game, _network, _root):
            self.write_manifest()
            return ["recovered g7"]

        with (mock.patch.object(store_dump.store_paths, "recover", side_effect=recovered) as recover,
              mock.patch.object(store_dump, "dump_game") as dump,
              mock.patch.object(store_dump.subprocess, "run",
                                return_value=types.SimpleNamespace(returncode=0)),
              mock.patch.object(store_dump, "complete_raw_details", return_value=self.directory)):
            self.assertEqual(store_dump.run_report_flow(7, root=self.root), 0)
        recover.assert_called_once()
        dump.assert_not_called()

    def test_report_cli_routes_all_store_options_to_the_flow(self):
        with mock.patch.object(store_dump, "run_report_flow", return_value=0) as run:
            self.assertEqual(store_dump.main([
                "7", "--report", "--root", self.root, "--refresh",
                "--allow-shrink", "--allow-missing-events",
                "--with-test-project", "--ws", "wss://example.test",
            ]), 0)
        run.assert_called_once_with(
            7, self.root, True, True, True, True, "wss://example.test")


class BackfillCommands(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = self.temp.name

    def test_backfill_order_oldest_first(self):
        calls = []
        with (mock.patch.object(store_dump, "retention_watch"),
              mock.patch.object(store_dump, "backfill_games", return_value=[3, 1, 2]),
              mock.patch.object(store_dump, "dump_game",
                                side_effect=lambda game, **_kwargs: calls.append(game) or "/missing"),
              mock.patch.object(store_dump.time, "sleep"),
              mock.patch("sys.stdout", new_callable=__import__("io").StringIO)):
            code = store_dump.run_backfill(root=self.root, sleep_seconds=0)
        self.assertEqual(code, 0)
        self.assertEqual(calls, [1, 2, 3])

    def test_backfill_continues_after_failure_and_exits_1(self):
        calls = []
        def dumped(game, **_kwargs):
            calls.append(game)
            if game == 1:
                raise RuntimeError("broken one")
            return "/missing"

        with (mock.patch.object(store_dump, "retention_watch"),
              mock.patch.object(store_dump, "backfill_games", return_value=[1, 2]),
              mock.patch.object(store_dump, "dump_game", side_effect=dumped),
              mock.patch.object(store_dump.time, "sleep"),
              mock.patch("sys.stdout", new_callable=__import__("io").StringIO) as stdout):
            code = store_dump.run_backfill(root=self.root, sleep_seconds=0)
        self.assertEqual(code, 1)
        self.assertEqual(calls, [1, 2])
        self.assertIn("g1 failed: broken one", stdout.getvalue())
        self.assertIn("1 failed", stdout.getvalue())
        self.assertIn("2 stored", stdout.getvalue())

    def test_backfill_skips_existing(self):
        existing = store_dump.store_paths.game_dir(1, root=self.root)
        os.makedirs(existing)
        marker = os.path.join(existing, "keep")
        with open(marker, "w", encoding="utf-8") as fh:
            fh.write("evidence")
        with (mock.patch.object(store_dump, "retention_watch"),
              mock.patch.object(store_dump, "backfill_games", return_value=[1, 2]),
              mock.patch.object(store_dump, "dump_game", return_value="/missing") as dump,
              mock.patch.object(store_dump.time, "sleep"),
              mock.patch("sys.stdout", new_callable=__import__("io").StringIO) as stdout):
            code = store_dump.run_backfill(root=self.root, sleep_seconds=0)
        self.assertEqual(code, 0)
        dump.assert_called_once_with(2, root=self.root)
        with open(marker, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), "evidence")
        self.assertIn("1 skipped-existing", stdout.getvalue())

    def test_due_lists_only_past_late_end(self):
        manifests = {
            1: (False, "2026-10-16T00:00:00Z"),
            2: (False, "2026-10-18T00:00:00Z"),
            3: (True, "2026-10-16T00:00:00Z"),
        }
        for game, (complete, late_end) in manifests.items():
            folder = store_dump.store_paths.game_dir(game, root=self.root)
            os.makedirs(folder)
            with open(os.path.join(folder, "manifest.json"), "w", encoding="utf-8") as fh:
                json.dump({"game": game, "late_complete": complete,
                           "window": {"late_end_utc": late_end}}, fh)
        now = datetime.datetime(2026, 10, 17, tzinfo=datetime.timezone.utc)
        with mock.patch("sys.stdout", new_callable=__import__("io").StringIO) as stdout:
            games = store_dump.print_due(root=self.root, now=now)
        self.assertEqual(games, [1])
        self.assertIn(" 1 --refresh", stdout.getvalue())
        self.assertNotIn(" 2 --refresh", stdout.getvalue())
        self.assertNotIn(" 3 --refresh", stdout.getvalue())

    def test_watch_prints_oldest_per_dataset_and_project(self):
        def pages(dataset, query, fields, **kwargs):
            self.assertEqual(query, "")
            self.assertEqual(fields, ["timestamp"])
            self.assertEqual(kwargs["sort"], "timestamp")
            self.assertEqual(kwargs["per_page"], 1)
            self.assertEqual(kwargs["period"], "90d")
            self.assertEqual(len(kwargs["pids"]), 1)
            return [[{"timestamp": "2026-10-01T00:00:00Z"}]]

        with (mock.patch.object(sentry, "pages", side_effect=pages) as paged,
              mock.patch("sys.stdout", new_callable=__import__("io").StringIO) as stdout):
            rows = store_dump.retention_watch()
        self.assertEqual(len(rows), 10)
        self.assertEqual(paged.call_count, 10)
        for dataset in ("spans", "errors", "transactions", "tracemetrics", "logs"):
            self.assertIn(dataset, stdout.getvalue())
        for project in sentry.PROJECTS:
            self.assertIn(project, stdout.getvalue())
        self.assertIn("first_data", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
