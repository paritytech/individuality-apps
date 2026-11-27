#!/usr/bin/env python3
# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""Capture one report-ready Sentry dataset, then resume retained raw details.

This is the network-facing half of the store writer.  It discovers fields,
splits them below Sentry's field cap, pages every group with an explicit
project id, and refuses any result whose counts or id sets do not agree.
"""

import argparse
import concurrent.futures
import datetime
import hashlib
import importlib.util
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time

import sentry
import sentry_logs
import store_paths
import store_write


HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
REPORT = os.path.join(HERE, "game-report.py")
REPORT_WINDOW_MARGIN_SECONDS = 30


KEY_FIELDS = ["id", "timestamp"]
MAX_FIELDS = 50
GROUP_RECONCILE_ATTEMPTS = 2
DATASETS = ("spans", "errors", "transactions", "tracemetrics", "logs")
BACKFILL_QUERY = "has:game.index environment:[dim2.paseo,dim2next.paseo] is_transaction:true"

# These are the first rows observed by the frozen store design's 90-day probe.
# Retention has begun expiring when a current oldest row moves past its baseline.
FIRST_DATA = {
    "jollity-next": {
        "spans": "2026-10-01 00:31 CEST",
        "errors": "2026-10-01 15:46 CEST",
        "transactions": "2026-10-01 00:31 CEST",
        "tracemetrics": "2026-10-01 01:40 CEST",
        "logs": "none",
    },
    "dim2-testing": dict.fromkeys(DATASETS, "2026-10-14 22:25-23:11 CEST"),
}

BASE = {
    "spans": [
        "project", "trace", "is_transaction", "transaction", "span.op",
        "span.description", "span.duration", "parent_span",
        # Section 6 and the T10/T11 game-report source.  These are explicit:
        # built-in fields such as user.id are not returned by attribute_keys.
        "user.id", "environment", "journey.outcome", "journey.sad",
        "journey.sad_reason", "journey.expected", "host.kind", "host.app",
        "host.app_version", "device.os", "device.os_version", "device.model",
        "device.gpu", "device.cores", "device.memory", "net.type",
        "net.effective", "env.source", "session.id", "telemetry.grant",
        "signup.route", "signup.stage", "draw.entered", "draw.skipped",
        "person.stage", "permissions.step", "permissions.reason", "camera.warm",
        "user.username", "release", "game.index", "test.tag", "sdk.name",
        "surface", "join.first_link_ms", "join.all_links_ms", "rtc.path",
        "rtc.outcome", "camera.state", "camera.reason",
    ],
    "tracemetrics": [
        "project", "trace", "metric.name", "metric.type", "metric.unit", "value",
        # Section 6 and every grouping/filter dependency of metric_groups.
        "stat", "scene", "moment", "round", "rtc.peer", "rtc.path", "reason",
        "rtc.signal_peer_present", "lowpower", "lowpower.reason", "probe",
        "probe.version", "probe.threshold_ms", "probe.sample", "probe.rule",
        "probe.borderline_from_ms", "probe.weak_from_ms", "probe.stage",
        "probe.attempts", "rtc.pair", "rtc.encoder_kind", "rtc.decoder_kind",
        "release", "session.id", "game.index",
    ],
    "logs": [
        "project", "trace", "message", "severity",
        # sentry_logs.LOG_FIELDS, consumed by fetch_logs through T10/T11.
        "user.id", "session.id", "game.index", "game_log.stage", "game_log.item",
        "game_log.record", "game_log.records", "game_log.checkpoint",
        "game_log.seq", "game_log.part", "game_log.parts", "game_log.copy",
        "game_log.full_stage", "game_log.begin", "app.version", "test.tag",
        "tags[game_log.first_ts_ms,number]", "sentry.observed_timestamp_nanos",
        "tags[game_log.captured_ms,number]",
    ],
    "errors": [
        "project", "trace", "title", "message", "level", "environment", "release",
        "platform", "culprit", "user.id", "user.username", "event.type", "received",
        "issue", "transaction", "game.index", "test.tag", "game_log.stage",
        "game_log.checkpoint", "game_log.seq", "sdk.name", "chat.count", "outcome",
        "complete",
    ],
    "transactions": [
        "project", "trace", "transaction", "transaction.op", "transaction.duration",
        "transaction.status", "environment", "release", "user.id", "event.type",
        # Detail routing plus SEND_RUNG_FIELDS and its measurement_set filter.
        "host.kind", "game.index", "measurement_set", "round", "opening_rung",
        "min_rung", "max_rung", "closing_rung",
        "measurements.rtc.send.rung_full_s", "measurements.rtc.send.rung_lean_s",
        "measurements.rtc.send.rung_low_s", "measurements.rtc.send.rung_minimum_s",
        "measurements.rtc.send.rung_survival_s",
        "measurements.rtc.send.bandwidth_limited_s",
        "measurements.rtc.send.step_up_count",
    ],
}

BASE_TYPES = {
    "span.duration": "number",
    "value": "number",
    "transaction.duration": "number",
    "is_transaction": "boolean",
    "tags[game_log.first_ts_ms,number]": "number",
    "sentry.observed_timestamp_nanos": "int",
    "tags[game_log.captured_ms,number]": "number",
    "measurements.rtc.send.rung_full_s": "number",
    "measurements.rtc.send.rung_lean_s": "number",
    "measurements.rtc.send.rung_low_s": "number",
    "measurements.rtc.send.rung_minimum_s": "number",
    "measurements.rtc.send.rung_survival_s": "number",
    "measurements.rtc.send.bandwidth_limited_s": "number",
    "measurements.rtc.send.step_up_count": "number",
}


class DumpFailed(RuntimeError):
    """A completeness check failed twice.  ``check`` is safe to print."""

    def __init__(self, check):
        self.check = check
        super().__init__("dataset completeness check failed: %r" % check)


class NoPaseoTelemetry(DumpFailed):
    """The chain game number has no production telemetry in its window."""


def _kind(field):
    return BASE_TYPES.get(field, "string")


def _completeness_count_field(dataset):
    """Count the distinct ids that a successful paged dump must retain.

    Span pages are sampled, so their existing ``count_sample()`` contract is
    the only count that describes the rows returned by Discover.  The other
    datasets are unsampled and can use the id cardinality directly.  That
    avoids treating a repeated event occurrence in Sentry's aggregate or an
    overlapping page boundary as another event that must be stored.
    """
    return sentry.COUNT_FIELD[dataset] if dataset == "spans" else "count_unique(id)"


def discover(dataset, start, end, pid):
    """Return ordered ``(response field, type)`` pairs for one dataset."""
    columns = [(field, "string") for field in KEY_FIELDS]
    columns.extend((field, _kind(field)) for field in BASE[dataset])
    seen = {field for field, _kind_name in columns}

    discovered = []
    if dataset in ("spans", "tracemetrics", "logs"):
        discovered = [
            (item["field"], item["type"])
            for item in sentry.attribute_keys(dataset, start, end, pids=[pid])
        ]
    elif dataset in ("errors", "transactions"):
        discovered.extend(
            ("tags[%s]" % key, "string")
            for key in sentry.tag_keys(dataset, start, end, pids=[pid])
            if key not in seen
        )
        if dataset == "transactions":
            discovered.extend(
                (key, "number") for key in sentry.measurement_keys(start, end, pids=[pid])
            )
    else:
        raise ValueError("unknown dataset %r" % dataset)

    for field, kind in discovered:
        if field not in seen and field not in KEY_FIELDS:
            columns.append((field, kind))
            seen.add(field)
    return columns


def field_groups(columns):
    """Split columns into groups that all carry id/timestamp and fit the cap."""
    if MAX_FIELDS < len(KEY_FIELDS) + 1:
        raise ValueError("MAX_FIELDS must leave room for a non-key field")
    fields = [field for field, _kind_name in columns]
    others = [field for field in fields if field not in KEY_FIELDS]
    width = MAX_FIELDS - len(KEY_FIELDS)
    if not others:
        return [list(KEY_FIELDS)]
    return [list(KEY_FIELDS) + others[offset:offset + width]
            for offset in range(0, len(others), width)]


def _read_group(dataset, query, fields, start, end, pid):
    def read():
        rows = []
        seen = set()
        duplicates = 0
        for page in sentry.pages(
                dataset, query, fields, sort=["timestamp", "id"],
                per_page=sentry.PER_PAGE_MAX[dataset], start=start, end=end, pids=[pid]):
            for row in page:
                event_id = row.get("id")
                if event_id in seen:
                    duplicates += 1
                else:
                    seen.add(event_id)
                    rows.append(row)
        return rows, seen, duplicates

    try:
        return sentry._checked("pages(%s)" % dataset, read)
    except sentry.SentryQueryError as error:
        raise DumpFailed({
            "query": query,
            "start": start,
            "end": end,
            "query_error": str(error),
            "pass": False,
        }) from error


def _check(dataset, query, start, end, columns, groups, count_before, count_after,
           count_extrapolated, rows_stored, duplicates, equal):
    sampled = dataset == "spans" and count_extrapolated != count_before
    passed = (
        count_before == count_after == rows_stored
        and equal
    )
    check = {
        "query": query,
        "start": start,
        "end": end,
        "fields": [field for field, _kind_name in columns],
        "field_groups": len(groups),
        "count_fn": _completeness_count_field(dataset),
        "sentry_count": count_before,
        "sentry_count_after": count_after,
        "rows_stored": rows_stored,
        "duplicates": duplicates,
        "group_id_sets_equal": equal,
        "pass": passed,
    }
    if dataset == "spans":
        check["count_extrapolated"] = count_extrapolated
        check["sampled"] = sampled
    return check


def _dump_dataset_once(dataset, query, start, end, pid, columns):
    groups = field_groups(columns)
    count_field = _completeness_count_field(dataset)
    try:
        count_before = sentry.count(
            dataset, query, start, end, pids=[pid], field=count_field,
        )
        count_extrapolated = (
            sentry.count(dataset, query, start, end, pids=[pid], field="count()")
            if dataset == "spans" else count_before
        )
    except sentry.SentryQueryError as error:
        raise DumpFailed({"query": query, "start": start, "end": end,
                          "query_error": str(error), "pass": False}) from error

    group_rows = []
    id_sets = []
    duplicates = 0
    for group in groups:
        rows, ids, repeated = _read_group(dataset, query, group, start, end, pid)
        group_rows.append(rows)
        id_sets.append(ids)
        duplicates += repeated

    group_retries = [0] * len(groups)
    spine_count = None
    if id_sets and any(ids != id_sets[0] for ids in id_sets[1:]):
        _spine_rows, spine_ids, spine_duplicates = _read_group(
            dataset, query, KEY_FIELDS, start, end, pid)
        spine_count = len(spine_ids)
        duplicates += spine_duplicates
        if not spine_duplicates and spine_count == count_before:
            for index, group in enumerate(groups):
                while (id_sets[index] != spine_ids
                       and group_retries[index] < GROUP_RECONCILE_ATTEMPTS):
                    rows, ids, repeated = _read_group(
                        dataset, query, group, start, end, pid)
                    group_rows[index] = rows
                    id_sets[index] = ids
                    duplicates += repeated
                    group_retries[index] += 1

    try:
        count_after = sentry.count(
            dataset, query, start, end, pids=[pid], field=count_field,
        )
    except sentry.SentryQueryError as error:
        raise DumpFailed({"query": query, "start": start, "end": end,
                          "query_error": str(error), "pass": False}) from error
    equal = all(ids == id_sets[0] for ids in id_sets[1:])

    merged = []
    if equal and group_rows:
        by_id = {row["id"]: dict(row) for row in group_rows[0]}
        for rows in group_rows[1:]:
            for row in rows:
                by_id[row["id"]].update(row)
        merged = [by_id[row["id"]] for row in group_rows[0]]

    check = _check(
        dataset, query, start, end, columns, groups, count_before, count_after,
        count_extrapolated, len(merged), duplicates, equal,
    )
    check["group_id_counts"] = [len(ids) for ids in id_sets]
    check["group_retries"] = group_retries
    if spine_count is not None:
        check["spine_id_count"] = spine_count
    return merged, check


def dump_dataset(dataset, query, start, end, pid, columns):
    """Dump one dataset, retrying the entire consistency operation once."""
    last_check = None
    for _attempt in range(2):
        try:
            rows, check = _dump_dataset_once(dataset, query, start, end, pid, columns)
        except DumpFailed as error:
            last_check = error.check
            continue
        if check["pass"]:
            return rows, check
        last_check = check
    raise DumpFailed(last_check)


def dump_grouped(dataset, query, fields, start, end, pid):
    """Capture a grouped query, retrying the entire operation once."""
    grouping = [field for field in fields if "(" not in field]
    last_check = None
    for _attempt in range(2):
        rows, seen, duplicates = [], set(), 0
        def read():
            nonlocal duplicates
            for page in sentry.pages(dataset, query, fields, sort=None,
                    per_page=sentry.PER_PAGE_MAX[dataset], start=start, end=end, pids=[pid]):
                for row in page:
                    key = tuple(row.get(field) for field in grouping)
                    if key in seen:
                        duplicates += 1
                    else:
                        seen.add(key)
                        rows.append(row)
        try:
            sentry._checked("pages(%s grouped)" % dataset, read)
            last_check = {"query": query, "start": start, "end": end, "fields": list(fields),
                          "rows_stored": len(rows), "duplicates": duplicates,
                          "pass": duplicates == 0}
        except sentry.SentryQueryError as error:
            last_check = {"query": query, "start": start, "end": end,
                          "query_error": str(error), "pass": False}
        if last_check["pass"]:
            return rows, last_check
    raise DumpFailed(last_check)


def _load_script(name):
    module_name = name.replace("-", "_")
    if module_name in sys.modules:
        return sys.modules[module_name]
    path = os.path.join(os.path.dirname(__file__), name + ".py")
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _iso(dt):
    return dt.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _git(*args):
    worktree = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))
    return subprocess.run(["git", *args], cwd=worktree,
                          capture_output=True, text=True, check=True).stdout.strip()


def _tag(rows, project, part):
    return [{**row, "__store_project": project, "__store_part": part} for row in rows]


def _raw_table(rows, columns):
    """Build one raw table while keeping store metadata distinct from reserved Sentry attributes."""
    if rows:
        table, json_columns = store_write.rows_to_table(rows, columns, {})
        projects = table.column("__store_project")
        parts = table.column("__store_part")
        table = table.drop(["__store_project", "__store_part"])
        return table.append_column("_project", projects).append_column("_part", parts), json_columns
    table = store_write.empty_table(columns)
    empty = store_write.pa.array([], type=store_write.pa.string())
    return table.append_column("_project", empty).append_column("_part", empty), []


def _file_bytes(root):
    return sum(os.path.getsize(os.path.join(base, name))
               for base, _dirs, names in os.walk(root) for name in names)


def _read_json(path, fallback=None):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return fallback


def _print_checks(checks):
    print("dataset check rows pass")
    for dataset, slug, part, check in checks:
        print("%s/%s/%s %s %s" %
              (dataset, slug, part, check.get("rows_stored", "-"), check.get("pass", False)))


def _local_time(value):
    """Format an API timestamp in the machine's labelled local timezone."""
    if not value:
        return "none"
    parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")


