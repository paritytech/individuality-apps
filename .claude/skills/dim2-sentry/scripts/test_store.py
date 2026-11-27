# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""Tests for store.py: read-only DuckDB views over stored games. Needs the skill venv."""
import os
import shutil
import sys
import tempfile
import unittest

try:
    import pyarrow  # noqa: F401
    import duckdb  # noqa: F401
except ImportError:
    raise unittest.SkipTest(
        "store tests need the skill venv: "
        ".claude/skills/dim2-sentry/.venv/bin/python -m pytest")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import store  # noqa: E402
import store_paths  # noqa: E402
import store_write  # noqa: E402


EXAMPLE_QUERIES = [
    '''
SELECT _game, count(*) AS samples,
       round(100.0 * count(*) FILTER (WHERE "rtc.path" = 'relay') / count(*), 1) AS turn_pct,
       round(100.0 * count(*) FILTER (WHERE "rtc.path" = 'stun') / count(*), 1) AS stun_pct,
       round(100.0 * count(*) FILTER (WHERE "rtc.path" = 'direct') / count(*), 1) AS direct_pct
FROM tracemetrics
WHERE _project = 'jollity-next' AND "metric.name" = 'rtc.rtt_ms' AND "game.index" = CAST(_game AS VARCHAR)
GROUP BY _game ORDER BY _game
''',
    '''
SELECT _game, max(value) FILTER (WHERE stat = 'p95') AS worst_loss_p95_pct,
       median(value) FILTER (WHERE stat = 'p50') AS typical_loss_p50_pct
FROM tracemetrics
WHERE _project = 'jollity-next' AND "metric.name" = 'rtc.loss_pct' AND "game.index" = CAST(_game AS VARCHAR)
GROUP BY _game ORDER BY _game
''',
    '''
WITH c AS (SELECT _game, count(*) AS registered, count(*) FILTER (WHERE sentReport) AS reported,
                  count(*) FILTER (WHERE attended) AS attested FROM accounts GROUP BY _game),
     j AS (SELECT _game, count(DISTINCT "user.id") AS joined FROM spans
           WHERE _project = 'jollity-next' AND "span.op" = 'journey.join' AND "game.index" = CAST(_game AS VARCHAR) GROUP BY _game)
SELECT c._game, registered, joined, reported, attested FROM c LEFT JOIN j USING (_game) ORDER BY c._game
''',
    '''
SELECT _game, "journey.outcome" AS outcome, count(*) AS journeys
FROM spans
WHERE _project = 'jollity-next' AND "span.op" = 'journey.game-signup' AND "game.index" = CAST(_game AS VARCHAR)
GROUP BY ALL ORDER BY _game, journeys DESC
''',
    '''
SELECT _game, pulled_at_local, data_as_of_local, late_complete, api_calls, minutes
FROM manifests ORDER BY _game
''',
]


