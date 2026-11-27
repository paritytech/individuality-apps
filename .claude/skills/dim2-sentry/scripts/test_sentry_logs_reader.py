# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

import importlib.util
import json
import os
import unittest
from unittest.mock import patch


HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "fixtures", "logs-g999.json")
GOLDEN = os.path.join(HERE, "fixtures", "logs-task6-golden.json")

import sentry_logs


def load_pull():
    spec = importlib.util.spec_from_file_location("game_report_pull_dual_read", os.path.join(HERE, "game-report-pull.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_links():
    spec = importlib.util.spec_from_file_location("game_links_game821", os.path.join(HERE, "game-links.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def rows():
    with open(FIXTURE, encoding="utf-8") as fh:
        return json.load(fh)


class SentryLogReaderTests(unittest.TestCase):
    def test_event_rows_restore_every_known_title_to_the_exact_legacy_shape(self):
        titles = ["telemetry.health", "signup-broadcast", "camera-trail", "chain.health",
                  "previous-session-end", "storage-slow", "camera-unavailable: denied"]
        rows = [{
            "timestamp": f"2026-10-16T10:00:0{i}Z", "message": title + "\tignored detail", "severity": "warn",
            "user.id": "5Alice", "session.id": "session-2", "game.index": "254", "previous.game": "254", "failure.kind": "camera-unavailable" if i == 6 else None,
            "failure.reason": "denied" if i == 6 else None,
            "tags[telemetry.health_late,boolean]": True if i == 0 else None,
            "tags[telemetry_health.failed_429,number]": 3 if i == 0 else None,
            "tags[telemetry_health.session.retries,number]": 2 if i == 0 else None,
            "telemetry_health.rate_limit_last": "quota" if i == 0 else None,
        } for i, title in enumerate(titles)]
        found = sentry_logs.event_rows("5Alice", "start", "end", game="254", _events_all=lambda *a, **k: rows)
        self.assertEqual([row["title"] for row in found], titles)
        self.assertEqual(found[0], {
            "timestamp": "2026-10-16T10:00:00Z", "title": "telemetry.health", "level": "warning",
            "session.id": "session-2", "previous.game": "254",
            "failure": None, "telemetryHealth": {"failed_429": 3, "rate_limit_last": "quota", "session": {"retries": 2}},
            "telemetryHealthLate": True, "exception": [],
        })
        self.assertEqual(found[-1]["failure"], {"kind": "camera-unavailable", "reason": "denied"})
        self.assertEqual(set(found[-1]), {"timestamp", "title", "level", "session.id", "previous.game", "failure", "telemetryHealth",
                                         "telemetryHealthLate", "exception"})

    def test_event_rows_query_uses_typed_number_fields_and_excludes_game_logs(self):
        calls = []
        sentry_logs.event_rows("5Alice", "start", "end", _events_all=lambda *a, **k: calls.append((a, k)) or [])
        args, kwargs = calls[0]
        self.assertEqual(args[0], "logs")
        self.assertIn("user.id:5Alice", args[1])
        self.assertIn("!has:game_log.item", args[1])
        self.assertIn("severity", args[2])
        self.assertIn("session.id", args[2])
        self.assertIn("previous.game", args[2])
        self.assertIn("tags[telemetry_health.failed_429,number]", args[2])
        self.assertIn("tags[telemetry_health.session.failed_429,number]", args[2])
        self.assertIn("tags[telemetry.health_late,boolean]", args[2])
        self.assertIn("timestamp_precise", args[2])
        self.assertEqual((kwargs["start"], kwargs["end"], kwargs["per_page"]), ("start", "end", 1000))

    def test_event_union_dedupes_legacy_and_logs_by_title_timestamp_and_user(self):
        duplicate = {"timestamp": "2026-10-16T10:00:00Z", "title": "storage-slow", "level": "warn",
                     "failure": None, "telemetryHealth": None, "telemetryHealthLate": False, "exception": []}
        distinct = {**duplicate, "title": "chain.health"}
        self.assertEqual(sentry_logs.merge_event_rows([duplicate], [dict(duplicate), distinct], "5Alice"),
                         [duplicate, distinct])
        self.assertEqual(sentry_logs.merge_event_rows([duplicate, dict(duplicate)], [], "5Alice"),
                         [duplicate, duplicate])

    def test_event_rows_keep_real_same_second_logs_but_dedupe_retries_by_id(self):
        base = {"timestamp": "2026-10-16T10:00:00Z", "timestamp_precise": "2026-10-16T10:00:00.123Z",
                "message": "storage-slow", "severity": "warn"}
        rows = [{**base, "id": "a"}, {**base, "id": "b", "timestamp_precise": "2026-10-16T10:00:00.456Z"},
                {**base, "id": "a"}, {**base, "id": "c"}]
        found = sentry_logs.event_rows("5Alice", "start", "end", _events_all=lambda *a, **k: rows)
        self.assertEqual(len(found), 2)
        self.assertTrue(all(row["level"] == "warning" for row in found))

    def test_chain_health_keeps_its_error_attribute(self):
        # pb#76's text rides chain.health.error, not the message (g268 10:37 CEST was pulled as a bare "chain.health")
        rows = [{"id": "a", "timestamp": "2026-10-22T08:37:00Z", "message": "chain.health", "severity": "warn",
                 "chain.health.error": 'RpcError: HostFailure: remote_chain_head_call: unknown follow subscription id "c1:host:2"'}]
        found = sentry_logs.event_rows("5Alice", "start", "end", _events_all=lambda *a, **k: rows)
        self.assertIn("unknown follow subscription id", found[0]["chainHealthError"])

    def test_event_union_normalizes_timestamp_forms_before_cross_source_dedupe(self):
        legacy = {"timestamp": "2026-10-16T10:00:00+00:00", "title": "storage-slow", "level": "warning"}
        log = {"timestamp": "2026-10-16T10:00:00Z", "title": "storage-slow", "level": "warning"}
        self.assertEqual(sentry_logs.merge_event_rows([legacy], [log], "5Alice"), [legacy])

    def test_untagged_event_before_registration_is_dropped(self):
        rows = [{"id": "a", "timestamp": "2026-10-16T09:59:59Z", "message": "storage-slow", "severity": "warn"},
                {"id": "b", "timestamp": "2026-10-16T10:00:00Z", "message": "storage-slow", "severity": "warn"}]
        found = sentry_logs.event_rows("5Alice", "start", "end", game="254", untagged_from="2026-10-16T10:00:00",
                                       _events_all=lambda *a, **k: rows)
        self.assertEqual([row["timestamp"] for row in found], ["2026-10-16T10:00:00Z"])

    def test_chat_metric_rows_normalize_worker_counter_and_preserve_groups_and_user_name(self):
        calls = []
        raw = [{"metric.name": "chat.notif.permission", "user.id": "5Alice", "user.name": "alice.01",
                "outcome": "granted", "sum(value)": 2}]
        found = sentry_logs.chat_metric_rows("metric.name:chat.notif.permission", ["outcome"], "start", "end",
                                              _events_all=lambda *a, **k: calls.append((a, k)) or raw)
        self.assertEqual(found, [{"user.id": "5Alice", "user.name": "alice.01", "name": "chat.notif.permission",
                                  "outcome": "granted", "count()": 2, "first": None, "last": None}])
        self.assertIn("sentry.sdk.name:jollity.chat-worker", calls[0][0][1])
        self.assertEqual(calls[0][0][0], "tracemetrics")

    def test_chat_metric_rows_can_use_the_checked_metric_group_reader(self):
        calls = []
        def checked(query, fields, start, end):
            calls.append((query, fields, start, end))
            return [{"user.id": "5Alice", "metric.name": "chat.start", "sum(value)": 1}]
        found = sentry_logs.chat_metric_rows("metric.name:chat.*", [], "start", "end", _metric_groups=checked)
        self.assertEqual(found[0]["count()"], 1)
        self.assertEqual(calls[0][2:], ("start", "end"))
        self.assertIn("count(value)", calls[0][1])

    def test_parse_body_round_trips_escapes_and_splits_on_first_tab(self):
        body = (
            "2026-10-16T09:59:59.001Z warn alpha\\ttag: first\\nline\\rwith \\\\ slash"
            "\t{\"text\":\"left\\\\tright\\\\nagain\"}"
        )
        self.assertEqual(sentry_logs.parse_body(body, "session-a"), [{
            "ts": 1792144799001,
            "sessionId": "session-a",
            "level": "warn",
            "tag": "alpha\ttag",
            "message": "first\nline\rwith \\ slash",
            "data": {"text": "left\tright\nagain"},
        }])

    def test_parse_body_preserves_json_looking_string_data_as_a_string(self):
        for data in ("123", "true"):
            parsed = sentry_logs.parse_body(f"2026-10-16T09:59:59.001Z info data: value\t{data}", "session-a")
            self.assertEqual(parsed[0]["data"], data)

    def test_game_821_mesh_record_restores_object_data_for_game_links(self):
        # Retained from /tmp/jollity-telemetry-acceptance-g821. The Logs reader
        # left this payload as text, so game-links.py crashed on data.get().
        room = (
            "g821:5Df9pmcJ2aKg56mdQNq3hNi2tZxVmGiaVK5PxvUn6k6MJLhP_"
            "5E4AuXD91G7fBgX1KLLswYwDSjnTTeiraSN3QxfLT1FrjNpL_"
            "5F2HruQJB6YZTH9CtyJMiZSdGYf79LvZrcXzooT4f3wYeXAj_"
            "5FLbRzf9YW3cH4Zws1oKzCJYALjzqXKFdBiktXixZ5mveEdM_"
            "5GbmiBSj7Lmn8YDfRuiwSGZVoKkvV5UKnEBeQvEeUdx543wo_"
            "5HiXq1QiQLW8ckbn8EgXBKY3cuaRQEXjAmEN3Qwd1xBAcekH"
        )
        data = json.dumps({
            "room": room,
            "self": "5Df9pmcJ2aKg56mdQNq3hNi2tZxVmGiaVK5PxvUn6k6MJLhP",
            "peers": [
                "5HiXq1QiQLW8ckbn8EgXBKY3cuaRQEXjAmEN3Qwd1xBAcekH",
                "5FLbRzf9YW3cH4Zws1oKzCJYALjzqXKFdBiktXixZ5mveEdM",
                "5F2HruQJB6YZTH9CtyJMiZSdGYf79LvZrcXzooT4f3wYeXAj",
                "5E4AuXD91G7fBgX1KLLswYwDSjnTTeiraSN3QxfLT1FrjNpL",
                "5GbmiBSj7Lmn8YDfRuiwSGZVoKkvV5UKnEBeQvEeUdx543wo",
            ],
            "iceServers": 9,
        }, separators=(",", ":"))
        [entry] = sentry_logs.parse_body(
            f"2026-10-17T16:39:10.778Z info rtc: mesh open\t{data}",
            "2d7c74c0-c782-42e7-866a-dd678c9b12ce",
        )
        self.assertEqual(load_links().mesh_opens([entry]), [{"ts": 1792255150778, "room": room}])

    def test_log_rows_requests_the_complete_contract_through_shared_pages(self):
        seen = []

        def events_all(*args, **kwargs):
            seen.append((args, kwargs))
            return [{"id": "log-default"}]

        with patch.object(sentry_logs.sentry, "events_all", side_effect=events_all):
            self.assertEqual(sentry_logs.log_rows(999, "2026-10-16T10:00:00", "2026-10-16T11:00:00"),
                             [{"id": "log-default"}])
        args, kwargs = seen.pop()
        self.assertEqual(args[0], "logs")
        self.assertEqual(kwargs["per_page"], 1000)
        self.assertLess(kwargs["start"], "2026-10-16T10:00:00")

        def pages(*args, **kwargs):
            seen.append((args, kwargs))
            yield [[{"id": "log-1"}][0]]

        with patch.object(sentry_logs.sentry, "pages", side_effect=pages):
            self.assertEqual(sentry_logs.log_rows(999, "2026-10-16T10:00:00", "2026-10-16T11:00:00", pids=["pid-1"]),
                             [{"id": "log-1"}])
        args, kwargs = seen[0]
        self.assertEqual(args[0], "logs")
        self.assertEqual(kwargs["pids"], ["pid-1"])
        self.assertEqual(kwargs["per_page"], 1000)
        self.assertIn("timestamp", sentry_logs.LOG_FIELDS)
        self.assertEqual(kwargs["sort"], "-timestamp")
        self.assertIn(kwargs["sort"].lstrip("-"), sentry_logs.LOG_FIELDS)
        self.assertIn(sentry_logs.OBSERVED_FIELD, sentry_logs.LOG_FIELDS)
        self.assertIn(sentry_logs.CAPTURED_FIELD, sentry_logs.LOG_FIELDS)
        self.assertEqual(set(sentry_logs.LOG_FIELDS), {
            "id", "timestamp", "message", "user.id", "session.id", "game.index", "game_log.stage",
            "game_log.item", "game_log.record", "game_log.records", "game_log.checkpoint", "game_log.seq",
            "game_log.part", "game_log.parts", "game_log.copy", "game_log.full_stage", "game_log.begin",
            "app.version", "test.tag", "tags[game_log.first_ts_ms,number]",
            "sentry.observed_timestamp_nanos", "tags[game_log.captured_ms,number]",
        })

    def test_log_request_exposes_the_exact_packed_log_scope(self):
        query, start = sentry_logs.log_request(999, "2026-10-16T10:00:00Z")
        self.assertEqual(query, "game.index:999 has:game_log.item")
        self.assertEqual(start, "2026-10-15T22:00:00")

    def test_observed_ingest_and_checkpoint_capture_times_are_kept_separate(self):
        row = next(item for item in rows() if item["id"] == "chunk-a-r0") | {
            sentry_logs.OBSERVED_FIELD: "1792144800800848036",
            sentry_logs.CAPTURED_FIELD: 1792144798123,
            "game_log.records": "1",
        }
        chunk = sentry_logs.records_to_items([row])["5Alice"]["chunks"][0]
        self.assertEqual(chunk["_receivedAt"], 1792144800800)
        self.assertEqual(chunk["capturedAt"], 1792144798123)

    def test_records_dedupe_on_item_and_record_and_report_missing_indexes(self):
        items = sentry_logs.records_to_items(rows())
        alice = items["5Alice"]
        self.assertEqual(len(alice["chunks"]), 1)
        self.assertEqual(len(alice["chunks"][0]["lines"]), 1)
        self.assertEqual(items["5Gap"]["missing"], [("gap-item", 1)])

    def test_stable_line_ids_dedupe_chunk_and_recovery_copies(self):
        chunk = {**rows()[0], "game_log.records": "1",
                 "message": rows()[0]["message"].replace("alpha: one", "[stable-line] alpha: one")}
        recovery = {**chunk, "id": "recovery-r0", "game_log.item": "recovery-item",
                    "game_log.stage": "full", "game_log.copy": "copy-recovery",
                    "game_log.part": "0", "game_log.parts": "1",
                    "message": chunk["message"].replace("alpha: one", "alpha: one [scrubbed]")}
        shaped = sentry_logs.legacy_shape(sentry_logs.records_to_items([chunk, recovery]))
        self.assertEqual(len(shaped["5Alice"]["entries"]), 1)
        self.assertNotIn("_deliveryId", shaped["5Alice"]["entries"][0])

    def test_distinct_capture_ids_keep_genuine_same_millisecond_repeats(self):
        chunk = {**rows()[0], "game_log.records": "1",
                 "message": "2026-10-16T10:00:00.000Z info [g843:1] clock: same\n"
                            "2026-10-16T10:00:00.000Z info [g843:2] clock: same"}
        recovery = {**chunk, "id": "recovery-r0", "game_log.item": "recovery-item",
                    "game_log.stage": "full", "game_log.copy": "copy-recovery",
                    "game_log.part": "0", "game_log.parts": "1"}
        shaped = sentry_logs.legacy_shape(sentry_logs.records_to_items([chunk, recovery]))
        self.assertEqual(len(shaped["5Alice"]["entries"]), 2)

    def test_missing_capture_id_is_still_reported_missing(self):
        original = {"ts": 1, "sessionId": "s", "level": "info", "tag": "clock",
                    "message": "same", "_deliveryId": "g843:1"}
        delivered = {**original, "_deliveryId": "g843:2"}
        merged = sentry_logs.merge_line_sources([[delivered]])
        self.assertEqual(merged, [{key: value for key, value in delivered.items()
                                  if key != "_deliveryId"}])

    def test_legacy_fallback_preserves_genuine_same_millisecond_occurrences(self):
        legacy = {"ts": 1, "sessionId": "s", "level": "info", "tag": "clock",
                  "message": "same"}
        merged = sentry_logs.merge_line_sources([[legacy, dict(legacy)], [dict(legacy)]])
        self.assertEqual(merged, [legacy, legacy])

    def test_special_lines_restore_attachment_shapes_and_leave_entries(self):
        items = sentry_logs.records_to_items(rows())
        alice = items["5Alice"]
        chunk = alice["chunks"][0]
        self.assertEqual(chunk["evictedOnDevice"], [{"id": "old-chunk", "gameIndex": 998}])
        self.assertEqual([line["tag"] for line in chunk["lines"]], ["alpha"])
        full = alice["full"]["copy-a"]["documents"][0]
        self.assertEqual(full["meta"]["username"], "alice")
        self.assertEqual(full["worker"], {"queued": 0})
        self.assertEqual(full["extras"], "kept")
        self.assertEqual(full["meta"]["evictedOnDevice"], [{"id": "old-full", "gameIndex": 997}])
        self.assertEqual([line["tag"] for line in full["entries"]], ["beta"])
        shaped = sentry_logs.legacy_shape(items)
        self.assertEqual(shaped["5Alice"]["meta"]["username"], "alice")
        self.assertEqual([line["tag"] for line in shaped["5Alice"]["entries"]], ["alpha", "beta"])

    def test_fetch_logs_with_only_legacy_attachments_is_unchanged(self):
        pull = load_pull()
        fixture_path = os.path.join(
            os.path.dirname(HERE), "..", "..", "..", "docs-internal", "game-logs", "game-159", "5GZ8jxye-a5096864.json")
        fixture_path = os.path.normpath(fixture_path)
        with open(fixture_path, "rb") as fh:
            raw = fh.read()
        body = json.loads(raw)
        uid = body["meta"]["address"]
        row = {"id": "a" * 32, "user.id": uid, "timestamp": "2026-10-16T10:00:00", "game_log.stage": "payoff"}
        attachment = {"id": "att", "name": "legacy.json", "size": len(raw)}

        def event(_row, suffix="", raw=False):
            return raw_bytes if raw else [attachment]

        raw_bytes = raw
        with patch.object(pull, "full_log_rows", return_value=([row], "late")), \
             patch.object(pull, "events_all", return_value=[]), \
             patch.object(pull.sentry_logs, "log_rows", return_value=[]), \
             patch.object(pull, "_event", side_effect=event), patch.object(pull, "WORKERS", 1):
            found, _meta = pull.fetch_logs(999, "start", "end")
        expected = pull._links().parse_log(body)[1]
        self.assertEqual(found[uid]["entries"], pull.merge_log_sources([expected["entries"]]))
        self.assertEqual(found[uid]["meta"], {
            "address": uid, "source": "full-documents", "complete": True,
        })

    def test_fetch_logs_with_logs_only_has_the_legacy_meta_entries_shape(self):
        pull = load_pull()
        with patch.object(pull, "full_log_rows", return_value=([], "late")), \
             patch.object(pull, "events_all", return_value=[]), \
             patch.object(pull.sentry_logs, "log_rows", return_value=rows()), \
             patch.object(pull, "WORKERS", 1):
            found, meta = pull.fetch_logs(999, "start", "end")
        self.assertEqual(set(found["5Alice"]), {"meta", "entries"})
        self.assertEqual(found["5Alice"]["meta"]["address"], "5Alice")
        self.assertEqual([line["tag"] for line in found["5Alice"]["entries"]], ["alpha", "beta"])
        self.assertEqual(meta["5Gap"]["missingRecords"], [("gap-item", 1)])
        self.assertEqual(meta["5Gap"]["missingSeqs"], [4])
        self.assertFalse(found["5Gap"]["meta"]["complete"])

    def test_missing_full_record_keeps_the_part_incomplete(self):
        pull = load_pull()
        partial = [row for row in rows() if row["id"].startswith("full-a-") and row["id"] != "full-a-r2"]
        with patch.object(pull, "full_log_rows", return_value=([], "late")), \
             patch.object(pull, "events_all", return_value=[]), \
             patch.object(pull.sentry_logs, "log_rows", return_value=partial), \
             patch.object(pull, "WORKERS", 1):
            found, meta = pull.fetch_logs(999, "start", "end")
        self.assertEqual(meta["5Alice"]["missingFullParts"], [{"copyId": "copy-a", "part": 0}])
        self.assertFalse(found["5Alice"]["meta"]["complete"])

    def test_fetch_logs_with_both_sources_is_the_line_union(self):
        pull = load_pull()
        uid = "5Alice"
        legacy = {"meta": {"address": uid}, "entries": [{
            "ts": 1792144700000, "sessionId": "old", "level": "info", "tag": "legacy", "message": "legacy line",
        }]}
        raw = json.dumps(legacy).encode()
        row = {"id": "b" * 32, "user.id": uid, "timestamp": "2026-10-16T10:00:00", "game_log.stage": "payoff"}
        attachment = {"id": "att", "name": "legacy.json", "size": len(raw)}

        def event(_row, suffix="", raw=False):
            return raw_bytes if raw else [attachment]

        raw_bytes = raw
        with patch.object(pull, "full_log_rows", return_value=([row], "late")), \
             patch.object(pull, "events_all", return_value=[]), \
             patch.object(pull.sentry_logs, "log_rows", return_value=rows()), \
             patch.object(pull, "_event", side_effect=event), patch.object(pull, "WORKERS", 1):
            found, _meta = pull.fetch_logs(999, "start", "end")
        self.assertEqual([line["tag"] for line in found[uid]["entries"]], ["legacy", "alpha", "beta"])

    def test_masked_logs_dedupe_with_raw_legacy_and_match_device_truth(self):
        pull = load_pull()
        uid = "5Alice"
        raw_line = {"ts": 1792144799001, "sessionId": "session-a", "level": "info",
                    "tag": "alpha", "message": "Unauthorized"}
        body = {"meta": {"address": uid}, "entries": [raw_line]}
        raw = json.dumps(body).encode()
        legacy_row = {"id": "b" * 32, "user.id": uid, "timestamp": "2026-10-16T10:00:00",
                      "game_log.stage": "payoff"}
        attachment = {"id": "att", "name": "legacy.json", "size": len(raw)}
        log_row = {**rows()[0], "game_log.records": "1",
                   "message": "2026-10-16T09:59:59.001Z info alpha: Unau*horized"}

        def event(_row, suffix="", raw=False):
            return raw_bytes if raw else [attachment]

        raw_bytes = raw
        with patch.object(pull, "full_log_rows", return_value=([legacy_row], "late")), \
             patch.object(pull, "events_all", return_value=[]), \
             patch.object(pull.sentry_logs, "log_rows", return_value=[log_row]), \
             patch.object(pull, "_event", side_effect=event), patch.object(pull, "WORKERS", 1):
            found, _meta = pull.fetch_logs(999, "start", "end")
        self.assertEqual(found[uid]["entries"], [raw_line])
        self.assertNotIn("_viaLogs", found[uid]["entries"][0])
        self.assertTrue(pull.compare_log_completeness([raw_line], found[uid]["entries"])["ok"])

    def test_fetch_logs_records_a_logs_query_failure_as_a_gap(self):
        pull = load_pull()
        uid = "5Legacy"
        body = {"meta": {"address": uid}, "entries": [{"ts": 1, "sessionId": "s", "tag": "x", "message": "y"}]}
        raw = json.dumps(body).encode()
        row = {"id": "c" * 32, "user.id": uid, "timestamp": "t", "game_log.stage": "payoff"}

        def event(_row, suffix="", raw=False):
            return raw_bytes if raw else [{"id": "att", "name": "legacy.json", "size": len(raw_bytes)}]

        raw_bytes = raw
        with patch.object(pull, "full_log_rows", return_value=([row], "late")), \
             patch.object(pull, "events_all", return_value=[]), \
             patch.object(pull.sentry_logs, "log_rows", side_effect=RuntimeError("logs unavailable")), \
             patch.object(pull, "_event", side_effect=event), patch.object(pull, "WORKERS", 1):
            _found, meta = pull.fetch_logs(999, "start", "end")
        self.assertIn({"event": None, "attachment": None, "reason": "logs query failed: logs unavailable"}, meta[uid]["downloadGaps"])

    def test_logs_only_query_failure_becomes_a_game_wide_pull_error(self):
        pull = load_pull()
        with patch.object(pull, "full_log_rows", return_value=([], "late")), \
             patch.object(pull, "events_all", return_value=[]), \
             patch.object(pull.sentry_logs, "log_rows", side_effect=RuntimeError("logs unavailable")), \
             patch.object(pull, "WORKERS", 1):
            logs, meta = pull.fetch_logs(999, "start", "end")
        with patch.object(pull, "events_all", return_value=[]), patch.object(pull, "slice_releases", return_value=[]):
            report = pull.pull(999, "start", "end", logs=logs, log_meta=meta)
        self.assertEqual(report["pullErrors"]["game logs"], "logs query failed: logs unavailable")

    def test_legacy_attachment_uses_user_id_as_the_canonical_identity(self):
        pull = load_pull()
        body = {"meta": {"address": "device-id"}, "entries": [
            {"ts": 1, "sessionId": "s", "level": "info", "tag": "x", "message": "y"}]}
        raw = json.dumps(body).encode()
        row = {"id": "d" * 32, "user.id": "5Account", "timestamp": "t", "game_log.stage": "report"}

        def event(_row, suffix="", raw=False):
            return raw_bytes if raw else [{"id": "att", "name": "legacy.json", "size": len(raw_bytes)}]

        raw_bytes = raw
        with patch.object(pull, "full_log_rows", return_value=([row], "late")), \
             patch.object(pull, "events_all", return_value=[]), patch.object(pull.sentry_logs, "log_rows", return_value=[]), \
             patch.object(pull, "_event", side_effect=event), patch.object(pull, "WORKERS", 1):
            found, meta = pull.fetch_logs(999, "start", "end")
        self.assertEqual(set(found), {"5Account"})
        self.assertFalse(meta["5Account"]["full"])
        self.assertTrue(meta["5Account"]["report"])

    def test_real_task6_writer_golden_rows_restore_exactly(self):
        with open(GOLDEN, encoding="utf-8") as fh:
            golden = json.load(fh)
        self.assertEqual(sentry_logs.legacy_shape(sentry_logs.records_to_items(golden["rows"])), golden["legacy"])


if __name__ == "__main__":
    unittest.main()
