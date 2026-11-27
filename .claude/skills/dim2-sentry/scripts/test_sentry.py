# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""Tests for sentry.py's project choice (plan D8: test traffic lives in dim2-testing)."""
import importlib.util, json, os, subprocess, sys, unittest, urllib.error
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sentry  # noqa: E402

PROD, TEST = "4512177451237456", "4512256244777040"


def imported_with(env_value):
    """PROJECT and PID of a fresh import under DIM2_SENTRY_PROJECT=env_value."""
    env = {k: v for k, v in os.environ.items() if k != "DIM2_SENTRY_PROJECT"}
    if env_value is not None:
        env["DIM2_SENTRY_PROJECT"] = env_value
    out = subprocess.run([sys.executable, "-c", "import json, sentry; print(json.dumps([sentry.PROJECT, sentry.PID]))"],
                         cwd=HERE, env=env, capture_output=True, text=True)
    return out.returncode, out.stdout, out.stderr


class ProjectChoice(unittest.TestCase):
    def tearDown(self):
        sentry.use_source(None)
        sentry.use_project("jollity-next")

    def test_default_is_production(self):
        code, out, _ = imported_with(None)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), ["jollity-next", "4512177451237456"])

    def test_env_dim2_testing_reads_both_projects_from_import(self):
        env = {k: v for k, v in os.environ.items() if k != "DIM2_SENTRY_PROJECT"}
        env["DIM2_SENTRY_PROJECT"] = "dim2-testing"
        out = subprocess.run([sys.executable, "-c", "import json, sentry; print(json.dumps([sentry.PROJECT, sentry.PIDS]))"],
                             cwd=HERE, env=env, capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout), ["dim2-testing", [TEST, PROD]])

    def test_unknown_project_is_refused(self):
        code, _, err = imported_with("nope")
        self.assertNotEqual(code, 0)
        self.assertIn("unknown Sentry project", err)
        with self.assertRaises(SystemExit):
            sentry.use_project("dim2-testing,nope")

    def test_explicit_production_reads_production_alone(self):
        sentry.use_project("jollity-next")
        self.assertEqual(sentry.PIDS, [PROD])
        self.assertEqual(sentry.event_projects(), ["jollity-next"])

    def test_a_comma_list_names_the_projects_outright(self):
        sentry.use_project("jollity-next, dim2-testing")
        self.assertEqual(sentry.PROJECT_SLUGS, ["jollity-next", "dim2-testing"])
        sentry.use_project("dim2-testing,jollity-next")
        self.assertEqual(sentry.PIDS, [TEST, PROD])

    def query(self, data):
        seen = {}
        original = sentry.get
        sentry.get = lambda url, params=None, raw=False: seen.update(params or {}) or {"data": data}
        try:
            rows = sentry.events("errors", "x", ["id"])
        finally:
            sentry.get = original
        return seen, rows

    def test_a_test_read_queries_both_projects_and_dedupes_rows(self):
        sentry.use_project("dim2-testing")
        seen, rows = self.query([{"id": "a", "project": "dim2-testing"}, {"id": "b", "project": "jollity-next"},
                                 {"id": "a", "project": "dim2-testing"}, {"count()": 3}])
        self.assertEqual(seen["project"], [TEST, PROD])
        self.assertEqual(rows, [{"id": "a", "project": "dim2-testing"}, {"id": "b", "project": "jollity-next"}, {"count()": 3}])

    def test_a_production_read_queries_one_project(self):
        seen, _ = self.query([])
        self.assertEqual(seen["project"], [PROD])

    def test_events_all_dedupes_across_pages(self):
        sentry.use_project("dim2-testing")

        class Resp:
            def __init__(self, body, link):
                self.body, self.headers = body, {"Link": link}
            def read(self):
                return json.dumps(self.body).encode()
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False
        pages = [Resp({"data": [{"id": "a"}, {"id": "b"}]}, '<https://x/next>; rel="next"; results="true"'),
                 Resp({"data": [{"id": "b"}, {"id": "c"}]}, "")]
        seen = []
        original = sentry._open
        sentry._open = lambda url, params=None: seen.append(params) or pages.pop(0)
        try:
            rows = sentry.events_all("errors", "x", ["id"])
        finally:
            sentry._open = original
        self.assertEqual([r["id"] for r in rows], ["a", "b", "c"])
        self.assertEqual(seen[0]["project"], [TEST, PROD])

    def test_events_all_retries_a_server_error_and_sorts_stably(self):
        import urllib.error
        from unittest import mock

        class Resp:
            headers = {"Link": ""}
            def read(self):
                return json.dumps({"data": [{"user.id": "a", "count()": 1}]}).encode()
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False
        calls = []

        def answer(url, params=None):
            calls.append(params)
            if len(calls) == 1:
                raise urllib.error.HTTPError(url, 502, "bad gateway", {}, None)
            return Resp()
        original = sentry._open
        sentry._open = answer
        try:
            with mock.patch.object(sentry.time, "sleep"):
                rows = sentry.events_all("spans", "x", ["user.id", "count()"])
        finally:
            sentry._open = original
        self.assertEqual(rows, [{"user.id": "a", "count()": 1}])
        self.assertEqual(calls[-1]["sort"], ["user.id"])

    def test_an_event_is_fetched_from_its_own_project(self):
        sentry.use_project("dim2-testing")
        asked = []

        def fetch(url, raw=False):
            asked.append(url)
            return {"id": "e"} if "/jollity-next/" in url else {}
        self.assertEqual(sentry.event_get("e", row={"id": "e", "project": "jollity-next"}, fetch=fetch), {"id": "e"})
        self.assertEqual(asked, ["/projects/paritytech/jollity-next/events/e/"])
        asked.clear()
        # without the row's project: every project being read, first answer wins
        self.assertEqual(sentry.event_get("e", "attachments/", fetch=fetch), {"id": "e"})
        self.assertEqual(asked, ["/projects/paritytech/dim2-testing/events/e/attachments/",
                                 "/projects/paritytech/jollity-next/events/e/attachments/"])

    def test_the_pull_reads_a_game_log_from_the_project_its_row_names(self):
        sentry.use_project("dim2-testing")
        spec = importlib.util.spec_from_file_location("game_report_pull_t", os.path.join(HERE, "game-report-pull.py"))
        pull = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(pull)
        asked = []
        pull.get = lambda url, params=None, raw=False: asked.append(url) or {"ok": 1}
        self.assertEqual(pull._event({"id": "e1", "project": "jollity-next"}, "attachments/"), {"ok": 1})
        self.assertEqual(asked, ["/projects/paritytech/jollity-next/events/e1/attachments/"])

    def test_source_seam_reaches_names_bound_at_import(self):
        spec = importlib.util.spec_from_file_location("game_report_pull_source_t", os.path.join(HERE, "game-report-pull.py"))
        pull = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(pull)

        class Source:
            def __init__(self):
                self.calls = []

            def rows(self, *args, **kwargs):
                self.calls.append((args, kwargs))
                return [{"id": "stored"}]

        source = Source()
        sentry.use_source(source)
        with mock.patch.object(sentry, "_open", side_effect=AssertionError("network touched")):
            rows = pull.events_all("errors", "game.index:7", ["id"], ["id"], 17,
                                   None, "2026-10-01T00:00:00", "2026-10-01T01:00:00")
        self.assertEqual(rows, [{"id": "stored"}])
        self.assertEqual(source.calls, [(('errors', 'game.index:7', ['id']), {
            'sort': ['id'], 'start': '2026-10-01T00:00:00', 'end': '2026-10-01T01:00:00',
            'period': None, 'limit': None,
        })])

    def test_source_seam_routes_events_limit_and_get_without_network(self):
        class Source:
            def __init__(self):
                self.calls = []

            def rows(self, *args, **kwargs):
                self.calls.append(("rows", args, kwargs))
                return [{"count()": 1}]

            def get(self, url, raw=False):
                self.calls.append(("get", url, raw))
                return b"stored" if raw else {"stored": True}

        source = Source()
        sentry.use_source(source)
        with mock.patch.object(sentry, "_open", side_effect=AssertionError("network touched")):
            self.assertEqual(sentry.events("errors", "x:y", ["count()"], per_page=3), [{"count()": 1}])
            self.assertEqual(sentry.get("/event", params={"ignored": "by source"}, raw=True), b"stored")
        self.assertEqual(source.calls[0][2]["limit"], 3)
        self.assertEqual(source.calls[1], ("get", "/event", True))

