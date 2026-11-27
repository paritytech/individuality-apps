#!/usr/bin/env python3
# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""Small Sentry CLI for DIM2 (org paritytech, project jollity-next, EU region). Stdlib only.

  sentry.py [--project jollity-next|dim2-testing] whoami
  sentry.py query <dataset> "<query>" -f field [-f field ...] [--period 24h | --start ISO --end ISO]
                  [--sort=-timestamp] [--limit 100] [--json]
  sentry.py event <event_id>
  sentry.py attachment <event_id> [--out file]

Datasets: spans, errors, tracemetrics (also transactions). The token comes from
SENTRY_AUTH_TOKEN, else the macOS keychain (service sentry-api-token). It is never printed.
Other scripts import token(), get(), events() and parse_ts() from here.

THE PROJECT. Production telemetry is in jollity-next; test traffic (next dev, the
desk harness, the e2e bots) is in dim2-testing whenever the build carried
NEXT_PUBLIC_SENTRY_DSN_TEST (apps/jollity-app/lib/telemetry/environment.ts pickDsn, plan D8).
DIM2_SENTRY_PROJECT picks the project at import (default jollity-next), so every
script that imports this module reads the same one; --project and use_project()
switch it later. Read PROJECT, PID and PROJECT_SLUGS through this module
(sentry.PROJECT), never copy them at import, or a switch does not reach you.