class StoreReader(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="store-reader-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self._write_game(1, drift=False)
        self._write_game(2, drift=True)

    def _folder(self, game, name="paseo"):
        folder = os.path.join(self.root, name, "g%d" % game)
        os.makedirs(folder, exist_ok=True)
        return folder

    @staticmethod
    def _raw_table(rows, columns):
        table, _json_columns = store_write.rows_to_table(rows, columns, {})
        projects = table.column("__store_project")
        parts = table.column("__store_part")
        table = table.drop(["__store_project", "__store_part"])
        return table.append_column("_project", projects).append_column("_part", parts)

    def _write_game(self, game, drift):
        folder = self._folder(game)
        index = str(game)
        span_rows = [
            {"id": "join-%d" % game, "timestamp": "2026-10-16T10:00:00Z",
             "span.op": "journey.join", "game.index": index,
             "user.id": "fake-%d" % game, "__store_project": "jollity-next",
             "__store_part": "window"},
            {"id": "signup-%d" % game, "timestamp": "2026-10-16T10:00:01Z",
             "span.op": "journey.game-signup", "game.index": index,
             "user.id": "fake-%d" % game, "__store_project": "jollity-next",
             "__store_part": "window", **({"journey.outcome": "registered"} if drift else {})},
        ]
        span_columns = [(name, "string") for name in (
            "id", "timestamp", "span.op", "game.index", "user.id")]
        if drift:
            span_columns.append(("journey.outcome", "string"))
        store_write.write_parquet(
            self._raw_table(span_rows, span_columns), os.path.join(folder, "spans.parquet"))

        metric_rows = [
            {"id": "rtt-%d" % game, "timestamp": "2026-10-16T10:00:02Z",
             "metric.name": "rtc.rtt_ms", "game.index": index, "rtc.path": "relay",
             "stat": "p50", "value": 12.0, "__store_project": "jollity-next",
             "__store_part": "window"},
            {"id": "loss50-%d" % game, "timestamp": "2026-10-16T10:00:03Z",
             "metric.name": "rtc.loss_pct", "game.index": index, "rtc.path": "stun",
             "stat": "p50", "value": 1.0 + game, "__store_project": "jollity-next",
             "__store_part": "window"},
            {"id": "loss95-%d" % game, "timestamp": "2026-10-16T10:00:04Z",
             "metric.name": "rtc.loss_pct", "game.index": index, "rtc.path": "direct",
             "stat": "p95", "value": 3.0 + game, "__store_project": "jollity-next",
             "__store_part": "window"},
        ]
        metric_columns = [(name, "string") for name in (
            "id", "timestamp", "metric.name", "game.index", "rtc.path", "stat")]
        metric_columns.append(("value", "number"))
        store_write.write_parquet(
            self._raw_table(metric_rows, metric_columns),
            os.path.join(folder, "tracemetrics.parquet"))

        store_paths.write_json(os.path.join(folder, "chain.json"), {
            "game": game,
            "accounts": [
                {"account": "fake-account-%d-a" % game, "sentReport": True, "attended": True},
                {"account": "fake-account-%d-b" % game, "sentReport": False, "attended": False},
            ],
        })
        store_paths.write_json(os.path.join(folder, "manifest.json"), {
            "network": "paseo", "game": game,
            "pulled_at_local": "17 Oct 2026, 06:00 CEST",
            "data_as_of_local": "17 Oct 2026, 06:00 CEST",
            "late_complete": game == 2, "api_calls": 100 + game,
            "minutes": 1.25, "pass": True,
        })

    def test_views_union_games_with_drifting_columns(self):
        con = store.connect(self.root)
        try:
            rows = con.execute(
                'SELECT _game, id, "journey.outcome" FROM spans ORDER BY _game, id').fetchall()
        finally:
            con.close()
        self.assertEqual(rows, [
            (1, "join-1", None), (1, "signup-1", None),
            (2, "join-2", None), (2, "signup-2", "registered"),
        ])

    def test_game_and_network_from_path(self):
        con = store.connect(self.root)
        try:
            got = con.execute("SELECT DISTINCT _network, _game FROM spans ORDER BY _game").fetchall()
        finally:
            con.close()
        self.assertEqual(got, [("paseo", 1), ("paseo", 2)])

    def test_hidden_folders_not_read(self):
        hidden = os.path.join(self.root, "paseo", ".tmp-g3-10-20")
        os.makedirs(hidden)
        table = self._raw_table([{
            "id": "hidden", "timestamp": "2026-10-16T10:00:00Z",
            "span.op": "journey.join", "game.index": "3", "user.id": "hidden",
            "__store_project": "jollity-next", "__store_part": "window",
        }], [(name, "string") for name in (
            "id", "timestamp", "span.op", "game.index", "user.id")])
        store_write.write_parquet(table, os.path.join(hidden, "spans.parquet"))
        con = store.connect(self.root)
        try:
            got = con.execute("SELECT count(*), max(_game) FROM spans").fetchone()
        finally:
            con.close()
        self.assertEqual(got, (4, 2))

    def test_dataset_without_files_gets_no_view_and_no_error(self):
        sql = store.views_sql(self.root)
        self.assertIn("-- no files for attachments", sql)
        con = store.connect(self.root)
        try:
            tables = {row[0] for row in con.execute(
                "SELECT table_name FROM information_schema.tables").fetchall()}
        finally:
            con.close()
        self.assertNotIn("attachments", tables)
        self.assertIn("spans", tables)

    def test_chain_and_accounts_views(self):
        con = store.connect(self.root)
        try:
            chains = con.execute("SELECT _network, _game, game FROM chain ORDER BY _game").fetchall()
            accounts = con.execute(
                "SELECT _game, account, sentReport, attended FROM accounts ORDER BY _game, account"
            ).fetchall()
        finally:
            con.close()
        self.assertEqual(chains, [("paseo", 1, 1), ("paseo", 2, 2)])
        self.assertEqual(accounts[0], (1, "fake-account-1-a", True, True))
        self.assertEqual(len(accounts), 4)

    def test_as_num_parses_strings(self):
        con = store.connect(self.root)
        try:
            got = con.execute(
                "SELECT as_num('12.5'), as_num('no'), as_bool('TRUE'), as_bool('x'), "
                "as_ts('2026-10-17T04:00:00Z') IS NOT NULL").fetchone()
        finally:
            con.close()
        self.assertEqual(got, (12.5, None, True, None, True))

    def test_write_views_is_rebuildable_sql_not_a_database(self):
        path = store.write_views(self.root)
        self.assertEqual(path, os.path.join(self.root, "views.sql"))
        with open(path, encoding="utf-8") as fh:
            first = fh.read()
        self.assertEqual(first, store.views_sql(self.root))
        self.assertIn("CREATE OR REPLACE VIEW spans", first)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("broken\n")
        self.assertEqual(store.write_views(self.root), path)
        with open(path, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), first)
        self.assertFalse(os.path.exists(os.path.join(self.root, "views.duckdb")))

    def test_games_and_manifest(self):
        self.assertEqual(store.manifest(2, root=self.root)["game"], 2)
        self.assertEqual(store.games(self.root), [
            {"network": "paseo", "game": 1,
             "pulled_at_local": "17 Oct 2026, 06:00 CEST",
             "data_as_of_local": "17 Oct 2026, 06:00 CEST",
             "late_complete": False, "pass": True},
            {"network": "paseo", "game": 2,
             "pulled_at_local": "17 Oct 2026, 06:00 CEST",
             "data_as_of_local": "17 Oct 2026, 06:00 CEST",
             "late_complete": True, "pass": True},
        ])

    def test_example_queries_run(self):
        con = store.connect(self.root)
        try:
            results = [con.execute(query).fetchall() for query in EXAMPLE_QUERIES]
        finally:
            con.close()
        self.assertEqual([len(rows) for rows in results], [2, 2, 2, 2, 2])
        self.assertEqual(results[0][0], (1, 1, 100.0, 0.0, 0.0))
        self.assertEqual(results[2][0], (1, 2, 1, 1, 1))


if __name__ == "__main__":
    unittest.main()