class FakeResponse:
    """A stand-in for urllib's response: a body (JSON-encoded when it is not bytes), a Link header and a status."""
    def __init__(self, body, link="", status=200):
        self._body = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.headers, self.status = {"Link": link}, status
    def read(self):
        return self._body
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


def fake_open(*responses):
    """A _open replacement that pops the given responses; each is a FakeResponse or an exception to raise."""
    queue = list(responses)

    def _opener(url, params=None):
        item = queue.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item
    return _opener


def http_error(code, url="https://de.sentry.io/api/0/x"):
    return urllib.error.HTTPError(url, code, f"HTTP {code}", {}, None)


class Pages(unittest.TestCase):
    def tearDown(self):
        sentry.use_project("jollity-next")

    def test_pages_yields_duplicates_raw(self):
        """pages() must not dedupe: a repeated row is how P1 spots a paging bug. events_all still dedupes."""
        opener = fake_open(
            FakeResponse({"data": [{"id": "a"}, {"id": "b"}]}, '<https://x/next>; rel="next"; results="true"'),
            FakeResponse({"data": [{"id": "b"}, {"id": "c"}]}))
        with mock.patch.object(sentry, "_open", opener):
            rows = [r for page in sentry.pages("errors", "x", ["id"]) for r in page]
        self.assertEqual([r["id"] for r in rows], ["a", "b", "b", "c"])

    def test_full_project_events_follow_cursor_and_send_filters_once(self):
        seen = []
        responses = fake_open(
            FakeResponse([{"eventID": "a"}], '<https://x/next>; rel="next"; results="true"'),
            FakeResponse([{"eventID": "b"}]))

        def opener(url, params=None):
            seen.append((url, params))
            return responses(url, params)

        with mock.patch.object(sentry, "_open", opener):
            pages = list(sentry.project_event_pages(
                "jollity-next", "2026-10-01T00:00:00Z", "2026-10-01T01:00:00Z",
                "game.index:1"))
        self.assertEqual([[row["eventID"] for row in page] for page in pages], [["a"], ["b"]])
        self.assertEqual(seen[0][1], {
            "full": "true", "start": "2026-10-01T00:00:00Z",
            "end": "2026-10-01T01:00:00Z", "query": "game.index:1",
        })
        self.assertIsNone(seen[1][1])

    def test_pages_refuses_per_page_over_the_dataset_cap(self):
        with self.assertRaises(ValueError):
            list(sentry.pages("errors", "x", ["id"], per_page=101))
        with self.assertRaises(ValueError):
            list(sentry.pages("spans", "x", ["id"], per_page=1001))
        # at the cap it is allowed (the request itself is faked out)
        with mock.patch.object(sentry, "_open", fake_open(FakeResponse({"data": []}))):
            self.assertEqual(list(sentry.pages("spans", "x", ["id"], per_page=1000)), [[]])

    def test_explicit_pids_override_project(self):
        sentry.use_project("dim2-testing")
        seen = []

        def _opener(url, params=None):
            seen.append(params)
            return FakeResponse({"data": []})
        with mock.patch.object(sentry, "_open", _opener):
            list(sentry.pages("errors", "x", ["id"], pids=["1"]))
        self.assertEqual(seen[0]["project"], ["1"])

    def test_an_empty_pids_list_is_refused(self):
        """pids=[] silently meaning jollity-next is how test traffic gets read into a production dump."""
        with self.assertRaises(ValueError):
            list(sentry.pages("errors", "x", ["id"], pids=[]))


