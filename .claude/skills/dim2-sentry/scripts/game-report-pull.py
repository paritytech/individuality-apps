"""Pull everything Sentry has for one game.

Usage: python3 game-report-pull.py <game> <window-start ISO UTC> <window-end ISO UTC> <out.json>
Window: from about 20 minutes before kickoff to about 10 minutes after settlement.
(game-report.py gets the window from the chain and calls fetch_logs() and pull() below; this CLI is the manual way.)

Players = every user.id seen on spans/events tagged game.index:<game>, plus any account
in the room key of a game log, plus any account the caller passes in (the chain's
registered players). Per player: every root span of the game, the child steps inside those
roots, every error/info event (with failure context), the device profile, payoff facts, `bot` (the e2e- test.tag of a scripted run, else null), the
metrics of the sessions that carried game.index:<game>, the page opens from a notification and the returns to the app
(`foreground`), and the game-log attachment's meta
(entry count, username, stage, and whether it is a full log). `sliceReleases` lists the builds that emitted coverage slices in the 30 days before the window ends. Rows tagged with ANOTHER game's index are dropped. The token and API
helpers come from sentry.py.
"""
import concurrent.futures, importlib.util, ipaddress, json, os, re, sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sentry
import sentry_logs
import agg
from sentry import events as _events, events_all, get, parse_ts
import datetime


def _event(row, suffix="", raw=False):
    """One event's detail or attachment, in the project the row came from (sentry.event_get: a read can
    span dim2-testing and jollity-next). Goes through this module's get so tests can stand in for it."""
    return sentry.event_get(row["id"], suffix, raw=raw, row=row, fetch=lambda url, raw=False: get(url, raw=raw))


WORKERS = 4
ROOT_FIELDS = ["id", "timestamp", "environment", "span.op", "journey.outcome", "journey.sad", "journey.sad_reason", "journey.expected",
               "journey.recovered", "journey.previous_session_id", "wall.time.start", "wall.time.end",
               "span.duration", "host.kind", "host.app", "host.app_version", "device.os", "device.os_version", "device.model",
               "device.gpu", "device.cores", "device.memory", "net.type", "net.effective", "env.source", "session.id",
               "telemetry.grant", "signup.route", "signup.stage", "draw.entered", "draw.skipped", "person.stage",
               "permissions.step", "permissions.reason", "camera.warm", "user.username", "release", "game.index", "test.tag",
               "sdk.name", "surface", "join.first_link_ms", "join.all_links_ms"]
STEP_FIELDS = ["id", "timestamp", "transaction", "span.op", "span.duration", "rtc.path", "rtc.outcome", "camera.state", "camera.reason", "user.username", "signup.route"]
METRIC_FIELDS = ["metric.name", "stat", "scene", "moment", "round", "rtc.peer", "rtc.path", "reason", "rtc.signal_peer_present", "p50(value)", "max(value)", "min(value)", "count(value)", "sum(value)", "lowpower", "lowpower.reason", "probe", "probe.version", "probe.threshold_ms", "probe.sample", "probe.rule", "probe.borderline_from_ms", "probe.weak_from_ms", "probe.stage", "probe.attempts"]
COVERAGE_METRIC_FIELDS = ["metric.name", "round", "rtc.peer", "rtc.pair", "count(value)", "sum(value)"]
# separate queries, so adding a group-by field never splits the rows the Links and Video figures read
LINK_PAIR_FIELDS = ["metric.name", "stat", "round", "rtc.pair", "rtc.peer", "p50(value)", "count(value)"]
LINK_KIND_FIELDS = ["round", "rtc.pair", "rtc.peer", "rtc.encoder_kind", "rtc.decoder_kind", "count(value)"]
SEND_RUNGS = ("full", "lean", "low", "minimum", "survival")  # apps/jollity-app/lib/webrtc/send-adaptation-classifier.ts VIDEO_RUNGS, index order
SEND_RUNG_FIELDS = (["id", "timestamp", "game.index", "round", "opening_rung", "min_rung", "max_rung", "closing_rung"]
                    + [f"measurements.rtc.send.rung_{name}_s" for name in SEND_RUNGS]
                    + ["measurements.rtc.send.bandwidth_limited_s", "measurements.rtc.send.step_up_count"])
PAGE_END_FIELDS = [
    "id", "project", "timestamp", "session.id",
    "previous.end", "previous.game", "previous.in_game", "previous.turn", "previous.screen",
    "previous.session.session_id", "previous.session.gap_ms", "previous.session.game_index", "previous.session.open_journeys",
    "previous.session.open_journey_steps",
]
PAGE_END_LOG_FIELDS = [
    "id", "timestamp", "timestamp_precise", "message", "session.id",
    "previous.end", "previous.game", "tags[previous.in_game,boolean]", "previous.turn", "previous.screen",
    "previous.session.session_id", "tags[previous.session.gap_ms,number]", "previous.session.game_index",
    "previous.session.open_journeys", "previous.session.open_journey_steps",
]


stable_sort = sentry.stable_sort  # every paged query sorts stably (sentry.events_all applies it)
METRIC_PAGE = 1000  # tracemetrics answers this many groups a page; paging it 100 at a time repeated and lost groups (game 254)


def metric_groups(query, fields, start, end, page=METRIC_PAGE):
    """Compatibility seam for every report-wide metric aggregate; all now aggregate raw points locally."""
    return local_metric_groups(query, fields, start, end, page)


def grouped_metric_groups(query, fields, start, end, page=METRIC_PAGE):
    """Checked grouped query for set-only release discovery; it publishes no aggregate number."""
    expected_rows = sentry.events(
        "tracemetrics", query, ["count(value)"], start=start, end=end)
    expected = int(float(expected_rows[0].get("count(value)") or 0)) if expected_rows else 0
    for _ in range(2):
        rows = events_all("tracemetrics", query, fields, stable_sort(fields),
                          per_page=page, start=start, end=end)
        got = sum(int(float(row.get("count(value)") or 0)) for row in rows)
        if got == expected:
            return rows
    raise RuntimeError(f"paging returned {got} of {expected} metric points")


def local_metric_groups(query, fields, start, end, page=METRIC_PAGE):
    """Fetch complete raw metric points under a stable row sort, then aggregate identically live and from-store."""
    group_fields = [field for field in fields if "(" not in field]
    agg_fields = [field for field in fields if "(" in field]
    raw_fields = list(dict.fromkeys(group_fields + ["value", "id", "timestamp"]))
    expected_rows = sentry.events(
        "tracemetrics", query, ["count(value)"], start=start, end=end)
    expected = int(float(expected_rows[0].get("count(value)") or 0)) if expected_rows else 0
    for _ in range(2):
        rows = events_all("tracemetrics", query, raw_fields, stable_sort(raw_fields),
                          per_page=page, start=start, end=end)
        if len(rows) == expected:
            return agg.aggregate(rows, group_fields, agg_fields)
    raise RuntimeError(f"paging returned {len(rows)} of {expected} metric points")


