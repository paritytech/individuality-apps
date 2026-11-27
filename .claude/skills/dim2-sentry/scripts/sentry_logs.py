"""Read packed game-log records from Sentry Logs and restore legacy shapes.

Queries use the organization events endpoint with dataset=logs and call-time projects.
The requested sort field is selected too; pages of 1000 follow sentry.py's timeout/retry/Link path.
String attributes filter by bare name; integer attributes use tags[name,number]. Bodies follow
log-envelope.ts; retry identity is (game_log.item, game_log.record), never timestamp or event id.
"""
import collections
import datetime
import json
import re
import sentry

LOG_FIELDS = [
    "id", "timestamp", "message", "user.id", "session.id", "game.index", "game_log.stage",
    "game_log.item", "game_log.record", "game_log.records", "game_log.checkpoint", "game_log.seq",
    "game_log.part", "game_log.parts", "game_log.copy", "game_log.full_stage", "game_log.begin",
    "app.version", "test.tag", "tags[game_log.first_ts_ms,number]"]
OBSERVED_FIELD, CAPTURED_FIELD = "sentry.observed_timestamp_nanos", "tags[game_log.captured_ms,number]"
CLOCK_LAG_PAD = datetime.timedelta(hours=12)
LOG_FIELDS += [OBSERVED_FIELD, CAPTURED_FIELD]
META_TAG, EVICTED_TAG = "game-log.meta", "game-log.evicted"
LINE_RE = re.compile(r"^(\S+)\s+(\S+)\s+(.*)$")
LINE_ID_RE = re.compile(r"^\[([^\]]+)\]\s+(.*)$")
ESCAPE_RE = re.compile(r"\\([\\nrt])")

EVENT_TITLES = {"telemetry.health", "signup-broadcast", "camera-trail", "chain.health",
                "previous-session-end", "storage-slow"}
HEALTH_NUMERIC = (
    "failed_fetch", "failed_4xx", "failed_429", "failed_5xx", "failed_timeout", "retries",
    "dropped_events", "dropped_metrics", "offline_ms", "recovered_timeouts", "longest_wait_ms",
    "unknown_lanes", "failed_429_server", "failed_429_local", "limited_2xx",
)
HEALTH_TEXT = ("rate_limit_last", "rate_limit_reasons")
EVENT_FIELDS = [
    "id", "timestamp", "timestamp_precise", "message", "severity", "user.id", "user.name", "session.id", "game.index", "previous.game", "test.tag",
    "failure.kind", "failure.reason", "journey.expected", "tags[telemetry.health_late,boolean]",
    "chain.health.error", "chain.health.outcome", "tags[chain.health.stall_ms,number]",
] + [f"tags[telemetry_health.{name},number]" for name in HEALTH_NUMERIC] \
  + [f"tags[telemetry_health.session.{name},number]" for name in HEALTH_NUMERIC] \
  + [f"telemetry_health.{name}" for name in HEALTH_TEXT] \
  + [f"telemetry_health.session.{name}" for name in HEALTH_TEXT]


def _health(row):
    health, session = {}, {}
    for name in HEALTH_NUMERIC:
        value = _integer(row.get(f"tags[telemetry_health.{name},number]"))
        if value is not None:
            health[name] = value
        value = _integer(row.get(f"tags[telemetry_health.session.{name},number]"))
        if value is not None:
            session[name] = value
    for name in HEALTH_TEXT:
        value = row.get(f"telemetry_health.{name}")
        if value not in (None, ""):
            health[name] = value
        value = row.get(f"telemetry_health.session.{name}")
        if value not in (None, ""):
            session[name] = value
    if session:
        health["session"] = session
    return health or None


def _timestamp_key(value):
    try:
        parsed = sentry.parse_ts(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=datetime.timezone.utc)
        return int(parsed.timestamp())
    except (AttributeError, TypeError, ValueError):
        return str(value or "").replace("+00:00", "Z")


