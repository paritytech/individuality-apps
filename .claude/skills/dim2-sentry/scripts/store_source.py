#!/usr/bin/env python3
# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""Translate the report's frozen Sentry-query subset to the local DuckDB store."""
import dataclasses
import datetime
import json
import re
import threading
import urllib.parse

import agg
import sentry
import sentry_logs
import store


@dataclasses.dataclass(frozen=True)
class Token:
    key: str
    values: tuple = ()
    negative: bool = False
    has: bool = False


_REFUSED = re.compile(r'["\'<>()]')
_AGGREGATE = re.compile(r"^(count|p50|max|min|sum|count_sample)\(([^)]*)\)$")
_EAP = {"spans", "tracemetrics", "logs"}
_LOCAL_AGGREGATES = {"count(value)", "sum(value)", "min(value)", "max(value)", "p50(value)"}


def _unsupported(value):
    raise sentry.OutOfStore("unsupported: %s" % value)


def _split(query):
    parts, current, depth = [], [], 0
    for char in query.strip():
        if char == "[":
            depth += 1
            if depth > 1:
                _unsupported(query)
        elif char == "]":
            depth -= 1
            if depth < 0:
                _unsupported(query)
        if char.isspace() and depth == 0:
            if current:
                parts.append("".join(current))
                current = []
        else:
            current.append(char)
    if depth != 0:
        _unsupported(query)
    if current:
        parts.append("".join(current))
    return parts


def parse_query(query):
    """Parse only the exact search-token subset frozen for the report."""
    if _REFUSED.search(query or ""):
        _unsupported(query)
    out = []
    for raw in _split(query or ""):
        if raw in ("OR", "AND") or ":" not in raw:
            _unsupported(raw)
        negative = raw.startswith("!")
        text = raw[1:] if negative else raw
        if text.startswith("!"):
            _unsupported(raw)
        if text.startswith("has:"):
            key = text[4:]
            if not key or "*" in key:
                _unsupported(raw)
            out.append(Token(key=key, negative=negative, has=True))
            continue
        key, value = text.split(":", 1)
        if not key or not value or "*" in key:
            _unsupported(raw)
        if value.startswith("["):
            if not value.endswith("]"):
                _unsupported(raw)
            values = tuple(item.strip() for item in value[1:-1].split(",")) if value[1:-1] else ()
            if not values or any(not value or "*" in value for value in values):
                _unsupported(raw)
        elif "[" in value or "]" in value:
            _unsupported(raw)
        else:
            if "*" in value and (value.count("*") != 1 or not value.endswith("*") or
                                 len(value) == 1):
                _unsupported(raw)
            values = (value,)
        out.append(Token(key=key, values=values, negative=negative))
    return out


def _column_map(columns):
    if isinstance(columns, dict):
        return dict(columns)
    return {row if isinstance(row, str) else row[0]: "" if isinstance(row, str) else row[1]
            for row in columns}


def resolve_column(key, table_columns):
    names = resolve_columns(key, table_columns)
    return names[0] if names else None


def resolve_columns(key, table_columns):
    """Return every physical home that can carry one logical Sentry field."""
    columns = _column_map(table_columns)
    candidates = [
        key, "tags[%s]" % key, "tags[%s,number]" % key, "tags[%s,boolean]" % key,
    ]
    if key == "project.name":
        candidates.append("_project")
    if key == "sentry.sdk.name":
        # tracemetrics and errors store the SDK name as sdk.name; logs keep the sentry. prefix
        candidates += ["sdk.name", "tags[sdk.name]"]
    return tuple(name for name in candidates if name in columns)


def _quote(name):
    return '"%s"' % name.replace('"', '""')


def _is_boolean(kind):
    return "BOOL" in str(kind).upper()


def _is_numeric(kind):
    upper = str(kind).upper()
    return any(part in upper for part in (
        "INT", "DOUBLE", "FLOAT", "REAL", "DECIMAL", "NUMERIC", "HUGEINT",
    ))


def _coerce(expression, source_kind, target_kind):
    if _is_boolean(target_kind):
        return expression if _is_boolean(source_kind) else "TRY_CAST(%s AS BOOLEAN)" % expression
    if _is_numeric(target_kind):
        return expression if _is_numeric(source_kind) else "TRY_CAST(%s AS DOUBLE)" % expression
    return expression if not (_is_numeric(source_kind) or _is_boolean(source_kind)) else \
        "CAST(%s AS VARCHAR)" % expression