def _oldest_row(dataset, pid):
    def read():
        for page in sentry.pages(dataset, "", ["timestamp"], sort="timestamp",
                                 per_page=1, period="90d", pids=[pid]):
            if page:
                return page[0].get("timestamp")
        return None
    return sentry._checked("oldest(%s,%s)" % (dataset, pid), read)


def retention_watch():
    """Print and return the oldest retained row for every dataset/project."""
    rows = []
    print("retention watch")
    print("dataset project oldest first_data")
    for dataset in DATASETS:
        for project, pid in sentry.PROJECTS.items():
            oldest = _oldest_row(dataset, pid)
            row = {"dataset": dataset, "project": project, "oldest": oldest,
                   "first_data": FIRST_DATA[project][dataset]}
            rows.append(row)
            print("%s %s %s %s" %
                  (dataset, project, _local_time(oldest), row["first_data"]))
    return rows


def backfill_games():
    """Return production paseo game numbers from Sentry, oldest first."""
    pid = sentry.PROJECTS["jollity-next"]

    def read():
        games = set()
        for page in sentry.pages(
                "spans", BACKFILL_QUERY, ["game.index", "count()"],
                sort="game.index", per_page=sentry.PER_PAGE_MAX["spans"],
                period="90d", pids=[pid]):
            for row in page:
                value = row.get("game.index")
                try:
                    games.add(int(value))
                except (TypeError, ValueError):
                    continue
        return sorted(games)

    return sentry._checked("backfill game list", read)