def event_rows(user_id, start, end, game=None, untagged_from=None, _events_all=None):
    """Non-game-log Logs restored to game-report-pull's legacy event detail shape."""
    fetch = _events_all or sentry.events_all
    query = f"user.id:{user_id} !has:game_log.item"
    rows = fetch("logs", query, EVENT_FIELDS, sort="timestamp", per_page=1000, start=start, end=end)
    out = []
    seen_ids, seen_precise = set(), set()
    for row in rows:
        row_id, precise = row.get("id"), row.get("timestamp_precise")
        if (row_id and row_id in seen_ids) or (precise and precise in seen_precise):
            continue
        if row_id:
            seen_ids.add(row_id)
        if precise:
            seen_precise.add(precise)
        if game is not None and row.get("game.index") not in (None, "", str(game), game):
            continue
        if (game is not None and row.get("game.index") in (None, "") and untagged_from and
                _timestamp_key(row.get("timestamp")) < _timestamp_key(untagged_from)):
            continue
        title = str(row.get("message") or "").split("\t", 1)[0]
        failure = {name: row.get(f"failure.{name}") for name in ("kind", "reason") if row.get(f"failure.{name}") not in (None, "")}
        if title not in EVENT_TITLES and not failure:
            continue
        late = row.get("tags[telemetry.health_late,boolean]", row.get("telemetry.health_late"))
        level = row.get("severity", row.get("level"))
        out.append({"timestamp": row.get("timestamp"), "title": title, "session.id": row.get("session.id"),
                    "previous.game": row.get("previous.game"),
                    "level": "warning" if level == "warn" else level,
                    "failure": failure or None, "telemetryHealth": _health(row),
                    "telemetryHealthLate": late is True or str(late).lower() == "true", "exception": [],
                    # chain.health keeps its error in an attribute (pb#76's text); known_platform_errors reads it here
                    **({"chainHealthError": row["chain.health.error"]} if row.get("chain.health.error") else {}),
                    **({"chainHealthOutcome": row["chain.health.outcome"]} if row.get("chain.health.outcome") else {})})
    return out


def merge_event_rows(legacy, logs, user_id):
    """Stable legacy-first union; delivery retries do not double-count an event."""
    out = list(legacy)
    legacy_counts = collections.Counter(
        (row.get("title"), _timestamp_key(row.get("timestamp")), user_id) for row in out)
    for row in logs:
        key = (row.get("title"), _timestamp_key(row.get("timestamp")), user_id)
        if legacy_counts[key]:
            legacy_counts[key] -= 1
            continue
        out.append(row)
    return out


def chat_metric_rows(query, groups, start, end, _events_all=None, _metric_groups=None, **window):
    """Chat-worker counter metrics normalized to the event/span aggregate row shape."""
    fetch = _events_all or sentry.events_all
    scope = "sentry.sdk.name:jollity.chat-worker has:user.id"
    fields = ["user.id", "user.name", "metric.name", *groups, "count(value)", "sum(value)"]
    scoped_query = f"{scope} {query}".strip()
    if _metric_groups is not None:
        rows = _metric_groups(scoped_query, fields, start, end)
    else:
        params = {"per_page": 1000, **window}
        if start is not None:
            params["start"] = start
        if end is not None:
            params["end"] = end
        rows = fetch("tracemetrics", scoped_query, fields, **params)
    return [{"user.id": row.get("user.id"), "user.name": row.get("user.name"),
             "name": row.get("metric.name"), **{group: row.get(group) for group in groups},
             "count()": row.get("sum(value)"), "first": None, "last": None} for row in rows]
def log_request(game, start):
    """Return the exact query and padded start used for packed game logs."""
    query = f"game.index:{game} has:game_log.item"
    try:
        start = (sentry.parse_ts(start) - CLOCK_LAG_PAD).strftime("%Y-%m-%dT%H:%M:%S")
    except (TypeError, ValueError):
        pass
    return query, start


