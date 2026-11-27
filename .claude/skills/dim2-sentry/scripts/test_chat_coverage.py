# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""Tests for chat-coverage.py on fixture rows.  python3 -m unittest test_chat_coverage -v"""
import importlib.util
import os
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("chat_coverage", os.path.join(os.path.dirname(__file__), "chat-coverage.py"))
cc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cc)

IOS_U, AND_U, MIX_U, CHAT_ONLY = "5IOS", "5AND", "5MIX", "5CHAT"
IOS = {"device.os": "ios", "device.os_version": "18.7", "device.model": "iphone-6.3in", "host.app": "Polkadot App", "host.app_version": "0.10.0"}
ANDROID = {"device.os": "android", "device.os_version": "14", "device.model": "LE2123", "host.app": "Polkadot", "host.app_version": "1.0.0 (1029)"}


def app(user, ctx, count, last, dataset="errors"):
    return {"dataset": dataset, "user.id": user, **ctx, "count": count, "last": last}


def chat(user, name, count, first, last):
    return {"user.id": user, "name": name, "count": count, "first": first, "last": last}


APP = [app(IOS_U, IOS, 10, "2026-10-09T10:00:00+00:00"), app(AND_U, ANDROID, 20, 1791540000.0),
       app(MIX_U, IOS, 5, "2026-10-08T10:00:00+00:00"), app(MIX_U, ANDROID, 3, "2026-10-09T10:00:00+00:00")]
CHAT = [chat(IOS_U, "chat.start", 2, "2026-10-09T09:00:00+00:00", "2026-10-09T11:00:00+00:00"),
        chat(IOS_U, "chat.poll.failed", 1, "2026-10-09T12:00:00+00:00", "2026-10-09T12:00:00+00:00"),
        chat(CHAT_ONLY, "chat.start", 4, "2026-10-09T09:00:00+00:00", "2026-10-09T09:30:00+00:00")]


class Helpers(unittest.TestCase):
    def test_pull_includes_app_and_chat_metrics_and_logs(self):
        calls = []
        def rows(dataset, query, fields, **kw):
            calls.append((dataset, query, fields))
            return []
        with mock.patch.object(cc, "events_all", side_effect=rows), \
             mock.patch.object(cc.sentry_logs, "chat_metric_rows", return_value=[]) as metrics:
            cc.pull({"period": "7d"}, {"period": "30d"}, include_bots=False)
        app_datasets = {dataset for dataset, query, _ in calls if "has:device.os" in query and "!sdk.name:" in query}
        self.assertEqual(app_datasets, {"errors", "spans"})
        self.assertTrue(any(dataset == "logs" and f"sentry.sdk.name:{cc.CHAT_SDK}" in query for dataset, query, _ in calls))
        metrics.assert_called_once()

    def test_new_chat_query_failures_preserve_the_legacy_rows_and_record_gaps(self):
        def rows(dataset, query, fields, **kw):
            if dataset in {"logs", "tracemetrics"}:
                raise RuntimeError(dataset + " unavailable")
            if dataset == "errors" and f"sdk.name:{cc.CHAT_SDK}" in query:
                return [{"user.id": "5Legacy", "title": "chat.start", "count()": 1,
                         "min(timestamp)": "2026-10-16T10:00:00Z", "max(timestamp)": "2026-10-16T10:00:00Z"}]
            return []
        with mock.patch.object(cc, "events_all", side_effect=rows), \
             mock.patch.object(cc.sentry_logs, "chat_metric_rows", side_effect=RuntimeError("metrics unavailable")):
            _app, _ctx, chat, _bots, gaps = cc.pull({"period": "7d"}, {"period": "30d"}, include_bots=False)
        self.assertEqual([row["name"] for row in chat], ["chat.start"])
        self.assertEqual(set(gaps), {"chat logs", "chat metrics"})

    def test_metric_and_log_copy_of_one_chat_count_is_counted_once(self):
        metric = {"user.id": "5A", "name": "chat.poll", "count": 2, "first": None, "last": None, "source": "metrics"}
        log = {"user.id": "5A", "name": "chat.poll", "count": 2, "first": "a", "last": "b", "source": "logs"}
        self.assertEqual(cc.merge_new_chat_rows([metric], [log]), [{**metric, "first": "a", "last": "b"}])

    def test_legacy_only_shape_keeps_the_two_original_app_datasets(self):
        self.assertEqual(cc.DATASETS, ["errors", "spans"])
        self.assertEqual(cc.user_rows(cc.build_users(APP, CHAT))[0]["app_counts"], {"errors": 20, "spans": 0})

    def test_platform_label(self):
        self.assertEqual(cc.platform_label(IOS), "ios · Polkadot App 0.10.0")
        self.assertEqual(cc.platform_label({"device.os": "android"}), "android")
        self.assertEqual(cc.platform_label(None), "unknown")

    def test_to_epoch(self):
        self.assertEqual(cc.to_epoch("2026-10-09T10:00:00+00:00"), cc.to_epoch("2026-10-09T10:00:00Z"))
        self.assertEqual(cc.to_epoch(5), 5.0)
        self.assertIsNone(cc.to_epoch(None))

    def test_coverage(self):
        self.assertEqual(cc.coverage(1, 4), 0.25)
        self.assertIsNone(cc.coverage(0, 0))