TEST READS SPAN BOTH PROJECTS. Bundles built before the test DSN still send test
traffic to jollity-next, and a game with both phones and bots is split across
the two, so asking for dim2-testing reads dim2-testing AND jollity-next: one
query with both project ids, rows deduped on the event id. A comma list
("dim2-testing,jollity-next") names the projects outright. Asking for
jollity-next reads jollity-next alone. Per-event paths need the event's own
project: ask for the "project" field and pass the row to event_projects().
"""
import argparse, datetime, email.utils, functools, json, os, random, re, socket, subprocess, sys, threading, time, urllib.error, urllib.parse, urllib.request

ORG = "paritytech"
PROJECTS = {"jollity-next": "4512177451237456", "dim2-testing": "4512256244777040"}
# the test project also reads production while bundles built before the test DSN still write there
ALSO_READ = {"dim2-testing": ["jollity-next"]}
PROJECT = "jollity-next"
PID = PROJECTS[PROJECT]
PROJECT_SLUGS = [PROJECT]
PIDS = [PID]
SOURCE = None

# The events API's per_page caps (T0: errors/transactions 100, spans/tracemetrics/logs 1000). pages() refuses more.
PER_PAGE_MAX = {"errors": 100, "transactions": 100, "spans": 1000, "tracemetrics": 1000, "logs": 1000}
# Each dataset's count function: tracemetrics has no count(), only count(value); spans answer count_sample() (P4).
COUNT_FIELD = {"errors": "count()", "transactions": "count()", "spans": "count_sample()", "tracemetrics": "count(value)", "logs": "count()"}
# measurement_keys()'s fallback (P3): the measurements-meta endpoint answered {} for jollity-next, so the transactions
# dump falls back to the fixed send-ladder list game-report-pull.py uses (SEND_RUNG_FIELDS, SEND_RUNGS there).
FIXED_MEASUREMENT_KEYS = [f"measurements.rtc.send.rung_{name}_s" for name in ("full", "lean", "low", "minimum", "survival")] + \
    ["measurements.rtc.send.bandwidth_limited_s", "measurements.rtc.send.step_up_count"]
# The rank attribute_keys() sorts by (L3): string, then number, then boolean.
ATTRIBUTE_ORDER = ("string", "number", "boolean")
HTTP_TIMEOUT_SECONDS = 60
RETRYABLE_NETWORK_ERRORS = (urllib.error.URLError, TimeoutError, socket.timeout)


class RequestController:
    """One process-wide retry cooldown shared by concurrent dump workers."""

    def __init__(self, requests_per_second=None, clock=None, sleeper=None):
        if requests_per_second is not None and requests_per_second <= 0:
            raise ValueError("requests_per_second must be positive")
        self.interval = 1.0 / requests_per_second if requests_per_second else 0.0
        self.clock = clock or time.monotonic
        self.sleep = sleeper or time.sleep
        self.lock = threading.Lock()
        self.next_request = 0.0
        self.cooldown_until = 0.0
        self.stats = {
            "attempts": 0, "retries": 0, "rate_limited_429": 0,
            "server_errors_5xx": 0, "network_errors": 0,
            "throttle_seconds": 0.0, "cooldown_seconds": 0.0,
        }

    def before_request(self):
        while True:
            with self.lock:
                now = self.clock()
                ready = max(self.next_request, self.cooldown_until)
                if now >= ready:
                    self.next_request = now + self.interval
                    self.stats["attempts"] += 1
                    return
                delay = ready - now
                self.stats["throttle_seconds"] += delay
            self.sleep(delay)

    def retry(self, delay, status=None, network=False):
        with self.lock:
            self.stats["retries"] += 1
            if status == 429:
                self.stats["rate_limited_429"] += 1
            elif status is not None and status >= 500:
                self.stats["server_errors_5xx"] += 1
            if network:
                self.stats["network_errors"] += 1
            if status == 429 or (status is not None and status >= 500):
                now = self.clock()
                previous = self.cooldown_until
                self.cooldown_until = max(previous, now + delay)
                self.stats["cooldown_seconds"] += max(0.0, self.cooldown_until - max(now, previous))

    def snapshot(self):
        with self.lock:
            out = dict(self.stats)
        for key in ("throttle_seconds", "cooldown_seconds"):
            out[key] = round(out[key], 3)
        return out


_REQUEST_CONTROLLER = None


def begin_request_control(requests_per_second=None):
    """Enable one shared retry cooldown for a bounded dump run.

    A fixed pace is optional for diagnostics. Production dumps use the server's
    Retry-After signal instead: the old four-request pace made g268 slower.
    """
    global _REQUEST_CONTROLLER
    if _REQUEST_CONTROLLER is not None:
        raise RuntimeError("request control is already active")
    _REQUEST_CONTROLLER = RequestController(requests_per_second)


def request_stats():
    return _REQUEST_CONTROLLER.snapshot() if _REQUEST_CONTROLLER is not None else {}


def end_request_control():
    """Disable request control and return its final counters."""
    global _REQUEST_CONTROLLER
    out = request_stats()
    _REQUEST_CONTROLLER = None
    return out


class SentryQueryError(RuntimeError):
    """A query failed. count() and the key discovery raise this instead of returning a plausible-looking empty answer."""


class OutOfStore(RuntimeError):
    """The configured local store cannot answer a query without changing its meaning."""


def use_source(src):
    """Route supported reads through src. None restores the live Sentry API."""
    global SOURCE
    SOURCE = src


def use_project(spec):
    """Point every query at a project of the org, or a comma list of them. dim2-testing alone
    expands to dim2-testing,jollity-next (ALSO_READ). PROJECT/PID name the first one."""
    global PROJECT, PID, PROJECT_SLUGS, PIDS
    names = [n.strip() for n in (spec or "").split(",") if n.strip()] or ["jollity-next"]
    for n in names:
        if n not in PROJECTS:
            raise SystemExit(f"unknown Sentry project {n!r}: one of {', '.join(PROJECTS)}")
    if len(names) == 1:
        names += ALSO_READ.get(names[0], [])
    slugs = list(dict.fromkeys(names))
    PROJECT_SLUGS, PIDS = slugs, [PROJECTS[n] for n in slugs]
    PROJECT, PID = slugs[0], PIDS[0]


def event_projects(row=None):
    """The projects an event can live in: the row's own "project" field when the query asked for it,
    else every project being read (first match wins, see event_get)."""
    slug = (row or {}).get("project") if isinstance(row, dict) else None
    return [slug] if slug in PROJECTS else list(PROJECT_SLUGS)


def dedupe(rows):
    """Rows of a query over several projects, once per event id (rows without an id, e.g. aggregates, stay)."""
    seen, out = set(), []
    for r in rows:
        key = r.get("id") if isinstance(r, dict) else None
        if key is not None:
            if key in seen:
                continue
            seen.add(key)
        out.append(r)
    return out


use_project(os.environ.get("DIM2_SENTRY_PROJECT", ""))
BASE = "https://de.sentry.io/api/0"

SETUP_HELP = (
    "No Sentry token found. Create one at https://de.sentry.io/settings/account/api/auth-tokens/ "
    "(scopes org:read, project:read, event:read), then on macOS run\n"
    '  security add-generic-password -a "$USER" -s sentry-api-token -w\n'
    "or export SENTRY_AUTH_TOKEN in your shell profile. See SKILL.md, One-time setup."
)


@functools.lru_cache(maxsize=None)
def token():
    """The token, read once per process (the keychain lookup is a subprocess)."""
    t = os.environ.get("SENTRY_AUTH_TOKEN", "").strip()
    if t:
        return t
    try:
        out = subprocess.run(["security", "find-generic-password", "-s", "sentry-api-token", "-w"],
                             capture_output=True, text=True)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except FileNotFoundError:
        pass  # not macOS
    sys.exit(SETUP_HELP)


def parse_ts(s):
    """ISO string (Sentry, the chain reader) or epoch ms to an aware UTC datetime. The one parser the report scripts share."""
    if isinstance(s, (int, float)):
        return datetime.datetime.fromtimestamp(s / 1000, datetime.timezone.utc)
    d = datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=datetime.timezone.utc)


def _open(url, params=None):
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token()}"})
    return urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS)


def get(url, params=None, raw=False):
    """GET a URL (absolute, or a path under /api/0). Returns parsed JSON ({} on HTTP error,
    after printing Sentry's error body to stderr), or the bytes when raw=True.
    Sentry answers 429 when several threads ask at once (5 requests a second); 429, passing server faults and network
    failures are retried with the shared _request loop. This best-effort helper keeps returning an empty value after
    its retries, unlike strict store reads such as raw_get()."""
    if SOURCE is not None:
        return SOURCE.get(url, raw)
    if url.startswith("/"):
        url = BASE + url
    try:
        _status, body, _headers = _request(url, params)
        return body if raw else json.loads(body)
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code} {url[:120]}\n{e.read()[:600].decode(errors='replace')}", file=sys.stderr)
        if e.code == 401:
            print("The Sentry token is wrong, expired or revoked. Create a new one and store it again\n"
                  "(SKILL.md, One-time setup).", file=sys.stderr)
        elif e.code == 403:
            print("The token works but may not reach this. It needs the scopes org:read, project:read and\n"
                  "event:read, and your account must be in the paritytech org (SKILL.md, One-time setup).",
                  file=sys.stderr)
    except RETRYABLE_NETWORK_ERRORS as e:
        print(f"GET failed after retries {url[:120]} - {e}", file=sys.stderr)
    return b"" if raw else {}


def events(dataset, query, fields, sort=None, per_page=100, period=None, start=None, end=None):
    """Discover-style query over the project. Returns the list of rows (dicts)."""
    if SOURCE is not None:
        return SOURCE.rows(dataset, query, fields, sort=sort, start=start, end=end,
                           period=period, limit=per_page)
    p = {"dataset": dataset, "project": list(PIDS), "query": query, "field": fields, "per_page": per_page}
    if start and end:
        p["start"], p["end"] = start, end
    else:
        p["statsPeriod"] = period or "24h"
    if sort:
        p["sort"] = sort
    return dedupe(get(f"{BASE}/organizations/{ORG}/events/", p).get("data", []))


def stable_sort(fields, sort=None):
    """A sort that pages deterministically: the sort given, then tiebreaks that make every row's place unique. A grouped
    query (any aggregate field) adds its grouping fields, which together are unique per row; a row query adds its
    timestamp and the event id. Without it page 2 can repeat or skip rows, and dedupe cannot catch grouped rows, which
    carry no id."""
    first = [sort] if isinstance(sort, str) else list(sort or [])
    if any("(" in f for f in fields):
        tail = [f for f in fields if "(" not in f]
    else:
        tail = [f for f in ("timestamp", "id") if f in fields] or ([] if first else ["timestamp"])
    return first + [f for f in tail if f not in first and f.lstrip("-") not in first and "-" + f not in first]


def _projects(pids):
    """The project ids a query names: PIDS when pids is None. An EMPTY list is refused, never read as the default:
    a dump must name its project, and pids=[] silently meaning jollity-next is how test traffic gets read."""
    if pids is None:
        return list(PIDS)
    pids = list(pids)
    if not pids:
        raise ValueError("pids=[] names no project; pass None for the default")
    return pids


def _next_url(link):
    """The next page's URL out of a Link header, or None. Only a rel="next" that carries results="true" is followed."""
    part = next((p for p in link.split(",") if 'rel="next"' in p and 'results="true"' in p), None)
    found = re.search(r"<([^>]+)>", part or "")
    return found.group(1) if found else None


def _request(url, params):
    """One GET under the retry loop events_all used to hold: 429, 5xx and network timeouts, up to 8 attempts, a growing pause.
    Returns (status, body bytes, headers). A non-retryable HTTP error is RE-RAISED UNCHANGED as the original
    urllib.error.HTTPError: the pull stores str(error)[:200] in queryErrors and coverage_metrics reads error.code,
    so wrapping it would change report text."""
    for attempt in range(8):
        if _REQUEST_CONTROLLER is not None:
            _REQUEST_CONTROLLER.before_request()
        try:
            with _open(url, params) as response:
                return getattr(response, "status", 200), response.read(), response.headers
        except urllib.error.HTTPError as e:
            # 429 (several threads at once) and 5xx (a passing server fault) are retried with the same growing pause
            if (e.code == 429 or e.code >= 500) and attempt < 7:
                delay = _retry_delay(e, attempt)
                if _REQUEST_CONTROLLER is not None:
                    _REQUEST_CONTROLLER.retry(delay, status=e.code)
                else:
                    time.sleep(delay)
                continue
            raise
        except RETRYABLE_NETWORK_ERRORS:
            if attempt < 7:
                delay = min(0.5 * 2 ** attempt, 10) * (0.5 + random.random())
                if _REQUEST_CONTROLLER is not None:
                    _REQUEST_CONTROLLER.retry(delay, network=True)
                    time.sleep(delay)
                else:
                    time.sleep(delay)
                continue
            raise


def _retry_delay(error, attempt):
    """Retry-After seconds/date when present, otherwise the existing jittered backoff."""
    fallback = min(0.5 * 2 ** attempt, 10) * (0.5 + random.random())
    header = (getattr(error, "headers", None) or {}).get("Retry-After")
    if not header:
        return fallback
    try:
        return max(fallback, float(header))
    except (TypeError, ValueError):
        try:
            when = email.utils.parsedate_to_datetime(header)
            if when.tzinfo is None:
                when = when.replace(tzinfo=datetime.timezone.utc)
            return max(
                fallback,
                (when - datetime.datetime.now(datetime.timezone.utc)).total_seconds(),
            )
        except (TypeError, ValueError, OverflowError):
            return fallback


def _checked(label, fn):
    """Run fn() and turn every failure into SentryQueryError: an HTTPError, a retryable network failure that survived
    the retries, a body that is not JSON, and a body of the wrong shape (a dict where a list is expected, a missing
    key). The new helpers raise this one type, so the dump never has to read a bare transport error."""
    try:
        return fn()
    except SentryQueryError:
        raise
    except urllib.error.HTTPError as e:
        raise SentryQueryError(f"HTTP {e.code} {label} failed: {e}") from e
    except RETRYABLE_NETWORK_ERRORS as e:
        raise SentryQueryError(f"{label} failed: {e}") from e
    except (ValueError, TypeError, KeyError, IndexError, AttributeError) as e:
        raise SentryQueryError(f"{label} answered unusable data: {e!r}") from e


def _fetch(url, params):
    """GET one page as JSON: (parsed body, Link header). A non-retryable HTTP error is re-raised unchanged (see
    _request)."""
    status, raw, headers = _request(url, params)
    return json.loads(raw), headers.get("Link", "")


def pages(dataset, query, fields, sort=None, per_page=100, period=None, start=None, end=None, pids=None):
    """A generator yielding each page of a Discover query RAW, in order: the rows exactly as Sentry sent them, with no
    dedupe, so a repeated row is visible (P1). per_page above the dataset's cap is refused, not clamped. The project
    is read at call time (pids or PIDS), never copied at import. Pages follow Sentry's Link cursor under stable_sort."""
    if per_page > PER_PAGE_MAX[dataset]:
        raise ValueError(f"per_page {per_page} is over the {dataset} cap of {PER_PAGE_MAX[dataset]}")
    p = {"dataset": dataset, "project": _projects(pids), "query": query, "field": fields, "per_page": per_page}
    if start and end:
        p["start"], p["end"] = start, end
    else:
        p["statsPeriod"] = period or "24h"
    sort = stable_sort(fields, sort)
    if sort:
        p["sort"] = sort
    url = f"{BASE}/organizations/{ORG}/events/"
    while url:
        body, link = _fetch(url, p)
        yield body.get("data", [])
        url, p = _next_url(link), None


def project_event_pages(project, start, end, query=""):
    """Yield full error events from Sentry's cursor-paged project endpoint."""
    url = f"{BASE}/projects/{ORG}/{project}/events/"
    params = {"full": "true", "start": start, "end": end}
    if query:
        params["query"] = query
    while url:
        body, link = _checked("full project events", lambda: _fetch(url, params))
        if not isinstance(body, list):
            raise SentryQueryError("full project events answered unusable data: expected a list")
        yield body
        url, params = _next_url(link), None


HOST_PROJECTS = (("polkadot-ios", "ios"), ("polkadot-android", "android"))
HOST_REMINDER_EVENTS = ("scheduled", "fired", "tapped", "product_opened")


def host_reminder_events(start, end):
    """The Polkadot iOS and Android hosts' reminder events in the window, as [{title, timestamp, user, delivery,
    product_id, starts_at_unix_ms, app_variant, platform}] (platform "ios" or "android"). One query per project and
    event name over the project's full events; user is the device id. Each page request retries 429 and 5xx (_request)."""
    found = {}
    for project, platform in HOST_PROJECTS:
        for name in HOST_REMINDER_EVENTS:
            title = f"host.reminder.{name}"
            for page in project_event_pages(project, start, end, title):
                for event in page:
                    if event.get("title") != title:
                        continue
                    tags = {t.get("key"): t.get("value") for t in event.get("tags") or []}
                    found[(platform, event.get("eventID") or event.get("id"))] = {
                        "title": title, "timestamp": event.get("dateCreated"),
                        "user": (event.get("user") or {}).get("id") or str(tags.get("user", "")).removeprefix("id:") or None,
                        "delivery": tags.get("reminder.delivery"), "product_id": tags.get("reminder.product_id"),
                        "starts_at_unix_ms": (event.get("context") or {}).get("reminder.starts_at_unix_ms"),
                        "app_variant": tags.get("host.app_variant"), "platform": platform}
    return sorted(found.values(), key=lambda r: (r["timestamp"] or "", r["title"]))


def events_all(dataset, query, fields, sort=None, per_page=100, period=None, start=None, end=None):
    """All pages of one Discover query, following Sentry's Link cursor, under a stable sort (stable_sort)."""
    if SOURCE is not None:
        return SOURCE.rows(dataset, query, fields, sort=sort, start=start, end=end,
                           period=period, limit=None)
    return dedupe([r for page in pages(dataset, query, fields, sort, per_page, period, start, end) for r in page])


def count(dataset, query, start, end, pids=None, field=None):
    """The number of rows a query matches, through the dataset's own count function (COUNT_FIELD; field= overrides it,
    for comparing a sampled count_sample() with the plain count()). One row holding that field is the only answer
    accepted; an HTTP error or anything else raises SentryQueryError. It is NEVER built on get(), which returns {} on
    error: a naive count would read 0 and "0 == 0" would pass the completeness check."""
    field = field or COUNT_FIELD[dataset]
    p = {"dataset": dataset, "project": _projects(pids), "query": query, "field": [field], "per_page": 1,
         "start": start, "end": end}

    def one():
        body, _ = _fetch(f"{BASE}/organizations/{ORG}/events/", p)
        data = body.get("data")
        if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], dict) or field not in data[0]:
            raise SentryQueryError(f"count({dataset}) answer is not one row holding {field!r}: {body!r}")
        value = data[0][field]
        if value is None:
            raise SentryQueryError(f"count({dataset}) answered null for {field!r}")
        return int(round(float(value)))
    return _checked(f"count({dataset})", one)