def _summary_size(path):
    return _file_bytes(path) / (1024 * 1024) if os.path.isdir(path) else 0.0


def run_backfill(root=None, from_game=None, to_game=None, sleep_seconds=30, ws=None):
    """Dump every eligible discovered game sequentially; never replace evidence."""
    retention_watch()
    games = [game for game in sorted(set(backfill_games()))
             if (from_game is None or game >= from_game)
             and (to_game is None or game <= to_game)]
    results = []
    failed = False
    attempted = False
    for game in games:
        final = store_paths.game_dir(game, root=root)
        if os.path.isdir(final):
            results.append((game, "skipped-existing", 0.0, _summary_size(final)))
            continue
        if attempted and sleep_seconds:
            time.sleep(sleep_seconds)
        attempted = True
        started = time.monotonic()
        try:
            kwargs = {"root": root}
            if ws is not None:
                kwargs["ws"] = ws
            path = dump_game(game, **kwargs)
            results.append((game, "stored", (time.monotonic() - started) / 60,
                            _summary_size(path)))
        except store_write.DumpRefused as error:
            if "inside the 15 minute ingest guard" in str(error):
                results.append((game, "skipped-early",
                                (time.monotonic() - started) / 60, 0.0))
            else:
                failed = True
                print("g%d failed: %s" % (game, error))
                results.append((game, "failed", (time.monotonic() - started) / 60, 0.0))
        except Exception as error:
            failed = True
            print("g%d failed: %s" % (game, error))
            results.append((game, "failed", (time.monotonic() - started) / 60, 0.0))

    print("game status minutes MB")
    for game, status, minutes, megabytes in results:
        print("%d %s %.2f %.2f" % (game, status, minutes, megabytes))
    return 1 if failed else 0