class Join(unittest.TestCase):
    def setUp(self):
        self.users = cc.build_users(APP, CHAT)

    def test_ios_user_has_both(self):
        u = self.users[IOS_U]
        self.assertEqual((u["platform"], u["app_counts"]["errors"], u["chat_events"]), ("ios · Polkadot App 0.10.0", 10, 3))
        self.assertEqual(u["last_chat_name"], "chat.poll.failed")
        self.assertEqual(dict(u["chat_names"]), {"chat.start": 2, "chat.poll.failed": 1})

    def test_android_app_only(self):
        u = self.users[AND_U]
        self.assertEqual((u["has_app"], u["chat_events"]), (True, 0))

    def test_mixed_os(self):
        u = self.users[MIX_U]
        self.assertEqual(u["platform"], "mixed")
        self.assertEqual(sorted(u["oses"]), ["android", "ios"])
        self.assertEqual(u["ctx"]["device.os"], "android")  # the most recent row

    def test_chat_only_user(self):
        u = self.users[CHAT_ONLY]
        self.assertEqual((u["platform"], u["has_app"], u["chat_events"]), (cc.CHAT_ONLY, False, 4))

    def test_rows_without_device_os_are_not_app_events(self):
        users = cc.build_users([app("5X", {"device.os": None}, 9, None)], [])
        self.assertEqual(users, {})