FOREGROUND_METRICS = ("app.opened_from_notification", "app.away_ms")
FOREGROUND_FIELDS = ["id", "timestamp", "metric.name", "value", "user.id", "session.id", "game.index",
                     "app.return_source", "notification.moment", "app.suspended"]


def foreground_points(start, end):
    """Every page open from a notification and every return to the app in the window, as raw metric points.

    apps/jollity-app/lib/telemetry/foreground.ts sends app.resumed with each app.away_ms point and the same attributes,
    so the away points alone hold every return. The count is checked as local_metric_groups checks it."""
    query = "metric.name:[" + ",".join(FOREGROUND_METRICS) + "]"
    expected_rows = sentry.events("tracemetrics", query, ["count(value)"], start=start, end=end)
    expected = int(float(expected_rows[0].get("count(value)") or 0)) if expected_rows else 0
    for _ in range(2):
        rows = events_all("tracemetrics", query, FOREGROUND_FIELDS, stable_sort(FOREGROUND_FIELDS),
                          per_page=METRIC_PAGE, start=start, end=end)
        if len(rows) == expected:
            return rows
    raise RuntimeError(f"paging returned {len(rows)} of {expected} foreground points")


def player_foreground(points, acct, sessions, game, untagged_from=None):
    """The foreground points of one account: its own, and those of its page sessions that carry no user.

    An open from a notification is counted before the app knows the player, so only its session ties it to one."""
    return [r for r in points
            if (r.get("user.id") == acct or (not r.get("user.id") and r.get("session.id") in sessions))
            and not other_game(r, game, untagged_from)]


