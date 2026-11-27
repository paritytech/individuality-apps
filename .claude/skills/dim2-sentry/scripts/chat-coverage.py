#!/usr/bin/env python3
# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""Chat-worker telemetry by platform, joined to the app by user.id (#519).

  python3 chat-coverage.py [--days 7 | --start ISO --end ISO] [--context-days 30] [--include-bots] [--json FILE]

The chat worker sends no OS data of its own. Its events and spans (sdk jollity.chat-worker, tag surface:chat) carry
user.id, and the same user's APP rows carry the device tags (device.os, device.os_version, device.model, host.app,
host.app_version). The user.id is the same account address on both sides. This joins the two and prints, read-only
against Sentry (errors, spans, tracemetrics, logs):
  1. per platform (OS + host app version): users with app rows, users with chat rows, coverage (the share of the app's
     users with at least one chat event or span) and chat rows per chat user;
  2. per user: platform, app rows (errors/spans/metrics/logs), chat rows, the last chat event, and a user with app rows
     and ZERO chat rows flagged "NO CHAT": the "this platform sends nothing" signal.
App activity and chat counts use the window (--days or --start/--end): "app users", the coverage denominator, NO CHAT
and the app e/s counts are all window-bounded. The device context is looked up over a WIDER window (--context-days,
default 30, ending at the window's end) and is used ONLY to label the platform: the worker polls without the app being
opened, so a chat user is often not in the app's rows for the same days. A user's context is the most recent DATED app row with a device.os; an
undated row (tracemetrics, queried only for users still missing a context) never replaces a dated one, and among
undated rows the first is kept. A user seen on more than one OS is platform "mixed". A chat user with no app row at all in
the context window is "chat only (no app use)": a player who only uses the chat (a sign-up from the chat, say), coverage
n/a. "unknown" is kept for a user whose app rows lack device info. Bots: the worker never sets test.tag, so the bot
user.ids are those with a test.tag app row in the context window; they are dropped from the chat side unless
--include-bots. So is any user whose app context has host.app "Headless Signing Host" (truapi-host: our bots and the desk
dev-host, never a real phone), dropped on both sides (app and chat), like every bot. Times printed are local (the machine's zone).
"""
import argparse, collections, datetime, importlib.util, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sentry import events_all, parse_ts, table
import sentry_logs

_pull_spec = importlib.util.spec_from_file_location("chat_coverage_pull", os.path.join(os.path.dirname(__file__), "game-report-pull.py"))
_puller = importlib.util.module_from_spec(_pull_spec)
_pull_spec.loader.exec_module(_puller)

CHAT_SDK = "jollity.chat-worker"
DEVICE = ["device.os", "device.os_version", "device.model", "host.app", "host.app_version"]
UNKNOWN = "unknown"
CHAT_ONLY = "chat only (no app use)"
HEADLESS = "Headless Signing Host"  # truapi-host: our bots and the desk dev-host, never a real phone
MIXED = "mixed"
MISSING = (None, "")


# ---------------------------------------------------------------- pure helpers (tested in test_chat_coverage.py)

def to_epoch(value):
    """Sentry's timestamp as epoch seconds: an ISO string (errors) or epoch SECONDS (spans); None when absent."""
    if value in MISSING:
        return None
    return parse_ts(value * 1000 if isinstance(value, (int, float)) else value).timestamp()


def platform_label(ctx):
    """'ios · Polkadot App 0.10.0', 'android · Polkadot 1.0.0 (1029)'; the OS alone when the host is not named; unknown with no OS."""
    if not ctx or ctx.get("device.os") in MISSING:
        return UNKNOWN
    host = " ".join(str(ctx[k]) for k in ("host.app", "host.app_version") if ctx.get(k) not in MISSING)
    return f"{ctx['device.os']} · {host}" if host else ctx["device.os"]


def bot_ids(bot_rows):
    """The user.ids of rows that carry a test.tag: the worker sets none, so this is how a bot's chat rows are recognised."""
    return {r["user.id"] for r in bot_rows if r.get("user.id") not in MISSING}


def build_users(app_rows, chat_rows, bots=frozenset(), include_bots=False, context_rows=()):
    """Join the pulls by user.id. app_rows: the WINDOW's app activity (dataset, user.id, device.*, host.*, count, last); only these
    count as app use. context_rows: the wider window, used only to recover a platform label (their counts are ignored). chat_rows:
    user.id, name, count, first, last (events and spans alike). Unless include_bots, a user in bots is dropped from every pull. A user's context is the newest DATED app row;
    an undated row only fills an empty context, and the first undated one stays. Unless include_bots, a user whose context host.app is
    the headless signing host is dropped."""
    users = {}

    def entry(uid):
        return users.setdefault(uid, {"ctx": None, "ctx_ts": None, "oses": set(), "app_counts": collections.Counter(), "chat_events": 0,
                                      "chat_names": collections.Counter(), "first_chat": None, "last_chat": None, "last_chat_name": None})

    for r, counts in [(r, True) for r in app_rows] + [(r, False) for r in context_rows]:
        uid = r.get("user.id")
        if uid in MISSING or r.get("device.os") in MISSING or (uid in bots and not include_bots):
            continue
        u = entry(uid)
        if counts:
            u["app_counts"][r.get("dataset") or "?"] += int(r.get("count") or 0)
        u["oses"].add(r["device.os"])
        ts = to_epoch(r.get("last"))
        if u["ctx"] is None or (ts is not None and (u["ctx_ts"] is None or ts >= u["ctx_ts"])):
            u["ctx"], u["ctx_ts"] = {k: r.get(k) for k in DEVICE}, ts
    for r in chat_rows:
        uid = r.get("user.id")
        if uid in MISSING or (uid in bots and not include_bots):
            continue
        u = entry(uid)
        n = int(r.get("count") or 0)
        u["chat_events"] += n
        u["chat_names"][r.get("name") or "?"] += n
        first, last = to_epoch(r.get("first")), to_epoch(r.get("last"))
        if first is not None and (u["first_chat"] is None or first < u["first_chat"]):
            u["first_chat"] = first
        if last is not None and (u["last_chat"] is None or last >= u["last_chat"]):
            u["last_chat"], u["last_chat_name"] = last, r.get("name")
    if not include_bots:
        users = {k: u for k, u in users.items() if (u["ctx"] or {}).get("host.app") != HEADLESS}
    for u in users.values():
        u["has_app"] = bool(u["app_counts"])
        u["platform"] = MIXED if len(u["oses"]) > 1 else platform_label(u["ctx"]) if u["ctx"] else CHAT_ONLY
    return users


def coverage(with_chat, with_app):
    """Share of the app's users that sent chat rows, 0..1; None when there are no app users."""
    return with_chat / with_app if with_app else None


def platform_rows(users):
    """One row per platform: users_app, users_chat (all chat users on it), both (app users with chat), coverage, chat_events, per_chat_user."""
    groups = collections.defaultdict(lambda: {"users_app": 0, "users_chat": 0, "both": 0, "chat_events": 0})
    for u in users.values():
        g = groups[u["platform"]]
        if u["has_app"]:
            g["users_app"] += 1
        if u["chat_events"]:
            g["users_chat"] += 1
            g["chat_events"] += u["chat_events"]
            if u["has_app"]:
                g["both"] += 1
    rows = []
    for name, g in groups.items():
        rows.append({"platform": name, **g, "coverage": coverage(g["both"], g["users_app"]),
                     "per_chat_user": g["chat_events"] / g["users_chat"] if g["users_chat"] else None})
    return sorted(rows, key=lambda r: (r["platform"] in (UNKNOWN, CHAT_ONLY, MIXED), -r["users_app"], r["platform"]))


def user_rows(users):
    """Per-user rows, flagged when the user has app rows and no chat rows; flagged first."""
    rows = [{"user": uid, "platform": u["platform"], "oses": sorted(u["oses"]), "os_version": (u["ctx"] or {}).get("device.os_version"),
             "model": (u["ctx"] or {}).get("device.model"), "has_app": u["has_app"],
             "app_counts": {k: u["app_counts"].get(k, 0) for k in DATASETS}, "chat_events": u["chat_events"],
             "chat_names": dict(u["chat_names"]), "first_chat": u["first_chat"], "last_chat": u["last_chat"],
             "last_chat_name": u["last_chat_name"], "no_chat": u["has_app"] and not u["chat_events"]}
            for uid, u in users.items()]
    return sorted(rows, key=lambda r: (not r["no_chat"], r["platform"], -r["chat_events"], r["user"]))


def windows(days, start, end, context_days):
    """(chat window, context window) as Sentry params. The context window reaches context_days back from the window's end (or to its start, if that is earlier)."""
    if start and end:
        back = min(parse_ts(start), parse_ts(end) - datetime.timedelta(days=context_days))
        return {"start": start, "end": end}, {"start": back.strftime("%Y-%m-%dT%H:%M:%S"), "end": end}
    return {"period": f"{days}d"}, {"period": f"{max(days, context_days)}d"}


# ---------------------------------------------------------------- Sentry pulls

DATASETS = ["errors", "spans"]


def merge_new_chat_rows(metrics, logs):
    """One detailed chatCount emits both records; count it once and retain its Log clock."""
    combined = {}
    for source in (metrics, logs):
        for row in source:
            key = (row.get("user.id"), row.get("name"))
            if key not in combined:
                combined[key] = dict(row)
                continue
            current = combined[key]
            current["count"] = max(int(current.get("count") or 0), int(row.get("count") or 0))
            current["first"] = current.get("first") or row.get("first")
            current["last"] = current.get("last") or row.get("last")
    return list(combined.values())


def pull(window, context, include_bots):
    """Returns (window app rows, context rows, chat rows, bot ids, query errors). Context rows only label platforms;
    tracemetrics, which carry no clock, are asked only when a chat user still has no context."""
    app, ctx, chat, bots, errors = [], [], [], set(), {}
    base = f"has:user.id has:device.os !sdk.name:{CHAT_SDK}" + ("" if include_bots else " !has:test.tag")
    fields = ["user.id"] + DEVICE + ["count()", "max(timestamp)"]
    for ds in ("errors", "spans"):
        for span, into in ((window, app), (context, ctx)):
            for r in events_all(ds, base, fields, per_page=100, **span):
                into.append({**{k: r.get(k) for k in ["user.id"] + DEVICE}, "dataset": ds,
                             "count": r.get("count()"), "last": r.get("max(timestamp)")})
        if not include_bots:
            bots |= bot_ids(events_all(ds, f"has:user.id has:test.tag !sdk.name:{CHAT_SDK}", ["user.id", "count()"], per_page=100, **context))
    chat_users = set()
    for ds, name in (("errors", "title"), ("spans", "span.op")):
        for r in events_all(ds, f"sdk.name:{CHAT_SDK} has:user.id", ["user.id", name, "count()", "min(timestamp)", "max(timestamp)"], per_page=100, **window):
            chat_users.add(r.get("user.id"))
            chat.append({"user.id": r.get("user.id"), "name": r.get(name), "count": r.get("count()"),
                         "first": r.get("min(timestamp)"), "last": r.get("max(timestamp)")})
    log_chat = []
    try:
        for r in events_all("logs", f"sentry.sdk.name:{CHAT_SDK} has:user.id",
                            ["user.id", "message", "count()", "min(timestamp)", "max(timestamp)"], per_page=100, **window):
            log_chat.append({"user.id": r.get("user.id"), "name": str(r.get("message") or "").split("\t", 1)[0],
                             "count": r.get("count()"), "first": r.get("min(timestamp)"),
                             "last": r.get("max(timestamp)"), "source": "logs"})
    except Exception as error:
        errors["chat logs"] = str(error)[:200]
    metric_window = dict(window)
    metric_start, metric_end = metric_window.pop("start", None), metric_window.pop("end", None)
    metric_chat = []
    try:
        metric_chat = [{"user.id": r.get("user.id"), "name": r.get("name"), "count": r.get("count()"),
                        "first": r.get("first"), "last": r.get("last"), "source": "metrics"}
                       for r in sentry_logs.chat_metric_rows(
                           "metric.name:chat.*", [], metric_start, metric_end,
                           _metric_groups=_puller.metric_groups, **metric_window)]
    except Exception as error:
        errors["chat metrics"] = str(error)[:200]
    for r in merge_new_chat_rows(metric_chat, log_chat):
        chat_users.add(r.get("user.id"))
        chat.append(r)
    have = {r["user.id"] for r in app + ctx}
    if chat_users - have - bots:  # a chat user without a context: the metrics carry the device scope but no clock
        try:
            for r in events_all("tracemetrics", "has:user.id has:device.os", ["user.id"] + DEVICE + ["count(value)"], per_page=100, **context):
                if r.get("user.id") not in have:
                    ctx.append({**{k: r.get(k) for k in ["user.id"] + DEVICE}, "dataset": "metrics", "count": r.get("count(value)"), "last": None})
        except Exception as error:
            errors["device metrics"] = str(error)[:200]
    return app, ctx, chat, bots, errors


# ---------------------------------------------------------------- output

def local(epoch):
    return datetime.datetime.fromtimestamp(epoch).astimezone().strftime("%m-%d %H:%M %Z") if epoch else "-"


def local_iso(s):
    return parse_ts(s).astimezone().strftime("%Y-%m-%d %H:%M %Z")


def pct(x):
    return "n/a" if x is None else f"{x * 100:.0f}%"


def render(users):
    prows = platform_rows(users)
    print("\nBy platform (OS + host app version)\n")
    cols = ["platform", "app users", "chat users", "both", "coverage", "chat rows", "rows/chat user"]
    table([dict(zip(cols, [r["platform"], r["users_app"], r["users_chat"], r["both"], pct(r["coverage"]), r["chat_events"],
                           "-" if r["per_chat_user"] is None else f"{r['per_chat_user']:.1f}"])) for r in prows], cols)
    urows = user_rows(users)
    print("\nBy user (users with app rows and no chat rows first, flagged NO CHAT)\n")
    cols = ["user", "platform", "os ver", "app e/s/m", "chat rows", "last chat event", "last chat", "flag"]
    table([dict(zip(cols, [r["user"][:10], r["platform"] if r["platform"] != MIXED else f"mixed ({', '.join(r['oses'])})", r["os_version"] or "-",
                           "/".join(str(r["app_counts"][k]) for k in DATASETS) if r["has_app"] else "-", r["chat_events"],
                           r["last_chat_name"] or "-", local(r["last_chat"]), "NO CHAT" if r["no_chat"] else ""])) for r in urows], cols)
    return prows, urows


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--start", help="ISO UTC")
    ap.add_argument("--end", help="ISO UTC")
    ap.add_argument("--context-days", type=int, default=30, help="how far back the app's device context is looked up (default 30)")
    ap.add_argument("--include-bots", action="store_true")
    ap.add_argument("--json", help="also write the platform and user rows here")
    a = ap.parse_args()
    if bool(a.start) != bool(a.end):
        ap.error("--start and --end go together")
    window, context = windows(a.days, a.start, a.end, a.context_days)
    now = datetime.datetime.now().astimezone()
    span = f"{local_iso(a.start)} to {local_iso(a.end)}" if a.start else f"last {a.days} days"
    print(f"Chat coverage, {span}, device context over {a.context_days} days, made {now:%Y-%m-%d %H:%M %Z}"
          f"{', bots included' if a.include_bots else ', bots left out'}")
    app, ctx, chat, bots, query_errors = pull(window, context, a.include_bots)
    prows, urows = render(build_users(app, chat, bots, a.include_bots, ctx))
    if a.json:
        with open(a.json, "w") as f:
            json.dump({"platforms": prows, "users": urows,
                       **({"queryErrors": query_errors} if query_errors else {})}, f, indent=1)
        print(f"\nwrote {a.json}")


if __name__ == "__main__":
    main()