def _field_expression(key, table_columns):
    columns = _column_map(table_columns)
    names = resolve_columns(key, columns)
    if not names:
        return "NULL", None
    target_kind = columns[names[0]]
    expressions = [_coerce(_quote(name), columns[name], target_kind) for name in names]
    return (expressions[0] if len(expressions) == 1 else
            "COALESCE(%s)" % ", ".join(expressions)), target_kind


def _predicate(token, columns, params):
    expression, kind = _field_expression(token.key, columns)
    if kind is None:
        return "TRUE" if token.negative else "FALSE"
    if token.has:
        found = "(%s IS NOT NULL AND CAST(%s AS VARCHAR) <> '')" % (expression, expression)
        return "NOT %s" % found if token.negative else found
    values = list(token.values)
    prefix_wildcard = len(values) == 1 and values[0].endswith("*")
    if prefix_wildcard and (_is_boolean(kind) or _is_numeric(kind)):
        _unsupported("%s:%s" % (token.key, values[0]))
    if _is_boolean(kind):
        converted = []
        for value in values:
            if value.lower() not in ("true", "false"):
                _unsupported("%s:%s" % (token.key, value))
            converted.append(value.lower() == "true")
        values = converted
    elif _is_numeric(kind):
        try:
            values = [float(value) for value in values]
        except ValueError:
            _unsupported("%s:%s" % (token.key, ",".join(values)))
    if prefix_wildcard:
        prefix = values[0][:-1].replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        params.append(prefix + "%")
        comparison = "%s %sLIKE ? ESCAPE '\\'" % (
            expression, "NOT " if token.negative else "")
        return (("(%s IS NULL OR %s)" % (expression, comparison))
                if token.negative else comparison)
    params.extend(values)
    placeholders = ", ".join("?" for _ in values)
    if len(values) == 1:
        comparison = "%s %s ?" % (expression, "<>" if token.negative else "=")
    else:
        comparison = "%s %sIN (%s)" % (expression, "NOT " if token.negative else "", placeholders)
    return "(%s IS NULL OR %s)" % (expression, comparison) if token.negative else comparison


def _aggregate(dataset, field, columns):
    match = _AGGREGATE.fullmatch(field)
    if not match:
        _unsupported(field)
    function, argument = match.groups()
    if function == "count" and argument == "":
        expression = "COUNT(*)"
    elif function == "count_sample" and argument == "":
        expression = "COUNT(*)"
    else:
        _unsupported(field)
    if dataset in _EAP and function in ("count", "count_sample"):
        expression = "CAST(%s AS DOUBLE)" % expression
    return "%s AS %s" % (expression, _quote(field))


def _plain_expression(dataset, field, columns):
    expression, _kind_name = _field_expression(field, columns)
    if dataset == "transactions" and field == "transaction.duration":
        return "CAST(%s AS BIGINT)" % expression
    if dataset == "logs" and field == "timestamp_precise":
        return "CAST(%s AS BIGINT)" % expression
    return expression


def _build_sql(dataset, tokens, fields, sort, table_columns, extra=()):
    columns = _column_map(table_columns)
    plain = [field for field in fields if "(" not in field]
    aggregates = [field for field in fields if "(" in field]
    selected = []
    group_expressions = []
    for field in plain:
        expression = _plain_expression(dataset, field, columns)
        selected.append("%s AS %s" % (expression, _quote(field)))
        group_expressions.append(expression)
    # P13: Sentry adds project.name to every ungrouped row response, even
    # when it was not requested. The dump preserves that extra column.
    if not aggregates and "project.name" not in plain:
        project_expression, project_kind = _field_expression("project.name", columns)
        if project_kind is not None:
            selected.append('%s AS "project.name"' % project_expression)
    selected.extend(_aggregate(dataset, field, columns) for field in aggregates)
    if not selected:
        _unsupported("no fields")
    params, predicates = [], []
    for token in tokens:
        predicates.append(_predicate(token, columns, params))
    for sql, values in extra:
        predicates.append(sql)
        params.extend(values)
    source = _quote(dataset)
    if "id" in columns and "_network" in columns and "_game" in columns:
        part_order = ('CASE "_part" WHEN \'window\' THEN 0 WHEN \'late\' THEN 1 ELSE 2 END'
                      if "_part" in columns else "0")
        source = ('(SELECT * FROM %s QUALIFY "id" IS NULL OR '
                  'ROW_NUMBER() OVER (PARTITION BY "_network", "_game", "id" ORDER BY %s) = 1) '
                  'AS "_deduped"') % (_quote(dataset), part_order)
    sql = "SELECT %s FROM %s" % (", ".join(selected), source)
    if predicates:
        sql += " WHERE " + " AND ".join(predicates)
    if aggregates and plain:
        sql += " GROUP BY " + ", ".join(group_expressions)
    order = sentry.stable_sort(fields, sort)
    if order:
        clauses = []
        previous_descending = False
        for item in order:
            descending = item.startswith("-")
            field = item[1:] if descending else item
            resolved_sort, resolved_kind = _field_expression(field, columns)
            if field not in fields and resolved_kind is None:
                _unsupported("sort %s" % item)
            # P12: Sentry gives no stable same-second order. Its deterministic
            # local equivalent uses id in the same direction as the last key.
            if field == "id" and not item.startswith("-") and clauses:
                descending = previous_descending
            sort_expression = _quote(field) if field in fields else resolved_sort
            clauses.append("%s %s NULLS LAST" % (sort_expression, "DESC" if descending else "ASC"))
            previous_descending = descending
        sql += " ORDER BY " + ", ".join(clauses)
    return sql, params