def log_rows(game, start, end, pids=None, _events_all=None):
    """Every packed game-log record for one game, through shared paging."""
    query, start = log_request(game, start)
    if pids is None:
        # Keep game-report-pull's existing imported events_all test seam.
        fetch = _events_all or sentry.events_all
        return fetch("logs", query, LOG_FIELDS, sort="-timestamp", per_page=1000, start=start, end=end)
    out = []
    for page in sentry.pages(
            "logs", query, LOG_FIELDS,
            sort="-timestamp", per_page=1000, start=start, end=end, pids=pids):
        out.extend(page)
    return out
def _unescape(text):
    return ESCAPE_RE.sub(lambda found: {"\\": "\\", "n": "\n", "r": "\r", "t": "\t"}[found.group(1)], text)
def _restore_data(text):
    """Restore the object/array shape the packed writer serializes.

    The wire carries data as text.  JSON primitives are ambiguous with native
    string payloads (notably "123"), so they deliberately remain strings.
    """
    stripped = text.lstrip()
    if not stripped.startswith(("{", "[")):
        return text
    try:
        parsed = json.loads(text)
    except (TypeError, ValueError):
        return text
    return parsed if isinstance(parsed, (dict, list)) else text
def parse_body(body, session_id):
    """Turn one packed body into the legacy entry shape."""
    entries = []
    for raw_line in str(body or "").split("\n"):
        if not raw_line:
            continue
        text, separator, data_text = raw_line.partition("\t")
        found = LINE_RE.match(text)
        if not found:
            continue
        timestamp, level, rest = found.groups()
        line_id = None
        identified = LINE_ID_RE.match(rest)
        if identified:
            line_id, rest = identified.groups()
        tag, marker, message = rest.partition(": ")
        if not marker:
            continue
        try:
            ts = round(sentry.parse_ts(timestamp).timestamp() * 1000)
        except (TypeError, ValueError):
            continue
        entry = {"ts": ts, "sessionId": str(session_id or ""), "level": level,
                 "tag": _unescape(tag), "message": _unescape(message)}
        if line_id:
            entry["_deliveryId"] = _unescape(line_id)
        if separator:
            entry["data"] = _restore_data(_unescape(data_text))
        entries.append(entry)
    return entries
def _integer(value, default=None):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
def _specials(entries):
    normal, header, evicted = [], {}, []
    for entry in entries:
        data = entry.get("data")
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except (TypeError, ValueError):
                pass
        if entry.get("tag") == META_TAG:
            if isinstance(data, dict):
                header.update(data)
        elif entry.get("tag") == EVICTED_TAG:
            if isinstance(data, list):
                evicted.extend(item for item in data if isinstance(item, dict))
        else:
            normal.append(entry)
    return normal, header, evicted