class BestEffortGet(unittest.TestCase):
    def tearDown(self):
        sentry.end_request_control()

    def test_open_sets_a_sixty_second_timeout(self):
        response = FakeResponse({"ok": True})
        with mock.patch.object(sentry, "token", return_value="fake-token"), \
             mock.patch.object(sentry.urllib.request, "urlopen", return_value=response) as urlopen:
            self.assertIs(sentry._open("https://example.test/data"), response)
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 60)

    def test_timeout_then_success_is_retried_through_request(self):
        opener = fake_open(urllib.error.URLError("timed out"), FakeResponse({"ok": True}))
        with mock.patch.object(sentry, "_open", opener), mock.patch.object(sentry.time, "sleep") as sleep:
            self.assertEqual(sentry.get("https://example.test/data"), {"ok": True})
        self.assertEqual(sleep.call_count, 1)

    def test_plain_and_socket_timeouts_are_retried_through_request(self):
        for timeout in (TimeoutError("timed out"), sentry.socket.timeout("timed out")):
            with self.subTest(timeout=type(timeout)):
                opener = fake_open(timeout, FakeResponse({"ok": True}))
                with mock.patch.object(sentry, "_open", opener), mock.patch.object(sentry.time, "sleep") as sleep:
                    self.assertEqual(sentry.get("https://example.test/data"), {"ok": True})
                self.assertEqual(sleep.call_count, 1)

    def test_server_error_then_success_is_retried_through_request(self):
        opener = fake_open(http_error(503), FakeResponse({"ok": True}))
        with mock.patch.object(sentry, "_open", opener), mock.patch.object(sentry.time, "sleep") as sleep:
            self.assertEqual(sentry.get("https://example.test/data"), {"ok": True})
        self.assertEqual(sleep.call_count, 1)

    def test_rate_limit_then_success_is_retried_through_request(self):
        opener = fake_open(http_error(429), FakeResponse({"ok": True}))
        with mock.patch.object(sentry, "_open", opener), mock.patch.object(sentry.time, "sleep") as sleep:
            self.assertEqual(sentry.get("https://example.test/data"), {"ok": True})
        self.assertEqual(sleep.call_count, 1)

    def test_shared_controller_honours_retry_after_and_records_attempts(self):
        class Clock:
            now = 0.0
            sleeps = []

            def monotonic(self):
                return self.now

            def sleep(self, delay):
                self.sleeps.append(delay)
                self.now += delay

        clock = Clock()
        sentry._REQUEST_CONTROLLER = sentry.RequestController(
            4, clock=clock.monotonic, sleeper=clock.sleep)
        limited = urllib.error.HTTPError(
            "https://example.test/data", 429, "limited", {"Retry-After": "2"}, None)
        with mock.patch.object(sentry, "_open", fake_open(limited, FakeResponse({"ok": True}))):
            self.assertEqual(sentry.get("https://example.test/data"), {"ok": True})
        stats = sentry.request_stats()
        self.assertEqual((stats["attempts"], stats["retries"], stats["rate_limited_429"]),
                         (2, 1, 1))
        self.assertEqual(clock.sleeps, [2.0])
        self.assertEqual(stats["cooldown_seconds"], 2.0)

    def test_retry_after_never_shortens_jittered_backoff(self):
        error = urllib.error.HTTPError(
            "https://example.test/data", 429, "limited", {"Retry-After": "0"}, None)
        with mock.patch.object(sentry.random, "random", return_value=0.5):
            self.assertEqual(sentry._retry_delay(error, 2), 2.0)
        past = urllib.error.HTTPError(
            "https://example.test/data", 429, "limited",
            {"Retry-After": "Thu, 01 Jan 1970 00:00:00 GMT"}, None)
        with mock.patch.object(sentry.random, "random", return_value=0.5):
            self.assertEqual(sentry._retry_delay(past, 2), 2.0)

    def test_controller_spaces_requests_at_four_per_second(self):
        class Clock:
            now = 0.0
            sleeps = []

            def monotonic(self):
                return self.now

            def sleep(self, delay):
                self.sleeps.append(delay)
                self.now += delay

        clock = Clock()
        controller = sentry.RequestController(4, clock=clock.monotonic, sleeper=clock.sleep)
        controller.before_request()
        controller.before_request()
        controller.before_request()
        self.assertEqual(clock.sleeps, [0.25, 0.25])
        self.assertEqual(controller.snapshot()["attempts"], 3)

    def test_persistent_timeouts_keep_gets_empty_contract(self):
        failures = [urllib.error.URLError("timed out")] * 16
        with mock.patch.object(sentry, "_open", fake_open(*failures)), \
             mock.patch.object(sentry.time, "sleep") as sleep:
            self.assertEqual(sentry.get("https://example.test/data"), {})
            self.assertEqual(sentry.get("https://example.test/data", raw=True), b"")
        self.assertEqual(sleep.call_count, 14)

    def test_persistent_plain_timeouts_keep_gets_empty_contract(self):
        failures = [TimeoutError("timed out")] * 16
        with mock.patch.object(sentry, "_open", fake_open(*failures)), \
             mock.patch.object(sentry.time, "sleep") as sleep:
            self.assertEqual(sentry.get("https://example.test/data"), {})
            self.assertEqual(sentry.get("https://example.test/data", raw=True), b"")
        self.assertEqual(sleep.call_count, 14)