def attribute_keys(item_type, start, end, pids=None):
    """Every attribute key of an EAP dataset (spans, logs, tracemetrics), across the three attribute types.
    Each is {"field": key, "name": name, "type": attributeType}; "field" is what goes in `field=`. Sorted by
    (string < number < boolean, field), so the group order is the same in every game. Follows the Link cursor."""
    out = []

    def one():
        for attribute_type in ("string", "number", "boolean"):
            p = {"itemType": item_type, "attributeType": attribute_type, "project": _projects(pids),
                 "start": start, "end": end}
            url = f"{BASE}/organizations/{ORG}/trace-items/attributes/"
            while url:
                body, link = _fetch(url, p)
                out.extend({"field": r["key"], "name": r["name"], "type": r["attributeType"]} for r in body)
                url, p = _next_url(link), None
        return sorted(out, key=lambda a: (ATTRIBUTE_ORDER.index(a["type"]), a["field"]))
    return _checked(f"attribute_keys({item_type})", one)


def tag_keys(dataset, start, end, pids=None):
    """Every tag key of errors or transactions. The API calls the errors dataset "events" and refuses "errors"."""
    api_dataset = {"errors": "events", "transactions": "transactions"}[dataset]
    p = {"dataset": api_dataset, "project": _projects(pids), "start": start, "end": end}

    def one():
        body, _ = _fetch(f"{BASE}/organizations/{ORG}/tags/", p)
        return sorted({r["key"] for r in body})
    return _checked(f"tag_keys({dataset})", one)