def print_due(root=None, now=None):
    """Print refresh commands for late-incomplete games; execute nothing."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    parent = os.path.dirname(store_paths.game_dir(0, root=root))
    due = []
    if os.path.isdir(parent):
        for name in os.listdir(parent):
            match = re.fullmatch(r"g([0-9]+)", name)
            if not match:
                continue
            manifest = _read_json(os.path.join(parent, name, "manifest.json"), {})
            late_end = manifest.get("window", {}).get("late_end_utc")
            if manifest.get("late_complete") or not late_end:
                continue
            parsed = datetime.datetime.fromisoformat(late_end.replace("Z", "+00:00"))
            if parsed <= now:
                due.append(int(match.group(1)))
    due.sort()
    for game in due:
        command = [sys.executable, os.path.abspath(__file__), str(game), "--refresh"]
        if root:
            command.extend(["--root", os.path.abspath(root)])
        print(" ".join(shlex.quote(part) for part in command))
    return due


def _dump_late_logs(module, game, query, start, end, pid, columns):
    if hasattr(module, "log_request"):
        query, count_start = module.log_request(game, start)
    else:
        query = "%s has:game_log.item" % query
        try:
            count_start = (sentry.parse_ts(start) - datetime.timedelta(hours=12)).strftime(
                "%Y-%m-%dT%H:%M:%S")
        except (TypeError, ValueError):
            count_start = start
    last_check = None
    for _attempt in range(2):
        try:
            before = sentry.count("logs", query, count_start, end, pids=[pid])
            # Count and fetch share sentry_logs' exact packed-log query/window.
            rows = module.log_rows(game, start, end, pids=[pid])
            after = sentry.count("logs", query, count_start, end, pids=[pid])
            missing_ids = sum(row.get("id") is None for row in rows)
            ids = [row["id"] for row in rows if row.get("id") is not None]
            duplicates = len(ids) - len(set(ids))
            passed = before == after == len(rows) and duplicates == 0 and missing_ids == 0
            last_check = {"query": query, "start": count_start, "end": end,
                          "fields": [c[0] for c in columns], "field_groups": 1,
                          "count_fn": sentry.COUNT_FIELD["logs"], "sentry_count": before,
                          "sentry_count_after": after, "rows_stored": len(rows),
                          "duplicates": duplicates, "missing_ids": missing_ids,
                          "group_id_sets_equal": True, "pass": passed}
            if passed:
                return rows, last_check
        except Exception as error:
            last_check = {"query": query, "start": count_start, "end": end,
                          "query_error": str(error), "pass": False}
    raise DumpFailed(last_check)


EVENT_JSON_SCHEMA = [
    ("id", "string"), ("project", "string"), ("dataset", "string"),
    ("status", "int"), ("json", "string"),
]
ATTACHMENT_SCHEMA = [
    ("event_id", "string"), ("project", "string"),
    ("attachment_id", "string"), ("name", "string"), ("size", "int"),
    ("list_json", "string"), ("body", "binary"), ("sha256", "string"),
]

DETAIL_WORKERS = 4
RAW_CHECKPOINT_ROWS = 250


def _ordered_parallel_map(fn, items, workers=DETAIL_WORKERS):
    """Run independent strict reads concurrently while preserving source order.

    The first worker exception cancels work that has not started and is re-raised;
    successfully returned rows are never published out of order.
    """
    items = list(items)
    if not items:
        return []
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=workers)
    futures = [executor.submit(fn, item) for item in items]
    try:
        done, _pending = concurrent.futures.wait(
            futures, return_when=concurrent.futures.FIRST_EXCEPTION)
        failure = next((future.exception() for future in done if future.exception() is not None), None)
        if failure is not None:
            for future in futures:
                future.cancel()
            raise failure
        return [future.result() for future in futures]
    finally:
        executor.shutdown(wait=True, cancel_futures=True)


def _detail_json_rows(sources, dataset, allow_missing):
    """Fetch selected details through Sentry's strict retry path."""
    sources = [(dataset, source) for source in sources]

    def fetch(item):
        dataset, source = item
        event_id = source["id"]
        slug = source["__store_project"]
        path = "/projects/%s/%s/events/%s/" % (sentry.ORG, slug, event_id)
        status, body = sentry.raw_get(path)
        if status == 404:
            time.sleep(5)
            status, body = sentry.raw_get(path)
        missing = status == 404
        if missing:
            if not allow_missing:
                raise DumpFailed({"dataset": "events_json", "id": event_id,
                                  "status": status, "pass": False})
            text = None
        elif status == 200:
            try:
                text = body.decode("utf-8")
            except UnicodeDecodeError as error:
                raise DumpFailed({"dataset": "events_json", "id": event_id,
                                  "reason": "event JSON is not UTF-8: %s" % error,
                                  "pass": False}) from error
        else:
            raise DumpFailed({"dataset": "events_json", "id": event_id,
                              "status": status, "pass": False})
        return ({"id": event_id, "project": slug, "dataset": dataset,
                 "status": status, "json": text}, event_id if missing else None)

    fetched = _ordered_parallel_map(fetch, sources)
    return [row for row, _missing in fetched], [missing for _row, missing in fetched if missing]


def _event_json_rows(captured, allow_missing):
    """Compatibility helper for complete error and transaction detail pulls."""
    rows, missing = [], []
    for dataset in ("errors", "transactions"):
        part_rows, part_missing = _detail_json_rows(captured[dataset], dataset, allow_missing)
        rows.extend(part_rows)
        missing.extend(part_missing)
    return rows, missing