class Counts(unittest.TestCase):
    def tearDown(self):
        sentry.use_project("jollity-next")

    def test_count_uses_the_dataset_function(self):
        cases = {"tracemetrics": "count(value)", "spans": "count_sample()",
                 "errors": "count()", "transactions": "count()", "logs": "count()"}
        for dataset, field in cases.items():
            seen = []

            def _opener(url, params=None, _seen=seen):
                _seen.append(params)
                return FakeResponse({"data": [{field: 7}]})
            with mock.patch.object(sentry, "_open", _opener):
                got = sentry.count(dataset, "x", "2026-10-15T09:00:00", "2026-10-15T12:00:00")
            self.assertEqual(got, 7, dataset)
            self.assertEqual(seen[0]["field"], [field], dataset)
            self.assertEqual(seen[0]["per_page"], 1, dataset)

    def test_count_field_override_asks_for_plain_count(self):
        seen = []

        def _opener(url, params=None):
            seen.append(params)
            return FakeResponse({"data": [{"count()": 3}]})
        with mock.patch.object(sentry, "_open", _opener):
            self.assertEqual(sentry.count("spans", "x", "a", "b", field="count()"), 3)
        self.assertEqual(seen[0]["field"], ["count()"])

    def test_events_all_still_raises_the_original_http_error(self):
        """The pull stores str(error)[:200] and coverage_metrics reads error.code, so events_all must not wrap it."""
        with mock.patch.object(sentry, "_open", fake_open(http_error(400))):
            with self.assertRaises(urllib.error.HTTPError) as cm:
                sentry.events_all("errors", "x", ["id"])
        self.assertEqual(cm.exception.code, 400)
        self.assertEqual(str(cm.exception), str(http_error(400)))