def measurement_keys(start, end, pids=None):
    """The measurements.* keys of transactions: the measurements-meta endpoint UNIONED with the fixed list (P3). That
    endpoint answered {} for jollity-next, and a partial answer would silently drop a rung of the upload ladder, so
    the fixed list is always in the answer."""
    p = {"project": _projects(pids), "start": start, "end": end}

    def one():
        body, _ = _fetch(f"{BASE}/organizations/{ORG}/measurements-meta/", p)
        found = set(body) if isinstance(body, dict) else set()
        return sorted(found | set(FIXED_MEASUREMENT_KEYS))
    return _checked("measurement_keys", one)


def raw_get(path):
    """(status, body bytes) of a GET under /api/0, through the retry loop. 404 returns (404, b""); any other non-2xx
    raises SentryQueryError. The dump uses it for the event JSON and the attachments."""
    url = BASE + path if path.startswith("/") else path

    def one():
        try:
            status, body, _ = _request(url, None)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return 404, b""
            raise
        return status, body
    return _checked(f"GET {url}", one)


def table(rows, fields):
    cols = [[f] + [str(r.get(f, "")) for r in rows] for f in fields]
    widths = [max(len(c) for c in col) for col in cols]
    for i in range(len(rows) + 1):
        print("  ".join(col[i].ljust(w) for col, w in zip(cols, widths)).rstrip())