def _links():
    spec = importlib.util.spec_from_file_location("game_links", os.path.join(os.path.dirname(os.path.abspath(__file__)), "game-links.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def bot_tag(*row_lists):
    """The first test.tag starting with e2e- on any row (a scripted run, see apps/jollity-app/lib/telemetry/init.ts), else None.
    The pull never filters on environment (bots run as `local`); a row is kept or dropped by its game.index alone."""
    for rows in row_lists:
        for r in rows:
            t = r.get("test.tag")
            if isinstance(t, str) and t.startswith("e2e-"):
                return t
    return None


def other_game(row, game, untagged_from=None):
    """True when the row is not this game's: it carries another game.index, or it carries none and is older
    than untagged_from (ISO UTC; the chain's registration-open time, so the game before's events drop out)."""
    gi = row.get("game.index")
    if gi not in (None, ""):
        return str(gi) != str(game)
    return bool(untagged_from and row.get("timestamp") and str(row["timestamp"]).replace("+00:00", "") < untagged_from)


def coverage_metrics(sessions, game, start, end):
    """Coverage aggregates for one viewer; one API failure stays local."""
    if not sessions:
        return [], None
    try:
        rows = local_metric_groups("session.id:[" + ",".join(sessions) + f"] game.index:{game} metric.name:[rtc.video_ms,rtc.present_ms]",
                                   COVERAGE_METRIC_FIELDS, start, end)
        return rows, None
    except sentry.OutOfStore:
        raise
    except Exception as error:
        status = getattr(error, "code", None)
        reason = f"coverage query failed{f' (HTTP {status})' if status else ''}"
        print(reason, "for", sessions[0], file=sys.stderr)
        return [], reason


def slice_releases(end):
    """Releases that emitted rtc.video_ms/rtc.present_ms in the 30 days before `end`: the builds that support slices."""
    since = (parse_ts(end) - datetime.timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%S")
    rows = grouped_metric_groups(
        "metric.name:[rtc.video_ms,rtc.present_ms]", ["release", "count(value)"], since, end)
    return sorted({r["release"] for r in rows if r.get("release")})


def step_in_game(step, roots, game):
    """Steps carry no game.index, so a step belongs to the game when its parent journey (the
    `transaction`) has a root tagged with the game and the step falls inside that root's time span."""
    ts = parse_ts(step["timestamp"])
    for r in roots:
        if str(r.get("game.index")) != str(game) or r.get("span.op") != step.get("transaction"):
            continue
        t0 = parse_ts(r["timestamp"])
        dur = datetime.timedelta(milliseconds=float(r.get("span.duration") or 0))
        if t0 - datetime.timedelta(seconds=2) <= ts <= t0 + dur + datetime.timedelta(seconds=2):
            return True
    return False


def game_log_filename(username, account, event_id):
    """Name of a downloaded game log, as in docs-internal/game-logs: <username or account[:8]>-<event id[:8]>.json."""
    return f"{username or account[:8]}-{event_id[:8]}.json"


def stitch_log_chunks(chunks, manifest=()):
    """Return exact-once chronological entries plus checkpoint/sequence coverage.

    Retries can produce more than one Sentry event for the same durable chunk,
    so both chunks and lines are deduplicated by their stable identities before
    reporting. A missing sequence is evidence that the reconstructed log has a
    hole; it is never presented as complete.
    """
    unique_chunks = {}
    for chunk in chunks:
        key = chunk.get("id") or (chunk.get("sessionId"), chunk.get("seq"), chunk.get("part"))
        unique_chunks[key] = chunk
    def begin_id(chunk):
        explicit = chunk.get("beginId")
        if explicit:
            return explicit
        pieces = str(chunk.get("id", "")).split(":")
        return pieces[2] if len(pieces) >= 5 else ""

    ordered = sorted(unique_chunks.values(), key=lambda c: (begin_id(c), c.get("seq", 0), c.get("part", 0), c.get("capturedAt", 0)))
    entries, seen = [], set()
    for chunk in ordered:
        chunk_id = chunk.get("id") or f"{chunk.get('sessionId')}:{chunk.get('seq')}:{chunk.get('part')}"
        delivery_occurrences = Counter()
        for index, entry in enumerate(chunk.get("lines", [])):
            # Identical log lines can be genuine. Only a retry of the same
            # stable chunk/index or the same delivery occurrence in another
            # checkpoint/recovery copy is a duplicate.
            delivery_id = entry.get("_deliveryId") if isinstance(entry, dict) else None
            semantic_id = log_line_key(entry)
            identity = ("delivery", delivery_id) if delivery_id else (("semantic", semantic_id) if semantic_id else None)
            occurrence = delivery_occurrences[identity]
            if identity and not delivery_id:
                delivery_occurrences[identity] += 1
            key = (*identity, occurrence) if identity and not delivery_id else (identity if identity else ("chunk", chunk_id, index))
            if key in seen:
                continue
            seen.add(key)
            normalised = dict(entry)
            if chunk.get("_viaLogs"):
                normalised["_viaLogs"] = True
            data = normalised.get("data")
            if isinstance(data, str):
                try:
                    normalised["data"] = json.loads(data)
                except (TypeError, ValueError):
                    pass
            entries.append(normalised)
    entries.sort(key=lambda e: (e.get("ts", 0), e.get("sessionId", ""), e.get("tag", ""), e.get("message", "")))
    seqs = sorted({int(c["seq"]) for c in ordered if isinstance(c.get("seq"), int)})
    expected = sorted({int(c["seq"]) for c in manifest if isinstance(c, dict) and isinstance(c.get("seq"), int)})
    boundary = expected or seqs
    gaps = [n for n in range(boundary[0], boundary[-1] + 1) if n not in seqs] if boundary else []
    arrived_parts = {(c.get("seq"), c.get("part")) for c in ordered}
    missing_parts = [
        {"seq": c.get("seq"), "part": c.get("part"), "id": c.get("id")}
        for c in manifest
        if isinstance(c, dict) and (c.get("seq"), c.get("part")) not in arrived_parts
    ]
    checkpoints = []
    evicted = {}
    for chunk in ordered:
        checkpoint = chunk.get("checkpoint")
        if checkpoint and checkpoint not in checkpoints:
            checkpoints.append(checkpoint)
        for item in chunk.get("evictedOnDevice", []):
            if isinstance(item, dict) and item.get("id"):
                evicted[item["id"]] = {"id": item["id"], "gameIndex": item.get("gameIndex")}
    return {"entries": entries, "chunks": len(ordered), "checkpoints": checkpoints,
            "missingSeqs": gaps, "missingParts": missing_parts,
            "evictedOnDevice": list(evicted.values())}


def log_line_key(line):
    """#723's identity for one page-owned devLog line."""
    if not isinstance(line, dict):
        return None
    ts, session, tag, message = (line.get(k) for k in ("ts", "sessionId", "tag", "message"))
    if not isinstance(ts, (int, float)) or not all(isinstance(v, str) for v in (session, tag, message)):
        return None
    return (ts, session, tag, message)


MASKED_WORDS = re.compile(r"auth|secret|credential|password", re.IGNORECASE)
IP_CANDIDATE = re.compile(
    r"(?<![0-9A-Za-z_.:])(?:"
    r"\[[0-9A-Fa-f:.]+\](?::\d{1,5})?"
    r"|\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?"
    r"|[0-9A-Fa-f:]*:[0-9A-Fa-f:.]+"
    r")(?![0-9A-Za-z_.:])")
MASKED_IP = re.compile(r"\*{4,}")


def mask_safe(text):
    """Canonical mask-safe text for raw device and Sentry-scrubbed comparisons."""
    def ip_token(found):
        candidate = found.group(0)
        host, port = candidate, ""
        if candidate.startswith("["):
            closing = candidate.find("]")
            host = candidate[1:closing]
            port = candidate[closing + 1:]
        else:
            ipv4_port = re.fullmatch(r"(\d{1,3}(?:\.\d{1,3}){3})(:\d{1,5})", candidate)
            mapped_port = re.fullmatch(
                r"((?:[0-9A-Fa-f]{0,4}:)*:ffff:\d{1,3}(?:\.\d{1,3}){3})(:\d{1,5})",
                candidate, re.IGNORECASE)
            with_port = ipv4_port or mapped_port
            if with_port:
                host, port = with_port.groups()
        try:
            ipaddress.ip_address(host)
            if port and int(port[1:]) > 65535:
                raise ValueError("port outside the valid range")
        except (ValueError, IndexError):
            return candidate
        return "<ip>" + port

    masked = MASKED_WORDS.sub(lambda found: found.group(0)[:2] + "*" + found.group(0)[3:], text)
    return MASKED_IP.sub("<ip>", IP_CANDIDATE.sub(ip_token, masked))


def masked_log_line_key(line):
    key = log_line_key(line)
    return (*key[:3], mask_safe(key[3])) if key is not None else None


def without_log_source(line):
    if not isinstance(line, dict) or "_viaLogs" not in line:
        return line
    return {key: value for key, value in line.items() if key != "_viaLogs"}


def timestamp_ms(value):
    if isinstance(value, (int, float)):
        return float(value)
    return parse_ts(value).timestamp() * 1000


def compare_log_completeness(ground_truth, delivered, meta=None, latency_budget_ms=60_000, truth_cutoff_at=None, fault_started_at=None, recovered_at=None, enforce_latency=False, require_full_and_chunks=False, require_report_and_chunks=False, require_no_double_count=False):
    """Compare page truth with the union of Sentry full logs and chunks.

    Independent document retries are collapsed before this function, while
    genuine same-document occurrences remain distinct. Device-eviction receipts are retained as reported
    evidence, but cannot conceal an unrelated missing current-game line.
    """
    # The browser masks sensitive fragments before Logs delivery. Canonicalize
    # both the device export and every delivered candidate first, so a raw
    # device line and its masked Logs copy are the same occurrence even when
    # no Logs-side identity metadata survived the pull.
    def truth_key(line):
        return masked_log_line_key(line)

    raw_truth = Counter(key for key in map(truth_key, ground_truth or []) if key is not None)
    truth_cutoff_valid = True
    try:
        truth_cutoff_ms = timestamp_ms(truth_cutoff_at) if truth_cutoff_at is not None else None
    except (TypeError, ValueError):
        truth_cutoff_ms = None
        truth_cutoff_valid = False
    truth = Counter({key: count for key, count in raw_truth.items() if truth_cutoff_ms is None or key[0] <= truth_cutoff_ms})
    truth_start_ms = min((key[0] for key in truth), default=None)
    excluded_after_checkpoint = sum(raw_truth.values()) - sum(truth.values())
    raw_got = Counter(key for key in map(truth_key, delivered or []) if key is not None)
    # Compare the same interval on both sides. Full logs legitimately include
    # lines written after the page-owned checkpoint boundary; those lines are
    # neither expected truth nor duplicate deliveries for T12.
    got = Counter({key: count for key, count in raw_got.items()
                   if (truth_start_ms is None or truth_start_ms <= key[0])
                   and (truth_cutoff_ms is None or key[0] <= truth_cutoff_ms)})
    missing = sorted((truth - got).elements())
    # The page export is a point-in-time snapshot, so telemetry captured after
    # that snapshot can legitimately be present only on the delivered side.
    # noDoubleCount is about repeated delivery of canonical truth records, not
    # about unique delivered-only records that the snapshot did not observe.
    comparable_got = Counter({key: count for key, count in got.items() if key in truth})
    duplicates = sorted((comparable_got - truth).elements())
    receipts = list((meta or {}).get("evictedOnDevice") or [])
    missing_seqs = list((meta or {}).get("missingSeqs") or [])
    missing_parts = list((meta or {}).get("missingParts") or [])
    delivery_shape_ok = not require_full_and_chunks or ((meta or {}).get("full") is True and int((meta or {}).get("chunks") or 0) > 0)
    report_shape_ok = not require_report_and_chunks or ((meta or {}).get("report") is True and int((meta or {}).get("chunks") or 0) > 0)
    latencies = []
    accepted_line_occurrences = 0
    chunk_counts = Counter()
    try:
        recovery_ms = timestamp_ms(recovered_at) if recovered_at else None
    except (TypeError, ValueError):
        recovery_ms = None
    try:
        fault_start_ms = timestamp_ms(fault_started_at) if fault_started_at else None
    except (TypeError, ValueError):
        fault_start_ms = None

    def add_latency(received_ms, baseline_ms):
        # Sentry's `received` field is second-resolution while capture times
        # are millisecond-resolution. A sub-second negative is rounding, not a
        # causality failure; larger negatives still fail closed.
        raw = int(received_ms - baseline_ms)
        latencies.append(max(0, raw) if raw >= -1000 else raw)

    for acceptance in (meta or {}).get("chunkAcceptances") or []:
        keys = [key for key in map(truth_key, acceptance.get("lines") or []) if key is not None]
        chunk_counts.update(keys)
        try:
            received_ms = timestamp_ms(acceptance["receivedAt"])
            captured_ms = timestamp_ms(acceptance["capturedAt"])
            for key in keys:
                accepted_line_occurrences += 1
                # The SLA is a recovery guarantee, not an age limit on healthy
                # checkpoint chunks. Only acceptances after the fault ended are
                # timed, from that controller-clock boundary. This also avoids
                # comparing a clock-offset page's capture time with Sentry time.
                if recovery_ms is not None and received_ms >= recovery_ms:
                    # A chunk already pending at recovery gets the full
                    # recovery budget. A checkpoint created after recovery is
                    # timed from that checkpoint, not from the earlier fault
                    # boundary (which would turn healthy later checkpoints red).
                    add_latency(received_ms, max(recovery_ms, captured_ms))
        except (KeyError, TypeError, ValueError):
            continue

    # A fault-window line may be absent from checkpoint chunks yet present in
    # the final full log. Merge repeated full documents by occurrence index and
    # use the earliest valid server receipt for each occurrence.
    full_counts, full_receipts = Counter(), {}
    acceptance_errors = []
    for acceptance in (meta or {}).get("fullAcceptances") or []:
        current = Counter(key for key in map(truth_key, acceptance.get("lines") or []) if key is not None)
        full_counts |= current
        try:
            received_ms = timestamp_ms(acceptance["receivedAt"])
        except (KeyError, TypeError, ValueError):
            acceptance_errors.append(f"full log {acceptance.get('id') or '<unknown>'} has no parseable Sentry received time")
            continue
        for key, count in current.items():
            receipts = full_receipts.setdefault(key, [])
            while len(receipts) < count:
                receipts.append(received_ms)
            for index in range(count):
                receipts[index] = min(receipts[index], received_ms)

    expected_full_fault_occurrences = 0
    accepted_full_fault_occurrences = 0
    if fault_start_ms is not None and recovery_ms is not None:
        for key, count in truth.items():
            if not fault_start_ms <= key[0] <= recovery_ms:
                continue
            full_only = max(0, count - min(count, chunk_counts[key]))
            expected_full_fault_occurrences += full_only
            for received_ms in (full_receipts.get(key) or [])[:min(full_only, full_counts[key])]:
                accepted_full_fault_occurrences += 1
                if received_ms >= recovery_ms:
                    add_latency(received_ms, recovery_ms)
    latency_ms = max(latencies) if latencies else None
    latency_valid = all(value >= 0 for value in latencies)
    expected_chunk_lines = int((meta or {}).get("chunkLineOccurrences") or 0)
    latency_evidence_complete = not enforce_latency or (
        fault_start_ms is not None and recovery_ms is not None
        and expected_chunk_lines > 0 and accepted_line_occurrences >= expected_chunk_lines
        and accepted_full_fault_occurrences >= expected_full_fault_occurrences
    )
    empty_truth = sum(truth.values()) == 0
    no_double_count = not duplicates
    return {
        "ok": truth_cutoff_valid and not empty_truth and not missing and not missing_seqs and not missing_parts and not acceptance_errors and delivery_shape_ok and report_shape_ok and (not enforce_latency or (latency_valid and latency_evidence_complete and (latency_ms is None or latency_ms <= latency_budget_ms))) and (no_double_count or not require_no_double_count),
        "expected": sum(truth.values()),
        "excludedAfterCheckpoint": excluded_after_checkpoint,
        "truthCutoffValid": truth_cutoff_valid,
        "delivered": sum((truth & got).values()),
        "missing": [{"ts": key[0], "sessionId": key[1], "tag": key[2], "message": key[3]} for key in missing],
        "evictedOnDevice": receipts,
        "missingSeqs": missing_seqs,
        "missingParts": missing_parts,
        "fullLog": bool((meta or {}).get("full")),
        "reportCopy": bool((meta or {}).get("report")),
        "chunks": int((meta or {}).get("chunks") or 0),
        "latencyMs": latency_ms,
        "latencyEvidenceComplete": latency_evidence_complete,
        "latencyBudgetMs": latency_budget_ms,
        "recoveredAt": recovered_at,
        "faultStartedAt": fault_started_at,
        "emptyTruth": empty_truth,
        "duplicateDeliveries": [{"ts": key[0], "sessionId": key[1], "tag": key[2], "message": key[3]} for key in duplicates],
        "noDoubleCount": no_double_count,
        "acceptanceErrors": acceptance_errors,
    }


def merge_log_sources(sources, log_sources=(), keep_ids=False):
    """Merge raw and delivered copies by their mask-safe occurrence identity."""
    merged = sentry_logs.merge_line_sources(
        [*sources, *log_sources],
        lambda entry: masked_log_line_key(entry) or ("__raw__", json.dumps(entry, sort_keys=True)),
        strip_identity=not keep_ids,
    )
    if keep_ids:
        return merged
    return [{name: value for name, value in entry.items() if name != "_viaLogs"}
            for entry in merged]


def assemble_full_parts(part_entries):
    """Concatenate one copy's parts in order without collapsing genuine duplicate lines."""
    return [entry for part in sorted(part_entries) for entry in part_entries[part]]


def full_log_rows(game, fields, start, end):
    """Paginate every full-log row through the same +7 day late-delivery window as chunks."""
    try:
        late_end = (parse_ts(end) + datetime.timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%S")
    except (TypeError, ValueError):
        late_end = end
    rows = events_all("errors", f"game.index:{game} title:game-log", fields, per_page=100, start=start, end=late_end)
    return [row for row in rows if row.get("game_log.stage") != "chunk"], late_end


def has_complete_nonreport_copy(copies):
    return any(
        isinstance(state.get("parts"), int)
        and state.get("stage") != "report"
        and all(part in state["arrived"] for part in range(state["parts"]))
        for state in copies.values()
    )


def fetch_logs(game, start, end, logs_dir=None, use_cache=True):
    """The game's game-log attachments, parsed once: (logs, log_meta).

    logs: {account: {meta, entries}} (the shape game-links.py takes). log_meta: {user.id: {name, bytes,
    entries, username, event, sent, file}}. With logs_dir every log is saved there, named
    <username or account[:8]>-<event id[:8]>.json; when use_cache is true, a file already there
    (found by its event-id suffix; the directory is listed once) is read, not downloaded again.
    Downloads run in parallel.
    """
    fields = ["id", "project", "user.id", "timestamp", "received", "game_log.stage", "game_log.checkpoint", "game_log.seq"]
    rows, late_end = full_log_rows(game, fields, start, end)
    chunk_rows = [r for r in events_all("errors", f"game.index:{game} title:game-log-chunk", fields, per_page=100, start=start, end=late_end)
                  if r.get("game_log.stage") == "chunk"]
    log_items, log_shape, logs_query_error = {}, {}, None
    try:
        log_items = sentry_logs.records_to_items(sentry_logs.log_rows(game, start, late_end, _events_all=events_all))
        log_shape = sentry_logs.legacy_shape(log_items)
    except sentry.OutOfStore:
        raise
    except Exception as e:  # a missing Logs page is a report gap, not a crashed report
        logs_query_error = f"logs query failed: {e}"[:200]
        print(logs_query_error, file=sys.stderr)
    cached = {}
    if logs_dir:
        os.makedirs(logs_dir, exist_ok=True)
    if logs_dir and use_cache:
        for f in os.listdir(logs_dir):
            m = re.search(r"-([0-9a-f]{8})\.json$", f)
            if m:
                cached[m.group(1)] = os.path.join(logs_dir, f)
    gl = _links()

    def one(lg):
        out = []
        try:
            attachments = _event(lg, "attachments/")
            if not attachments:
                raise RuntimeError("returned no data")
        except sentry.OutOfStore:
            raise
        except Exception as e:  # an unlisted attachment is a missing log, not proof that the event had none
            reason = f"attachment listing failed: {e}"[:200]
            print("skipped attachment listing of event", lg["id"], "-", e, file=sys.stderr)
            return [(lg, {"id": None}, None, None, reason)]
        for a in attachments:
            try:
                local = cached.get(lg["id"][:8])
                if local:
                    with open(local, "rb") as fh:
                        raw = fh.read()
                else:
                    raw = _event(lg, f"attachments/{a['id']}/?download=1", raw=True)
                    if not raw:
                        raise RuntimeError("attachment download returned no data")
                body = json.loads(raw)
                if logs_dir and not local:
                    meta = body.get("meta", {})
                    local = os.path.join(logs_dir, game_log_filename(meta.get("username"), lg.get("user.id") or meta.get("address") or "unknown", lg["id"]))
                    with open(local, "wb") as fh:
                        fh.write(raw)
            except sentry.OutOfStore:
                raise
            except Exception as e:  # one bad attachment must not kill the run
                print("skipped attachment", a.get("id"), "of event", lg["id"], "-", e, file=sys.stderr)
                out.append((lg, a, None, None, str(e)[:200]))
                continue
            out.append((lg, a, body, local, None))
        return out

    # A player can have two game-log events (a bonus copy when the report landed, a full one at the payoff
    # screen or later): any copy whose stage is not "report" (untagged legacy included) beats a report copy,
    # then the most entries, then the later event. The download order must not decide it.
    logs, log_meta, full_sources, full_log_sources, chunks_by_user, manifests_by_user, chunk_acceptances, full_acceptances = {}, {}, {}, {}, {}, {}, {}, {}
    download_gaps, successful_full_users = {}, set()
    full_parts_by_user, whole_full_users = {}, set()
    for uid, state in log_items.items():
        for chunk in state.get("chunks", []):
            chunks_by_user.setdefault(uid, []).append({**chunk, "_viaLogs": True})
            chunk_acceptances.setdefault(uid, []).append({"id": chunk.get("id"),
                "receivedAt": chunk.get("_receivedAt"), "capturedAt": chunk.get("capturedAt"), "lines": chunk.get("lines", [])})
        for copy_id, full in state.get("full", {}).items():
            restored = full_parts_by_user.setdefault(uid, {}).setdefault(copy_id, {"parts": full.get("parts"),
                "arrived": set(), "entries": {}, "stage": full.get("stage"), "received": list(full.get("received") or []),
                "viaLogs": True})
            for part, document in full.get("documents", {}).items():
                if full.get("complete", {}).get(part, True):
                    restored["arrived"].add(part)
                restored["entries"][part] = list(document.get("entries") or [])
                manifests_by_user.setdefault(uid, []).extend((document.get("gameLogManifest") or {}).get("chunks", []))
            successful_full_users.add(uid)
        shaped = log_shape.get(uid) or {"meta": {"address": uid}, "entries": []}
        full_stages = [full.get("stage") for full in state.get("full", {}).values()]
        if full_stages:
            stage = max(full_stages, key=lambda value: (value != "report", value or ""))
            log_meta[uid] = {"name": None, "bytes": None, "entries": len(shaped["entries"]), "event": None, "sent": None,
                "username": shaped["meta"].get("username"), "file": None, "stage": stage, "full": stage != "report",
                "rank": (stage != "report", len(shaped["entries"]), "")}
            if shaped["meta"].get("evictedOnDevice"):
                log_meta[uid]["evictedOnDevice"] = shaped["meta"]["evictedOnDevice"]
    with concurrent.futures.ThreadPoolExecutor(WORKERS) as ex:
        for found in ex.map(one, rows):
            for lg, a, body, local, error in found:
                uid = lg.get("user.id")
                if error:
                    if uid:
                        download_gaps.setdefault(uid, []).append({
                            "event": lg.get("id"), "attachment": a.get("id"), "reason": error,
                        })
                    continue
                entries = len(body.get("entries", []))
                uid = lg["user.id"]
                successful_full_users.add(uid)
                full = lg.get("game_log.stage") != "report"
                rank = (full, entries, lg.get("timestamp") or "")
                if uid not in log_meta or rank > log_meta[uid]["rank"]:
                    log_meta[uid] = {"name": a["name"], "bytes": a["size"], "entries": entries,
                                     "username": body.get("meta", {}).get("username"), "event": lg["id"], "sent": lg.get("timestamp"),
                                     "file": os.path.basename(local) if local else None, "stage": lg.get("game_log.stage"), "full": full,
                                     "rank": rank}
                parsed = gl.parse_log(body)
                marker = body.get("gameLogPart")
                parsed_uid = uid or (parsed[0] if parsed else None)
                parsed_entries = parsed[1].get("entries", []) if parsed else body.get("entries", [])
                if parsed_uid:
                    if isinstance(marker, dict) and isinstance(marker.get("copyId"), str):
                        copy = full_parts_by_user.setdefault(parsed_uid, {}).setdefault(marker["copyId"], {
                            "parts": marker.get("parts"), "arrived": set(), "entries": {},
                            "stage": lg.get("game_log.stage"), "received": [],
                        })
                        if isinstance(marker.get("part"), int):
                            copy["arrived"].add(marker["part"])
                            copy["entries"][marker["part"]] = parsed_entries
                        if isinstance(marker.get("parts"), int):
                            copy["parts"] = marker["parts"]
                        if lg.get("received"):
                            copy["received"].append(lg.get("received"))
                    elif parsed:
                        whole_full_users.add(parsed_uid)
                        full_sources.setdefault(parsed_uid, []).append(parsed_entries)
                        full_acceptances.setdefault(parsed_uid, []).append({
                            "id": lg.get("id"), "receivedAt": lg.get("received"),
                            "capturedAt": body.get("meta", {}).get("exportedAt"),
                            "lines": parsed_entries,
                        })
                    manifests_by_user.setdefault(parsed_uid, []).extend(body.get("gameLogManifest", {}).get("chunks", []))
        for found in ex.map(one, chunk_rows):
            for lg, a, body, _local, error in found:
                if error:
                    uid = lg.get("user.id")
                    if uid:
                        download_gaps.setdefault(uid, []).append({
                            "event": lg.get("id"), "attachment": a.get("id"), "reason": error,
                        })
                    continue
                uid = lg.get("user.id") or body.get("account") or body.get("deviceId")
                if uid and isinstance(body.get("lines"), list):
                    chunks_by_user.setdefault(uid, []).append(body)
                    chunk_acceptances.setdefault(uid, []).append({"id": body.get("id"), "receivedAt": lg.get("received"), "capturedAt": body.get("capturedAt"), "lines": body.get("lines", [])})
    for uid, copies in full_parts_by_user.items():
        for copy_id, state in copies.items():
            assembled = assemble_full_parts(state["entries"])
            target = full_log_sources if state.get("viaLogs") else full_sources
            target.setdefault(uid, []).append(assembled)
            full_acceptances.setdefault(uid, []).append({
                "id": copy_id,
                "receivedAt": max(state["received"]) if state["received"] else None,
                "capturedAt": None,
                "lines": assembled,
            })
    for uid in sorted(set(full_sources) | set(full_log_sources)):
        sources = full_sources.get(uid, [])
        logs_sources = full_log_sources.get(uid, [])
        copies = full_parts_by_user.get(uid, {})
        missing_full_parts = [
            {"copyId": copy_id, "part": part}
            for copy_id, state in copies.items()
            if isinstance(state.get("parts"), int)
            for part in range(state["parts"])
            if part not in state["arrived"]
        ]
        complete_part_copy = has_complete_nonreport_copy(copies)
        whole_full_complete = uid in whole_full_users and any(
            row.get("user.id") == uid and row.get("game_log.stage") != "report" for row in rows)
        full_complete = whole_full_complete or complete_part_copy
        output_meta = {"address": uid, "source": "full-documents", "complete": full_complete}
        if log_meta[uid].get("evictedOnDevice"):
            output_meta["evictedOnDevice"] = log_meta[uid]["evictedOnDevice"]
        logs[uid] = {"meta": output_meta, "entries": merge_log_sources(sources, logs_sources, keep_ids=True)}
        log_meta[uid]["documents"] = len(sources) + len(logs_sources)
        log_meta[uid]["fullCopies"] = len(copies)
        log_meta[uid]["missingFullParts"] = missing_full_parts
        log_meta[uid]["full"] = any(row.get("user.id") == uid and row.get("game_log.stage") != "report" for row in rows) or any(
            state.get("stage") != "report" for state in copies.values())
        log_meta[uid]["report"] = any(row.get("user.id") == uid and row.get("game_log.stage") == "report" for row in rows) or any(
            state.get("stage") == "report" for state in copies.values())
        log_meta[uid]["fullAcceptances"] = full_acceptances.get(uid, [])
    for uid, chunks in chunks_by_user.items():
        stitched = stitch_log_chunks(chunks, manifests_by_user.get(uid, ()))
        incomplete_seqs = {chunk.get("seq") for chunk in chunks if chunk.get("_recordsComplete") is False}
        missing_seqs = sorted(set(stitched["missingSeqs"]) | {seq for seq in incomplete_seqs if isinstance(seq, int)})
        chunk_meta = {"chunks": stitched["chunks"], "checkpoints": stitched["checkpoints"],
                      "missingSeqs": missing_seqs, "missingParts": stitched["missingParts"],
                      "evictedOnDevice": stitched["evictedOnDevice"],
                      "chunkLineOccurrences": sum(len(chunk.get("lines") or []) for chunk in chunks),
                      "chunkAcceptances": chunk_acceptances.get(uid, [])}
        if uid in log_meta:
            log_meta[uid].update(chunk_meta)
        else:
            log_meta[uid] = {"name": None, "bytes": None, "entries": len(stitched["entries"]), "username": None,
                             "event": None, "sent": None, "file": None, "stage": "chunk", "full": False,
                             "rank": (False, len(stitched["entries"]), ""), **chunk_meta}
        if stitched["entries"]:
            log_entries = [without_log_source(entry) for entry in stitched["entries"] if entry.get("_viaLogs")]
            legacy_entries = [entry for entry in stitched["entries"] if not entry.get("_viaLogs")]
            if uid in logs:
                logs[uid]["entries"] = merge_log_sources(
                    [legacy_entries, logs[uid]["entries"]], [log_entries] if log_entries else [], keep_ids=True)
                logs[uid]["meta"]["source"] = "full+chunks"
                logs[uid]["meta"]["complete"] = logs[uid]["meta"]["complete"] and not stitched["missingParts"] and not missing_seqs
            else:
                logs[uid] = {"meta": {"address": uid, "source": "chunks", "complete": not stitched["missingParts"] and not missing_seqs},
                             "entries": merge_log_sources([legacy_entries], [log_entries] if log_entries else [], keep_ids=True)}
    for uid, gaps in download_gaps.items():
        if uid in successful_full_users:
            continue
        if uid in log_meta:
            log_meta[uid]["downloadGaps"] = gaps
            continue
        row = next((candidate for candidate in rows + chunk_rows if candidate.get("user.id") == uid), {})
        log_meta[uid] = {"name": None, "bytes": None, "entries": 0, "username": None,
                         "event": row.get("id"), "sent": row.get("timestamp"), "file": None,
                         "stage": row.get("game_log.stage"), "full": False,
                         "rank": (False, 0, ""), "downloadGaps": gaps}
    for uid, state in log_items.items():
        missing = list(state.get("missing") or [])
        if not missing:
            continue
        meta = log_meta.setdefault(uid, {"name": None, "bytes": None, "entries": 0, "username": None, "event": None,
                                     "sent": None, "file": None, "stage": None, "full": False, "rank": (False, 0, "")})
        meta["missingRecords"] = missing
        meta.setdefault("downloadGaps", []).extend(
            {"event": None, "attachment": None, "reason": f"missing log record {item}#{index}"}
            for item, index in missing)
    if logs_query_error:
        log_meta.setdefault("_pullErrors", {})["game logs"] = logs_query_error
        users = set(log_meta) | {row.get("user.id") for row in rows + chunk_rows if row.get("user.id")}
        users.discard("_pullErrors")
        for uid in users:
            meta = log_meta.setdefault(uid, {"name": None, "bytes": None, "entries": 0, "username": None, "event": None,
                                         "sent": None, "file": None, "stage": None, "full": False, "rank": (False, 0, "")})
            meta.setdefault("downloadGaps", []).append(
                {"event": None, "attachment": None, "reason": logs_query_error})
    for value in logs.values():
        value["entries"] = [
            {name: item for name, item in entry.items() if name not in ("_deliveryId", "_viaLogs")}
            for entry in value.get("entries", [])
        ]
    return dict(sorted(logs.items())), log_meta


def event_tag(event, key):
    """The value of tag `key` on an event from the event API, which returns tags as a list of {key, value}."""
    return next((t.get("value") for t in event.get("tags") or [] if t.get("key") == key), None)


def previous_session_ends(events, source):
    """Canonical previous-session-end rows from legacy Errors or current Logs.

    These events are emitted before the account is known, so user.id and
    game.index cannot select them. The caller links them to a player through
    the Sentry session.id of the newly opened page.
    """
    out = []
    for row in events:
        shaped = {**row, "title": "previous-session-end", "_source": source}
        if source == "logs":
            shaped["previous.in_game"] = row.get("tags[previous.in_game,boolean]", row.get("previous.in_game"))
            shaped["previous.session.gap_ms"] = row.get(
                "tags[previous.session.gap_ms,number]", row.get("previous.session.gap_ms"))
        out.append(shaped)
    return out


PAGE_END_CONTEXT_FIELDS = (
    ("previous.session.session_id", "session_id"),
    ("previous.session.gap_ms", "gap_ms"),
    ("previous.session.game_index", "game_index"),
    ("previous.session.open_journeys", "open_journeys"),
    ("previous.session.open_journey_steps", "open_journey_steps"),
)


def _page_end_keys(row):
    """Cross-dataset identities: event ids differ between an Error and its Log copy."""
    current = row.get("session.id")
    keys = []
    previous = row.get("previous.session.session_id")
    if previous:
        keys.append((current, "previous", previous))
    timestamp = row.get("timestamp")
    try:
        timestamp = int(parse_ts(timestamp).timestamp())
    except (TypeError, ValueError):
        pass
    keys.append((current, "timestamp", timestamp))
    return keys


def _page_end_needs_detail(row):
    return row.get("_source") == "errors" and any(row.get(field) in (None, "") for field, _ in PAGE_END_CONTEXT_FIELDS)


def _page_end_with_detail(row, detail):
    shaped = dict(row)
    previous = ((detail.get("contexts") or {}).get("previous.session") or {})
    for field, context_key in PAGE_END_CONTEXT_FIELDS:
        if shaped.get(field) in (None, "") and previous.get(context_key) not in (None, ""):
            shaped[field] = previous[context_key]
    return shaped


def merge_previous_session_ends(errors, logs):
    """Stable Error-first union, filling empty legacy fields from a Log copy."""
    aliases, unique = {}, []
    for row in [*errors, *logs]:
        keys = _page_end_keys(row)
        kept = next((aliases[key] for key in keys if key in aliases), None)
        if kept is None:
            kept = row
            unique.append(kept)
            for key in keys:
                aliases[key] = kept
            continue
        for field, value in row.items():
            if kept.get(field) in (None, "", "unknown") and value not in (None, "", "unknown"):
                kept[field] = value
        for key in _page_end_keys(kept):
            aliases[key] = kept
    return sorted(unique, key=lambda row: (row.get("timestamp") or "", row.get("id") or ""))


def pull(game, start, end, extra_accounts=(), logs=None, log_meta=None, untagged_from=None):
    """Returns the pulled dict (see the module doc) for exactly the window given. `logs` and `log_meta` are
    fetch_logs()'s results; the accounts in their room keys and `extra_accounts` are pulled too."""
    GAME = str(game)
    logs, log_meta = logs or {}, log_meta or {}
    gl = _links()

    def events(dataset, query, fields, sort=None, per_page=100):
        # every page: a single page silently capped each player at 100 roots and 200 metric rows (game 254); a stable sort
        # so the pages neither repeat nor skip rows
        return events_all(dataset, query, fields, stable_sort(fields, sort), per_page, start=start, end=end)

    def latest(dataset, query, fields, sort, per_page):
        """One page on purpose: the newest row(s) only."""
        return _events(dataset, query, fields, sort, per_page, start=start, end=end)

    pull_errors = dict(log_meta.get("_pullErrors") or {})
    try:
        tagged = events("spans", f"game.index:{GAME}", ["user.id", "count()"]) + events("errors", f"game.index:{GAME}", ["user.id", "count()"])
    except sentry.OutOfStore:
        raise
    except Exception as error:  # the chain's and the logs' accounts are still pulled; the gap is recorded and reported
        pull_errors["tagged accounts"] = str(error)[:200]
        print("tagged-accounts query failed:", error, file=sys.stderr)
        tagged = []
    page_end_sources = {}
    for source, dataset, query, fields in (
            ("errors", "errors", "title:previous-session-end", PAGE_END_FIELDS),
            ("logs", "logs", "message:previous-session-end !has:game_log.item", PAGE_END_LOG_FIELDS)):
        try:
            page_end_sources[source] = previous_session_ends(
                events(dataset, query, fields, sort="timestamp",
                       per_page=100 if dataset == "errors" else 1000), source)
        except sentry.OutOfStore:
            raise
        except Exception as error:
            pull_errors[f"previous-session-end {source}"] = str(error)[:200]
            print(f"previous-session-end {source} query failed:", error, file=sys.stderr)
            page_end_sources[source] = []
    page_ends = merge_previous_session_ends(page_end_sources["errors"], page_end_sources["logs"])
    try:
        foreground = foreground_points(start, end)
    except sentry.OutOfStore:
        raise
    except Exception as error:
        pull_errors["foreground"] = str(error)[:200]
        print("foreground query failed:", error, file=sys.stderr)
        foreground = None
    tagged_accounts = sorted({r["user.id"] for r in tagged if r.get("user.id")})
    room_accounts = {a for lg in logs.values() for m in gl.mesh_opens(lg["entries"]) if m["room"].startswith(f"g{GAME}:") for a in gl.room_accounts(m["room"])}
    players = sorted(set(tagged_accounts) | room_accounts | set(extra_accounts))

    def one(acct):
        errors = {}
        gaps = (log_meta.get(acct) or {}).get("downloadGaps") or []
        if gaps:
            errors["game-log download"] = "; ".join(gap.get("reason") or "failed" for gap in gaps)[:200]

        def attempt(name, run, default=()):
            """One query of this player's; a failure (after the retries) is recorded under its name and the pull goes on,
            so the report shows the gap instead of looking complete."""
            try:
                return run()
            except sentry.OutOfStore:
                raise
            except Exception as error:
                errors[name] = str(error)[:200]
                print(f"{name} query failed for {acct[:8]}: {error}", file=sys.stderr)
                return list(default)

        roots = [r for r in attempt("journeys", lambda: events("spans", f"is_transaction:true user.id:{acct}", ROOT_FIELDS, sort="timestamp")) if not other_game(r, GAME, untagged_from)]
        steps = [r for r in attempt("steps", lambda: events("spans", f"!is_transaction:true user.id:{acct}", STEP_FIELDS, sort="timestamp", per_page=200)) if step_in_game(r, roots, GAME)]
        evs = [r for r in attempt("errors", lambda: events("errors", f"user.id:{acct}", ["id", "project", "timestamp", "title", "level", "environment", "game.index", "test.tag"], sort="timestamp")) if not other_game(r, GAME, untagged_from)]
        details = []
        for ev in evs:
            e = _event(ev)
            c = e.get("contexts", {})
            details.append({"timestamp": ev["timestamp"], "title": ev["title"], "level": ev["level"],
                            "session.id": event_tag(e, "session.id"), "previous.game": event_tag(e, "previous.game"),
                            "failure": c.get("failure"),
                            "telemetryHealth": c.get("telemetry_health"),
                            "telemetryHealthLate": event_tag(e, "telemetry.health_late") == "true",
                            "exception": [(v.get("type"), str(v.get("value"))[:300]) for x in (e.get("entries") or []) if x.get("type") == "exception" for v in x["data"]["values"]]})
        log_details = attempt("event logs", lambda: sentry_logs.event_rows(
            acct, start, end, game=GAME, untagged_from=untagged_from, _events_all=events_all))
        details = sentry_logs.merge_event_rows(details, log_details, acct)
        # Device profile + page belong to the app, not to a newer chat-worker
        # transaction from the same account. Chat roots have no host.kind;
        # game-report.py's is_chat_root additionally rejects explicit worker
        # markers when it validates the pulled roots.
        profile = page = None
        tx = attempt("device profile", lambda: latest("transactions", f"user.id:{acct} has:host.kind", ["id", "project", "timestamp"], sort="-timestamp", per_page=1))
        if tx:
            e = _event(tx[0])
            profile = e.get("contexts", {}).get("device_profile")
            page = e.get("contexts", {}).get("page")
        payoff = None
        ptx = [p for p in attempt("payoff", lambda: latest("transactions", f"user.id:{acct} transaction:journey.payoff", ["id", "project", "timestamp", "game.index"], sort="-timestamp", per_page=5)) if not other_game(p, GAME, untagged_from)]
        if ptx:
            e = _event(ptx[0])
            payoff = {k: v for k, v in ((e.get("contexts", {}).get("trace", {}) or {}).get("data") or {}).items()
                      if k.split(".")[0] in ("chest", "draw", "membership", "payoff", "journey")}
        sessions = sorted({r.get("session.id") for r in roots if r.get("session.id")})
        linked_page_ends, page_end_errors = [], {}
        for row in page_ends:
            previous_game = row.get("previous.game") or row.get("previous.session.game_index")
            if (str(previous_game) != GAME or
                    (row.get("session.id") not in sessions and row.get("previous.session.session_id") not in sessions)):
                continue
            if _page_end_needs_detail(row):
                try:
                    row = _page_end_with_detail(row, _event(row))
                except sentry.OutOfStore:
                    raise
                except Exception as error:
                    key = f"previous-session-end detail {row.get('id') or 'unknown'}"
                    page_end_errors[key] = str(error)[:200]
                    print(f"{key} fetch failed for {acct[:8]}: {error}", file=sys.stderr)
            linked_page_ends.append({key: value for key, value in row.items() if key != "_source"})
        scope = "session.id:[" + ",".join(sessions) + f"] game.index:{GAME} "
        metrics = attempt("metrics", lambda: local_metric_groups(scope + "!metric.name:[rtc.video_ms,rtc.present_ms]", METRIC_FIELDS, start, end)) if sessions else []
        coverage, coverage_error = coverage_metrics(sessions, GAME, start, end)
        metrics += coverage
        link_pairs = attempt("link pairing", lambda: local_metric_groups(scope + "metric.name:[rtc.in_fps,rtc.out_fps,rtc.in_height,rtc.out_height] stat:p50", LINK_PAIR_FIELDS, start, end)) if sessions else []
        link_kinds = attempt("hardware or software coding", lambda: local_metric_groups(scope + "metric.name:rtc.link", LINK_KIND_FIELDS, start, end)) if sessions else []
        # one transaction per sender per round from the send-adaptation ladder (apps/jollity-app/lib/webrtc/send-adaptation-evidence.ts),
        # numeric measurements in the transactions dataset
        send_rungs = [r for r in attempt("upload ladder", lambda: events("transactions", f"user.id:{acct} transaction:rtc.send_adaptation.round measurement_set:rungs-network",
                                                                          SEND_RUNG_FIELDS, sort="timestamp")) if not other_game(r, GAME, untagged_from)]
        public_log_meta = {
            key: value for key, value in (log_meta.get(acct) or {}).items()
            if not key.startswith("_")
        } or None
        return {"roots": roots, "steps": steps, "events": details, "profile": profile, "page": page,
                "pageEnds": linked_page_ends,
                **({} if foreground is None else {"foreground": player_foreground(foreground, acct, set(sessions), GAME, untagged_from)}),
                "payoff": payoff, "metrics": metrics, "coverage_error": coverage_error,
                "linkPairs": link_pairs, "linkKinds": link_kinds, "sendRungs": send_rungs, "queryErrors": errors,
                "bot": bot_tag(roots, evs), "log": public_log_meta, "in_room": acct in room_accounts,
                "_pullErrors": page_end_errors}

    with concurrent.futures.ThreadPoolExecutor(WORKERS) as ex:
        pulled = list(ex.map(one, players))
    for player in pulled:
        for name, error in player.pop("_pullErrors", {}).items():
            pull_errors[name] = error
    try:
        releases = slice_releases(end)
    except sentry.OutOfStore:
        raise
    except Exception as error:
        pull_errors["coverage builds"] = str(error)[:200]
        releases = []
    return {"game": int(GAME), "window": [start, end], "tagged_accounts": tagged_accounts, "sliceReleases": releases,
            "pullErrors": pull_errors, "players": dict(zip(players, pulled))}


if __name__ == "__main__":
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    GAME, START, END, OUT = sys.argv[1:5]
    logs, meta = fetch_logs(GAME, START, END)
    out = pull(GAME, START, END, logs=logs, log_meta=meta)
    json.dump(out, open(OUT, "w"), indent=1, default=str)
    print("players:", sorted(out["players"]))
    for a, p in out["players"].items():
        print(a[:8], "roots", len(p["roots"]), "steps", len(p["steps"]), "events", len(p["events"]), "metrics", len(p["metrics"]), "log", bool(p["log"]), "room", p["in_room"])