class StrictFailures(unittest.TestCase):
    """M2: count, attribute_keys, tag_keys, measurement_keys and raw_get raise ONLY SentryQueryError, whatever went
    wrong — an HTTP error, a URLError that outlived the retries, a body that is not JSON, or the wrong shape."""

    def setUp(self):
        self.calls = {
            "count": lambda: sentry.count("errors", "x", "a", "b"),
            "attribute_keys": lambda: sentry.attribute_keys("spans", "a", "b"),
            "tag_keys": lambda: sentry.tag_keys("errors", "a", "b"),
            "measurement_keys": lambda: sentry.measurement_keys("a", "b"),
            "raw_get": lambda: sentry.raw_get("/projects/paritytech/jollity-next/events/e1/"),
        }

    def tearDown(self):
        sentry.use_project("jollity-next")

    def check(self, names, *responses):
        for name in names:
            with mock.patch.object(sentry, "_open", fake_open(*responses)):
                with mock.patch.object(sentry.time, "sleep"):
                    with self.assertRaises(sentry.SentryQueryError, msg=name):
                        self.calls[name]()

    def test_http_error(self):
        self.check(self.calls, http_error(400))

    def test_url_error_after_the_retries(self):
        self.check(self.calls, *[urllib.error.URLError("down")] * 8)

    def test_a_body_that_is_not_json(self):
        # raw_get returns bytes, so a non-JSON body is legitimate there (an attachment is binary): only the parsers
        self.check(["count", "attribute_keys", "tag_keys", "measurement_keys"], *[FakeResponse(b"<html>nope</html>")] * 2)

    def test_a_wrong_shape(self):
        # a dict where the tags endpoint promises a list; a list where count promises {"data": [...]}
        self.check(["count", "attribute_keys", "tag_keys"], *[FakeResponse({"nope": 1})] * 2)

    def test_a_null_or_non_numeric_count(self):
        for bad in (None, "many", {"a": 1}):
            with mock.patch.object(sentry, "_open", fake_open(FakeResponse({"data": [{"count()": bad}]}))):
                with self.assertRaises(sentry.SentryQueryError):
                    sentry.count("errors", "x", "a", "b")

    def test_count_raises_on_http_error_never_zero(self):
        """Trap 1: a naive count built on get() reads 0 on an HTTP error and 0 == 0 passes."""
        with mock.patch.object(sentry, "_open", fake_open(http_error(400))):
            with self.assertRaises(sentry.SentryQueryError) as cm:
                sentry.count("spans", "x", "2026-10-15T09:00:00", "2026-10-15T12:00:00")
        self.assertIn("HTTP 400", str(cm.exception))

    def test_count_raises_on_empty_answer(self):
        with mock.patch.object(sentry, "_open", fake_open(FakeResponse({"data": []}))):
            with self.assertRaises(sentry.SentryQueryError):
                sentry.count("errors", "x", "2026-10-15T09:00:00", "2026-10-15T12:00:00")


