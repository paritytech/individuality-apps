# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""Tests for the frozen T10/T11 local telemetry-store query source."""
import datetime
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

import pyarrow as pa
import pyarrow.parquet as pq

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sentry  # noqa: E402
import sentry_logs  # noqa: E402
import store_source  # noqa: E402

PULL_SPEC = importlib.util.spec_from_file_location(
    "store_source_game_report_pull", os.path.join(HERE, "game-report-pull.py"))
PULL = importlib.util.module_from_spec(PULL_SPEC)
PULL_SPEC.loader.exec_module(PULL)


class Translator(unittest.TestCase):
    COLUMNS = {
        "id": "VARCHAR", "timestamp": "VARCHAR", "title": "VARCHAR",
        "is_transaction": "BOOLEAN", "tags[game.index]": "VARCHAR",
        "tags[mode,number]": "DOUBLE", "value": "DOUBLE",
    }

    def test_parse_each_supported_form(self):
        got = store_source.parse_query(
            "title:game-log !title:noise has:id !has:missing game.index:[7, 8] !mode:[1,2]")
        self.assertEqual([(t.key, t.values, t.negative, t.has) for t in got], [
            ("title", ("game-log",), False, False),
            ("title", ("noise",), True, False),
            ("id", (), False, True),
            ("missing", (), True, True),
            ("game.index", ("7", "8"), False, False),
            ("mode", ("1", "2"), True, False),
        ])

    def test_refuses_wildcard_quotes_comparisons_boolean_operators_and_parentheses(self):
        for query in ("title:*", 'title:"x"', "value:>3", "value:<3", "a:b OR c:d",
                      "a:b AND c:d", "(a:b)", "!!a:b", "a:[[b]]"):
            with self.subTest(query=query), self.assertRaisesRegex(sentry.OutOfStore, "unsupported"):
                store_source.parse_query(query)

    def test_trailing_string_wildcard_is_anchored_and_supports_negation(self):
        connection = store_source.store.duckdb.connect(":memory:")
        self.addCleanup(connection.close)
        connection.execute("CREATE TABLE errors (id VARCHAR, title VARCHAR)")
        connection.executemany("INSERT INTO errors VALUES (?, ?)", [
            ("match", "chat.notif.book"), ("not-anchored", "achat.x"),
        ])
        columns = {"id": "VARCHAR", "title": "VARCHAR"}

        sql, params = store_source.to_sql(
            "errors", store_source.parse_query("title:chat.*"), ["id"], "id", columns)
        self.assertEqual(connection.execute(sql, params).fetchall(), [("match",)])
        self.assertIn("LIKE ? ESCAPE '\\'", sql)
        self.assertEqual(params, ["chat.%"])

        sql, params = store_source.to_sql(
            "errors", store_source.parse_query("!title:chat.*"), ["id"], "id", columns)
        self.assertEqual(connection.execute(sql, params).fetchall(), [("not-anchored",)])
        self.assertIn("NOT LIKE ? ESCAPE '\\'", sql)

    def test_trailing_string_wildcard_escapes_literal_sql_wildcards(self):
        connection = store_source.store.duckdb.connect(":memory:")
        self.addCleanup(connection.close)
        connection.execute("CREATE TABLE errors (id VARCHAR, title VARCHAR)")
        connection.executemany("INSERT INTO errors VALUES (?, ?)", [
            ("percent", "chat.%literal.tail"), ("percent-near", "chat.Xliteral.tail"),
            ("underscore", "chat._literal.tail"), ("underscore-near", "chat.Yliteral.tail"),
        ])
        columns = {"id": "VARCHAR", "title": "VARCHAR"}
        for query, expected, parameter in (
                ("title:chat.%literal*", [("percent",)], "chat.\\%literal%"),
                ("title:chat._literal*", [("underscore",)], "chat.\\_literal%")):
            with self.subTest(query=query):
                sql, params = store_source.to_sql(
                    "errors", store_source.parse_query(query), ["id"], "id", columns)
                self.assertEqual(connection.execute(sql, params).fetchall(), expected)
                self.assertEqual(params, [parameter])

    def test_refuses_every_other_wildcard_form(self):
        for query in ("title:*", "title:*chat", "title:ch*at", "title:chat**",
                      "title:[chat.*,other]", "title:[chat,other*]", "ti*tle:chat"):
            with self.subTest(query=query), self.assertRaisesRegex(sentry.OutOfStore, "unsupported"):
                store_source.parse_query(query)

        for query in ("mode:1*", "is_transaction:true*"):
            with self.subTest(query=query), self.assertRaisesRegex(sentry.OutOfStore, "unsupported"):
                store_source.to_sql(
                    "spans", store_source.parse_query(query), ["id"], None, self.COLUMNS)

    def test_key_resolution_uses_plain_then_string_number_boolean_tags(self):
        self.assertEqual(store_source.resolve_column("title", self.COLUMNS), "title")
        self.assertEqual(store_source.resolve_column("game.index", self.COLUMNS), "tags[game.index]")
        self.assertEqual(store_source.resolve_column("mode", self.COLUMNS), "tags[mode,number]")
        self.assertIsNone(store_source.resolve_column("absent", self.COLUMNS))

    def test_resolution_coalesces_every_existing_column_home(self):
        columns = {
            "id": "VARCHAR", "timestamp": "VARCHAR",
            "game.index": "VARCHAR", "tags[game.index]": "VARCHAR",
            "tags[game.index,number]": "DOUBLE", "tags[game.index,boolean]": "BOOLEAN",
        }
        sql, _ = store_source.to_sql("errors", [], ["game.index"], None, columns)
        self.assertIn(
            'COALESCE("game.index", "tags[game.index]", '
            'CAST("tags[game.index,number]" AS VARCHAR), '
            'CAST("tags[game.index,boolean]" AS VARCHAR)) AS "game.index"',
            sql,
        )

    def test_missing_column_semantics(self):
        positive, _ = store_source.to_sql("errors", store_source.parse_query("absent:x"), ["id"], None,
                                          self.COLUMNS)
        negative, _ = store_source.to_sql("errors", store_source.parse_query("!absent:x"), ["id"], None,
                                          self.COLUMNS)
        has, _ = store_source.to_sql("errors", store_source.parse_query("has:absent"), ["id"], None,
                                     self.COLUMNS)
        self.assertIn("FALSE", positive)
        self.assertIn("TRUE", negative)
        self.assertIn("FALSE", has)

    def test_negation_includes_null_and_boolean_comparison_is_typed(self):
        sql, params = store_source.to_sql(
            "spans", store_source.parse_query("!title:noise is_transaction:true"), ["id"], None, self.COLUMNS)
        self.assertIn('("title" IS NULL OR "title" <> ?)', sql)
        self.assertIn('"is_transaction" = ?', sql)
        self.assertEqual(params, ["noise", True])

    def test_number_tag_filter_is_numeric(self):
        sql, params = store_source.to_sql(
            "spans", store_source.parse_query("mode:1"), ["id"], None, self.COLUMNS)
        self.assertIn('"tags[mode,number]" = ?', sql)
        self.assertNotIn('CAST("tags[mode,number]" AS VARCHAR)', sql)
        self.assertEqual(params, [1.0])

    def test_sql_aggregation_is_limited_to_non_metric_counts(self):
        sql, _ = store_source.to_sql(
            "spans", [], ["title", "count()"], None, self.COLUMNS)
        self.assertIn('GROUP BY "title"', sql)
        self.assertIn('CAST(COUNT(*) AS DOUBLE) AS "count()"', sql)
        error_sql, _ = store_source.to_sql("errors", [], ["count()"], None, self.COLUMNS)
        self.assertNotIn("DOUBLE", error_sql)

    def test_row_tie_break_uses_last_sort_direction_and_p13_plain_casts(self):
        sql, _ = store_source.to_sql("errors", [], ["id", "timestamp"], "-timestamp", self.COLUMNS)
        self.assertIn('ORDER BY "timestamp" DESC NULLS LAST, "id" DESC NULLS LAST', sql)
        tx_sql, _ = store_source.to_sql(
            "transactions", [], ["transaction.duration"], None,
            {"transaction.duration": "DOUBLE", "timestamp": "VARCHAR"})
        self.assertIn('CAST("transaction.duration" AS BIGINT)', tx_sql)

    def test_only_frozen_aggregates_are_allowed(self):
        with self.assertRaisesRegex(sentry.OutOfStore, "unsupported"):
            store_source.to_sql("errors", [], ["avg(value)"], None, self.COLUMNS)

    def test_metric_aggregates_have_no_second_sql_implementation(self):
        with self.assertRaisesRegex(sentry.OutOfStore, "unsupported"):
            store_source.to_sql("tracemetrics", [], ["p50(value)"], None, self.COLUMNS)