def cmd_whoami(a):
    org = get(f"/organizations/{ORG}/")
    if org:
        print(f"Token works. Organization: {org.get('name')} ({org.get('slug')})")
    else:
        sys.exit(1)


def cmd_query(a):
    fields = list(a.field)
    if a.sort and a.sort.lstrip("-") not in fields:
        fields.append(a.sort.lstrip("-"))  # the API wants every sort field in `field` too
    rows = events(a.dataset, a.query, fields, a.sort, a.limit, a.period, a.start, a.end)
    if a.json:
        print(json.dumps(rows, indent=1))
    else:
        table(rows, fields)
        print(f"\n{len(rows)} rows", file=sys.stderr)


def event_get(event_id, suffix="", raw=False, row=None, fetch=None):
    """GET /projects/<project>/events/<id>/<suffix> in the event's project: the row's own one when it
    carries "project", else the first project being read that answers."""
    fetch = fetch or get
    for slug in event_projects(row):
        r = fetch(f"/projects/{ORG}/{slug}/events/{event_id}/{suffix}", raw=raw)
        if r:
            return r
    return b"" if raw else {}


def cmd_event(a):
    print(json.dumps(event_get(a.event_id), indent=1))


def cmd_attachment(a):
    atts = event_get(a.event_id, "attachments/")
    if not atts:
        sys.exit("No attachments on that event.")
    for i, att in enumerate(atts):
        data = event_get(a.event_id, f"attachments/{att['id']}/?download=1", raw=True)
        if a.out:
            path = a.out if len(atts) == 1 else f"{a.out}.{i}"
            open(path, "wb").write(data)
            print(f"saved {att['name']} ({len(data)} bytes) to {path}")
        else:
            sys.stdout.write(data.decode(errors="replace"))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", help="a project or comma list (dim2-testing also reads jollity-next); default: DIM2_SENTRY_PROJECT, else jollity-next")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("whoami").set_defaults(fn=cmd_whoami)
    q = sub.add_parser("query")
    q.add_argument("dataset")
    q.add_argument("query")
    q.add_argument("-f", "--field", action="append", required=True)
    q.add_argument("--period", help="e.g. 24h, 7d (default 24h when no --start/--end)")
    q.add_argument("--start", help="ISO UTC, e.g. 2026-10-01T15:45:00")
    q.add_argument("--end")
    q.add_argument("--sort")
    q.add_argument("--limit", type=int, default=100)
    q.add_argument("--json", action="store_true")
    q.set_defaults(fn=cmd_query)
    e = sub.add_parser("event")
    e.add_argument("event_id")
    e.set_defaults(fn=cmd_event)
    t = sub.add_parser("attachment")
    t.add_argument("event_id")
    t.add_argument("--out")
    t.set_defaults(fn=cmd_attachment)
    a = ap.parse_args()
    if a.project:
        use_project(a.project)
    a.fn(a)


if __name__ == "__main__":
    main()