def records_to_items(rows):
    """Restore durable chunks/full parts per user and report record holes."""
    grouped = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        uid, item = row.get("user.id"), row.get("game_log.item")
        record = _integer(row.get("game_log.record"))
        if not uid or not item or record is None:
            continue
        key = (str(uid), str(item))
        state = grouped.setdefault(key, {"records": {}, "expected": 0})
        state["expected"] = max(state["expected"], _integer(row.get("game_log.records"), 0) or 0)
        state["records"].setdefault(record, row)  # retries: same item+record counts once
    users = {}
    for (uid, item), state in sorted(grouped.items()):
        user = users.setdefault(uid, {"chunks": [], "full": {}, "missing": []})
        missing = [index for index in range(state["expected"]) if index not in state["records"]]
        user["missing"].extend((item, index) for index in missing)
        ordered = [state["records"][index] for index in sorted(state["records"])]
        entries = []
        for row in ordered:
            parsed = parse_body(row.get("message", ""), row.get("session.id", ""))
            entries.extend(parsed)
        normal, header, evicted = _specials(entries)
        first = ordered[0]
        stage = first.get("game_log.stage")
        observed = [_integer(row.get(OBSERVED_FIELD)) for row in ordered]
        received = max((value // 1_000_000 for value in observed if value is not None), default=None)
        captured = _integer(first.get(CAPTURED_FIELD), _integer(first.get("tags[game_log.first_ts_ms,number]")))
        if stage == "chunk":
            chunk = {"schema": 1, "id": item, "beginId": first.get("game_log.begin"),
                     "gameIndex": _integer(first.get("game.index")), "sessionId": first.get("session.id"),
                     "account": uid, "seq": _integer(first.get("game_log.seq")), "part": _integer(first.get("game_log.part")),
                     "checkpoint": first.get("game_log.checkpoint"),
                     "capturedAt": captured, "lines": normal, "_recordsComplete": not missing}
            if normal:
                chunk["from"], chunk["to"] = normal[0]["ts"], normal[-1]["ts"]
            if evicted:
                chunk["evictedOnDevice"] = evicted
            chunk["_receivedAt"] = received
            user["chunks"].append(chunk)
            continue
        if stage != "full":
            continue
        copy_id = str(first.get("game_log.copy") or item)
        part = _integer(first.get("game_log.part"), 0)
        parts = _integer(first.get("game_log.parts"))
        document = {**header, "entries": normal,
                    "gameLogPart": {"schema": 1, "copyId": copy_id, "part": part, "parts": parts}}
        if evicted:
            meta = document.setdefault("meta", {})
            if not isinstance(meta, dict):
                meta = document["meta"] = {}
            meta["evictedOnDevice"] = evicted
        full = user["full"].setdefault(copy_id, {"parts": parts, "stage": first.get("game_log.full_stage"), "documents": {}, "received": [], "complete": {}})
        full["documents"][part] = document
        full["complete"][part] = not missing
        if received:
            full["received"].append(received)
    for user in users.values():
        user["chunks"].sort(key=lambda chunk: (str(chunk.get("beginId") or ""), chunk.get("seq") or 0, chunk.get("part") or 0, chunk.get("id") or ""))
    return users
def merge_line_sources(sources, fallback_key=None, strip_identity=True):
    """Take each capture id once across copies; preserve legacy occurrence counts."""
    fallback_key = fallback_key or (lambda entry: tuple(
        entry.get(key) for key in ("ts", "sessionId", "tag", "message")))
    counts, exemplar = collections.Counter(), {}
    for source in sources:
        current = collections.Counter()
        for entry in source:
            delivery_id = entry.get("_deliveryId")
            key = ("delivery", delivery_id) if delivery_id else ("legacy", fallback_key(entry))
            if delivery_id:
                current[key] = 1
            else:
                current[key] += 1
            exemplar.setdefault(key, entry)
        counts |= current
    out = [{name: value for name, value in exemplar[key].items()
            if not strip_identity or name != "_deliveryId"}
           for key, count in counts.items() for _ in range(count)]
    return sorted(out, key=lambda entry: (entry.get("ts", 0), entry.get("sessionId", ""),
                                          entry.get("tag", ""), entry.get("message", "")))
def legacy_shape(items):
    """The old fetch_logs result shape, for Logs-only callers and tests."""
    shaped = {}
    for uid, state in items.items():
        chunk_entries = [entry for chunk in state.get("chunks", []) for entry in chunk.get("lines", [])]
        sources = [chunk_entries] if chunk_entries else []
        meta, evicted = {"address": uid}, []
        for copy_id in sorted(state.get("full", {})):
            full = state["full"][copy_id]
            documents = full.get("documents", {})
            entries = []
            for part in sorted(documents):
                document = documents[part]
                document_meta = document.get("meta")
                if isinstance(document_meta, dict):
                    meta.update(document_meta)
                    evicted.extend(document_meta.get("evictedOnDevice") or [])
                entries.extend(document.get("entries") or [])
            if entries:
                sources.append(entries)
        evicted.extend(item for chunk in state.get("chunks", []) for item in chunk.get("evictedOnDevice", []))
        if evicted:
            meta["evictedOnDevice"] = list({item.get("id"): item for item in evicted if isinstance(item, dict)}.values())
        if state.get("missing"):
            meta["missingRecords"] = list(state["missing"])
        shaped[uid] = {"meta": meta, "entries": merge_line_sources(sources)}
    return shaped