class KeyDiscovery(unittest.TestCase):
    def tearDown(self):
        sentry.use_project("jollity-next")

    def test_attribute_keys_shape_and_order(self):
        def rows(*triples):
            return [{"key": k, "name": n, "attributeType": t} for k, n, t in triples]
        opener = fake_open(
            FakeResponse(rows(("tags[b,number]", "b", "number"), ("a", "a", "string"))),
            FakeResponse(rows(("tags[c,boolean]", "c", "boolean"))),
            FakeResponse(rows(("z", "z", "string"))))
        with mock.patch.object(sentry, "_open", opener):
            got = sentry.attribute_keys("spans", "2026-10-15T09:00:00", "2026-10-15T12:00:00")
        self.assertEqual(got, [
            {"field": "a", "name": "a", "type": "string"},
            {"field": "z", "name": "z", "type": "string"},
            {"field": "tags[b,number]", "name": "b", "type": "number"},
            {"field": "tags[c,boolean]", "name": "c", "type": "boolean"},
        ])

    def test_tag_keys_maps_errors_to_events(self):
        seen = []

        def _opener(url, params=None):
            seen.append(params)
            return FakeResponse([{"key": "b"}, {"key": "a"}])
        with mock.patch.object(sentry, "_open", _opener):
            got = sentry.tag_keys("errors", "2026-10-15T09:00:00", "2026-10-15T12:00:00")
            self.assertEqual(got, ["a", "b"])
            self.assertEqual(seen[0]["dataset"], "events")
            sentry.tag_keys("transactions", "2026-10-15T09:00:00", "2026-10-15T12:00:00")
            self.assertEqual(seen[1]["dataset"], "transactions")

    def test_measurement_keys_always_include_the_fixed_list(self):
        """A partial answer must not drop a rung of the upload ladder (M5)."""
        with mock.patch.object(sentry, "_open", fake_open(FakeResponse({"measurements.rtc.other_s": 1}))):
            got = sentry.measurement_keys("2026-10-15T09:00:00", "2026-10-15T12:00:00")
        self.assertIn("measurements.rtc.other_s", got)
        for key in sentry.FIXED_MEASUREMENT_KEYS:
            self.assertIn(key, got)

    def test_the_fixed_measurement_list_matches_game_report_pull(self):
        """M4: sentry.py holds the one copy; this fails if game-report-pull.py's list drifts from it."""
        spec = importlib.util.spec_from_file_location("game_report_pull_m", os.path.join(HERE, "game-report-pull.py"))
        pull = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(pull)
        self.assertEqual(sorted(pull.SEND_RUNG_FIELDS), sorted(["id", "timestamp", "game.index", "round", "opening_rung",
                         "min_rung", "max_rung", "closing_rung"] + sentry.FIXED_MEASUREMENT_KEYS))