def _bulk_error_json_rows(error_rows, windows, game, allow_missing):
    """Fetch full error payloads by page, then retain the captured error ids in source order."""
    found = {}
    grouped = {}
    for source in error_rows:
        grouped.setdefault((source["__store_project"], source["__store_part"]), set()).add(source["id"])
    for (slug, part), wanted in grouped.items():
        start, end = windows[part]
        query = "game.index:%d" % game if part == "late" else ""
        for page in sentry.project_event_pages(slug, _iso(start), _iso(end), query):
            for event in page:
                event_id = event.get("eventID") or event.get("id")
                if event_id in wanted:
                    found[event_id] = json.dumps(
                        event, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    absent = [source for source in error_rows if source["id"] not in found]
    if absent:
        fallback_rows, _fallback_missing = _detail_json_rows(
            absent, "errors", allow_missing)
        found.update({row["id"]: row["json"] for row in fallback_rows
                      if row["status"] == 200})
    rows, missing = [], []
    for source in error_rows:
        event_id = source["id"]
        text = found.get(event_id)
        if text is None:
            missing.append(event_id)
            if not allow_missing:
                raise DumpFailed({"dataset": "events_json", "id": event_id,
                                  "reason": "full error was absent from bulk project events",
                                  "pass": False})
        rows.append({"id": event_id, "project": source["__store_project"],
                     "dataset": "errors", "status": 200 if text is not None else 404,
                     "json": text})
    return rows, missing


def _report_transaction_sources(transaction_rows):
    """The small transaction-detail subset consumed by game-report-pull."""
    latest_host = {}
    payoff_ids = set()
    for row in transaction_rows:
        account = row.get("user.id")
        if account and row.get("host.kind"):
            current = latest_host.get(account)
            if current is None or (row.get("timestamp") or "", row["id"]) > (
                    current.get("timestamp") or "", current["id"]):
                latest_host[account] = row
        if row.get("transaction") == "journey.payoff":
            payoff_ids.add(row["id"])
    wanted = {row["id"] for row in latest_host.values()} | payoff_ids
    return [row for row in transaction_rows if row["id"] in wanted]


def _preserved_transaction_rows(old_rows, current_ids):
    """Keep current transaction evidence across refresh, including prior non-200 rows."""
    return [row for row in old_rows
            if row.get("dataset") == "transactions" and row.get("id") in current_ids]


def _attachment_list_pages(path, event_id):
    """Yield every raw attachment-list page through sentry's retrying request path."""
    url = sentry.BASE + path if path.startswith("/") else path
    while url:
        try:
            status, body, headers = sentry._checked(
                "GET %s" % url, lambda: sentry._request(url, None))
        except sentry.SentryQueryError as error:
            raise DumpFailed({"dataset": "attachments", "event_id": event_id,
                              "reason": str(error), "pass": False}) from error
        if status != 200:
            raise DumpFailed({"dataset": "attachments", "event_id": event_id,
                              "status": status, "pass": False})
        try:
            list_json = body.decode("utf-8")
        except UnicodeDecodeError as error:
            raise DumpFailed({"dataset": "attachments", "event_id": event_id,
                              "reason": "attachment list is not UTF-8: %s" % error,
                              "pass": False}) from error
        try:
            attachments = json.loads(list_json)
            if not isinstance(attachments, list):
                raise TypeError("attachment list is not a list")
        except (ValueError, TypeError) as error:
            raise DumpFailed({"dataset": "attachments", "event_id": event_id,
                              "reason": "unusable attachment list: %s" % error,
                              "pass": False}) from error
        yield list_json, attachments
        url = sentry._next_url(headers.get("Link", ""))


def _attachment_rows(error_rows, missing_event_ids=()):
    """Fetch attachment lists and bodies for game-log error events."""
    missing_event_ids = set(missing_event_ids)
    sources = [source for source in error_rows
               if source.get("title") in ("game-log", "game-log-chunk")
               and source["id"] not in missing_event_ids]

    def fetch(source):
        rows, file_count, byte_count = [], 0, 0
        event_id = source["id"]
        slug = source["__store_project"]
        base = "/projects/%s/%s/events/%s/attachments" % (sentry.ORG, slug, event_id)
        pages = list(_attachment_list_pages(base + "/", event_id))
        if not any(attachments for _list_json, attachments in pages):
            rows.append({"event_id": event_id, "project": slug,
                         "attachment_id": None, "name": None, "size": None,
                         "list_json": pages[0][0], "body": None, "sha256": None})
            return rows, file_count, byte_count
        for list_json, attachments in pages:
            for attachment in attachments:
                try:
                    attachment_id = str(attachment["id"])
                    name = attachment["name"]
                    expected = int(attachment["size"])
                except (KeyError, TypeError, ValueError) as error:
                    raise DumpFailed({"dataset": "attachments", "event_id": event_id,
                                      "reason": "unusable attachment metadata: %s" % error,
                                      "pass": False}) from error
                status, body = sentry.raw_get(base + "/%s/?download=1" % attachment_id)
                if status != 200:
                    raise DumpFailed({"dataset": "attachments", "event_id": event_id,
                                      "attachment_id": attachment_id, "status": status,
                                      "pass": False})
                if len(body) != expected:
                    raise DumpFailed({"dataset": "attachments", "event_id": event_id,
                                      "attachment_id": attachment_id,
                                      "reason": "attachment size %d != listed size %d" %
                                                (len(body), expected), "pass": False})
                file_count += 1
                byte_count += len(body)
                rows.append({"event_id": event_id, "project": slug,
                             "attachment_id": attachment_id, "name": name,
                             "size": expected, "list_json": list_json, "body": body,
                             "sha256": hashlib.sha256(body).hexdigest()})
        return rows, file_count, byte_count

    fetched = _ordered_parallel_map(fetch, sources)
    rows = [row for event_rows, _files, _bytes in fetched for row in event_rows]
    return (rows, len(sources), sum(files for _rows, files, _bytes in fetched),
            sum(byte_count for _rows, _files, byte_count in fetched))


def _context_table(rows, columns):
    table, _json_columns = store_write.rows_to_table(rows, columns, {})
    if rows:
        projects = table.column("__store_project")
        table = table.drop(["__store_project"])
    else:
        projects = store_write.pa.array([], type=store_write.pa.string())
    return table.append_column("_project", projects)


def dump_game(game, root=None, refresh=False, allow_shrink=False,
              allow_missing_events=False, force_early=False, with_test=False, ws=None,
              report_on_window_close=False, interim=False):
    """Capture one complete game's raw telemetry and atomically publish its folder."""
    if interim:
        force_early = True  # an interim store is early by definition: --report --refresh replaces it after settlement
        if report_on_window_close:
            raise store_write.DumpRefused("--interim cannot be combined with --report")
    network = store_paths.NETWORK
    for action in store_paths.recover(game, network, root):
        print(action)
    final = store_paths.game_dir(game, network, root)
    if os.path.exists(final) and not refresh:
        raise store_write.DumpRefused("g%d exists; use --refresh" % game)

    tmp = store_paths.tmp_dir(game, network, root)
    os.makedirs(tmp, exist_ok=False)
    started = time.monotonic()
    checks = []
    phase_seconds = {}
    request_control_started = False
    try:
        sentry.begin_request_control()
        request_control_started = True
        phase_started = time.monotonic()
        report = _load_script("game-report")
        chain_path = os.path.join(tmp, "chain.json")
        chain = (report.run_chain(game, chain_path, ws, interim=True) if interim
                 else report.run_chain(game, chain_path, ws))
        phase_seconds["chain"] = round(time.monotonic() - phase_started, 3)
        w0, w1 = report.chain_window(chain, None)
        late_start = w1
        late_end = w1 + datetime.timedelta(days=7)
        now = datetime.datetime.now(datetime.timezone.utc)
        if report_on_window_close:
            if not chain.get("settlement"):
                raise store_write.DumpRefused(
                    "game %d has not settled; rerun --report after settlement" % game)
            ready_at = w1 + datetime.timedelta(seconds=REPORT_WINDOW_MARGIN_SECONDS)
            wait_seconds = (ready_at - now).total_seconds()
            if wait_seconds > 0:
                print("g%d: waiting %.0f seconds for the report window to close" %
                      (game, wait_seconds))
                time.sleep(wait_seconds)
        if (now < w1 + datetime.timedelta(minutes=15)
                and not force_early and not report_on_window_close):
            raise store_write.DumpRefused("game %d is inside the 15 minute ingest guard" % game)

        paseo_query = "game.index:%d environment:[dim2.paseo,dim2next.paseo]" % game
        production_pid = sentry.PROJECTS["jollity-next"]
        if sentry.count("spans", paseo_query, _iso(w0), _iso(w1),
                        pids=[production_pid]) < 1:
            raise NoPaseoTelemetry({"pass": False,
                "reason": "no paseo telemetry for game %d in its chain window" % game})

        projects = {"jollity-next": production_pid}
        if with_test:
            projects["dim2-testing"] = sentry.PROJECTS["dim2-testing"]
        dataset_manifest = {}
        captured = {}
        late_logs_source = "generic"
        for dataset in ("spans", "errors", "transactions", "tracemetrics", "logs"):
            phase_started = time.monotonic()
            all_rows, per_project, all_columns = [], {}, []
            for slug, pid in projects.items():
                discovery_start = w0 - sentry_logs.CLOCK_LAG_PAD if dataset == "logs" else w0
                columns = discover(dataset, _iso(discovery_start),
                                   _iso(late_end if dataset in ("errors", "logs") else w1), pid)
                all_columns.extend(columns)
                rows, check = dump_dataset(dataset, "", _iso(w0),
                                           _iso(w1), pid, columns)
                checks.append((dataset, slug, "window", check))
                per_project[pid] = {"window": check}
                all_rows.extend(_tag(rows, slug, "window"))
                window_ids = {row.get("id") for row in rows if row.get("id") is not None}
                if dataset == "logs":
                    query = "game.index:%d" % game
                    rows, check = dump_dataset(dataset, query, _iso(discovery_start),
                                               _iso(w0), pid, columns)
                    overlap_rows_dropped = sum(row.get("id") in window_ids for row in rows)
                    rows = [row for row in rows if row.get("id") not in window_ids]
                    check = dict(check)
                    check["overlap_rows_dropped"] = overlap_rows_dropped
                    check["rows_written"] = len(rows)
                    checks.append((dataset, slug, "pre_window", check))
                    per_project[pid]["pre_window"] = check
                    all_rows.extend(_tag(rows, slug, "pre_window"))
                if dataset in ("errors", "logs"):
                    query = "game.index:%d" % game
                    if dataset == "logs" and ("sentry_logs" in sys.modules or
                                               os.path.exists(os.path.join(os.path.dirname(__file__), "sentry_logs.py"))):
                        log_module = _load_script("sentry_logs")
                        rows, check = _dump_late_logs(log_module, game, query, _iso(late_start),
                                                     _iso(late_end), pid, columns)
                        late_logs_source = "sentry_logs"
                    else:
                        rows, check = dump_dataset(dataset, query, _iso(late_start), _iso(late_end), pid, columns)
                    overlap_rows_dropped = sum(row.get("id") in window_ids for row in rows)
                    rows = [row for row in rows if row.get("id") not in window_ids]
                    check = dict(check)
                    check["overlap_rows_dropped"] = overlap_rows_dropped
                    check["rows_written"] = len(rows)
                    checks.append((dataset, slug, "late", check))
                    per_project[pid]["late"] = check
                    all_rows.extend(_tag(rows, slug, "late"))
            columns = list(dict.fromkeys(all_columns))
            table, json_columns = _raw_table(all_rows, columns)
            store_write.write_parquet(table, os.path.join(tmp, dataset + ".parquet"))
            dataset_manifest[dataset] = {"file": dataset + ".parquet", "json_columns": json_columns,
                                         "renamed_columns": {}, "per_project": per_project}
            captured[dataset] = all_rows
            phase_seconds[dataset] = round(time.monotonic() - phase_started, 3)

        phase_started = time.monotonic()
        event_rows, missing_events = _bulk_error_json_rows(
            captured["errors"], {"window": (w0, w1), "late": (late_start, late_end)},
            game, allow_missing_events)
        preserved_transactions = []
        captured_transaction_ids = {row["id"] for row in captured["transactions"]}
        old_events_path = os.path.join(final, "events_json.parquet")
        if refresh and os.path.exists(old_events_path):
            preserved_transactions = _preserved_transaction_rows(
                store_write.pq.read_table(old_events_path).to_pylist(),
                captured_transaction_ids,
            )
            event_rows.extend(preserved_transactions)
        successful_transaction_ids = {
            row["id"] for row in preserved_transactions if row.get("status") == 200
        }
        report_sources = [
            row for row in _report_transaction_sources(captured["transactions"])
            if row["id"] not in successful_transaction_ids
        ]
        report_rows, _report_missing = _detail_json_rows(
            report_sources, "transactions", False)
        report_ids = {row["id"] for row in report_rows}
        event_rows = [row for row in event_rows if row.get("id") not in report_ids]
        event_rows.extend(report_rows)
        successful_transaction_ids |= report_ids
        pending_transaction_ids = captured_transaction_ids - successful_transaction_ids
        store_write.write_parquet(
            store_write.blob_table(event_rows, EVENT_JSON_SCHEMA),
            os.path.join(tmp, "events_json.parquet"),
        )
        dataset_manifest["events_json"] = {
            "rows": len(event_rows), "rows_stored": len(event_rows),
            "missing": missing_events, "errors_complete": not missing_events,
            "transactions_complete": not pending_transaction_ids,
            "pending_transactions": len(pending_transaction_ids),
        }
        phase_seconds["events_json"] = round(time.monotonic() - phase_started, 3)

        phase_started = time.monotonic()
        attachment_rows, attachment_events, attachment_files, attachment_bytes = \
            _attachment_rows(captured["errors"], missing_events)
        store_write.write_parquet(
            store_write.blob_table(attachment_rows, ATTACHMENT_SCHEMA),
            os.path.join(tmp, "attachments.parquet"),
        )
        dataset_manifest["attachments"] = {
            "events": attachment_events, "files": attachment_files,
            "bytes": attachment_bytes, "rows_stored": len(attachment_rows),
        }
        phase_seconds["attachments"] = round(time.monotonic() - phase_started, 3)

        phase_started = time.monotonic()
        report_end = w1.strftime("%Y-%m-%dT%H:%M:%S")
        context_start = (w1 - datetime.timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%S")
        username_rows, username_duplicates = [], 0
        username_fields = ["user.id", "user.username", "count()"]
        for slug, pid in projects.items():
            for dataset in ("spans", "errors"):
                rows, check = dump_grouped(dataset, "has:user.username", username_fields,
                                           context_start, report_end, pid)
                checks.append(("context_usernames", slug, dataset, check))
                username_duplicates += check["duplicates"]
                username_rows.extend({**row, "dataset": dataset, "__store_project": slug}
                                     for row in rows)
        store_write.write_parquet(
            _context_table(username_rows, [
                ("user.id", "string"), ("user.username", "string"),
                ("count()", "number"), ("dataset", "string"),
            ]),
            os.path.join(tmp, "context_usernames.parquet"),
        )
        dataset_manifest["context_usernames"] = {
            "start": context_start, "end": report_end, "rows": len(username_rows),
            "duplicates": username_duplicates,
        }

        release_rows, release_duplicates = [], 0
        release_fields = ["release", "count(value)"]
        for slug, pid in projects.items():
            rows, check = dump_grouped(
                "tracemetrics", "metric.name:[rtc.video_ms,rtc.present_ms]",
                release_fields, context_start, report_end, pid,
            )
            checks.append(("context_releases", slug, "window", check))
            release_duplicates += check["duplicates"]
            release_rows.extend({**row, "__store_project": slug} for row in rows)
        store_write.write_parquet(
            _context_table(release_rows, [
                ("release", "string"), ("count(value)", "number"),
            ]),
            os.path.join(tmp, "context_releases.parquet"),
        )
        dataset_manifest["context_releases"] = {
            "start": context_start, "end": report_end, "rows": len(release_rows),
            "duplicates": release_duplicates,
        }
        phase_seconds["context"] = round(time.monotonic() - phase_started, 3)

        # the hosts' reminder events, from 24 h back because phones book at registration (optional: a failure is recorded in the manifest, never fails the dump)
        try:
            host_reminders = sentry.host_reminder_events((w0 - datetime.timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%S"), w1.strftime("%Y-%m-%dT%H:%M:%S"))
            store_paths.write_json(os.path.join(tmp, "host_reminders.json"), host_reminders)
            host_reminders_manifest = {"file": "host_reminders.json", "events": len(host_reminders)}
        except sentry.OutOfStore:
            raise
        except Exception as error:
            host_reminders_manifest = {"error": str(error)[:200]}

        game_links = _load_script("game-links")
        inputs = {"usernames": _read_json(store_paths.usernames_path(), {}),
                  "siblingUsernames": game_links.usernames_under(os.path.join(store_paths.main_checkout(), "docs-internal", "game-logs"))}
        store_paths.write_json(os.path.join(tmp, "inputs.json"), inputs)

        pulled = datetime.datetime.now(datetime.timezone.utc)
        with open(chain_path, "rb") as chain_file:
            chain_bytes = chain_file.read()
        requests = sentry.request_stats()
        manifest = {
            "store_schema": 1, "tool": "store_dump", "tool_version": 1,
            "scripts_sha": _git("rev-parse", "HEAD"),
            "scripts_dirty": bool(_git("status", "--porcelain", "--", ".claude/skills/dim2-sentry")),
            "network": network, "game": game,
            "pulled_at_utc": _iso(pulled), "pulled_at_local": store_write.local_label(pulled),
            "data_as_of_utc": _iso(pulled), "data_as_of_local": store_write.local_label(pulled),
            "window": {"start_utc": _iso(w0), "end_utc": _iso(w1), "late_end_utc": _iso(late_end),
                       "start_local": store_write.local_label(w0), "end_local": store_write.local_label(w1),
                       "report_start": w0.strftime("%Y-%m-%dT%H:%M:%S"),
                       "report_end": w1.strftime("%Y-%m-%dT%H:%M:%S")},
            "late_complete": pulled >= late_end, "late_logs_source": late_logs_source,
            "early": bool(force_early),
            "report_window_closed": bool(
                chain.get("settlement") and (report_on_window_close or pulled >= w1)),
            "report_ready": True,
            "raw_complete": not pending_transaction_ids and not missing_events,
            "projects": projects, "datasets": dataset_manifest,
            "inputs": {"file": "inputs.json"},
            "host_reminders": host_reminders_manifest,
            "chain": {"file": "chain.json", "sha256": hashlib.sha256(chain_bytes).hexdigest()},
            "api_calls": requests.get("attempts", 0),
            "performance": {"phase_seconds": phase_seconds, "requests": requests},
            "minutes": round((time.monotonic() - started) / 60, 2),
            "bytes": 0, "pass": True,
        }
        manifest_path = os.path.join(tmp, "manifest.json")
        for _attempt in range(3):
            store_paths.write_json(manifest_path, manifest)
            total = _file_bytes(tmp)
            if total == manifest["bytes"]:
                break
            manifest["bytes"] = total
        store_paths.write_json(manifest_path, manifest)
        old_manifest = _read_json(os.path.join(final, "manifest.json"), {})
        store_write.commit_game_dir(tmp, final, refresh, old_manifest, manifest,
                                    game, network, root, allow_shrink)
        _print_checks(checks)
        return final
    except BaseException:
        try:
            shutil.rmtree(tmp)
        except OSError as cleanup_error:
            print("warning: could not clean %s (%s)" % (tmp, cleanup_error), file=sys.stderr)
        for _dataset, _slug, _part, check in checks:
            print(json.dumps(check, sort_keys=True), file=sys.stderr)
        raise
    finally:
        if request_control_started:
            sentry.end_request_control()


def _replace_parquet(path, rows, schema):
    """Atomically replace one mutable enrichment file inside a report-ready store."""
    temporary = "%s.tmp-%d" % (path, os.getpid())
    try:
        store_write.write_parquet(store_write.blob_table(rows, schema), temporary)
        os.chmod(temporary, 0o444)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _replace_manifest(directory, manifest):
    path = os.path.join(directory, "manifest.json")
    temporary = "%s.tmp-%d" % (path, os.getpid())
    try:
        old_size = os.path.getsize(path)
        for _attempt in range(3):
            store_paths.write_json(temporary, manifest)
            total = _file_bytes(directory) - old_size
            if total == manifest.get("bytes"):
                break
            manifest["bytes"] = total
        store_paths.write_json(temporary, manifest)
        os.chmod(temporary, 0o444)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def complete_raw_details(game, root=None, allow_missing_events=False):
    """Resume deferred transaction-detail capture without delaying a stored report."""
    directory = store_paths.game_dir(game, root=root)
    manifest_path = os.path.join(directory, "manifest.json")
    manifest = _read_json(manifest_path, {})
    if not manifest.get("report_ready") or not manifest.get("pass"):
        raise store_write.DumpRefused("g%d is not a passing report-ready store" % game)
    if manifest.get("raw_complete"):
        return directory

    transactions_path = os.path.join(directory, "transactions.parquet")
    events_path = os.path.join(directory, "events_json.parquet")
    transactions = store_write.pq.read_table(transactions_path).to_pylist()
    existing = store_write.pq.read_table(events_path).to_pylist()
    existing_transactions = {row["id"] for row in existing
                             if row.get("dataset") == "transactions" and row.get("status") == 200}
    pending = [{"id": row["id"], "__store_project": row["_project"]}
               for row in transactions if row.get("id") not in existing_transactions]

    started = time.monotonic()
    sentry.begin_request_control()
    try:
        dataset = manifest["datasets"]["events_json"]
        api_calls_before = int(manifest.get("api_calls") or 0)
        rows_added = 0
        missing_error_sources = [
            {"id": row["id"], "__store_project": row["project"]}
            for row in existing
            if row.get("dataset") == "errors" and row.get("status") != 200
        ]
        if missing_error_sources:
            retried_errors, _still_missing = _detail_json_rows(
                missing_error_sources, "errors", allow_missing_events)
            retried_ids = {row["id"] for row in retried_errors}
            existing = [row for row in existing if row.get("id") not in retried_ids]
            existing.extend(retried_errors)
            rows_added += len(retried_errors)
            _replace_parquet(events_path, existing, EVENT_JSON_SCHEMA)
        chunks = [pending[index:index + RAW_CHECKPOINT_ROWS]
                  for index in range(0, len(pending), RAW_CHECKPOINT_ROWS)] or [[]]
        for chunk in chunks:
            added, missing = _detail_json_rows(chunk, "transactions", allow_missing_events)
            added_ids = {row["id"] for row in added}
            existing = [row for row in existing if row.get("id") not in added_ids] + added
            rows_added += len(added)
            if added:
                _replace_parquet(events_path, existing, EVENT_JSON_SCHEMA)

            successful = {row["id"] for row in existing
                          if row.get("dataset") == "transactions" and row.get("status") == 200}
            pending_ids = {row["id"] for row in transactions} - successful
            remaining_missing = list(dict.fromkeys(
                row["id"] for row in existing if row.get("status") != 200))
            dataset.update({
                "rows": len(existing), "rows_stored": len(existing),
                "missing": remaining_missing,
                "errors_complete": not any(
                    row.get("dataset") == "errors" and row.get("status") != 200
                    for row in existing),
                "transactions_complete": not pending_ids,
                "pending_transactions": len(pending_ids),
            })
            finished = datetime.datetime.now(datetime.timezone.utc)
            stats = sentry.request_stats()
            manifest["raw_complete"] = not pending_ids and not remaining_missing
            manifest["raw_completed_at_utc"] = _iso(finished) if manifest["raw_complete"] else None
            manifest["raw_completed_at_local"] = \
                store_write.local_label(finished) if manifest["raw_complete"] else None
            manifest.setdefault("performance", {})["raw_completion"] = {
                "seconds": round(time.monotonic() - started, 3), "requests": stats,
                "rows_added": rows_added,
            }
            manifest["api_calls"] = api_calls_before + int(stats.get("attempts") or 0)
            _replace_manifest(directory, manifest)
        if not manifest.get("raw_complete"):
            raise store_write.DumpRefused(
                "g%d raw details remain incomplete; rerun --complete-raw" % game)
        return directory
    finally:
        sentry.end_request_control()


def run_report_flow(game, root=None, refresh=False, allow_shrink=False,
                    allow_missing_events=False, with_test=False, ws=None):
    """Build the report at store readiness, then finish retained raw evidence."""
    root = os.path.abspath(root) if root else store_paths.store_root()
    for action in store_paths.recover(game, store_paths.NETWORK, root):
        print(action)
    directory = store_paths.game_dir(game, root=root)
    manifest_path = os.path.join(directory, "manifest.json")
    if refresh or not os.path.exists(directory):
        directory = dump_game(
            game, root=root, refresh=refresh, allow_shrink=allow_shrink,
            allow_missing_events=allow_missing_events, with_test=with_test, ws=ws,
            report_on_window_close=True,
        )
    manifest = _read_json(manifest_path, {})
    if manifest.get("early") is True:
        raise store_write.DumpRefused(
            "g%d existing store is early; rerun --report --refresh" % game)
    if manifest.get("pass") is not True or manifest.get("report_ready") is not True:
        raise store_write.DumpRefused(
            "g%d existing store is not report-ready; rerun --report --refresh" % game)
    chain_file = manifest.get("chain", {}).get("file", "chain.json")
    chain = _read_json(os.path.join(directory, chain_file), {})
    if not chain.get("settlement"):
        raise store_write.DumpRefused(
            "g%d existing store used a fallback window; rerun --report --refresh" % game)

    command = [sys.executable, REPORT, str(game), "--from-store", "--store-root", root]
    report = subprocess.run(command, cwd=REPO, check=False)
    # Retention completion is independent of report assembly success. A report bug must
    # not strand the raw evidence; the next invocation can resume either stage safely.
    completion_error = None
    try:
        complete_raw_details(game, root=root, allow_missing_events=allow_missing_events)
    except Exception as error:  # report and retention are independent outcomes
        completion_error = error
    if report.returncode:
        print("g%d report failed with exit %d" % (game, report.returncode), file=sys.stderr)
        if completion_error:
            print("g%d raw completion also failed: %s" % (game, completion_error),
                  file=sys.stderr)
        return report.returncode
    if completion_error:
        raise completion_error
    return report.returncode


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("game", type=int, nargs="?")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--backfill", action="store_true")
    modes.add_argument("--due", action="store_true")
    modes.add_argument("--watch", action="store_true")
    modes.add_argument("--complete-raw", action="store_true")
    modes.add_argument("--report", action="store_true",
                       help="dump now, run the stored report, then resume raw details")
    parser.add_argument("--from", dest="from_game", type=int)
    parser.add_argument("--to", dest="to_game", type=int)
    parser.add_argument("--sleep", type=float, default=30)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--allow-shrink", action="store_true")
    parser.add_argument("--allow-missing-events", action="store_true")
    parser.add_argument("--force-early", action="store_true")
    parser.add_argument("--interim", action="store_true",
                        help="read the chain as of kickoff + 3 min (before the 1-hour settle) and dump early; implies --force-early")
    parser.add_argument("--with-test-project", action="store_true")
    parser.add_argument("--root")
    parser.add_argument("--ws")
    args = parser.parse_args(argv)
    if args.backfill:
        if args.game is not None:
            parser.error("game cannot be used with --backfill")
        return run_backfill(args.root, args.from_game, args.to_game, args.sleep, args.ws)
    if args.due:
        if args.game is not None:
            parser.error("game cannot be used with --due")
        print_due(args.root)
        return 0
    if args.watch:
        if args.game is not None:
            parser.error("game cannot be used with --watch")
        retention_watch()
        return 0
    if args.complete_raw:
        if args.game is None:
            parser.error("game is required with --complete-raw")
        try:
            print(complete_raw_details(args.game, args.root, args.allow_missing_events))
            return 0
        except store_write.DumpRefused as error:
            print(error, file=sys.stderr)
            return 2
        except Exception as error:
            print(error, file=sys.stderr)
            return 1
    if args.report:
        if args.game is None:
            parser.error("game is required with --report")
        try:
            return run_report_flow(
                args.game, args.root, args.refresh, args.allow_shrink,
                args.allow_missing_events, args.with_test_project, args.ws,
            )
        except store_write.DumpRefused as error:
            print(error, file=sys.stderr)
            return 2
        except Exception as error:
            print(error, file=sys.stderr)
            return 1
    if args.game is None:
        parser.error("game is required unless --backfill, --due, or --watch is used")
    if args.from_game is not None or args.to_game is not None or args.sleep != 30:
        parser.error("--from, --to, and --sleep require --backfill")
    try:
        print(dump_game(args.game, args.root, args.refresh, args.allow_shrink,
                        args.allow_missing_events, args.force_early,
                        args.with_test_project, args.ws, interim=args.interim))
        return 0
    except NoPaseoTelemetry as error:
        print(error.check["reason"], file=sys.stderr)
        return 3
    except store_write.DumpRefused as error:
        print(error, file=sys.stderr)
        return 2
    except Exception as error:
        print(error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