class StoreRows(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = self.temp.name
        folder = os.path.join(self.root, "paseo", "g7")
        os.makedirs(folder)
        table = pa.table({
            "id": ["a", "b", "c", "d", "test-only", "boundary", "boundary"],
            "timestamp": ["2026-10-01T10:00:00+00:00", "2026-10-01T10:05:00+00:00",
                          "2026-10-01T10:10:00+00:00", "2026-10-01T10:20:00+00:00",
                          "2026-10-01T10:05:00+00:00", "2026-10-01T10:10:00+00:00",
                          "2026-10-01T10:10:00+00:00"],
            "title": [None, "alpha", "beta", "late", "test", "alpha", "alpha"],
            "project.name": ["jollity-next", "jollity-next", "jollity-next", "jollity-next",
                             "dim2-testing", "jollity-next", "jollity-next"],
            "game.index": ["7", "7", "8", "7", "7", "7", "7"],
            "tags[round,number]": [1.0, 2.0, 2.0, 1.0, 1.0, 2.0, 2.0],
            "_project": ["jollity-next", "jollity-next", "jollity-next", "jollity-next",
                         "dim2-testing", "jollity-next", "jollity-next"],
            "_part": ["window", "window", "window", "late", "window", "window", "late"],
        })
        pq.write_table(table, os.path.join(folder, "errors.parquet"))
        pq.write_table(pa.table({
            "id": ["log-pad", "log-a"],
            "timestamp": ["2026-10-01T00:00:00+00:00", "2026-10-01T10:05:00+00:00"],
            "game.index": ["7", "7"],
            "_project": ["jollity-next", "jollity-next"], "_part": ["window", "window"],
        }), os.path.join(folder, "logs.parquet"))
        pq.write_table(pa.table({
            "id": ["m1", "m2", "m3", "m4", "m5", "m6"],
            "timestamp": ["2026-10-01T10:01:00+00:00", "2026-10-01T10:02:00+00:00",
                          "2026-10-01T10:03:00+00:00", "2026-10-01T10:04:00+00:00",
                          "2026-10-01T10:05:00+00:00", "2026-10-01T10:06:00+00:00"],
            "metric.name": ["fps", "fps", "fps", "height",
                            "chat.notif.permission", "chat.notif.permission"],
            "value": [1.0, 4.0, 2.0, 8.0, 1.0, 1.0], "game.index": ["7", "7", "7", "7", None, None],
            # the chat worker's counters keep the SDK name in sdk.name, with no sentry. prefix
            "sdk.name": [None, None, None, None, "jollity.chat-worker", "jollity.chat-worker"],
            "user.id": [None, None, None, None, "5Alice", "5Bob"],
            "user.name": [None, None, None, None, "alice.01", "bob.01"],
            "outcome": [None, None, None, None, "granted", "denied"],
            "_project": ["jollity-next"] * 6, "_part": ["window"] * 6,
        }), os.path.join(folder, "tracemetrics.parquet"))
        pq.write_table(pa.table({
            "id": ["event-a", "missing-event", "pending-tx"],
            "project": ["jollity-next", "jollity-next", "jollity-next"],
            "dataset": ["errors", "errors", "transactions"], "status": [200, 404, 404],
            "json": ['{"id":"event-a","title":"boom"}', None, None],
        }), os.path.join(folder, "events_json.parquet"))
        pq.write_table(pa.table({
            "id": ["pending-tx"], "timestamp": ["2026-10-01T10:05:00+00:00"],
            "_project": ["jollity-next"], "_part": ["window"],
        }), os.path.join(folder, "transactions.parquet"))
        pq.write_table(pa.table({
            "event_id": ["event-a", "event-a"], "project": ["jollity-next", "jollity-next"],
            "attachment_id": ["att-a", "att-b"], "name": ["a.json", "b.json"],
            "size": [3, 3],
            "list_json": [
                '[{"id":"att-a","name":"a.json","size":3},{"id":"att-b","name":"b.json","size":3}]',
                '[{"id":"att-a","name":"a.json","size":3},{"id":"att-b","name":"b.json","size":3}]',
            ],
            "body": [b"one", b"two"], "sha256": ["sha-one", "sha-two"],
        }), os.path.join(folder, "attachments.parquet"))
        pq.write_table(pa.table({
            "user.id": ["5Alice", "5Bob", "5Alice"],
            "user.username": ["alice.01", "bob.01", "alice.01"],
            "count()": [4.0, 2.0, 1.0], "dataset": ["spans", "errors", "spans"],
            "_project": ["jollity-next", "jollity-next", "dim2-testing"],
        }), os.path.join(folder, "context_usernames.parquet"))
        pq.write_table(pa.table({
            "release": ["r-new", "r-new", "r-old"], "count(value)": [9.0, 3.0, 2.0],
            "_project": ["jollity-next", "dim2-testing", "dim2-testing"],
        }), os.path.join(folder, "context_releases.parquet"))
        padded_start = (sentry.parse_ts("2026-10-01T10:00:00") -
                        sentry_logs.CLOCK_LAG_PAD).isoformat()
        project_parts = {
            sentry.PROJECTS["jollity-next"]: {
                "window": {}, "pre_window": {"start": padded_start}, "late": {}},
            sentry.PROJECTS["dim2-testing"]: {
                "window": {}, "pre_window": {"start": padded_start}, "late": {}},
        }
        with open(os.path.join(folder, "manifest.json"), "w", encoding="utf-8") as fh:
            json.dump({
                "network": "paseo", "game": 7, "pass": True,
                "projects": {"jollity-next": sentry.PROJECTS["jollity-next"],
                             "dim2-testing": sentry.PROJECTS["dim2-testing"]},
                "window": {
                    "report_start": "2026-10-01T10:00:00",
                    "report_end": "2026-10-01T10:10:00",
                    "late_end_utc": "2026-10-08T10:10:00+00:00",
                },
                "datasets": {
                    "errors": {"per_project": project_parts},
                    "logs": {"per_project": project_parts},
                    "spans": {"per_project": {
                        sentry.PROJECTS["jollity-next"]: {"window": {}},
                        sentry.PROJECTS["dim2-testing"]: {"window": {}},
                    }},
                    "tracemetrics": {"per_project": {
                        sentry.PROJECTS["jollity-next"]: {"window": {}},
                        sentry.PROJECTS["dim2-testing"]: {"window": {}},
                    }},
                    "context_usernames": {
                        "start": "2026-09-01T10:10:00", "end": "2026-10-01T10:10:00",
                    },
                    "context_releases": {
                        "start": "2026-09-01T10:10:00", "end": "2026-10-01T10:10:00",
                    },
                },
            }, fh)
        folder8 = os.path.join(self.root, "paseo", "g8")
        os.makedirs(folder8)
        pq.write_table(pa.table({
            "id": ["g8-tagged"], "timestamp": ["2026-10-01T10:05:00+00:00"],
            "tags[game.index]": ["8"], "project.name": ["jollity-next"],
            "_project": ["jollity-next"], "_part": ["window"],
        }), os.path.join(folder8, "errors.parquet"))
        with open(os.path.join(folder8, "manifest.json"), "w", encoding="utf-8") as fh:
            json.dump({
                "network": "paseo", "game": 8, "pass": True,
                "projects": {"jollity-next": sentry.PROJECTS["jollity-next"]},
                "window": {
                    "report_start": "2026-10-01T10:00:00",
                    "report_end": "2026-10-01T10:10:00",
                    "late_end_utc": "2026-10-08T10:10:00+00:00",
                },
                "datasets": {"errors": {"per_project": {
                    sentry.PROJECTS["jollity-next"]: {"window": {}, "late": {}},
                }}},
            }, fh)
        self.source = store_source.StoreSource(7, root=self.root)
        sentry.use_project("jollity-next")

    def tearDown(self):
        sentry.use_source(None)
        self.source.close()
        self.temp.cleanup()
        sentry.use_project("jollity-next")

    def test_window_is_inclusive_and_project_filter_comes_from_pids(self):
        rows = self.source.rows("errors", "", ["id"], sort="id",
                                start="2026-10-01T10:00:00", end="2026-10-01T10:10:00")
        self.assertEqual(rows, [
            {"id": "a", "project.name": "jollity-next"},
            {"id": "b", "project.name": "jollity-next"},
            {"id": "boundary", "project.name": "jollity-next"},
            {"id": "c", "project.name": "jollity-next"},
        ])
        sentry.use_project("dim2-testing")
        rows = self.source.rows("errors", "", ["id"], sort="id",
                                start="2026-10-01T10:00:00", end="2026-10-01T10:10:00")
        self.assertEqual(rows, [
            {"id": "a", "project.name": "jollity-next"},
            {"id": "b", "project.name": "jollity-next"},
            {"id": "boundary", "project.name": "jollity-next"},
            {"id": "c", "project.name": "jollity-next"},
            {"id": "test-only", "project.name": "dim2-testing"},
        ])

    def test_same_field_coalesces_across_games_with_different_column_homes(self):
        self.assertEqual(self.source.rows(
            "errors", "game.index:7", ["id", "game.index"], sort="id",
            start="2026-10-01T10:00:00", end="2026-10-01T10:00:00"), [
                {"id": "a", "game.index": "7", "project.name": "jollity-next"},
            ])
        other = store_source.StoreSource(8, root=self.root)
        self.addCleanup(other.close)
        self.assertEqual(other.rows(
            "errors", "game.index:8", ["id", "game.index"], sort="id",
            start="2026-10-01T10:00:00", end="2026-10-01T10:10:00"), [
                {"id": "g8-tagged", "game.index": "8", "project.name": "jollity-next"},
            ])

    def test_number_tag_filter_matches_equivalent_numeric_spelling(self):
        rows = self.source.rows(
            "errors", "round:1", ["id"], sort="id",
            start="2026-10-01T10:00:00", end="2026-10-01T10:10:00")
        self.assertEqual(rows, [{"id": "a", "project.name": "jollity-next"}])

    def test_negative_filter_includes_nulls_and_sort_puts_nulls_last(self):
        rows = self.source.rows("errors", "!title:alpha", ["id", "title"], sort="title",
                                start="2026-10-01T10:00:00", end="2026-10-01T10:10:00")
        self.assertEqual(rows, [
            {"id": "c", "title": "beta", "project.name": "jollity-next"},
            {"id": "a", "title": None, "project.name": "jollity-next"},
        ])

    def test_out_of_window_raises(self):
        with self.assertRaisesRegex(sentry.OutOfStore, "coverage"):
            self.source.rows("errors", "game.index:7", ["id"],
                             start="2026-09-30T23:59:59", end="2026-10-01T10:10:00")

    def test_late_range_requires_this_game_filter(self):
        with self.assertRaisesRegex(sentry.OutOfStore, "game.index:7"):
            self.source.rows("errors", "title:late", ["id"],
                             start="2026-10-01T10:10:00", end="2026-10-01T10:20:00")
        self.assertEqual(self.source.rows(
            "errors", "game.index:7 title:late", ["id"],
            start="2026-10-01T10:10:00", end="2026-10-01T10:20:00"),
            [{"id": "d", "project.name": "jollity-next"}])

    def test_late_range_requires_a_stored_late_part_for_the_dataset(self):
        with self.assertRaisesRegex(sentry.OutOfStore, "late part"):
            self.source.rows(
                "spans", "game.index:7", ["id"],
                start="2026-10-01T10:10:00", end="2026-10-01T10:20:00")

    def test_every_requested_project_must_be_stored(self):
        other = store_source.StoreSource(8, root=self.root)
        self.addCleanup(other.close)
        sentry.use_project("dim2-testing")
        with self.assertRaisesRegex(sentry.OutOfStore, "requested projects are absent"):
            other.rows("errors", "game.index:8", ["id"],
                       start="2026-10-01T10:00:00", end="2026-10-01T10:10:00")

    def test_logs_synthesizes_project_name_from_store_project(self):
        self.assertEqual(self.source.rows(
            "logs", "", ["id"],
            start="2026-10-01T10:00:00", end="2026-10-01T10:10:00"), [
                {"id": "log-a", "project.name": "jollity-next"},
            ])

    def test_logs_for_this_game_may_start_at_the_clock_lag_pad_only(self):
        padded = (sentry.parse_ts("2026-10-01T10:00:00") -
                  sentry_logs.CLOCK_LAG_PAD).strftime("%Y-%m-%dT%H:%M:%S")
        self.assertEqual(self.source.rows(
            "logs", "game.index:7", ["id"], sort="id",
            start=padded, end="2026-10-01T10:10:00"), [
                {"id": "log-a", "project.name": "jollity-next"},
                {"id": "log-pad", "project.name": "jollity-next"},
            ])

    def test_logs_pad_requires_every_project_to_have_a_full_pre_window_capture(self):
        padded = (sentry.parse_ts("2026-10-01T10:00:00") -
                  sentry_logs.CLOCK_LAG_PAD).strftime("%Y-%m-%dT%H:%M:%S")
        parts = self.source.manifest["datasets"]["logs"]["per_project"]
        parts[sentry.PROJECTS["jollity-next"]]["pre_window"]["start"] = (
            sentry.parse_ts(padded) + datetime.timedelta(seconds=1)).isoformat()
        with self.assertRaisesRegex(sentry.OutOfStore, "pre-window"):
            self.source.rows("logs", "game.index:7", ["id"], start=padded,
                             end="2026-10-01T10:10:00")

        parts[sentry.PROJECTS["jollity-next"]]["pre_window"]["start"] = padded
        sentry.use_project("dim2-testing")
        del parts[sentry.PROJECTS["dim2-testing"]]["pre_window"]
        with self.assertRaisesRegex(sentry.OutOfStore, "pre-window"):
            self.source.rows("logs", "game.index:7", ["id"], start=padded,
                             end="2026-10-01T10:10:00")
        for dataset, query in (("logs", "user.id:5Alice"), ("errors", "game.index:7"),
                               ("logs", "game.index:8")):
            with self.subTest(dataset=dataset, query=query), \
                 self.assertRaisesRegex(sentry.OutOfStore, "coverage"):
                self.source.rows(dataset, query, ["id"], start=padded,
                                 end="2026-10-01T10:10:00")
        too_early = (sentry.parse_ts(padded) -
                     datetime.timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%S")
        with self.assertRaisesRegex(sentry.OutOfStore, "coverage"):
            self.source.rows("logs", "game.index:7", ["id"], start=too_early,
                             end="2026-10-01T10:10:00")
        self.assertEqual(self.source.rows(
            "logs", "", ["id", "project.name"],
            start="2026-10-01T10:00:00", end="2026-10-01T10:10:00"), [
                {"id": "log-a", "project.name": "jollity-next"},
            ])

    def test_window_late_boundary_is_deduped_before_aggregation(self):
        self.assertEqual(self.source.rows(
            "errors", "game.index:7", ["count()"],
            start="2026-10-01T10:10:00", end="2026-10-01T10:10:00"), [
                {"count()": 1},
            ])

    def test_store_aggregate_queries_use_the_shared_local_implementation(self):
        fields = ["metric.name", "p50(value)", "max(value)", "min(value)",
                  "count(value)", "sum(value)"]
        expected = [
            {"metric.name": "fps", "p50(value)": 2.0, "max(value)": 4.0,
             "min(value)": 1.0, "count(value)": 3.0, "sum(value)": 7.0},
            {"metric.name": "height", "p50(value)": 8.0, "max(value)": 8.0,
             "min(value)": 8.0, "count(value)": 1.0, "sum(value)": 8.0},
        ]
        real = store_source.agg.aggregate
        with mock.patch.object(store_source.agg, "aggregate", wraps=real) as aggregate:
            self.assertEqual(self.source.rows(
                "tracemetrics", "game.index:7", fields,
                start="2026-10-01T10:00:00", end="2026-10-01T10:10:00"), expected)
        self.assertEqual(aggregate.call_count, 1)

    def test_store_aggregate_refuses_caller_sort_before_limit(self):
        with self.assertRaisesRegex(sentry.OutOfStore, "aggregate sort"):
            self.source.rows(
                "tracemetrics", "game.index:7", ["metric.name", "sum(value)"],
                sort="-sum(value)", limit=1,
                start="2026-10-01T10:00:00", end="2026-10-01T10:10:00")

    def test_chat_metric_rows_read_the_chat_workers_counters_from_the_store(self):
        # #1354: the reader scopes on sentry.sdk.name, which the store keeps as sdk.name, so every chat counter read as nothing
        sentry.use_source(self.source)
        rows = sentry_logs.chat_metric_rows(
            "metric.name:chat.notif.permission", ["outcome"], "2026-10-01T10:00:00", "2026-10-01T10:10:00",
            _metric_groups=PULL.metric_groups)
        self.assertEqual(sorted((r["user.id"], r["outcome"], r["count()"]) for r in rows),
                         [("5Alice", "granted", 1.0), ("5Bob", "denied", 1.0)])

    def test_live_pull_and_store_use_the_same_function(self):
        self.assertIs(PULL.agg, store_source.agg)
        self.assertIs(PULL.agg.aggregate, store_source.agg.aggregate)

    def test_grouped_query_does_not_add_project_name(self):
        rows = self.source.rows("errors", "game.index:7", ["title", "count()"], sort="title",
                                start="2026-10-01T10:00:00", end="2026-10-01T10:10:00")
        self.assertTrue(rows)
        self.assertTrue(all("project.name" not in row for row in rows))

    def test_get_routes_event_json_and_unknown_event(self):
        self.assertEqual(self.source.get(
            "/projects/paritytech/jollity-next/events/event-a/"),
            {"id": "event-a", "title": "boom"})
        self.assertEqual(self.source.get(
            "https://de.sentry.io/api/0/projects/paritytech/jollity-next/events/missing-event/"), {})
        self.assertEqual(self.source.get(
            "/projects/paritytech/jollity-next/events/unknown/"), {})
        with self.assertRaisesRegex(sentry.OutOfStore, "transaction event JSON is pending"):
            self.source.get(
                "/projects/paritytech/jollity-next/events/pending-tx/")

    def test_get_routes_attachment_list_and_binary_download(self):
        self.assertEqual([row["id"] for row in self.source.get(
            "/projects/paritytech/jollity-next/events/event-a/attachments/")],
            ["att-a", "att-b"])
        self.assertEqual(self.source.get(
            "/projects/paritytech/jollity-next/events/event-a/attachments/att-b/?download=1",
            raw=True), b"two")

    def test_get_refuses_every_other_url(self):
        for url in ("/organizations/paritytech/events/",
                    "/projects/other/jollity-next/events/event-a/",
                    "/projects/paritytech/jollity-next/events/event-a/attachments/att-b/"):
            with self.subTest(url=url), self.assertRaisesRegex(sentry.OutOfStore, "unsupported"):
                self.source.get(url)

    def test_exact_history_username_context_filters_users_and_dataset(self):
        rows = self.source.rows(
            "spans", "user.id:[5Alice,5Missing] has:user.username",
            ["user.id", "user.username", "count()"],
            start="2026-09-01T10:10:00", end="2026-10-01T10:10:00")
        self.assertEqual(rows, [{"user.id": "5Alice", "user.username": "alice.01", "count()": 4.0}])

    def test_exact_release_context_returns_stored_window(self):
        self.assertEqual(self.source.rows(
            "tracemetrics", "metric.name:[rtc.video_ms,rtc.present_ms]",
            ["release", "count(value)"], start="2026-09-01T10:10:00",
            end="2026-10-01T10:10:00"), [
                {"release": "r-new", "count(value)": 9.0},
            ])

    def test_release_context_regroups_projects_and_serves_real_slice_releases(self):
        sentry.use_project("dim2-testing")
        self.assertEqual(self.source.rows(
            "tracemetrics", "metric.name:[rtc.video_ms,rtc.present_ms]",
            ["release", "count(value)"], start="2026-09-01T10:10:00",
            end="2026-10-01T10:10:00"), [
                {"release": "r-new", "count(value)": 12.0},
                {"release": "r-old", "count(value)": 2.0},
            ])
        sentry.use_source(self.source)
        self.assertEqual(PULL.slice_releases("2026-10-01T10:10:00"), ["r-new", "r-old"])

    def test_username_context_regroups_duplicate_identity_across_projects(self):
        sentry.use_project("dim2-testing")
        rows = self.source.rows(
            "spans", "user.id:[5Alice] has:user.username",
            ["user.id", "user.username", "count()"],
            start="2026-09-01T10:10:00", end="2026-10-01T10:10:00")
        self.assertEqual(rows, [
            {"user.id": "5Alice", "user.username": "alice.01", "count()": 5.0},
        ])

    def test_near_context_matches_fail_closed(self):
        cases = [
            ("spans", "user.id:[5Alice] has:user.username",
             ["user.id", "user.username", "count()"], "2026-09-01T10:10:01"),
            ("errors", "user.id:[5Alice]", ["user.id", "user.username", "count()"],
             "2026-09-01T10:10:00"),
            ("tracemetrics", "metric.name:[rtc.video_ms,rtc.present_ms]",
             ["release", "count()"], "2026-09-01T10:10:00"),
        ]
        for dataset, query, fields, start in cases:
            with self.subTest(dataset=dataset, query=query, fields=fields), \
                 self.assertRaises(sentry.OutOfStore):
                self.source.rows(dataset, query, fields, start=start,
                                 end="2026-10-01T10:10:00")


if __name__ == "__main__":
    unittest.main()