class Tables(unittest.TestCase):
    def setUp(self):
        self.users = cc.build_users(APP, CHAT)

    def test_platform_rows(self):
        rows = {r["platform"]: r for r in cc.platform_rows(self.users)}
        ios = rows["ios · Polkadot App 0.10.0"]
        self.assertEqual((ios["users_app"], ios["users_chat"], ios["coverage"], ios["per_chat_user"]), (1, 1, 1.0, 3.0))
        android = rows["android · Polkadot 1.0.0 (1029)"]
        self.assertEqual((android["users_app"], android["users_chat"], android["coverage"], android["per_chat_user"]), (1, 0, 0.0, None))
        self.assertEqual(rows["mixed"]["coverage"], 0.0)
        self.assertEqual((rows[cc.CHAT_ONLY]["users_app"], rows[cc.CHAT_ONLY]["users_chat"], rows[cc.CHAT_ONLY]["coverage"]), (0, 1, None))
        self.assertEqual(cc.platform_rows(self.users)[-1]["platform"] in (cc.CHAT_ONLY, "mixed"), True)

    def test_user_rows_flag_no_chat_first(self):
        rows = cc.user_rows(self.users)
        self.assertEqual([r["user"] for r in rows if r["no_chat"]], [AND_U, MIX_U])
        self.assertTrue(rows[0]["no_chat"] and rows[1]["no_chat"])
        self.assertFalse({r["user"]: r for r in rows}[CHAT_ONLY]["no_chat"])  # chat only: nothing to flag

    def test_bots_dropped_from_chat_side(self):
        users = cc.build_users(APP, CHAT, bots={CHAT_ONLY})
        self.assertNotIn(CHAT_ONLY, users)
        self.assertIn(CHAT_ONLY, cc.build_users(APP, CHAT))
        self.assertEqual(cc.bot_ids([{"user.id": "b1"}, {"user.id": None}]), {"b1"})

    def test_undated_row_never_replaces_dated(self):
        rows = [app("5U", IOS, 1, "2026-10-09T10:00:00+00:00"), app("5U", ANDROID, 1, None, "metrics")]
        self.assertEqual(cc.build_users(rows, [])["5U"]["ctx"]["device.os"], "ios")
        rows = [app("5V", ANDROID, 1, None, "metrics"), app("5V", IOS, 1, None, "metrics"), app("5V", IOS, 1, "2026-10-09T10:00:00Z")]
        self.assertEqual(cc.build_users(rows, [])["5V"]["ctx"]["device.os"], "ios")
        rows = [app("5W", ANDROID, 1, None, "metrics"), app("5W", IOS, 1, None, "metrics")]
        self.assertEqual(cc.build_users(rows, [])["5W"]["ctx"]["device.os"], "android")  # the first undated one stays

    def test_chat_spans_count_toward_coverage(self):
        users = cc.build_users([app("5S", ANDROID, 3, None, "spans")], [chat("5S", "chat.poll.duration_ms", 4, 1791540000.0, 1791540100.0)])
        self.assertEqual(users["5S"]["chat_events"], 4)
        self.assertEqual(cc.platform_rows(users)[0]["coverage"], 1.0)
        self.assertEqual(users["5S"]["app_counts"]["spans"], 3)

    def test_spans_epoch_is_seconds(self):
        self.assertEqual(cc.to_epoch(1791540000.0), 1791540000.0)

    def test_windows(self):
        self.assertEqual(cc.windows(14, None, None, 30), ({"period": "14d"}, {"period": "30d"}))
        self.assertEqual(cc.windows(45, None, None, 30)[1], {"period": "45d"})
        w, c = cc.windows(7, "2026-10-10T00:00:00", "2026-10-11T00:00:00", 30)
        self.assertEqual((w["start"], c["start"], c["end"]), ("2026-10-10T00:00:00", "2026-09-11T00:00:00", "2026-10-11T00:00:00"))

    def test_headless_host_is_a_bot(self):
        headless = {**IOS, "host.app": "Headless Signing Host", "host.app_version": "0.24.0"}
        rows = [app("5H", headless, 5, "2026-10-09T10:00:00Z")]
        chat_rows = [chat("5H", "chat.start", 1, 1791540000.0, 1791540000.0)]
        self.assertNotIn("5H", cc.build_users(rows, chat_rows))
        self.assertIn("5H", cc.build_users(rows, chat_rows, include_bots=True))
        self.assertIn(IOS_U, cc.build_users(APP + rows, CHAT))

    def test_chat_only_label(self):
        self.assertEqual(cc.build_users([], CHAT)[CHAT_ONLY]["platform"], "chat only (no app use)")

    def test_context_rows_label_but_are_not_app_activity(self):
        ctx = [app("5OLD", ANDROID, 99, "2026-09-20T10:00:00Z")]
        users = cc.build_users([], [chat("5OLD", "chat.start", 1, 1791540000.0, 1791540000.0)], context_rows=ctx)
        self.assertEqual((users["5OLD"]["platform"], users["5OLD"]["has_app"]), ("android · Polkadot 1.0.0 (1029)", False))
        # app use only in the wider window: no app user, no NO CHAT flag, no denominator
        users = cc.build_users([], [], context_rows=ctx)
        self.assertFalse(users["5OLD"]["has_app"])
        self.assertEqual(cc.platform_rows(users)[0]["users_app"], 0)
        self.assertFalse(cc.user_rows(users)[0]["no_chat"])
        # the same user active inside the window does count
        users = cc.build_users([app("5OLD", ANDROID, 3, "2026-10-09T10:00:00Z")], [], context_rows=ctx)
        self.assertEqual((users["5OLD"]["has_app"], users["5OLD"]["app_counts"]["errors"]), (True, 3))

    def test_bot_with_app_and_chat_rows_absent_from_both(self):
        users = cc.build_users(APP, CHAT, bots={IOS_U}, context_rows=[app(IOS_U, IOS, 1, None)])
        self.assertNotIn(IOS_U, users)
        self.assertIn(IOS_U, cc.build_users(APP, CHAT, bots={IOS_U}, include_bots=True))


if __name__ == "__main__":
    unittest.main()
