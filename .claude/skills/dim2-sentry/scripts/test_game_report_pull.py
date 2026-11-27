# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

import importlib.util
import json
import os
import tempfile
import unittest
from unittest.mock import patch


HERE = os.path.dirname(os.path.abspath(__file__))
PAGE_LIVES_FIXTURE = os.path.join(HERE, "fixtures", "page-lives-g259-g835.json")
SPEC = importlib.util.spec_from_file_location("game_report_pull", os.path.join(HERE, "game-report-pull.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

with open(PAGE_LIVES_FIXTURE, encoding="utf-8") as fh:
    PAGE_LIVES = json.load(fh)


class FullLogPullTests(unittest.TestCase):
    def test_previous_session_ends_without_a_user_are_linked_by_current_session(self):
        evidence = PAGE_LIVES["game259"]
        acct, roots, page_ends = evidence["account"], evidence["roots"], evidence["errors"]
        unrelated = {**page_ends[0], "id": "other-game", "previous.game": "258"}

        queries = []
        page_sizes = []
        detail_calls = []

        def pages(dataset, query, fields, sort=None, per_page=100, **_kwargs):
            queries.append((dataset, query))
            page_sizes.append((dataset, query, per_page))
            if dataset == "spans" and query == "game.index:259":
                return [{"user.id": acct, "count()": 3}]
            if dataset == "errors" and query == "title:previous-session-end":
                return [*page_ends, unrelated]
            if dataset == "spans" and query == f"is_transaction:true user.id:{acct}":
                return roots
            return []

        def event_detail(row):
            detail_calls.append(row["id"])
            return evidence["details"][row["id"]]

        with patch.object(MODULE, "events_all", side_effect=pages), \
             patch.object(MODULE, "_events", return_value=[]), \
             patch.object(MODULE.sentry, "events", return_value=[]), \
             patch.object(MODULE, "_event", side_effect=event_detail), \
             patch.object(MODULE.sentry_logs, "event_rows", return_value=[]), \
             patch.object(MODULE, "slice_releases", return_value=[]), \
             patch.object(MODULE, "coverage_metrics", return_value=([], None)), \
             patch.object(MODULE, "WORKERS", 1):
            out = MODULE.pull(259, "2026-10-16T13:45:00", "2026-10-16T14:30:00")

        found = out["players"][acct]["pageEnds"]
        self.assertEqual([row["id"] for row in found], [row["id"] for row in page_ends])
        self.assertEqual(found[0]["previous.session.session_id"], "e56208355e814c4c8d154db9aab29dec")
        self.assertEqual(found[0]["previous.session.gap_ms"], 61)
        self.assertEqual(found[1]["previous.session.open_journeys"], "join")
        self.assertEqual(found[1]["previous.session.open_journey_steps"], "join:chain.read")
        self.assertEqual(detail_calls, [row["id"] for row in page_ends])
        self.assertEqual(queries.count(("errors", "title:previous-session-end")), 1)
        self.assertEqual(queries.count(("logs", "message:previous-session-end !has:game_log.item")), 1)
        self.assertIn(("errors", "title:previous-session-end", 100), page_sizes)
        self.assertIn(("logs", "message:previous-session-end !has:game_log.item", 1000), page_sizes)

    def test_complete_legacy_page_end_does_not_fetch_detail(self):
        acct = "5Complete"
        row = {
            "id": "complete", "timestamp": "2026-10-16T14:05:26+00:00", "session.id": "current",
            "previous.end": "host-reload", "previous.game": "259", "previous.turn": "1",
            "previous.session.session_id": "previous", "previous.session.gap_ms": 61,
            "previous.session.game_index": "259", "previous.session.open_journeys": "game",
            "previous.session.open_journey_steps": "game:round.1",
        }

        def pages(dataset, query, fields, sort=None, per_page=100, **_kwargs):
            if dataset == "spans" and query == "game.index:259":
                return [{"user.id": acct, "count()": 1}]
            if dataset == "errors" and query == "title:previous-session-end":
                return [row]
            if dataset == "spans" and query == f"is_transaction:true user.id:{acct}":
                return [{"id": "root", "timestamp": row["timestamp"], "session.id": "current",
                         "span.op": "journey.app-open", "host.kind": "ios"}]
            return []

        with patch.object(MODULE, "events_all", side_effect=pages), \
             patch.object(MODULE, "_events", return_value=[]), \
             patch.object(MODULE.sentry, "events", return_value=[]), \
             patch.object(MODULE, "_event", side_effect=AssertionError("must not fetch complete page end")), \
             patch.object(MODULE.sentry_logs, "event_rows", return_value=[]), \
             patch.object(MODULE, "slice_releases", return_value=[]), \
             patch.object(MODULE, "coverage_metrics", return_value=([], None)), \
             patch.object(MODULE, "WORKERS", 1):
            out = MODULE.pull(259, "2026-10-16T13:45:00", "2026-10-16T14:30:00")

        self.assertEqual(out["players"][acct]["pageEnds"][0]["id"], "complete")

    def test_legacy_page_end_detail_failure_is_recorded_in_pull_errors(self):
        acct = "5Failure"
        row = {"id": "failed-detail", "project": "jollity-next",
               "timestamp": "2026-10-16T14:05:26+00:00", "session.id": "current",
               "previous.end": "host-reload", "previous.game": "259", "previous.turn": "1"}

        def pages(dataset, query, fields, sort=None, per_page=100, **_kwargs):
            if dataset == "spans" and query == "game.index:259":
                return [{"user.id": acct, "count()": 1}]
            if dataset == "errors" and query == "title:previous-session-end":
                return [row]
            if dataset == "spans" and query == f"is_transaction:true user.id:{acct}":
                return [{"id": "root", "timestamp": row["timestamp"], "session.id": "current",
                         "span.op": "journey.app-open", "host.kind": "ios"}]
            return []

        with patch.object(MODULE, "events_all", side_effect=pages), \
             patch.object(MODULE, "_events", return_value=[]), \
             patch.object(MODULE.sentry, "events", return_value=[]), \
             patch.object(MODULE, "_event", side_effect=RuntimeError("HTTP 503 detail unavailable")), \
             patch.object(MODULE.sentry_logs, "event_rows", return_value=[]), \
             patch.object(MODULE, "slice_releases", return_value=[]), \
             patch.object(MODULE, "coverage_metrics", return_value=([], None)), \
             patch.object(MODULE, "WORKERS", 1):
            out = MODULE.pull(259, "2026-10-16T13:45:00", "2026-10-16T14:30:00")

        self.assertEqual(out["players"][acct]["pageEnds"][0]["id"], "failed-detail")
        self.assertEqual(out["pullErrors"]["previous-session-end detail failed-detail"],
                         "HTTP 503 detail unavailable")

    def test_post_905_logs_only_page_end_preserves_typed_attributes(self):
        acct = "5Game835"
        row = PAGE_LIVES["game835Logs"][0]
        roots = [
            {"id": "old", "timestamp": "2026-10-17T21:20:00+00:00", "session.id": "old-session",
             "span.op": "journey.game", "game.index": "835", "host.kind": "ios"},
            {"id": "current", "timestamp": row["timestamp"], "session.id": row["session.id"],
             "span.op": "journey.app-open", "host.kind": "ios"},
        ]

        def pages(dataset, query, fields, sort=None, per_page=100, **_kwargs):
            if dataset == "spans" and query == "game.index:835":
                return [{"user.id": acct, "count()": 2}]
            if dataset == "logs" and query == "message:previous-session-end !has:game_log.item":
                return [row]
            if dataset == "spans" and query == f"is_transaction:true user.id:{acct}":
                return roots
            return []

        with patch.object(MODULE, "events_all", side_effect=pages), \
             patch.object(MODULE, "_events", return_value=[]), \
             patch.object(MODULE.sentry, "events", return_value=[]), \
             patch.object(MODULE.sentry_logs, "event_rows", return_value=[]), \
             patch.object(MODULE, "slice_releases", return_value=[]), \
             patch.object(MODULE, "coverage_metrics", return_value=([], None)), \
             patch.object(MODULE, "WORKERS", 1):
            out = MODULE.pull(835, "2026-10-17T21:00:00", "2026-10-17T21:30:00")

        [found] = out["players"][acct]["pageEnds"]
        self.assertIs(found["previous.in_game"], True)
        self.assertEqual(found["previous.session.gap_ms"], 8027)
        self.assertEqual(found["previous.session.open_journeys"], "home-first-status,game")

    def test_error_and_log_copies_dedupe_by_sessions_not_event_id(self):
        log = MODULE.previous_session_ends([PAGE_LIVES["game835Logs"][0]], "logs")[0]
        error = {**log, "id": "different-error-id", "timestamp": log["timestamp"].replace("+00:00", "Z")}
        self.assertEqual(MODULE.merge_previous_session_ends([error], [log]), [error])

        no_previous = {key: value for key, value in log.items() if key != "previous.session.session_id"}
        timestamp_copy = {**no_previous, "id": "different-timestamp-id",
                          "timestamp": "2026-10-17T21:21:47.900000+00:00"}
        self.assertEqual(MODULE.merge_previous_session_ends([no_previous], [timestamp_copy]), [no_previous])

        mixed_copy = {**log, "id": "different-mixed-id",
                      "timestamp": "2026-10-17T21:21:47.400000+00:00"}
        self.assertEqual(MODULE.merge_previous_session_ends([no_previous], [mixed_copy]), [no_previous])
        self.assertEqual(no_previous["previous.session.session_id"], log["previous.session.session_id"])

    def test_legacy_previous_session_error_keeps_identity_when_its_log_copy_dedupes(self):
        acct = "5Acct"
        legacy = {"id": "legacy", "timestamp": "2026-10-15T10:00:00", "title": "previous-session-end",
                  "level": "info", "game.index": "254"}

        def pages(dataset, query, fields, sort=None, per_page=100, **_kwargs):
            if dataset == "spans" and query.startswith("game.index:"):
                return [{"user.id": acct, "count()": 1}]
            if dataset == "errors" and query.startswith("user.id:"):
                return [legacy]
            return []

        detail = {"tags": [{"key": "session.id", "value": "session-2"},
                            {"key": "previous.game", "value": "254"}],
                  "contexts": {"failure": {"kind": "unclean-exit", "reason": "in-game"}}, "entries": []}
        log_copy = {"timestamp": legacy["timestamp"], "title": legacy["title"], "level": "info",
                    "session.id": "session-2", "previous.game": "254", "failure": detail["contexts"]["failure"],
                    "telemetryHealth": {}, "telemetryHealthLate": False, "exception": []}
        with patch.object(MODULE, "events_all", side_effect=pages), \
             patch.object(MODULE, "_events", return_value=[]), \
             patch.object(MODULE.sentry, "events", return_value=[]), \
             patch.object(MODULE, "_event", return_value=detail), \
             patch.object(MODULE.sentry_logs, "event_rows", return_value=[log_copy]), \
             patch.object(MODULE, "slice_releases", return_value=[]), \
             patch.object(MODULE, "coverage_metrics", return_value=([], None)), \
             patch.object(MODULE, "WORKERS", 1):
            out = MODULE.pull(254, "2026-10-15T09:00:00", "2026-10-15T12:00:00")

        self.assertEqual(out["players"][acct]["events"], [{
            "timestamp": legacy["timestamp"], "title": legacy["title"], "level": "info",
            "session.id": "session-2", "previous.game": "254", "failure": detail["contexts"]["failure"],
            "telemetryHealth": None, "telemetryHealthLate": False, "exception": [],
        }])

    def test_merge_logs_normalizes_both_raw_and_delivered_keys_and_keeps_raw_text(self):
        legacy = {"ts": 1, "sessionId": "s", "tag": "http", "message": "Unauthorized"}
        delivered_log = {**legacy, "message": "Unau*horized"}
        self.assertEqual(
            MODULE.merge_log_sources([[legacy]], log_sources=[[delivered_log]]),
            [legacy],
        )
        self.assertEqual(MODULE.merge_log_sources([[legacy], [delivered_log]]), [legacy])

    def test_fetch_logs_without_cache_downloads_even_when_file_exists(self):
        row = {"id": "aaaaaaaa11111111", "user.id": "5Acct", "timestamp": "t",
               "game_log.stage": "payoff"}
        fresh = json.dumps({"meta": {"address": "5Acct"},
                            "entries": [{"ts": 2, "message": "fresh"}]}).encode()
        calls = []

        def event(_row, suffix="", raw=False):
            calls.append((suffix, raw))
            if suffix == "attachments/":
                return [{"id": "att-1", "name": "log.json", "size": len(fresh)}]
            return fresh

        with tempfile.TemporaryDirectory() as logs_dir:
            with open(os.path.join(logs_dir, "old-aaaaaaaa.json"), "w", encoding="utf-8") as fh:
                json.dump({"meta": {"address": "5Acct"},
                           "entries": [{"ts": 1, "message": "cached"}]}, fh)
            with patch.object(MODULE, "full_log_rows", return_value=([row], "late")), \
                 patch.object(MODULE, "events_all", return_value=[]), \
                 patch.object(MODULE, "_event", side_effect=event), \
                 patch.object(MODULE, "WORKERS", 1):
                logs, _meta = MODULE.fetch_logs(
                    259, "start", "end", logs_dir, use_cache=False)

        self.assertEqual(logs["5Acct"]["entries"][0]["message"], "fresh")
        self.assertIn(("attachments/att-1/?download=1", True), calls)

    def test_adaptations_do_not_change_the_existing_query_grouping(self):
        self.assertEqual(MODULE.STEP_FIELDS, ["id", "timestamp", "transaction", "span.op", "span.duration", "rtc.path", "rtc.outcome", "camera.state", "camera.reason", "user.username", "signup.route"])
        self.assertEqual(MODULE.METRIC_FIELDS, ["metric.name", "stat", "scene", "moment", "round", "rtc.peer", "rtc.path", "reason", "rtc.signal_peer_present", "p50(value)", "max(value)", "min(value)", "count(value)", "sum(value)", "lowpower", "lowpower.reason", "probe", "probe.version", "probe.threshold_ms", "probe.sample", "probe.rule", "probe.borderline_from_ms", "probe.weak_from_ms", "probe.stage", "probe.attempts"])

    def test_parts_preserve_identical_line_occurrences(self):
        duplicate = {"ts": 1, "sessionId": "s", "tag": "t", "message": "same"}
        self.assertEqual(
            MODULE.assemble_full_parts({1: [duplicate], 0: [duplicate]}),
            [duplicate, duplicate],
        )

    def test_full_rows_use_paginated_query_and_seven_day_late_window(self):
        rows = [{"id": str(index), "game_log.stage": "payoff"} for index in range(240)]
        with patch.object(MODULE, "events_all", return_value=rows) as query:
            found, late_end = MODULE.full_log_rows(
                251,
                ["id", "game_log.stage"],
                "2026-10-06T14:00:00",
                "2026-10-06T15:00:00",
            )
        self.assertEqual(len(found), 240)
        self.assertEqual(late_end, "2026-10-13T15:00:00")
        self.assertEqual(query.call_args.kwargs["per_page"], 100)
        self.assertEqual(query.call_args.kwargs["end"], late_end)

    def test_failed_game_log_download_is_recorded_as_a_gap(self):
        row = {
            "id": "aaaaaaaa11111111",
            "project": "jollity-next",
            "user.id": "5Acct",
            "timestamp": "2026-10-15T10:00:00",
            "received": "2026-10-15T10:00:01",
            "game_log.stage": "payoff",
        }
        attachment = {"id": "att-1", "name": "game-log.json", "size": 100}

        def event(_row, suffix="", raw=False):
            return b"" if raw else [attachment]

        with tempfile.TemporaryDirectory() as logs_dir, \
             patch.object(MODULE, "full_log_rows", return_value=([row], "2026-10-22T12:00:00")), \
             patch.object(MODULE, "events_all", return_value=[]), \
             patch.object(MODULE, "_event", side_effect=event), \
             patch.object(MODULE, "WORKERS", 1):
            logs, meta = MODULE.fetch_logs(259, "2026-10-15T09:00:00", "2026-10-15T12:00:00", logs_dir)

        self.assertEqual(logs, {})
        self.assertEqual(meta["5Acct"]["downloadGaps"], [{
            "event": "aaaaaaaa11111111",
            "attachment": "att-1",
            "reason": "attachment download returned no data",
        }])
        self.assertFalse(meta["5Acct"]["full"])

    def test_failed_attachment_listing_is_recorded_as_a_gap(self):
        row = {
            "id": "aaaaaaaa11111111",
            "project": "jollity-next",
            "user.id": "5Acct",
            "timestamp": "2026-10-15T10:00:00",
            "game_log.stage": "payoff",
        }
        with patch.object(MODULE, "full_log_rows", return_value=([row], "2026-10-22T12:00:00")), \
             patch.object(MODULE, "events_all", return_value=[]), \
             patch.object(MODULE, "_event", side_effect=TimeoutError("timed out")), \
             patch.object(MODULE, "WORKERS", 1):
            logs, meta = MODULE.fetch_logs(259, "2026-10-15T09:00:00", "2026-10-15T12:00:00")

        self.assertEqual(logs, {})
        self.assertFalse(meta["5Acct"]["full"])
        self.assertEqual(meta["5Acct"]["downloadGaps"], [{
            "event": "aaaaaaaa11111111",
            "attachment": None,
            "reason": "attachment listing failed: timed out",
        }])

    def test_empty_attachment_listing_is_recorded_as_a_gap(self):
        row = {
            "id": "aaaaaaaa11111111",
            "project": "jollity-next",
            "user.id": "5Acct",
            "timestamp": "2026-10-15T10:00:00",
            "game_log.stage": "payoff",
        }
        with patch.object(MODULE, "full_log_rows", return_value=([row], "2026-10-22T12:00:00")), \
             patch.object(MODULE, "events_all", return_value=[]), \
             patch.object(MODULE, "_event", return_value=[]), \
             patch.object(MODULE, "WORKERS", 1):
            logs, meta = MODULE.fetch_logs(259, "2026-10-15T09:00:00", "2026-10-15T12:00:00")

        self.assertEqual(logs, {})
        self.assertFalse(meta["5Acct"]["full"])
        self.assertEqual(meta["5Acct"]["downloadGaps"], [{
            "event": "aaaaaaaa11111111",
            "attachment": None,
            "reason": "attachment listing failed: returned no data",
        }])

    def test_one_successful_copy_suppresses_other_copy_download_gaps(self):
        failed = {
            "id": "aaaaaaaa11111111", "project": "jollity-next", "user.id": "5Acct",
            "timestamp": "2026-10-15T10:00:00", "game_log.stage": "payoff",
        }
        succeeded = {**failed, "id": "bbbbbbbb22222222", "timestamp": "2026-10-15T10:01:00"}
        attachment = {"id": "att-1", "name": "game-log.json", "size": 100}
        good_body = {"meta": {"address": "5Acct"}, "entries": [{"ts": 1}]}

        def event(row, suffix="", raw=False):
            if not raw:
                return [attachment]
            return b"" if row["id"].startswith("a") else json.dumps(good_body).encode()

        class Links:
            @staticmethod
            def parse_log(body):
                return body["meta"]["address"], {"entries": body["entries"]}

        with patch.object(MODULE, "full_log_rows", return_value=([failed, succeeded], "2026-10-22T12:00:00")), \
             patch.object(MODULE, "events_all", return_value=[]), \
             patch.object(MODULE, "_event", side_effect=event), \
             patch.object(MODULE, "_links", return_value=Links()), \
             patch.object(MODULE, "WORKERS", 1):
            logs, meta = MODULE.fetch_logs(259, "2026-10-15T09:00:00", "2026-10-15T12:00:00")

        self.assertIn("5Acct", logs)
        self.assertNotIn("downloadGaps", meta["5Acct"])

    def test_successful_chunk_does_not_suppress_failed_full_log_gap(self):
        full = {
            "id": "aaaaaaaa11111111", "project": "jollity-next", "user.id": "5Acct",
            "timestamp": "2026-10-15T10:00:00", "game_log.stage": "payoff",
        }
        chunk = {
            **full, "id": "bbbbbbbb22222222", "timestamp": "2026-10-15T10:01:00",
            "game_log.stage": "chunk",
        }
        attachment = {"id": "att-1", "name": "game-log.json", "size": 100}
        chunk_body = {
            "id": "chunk:5Acct:s1:0:0", "account": "5Acct", "seq": 0, "part": 0,
            "lines": [{"ts": 1, "sessionId": "s1", "tag": "test", "message": "arrived"}],
        }

        def event(row, suffix="", raw=False):
            if not raw:
                return [attachment]
            return b"" if row["id"].startswith("a") else json.dumps(chunk_body).encode()

        with patch.object(MODULE, "full_log_rows", return_value=([full], "2026-10-22T12:00:00")), \
             patch.object(MODULE, "events_all", return_value=[chunk]), \
             patch.object(MODULE, "_event", side_effect=event), \
             patch.object(MODULE, "WORKERS", 1):
            logs, meta = MODULE.fetch_logs(259, "2026-10-15T09:00:00", "2026-10-15T12:00:00")

        self.assertEqual(logs["5Acct"]["meta"]["source"], "chunks")
        self.assertEqual(meta["5Acct"]["downloadGaps"], [{
            "event": "aaaaaaaa11111111",
            "attachment": "att-1",
            "reason": "attachment download returned no data",
        }])

    def test_complete_report_copy_is_not_the_complete_game_log(self):
        report = {"parts": 2, "arrived": {0, 1}, "stage": "report"}
        payoff = {"parts": 2, "arrived": {0}, "stage": "payoff"}
        self.assertFalse(MODULE.has_complete_nonreport_copy({"report": report, "payoff": payoff}))
        payoff["arrived"].add(1)
        self.assertTrue(MODULE.has_complete_nonreport_copy({"report": report, "payoff": payoff}))

    def test_per_player_queries_read_every_page(self):
        """Game 254: a one-page query capped every player at 200 metric rows and 100 roots."""
        acct = "5Acct"

        def all_pages(dataset, query, fields, sort=None, per_page=100, **kw):
            if dataset == "spans" and query.startswith("game.index:"):
                return [{"user.id": acct, "count()": 1}]
            if dataset == "spans" and query.startswith("is_transaction:true"):
                return [{"id": f"r{i}", "timestamp": "2026-10-15T10:00:00", "session.id": "s1", "game.index": "254"} for i in range(150)]
            if dataset == "errors" and query.startswith("user.id:"):
                return [{"id": f"e{i}", "timestamp": "2026-10-15T10:00:00", "title": "x", "level": "info", "game.index": "254"} for i in range(130)]
            if dataset == "tracemetrics":
                return [{"id": f"m{i}", "timestamp": f"2026-10-15T10:{i // 60:02d}:{i % 60:02d}",
                         "metric.name": "rtc.in_fps", "stat": "p50", "round": i,
                         "value": 24.0} for i in range(450)]
            return []

        def counts(dataset, query, fields, **kw):
            return [{"count(value)": 450}] if dataset == "tracemetrics" else []

        with patch.object(MODULE, "events_all", side_effect=all_pages), \
             patch.object(MODULE, "_events", return_value=[]) as one_page, patch.object(MODULE.sentry, "events", side_effect=counts), \
             patch.object(MODULE, "_event", return_value={}), \
             patch.object(MODULE, "slice_releases", return_value=[]), \
             patch.object(MODULE, "coverage_metrics", return_value=([], None)), \
             patch.object(MODULE, "WORKERS", 1):
            out = MODULE.pull(254, "2026-10-15T09:00:00", "2026-10-15T12:00:00")
        player = out["players"][acct]
        self.assertEqual(len(player["roots"]), 150)
        self.assertEqual(len(player["events"]), 130)
        self.assertEqual(len(player["metrics"]), 450)
        # the pairing, encoder-kind and ladder rows come from queries of their own, never from the metrics query's grouping
        self.assertEqual((len(player["linkPairs"]), len(player["linkKinds"])), (450, 450))
        self.assertIn("rtc.pair", MODULE.LINK_PAIR_FIELDS)
        self.assertNotIn("rtc.pair", MODULE.METRIC_FIELDS)
        # one page only where the newest row is wanted on purpose
        self.assertTrue(all(call.args[0] == "transactions" for call in one_page.call_args_list))

    def test_foreground_points_reach_a_player_by_user_or_by_a_session_without_one(self):
        acct = "5Acct"
        points = [{"metric.name": "app.opened_from_notification", "timestamp": "2026-10-15T10:00:00", "session.id": "s1"},
                  {"metric.name": "app.away_ms", "timestamp": "2026-10-15T10:05:00", "session.id": "s9", "user.id": acct, "value": 4000.0},
                  {"metric.name": "app.away_ms", "timestamp": "2026-10-15T10:06:00", "session.id": "s1", "user.id": "5Other"},
                  {"metric.name": "app.away_ms", "timestamp": "2026-10-15T10:07:00", "user.id": acct, "game.index": "253"},
                  {"metric.name": "app.opened_from_notification", "timestamp": "2026-10-15T10:08:00", "session.id": "s7"}]

        def pages(dataset, query, fields, sort=None, per_page=100, **kw):
            if dataset == "spans" and query.startswith("game.index:"):
                return [{"user.id": acct, "count()": 1}]
            if dataset == "spans" and query.startswith("is_transaction:true"):
                return [{"id": "r", "timestamp": "2026-10-15T10:00:00", "session.id": "s1", "game.index": "254"}]
            if dataset == "tracemetrics" and query == "metric.name:[app.opened_from_notification,app.away_ms]":
                self.assertEqual(fields, MODULE.FOREGROUND_FIELDS)
                return points
            return []

        def counts(dataset, query, fields, **kw):
            return [{"count(value)": len(points)}] if query.startswith("metric.name:[app.opened") else []

        with patch.object(MODULE, "events_all", side_effect=pages), patch.object(MODULE, "_events", return_value=[]), \
             patch.object(MODULE.sentry, "events", side_effect=counts), patch.object(MODULE, "_event", return_value={}), \
             patch.object(MODULE, "slice_releases", return_value=[]), \
             patch.object(MODULE, "coverage_metrics", return_value=([], None)), patch.object(MODULE, "WORKERS", 1):
            out = MODULE.pull(254, "2026-10-15T09:00:00", "2026-10-15T12:00:00")

        self.assertEqual(out["players"][acct]["foreground"], points[:2])
        self.assertEqual(out["pullErrors"], {})

    def test_a_short_foreground_query_is_a_gap_and_leaves_the_players_without_it(self):
        acct = "5Acct"

        def pages(dataset, query, fields, sort=None, per_page=100, **kw):
            if dataset == "spans" and query.startswith("game.index:"):
                return [{"user.id": acct, "count()": 1}]
            if dataset == "tracemetrics" and query.startswith("metric.name:[app.opened"):
                return [{"metric.name": "app.away_ms", "timestamp": "2026-10-15T10:05:00", "user.id": acct}]
            return []

        def counts(dataset, query, fields, **kw):
            return [{"count(value)": 2}] if query.startswith("metric.name:[app.opened") else []

        with patch.object(MODULE, "events_all", side_effect=pages) as paged, patch.object(MODULE, "_events", return_value=[]), \
             patch.object(MODULE.sentry, "events", side_effect=counts), patch.object(MODULE, "_event", return_value={}), \
             patch.object(MODULE, "slice_releases", return_value=[]), \
             patch.object(MODULE, "coverage_metrics", return_value=([], None)), patch.object(MODULE, "WORKERS", 1):
            out = MODULE.pull(254, "2026-10-15T09:00:00", "2026-10-15T12:00:00")

        self.assertIn("1 of 2 foreground points", out["pullErrors"]["foreground"])
        self.assertNotIn("foreground", out["players"][acct])
        self.assertEqual(sum(1 for call in paged.call_args_list if call.args[1].startswith("metric.name:[app.opened")), 2)

    def test_paged_queries_sort_stably(self):
        self.assertEqual(MODULE.stable_sort(["metric.name", "round", "count(value)"]), ["metric.name", "round"])
        self.assertEqual(MODULE.stable_sort(["metric.name", "round", "count(value)"], "round"), ["round", "metric.name"])
        self.assertEqual(MODULE.stable_sort(["id", "timestamp", "span.op"], "timestamp"), ["timestamp", "id"])
        self.assertEqual(MODULE.stable_sort(["id", "timestamp"], "-timestamp"), ["-timestamp", "id"])
        self.assertEqual(MODULE.stable_sort(["timestamp", "span.op"]), ["timestamp"])

    def test_a_failing_query_is_recorded_per_player_and_the_pull_goes_on(self):
        acct = "5Acct"

        def pages(dataset, query, fields, sort=None, per_page=100, **kw):
            self.assertIsNotNone(sort)  # every paged query sorts
            if dataset == "spans" and query.startswith("game.index:"):
                return [{"user.id": acct, "count()": 1}]
            if dataset == "errors" and query.startswith("game.index:"):
                raise RuntimeError("HTTP 500")
            if dataset == "spans" and query.startswith("is_transaction:true"):
                return [{"id": "r", "timestamp": "2026-10-15T10:00:00", "session.id": "s1", "game.index": "254"}]
            if dataset == "tracemetrics" and "metric.name:rtc.link" in query:
                raise RuntimeError("HTTP 400")
            return []

        with patch.object(MODULE, "events_all", side_effect=pages), patch.object(MODULE, "_events", return_value=[]), patch.object(MODULE.sentry, "events", return_value=[]), \
             patch.object(MODULE, "_event", return_value={}), patch.object(MODULE, "slice_releases", return_value=[]), \
             patch.object(MODULE, "coverage_metrics", return_value=([], None)), patch.object(MODULE, "WORKERS", 1):
            out = MODULE.pull(254, "2026-10-15T09:00:00", "2026-10-15T12:00:00", extra_accounts=[acct],
                              log_meta={acct: {"downloadGaps": [{"reason": "timed out"}]}})
        self.assertEqual(set(out["pullErrors"]), {"tagged accounts"})
        self.assertEqual(set(out["players"][acct]["queryErrors"]), {"game-log download", "hardware or software coding"})
        self.assertEqual(out["players"][acct]["queryErrors"]["game-log download"], "timed out")
        self.assertEqual(len(out["players"][acct]["roots"]), 1)

    def test_out_of_store_from_a_player_query_fails_the_pull_closed(self):
        acct = "5Acct"
        def pages(dataset, query, fields, sort=None, per_page=100, **kw):
            if query.startswith("game.index:"):
                return []
            if dataset == "spans" and query.startswith("is_transaction:true"):
                raise MODULE.sentry.OutOfStore("store cannot serve journeys")
            return []
        with patch.object(MODULE, "events_all", side_effect=pages), \
             patch.object(MODULE, "WORKERS", 1):
            with self.assertRaisesRegex(MODULE.sentry.OutOfStore, "cannot serve journeys"):
                MODULE.pull(254, "2026-10-15T09:00:00", "2026-10-15T12:00:00",
                            extra_accounts=[acct])

    def test_source_out_of_store_bubbles_through_the_pull(self):
        class RefusingSource:
            def rows(self, *_args, **_kwargs):
                raise MODULE.sentry.OutOfStore("synthetic store refusal")

        with patch.object(MODULE.sentry, "SOURCE", RefusingSource()), patch.object(MODULE, "WORKERS", 1):
            with self.assertRaisesRegex(MODULE.sentry.OutOfStore, "synthetic store refusal"):
                MODULE.pull(254, "2026-10-15T09:00:00", "2026-10-15T12:00:00")

    def test_log_attachment_out_of_store_failures_are_not_recorded_as_gaps(self):
        row = {"id": "aaaaaaaa11111111", "project": "jollity-next", "user.id": "5Acct",
               "timestamp": "2026-10-15T10:00:00", "game_log.stage": "payoff"}
        for failure in ("listing", "download"):
            def event(_row, suffix="", raw=False):
                if failure == "listing" or raw:
                    raise MODULE.sentry.OutOfStore("store cannot serve " + failure)
                return [{"id": "att-1", "name": "game-log.json", "size": 1}]
            with self.subTest(failure=failure), \
                 patch.object(MODULE, "full_log_rows", return_value=([row], "late")), \
                 patch.object(MODULE, "events_all", return_value=[]), \
                 patch.object(MODULE, "_event", side_effect=event), \
                 patch.object(MODULE, "WORKERS", 1), \
                 self.assertRaisesRegex(MODULE.sentry.OutOfStore, "store cannot serve"):
                MODULE.fetch_logs(254, "start", "end")

    def test_metric_groups_check_their_points_and_raise_on_a_shortfall(self):
        rows = [
            {"id": f"m{index}", "timestamp": f"t{index}",
             "metric.name": "a" if index < 2 else "b", "value": float(index)}
            for index in range(5)
        ]
        with patch.object(MODULE.sentry, "events", return_value=[{"count(value)": 5}]), patch.object(MODULE, "events_all", return_value=rows) as q:
            self.assertEqual(MODULE.metric_groups("x", ["metric.name", "count(value)"], "s", "e"), [
                {"metric.name": "a", "count(value)": 2.0},
                {"metric.name": "b", "count(value)": 3.0},
            ])
        self.assertEqual(q.call_args.kwargs["per_page"], MODULE.METRIC_PAGE)
        with patch.object(MODULE.sentry, "events", return_value=[{"count(value)": 6}]), patch.object(MODULE, "events_all", return_value=rows) as q:
            with self.assertRaises(RuntimeError):
                MODULE.metric_groups("x", ["metric.name", "count(value)"], "s", "e")
        self.assertEqual(q.call_count, 2)

    def test_metric_groups_treat_a_missing_count_as_zero(self):
        rows = [{"id": "m1", "timestamp": "t1", "metric.name": "a", "value": 2.0}]
        with patch.object(MODULE.sentry, "events", return_value=[]), patch.object(MODULE, "events_all", return_value=rows):
            with self.assertRaises(RuntimeError):
                MODULE.metric_groups("x", ["metric.name", "count(value)"], "s", "e")
        with patch.object(MODULE.sentry, "events", return_value=[]), patch.object(MODULE, "events_all", return_value=[]):
            self.assertEqual(MODULE.metric_groups("x", ["metric.name", "count(value)"], "s", "e"), [])

    def test_local_metric_groups_fetch_raw_points_stably_and_use_shared_aggregate(self):
        fields = ["metric.name", "round", "p50(value)", "count(value)"]
        raw = [{"id": "m1", "timestamp": "t", "metric.name": "fps",
                "round": "1", "value": 3.0}]
        grouped = [{"metric.name": "fps", "round": "1", "p50(value)": 3.0,
                    "count(value)": 1.0}]
        with patch.object(MODULE.sentry, "events", return_value=[{"count(value)": 1}]), \
             patch.object(MODULE, "events_all", return_value=raw) as query, \
             patch.object(MODULE.agg, "aggregate", return_value=grouped) as aggregate:
            self.assertEqual(MODULE.local_metric_groups("scope", fields, "s", "e"), grouped)
        self.assertEqual(query.call_args.args[:3], (
            "tracemetrics", "scope", ["metric.name", "round", "value", "id", "timestamp"]))
        self.assertEqual(query.call_args.args[3], ["timestamp", "id"])
        aggregate.assert_called_once_with(raw, ["metric.name", "round"],
                                          ["p50(value)", "count(value)"])

    def test_local_metric_groups_retries_a_dropped_page_then_raises(self):
        fields = ["metric.name", "count(value)"]
        complete = [
            {"id": f"m{index}", "timestamp": f"t{index}", "metric.name": "fps",
             "value": float(index)}
            for index in range(5)
        ]
        with patch.object(MODULE.sentry, "events", return_value=[{"count(value)": 5}]), \
             patch.object(MODULE, "events_all", side_effect=[complete[:-1], complete]) as query:
            self.assertEqual(MODULE.local_metric_groups("scope", fields, "s", "e"), [
                {"metric.name": "fps", "count(value)": 5.0},
            ])
        self.assertEqual(query.call_count, 2)
        with patch.object(MODULE.sentry, "events", return_value=[{"count(value)": 5}]), \
             patch.object(MODULE, "events_all", return_value=complete[:-1]) as query, \
             self.assertRaisesRegex(RuntimeError, "4 of 5 metric points"):
            MODULE.local_metric_groups("scope", fields, "s", "e")
        self.assertEqual(query.call_count, 2)

    def test_slice_releases_use_one_checked_grouped_query_not_raw_points(self):
        with patch.object(MODULE, "grouped_metric_groups", return_value=[{"release": "r2", "count(value)": 1}, {"release": "r1", "count(value)": 3}]) as q, \
             patch.object(MODULE, "local_metric_groups") as raw:
            self.assertEqual(MODULE.slice_releases("2026-10-15T12:08:00"), ["r1", "r2"])
        self.assertIn("rtc.video_ms", q.call_args.args[0])
        self.assertEqual(q.call_args.args[1], ["release", "count(value)"])
        raw.assert_not_called()

    def test_grouped_release_query_retries_when_group_counts_are_short(self):
        rows = [{"release": "r1", "count(value)": 2.0},
                {"release": "r2", "count(value)": 3.0}]
        with patch.object(MODULE.sentry, "events", return_value=[{"count(value)": 5}]), \
             patch.object(MODULE, "events_all", return_value=rows) as query:
            self.assertEqual(MODULE.grouped_metric_groups(
                "scope", ["release", "count(value)"], "s", "e"), rows)
        self.assertEqual(query.call_count, 1)
        with patch.object(MODULE.sentry, "events", return_value=[{"count(value)": 6}]), \
             patch.object(MODULE, "events_all", return_value=rows) as query, \
             self.assertRaisesRegex(RuntimeError, "5 of 6 metric points"):
            MODULE.grouped_metric_groups(
                "scope", ["release", "count(value)"], "s", "e")
        self.assertEqual(query.call_count, 2)

    def test_coverage_reason_text_unchanged(self):
        """coverage_metrics reads error.code, so the real events_all must re-raise the original HTTPError, not a
        wrapper. This goes through the real paging (a faked _open), so it guards the T2 refactor."""
        import urllib.error
        from unittest import mock

        def _opener(url, params=None):
            raise urllib.error.HTTPError(url, 400, "HTTP 400", {}, None)

        with patch.object(MODULE.sentry, "events", return_value=[]), patch.object(MODULE.sentry, "_open", _opener), \
             patch.object(MODULE.sentry.time, "sleep"):
            rows, reason = MODULE.coverage_metrics(["s1"], 254, "2026-10-15T09:00:00", "2026-10-15T12:00:00")
        self.assertEqual(rows, [])
        self.assertEqual(reason, "coverage query failed (HTTP 400)")


if __name__ == "__main__":
    unittest.main()