class RawGet(unittest.TestCase):
    def test_raw_get_404_returns_status_not_raises(self):
        with mock.patch.object(sentry, "_open", fake_open(http_error(404))):
            status, body = sentry.raw_get("/projects/paritytech/jollity-next/events/e1/")
        self.assertEqual((status, body), (404, b""))

    def test_raw_get_500_retries_then_raises(self):
        with mock.patch.object(sentry, "_open", fake_open(*[http_error(500)] * 8)):
            with mock.patch.object(sentry.time, "sleep") as sleep:
                with self.assertRaises(sentry.SentryQueryError) as cm:
                    sentry.raw_get("/projects/paritytech/jollity-next/events/e1/")
        self.assertIn("HTTP 500", str(cm.exception))
        self.assertEqual(sleep.call_count, 7)

    def test_raw_get_returns_status_and_bytes(self):
        with mock.patch.object(sentry, "_open", fake_open(FakeResponse(b"hello"))):
            self.assertEqual(sentry.raw_get("/projects/paritytech/jollity-next/events/e1/"), (200, b"hello"))


class HostReminderEvents(unittest.TestCase):
    def test_reads_title_tags_context_and_device_and_skips_other_titles(self):
        def event(title, event_id):
            return {"eventID": event_id, "title": title, "dateCreated": "2026-11-03T12:59:30Z", "user": {"id": "PHONE-A"},
                    "context": {"reminder.starts_at_unix_ms": 1000},
                    "tags": [{"key": "reminder.delivery", "value": "alarm"}, {"key": "reminder.product_id", "value": "dim2.paseo"},
                             {"key": "host.app_variant", "value": "nightly"}]}
        pages = lambda project, start, end, query="": iter([[event(query, "e-" + query), event("host.reminder.other", "x")]])
        with mock.patch.object(sentry, "project_event_pages", side_effect=pages) as called:
            rows = sentry.host_reminder_events("s", "e")
        self.assertEqual({c.args[0] for c in called.call_args_list}, {"polkadot-ios", "polkadot-android"})
        self.assertEqual({r["title"] for r in rows}, {"host.reminder." + n for n in sentry.HOST_REMINDER_EVENTS})
        self.assertEqual({r["platform"] for r in rows}, {"ios", "android"})
        ios = next(r for r in rows if r["platform"] == "ios")
        self.assertEqual(ios, {"title": ios["title"], "timestamp": "2026-11-03T12:59:30Z", "user": "PHONE-A", "delivery": "alarm",
                               "product_id": "dim2.paseo", "starts_at_unix_ms": 1000, "app_variant": "nightly", "platform": "ios"})


if __name__ == "__main__":
    unittest.main()