def to_sql(dataset, tokens, fields, sort, table_columns):
    """Pure translation of query tokens, fields and ordering to parameterized SQL."""
    return _build_sql(dataset, tokens, fields, sort, table_columns)


def _timestamp(value):
    parsed = sentry.parse_ts(value)
    return parsed.astimezone(datetime.timezone.utc)


class StoreSource:
    def __init__(self, game, network="paseo", root=None):
        self.game = int(game)
        self.network = network
        self.manifest = store.manifest(self.game, network, root)
        self.connection = store.connect(root)
        # game-report-pull fans player queries across a ThreadPoolExecutor. DuckDB
        # connections are not safe for simultaneous execute/fetch sequences.
        self._lock = threading.RLock()

    def close(self):
        self.connection.close()

    def get(self, url, raw=False):
        parsed = urllib.parse.urlsplit(url)
        path = parsed.path
        if path.startswith("/api/0/"):
            path = path[6:]
        match = re.fullmatch(
            r"/projects/%s/([^/]+)/events/([^/]+)/(?:attachments/(?:([^/]+)/)?)?" %
            re.escape(sentry.ORG), path)
        if not match:
            raise sentry.OutOfStore("unsupported: store get route %s" % url)
        project, event_id, attachment_id = match.groups()
        projects = self.manifest.get("projects") or {}
        if project not in projects:
            raise sentry.OutOfStore("unsupported: project %s is absent from the store" % project)
        base = ['"_network" = ?', '"_game" = ?', '"project" = ?']
        params = [self.network, self.game, project]
        if attachment_id is not None:
            if not raw or parsed.query != "download=1":
                raise sentry.OutOfStore("unsupported: attachment route %s" % url)
            sql = ("SELECT body FROM attachments WHERE %s AND event_id = ? "
                   "AND attachment_id = ? LIMIT 1") % " AND ".join(base)
            params.extend([event_id, attachment_id])
            with self._lock:
                row = self.connection.execute(sql, params).fetchone()
            return b"" if row is None or row[0] is None else bytes(row[0])
        if path.endswith("/attachments/"):
            if raw or parsed.query:
                raise sentry.OutOfStore("unsupported: attachment-list route %s" % url)
            sql = ("SELECT list_json FROM attachments WHERE %s AND event_id = ? "
                   "ORDER BY attachment_id NULLS FIRST") % " AND ".join(base)
            with self._lock:
                rows = self.connection.execute(sql, params + [event_id]).fetchall()
            lists, seen = [], set()
            try:
                for (encoded,) in rows:
                    if encoded is None or encoded in seen:
                        continue
                    seen.add(encoded)
                    page = json.loads(encoded)
                    if not isinstance(page, list):
                        raise TypeError("attachment list is not a list")
                    lists.extend(page)
            except (TypeError, ValueError) as error:
                raise sentry.OutOfStore("stored attachment list is unusable: %s" % error) from error
            return lists
        if raw or parsed.query:
            raise sentry.OutOfStore("unsupported: event route %s" % url)
        sql = ("SELECT dataset, status, json FROM events_json WHERE %s AND id = ? LIMIT 1") % \
            " AND ".join(base)
        with self._lock:
            row = self.connection.execute(sql, params + [event_id]).fetchone()
            has_transactions = self.connection.execute(
                "SELECT 1 FROM information_schema.tables WHERE table_name = 'transactions'"
            ).fetchone()
            transaction = None
            if row is None and has_transactions is not None:
                transaction = self.connection.execute(
                    ("SELECT 1 FROM transactions WHERE \"_network\" = ? AND \"_game\" = ? "
                     "AND \"_project\" = ? AND id = ? LIMIT 1"),
                    params + [event_id],
                ).fetchone()
        pending_transaction = (
            row is not None and row[0] == "transactions"
            and (row[1] != 200 or row[2] is None)
        ) or transaction is not None
        if pending_transaction:
            raise sentry.OutOfStore(
                "transaction event JSON is pending; run store_dump.py %d --complete-raw" % self.game)
        if row is None or row[1] != 200 or row[2] is None:
            return {}
        try:
            value = json.loads(row[2])
        except (TypeError, ValueError) as error:
            raise sentry.OutOfStore("stored event JSON is unusable: %s" % error) from error
        if not isinstance(value, dict):
            raise sentry.OutOfStore("stored event JSON is not an object")
        return value

    def _projects(self):
        projects = self.manifest.get("projects") or {}
        stored_by_pid = {str(pid): slug for slug, pid in projects.items()}
        missing = [pid for pid in sentry.PIDS if str(pid) not in stored_by_pid]
        if missing:
            raise sentry.OutOfStore(
                "requested projects are absent from the store: %s" % ", ".join(missing))
        return [stored_by_pid[str(pid)] for pid in sentry.PIDS]

    def _context_rows(self, dataset, tokens, fields, start, end, slugs):
        context = None
        values = ()
        if (dataset in ("spans", "errors") and fields ==
                ["user.id", "user.username", "count()"] and len(tokens) == 2 and
                tokens[0].key == "user.id" and not tokens[0].negative and not tokens[0].has and
                tokens[1] == Token(key="user.username", has=True)):
            context, values = "context_usernames", tokens[0].values
        elif (dataset == "tracemetrics" and fields in
              (["count(value)"], ["release", "count(value)"]) and
              tokens == [Token(key="metric.name", values=("rtc.video_ms", "rtc.present_ms"))]):
            context = "context_releases"
        if context is None:
            return None
        coverage = ((self.manifest.get("datasets") or {}).get(context) or {})
        if not start or not end or not coverage.get("start") or not coverage.get("end") or \
                _timestamp(start) != _timestamp(coverage["start"]) or \
                _timestamp(end) != _timestamp(coverage.get("end")):
            raise sentry.OutOfStore("%s context window mismatch" % context)
        predicates = ['"_network" = ?', '"_game" = ?',
                      '"_project" IN (%s)' % ", ".join("?" for _ in slugs)]
        params = [self.network, self.game, *slugs]
        if context == "context_usernames":
            predicates.extend(['"dataset" = ?', '"user.id" IN (%s)' %
                               ", ".join("?" for _ in values)])
            params.extend([dataset, *values])
        groups = [field for field in fields if field not in ("count()", "count(value)")]
        selected = ", ".join(
            "SUM(%s) AS %s" % (_quote(field), _quote(field))
            if field in ("count()", "count(value)") else _quote(field)
            for field in fields)
        sql = "SELECT %s FROM %s WHERE %s" % (
            selected, _quote(context), " AND ".join(predicates))
        if groups:
            sql += " GROUP BY " + ", ".join(_quote(field) for field in groups)
            sql += " ORDER BY " + ", ".join(_quote(field) for field in groups)
        with self._lock:
            cursor = self.connection.execute(sql, params)
            names = [item[0] for item in cursor.description]
            answer = cursor.fetchall()
        return [dict(zip(names, row)) for row in answer]

    def _columns(self, dataset):
        try:
            with self._lock:
                rows = self.connection.execute("DESCRIBE %s" % _quote(dataset)).fetchall()
            return {row[0]: row[1] for row in rows}
        except Exception as error:
            raise sentry.OutOfStore("%s: dataset unavailable: %s" % (dataset, error)) from error

    def _window(self, start, end, period):
        window = self.manifest["window"]
        report_start = _timestamp(window["report_start"])
        report_end = _timestamp(window["report_end"])
        late_end = _timestamp(window["late_end_utc"])
        if start and end:
            query_start, query_end = _timestamp(start), _timestamp(end)
        else:
            match = re.fullmatch(r"(\d+)([hd])", period or "24h")
            if not match:
                _unsupported("period %s" % period)
            query_end = report_end
            unit = {"h": "hours", "d": "days"}[match.group(2)]
            amount = datetime.timedelta(**{unit: int(match.group(1))})
            query_start = query_end - amount
        if query_end > late_end or query_start > query_end:
            raise sentry.OutOfStore("coverage: [%s, %s] is outside [%s, %s]" %
                                    (start, end, window["report_start"], window["late_end_utc"]))
        return query_start, query_end, report_end

    def rows(self, dataset, query, fields, sort=None, start=None, end=None, period=None, limit=None):
        try:
            tokens = parse_query(query)
            slugs = self._projects()
            context = self._context_rows(dataset, tokens, fields, start, end, slugs)
            if context is not None:
                return context[:int(limit)] if limit is not None else context
            aggregate_fields = [field for field in fields if "(" in field]
            if sort and aggregate_fields and set(aggregate_fields) <= _LOCAL_AGGREGATES:
                raise sentry.OutOfStore("aggregate sort is unsupported locally")
            query_start, query_end, report_end = self._window(start, end, period)
            report_start = _timestamp(self.manifest["window"]["report_start"])
            if query_start < report_start:
                padded_start = report_start - sentry_logs.CLOCK_LAG_PAD
                exact_game = any(
                    token.key == "game.index" and not token.negative and not token.has and
                    token.values == (str(self.game),) for token in tokens)
                if dataset != "logs" or not exact_game or query_start < padded_start:
                    raise sentry.OutOfStore("coverage before report_start requires logs and game.index:%d" %
                                            self.game)
                per_project = ((self.manifest.get("datasets") or {}).get("logs") or {}).get(
                    "per_project") or {}
                projects = self.manifest.get("projects") or {}
                stored_by_pid = {str(pid): slug for slug, pid in projects.items()}
                missing_pre_window = []
                for pid in sentry.PIDS:
                    parts = per_project.get(pid, per_project.get(str(pid)))
                    pre_window = parts.get("pre_window") if isinstance(parts, dict) else None
                    captured_start = pre_window.get("start") if isinstance(pre_window, dict) else None
                    if not captured_start or _timestamp(captured_start) > padded_start:
                        missing_pre_window.append(stored_by_pid[str(pid)])
                if missing_pre_window:
                    raise sentry.OutOfStore(
                        "logs pre-window part does not cover the clock-lag pad for: %s" %
                        ", ".join(missing_pre_window))
            if query_end > report_end and not any(
                    token.key == "game.index" and not token.negative and not token.has and
                    str(self.game) in token.values for token in tokens):
                raise sentry.OutOfStore("late coverage requires game.index:%d" % self.game)
            projects = self.manifest.get("projects") or {}
            stored_by_pid = {str(pid): slug for slug, pid in projects.items()}
            if query_end > report_end:
                per_project = ((self.manifest.get("datasets") or {}).get(dataset) or {}).get(
                    "per_project") or {}
                missing_late = []
                for pid in sentry.PIDS:
                    parts = per_project.get(pid, per_project.get(str(pid)))
                    if not isinstance(parts, dict) or "late" not in parts or parts["late"] is None:
                        missing_late.append(stored_by_pid[str(pid)])
                if missing_late:
                    raise sentry.OutOfStore(
                        "%s late part is unavailable for: %s" % (dataset, ", ".join(missing_late)))
            columns = self._columns(dataset)
            extra = [
                ('"_network" = ?', [self.network]),
                ('"_game" = ?', [self.game]),
                ('"_project" IN (%s)' % ", ".join("?" for _ in slugs), slugs),
                ('as_ts("timestamp") >= ? AND as_ts("timestamp") <= ?', [query_start, query_end]),
            ]
            group_fields = [field for field in fields if "(" not in field]
            aggregate_fields = [field for field in fields if "(" in field]
            local_aggregate = bool(aggregate_fields) and set(aggregate_fields) <= _LOCAL_AGGREGATES
            query_fields = fields
            query_sort = sort
            if local_aggregate:
                query_fields = list(dict.fromkeys(group_fields + ["value", "id", "timestamp"]))
                query_sort = sentry.stable_sort(query_fields)
            sql, params = _build_sql(dataset, tokens, query_fields, query_sort, columns, extra)
            with self._lock:
                cursor = self.connection.execute(sql, params)
                names = [item[0] for item in cursor.description]
                answer = cursor.fetchall()
            rows = [dict(zip(names, row)) for row in answer]
            # The store keeps both inclusive window/late boundary rows in old
            # snapshots. Match sentry.events_all: one row per event id, then limit.
            rows = sentry.dedupe(rows)
            if local_aggregate:
                rows = agg.aggregate(rows, group_fields, aggregate_fields)
            return rows[:int(limit)] if limit is not None else rows
        except sentry.OutOfStore as error:
            raise sentry.OutOfStore("%s query %r: %s" % (dataset, query, error)) from error
        except Exception as error:
            raise sentry.OutOfStore("%s query %r failed locally: %s" % (dataset, query, error)) from error
