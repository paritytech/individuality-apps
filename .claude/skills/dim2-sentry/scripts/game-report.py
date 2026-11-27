#!/usr/bin/env python3
# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""One command for a DIM2 game report: mechanical draft, lint, then human judgment.

  python3 .claude/skills/dim2-sentry/scripts/game-report.py <game> [--out report.json] [--logs-dir DIR]
                                                            [--ws URL] [--no-chain]

Run it from the repo root (it runs `npx tsx scripts/game-chain-report.mts` there). It needs the
Sentry token (see SKILL.md, One-time setup) and the chain archive RPC (--ws, else PEOPLE_WS, else
the chain script's own default). A chain failure fails the run; --no-chain skips the chain. It writes:

  <telemetry store>/usernames.json
                              our shared account -> username mapping: names learned this run are added,
                              and a player with no name from Sentry or the logs is filled from it
                              (usernameSource "mapping"). seed-usernames.py fills it from every archived game log.
  <out>                       the full local report, in the shape of references/game-report.md
  <out dir>/report-publish.json  the trimmed main ArtifactData document
  <out dir>/sentry-pull.json  the raw Sentry pull the document was built from
  <out dir>/chain.json        what the chain reader found (scripts/game-chain-report.mts)
  <out dir>/links.json        game-links.py on the logs (also saved with the logs)
  <logs dir>/*.json           every game-log attachment, named as in docs-internal/game-logs

and prints where they are. The command drafts `summary`, `issues`, and `coverageNote`, then runs
report-lint.py before it publishes report-publish.json. Claude reviews the marked judgment slot and the
raw evidence; no generated number or data sentence is edited by hand. `facts` is a starting
checklist of mechanical findings, not the limit of what is worth looking at.

Order: the chain gives kickoff, settlement and the registered accounts, so the Sentry window is
the chain's registration-open time (--pad-before overrides) to settlement + 10 min (without the chain, the first and last game.index event
padded the same way). Then the logs are fetched once, the pull runs with the chain's accounts
added, the parsed logs go through game-links.py, and everything is assembled by the pure
functions below (tested in test_game_report.py). Times in text are Central European (CET or CEST).
"""
import argparse
import collections
import concurrent.futures
import contextlib
import dataclasses
import datetime
import hashlib
import importlib.util
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sentry  # noqa: E402
import sentry_logs  # noqa: E402
import store_paths  # noqa: E402
from sentry import parse_ts  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
BERLIN = ZoneInfo("Europe/Berlin")
SKEW_S = 30           # a phone clock this far from the others (after the chain offset) is flagged
HIDDEN_S = 60         # a reporter whose app was out of view this long during the game is flagged
REG_SLACK_MIN = 0     # the report counts telemetry from the block where the game was scheduled (chain registrationOpens), no padding before
INTERIM_MARGIN_MIN = 2  # an interim chain (no settlement yet) ends its windows this long after interimAt
PAYOFF_MIN = 10       # ...until this long after settlement: the prize draw, the chest and the end-of-game screen open after the chain settles
SLOW_PCT = 25         # a player with this share of slow frames in the round stands alone in the smoothness rows
SLOW_MOMENT_MS = 200  # a player whose ending moment averages this long gets a row of their own
COVERAGE_JOINED_PEER_MS = 10_000  # above stale ICE's few-second connected tail; far below one 12 s turn
WORKERS = 4
SHORT = lambda a: a[:4] + "…"
SKILL = os.path.dirname(HERE)
USERNAMES_SEED = os.path.join(SKILL, "data", "usernames.json")  # tracked, read-only bootstrap data
SHARED_USERNAMES = store_paths.usernames_path()
USERNAMES = SHARED_USERNAMES  # shared main-checkout mapping; encrypted before it enters git
# The deployed app version is a source hash, not the Git commit tagged by the release workflow.
# Record the workflow's promoted version here; unknown hashes stay visible rather than being guessed.
RELEASE_LABEL_BY_APP_HASH = {"246bcd99": "0.1.37"}



def load_usernames(path=USERNAMES):
    """Our account -> username mapping; the tracked seed bootstraps only the shared master."""
    mapping = gl.read_json(path) or {}
    if os.path.abspath(path) == os.path.abspath(SHARED_USERNAMES):
        return {**(gl.read_json(USERNAMES_SEED) or {}), **mapping}
    return mapping


def history_usernames(pull, mapping, end, days=30):
    """account -> username for the pulled accounts that have none yet (no user name in the window, none in the
    mapping), from any of their Sentry rows over the `days` before `end`. A chat-only account never sends a username,
    so it stays nameless."""
    nameless = sorted(a for a, p in pull.get("players", {}).items()
                      if a not in mapping and not any(r.get("user.username") for r in p.get("roots", [])))
    if not nameless:
        return {}
    since = (parse_ts(end) - datetime.timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S")
    found = {}
    for start in range(0, len(nameless), 50):
        scope = "user.id:[" + ",".join(nameless[start:start + 50]) + "]"
        for dataset in ("spans", "errors"):
            try:
                rows = sentry.events_all(dataset, scope + " has:user.username", ["user.id", "user.username", "count()"], per_page=100, start=since, end=end)
            except sentry.OutOfStore:
                raise
            except Exception as error:
                print(f"username {dataset} query failed: {error}", file=sys.stderr)
                continue
            for row in sorted(rows, key=lambda r: -(fnum(r.get("count()")) or 0)):  # the name the account used most
                name = row.get("user.name") or row.get("user.username")
                if row.get("user.id") in nameless and name:
                    found.setdefault(row["user.id"], name)
        for dataset, count in (("logs", "count()"), ("tracemetrics", "count(value)")):
            try:
                rows = sentry.events_all(dataset, scope + " has:user.name", ["user.id", "user.name", count], per_page=100, start=since, end=end)
            except sentry.OutOfStore as error:  # a name is optional: no stored rows for it means no name, not a stop
                print(f"username {dataset} lookup out of store, skipped: {error}", file=sys.stderr)
                continue
            except Exception as error:
                print(f"username {dataset} query failed: {error}", file=sys.stderr)
                continue
            for row in sorted(rows, key=lambda r: -(fnum(r.get(count)) or 0)):
                name = row.get("user.name") or row.get("user.username")
                if row.get("user.id") in nameless and name:
                    found.setdefault(row["user.id"], name)
    return found


def save_usernames(path, mapping):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(dict(sorted(mapping.items())), f, indent=1, ensure_ascii=False)
        f.write("\n")


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


gl = _load("game_links", "game-links.py")
puller = _load("game_report_pull", "game-report-pull.py")
report_lint = _load("report_lint", "report-lint.py")


# --------------------------------------------------------------------------- small helpers

def cest(dt, secs=False):
    """HH:MM (or HH:MM:SS) in Central European time."""
    return dt.astimezone(BERLIN).strftime("%H:%M:%S" if secs else "%H:%M")


def tz_label(dt):
    """CET or CEST, whichever applies in Berlin at this instant."""
    return dt.astimezone(BERLIN).tzname()


def evidence_cest(dt, deadline, secs=False):
    """Local evidence time, including its date when it is not on the deadline's local day."""
    local = dt.astimezone(BERLIN)
    if deadline is not None and local.date() != deadline.astimezone(BERLIN).date():
        clock = local.strftime("%H:%M:%S" if secs else "%H:%M")
        return f"{local:%a} {local.day} {local:%b} {clock}"
    return local.strftime("%H:%M:%S" if secs else "%H:%M")


def local_window_label(start, end):
    """A local-time window whose dates are explicit when it crosses days."""
    a, b = start.astimezone(BERLIN), end.astimezone(BERLIN)
    if a.date() != b.date():
        stamp = lambda value: f"{value:%a} {value.day} {value:%b %H:%M}"
        return f"{stamp(a)} to {stamp(b)} {b.tzname()}"
    return f"{a:%H:%M} to {b:%H:%M} {b.tzname()}"


def times_note(kickoff_dt):
    n = kickoff_dt.astimezone(BERLIN).tzname()
    off = "UTC+2" if n == "CEST" else "UTC+1"
    word = "Summer" if n == "CEST" else "Standard"
    return (f"All times are Central European {word} Time ({n}, {off}), except kickoff, which is ISO UTC. "
            "Journey and step times come from Sentry (stamped from the wall clock since #221; earlier builds can run early); "
            "log times are the phones' own clocks; chain times are block timestamps.")


def median(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def f1(x):
    return None if x is None else round(x, 1)


def fnum(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def tally(a, name):
    """'name yes/no' for one chain account row; `name` maps an account to its display name."""
    return f"{name(a['account'])} {a['yesPerson']}/{a['noNotPerson']}"


def tied(accounts):
    """Accounts whose yes and no tallies are equal and not zero (a tie loses)."""
    return [a for a in accounts if a["yesPerson"] == a["noNotPerson"] and a["yesPerson"] > 0]


def passes_at_close(yes, no):
    """Whether a reporter with these tallies passes when reporting closes: yes votes less 1, stopping at 0, reach the no votes."""
    return max(yes - 1, 0) >= no


def add_note(j, text):
    """Append text to a journey dict's note, joined with '; '."""
    j["note"] = f"{j['note']}; {text}" if j.get("note") else text
    return j


# --------------------------------------------------------------------------- vote trail (from a game log)

def vote_trail(log):
    """What one player's log says about how they voted and filed. Times are the phone's epoch ms.

    taps: vote taps. turns: sealed turns. defaults: verdicts that were sealed by the timer
    (the sum of `auto` over `turn sealed`, less each `seal overridden` and plus each `seal
    restored`: a tap or ban on a turn a backward clock step re-opened replaces its default, and
    the undo puts it back, #569). built: the first `report built` (its filedBy and
    per-target verdicts). signed: the first signtx after it. overrides: confirm-screen changes,
    each with `late` (after the report was built, so the report did not carry it) and
    `afterSign` (after the transaction was signed too).
    """
    es = log.get("entries", [])
    votes = [e for e in es if e.get("tag") == "vote"]
    taps = [e for e in votes if e.get("message") == "tap"]
    sealed = [e for e in votes if e.get("message") == "turn sealed"]
    built = next((e for e in votes if e.get("message") == "report built"), None)
    if not (taps or sealed or built):
        return None
    signs = [e for e in es if e.get("tag") == "signtx"]
    signed = next((e for e in signs if built and e["ts"] >= built["ts"]), None)
    d = built.get("data", {}) if built else {}
    ovs = []
    for e in votes:
        if e.get("message") != "override":
            continue
        ovs.append({"ts": e["ts"], "target": (e.get("data") or {}).get("target"), "verdict": (e.get("data") or {}).get("verdict"),
                    "late": bool(built and e["ts"] > built["ts"]),
                    "afterSign": bool(signed and e["ts"] > signed["ts"]),
                    "sBeforeBuild": round((built["ts"] - e["ts"]) / 1000, 1) if built and e["ts"] <= built["ts"] else None,
                    "sAfterBuild": round((e["ts"] - built["ts"]) / 1000, 1) if built and e["ts"] > built["ts"] else None})
    return {"taps": len(taps), "turns": len(sealed),
            "defaults": sum(len((e.get("data") or {}).get("auto", [])) for e in sealed)
            - sum(1 for e in votes if e.get("message") == "seal overridden")
            + sum(1 for e in votes if e.get("message") == "seal restored"),
            "filedBy": d.get("filedBy"), "built": built["ts"] if built else None, "signed": signed["ts"] if signed else None,
            "verdicts": d.get("players", {}), "overrides": ovs}


def seen_accounts(log):
    """Accounts the player's own log got video from (`<- track from <account>`)."""
    out = set()
    for e in log.get("entries", []):
        m = re.search(r"track from (" + gl.ADDR + ")", e.get("message", ""))
        if m:
            out.add(m.group(1))
    return out


def game_mesh_opens(log, game):
    """Epoch ms of every mesh open of this game in a log."""
    return [m["ts"] for m in gl.mesh_opens(log.get("entries", [])) if m["room"].startswith(f"g{game}:")]


def game_presence_accounts(game, pull, chain, logs, window):
    """Registered accounts seen from or about during play, plus chain reporters.

    This is the single definition behind the funnel's joined stage and the
    link view's never-joined state.  A co-player's game log counts as evidence
    about an account when a line names it, even if that account sent nothing.
    """
    players = pull.get("players") or {}
    chain_by = {row["account"]: row for row in (chain or {}).get("accounts", [])}
    registered = set(chain_by) if chain else set(players)
    present = {account for account, row in chain_by.items() if row.get("sentReport")}

    for account in registered:
        player = players.get(account) or {}
        evidence = live_evidence(player, window)
        game_steps = [row for row in player.get("steps", []) if _in(row.get("timestamp"), window)]
        if evidence["app"] or game_steps:
            present.add(account)
        for pair in player.get("linkPairs", []):
            present.update(set(gl.ADDR_RE.findall(str(pair.get("rtc.pair") or ""))) & registered)

    if window:
        start_ms, end_ms = (value.timestamp() * 1000 for value in window)
    else:
        start_ms = end_ms = None
    for owner, log in logs.items():
        for entry in log.get("entries", []):
            ts = entry.get("ts")
            if ts is None or (start_ms is not None and not start_ms <= ts <= end_ms):
                continue
            if owner in registered:
                present.add(owner)
            # Assigned rooms, addPeer and connection attempts name no-shows.
            # Only an event that proves the remote side existed counts as
            # telemetry *about* that peer.
            message = entry.get("message") or ""
            proves_peer = (re.search(r"<- track from " + gl.ADDR, message)
                           or re.search(r"\[jollity-rtc\] channel open " + gl.ADDR, message)
                           or re.search(r"\[jollity-rtc\] pc " + gl.ADDR + r" connected", message)
                           or re.search(r"\[jollity-rtc\] path " + gl.ADDR + r" ", message))
            if proves_peer:
                present.update(set(gl.ADDR_RE.findall(message)) & registered)
    return present & registered


def shared_rounds(a, b, chain_by):
    """How many rounds two accounts sat in the same group (a vote counts once per shared round)."""
    ga, gb = chain_by.get(a, {}).get("groups", []), chain_by.get(b, {}).get("groups", [])
    return sum(1 for x, y in zip(ga, gb) if x == y and x is not None and x >= 0)


def override_effects(trails, chain_by):
    """The late overrides, with what they would have done to the target's tally on chain.

    A late override whose verdict differs from the verdict the report was built with is a lost
    change. Its weight is the number of rounds reporter and target shared.
    """
    out = []
    for rep, t in trails.items():
        for o in t["overrides"]:
            tgt = o["target"]
            built_v = (t["verdicts"].get(tgt) or {}).get("verdict")
            if not o["late"] or built_v is None or o["verdict"] == built_v:
                continue
            c = chain_by.get(tgt)
            w = shared_rounds(rep, tgt, chain_by)
            row = {"reporter": rep, "target": tgt, "verdict": o["verdict"], "builtVerdict": built_v, "sAfterBuild": o["sAfterBuild"],
                   "afterSign": o["afterSign"], "weight": w}
            if c is not None and w:
                yes, no = c["yesPerson"], c["noNotPerson"]
                nyes, nno = (yes + w, no - w) if o["verdict"] == "person" else (yes - w, no + w)
                row.update({"tally": [yes, no], "tallyIfKept": [nyes, nno], "flips": c["sentReport"] and passes_at_close(yes, no) != passes_at_close(nyes, nno)})
            out.append(row)
    out.sort(key=lambda r: (r["sAfterBuild"] is None, r["sAfterBuild"]))
    return out


def hidden_seconds(links):
    """account -> seconds the app was out of view during the game's rounds (from links.json events)."""
    hidden = collections.defaultdict(float)
    rounds = (links or {}).get("rounds") or []
    if not rounds:
        return hidden
    g0 = rounds[0].get("playStart") or rounds[0]["start"]
    g1 = rounds[-1].get("playEnd") or rounds[-1]["end"]
    open_at = {}
    for e in sorted((links or {}).get("events", []), key=lambda e: e["at"]):
        if e["kind"] == "hidden":
            open_at[e["account"]] = e["at"]
        elif e["kind"] == "shown" and e["account"] in open_at:
            s, t1 = max(open_at.pop(e["account"]), g0), min(e["at"], g1)
            if t1 > s:
                hidden[e["account"]] += (t1 - s) / 1000
    return hidden


# --------------------------------------------------------------------------- the pieces of the document

CHAT_LABELS = {"chat.card.first_draw_ms": "cards", "chat.first_read_ms": "cards", "chat.poll.duration_ms": "polling", "journey.game-signup": "sign-up attempt"}
FUNNEL_TITLE = "entered from the app, chat sign-up, or chain"


def chat_activity(roots):
    """A short list of what a chat-only account did, off its chat roots."""
    seen = []
    for r in roots:
        op = r.get("span.op") or "?"
        label = CHAT_LABELS.get(op) or op.removeprefix("chat.").removesuffix("_ms").replace("_", " ")
        if label not in seen:
            seen.append(label)
    return ", ".join(seen[:4]) or "no spans"


HUMANITY_STEP = "payoff.humanity.open"


def funnel(live, app, registered, steps, why, window_note="", outside=(), chat_signup=()):
    """The one funnel, from the accounts where the person did something while the game was live.

    live: accounts that opened the app or signed up from the chat; app is the part of it that opened the app, the rest signed up
    from the chat alone (the split on stage 1). steps: [(key, name, accounts, note, measured)] after "registered", in the app's order.
    Every stage is a subset of the one before; registration counts from stage 1. An account is dropped once, at the first stage it
    misses. why(stage_key, account) gives the reason from the document's own data, or None (then "unknown").
    A stage that is not measured yet has count None and no accounts; the next stage is then counted from the last measured one.
    """
    live = set(live)
    reg = set(registered) & live
    opened = set(app) & live
    chat_su = (set(chat_signup) & live) - opened
    entry_rows = [
        {"key": "openedApp", "stage": "Opened the app (SPA)", "count": len(opened), "accounts": sorted(opened)},
        {"key": "chatSignup", "stage": "Signed up from the chat without opening the app", "count": len(chat_su), "accounts": sorted(chat_su)},
        {"key": "onChainOnly", "stage": "On chain only, no sign-up or app telemetry", "count": len(live - opened - chat_su), "accounts": sorted(live - opened - chat_su)},
    ]
    out = [{"n": 1, "key": "live", "stage": FUNNEL_TITLE + (f" ({window_note})" if window_note else ""), "count": len(live), "accounts": sorted(live), "from": None,
            "dropped": [], "note": "Accounts that opened the app, signed up from the chat, or are registered on chain for this game. The window runs 10 minutes past settlement because the prize draw, chest and end-of-game screens open after the chain settles. The chat worker running on its own does not count (see the side line).",
            "split": {"openedApp": len(opened), "chatSignup": len(chat_su), "onChainOnly": len(live - opened - chat_su)},
            "splitLabels": {"openedApp": "Opened the app (SPA)", "chatSignup": "Signed up from the chat without opening the app", "onChainOnly": "On chain only, no sign-up or app telemetry"},
            "entryRows": entry_rows}]

    def add(key, name, base, members, note, from_n, **extra):
        dropped = sorted(base - members)
        out.append({"n": len(out) + 1, "key": key, "stage": name, "count": len(members), "accounts": sorted(members), "from": from_n,
                    "dropped": [{"account": a, "reason": why(key, a) or "unknown"} for a in dropped], "note": note, **extra})

    note_out = (f" {len(outside)} more registered account(s) sent no telemetry in the window and are not in the funnel." if outside else "")
    sources = [{"key": row["key"], "stage": row["stage"], "count": len(set(row["accounts"]) & reg),
                "accounts": sorted(set(row["accounts"]) & reg)} for row in entry_rows]
    add("registered", "registered on chain", live, reg, "Counted from the chain's registrations for this game." + note_out, 1,
        sources=sources, **({"outsideWindow": sorted(outside)} if outside else {}))
    base, base_n = reg, 2
    for key, name, members, note, measured in steps:
        if not measured:
            out.append({"n": len(out) + 1, "key": key, "stage": name, "count": None, "accounts": [], "from": base_n, "dropped": [], "note": note, "measured": False})
            continue
        members = set(members) & base
        add(key, name, base, members, note, base_n)
        base, base_n = members, len(out)
    return out


def funnel_table(funnel_rows, chat_idle):
    """Presentation rows for the phone-first fallout table, without losing account-level evidence."""
    live = next((row for row in funnel_rows if row.get("key") == "live"), {})
    base = live.get("count") or 0
    entry_rows = [{**row, "sharePct": f1(100 * row["count"] / base) if base else None,
                   "dropped": 0, "why": []} for row in live.get("entryRows", [])]
    path_of = {account: row["key"] for row in live.get("entryRows", []) for account in row.get("accounts", [])}

    def reason_class(reason):
        """A compact table label; the dated per-player evidence stays in details."""
        if re.match(r"last app activity .+, before kickoff", reason):
            return "last app activity before kickoff"
        if re.match(r"no sign-up attempt seen before registration closed", reason):
            return "no sign-up attempt before registration closed"
        if re.match(r"opened the app .+ after registration closed", reason):
            return "opened the app after registration closed; no sign-up attempt"
        if reason.startswith("sign-up failed"):
            return "sign-up failed"
        if reason.startswith("not attested:"):
            return "not attested"
        if reason.startswith("tie:"):
            return "tied vote"
        return reason

    def why_groups(row):
        groups = collections.OrderedDict()
        if row.get("key") == "registered":
            for dropped in row.get("dropped", []):
                reason = dropped.get("reason") or "unknown"
                path = path_of.get(dropped.get("account"))
                if path == "openedApp" and "no sign-up attempt" in reason:
                    key, text = "app-no-signup", "opened the app but never tried to sign up"
                elif path == "chatSignup" and "sign-up failed" in reason:
                    key, text = "chat-failed", "chat sign-up failed"
                else:
                    text = reason_class(reason)
                    key = (path or "other") + ":" + text
                group = groups.setdefault(key, {"text": text, "count": 0, "accounts": [], "details": [], "afterDeadline": 0})
                group["count"] += 1
                group["accounts"].append(dropped["account"])
                group["details"].append({"account": dropped["account"], "reason": reason})
                if "after registration closed" in reason:
                    group["afterDeadline"] += 1
        else:
            for dropped in row.get("dropped", []):
                reason = dropped.get("reason") or "unknown"
                text = reason_class(reason)
                group = groups.setdefault(text, {"text": text, "count": 0, "accounts": [], "details": []})
                group["count"] += 1
                group["accounts"].append(dropped["account"])
                group["details"].append({"account": dropped["account"], "reason": reason})
        return list(groups.values())

    labels = {"registered": "Registered", "joined": "Joined", "played": "Played every round",
              "reported": "Report on chain", "attested": "Report attested", "draw": "Saw the prize draw",
              "chest": "Opened the chest", "endscreen": "Reached the end-of-game screen", "humanity": "Proceeded to Humanity"}
    stages = [row for row in funnel_rows if row.get("key") != "live"]
    rows, index = [], 0
    while index < len(stages):
        row = stages[index]
        run_keys = ("played", "reported", "attested", "draw", "chest", "endscreen")
        if row.get("key") == "played":
            run = stages[index:index + len(run_keys)]
            if ([item.get("key") for item in run] == list(run_keys)
                    and all(item.get("count") == row.get("count") and not item.get("dropped") for item in run)):
                rows.append({"key": "playedToEnd", "stage": f"Played through to the end-of-game screen ({len(run)} steps)",
                             "count": row.get("count"), "sharePct": f1(100 * row["count"] / base) if base else None,
                             "dropped": 0, "why": [], "collapsed": [{"key": item["key"], "stage": labels[item["key"]],
                                                                      "count": item["count"]} for item in run]})
                index += len(run)
                continue
        measured = row.get("count") is not None
        rows.append({"key": row.get("key"), "stage": labels.get(row.get("key"), row.get("stage")),
                     "count": row.get("count"), "sharePct": f1(100 * row["count"] / base) if measured and base else None,
                     "dropped": len(row.get("dropped", [])) if measured else None,
                     "why": why_groups(row) if measured else [{"text": "not measured yet", "count": None, "accounts": []}],
                     **({"sources": row["sources"]} if row.get("sources") else {})})
        index += 1
    idle_n = chat_idle.get("count", 0)
    intro = (f"We picked up telemetry from {base + idle_n} players during the game window; "
             + (f"{idle_n} had only the DIM2 chat running and didn't register or use the app; the table follows the {base} who did."
                if idle_n else f"the table follows all {base}."))
    return {"entryTotal": base, "intro": intro, "entries": entry_rows, "rows": rows,
            "side": {"count": chat_idle.get("count", 0), "accounts": chat_idle.get("accounts", [])}}  # the intro says it (item 2 drops the side line)


def chain_by_accounts(chain):
    return [a["account"] for a in chain["accounts"]]


def ties_by_acct(chain):
    return {a["account"] for a in tied(chain["accounts"])} if chain else set()


ReportWindows = collections.namedtuple("ReportWindows", "signup_from start end")


def settle_time(chain):
    """The end of a game for window purposes: the settlement time, or for an interim chain (read before the settle) interimAt; else None."""
    if not chain:
        return None
    s = chain.get("settlement")
    if s and s.get("time"):
        return parse_ts(s["time"])
    if chain.get("interim") and chain.get("interimAt"):
        return parse_ts(chain["interimAt"])
    return None


def end_margin(chain):
    """Minutes past settle_time where the windows end: the payoff margin, or a small one for an interim chain, which has no payoff."""
    return datetime.timedelta(minutes=INTERIM_MARGIN_MIN if chain and chain.get("interim") and not chain.get("settlement") else PAYOFF_MIN)


def provisional_attendance(chain):
    """An interim chain (read before the settle) has no Score after, so attended is null: fill it with the rule of the pallet
    applied to the votes read (reported, and yes votes less 1, stopping at 0, reach its no votes), and mark the chain provisional."""
    if chain and chain.get("interim"):
        for a in chain["accounts"]:
            if a.get("attended") is None:
                a["attended"] = bool(a["sentReport"] and passes_at_close(a["yesPerson"], a["noNotPerson"]))
        chain["attendedProvisional"] = True
    return chain


def interim_header(doc):
    """The first summary line of an interim report, or None for a final one."""
    interim = doc.get("interim")
    if not interim:
        return None
    at = parse_ts(interim["at"])
    return f"Interim report (as of {cest(at)} {tz_label(at)}, before the 1-hour settle). Attestation is provisional: the pallet's rule on the votes so far. Settlement, scores and the prize draw are not in it; a final report follows after settlement."


def report_windows(chain, pull):
    """The report window as ReportWindows(signup_from, start, end) datetimes, or None when neither chain nor pull has one.

    Ionut's rule: a game's report runs from the end of the previous game to the end of this game, where the end of a
    game is its settlement + PAYOFF_MIN (its prize draw, chest and end screen open after the chain settles). So:
      - end = this game's settlement + PAYOFF_MIN;
      - start = the previous game's settlement + PAYOFF_MIN, which keeps the previous game's payoff traffic out;
      - but registration for this game opens at the previous settlement (chain registrationOpens), so sign-up journeys
        and the chain-registration evidence count from signup_from = registrationOpens, ten minutes before start.
    Without a chain the pull's own window serves for both starts.
    """
    if chain and chain.get("registrationOpens") and settle_time(chain):
        opens = parse_ts(chain["registrationOpens"])
        return ReportWindows(opens, opens + datetime.timedelta(minutes=PAYOFF_MIN),
                             settle_time(chain) + end_margin(chain))
    w = pull.get("window")
    if w and len(w) == 2:
        return ReportWindows(parse_ts(w[0]), parse_ts(w[0]), parse_ts(w[1]))
    return None


def live_window(chain, pull):
    """(start, end) for everything but sign-ups: the previous settlement + PAYOFF_MIN to this settlement + PAYOFF_MIN, else the pull's window, else None."""
    w = report_windows(chain, pull)
    return (w.start, w.end) if w else None


def window_note(w):
    """The report's window in local time: where sign-ups and everything else start, and where it ends."""
    stamp = lambda d: (lambda b: f"{b.day} {b:%b %H:%M}")(d.astimezone(BERLIN))
    a, b, c = (d.astimezone(BERLIN) for d in w)
    one_day = a.date() == c.date()
    fmt = lambda d: f"{d:%H:%M}" if one_day else stamp(d)
    return (f"sign-ups from registration opening {fmt(a)}, everything else from {fmt(b)} ({PAYOFF_MIN} minutes after the previous game's settlement) "
            f"to {fmt(c)} {c.tzname()} ({PAYOFF_MIN} minutes after settlement)")


def game_page_window(chain, pull):
    """The page-life window: one minute before kickoff through settlement.

    The wider pull/live window intentionally starts at registration and runs
    past settlement for funnel and payoff evidence.  Page lives are a gameplay
    diagnostic, so counting every app page in that wider pull exaggerates
    reloads from ordinary pre-game browsing.
    """
    if chain and chain.get("kickoff") and settle_time(chain):
        return (parse_ts(chain["kickoff"]) - datetime.timedelta(seconds=60), settle_time(chain))
    return live_window(chain, pull)


def rounds_presence_window(window, windows):
    """The page window cut to the game itself: from the hand-over to /game (CONNECT_LEAD_S before the first round's
    play) to the end of the last round's play. The page window opens at the previous game's end, hours earlier, so
    an afternoon sign-up is not presence in the game; and a player who first opened the app after the rounds ended
    (before settlement) was not in the game either. The link view counts both as no-shows, not dead links."""
    if not window or not windows:
        return window
    start = datetime.datetime.fromtimestamp(windows[0][0] / 1000 - CONNECT_LEAD_S, tz=datetime.timezone.utc)
    end = datetime.datetime.fromtimestamp(windows[-1][1] / 1000, tz=datetime.timezone.utc)
    return (max(window[0], start), min(window[1], end))


def platform_error_window(chain, pull, kickoff):
    """Known-error window: registration open (sign-up errors belong to this game, see report_windows) through settlement.
    Only a registration that opened more than 24 h before kickoff (a multi-day one; the overnight gap is ~18 h) is bounded, to 2 h before kickoff."""
    raw = pull.get("window")
    pull_window = ((parse_ts(raw[0]), parse_ts(raw[1])) if raw and len(raw) == 2 else None)
    if settle_time(chain):
        start = (parse_ts(chain["registrationOpens"]) if chain.get("registrationOpens") else
                 (pull_window[0] if pull_window else kickoff - datetime.timedelta(minutes=20)))
        if kickoff - start > datetime.timedelta(hours=24):
            start = kickoff - datetime.timedelta(hours=2)
        return start, settle_time(chain)
    return pull_window


def _in(ts, win):
    return win is None or not ts or win[0] <= parse_ts(ts) <= win[1]


def live_evidence(p, win, signup_win=None):
    """Whether this account sent anything inside the window, and whether any of it came from the app (not the chat worker alone).

    A sign-up journey counts from signup_win (the earlier start, see report_windows); everything else from win."""
    signup_win = win if signup_win is None else signup_win
    is_signup = lambda r: r.get("span.op") == "journey.game-signup"
    roots = [r for r in p.get("roots", []) if _in(r.get("timestamp"), signup_win if is_signup(r) else win)]
    app_roots, _ = partition_roots(roots)
    events = [e for e in p.get("events", []) if _in(e.get("timestamp"), win)]
    steps = [s for s in p.get("steps", []) if _in(s.get("timestamp"), win)]
    # events carry no surface, and the chat worker sends failures titled like the app's ("signup-failed: bind"), so only roots prove the app was opened
    chat_roots = [r for r in roots if is_chat_root(r)]
    signup = any(is_signup(r) for r in chat_roots)
    return {"any": bool(roots or events or steps), "app": bool(app_roots), "chatSignup": signup, "chatRoots": chat_roots}


def step_ended(p, op):
    """A step reaches Sentry when it ends, so its presence is 'ended'. Matches the full op ("payoff.chest.show") or the bare step name ("chest.show")."""
    bare = op.split(".", 1)[-1]
    return any(s.get("span.op") in (op, bare) for s in p.get("steps", []))


def _at_or_before(row, deadline):
    """Whether timestamped evidence existed by a stage deadline. Untimed evidence cannot prove that when a deadline is known."""
    if deadline is None:
        return True
    return bool(row.get("timestamp")) and parse_ts(row["timestamp"]) <= deadline


def _app_roots(p, deadline=None):
    return [r for r in partition_roots(p.get("roots", []))[0] if _at_or_before(r, deadline)]


def _sad(roots, op, deadline=None):
    """'outcome (reason)' of the last journey of this kind, or None."""
    rs = [r for r in roots if r.get("span.op") == op and _at_or_before(r, deadline)]
    if not rs:
        return None
    r = rs[-1]
    return f"{r.get('journey.outcome') or '?'}" + (f", {r['journey.sad_reason']}" if r.get("journey.sad_reason") else "")


def _timeout_rows(p, deadline=None, after=False):
    rows = []
    for e in p.get("events", []):
        t = str(e.get("title") or "")
        if not re.search(r"timeout|timed out", t, re.I):
            continue
        if deadline is None:
            rows.append(e)
        elif e.get("timestamp") and (_at_or_before(e, deadline) != after):
            rows.append(e)
    return rows


def _timeout(p, deadline=None):
    rows = _timeout_rows(p, deadline)
    return f"Polkadot app timeout: {rows[0].get('title')}" if rows else None


def _when(rows, deadline=None):
    times = sorted(parse_ts(r["timestamp"]) for r in rows if r.get("timestamp"))
    if not times:
        return "at an unknown time"
    first, last = evidence_cest(times[0], deadline), evidence_cest(times[-1], deadline)
    label = tz_label(times[-1])
    return f"at {first} {label}" if first == last else f"at {first}–{last} {label}"


def _timeout_summary(rows, deadline=None):
    """Readable, deduplicated timeout context without leaking repeated raw exception titles."""
    if not rows:
        return None
    durations = []
    for row in rows:
        match = re.search(r"timed out after\s+([\d,]+)\s*ms", str(row.get("title") or ""), re.I)
        if match:
            seconds = int(match.group(1).replace(",", "")) / 1000
            label = f"{seconds:g} s"
            if label not in durations:
                durations.append(label)
    subject = "Polkadot app request" if len(rows) == 1 else f"{len(rows)} Polkadot app requests"
    duration = f" after {durations[0]}" if len(durations) == 1 else ""
    return f"{subject} timed out{duration} {_when(rows, deadline)}"


def _later_context(p, deadline, deadline_label, root_ops=()):
    """Relevant evidence after a stage deadline, clearly labelled as context rather than a cause of that drop."""
    if deadline is None:
        return ""
    parts = []
    timeouts = _timeout_rows(p, deadline, after=True)
    if timeouts:
        parts.append(_timeout_summary(timeouts, deadline))
    labels = {"journey.app-open": "app open", "journey.game-signup": "sign-up attempt", "journey.join": "join attempt"}
    for op in root_ops:
        rows = [r for r in p.get("roots", []) if r.get("span.op") == op and not _at_or_before(r, deadline)]
        if rows:
            outcomes = []
            for r in rows:
                outcome = str(r.get("journey.outcome") or "seen")
                if outcome not in outcomes:
                    outcomes.append(outcome)
            action = "app opened" if op == "journey.app-open" else f"{labels.get(op, op)} {'/'.join(outcomes)}"
            parts.append(f"{action} {_when(rows, deadline)}, after {deadline_label}")
    return (" Later context: " + "; ".join(parts) + ".") if parts else ""


def _with_context(reason, context):
    return reason.rstrip(".") + ("." if context else "") + context


def funnel_reason(stage, a, p, c, kickoff, ties, registration_close=None):
    """Why this account left the funnel at this stage, from the document's own data; None when there is no evidence (then 'unknown')."""
    roots = p.get("roots", [])
    if stage == "registered":
        app = _app_roots(p, registration_close)
        close_label = f"registration closed at {cest(registration_close, True)} {tz_label(registration_close)}" if registration_close else "registration closed"
        context = _later_context(p, registration_close, close_label, ("journey.game-signup",))
        fail = _sad(roots, "journey.game-signup", registration_close)
        if fail:
            detail = fail.removeprefix("failed").lstrip(", ")
            reason = "sign-up failed" + (f": {detail}" if detail else "")
            reason += f"; {_timeout(p, registration_close)}" if _timeout(p, registration_close) else ""
            return _with_context(reason, context)
        if _timeout(p, registration_close):
            return _with_context(_timeout(p, registration_close), context)
        if registration_close:
            late_app = [r for r in partition_roots(roots)[0] if not _at_or_before(r, registration_close)]
            if late_app:
                return (f"opened the app {_when(late_app, registration_close)}, after registration closed at {cest(registration_close, True)} {tz_label(registration_close)}; "
                        "no sign-up attempt." + context)
            return _with_context(f"no sign-up attempt seen before registration closed at {cest(registration_close, True)} {tz_label(registration_close)}", context)
        return (("opened the app, no sign-up attempt seen" if app else "") + context) or None
    if stage == "joined":
        app = _app_roots(p, kickoff)
        kickoff_label = f"kickoff at {cest(kickoff, True)} {tz_label(kickoff)}" if kickoff else "kickoff"
        context = _later_context(p, kickoff, kickoff_label, ("journey.app-open", "journey.join"))
        fail = _sad(roots, "journey.join", kickoff)
        if fail:
            return _with_context(f"join {fail}", context)
        if _timeout(p, kickoff):
            return _with_context(_timeout(p, kickoff), context)
        last = max((parse_ts(r["timestamp"]) for r in app if r.get("timestamp")), default=None)
        if not app or last is None:
            signed_up = any(r.get("span.op") == "journey.game-signup" and _at_or_before(r, kickoff) for r in roots)
            return _with_context(("signed up from the chat, never opened the app" if signed_up
                                  else "on chain, no sign-up or app telemetry in the window"), context)
        if kickoff and last < kickoff:
            return _with_context(f"last app activity {evidence_cest(last, kickoff)} {tz_label(last)}, before kickoff", context)
        return _with_context("opened the app around kickoff but never joined", context)
    if stage == "played":
        j = _sad(roots, "journey.game")
        return f"game journey {j}" if j else (f"joined ({_sad(roots, 'journey.join')}), no game journey" if _sad(roots, "journey.join") else _timeout(p))
    pay = p.get("payoff") or {}
    if stage == "reported":
        j = _sad(roots, "journey.payoff")
        return f"reached the end screen ({j}) but no report on chain" if j else "no report on chain"
    if stage == "draw":
        return pay.get("draw.reason") or "draw.show never ended"
    if stage == "chest":
        got = pay.get("chest.reason") or pay.get("chest.outcome")
        return f"chest {got}" if got else "chest.show never ended"
    if stage == "endscreen":
        j = _sad(roots, "journey.payoff")
        return f"payoff journey {j}" if j else None
    if stage == "humanity":
        return "end screen shown, Humanity not opened"
    if stage == "attested" and c:
        return f"{'tie' if c['account'] in ties else 'not attested'}: {c['yesPerson']} for, {c['noNotPerson']} against"
    return None


def payoff_shown(p):
    """The payoff journey ended 'shown': its attributes (the pull's payoff dict) or any journey.payoff root."""
    return (p.get("payoff") or {}).get("journey.outcome") == "shown" or any(
        r.get("span.op") == "journey.payoff" and "shown" in str(r.get("journey.outcome") or "") for r in p.get("roots", []))


def funnel_stage_by_account(fn):
    """account -> the name of the furthest stage it reached (stage 2 only when it went no further than the app)."""
    by = {}
    for st in fn:
        for a in st["accounts"]:
            by[a] = st["stage"]
    return by


def _iso(ts, plus_ms=0):
    return (parse_ts(ts) + datetime.timedelta(milliseconds=plus_ms)).isoformat()


def _end_ms(row):
    return fnum(row.get("span.duration")) or 0


def storyline_events(p, chain_row, reg, win):
    """One account as its registration, join and report on chain, in time order."""
    roots = [r for r in p.get("roots", []) if r.get("timestamp")]
    events = []

    def add(key, at, **extra):
        events.append({"key": key, "at": at, **{k: v for k, v in extra.items() if v is not None}})

    if (reg or {}).get("at"):
        add("registered", _iso(reg["at"]))
    joins = [r for r in roots if r.get("span.op") == "journey.join" and _in(r["timestamp"], win)]
    if joins:
        join = max(joins, key=lambda r: parse_ts(r["timestamp"]))
        add("join", _iso(join["timestamp"]), outcome=join.get("journey.outcome"))
    if chain_row and chain_row.get("sentReport") and chain_row.get("reportTime"):
        add("reported", _iso(chain_row["reportTime"]))
    return sorted(events, key=lambda e: parse_ts(e["at"]))


HUMANITY_GATEWAY_TLD = {"dotapps.io": "dot", "paseo.dotapps.io": "paseo"}


def humanity_tld(environment):
    """The tld the app hands off to, read from an environment name as currentTld reads it from the host the app is on.

    Mirrors apps/jollity-app/lib/membership/humanity-target.ts, so a report names the same network the app opened."""
    bare = re.sub(r":\d+$", "", environment)
    for gateway, tld in HUMANITY_GATEWAY_TLD.items():
        if bare == gateway or bare.endswith(f".{gateway}"):
            return tld
    parts = bare.split(".")
    return parts[-1] if parts[-1] and len(parts) > 1 and not parts[-1].isdigit() else "paseo"


def humanity_link(p):
    """The link the Humanity hand-off of one account opened, as the label and the full link without its scheme, or None.

    It is derived from the first journey.humanity root as humanityHandOff derives it: a phone opens the Humanity card in
    Pocket and any other host the Humanity product. None when that root lacks the host kind or a known environment."""
    roots = [r for r in p.get("roots", []) if r.get("span.op") == "journey.humanity" and r.get("timestamp")]
    root = min(roots, key=lambda r: parse_ts(r["timestamp"]), default=None)
    kind, environment = (root or {}).get("host.kind"), (root or {}).get("environment")
    if not kind or not environment or environment == "unknown":
        return None
    target = f"peopl.{humanity_tld(environment)}"
    if kind in ("android", "ios"):
        return {"label": f"pocket/open?product={target}", "link": f"pocket/open?product={target}&card=humanity"}
    return {"label": target, "link": target}


def storyline_pages(p):
    """The dated payoff screens of one account in time order, and the last of them with the time it first showed.

    The screens carry no window, the same reading as the funnel rows of the same key, so the two agree on who reached
    them. A last page that is the Humanity hand-off carries the link it opened when the record says which."""
    timed = [(key, at) for key, at in payoff_screens(p, [r for r in p.get("roots", []) if r.get("timestamp")]) if at]
    if not timed:
        return {"pages": []}
    last = {"key": timed[-1][0], "at": timed[-1][1]}
    if last["key"] == "humanity":
        last.update(humanity_link(p) or {})
    return {"pages": [key for key, _ in timed], "lastPage": last}


def _root_span_ms(root):
    """The wall start and end of a root in epoch ms, from its wall clock fields or else its timestamp and duration."""
    start = fnum(root.get("wall.time.start"))
    start = start if start else parse_ts(root["timestamp"]).timestamp() * 1000
    end = fnum(root.get("wall.time.end"))
    return start, end if end and end >= start else start + _end_ms(root)


def _ms_iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).isoformat()


def storyline_notifications(p):
    """The notifications one account tapped, in time order, from the foreground points of the pull.

    An app.opened_from_notification point is a page the tap opened, and an app.away_ms point whose app.return_source is
    notification a page the tap brought back. Each carries the reminder moment when the app read one. Only the push
    notifications the chat books carry the jollity-notification marker the app reads (apps/jollity-worker/src/index.ts
    reminderLink), so every tap is of kind push: the host alarm, its calendar entry and its pill open the product by id
    with no marker."""
    found = []
    for point in p.get("foreground") or []:
        name, at = point.get("metric.name"), point.get("timestamp")
        if not at:
            continue
        if name == "app.opened_from_notification":
            how = "opened"
        elif name == "app.away_ms" and point.get("app.return_source") == "notification":
            how = "returned"
        else:
            continue
        found.append({"at": _iso(at), "how": how, "kind": "push", **({"moment": point["notification.moment"]} if point.get("notification.moment") else {})})
    return sorted(found, key=lambda n: parse_ts(n["at"]))


HOST_ALARM_LEAD = datetime.timedelta(minutes=1)
CALENDAR_ALERT_LEAD = datetime.timedelta(minutes=5)
CALENDAR_MIN_AHEAD = datetime.timedelta(hours=1)


def storyline_expected_notices(registered_at, kickoff):
    """The notices the code books for a registered account of the game product, which no record shows arriving, in time order.

    The game product dim2 registers only once the host holds its game reminder (remindersInPlace in
    apps/jollity-worker/src/index.ts blocks it on unsupported), so the chat books none of its start notices for it
    (remindersFor, hostReminds). Both surfaces ask the host for a start a minute ahead of the game
    (apps/jollity-app/lib/game-source.ts reminderStartMs, and the worker ask), and the host rings its alarm then, or a
    plain notification where the phone allows no alarm, so the alarm is listed at that start. The host adds a calendar
    entry only for a start at least an hour away when asked, with its own alert 5 min before that start
    (trinity-user-agents ProductGameReminderCenter.swift and RealProductGameCalendar.kt), so the calendar alert is listed
    only for an account that registered that early. The closing pushes of the chat are not listed: the worker times a
    running game from the pallet registration duration (registrationStarts in apps/jollity-worker/src/chain.ts), which
    the chain report does not hold, and keeps each only when that window is longer than its lead."""
    if not registered_at or not kickoff:
        return []
    registered, alarm_at = parse_ts(registered_at), parse_ts(kickoff) - HOST_ALARM_LEAD
    found = []
    if alarm_at - registered >= CALENDAR_MIN_AHEAD:
        found.append({"at": (alarm_at - CALENDAR_ALERT_LEAD).isoformat(), "moment": "calendar", "kind": "calendar"})
    if alarm_at > registered:
        found.append({"at": alarm_at.isoformat(), "moment": "host-alarm", "kind": "alarm"})
    return found


def last_round_ends_at_first_report(rounds, chain):
    """Ends the last round at the first report of its accounts when one lands before the scheduled end.

    A player reports from the vote screen after the last turn, so a report before the computed end shows the round
    over by then. The round then says its end comes from the first report."""
    if not rounds:
        return rounds
    last = rounds[-1]
    seated = {account for group in last["groups"] for account in group}
    reports = [parse_ts(a["reportTime"]) for a in chain.get("accounts", [])
               if a.get("account") in seated and a.get("sentReport") and a.get("reportTime")]
    first = min(reports, default=None)
    if first and parse_ts(last["from"]) < first < parse_ts(last["to"]):
        last["to"], last["toFromReport"] = first.isoformat(), True
    return rounds


def storyline_screen(p):
    """The stretches one account had the app on screen, in time order, or None when the pull holds no foreground points.

    Per page session, a stretch starts at a page open (a journey.app-open root or an open from a notification) or at a
    return (an app.away_ms point), and ends at the next hide, which a later return dates as its time less the away, or
    else at the end of the last journey of that session. Sessions come from the app roots, never the chat worker. Two
    sessions on screen at once, such as two devices, give one stretch over both."""
    if "foreground" not in p:
        return None
    points = p.get("foreground") or []
    sessions = {}
    for root in p.get("roots", []):
        if root.get("timestamp") and root.get("session.id") and not is_chat_root(root):
            sessions.setdefault(root["session.id"], {"roots": [], "points": []})["roots"].append(root)
    for point in points:
        if point.get("timestamp") and point.get("session.id") in sessions:
            sessions[point["session.id"]]["points"].append(point)
    stretches = []
    for found in sessions.values():
        spans = [_root_span_ms(r) for r in found["roots"]]
        at = lambda point: parse_ts(point["timestamp"]).timestamp() * 1000
        # network and rtc roots run in the background too, so only a journey, a flow the player goes through, ends a stretch
        last = max([end for (_, end), r in zip(spans, found["roots"]) if str(r.get("span.op") or "").startswith("journey.")]
                   + [at(point) for point in found["points"]], default=None)
        if last is None:
            continue
        starts = [(start, "open") for (start, _), r in zip(spans, found["roots"]) if r.get("span.op") == "journey.app-open"]
        starts += [(at(point), "open") for point in found["points"] if point.get("metric.name") == "app.opened_from_notification"]
        hides = []
        for point in found["points"]:
            away = fnum(point.get("value")) if point.get("metric.name") == "app.away_ms" else None
            if away is not None:
                starts.append((at(point), "return"))
                hides.append(at(point) - away)
        mine = []
        for start, kind in sorted(starts):
            if mine and mine[-1][1] > start:
                continue
            hide = min((h for h in hides if h > start), default=None)
            end = min(hide, last) if hide is not None else last
            if end > start:
                mine.append((start, end, kind, "away" if hide is not None and hide <= last else "lastJourney"))
        stretches += mine
    merged = []
    for start, end, kind, why in sorted(stretches):
        if merged and start < merged[-1][1]:
            if end > merged[-1][1]:
                merged[-1] = (merged[-1][0], end, merged[-1][2], why)
            continue
        merged.append((start, end, kind, why))
    return [{"from": _ms_iso(a), "to": _ms_iso(b), "start": kind, "end": end} for a, b, kind, end in merged]


def payoff_screens(p, roots):
    """The payoff screens an account reached, by the predicates of the funnel rows of the same key, in time order.

    Each carries the first time it showed, or None when no row of it has a time, and the untimed ones come last."""
    steps = [s for s in p.get("steps", []) if s.get("timestamp")]
    payoff_ts = (p.get("payoff") or {}).get("timestamp")
    first = lambda rows: min(rows, key=lambda r: parse_ts(r["timestamp"]), default=None)
    first_step = lambda op: first([s for s in steps if s.get("span.op") in (op, op.split(".", 1)[-1])])
    screens = []
    for key, op in (("draw", "payoff.draw.show"), ("chest", "payoff.chest.show")):
        if step_ended(p, op):
            step = first_step(op)
            screens.append((key, step and _iso(step["timestamp"])))
    if payoff_shown(p):
        shown = [r for r in roots if r.get("span.op") == "journey.payoff" and "shown" in str(r.get("journey.outcome") or "")]
        end = max(shown, key=lambda r: parse_ts(r["timestamp"]), default=None)
        screens.append(("endscreen", _iso(end["timestamp"], _end_ms(end)) if end else payoff_ts and _iso(payoff_ts)))
    opened = (p.get("payoff") or {}).get("membership.humanity") == "opened"
    if step_ended(p, HUMANITY_STEP) or opened or any(r.get("span.op") == "journey.humanity" for r in roots):
        humanity = first([s for s in steps if s.get("span.op") in (HUMANITY_STEP, HUMANITY_STEP.split(".", 1)[-1])]
                         + [r for r in roots if r.get("span.op") == "journey.humanity"])
        screens.append(("humanity", _iso(humanity["timestamp"]) if humanity else payoff_ts and _iso(payoff_ts)))
    return sorted(screens, key=lambda screen: (screen[1] is None, screen[1] and parse_ts(screen[1])))


def _storyline_order(players, rounds):
    seat = {}
    for g, accounts in enumerate(rounds[0]["groups"] if rounds else []):
        for j, account in enumerate(accounts):
            seat[account] = (g, j)
    return sorted(players, key=lambda p: (bool(p["bot"]), p["id"] not in seat, seat.get(p["id"], (0, 0)),
                                         (p["username"] or "").lower(), p["id"]))


def storyline_phases(chain, windows3):
    """The phases of docs/architecture.md that the chain dates, in time order, leaving out any phase it cannot date.

    Player Process has no end in the chain, so it runs open to the end of the report window. Chat with Players has no
    source and no phase.
    """
    record = chain.get("record") or {}
    s_iso = lambda s: datetime.datetime.fromtimestamp(s, datetime.timezone.utc).isoformat()
    kickoff = chain.get("kickoff")
    settlement = (chain.get("settlement") or {}).get("time")
    reg_ends, shuffle_ends, report_ends = record.get("registrationEnds"), record.get("shuffleDeadline"), record.get("reportEnds")
    reporting_ends = _iso(settlement) if settlement else (s_iso(report_ends) if report_ends else None)
    spans = [
        ("registration", "Registration", chain.get("registrationOpens") and _iso(chain["registrationOpens"]), reg_ends and s_iso(reg_ends)),
        ("shuffle", "Shuffle", reg_ends and s_iso(reg_ends), shuffle_ends and s_iso(shuffle_ends)),
        ("reporting", "Reporting", shuffle_ends and s_iso(shuffle_ends), reporting_ends),
        ("playerProcess", "Player Process", settlement and _iso(settlement), windows3.end.isoformat()),
    ]
    phases = [{"key": key, "label": label, "from": start, "to": end} for key, label, start, end in spans if start and end]
    # the reader holds no shuffle block, so the edge between Shuffle and Reporting is the deadline, not the shuffle itself
    flags = {"shuffle": "toIsDeadline", "reporting": "fromIsDeadline", "playerProcess": "open"}
    for phase in phases:
        if phase["key"] in flags:
            phase[flags[phase["key"]]] = True
    return sorted(phases, key=lambda phase: parse_ts(phase["from"]))


STORYLINE_DROP_WORDS = {"joined": "never joined", "played": "no completed game journey", "draw": "no prize draw",
                        "chest": "chest not opened", "endscreen": "payoff not finished"}


def _seconds_text(seconds):
    return f"{round(seconds)} s" if seconds < 120 else f"{round(seconds / 60)} min"


def storyline_note(events, drop, play_from):
    """What went wrong for one account, from its join outcome and the funnel stage it dropped at, or None.

    drop is (stage key, stage name, reason) from the funnel. A late join says how long after play_from it came."""
    words = []
    join = next((e for e in events if e["key"] == "join"), None)
    outcome = (join or {}).get("outcome")
    if outcome == "late" and play_from:
        words.append(f"joined {_seconds_text((parse_ts(join['at']) - parse_ts(play_from)).total_seconds())} late")
    elif outcome and outcome != "full":
        words.append(f"{outcome} join")
    if drop:
        key, stage, reason = drop
        head, known = STORYLINE_DROP_WORDS.get(key), reason and reason != "unknown"
        words.append(f"{head}: {reason}" if head and known else head or (reason if known else f"missed {stage}"))
    return ", ".join(words) or None


def storyline(pull, chain, names, windows3, play_win, joined, drops=None):
    """Every account registered on chain as a row of dated events, the rounds with the joined accounts of each group, and the game marks.

    A seat the shuffle gave an account that never joined is left out of its group, so its line never merges. The row
    names the payoff screens it reached and the last of them. A report or payoff screen the reader could not date is a
    flag on the row rather than a mark or a page. drops maps an account to the (stage key, stage name, reason) it left
    the funnel at, and with its join outcome gives the row a note. A row carries the notifications the account tapped,
    the alarm and calendar alert the host books for it with no record of their arrival, and the stretches it had the app on
    screen when the pull holds foreground points. The last round ends at its first report when one lands earlier."""
    if not chain or not windows3:
        return None
    chain_by = {a["account"]: a for a in chain.get("accounts", [])}
    reg_by = registration_by_account(chain)
    settlement = (chain.get("settlement") or {}).get("time")
    win = (windows3.start, windows3.end)
    ms_iso = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).isoformat()
    rounds = [{"round": r + 1, "from": ms_iso(w[0]), "to": ms_iso(w[1]),
               "groups": [seated for group in groups if (seated := [a for a in group if a in joined])]}
              for r, (w, groups) in enumerate(zip(play_win or [], chain_group_accounts(chain)))]
    rounds = last_round_ends_at_first_report(rounds, chain)
    marks = [{"key": key, "at": _iso(at)} for key, at in (("kickoff", chain.get("kickoff")), ("settlement", settlement)) if at]
    players = []
    for account, chain_row in chain_by.items():
        p = pull["players"].get(account, {})
        row = {"id": account, "username": names.get(account), "bot": bool(p.get("bot")),
               "events": storyline_events(p, chain_row, reg_by.get(account), win), **storyline_pages(p)}
        if chain_row.get("sentReport") and not chain_row.get("reportTime"):
            row["reportUndated"] = True
        notifications, screen = storyline_notifications(p), storyline_screen(p)
        if notifications:
            row["notifications"] = notifications
        expected = storyline_expected_notices((reg_by.get(account) or {}).get("at"), chain.get("kickoff"))
        if expected:
            row["expectedNotices"] = expected
        if screen is not None:
            row["onScreen"] = screen
        undated = [key for key, at in payoff_screens(p, [r for r in p.get("roots", []) if r.get("timestamp")]) if not at]
        if undated:
            row["screensUndated"] = undated
        note = storyline_note(row["events"], (drops or {}).get(account), rounds[0]["from"] if rounds else chain.get("kickoff"))
        if note:
            row["note"] = note
        players.append(row)
    return {"from": windows3.signup_from.isoformat(), "to": windows3.end.isoformat(), "marks": marks, "rounds": rounds,
            "phases": storyline_phases(chain, windows3), "players": _storyline_order(players, rounds)}


def attach_reminders_fired(s, host):
    """Adds the reminders fired mark to the storyline when the hosts measured one."""
    fired = (host or {}).get("firedAt")
    if fired and not any(m["key"] == "remindersFired" for m in s["marks"]):
        s["marks"].append({"key": "remindersFired", "at": fired.isoformat() if isinstance(fired, datetime.datetime) else _iso(fired)})
        s["marks"].sort(key=lambda m: parse_ts(m["at"]))
    return s



# --------------------------------------------------------------------------- the notification funnel

HOST_REMINDER_LEAD = datetime.timedelta(minutes=10)


def host_reminder_counts(events, kickoff, env):
    """The hosts' reminder events for this game: those whose reminder time is within 10 minutes before kickoff and
    whose product is the game's env (or unnamed). Counts are distinct devices, not accounts, split by platform (an
    event without one is iOS, as older stored files). A device is "booked" on ANY of its reminder events, since the
    booking often happened before the pull window. None when events is None."""
    if events is None:
        return None
    lo, hi = (kickoff - HOST_REMINDER_LEAD).timestamp() * 1000, kickoff.timestamp() * 1000
    mine = [e for e in events if isinstance(e.get("starts_at_unix_ms"), (int, float)) and lo <= e["starts_at_unix_ms"] <= hi
            and e.get("product_id") in (None, "", env) and e.get("user")]
    plat = lambda e: "android" if e.get("platform") == "android" else "ios"
    devices = lambda name=None: {(plat(e), e["user"]) for e in mine if name is None or e.get("title") == f"host.reminder.{name}"}
    per = lambda pairs, p: len({u for q, u in pairs if q == p})
    booked, fired = devices(), devices("fired")
    firedat = [e["starts_at_unix_ms"] for e in mine if e.get("title") == "host.reminder.fired"]
    return {"scheduled": len(devices("scheduled")), "fired": len(fired), "tapped": len(devices("tapped")),
            "opened": len(devices("product_opened")),
            "booked": len(booked), "bookedIos": per(booked, "ios"), "bookedAndroid": per(booked, "android"),
            "firedIos": per(fired, "ios"), "firedAndroid": per(fired, "android"),
            "firedAt": datetime.datetime.fromtimestamp(min(firedat) / 1000, datetime.timezone.utc) if firedat else None}


def notification_funnel(rows, registered, joined, window=None, players=None, host=None):
    """The notification funnel from chat-worker rows: {"chat": [row], "permission": [row with outcome], "book": [row with complete]}.

    Rows without a user.id are dropped. Counts are accounts. host (host_reminder_counts) measures the hosts' reminders,
    counted in devices; without it whether a notification appeared on a phone is not measured.
    """
    ids = set(players) if players is not None else None
    player_names = players if isinstance(players, dict) else {}
    uid = lambda r: r.get("user.id") if ids is None or r.get("user.id") in ids else None  # only the game's own accounts
    running = {uid(r) for r in rows.get("chat", []) if uid(r)}
    perm = [r for r in rows.get("permission", []) if uid(r)]
    book = [r for r in rows.get("book", []) if uid(r)]
    running |= {uid(r) for r in perm + book}  # a booking or a permission answer is itself a chat.* event
    asked = {uid(r) for r in perm}
    granted = {uid(r) for r in perm if r.get("outcome") == "granted"}
    # #813: the request itself failed or timed out (not the player's no); counted apart from "not granted"
    failed = {uid(r) for r in perm if r.get("outcome") in ("failed", "timed-out")} - granted
    tried = {uid(r) for r in book}
    booked = {uid(r) for r in book if str(r.get("complete")).lower() == "true"}
    can = granted & booked
    booked_not_granted = booked - granted
    not_granted_known = (booked_not_granted & asked) - failed
    unknown = booked_not_granted - asked
    reg = can & set(registered)
    jn = reg & set(joined)
    not_asked = running - asked
    not_asked_details = [{"account": account,
                          "label": player_names.get(account) or "one without a username",
                          "reason": "no permission check in the window; likely the chat was already running from before it"}
                         for account in sorted(not_asked)]
    if host is None:
        shown_stage = {"key": "shown", "label": "Notification shown on the phone", "count": None, "measured": False,
                       "note": "Not measured: no signal tells us a notification appeared"}
    else:
        when = (f" at {cest(host['firedAt'])} {tz_label(host['firedAt'])}" if host["firedAt"] else "")
        phones = "1 phone" if host["booked"] == 1 else f"{host['booked']} phones"
        shown_stage = {"key": "shown", "label": "Game reminder booked on the phone (host)", "count": host["booked"], "measured": True,
                       "note": f"Booked on {phones} (iOS {host['bookedIos']}, Android {host['bookedAndroid']}). "
                               f"Went off{when} on {host['fired']} (Android {host['firedAndroid']}, iOS {host['firedIos']}; "
                               "iOS only records it while the Polkadot app is running, so the iOS figure is a floor); "
                               f"{host['tapped']} tapped it and {host['opened']} had the game opened from the reminder (tapped or opened automatically). "
                               "Host nightly/develop builds only (store builds report nothing), counted per phone, so not tied to the accounts above."}
    steps = [
        {"key": "chatRunning", "label": "DIM2 chat running on the phone", "count": len(running), "accounts": sorted(running)},
        {"key": "asked", "label": "Chat checked notification permission", "count": len(asked & running), "accounts": sorted(asked),
         "note": (f"{len(not_asked)} had no check in the window; likely the chat was already running from before it"),
         "details": not_asked_details},
        {"key": "granted", "label": "Permission granted, now or earlier", "count": len(granted), "accounts": sorted(granted),
         "note": ((f"{len(asked - granted - failed)} not granted: declined or notifications off; "
                   + (f"{len(failed)} more: the permission request failed or timed out" if failed else "no permission request failed or timed out"))
                  if asked else "No phone was asked for permission in the window")},
        {"key": "grantedBooked", "label": "Granted and all reminders booked", "count": len(can), "accounts": sorted(can),
         "note": f"{len(can)} had permission and all reminders booked."
                 + (f" {len(unknown)} more had all reminders booked but no permission check during the game window, so we don't know whether they could."
                    if unknown else "")},
        shown_stage,
        {"key": "registered", "label": f"Of those {len(can)}: registered for the game", "count": len(reg), "accounts": sorted(reg)},
        {"key": "joined", "label": f"Of those {len(can)}: joined the game", "count": len(jn), "accounts": sorted(jn)},
    ]
    side = {"triedToBook": len(tried), "fullyBooked": len(booked), "refused": len(tried - booked),
            "fullyBookedNotGranted": len(booked_not_granted), "notGranted": len(not_granted_known), "permissionUnknown": len(unknown),
            "permissionFailed": len(failed)}
    w = window or {}
    try:
        window_label = local_window_label(parse_ts(w["from"]), parse_ts(w["to"]))
    except (KeyError, TypeError, ValueError):
        window_label = f"{w.get('openedAt', '?')} to {w.get('closedAt', '?')} CET/CEST"
    window_text = (f"Game window: registration opened {window_label}, ending 10 minutes after settlement. "
                   f"{len(running)} of the game's {len(ids) if ids is not None else len(running)} accounts had the DIM2 chat running. Permission and reminders come from the chat worker's telemetry; "
                   "registered and joined come from the chain and the game. A permission check shows a prompt only the first time on a phone; after that the host answers silently. "
                   + ("Whether a notification actually appeared on the phone is not measured." if host is None else
                      "The game reminder row comes from the Polkadot iOS and Android hosts' telemetry, per phone."))
    refused = tried - booked
    never_tried = running - tried
    # every class below is a set from the table above (running, asked, granted, failed, tried, booked), never the book rows' own permission tag
    declined = asked - granted - failed
    kinds = {}
    for r in perm:
        if r.get("outcome") in ("failed", "timed-out"):
            kinds.setdefault(uid(r), set()).add(r["outcome"])
    def failed_word(accts):
        k = set().union(*(kinds.get(x, set()) for x in accts)) if accts else set()
        return "failed or timed out" if len(k) != 1 else ("timed out" if "timed-out" in k else "failed")
    side.update({"neverTried": len(never_tried),
                 "bookedAllGranted": len(booked & granted), "bookedAllDeclined": len(booked & declined),
                 "bookedAllFailed": len(booked & failed), "bookedAllDidNotAsk": len(booked - asked),
                 "refusedGranted": len(refused & granted), "refusedAskedNotGranted": len(refused & declined),
                 "refusedFailed": len(refused & failed), "refusedDidNotAsk": len(refused - asked)})
    acc = lambda n: f"{n} account" + ("" if n == 1 else "s")
    if not tried:
        side_text = "Reminders: no account tried to book them."
    else:
        side_text = (f"Reminders: {len(tried)} of the {len(running)} accounts tried to book them" if never_tried else f"Reminders: {'the' if len(tried) == 1 else 'all'} {acc(len(tried))} tried to book them")
        side_text += (f" ({len(never_tried)} never did)." if never_tried else ".")
        if booked:
            parts = [f"the {len(booked & granted)} with permission granted"] if booked & granted else []
            parts += [f"{n} {t}" for n, t in ((len(booked & declined), "whose permission was checked but wasn't granted"),
                                              (len(booked & failed), f"whose permission request {failed_word(booked & failed)}"),
                                              (len(booked - asked), "with no permission check")) if n]
            parts[0] = parts[0] if parts[0].startswith("the ") else "the " + parts[0]
            side_text += f" The {len(booked)} that booked every reminder are {parts[0]}" + "".join(f" plus {x}" for x in parts[1:]) + "."
        else:
            side_text += " None booked every reminder."
        if refused:
            parts = [f"{n} {t}" for n, t in ((len(refused & declined), "whose permission was checked but wasn't granted"),
                                             (len(refused & failed), f"whose permission request {failed_word(refused & failed)}"),
                                             (len(refused - asked), "with no permission check during the window"),
                                             (len(refused & granted), "that " + ("was" if len(refused & granted) == 1 else "were") + " granted")) if n]
            side_text += f" The {len(refused)} with a booking refused {'is' if len(refused) == 1 else 'are'} " + (", ".join(parts[:-1]) + " and " + parts[-1] if len(parts) > 1 else parts[0]) + "."
    return {"window": window_text, "windowFrom": w.get("from"), "windowTo": w.get("to"), "steps": steps, "side": side_text, "sideCounts": side}


def notification_rows(env, start, end):
    """The chat worker's rows in the window, one Sentry query per message (a combined multi-field query silently dropped rows)."""
    base = f"sdk.name:jollity.chat-worker has:user.id environment:{env}" if env else "sdk.name:jollity.chat-worker has:user.id"
    kw = {"per_page": 100, "start": start, "end": end}
    chat, errors = [], {}
    def attempt(name, run):
        try:
            return run()
        except sentry.OutOfStore:
            raise
        except Exception as error:
            errors[name] = str(error)[:200]
            return []
    for ds in ("errors", "spans"):
        chat += attempt(f"chat {ds}", lambda ds=ds: sentry.events_all(ds, base, ["user.id", "count()"], **kw))
    metric_env = f" environment:{env}" if env else ""
    chat += attempt("chat metrics", lambda: sentry_logs.chat_metric_rows(
        "metric.name:chat.*" + metric_env, [], start, end, _metric_groups=puller.metric_groups))
    permission = attempt("chat permission errors", lambda: sentry.events_all(
        "errors", base + " chat.count:chat.notif.permission", ["user.id", "outcome", "count()"], **kw))
    permission += attempt("chat permission metrics", lambda: sentry_logs.chat_metric_rows(
        "metric.name:chat.notif.permission" + metric_env, ["outcome"], start, end, _metric_groups=puller.metric_groups))
    book = attempt("chat book errors", lambda: sentry.events_all(
        "errors", base + " chat.count:chat.notif.book", ["user.id", "complete", "count()"], **kw))
    book += attempt("chat book metrics", lambda: sentry_logs.chat_metric_rows(
        "metric.name:chat.notif.book" + metric_env, ["complete"], start, end, _metric_groups=puller.metric_groups))
    return {"chat": chat, "permission": permission, "book": book, "queryErrors": errors}



def group_votes(chain, names):
    """Per round and group: who sat there, who reported, and the tallies the chain holds.

    The chain keeps one yes/no tally per account (both rounds added up, weighted by shared
    rounds), so the tallies repeat for a member of two groups.
    """
    out = []
    for r in range(chain["record"]["rounds"] or 0):
        by_group = collections.defaultdict(list)
        for a in chain["accounts"]:
            if r < len(a["groups"]):
                by_group[a["groups"][r]].append(a)
        for g in sorted(by_group):
            members = by_group[g]
            out.append({"round": r + 1, "group": g, "seats": len(members),
                        "reporters": sum(1 for m in members if m["sentReport"]),
                        "members": [{"account": m["account"], "username": names.get(m["account"]), "reported": m["sentReport"],
                                     "yes": m["yesPerson"], "no": m["noNotPerson"], "attested": m["attended"]} for m in members]})
    return out


def chain_group_accounts(chain):
    """Per round (0-based), the accounts of each group in group-index order; the same reading as group_votes."""
    out = []
    for r in range(chain["record"]["rounds"] or 0):
        by_group = collections.defaultdict(list)
        for a in chain["accounts"]:
            if r < len(a["groups"]):
                by_group[a["groups"][r]].append(a["account"])
        out.append([by_group[g] for g in sorted(by_group)])
    return out


HOST_FULL_CYCLE_S = 12  # packages/jollity-game-chain/src/game/constants.ts: 2 intro + 8 play + 2 ending
CONNECT_LEAD_S = 66  # packages/jollity-game-chain/src/game/constants.ts CONNECTION_STAGE_DURATION: the connect stage before round 1
ROUND_GAP_S = 7         # the same file as of v0.1.24 (the build of game 206): rounds start ROUND_GAP apart


def _round_start_s(record, r):
    return r * (HOST_FULL_CYCLE_S * record["maxGroupSize"] + ROUND_GAP_S)


def play_windows(record, lag_s=0):
    """Per round (0-based), (start_ms, end_ms) of the play as the app schedules it from the chain record.

    The app's roundStart(info, r) = r * (HOST_FULL_CYCLE * maxGroupSize + ROUND_GAP) seconds after gameDate,
    and a round plays HOST_FULL_CYCLE * maxGroupSize seconds. `lag_s` shifts the clock the players ran on
    against the game date (see clock_lag)."""
    per_round = HOST_FULL_CYCLE_S * record["maxGroupSize"]
    return [(round((record["gameDate"] + _round_start_s(record, r) + lag_s) * 1000),
             round((record["gameDate"] + _round_start_s(record, r) + per_round + lag_s) * 1000))
            for r in range(record["rounds"] or 0)]


def clock_lag(logs, record):
    """Seconds the players' turns ran behind the chain schedule: the median over every logged player's
    "turn sealed" line of (its time - the end of that turn on the schedule). The app runs on the chain
    clock, which trails the wall clock the logs carry by several seconds; 0 when no log sealed a turn.
    The log's turn counts across the game (round 1 holds turns 6-11), so the turn in its round is turn % maxGroupSize."""
    lags = []
    for lg in logs:
        for e in lg["entries"]:
            d = e.get("data") or {}
            if e.get("tag") == "vote" and e.get("message") == "turn sealed" and "round" in d and "turn" in d:
                end = record["gameDate"] + _round_start_s(record, d["round"]) + (d["turn"] % record["maxGroupSize"] + 1) * HOST_FULL_CYCLE_S
                lags.append(e["ts"] / 1000 - end)
    return statistics.median(lags) if lags else 0


HOST_INTRO_S = 2
HOST_PLAY_S = 8
HOST_LIVE_MIN_S = HOST_PLAY_S / 2


def _state_overlap(events, start, end, live_states, cutoff=None, excluded=()):
    """Milliseconds in live_states during [start, end], capped by evidence and excluded spans."""
    if cutoff is not None:
        end = min(end, cutoff)
    if end <= start:
        return 0

    hidden = []
    for left, right in sorted(excluded):
        left, right = max(start, left), min(end, right)
        if right <= left:
            continue
        if hidden and left <= hidden[-1][1]:
            hidden[-1] = (hidden[-1][0], max(hidden[-1][1], right))
        else:
            hidden.append((left, right))

    def visible(left, right):
        return max(0, right - left) - sum(max(0, min(right, h1) - max(left, h0)) for h0, h1 in hidden)

    state, cursor, total = None, start, 0
    for event in sorted(events, key=lambda item: item["at"]):
        at = event["at"]
        if at <= start:
            state = event["state"]
            continue
        if at >= end:
            break
        if state in live_states:
            total += visible(cursor, at)
        cursor, state = at, event["state"]
    if state in live_states:
        total += visible(cursor, end)
    return total


def _timeline_overlap(segments, start, end):
    return sum(max(0, min(end, segment["to"]) - max(start, segment["from"]))
               for segment in segments if segment.get("state") == "connected")


def player_host_coverage(chain, joined, logs, links, windows, names=None):
    """Share of joined players' other-host turns where a live face filled >= half of play.

    For each viewer and host turn, seat lines are authoritative: persistent live
    or weak state must cover at least 4 s of the 8 s play stage. Only when that
    viewer has no seat line for that host by the end of the turn do we fall back
    to the viewer->host connected segments in links.json's directional timeline.
    Empty seats, registered hosts who never joined, and joined hosts without
    enough video remain separate loss buckets.

    All turn windows use one shared median clock_lag across players. A viewer
    whose phone clock differs near the 4 s threshold can therefore be
    misclassified until retained evidence supports per-viewer lag.
    """
    record = chain["record"]
    rounds, max_size = record["rounds"] or 0, record["maxGroupSize"]
    if len(windows) < rounds:
        raise ValueError("player host coverage needs one play window per round")
    names = names or {}
    joined = set(joined)
    accounts = {row["account"]: row for row in chain["accounts"]}
    missing = sorted(joined - set(accounts))
    joined &= set(accounts)

    by_round = []
    for round_index in range(rounds):
        groups = collections.defaultdict(list)
        for row in chain["accounts"]:
            if round_index >= len(row.get("groups", [])) or round_index >= len(row.get("positions", [])):
                raise ValueError(f"chain account lacks round {round_index + 1} seat: {row['account']}")
            groups[row["groups"][round_index]].append(row)
        by_round.append({group: sorted(members, key=lambda row: row["positions"][round_index])
                         for group, members in groups.items()})

    seat_events = collections.defaultdict(list)
    for event in (links or {}).get("seatStates", []):
        seat_events[(event["account"], event["peer"])].append(event)
    viewer_evidence = {}
    for viewer, log in logs.items():
        entries = sorted(log.get("entries", []), key=lambda item: item["ts"])
        if entries:
            viewer_evidence[viewer] = (entries[-1]["ts"], gl.hidden_intervals(entries))
        parsed = gl.seat_state_events(viewer, log)
        if parsed:
            by_peer = collections.defaultdict(list)
            for event in parsed:
                by_peer[event["peer"]].append(event)
            for peer, events in by_peer.items():
                seat_events[(viewer, peer)] = events

    timelines = {(item["viewer"], item["peer"]): item.get("segments", [])
                 for item in (links or {}).get("timeline", [])}
    totals = collections.Counter()
    players = []
    for viewer in sorted(joined):
        live, turns = 0, 0
        used_sources = set()
        viewer_row = accounts[viewer]
        for round_index in range(rounds):
            group = viewer_row["groups"][round_index]
            members = by_round[round_index].get(group, [])
            viewer_seat = next((seat for seat, row in enumerate(members) if row["account"] == viewer), None)
            if viewer_seat is None:
                raise ValueError(f"joined account has no round {round_index + 1} seat: {viewer}")
            for seat in range(max_size):
                if seat == viewer_seat:
                    continue
                turns += 1
                host = members[seat]["account"] if seat < len(members) else None
                if host is None:
                    totals["emptySeats"] += 1
                    continue
                if host not in joined:
                    totals["noShows"] += 1
                    continue
                play_start = windows[round_index][0] + seat * HOST_FULL_CYCLE_S * 1000 + HOST_INTRO_S * 1000
                play_end = play_start + HOST_PLAY_S * 1000
                key = (viewer, host)
                turn_seat_events = [event for event in seat_events.get(key, []) if event["at"] <= play_end]
                cutoff, hidden = viewer_evidence.get(viewer, (None, ()))
                if turn_seat_events and (cutoff is None or cutoff > play_start):
                    visible = _state_overlap(turn_seat_events, play_start, play_end, {"live", "weak"}, cutoff, hidden)
                    used_sources.add("seat-states")
                elif key in timelines:
                    visible = _timeline_overlap(timelines[key], play_start, play_end)
                    used_sources.add("links-timeline")
                else:
                    visible = 0
                    used_sources.add("no-evidence")
                if visible >= HOST_LIVE_MIN_S * 1000:
                    live += 1
                else:
                    totals["noVideo"] += 1
        coverage = round(live / turns * 100, 1) if turns else None
        players.append({"account": viewer, "username": names.get(viewer) or viewer_row.get("username"),
                        "liveTurns": live, "turns": turns, "coverage": coverage,
                        "source": next(iter(used_sources)) if len(used_sources) == 1 else "mixed" if used_sources else "none"})
        totals["liveTurns"] += live
        totals["turns"] += turns

    turns = totals["turns"]
    percentages = [item["coverage"] for item in players if item["coverage"] is not None]
    pct = lambda key: round(totals[key] / turns * 100, 1) if turns else None
    return {"coverage": pct("liveTurns"), "liveTurns": totals["liveTurns"], "turns": turns,
            "median": round(statistics.median(percentages), 1) if percentages else None,
            "range": [min(percentages), max(percentages)] if percentages else None,
            "emptySeats": totals["emptySeats"], "emptySeatsPct": pct("emptySeats"),
            "noShows": totals["noShows"], "noShowsPct": pct("noShows"),
            "noVideo": totals["noVideo"], "noVideoPct": pct("noVideo"),
            "missingChainPlayers": len(missing), "missingChainAccounts": missing,
            "players": players}


AWAY_KEEP = 50  # AWAY_INTERVAL_KEEP in apps/jollity-app/lib/telemetry/foreground.ts: the latest intervals a player's log is read for
AWAY_WALL_DOMINATES = 2  # a wall span this many times the chain span (plus AWAY_WALL_SLACK_S) wins: the chain clock read behind across a freeze
AWAY_WALL_SLACK_S = 2


def _away_lines(log, message):
    out = []
    for e in log.get("entries", []):
        d = e.get("data")
        if e.get("tag") == "foreground" and e.get("message") == message and isinstance(d, dict) and isinstance(d.get("hiddenAtMs"), (int, float)):
            out.append(d)
    return out


def away_intervals(log):
    """The app's own away intervals from a game log (apps/jollity-app/lib/telemetry/foreground.ts, #435): the `foreground` /
    `away interval` lines, latest AWAY_KEEP by hide time. Each carries the wall edges in epoch ms, the chain-clock
    edges in seconds (null before an anchor, and always null for a freeze the heartbeat found), how the return was
    detected (visibility | pageshow | freeze-detected), and startedHidden (the page began hidden)."""
    out = sorted((d for d in _away_lines(log, "away interval") if isinstance(d.get("shownAtMs"), (int, float))), key=lambda d: d["hiddenAtMs"])
    return out[-AWAY_KEEP:]


def away_truncated(log):
    """True when the log holds more intervals than the report reads (the older ones were left out)."""
    return sum(1 for d in _away_lines(log, "away interval") if isinstance(d.get("shownAtMs"), (int, float))) > AWAY_KEEP


def away_open(log):
    """`away open` markers with no interval closing them in the same page session.

    A later page session is affirmative return evidence. Bound the older open marker at that session's first
    retained line instead of carrying it to the end of a later game and claiming the player never returned.
    """
    entries = log.get("entries", [])
    starts = {}
    for e in entries:
        sid, ts = e.get("sessionId"), e.get("ts")
        if isinstance(sid, str) and _isnum(ts):
            starts[sid] = min(starts.get(sid, ts), ts)
    closed = {
        (e.get("sessionId"), e["data"]["hiddenAtMs"])
        for e in entries
        if e.get("tag") == "foreground" and e.get("message") == "away interval"
        and isinstance(e.get("data"), dict) and _isnum(e["data"].get("hiddenAtMs"))
    }
    running = {
        (e.get("sessionId"), e["data"]["hiddenAtMs"])
        for e in entries
        if e.get("tag") == "foreground" and e.get("message") == "away running"
        and isinstance(e.get("data"), dict) and _isnum(e["data"].get("hiddenAtMs"))
    }
    out = []
    for e in entries:
        d = e.get("data")
        if e.get("tag") != "foreground" or e.get("message") != "away open" or not isinstance(d, dict) or not _isnum(d.get("hiddenAtMs")):
            continue
        sid, hidden = e.get("sessionId"), d["hiddenAtMs"]
        if (sid, hidden) in closed:
            continue
        resumed = min((ts for other, ts in starts.items() if other != sid and ts > hidden), default=None)
        ran = {"keptRunning": True} if (sid, hidden) in running else {}
        out.append({**d, **ran, "shownAtMs": resumed, "shownChainS": None, "via": "session-resumed"} if resumed is not None else {**d, **ran})
    return out


def turn_windows(record):
    """(round, turn, start_s, end_s) of every turn on the chain schedule, seconds, 0-based round and turn."""
    size = record["maxGroupSize"]
    return [(r, t, record["gameDate"] + _round_start_s(record, r) + t * HOST_FULL_CYCLE_S,
             record["gameDate"] + _round_start_s(record, r) + (t + 1) * HOST_FULL_CYCLE_S)
            for r in range(record["rounds"] or 0) for t in range(size)]


def _isnum(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _place(iv, record, lag_s):
    """(lo, hi, on_chain) of an interval on the schedule in seconds. An open one (no shownAtMs) runs to the end of the game.

    Chain edges are used when both exist, unless the wall span is much larger than the chain span: the chain clock
    reads behind across a visible freeze, so a sliver there is not the absence. The wall edges are then shifted by
    lag_s (clock_lag). hi <= lo is returned as is, for the caller to report as unplaced."""
    wall_lo = iv["hiddenAtMs"] / 1000 - lag_s
    if not _isnum(iv.get("shownAtMs")):
        end = max((te for _r, _t, _ts, te in turn_windows(record)), default=wall_lo)
        return (iv["hiddenChainS"] if _isnum(iv.get("hiddenChainS")) else wall_lo), end, _isnum(iv.get("hiddenChainS"))
    wall_hi = iv["shownAtMs"] / 1000 - lag_s
    if _isnum(iv.get("hiddenChainS")) and _isnum(iv.get("shownChainS")):
        c_lo, c_hi = iv["hiddenChainS"], iv["shownChainS"]
        if (wall_hi - wall_lo) <= AWAY_WALL_DOMINATES * (c_hi - c_lo) + AWAY_WALL_SLACK_S:
            return c_lo, c_hi, True
    return wall_lo, wall_hi, False


AWAY_RAN_SLACK_MS = 2000  # a page that ran within this of the whole hidden period counts as running throughout


def kept_running(iv):
    """True when the page kept running through the whole hidden period (a minimized game tab or another screen in the
    host), not a suspension (the app in the background). Needs the app's `ranHiddenMs`/`suspendedHidden` (or, for an open
    marker, an `away running` line); older logs have neither and stay False, the old wording."""
    if iv.get("keptRunning"):
        return True
    ran = iv.get("ranHiddenMs")
    if not _isnum(ran) or iv.get("suspendedHidden") is not False or not _isnum(iv.get("shownAtMs")):
        return False
    return (iv["shownAtMs"] - iv["hiddenAtMs"]) - ran <= AWAY_RAN_SLACK_MS


def away_turns(intervals, record, lag_s=0, opens=()):
    """Which turns a player's proven away intervals overlapped: [{round, turn, overlapS, via, chain, startedHidden}], 1-based, in order.

    `opens` are unmatched `away open` markers (away_open): open-ended, they run to the end of the game and say via "open".
    An overlap of zero is no overlap."""
    out = {}
    rows = [(iv, False) for iv in intervals] + [({**o, "via": o.get("via") or "open"}, True) for o in opens]
    for iv, was_open in rows:
        lo, hi, chain = _place(iv, record, lag_s)
        # An unmatched marker from an old home-page session is not evidence that the player stayed away into a
        # later game. The app hands over to the game one minute before kickoff; only an open interval beginning
        # in that game lifetime may be extended or bounded against its turns.
        if was_open and lo < record["gameDate"] - HANDOVER_S:
            continue
        if hi <= lo:
            continue
        for r, t, ts, te in turn_windows(record):
            overlap = min(hi, te) - max(lo, ts)
            if overlap > 0:
                row = out.setdefault((r, t), {"round": r + 1, "turn": t + 1, "overlapS": 0.0, "via": set(), "chain": True, "startedHidden": False, "keptRunning": True})
                row["overlapS"] += overlap
                row["via"].add(iv.get("via"))
                row["chain"] = row["chain"] and chain
                row["startedHidden"] = row["startedHidden"] or bool(iv.get("startedHidden"))
                row["keptRunning"] = row["keptRunning"] and kept_running(iv)
    return [{**row, "overlapS": round(row["overlapS"], 1), "via": sorted(v for v in row["via"] if v)} for _, row in sorted(out.items())]


def away_unplaced(intervals, record, lag_s=0):
    """Intervals whose edges run backwards or not at all on the schedule: never dropped silently, the report says how many."""
    return [iv for iv in intervals if (p := _place(iv, record, lag_s))[1] <= p[0]]


WEB_SIGNUP_CALLS = {"sign_up_with_account_lite_invite", "sign_up_with_account"}  # what the web app sends (apps/jollity-app/CONTEXT.md §3: A lite, B returning and C deposit); D sign_up_with_invite is not the web app
HANDOVER_S = 66  # the waiting room hands over to /game this long before play (CONNECTION_STAGE_DURATION)


def registration_by_account(chain):
    """account -> {at, route, call} from the chain reader's registration fields; "web" is a route the web app sends (lite, returning or deposit), "other"
    any other sign-up call (a native client). Accounts the reader could not place are left out."""
    out = {}
    for a in (chain or {}).get("accounts", []):
        call = a.get("registrationCall")
        if call:
            out[a["account"]] = {"at": a.get("registeredAt"), "route": "web" if call.split(".")[-1] in WEB_SIGNUP_CALLS else "other", "call": call}
    return out


CHAT_SDK = "jollity.chat-worker"


def is_app_root(root):
    """An app root is the complement of a chat-worker root."""
    return not is_chat_root(root)


def is_recovered_root(root):
    """A lost page's journey, recovered and emitted by the following page.

    Its session.id belongs to the following page, so it is historical evidence,
    never that page's start or evidence that the following page had already played.
    """
    recovered = root.get("journey.recovered")
    return recovered is True or str(recovered).lower() == "true" or bool(root.get("journey.previous_session_id"))


def is_chat_root(root):
    """A chat-worker root, including saved pulls from before sdk.name/surface were selected."""
    return (root.get("sdk.name") == CHAT_SDK or root.get("surface") == "chat"
            or str(root.get("span.op") or "").startswith("chat.") or not root.get("host.kind"))


def partition_roots(roots):
    """(app, chat-worker) roots, classified once for a player's report row."""
    app, chat = [], []
    for root in roots:
        (chat if is_chat_root(root) else app).append(root)
    return app, chat


def short_release(root):
    return (root.get("release") or "").replace("jollity-next@", "")[:8] or None


def _latest_release(roots):
    return next((short_release(root) for root in reversed(roots) if short_release(root)), None)


def worker_release(roots):
    """The newest chat worker release, kept separate from the app release."""
    return _latest_release(partition_roots(roots)[1])


def _signup_step_route(root, signup_count, steps):
    """The route child step belonging to one app sign-up root, when the pull includes it."""
    routes = [step for step in steps if step.get("transaction") == "journey.game-signup" and step.get("signup.route")]
    if not routes:
        return None
    if signup_count == 1:
        return routes[-1]["signup.route"]
    try:
        start = parse_ts(root["timestamp"])
        end = start + datetime.timedelta(milliseconds=fnum(root.get("span.duration")) or 0)
        inside = [step for step in routes if start <= parse_ts(step["timestamp"]) <= end]
        return inside[-1]["signup.route"] if inside else None
    except (KeyError, TypeError, ValueError):
        return None


def signup_route(roots, fallback=None, steps=()):
    """The surface that actually signed up, from the sign-up journey's signup.route.

    Prefer a journey that landed ("landed" in the app, "sent" in chat), so a
    failed chat attempt cannot override a later app sign-up. Chat carries the
    route on its root; the app carries it on its route child step. Older saved
    pulls without the child field retain the chain-call classification.
    """
    journeys = [root for root in roots if root.get("span.op") == "journey.game-signup"]
    if not journeys:
        return fallback
    landed = [root for root in journeys if root.get("journey.outcome") in ("landed", "sent")]
    chosen = (landed or journeys)[-1]
    route = chosen.get("signup.route") or _signup_step_route(chosen, len(journeys), steps)
    if not route:
        return fallback
    return "chat" if is_chat_root(chosen) else "web"


def _first_connected(segments, lo, hi):
    """First moment inside [lo, hi] a viewer's link is connected, None when it never is."""
    for sg in segments:
        if sg["state"] in ("connected", "relay") and sg["to"] > lo and sg["from"] < hi:  # a relayed link is up too
            return max(sg["from"], lo)
    return None


def _first_seen(segments, lo, hi):
    """When a viewer's own view of the link begins inside [lo, hi] (the log starts it; None when it has no segment there)."""
    starts = [max(sg["from"], lo) for sg in segments if sg["to"] > lo and sg["from"] < hi]
    return min(starts) if starts else None


def _session_start(pull_player, at_ms):
    """Start (ms) of the Sentry session the player was in at `at_ms`: the latest session whose first sign of activity is at or before it."""
    first = {}
    for r in (pull_player or {}).get("roots", []):
        if is_recovered_root(r):
            continue
        sid, ts = r.get("session.id"), r.get("timestamp")
        if sid and ts:
            t = parse_ts(ts).timestamp() * 1000
            first[sid] = min(first.get(sid, t), t)
    starts = [t for t in first.values() if t <= at_ms]
    return max(starts) if starts else None


def _sessions(pull_player):
    """{session id: (first timestamp ms, played)} from the player's Sentry roots; played is True when the session carried a
    join or game journey tagged with a game (the player was in the game, not just opening the app)."""
    out = {}
    for r in (pull_player or {}).get("roots", []):
        if is_recovered_root(r):
            continue
        sid, ts = r.get("session.id"), r.get("timestamp")
        if not (sid and ts):
            continue
        t = parse_ts(ts).timestamp() * 1000
        played = r.get("span.op") in ("journey.join", "journey.game") and r.get("game.index") not in (None, "")
        first, was = out.get(sid, (t, False))
        out[sid] = (min(first, t), was or played)
    return out


RELOAD_ENDS = {"host-reload", "own-reload", "crash-or-kill-foreground", "killed-background"}


def page_lives(pull_player, game=None):
    """The app pages visible in one player's pull, with each page's end.

    A previous-session-end event is emitted by page k+1 and carries page k's
    verdict. Its previous.session.session_id is the app's durable record id,
    not Sentry's session id, so the join is: locate page k+1 by the event's
    current session.id, then attach the verdict to the preceding page in time.
    A directly matching previous id is accepted for newer evidence that can
    provide it. This keeps the join deterministic without guessing by user or
    by an untagged event's timestamp alone.
    """
    sessions = {}
    for root in (pull_player or {}).get("roots", []):
        if is_recovered_root(root):
            continue
        sid, timestamp = root.get("session.id"), root.get("timestamp")
        if not (sid and timestamp and is_app_root(root)):
            continue
        at = parse_ts(timestamp)
        life = sessions.setdefault(sid, {"sessionId": sid, "startedAt": timestamp, "lastSeenAt": timestamp,
                                         "_at": at, "_last": at, "_roots": []})
        if at < life["_at"]:
            life.update(startedAt=timestamp, _at=at)
        if at > life["_last"]:
            life.update(lastSeenAt=timestamp, _last=at)
        life["_roots"].append(root)
    lives = sorted(sessions.values(), key=lambda life: (life["_at"], life["sessionId"]))
    by_id = {life["sessionId"]: life for life in lives}

    for event in sorted((pull_player or {}).get("pageEnds", []), key=lambda row: (row.get("timestamp") or "", row.get("id") or "")):
        previous_game = event.get("previous.game") or event.get("previous.session.game_index")
        if game is not None and str(previous_game) != str(game):
            continue
        current = by_id.get(event.get("session.id"))
        direct = by_id.get(event.get("previous.session.session_id"))
        target = direct
        if target is None and current is not None:
            index = lives.index(current)
            target = lives[index - 1] if index > 0 else None
        if target is None and current is not None:
            target = {
                "sessionId": event.get("previous.session.session_id") or f"before:{current['sessionId']}",
                "startedAt": None,
                "lastSeenAt": None,
                "_at": current["_at"] - datetime.timedelta(microseconds=1),
                "_last": current["_at"] - datetime.timedelta(microseconds=1),
                "_roots": [],
            }
            lives.insert(lives.index(current), target)
            by_id[target["sessionId"]] = target
        if target is None:
            continue
        target.update({
            "end": event.get("previous.end") or "unknown",
            "endedAt": event.get("timestamp"),
            "nextSessionId": event.get("session.id"),
            "previousRecordId": event.get("previous.session.session_id"),
            "inGame": event.get("previous.in_game"),
            "turn": event.get("previous.turn"),
            "screen": event.get("previous.screen"),
            "gapMs": event.get("previous.session.gap_ms"),
            "openJourneys": event.get("previous.session.open_journeys"),
        })

    for life in lives:
        if "end" not in life:
            played = any(root.get("span.op") == "journey.game" and
                         (game is None or str(root.get("game.index")) == str(game))
                         for root in life["_roots"])
            life["end"] = "played" if played else "open"
        life.pop("_at", None)
        life.pop("_last", None)
        life.pop("_roots", None)
    return lives


def page_lives_in_window(lives, window):
    """Return page lives overlapping window and the count ending before it."""
    if not window:
        return lives, 0
    start, end = window
    kept, earlier = [], 0
    ordered = sorted(lives, key=lambda life: life.get("startedAt") or "")
    for life in ordered:
        opened = parse_ts(life["startedAt"]) if life.get("startedAt") else None
        closed = parse_ts(life["endedAt"]) if life.get("endedAt") else None
        # No explicit end is not evidence that a page stayed alive for hours.
        # Bound it by the last app activity observed in that Sentry session,
        # while leaving its ending verdict unknown.
        if closed is None and life.get("lastSeenAt"):
            closed = parse_ts(life["lastSeenAt"])
        if closed is not None and closed < start:
            earlier += 1
        elif (opened is None or opened <= end) and (closed is None or closed >= start):
            kept.append(life)
    return kept, earlier


PAGE_END_NOTE = {
    "host-reload": "ended with a host reload",
    "own-reload": "ended with a page reload",
    "crash-or-kill-foreground": "was killed in the foreground",
    "killed-background": "was killed in the background",
    "clean-close": "closed cleanly",
    "unknown": "had an unknown ending",
}


def page_lives_note(lives, earlier=0):
    """Short player-row note grouping known page endings in the game window."""
    if not lives:
        return None
    counts = collections.Counter(life.get("end") for life in lives if life.get("end") not in ("open", "played"))
    details = [f"{count} {PAGE_END_NOTE.get(ending, str(ending or 'unknown').replace('-', ' '))}"
               for ending, count in counts.items()]
    line = f"{len(lives)} page {'life' if len(lives) == 1 else 'lives'} during the game"
    if details:
        line += ": " + ", ".join(details)
    if earlier:
        line += f"; {earlier} earlier {'session was' if earlier == 1 else 'sessions were'} omitted"
    return line


def _page_end_mid_round(event):
    """Whether the ended page had progressed beyond the waiting-room handover."""
    turn = event.get("previous.turn")
    if turn not in (None, "", "unknown"):
        return True
    open_journeys = (event.get("previous.session.open_journeys") or
                     (event.get("failure") or {}).get("open_journeys"))
    if isinstance(open_journeys, str):
        open_journeys = open_journeys.split(",")
    return "game" in {str(value).strip() for value in open_journeys or []}


def _reloaded(pull_player, started, events, lo, hi, game=None):
    """True when the session that began at `started` replaced one in which the player had already been in the game: an
    earlier Sentry session of the same player carried a join or game journey (game-report-pull.py roots), or the game log
    holds a rejoin (game-links.py events: the mesh reopened for the same room) inside the round [lo, hi]. A first open of
    the app, after play began, has neither."""
    if any(first < started and played for first, played in _sessions(pull_player).values()):
        return True
    replacement_sessions = {
        session_id for session_id, (first, _) in _sessions(pull_player).items()
        if abs(first - started) < 1
    }
    if any(
            event.get("session.id") in replacement_sessions and
            game is not None and
            str(event.get("previous.game") or event.get("previous.session.game_index")) == str(game) and
            event.get("previous.end") in RELOAD_ENDS and
            _page_end_mid_round(event)
            for event in (pull_player or {}).get("pageEnds", [])):
        return True
    if any(
            event.get("title") == "previous-session-end" and
            event.get("session.id") in replacement_sessions and
            game is not None and str(event.get("previous.game")) == str(game) and
            (event.get("failure") or {}).get("kind") == "unclean-exit" and
            _page_end_mid_round(event)
            for event in (pull_player or {}).get("events", [])):
        return True
    return any(e.get("kind") == "rejoin" and lo <= e["at"] <= hi for e in events or [])


def _session_cause(pull_player, ps, at, events=(), lo=None, hi=None, game=None):
    """The category for a player whose own view of a round began at `at`, from the Sentry session they were in then:
    None for no session (Unknown, no telemetry is the caller's word), "App in the background" when it began before the
    handover (the app came back), "Page reloaded mid-round" or "Late open" when it began after play started (the page was
    replaced after the player had been in the game, or the app first came up). A session between the handover and play
    start gives "" (an ordinary slow start)."""
    started = _session_start(pull_player, at)
    if started is None:
        return "Unknown, no telemetry", None
    if started < ps - HANDOVER_S * 1000:
        return "App in the background", started
    if started > ps:
        if _reloaded(pull_player, started, events, ps if lo is None else lo, at if hi is None else hi, game):
            return "Page reloaded mid-round", started
        return "Late open", started
    return "", started


def _absence_cause(pull_player, play_start, back_at, events=(), game=None):
    """Why a player was not in a round's play: the Sentry session they were in when they came back (`back_at`, their
    first view after the round) began before the handover (the app came back: background), after play started and
    replaced a session that had been in the game (page reloaded mid-round), after play started with nothing before it
    (late open), or there is none (unknown)."""
    return _session_cause(pull_player, play_start, back_at, events, game=game)[0] or "Late open"


def _camera_ms(pull_player):
    """Slowest camera acquire step (ms) the player's pull holds, None when there is none."""
    ds = [fnum(s.get("span.duration")) for s in (pull_player or {}).get("steps", []) if s.get("span.op") == "join.camera.acquire"]
    ds = [d for d in ds if d is not None]
    return max(ds) if ds else None


def pair_rounds(groups, windows, joined=None):
    """Expected joined account pairs and their chain-window duration.

    Without the link picture's joined set, retain the legacy reported-pair
    fallback for callers that have no presence evidence.
    """
    for group in groups or []:
        r = group["round"]
        window_ms = windows[r - 1][1] - windows[r - 1][0] if 0 < r <= len(windows) else 0
        accounts = sorted(member["account"] for member in group.get("members", [])
                          if (member["account"] in joined if joined is not None else member.get("reported")))
        for i, a in enumerate(accounts):
            for b in accounts[i + 1:]:
                yield {"round": r, "group": group["group"], "a": a, "b": b, "windowMs": window_ms}


def _coverage_joined_accounts(links, pull_players, windows):
    """Players with shared-clock game or peer-observed proof that they were present during play.

    A completed lobby join alone is not proof: the player may have left before
    play. A game journey must end after play started, and a directional timeline
    proves only that its viewer saw the peer connected for at least 10 seconds of
    one round's play; the viewer's page-clock segments do not prove the viewer
    participated. The explicit joined fields mark a current link picture; older
    callers without them retain the reported-pair fallback.
    """
    players = (links or {}).get("players", [])
    if not players or not all("joined" in p for p in players):
        return None
    play_starts = [start for start, _ in windows if start is not None]
    first_play_start = min(play_starts) if play_starts else None
    joined = {account for account, player in (pull_players or {}).items()
              if first_play_start is not None and any(
                  root.get("span.op") == "journey.game" and root.get("timestamp") and
                  parse_ts(root["timestamp"]).timestamp() * 1000 +
                  (fnum(root.get("span.duration")) or 0) > first_play_start
                  for root in player.get("roots", []))}
    for row in (links or {}).get("timeline", []):
        if any(_timeline_overlap(row.get("segments", []), start, end) >= COVERAGE_JOINED_PEER_MS
               for start, end in windows):
            joined.add(row["peer"])
    return joined


def _coverage_pair(value, game, row_round):
    match = re.fullmatch(r"g([^:]+):r(\d+):([^~:]+)~([^~:]+)", str(value or ""))
    if not match or match.group(1) != str(game) or match.group(2) != str(row_round):
        raise ValueError(f"invalid rtc.pair on coverage metric: {value!r}")
    a, b = match.group(3), match.group(4)
    if not a < b:
        raise ValueError(f"unsorted rtc.pair on coverage metric: {value!r}")
    return frozenset((a, b))


SLICE_METRICS = frozenset({"rtc.video_ms", "rtc.present_ms"})
LEGACY_COVERAGE_METRICS = frozenset({"rtc.coverage_s", "rtc.coverage_pct"})


def viewer_available(player, slice_releases):
    """Whether a viewer's silence is measured (zero video) rather than missing (the other end decides).

    A build sends slices only while its page is visible (presentMs > 0), so a viewer backgrounded all game sends
    none even on a current build; slices in this game prove support, their absence proves nothing. Slice support
    is therefore decided by the viewer's RELEASE: slice-capable when any player on it emitted a slice (the pull's
    sliceReleases). Available iff no coverage_error and either it sent slices, or its release is slice-capable and
    it has a journey.join or journey.game root (a player backgrounded all game is real loss). Unavailable: a release
    that never emitted slices, with or without legacy rows (v0.1.25 and older, game 209), and a viewer with no
    join/game root (game 216: telemetry stopped before the game). With no release or no sliceReleases to go on, it
    is available unless it carries the legacy-only signature.
    """
    if player.get("coverage_error"):
        return False
    names = {row.get("metric.name") for row in player.get("metrics", [])}
    if names & SLICE_METRICS:
        return True
    if not any(row.get("span.op") in ("journey.join", "journey.game") for row in player.get("roots", [])):
        return False
    release = next((r["release"] for r in reversed(player.get("roots", [])) if r.get("release")), None)
    if release is None or slice_releases is None:
        return not names & LEGACY_COVERAGE_METRICS
    return release in slice_releases


def coverage_links_from_metrics(game, links, groups, pull_players, windows, slice_releases=None):
    """A links-shaped coverage matrix sourced only from live metric slices.

    The pull is per viewer account and already spans every one of their page
    sessions, so summing rtc.video_ms survives a reload. Any coverage point in
    the game proves that viewer supports the metric; an absent expected pair is
    then zero rather than n/a. The denominator is always the corresponding
    lag-adjusted chain window, never client presence. The diagnostic link
    timeline is copied through for cause labels only.
    """
    out = dict(links or {})
    out["rounds"] = list(out.get("rounds") or [
        {"round": i + 1, "start": start, "end": end, "playStart": start, "playEnd": end}
        for i, (start, end) in enumerate(windows)
    ])

    sums = collections.defaultdict(float)
    available_viewers = {viewer for viewer, player in pull_players.items() if viewer_available(player, slice_releases)}
    coverage_errors = sum(1 for player in pull_players.values() if player.get("coverage_error"))
    for viewer, player in pull_players.items():
        for row in player.get("metrics", []):
            name = row.get("metric.name")
            if name not in SLICE_METRICS:
                continue
            row_round = row.get("round")
            pair = _coverage_pair(row.get("rtc.pair"), game, row_round)
            sums[(viewer, name, int(row_round), pair)] += fnum(row.get("sum(value)")) or 0

    joined = _coverage_joined_accounts(links, pull_players, windows)
    matrix = []
    for expected in pair_rounds(groups, windows, joined):
        r, a, b, window_ms = expected["round"], expected["a"], expected["b"], expected["windowMs"]
        pair = frozenset((a, b))
        directions, clipped = [], 0
        for viewer in (a, b):
            if viewer not in available_viewers:
                continue
            present = sums[(viewer, "rtc.present_ms", r, pair)]
            video = sums[(viewer, "rtc.video_ms", r, pair)]
            if present > window_ms + 3_000 or video > window_ms + 3_000:
                clipped += 1
            directions.append(min(video, window_ms) / window_ms if window_ms > 0 else 0)
        seen = "both" if len(directions) == 2 else "one" if directions else "neither"
        matrix.append({**{k: expected[k] for k in ("round", "group", "a", "b")},
                       "coverage": min(directions) if directions else None,
                       "seenBy": seen, "coverageSource": "metrics", "clipped": clipped})
    out["matrix"] = matrix
    out["coverageErrors"] = coverage_errors
    return out


# seconds of a round's play window a pair loses to drops after its link first
# came up, from which the loss is "Lost after the link came up" rather than "Other"
UNSTABLE_LINK_S = 10


def coverage_breakdown(links, groups, registration, pull_players, game=None):
    """Where the missing video coverage went, in percent of the coverage metric (field pct).

    Coverage is the mean, over the measured expected pair-rounds, of each pair's decoded-video share of the chain play window.
    An expected pair-round is two accounts in one chain group of a round who both joined, whether or not they reported; one
    with no live metric direction is n/a and left out. Each measured pair-round weighs 100/N percent and its missing share
    (1 - coverage) goes to
    the first cause that fits: Native players (either account registered through a route the web app has not), App in the
    background (a player's own view of the link began after play started, in a Sentry session that was already running before
    the handover: the app came back), Page reloaded mid-round (the same, in a session that began after play started and
    replaced one that had been in the game), Late open (the same, in a session that began after play started with no earlier
    game session: the app first came up), Unknown, no telemetry (the same, but that player has no Sentry session to tell
    which), the same causes for a player whose log and their peer's log have no view of the round at all (missed it), Log
    gap, cause unknown (positive video coverage and only one side's diagnostic log has no round view), Link never came up (both
    present, never connected inside play), Round N link setup (both present, the pair connected after play started), Lost
    after the link came up (UNSTABLE_LINK_S or more lost after the link first came up; sized, not read from the timeline), Other (the rest: short drops, round edges).

    Returns {coverage, measured, na, missing, webOnly, nonWeb, clipped, oneSided, causes: [{cause, pct, pairs, items}]}, causes by pct
    descending. pairs are readable labels with names, for analysis only. items hold one dict per pair-round that fed the
    cause: {round, native (web-to-native or not), cov, lostS (seconds of the round's play window), backS, connectS,
    reloadS, rejoinS, cameraMs, silent} with no names, from which coverage_note() writes its sentences. webOnly is the
    mean coverage between two web players, in percent (None without such a pair), nonWeb is True when a player who joined was
    not on the web app."""
    rounds = {r["round"]: r for r in (links or {}).get("rounds", [])}
    timeline = collections.defaultdict(list)
    for t in (links or {}).get("timeline", []):
        timeline[(t["viewer"], t["peer"])].extend(t["segments"])
    events = collections.defaultdict(list)
    for e in (links or {}).get("events", []):
        events[e.get("account")].append(e)
    windows = [(r.get("playStart"), r.get("playEnd")) for _, r in sorted(rounds.items())]
    joined = _coverage_joined_accounts(links, pull_players, windows)
    ok = {}  # (round, account) -> username of the members expected in coverage
    for g in groups or []:
        for m in g["members"]:
            if (m["account"] in joined if joined is not None else m["reported"]):
                ok[(g["round"], g["group"], m["account"])] = m["username"]
    name = lambda r, a: next((u for (rr, _, aa), u in ok.items() if rr == r and aa == a and u), None) or SHORT(a)
    native = lambda x: (registration.get(x) or {}).get("route") == "other"
    expected = {(p["round"], p["group"], p["a"], p["b"]) for p in pair_rounds(groups, windows, joined)}
    pairs = []
    na = 0
    for m in (links or {}).get("matrix", []):
        if (m["round"], m["group"], m["a"], m["b"]) not in expected:
            continue
        if m["coverage"] is None:
            na += 1
        else:
            pairs.append(m)
    n = len(pairs)
    nonweb = any(native(a) for (_, _, a) in ok)
    clipped = sum(m.get("clipped", 0) for m in pairs)
    one_sided = sum(1 for m in pairs if m.get("seenBy") == "one")
    coverage_errors = (links or {}).get("coverageErrors", 0)
    if not n:
        return {"coverage": None, "measured": 0, "na": na, "missing": None, "webOnly": None, "nonWeb": nonweb,
                "clipped": 0, "oneSided": 0, "coverageErrors": coverage_errors, "causes": []}
    web = [m["coverage"] for m in pairs if not native(m["a"]) and not native(m["b"])]
    causes = collections.OrderedDict()
    each = 100 / n

    def book(cause, pct, label, item):
        c = causes.setdefault(cause, {"cause": cause, "pct": 0.0, "pairs": [], "items": []})
        c["pct"] += pct
        if label not in c["pairs"]:
            c["pairs"].append(label)
        c["items"].append(item)

    for m in pairs:
        r, a, b, cov = m["round"], m["a"], m["b"], m["coverage"]
        missing = 1 - cov
        if missing <= 0:
            continue
        label = f"{name(r, a)} - {name(r, b)} round {r} ({cov * 100:.0f}%)"
        rd = rounds.get(r) or {}
        ps, pe = rd.get("playStart"), rd.get("playEnd")
        window = (pe - ps) / 1000 if ps is not None and pe is not None and pe > ps else None
        lost = lambda share: round(share * window, 1) if window else None  # seconds of this pair-round, as the note shows them
        item = {"round": r, "native": native(a) or native(b), "cov": round(cov, 4), "lostS": lost(missing)}
        cause, share = "Other", missing
        if native(a) or native(b):
            cause = "Native players"
        elif window:
            lo, hi = rd.get("start", ps), rd.get("end", pe)
            views = {x: timeline.get((x, y), []) for x, y in ((a, b), (b, a))}
            connects = [_first_connected(sg, ps, pe) for sg in views.values() if sg]
            logged = {p["account"] for p in (links or {}).get("players", []) if p.get("hasLog")}
            # A missing view in one diagnostic log does not prove that player was
            # absent when the pair's video metric is positive and the peer's log
            # does show the round. That is only a log gap. Absence is supported
            # when the metric says there was no video, or neither log saw the
            # round.
            unseen = [x for x in (a, b) if x in logged and _first_seen(views[x], lo, hi) is None]
            both_logs_empty = all(x in logged and _first_seen(views[x], lo, hi) is None for x in (a, b))
            absent = unseen if cov <= 0 or both_logs_empty else []
            if absent:
                who = absent[0]
                later = [sg["from"] for (v, _), sgs in timeline.items() if v == who for sg in sgs if sg["from"] >= hi]
                back = min(later) if later else None
                cause, started = _session_cause(pull_players.get(who), ps, back if back is not None else hi,
                                                events.get(who), lo, hi, game)
                cause = cause or "Late open"
                item.update(who=who, absentRound=True, silent=True, cameraMs=_camera_ms(pull_players.get(who)))
                if back is not None:
                    later_round = None
                    for rr in sorted(rounds.values(), key=lambda x: x["round"]):
                        start = rr.get("start") if rr.get("start") is not None else rr.get("playStart")
                        end = rr.get("end") if rr.get("end") is not None else rr.get("playEnd")
                        if rr["round"] > r and start is not None and end is not None and start <= back < end:
                            later_round = rr["round"]
                            break
                    if later_round is not None:
                        item["seenAgainRound"] = later_round
                if cause == "Page reloaded mid-round":
                    item["reloadS"] = round((started - ps) / 1000, 1)
                    all_lives = page_lives(pull_players.get(who), game)
                    round_window = (datetime.datetime.fromtimestamp(lo / 1000, datetime.timezone.utc),
                                    datetime.datetime.fromtimestamp(hi / 1000, datetime.timezone.utc))
                    lives, _ = page_lives_in_window(all_lives, round_window)
                    if lives:
                        item.update(pageLives=len(lives), pageEndings=[life["end"] for life in lives])
                label += f", {name(r, who)} missed the round"
            elif unseen:
                cause = "Log gap, cause unknown"
                item["logGapSides"] = len(unseen)
            elif cov <= 0:
                cause = "Link never came up"  # both present from the start, the pair never had video inside play
                late = [(x, _first_seen(sg, lo, hi)) for x, sg in views.items() if sg]
                late = [(x, t) for x, t in late if t is not None and t > ps]
                if late:  # one side only arrived after play started: the link had no time to carry video
                    who, seen = max(late, key=lambda x: x[1])
                    found, started = _session_cause(pull_players.get(who), ps, seen, events.get(who), lo, hi, game)
                    cause = found or "Late open"
                    item.update(who=who, backS=round((seen - ps) / 1000, 1), silent=True, cameraMs=_camera_ms(pull_players.get(who)))
                    if found == "Page reloaded mid-round":
                        item["reloadS"] = round((started - ps) / 1000, 1)
            elif connects and all(c is not None for c in connects):  # connected late: setup or a late player
                connected = max(connects)
                late = [(x, _first_seen(sg, lo, hi)) for x, sg in views.items() if sg]
                late = [(x, t) for x, t in late if t is not None and t > ps]
                setup = f"Round {r} link setup"
                cause = setup
                item["connectS"] = round((connected - ps) / 1000, 1)
                if late:
                    who, seen = max(late, key=lambda x: x[1])
                    found, started = _session_cause(pull_players.get(who), ps, connected, events.get(who), lo, hi, game)
                    cause = found or setup
                    if found:
                        item.update(who=who, backS=round((seen - ps) / 1000, 1), silent=True, cameraMs=_camera_ms(pull_players.get(who)))
                        if found == "Page reloaded mid-round":
                            item["reloadS"] = round((started - ps) / 1000, 1)
                            all_lives = page_lives(pull_players.get(who), game)
                            round_window = (datetime.datetime.fromtimestamp(lo / 1000, datetime.timezone.utc),
                                            datetime.datetime.fromtimestamp(hi / 1000, datetime.timezone.utc))
                            lives, _ = page_lives_in_window(all_lives, round_window)
                            if lives:
                                item.update(pageLives=len(lives), pageEndings=[life["end"] for life in lives])
                    label += f", {name(r, who)} silent"
                share = min(missing, (connected - ps) / (pe - ps))
        # each cause quotes only the seconds it was charged: a pair that
        # connected late AND dropped later splits its loss between two causes
        if window and cause != "Other" and share * window < 0.05:
            share = 0.0  # under a twentieth of a second is no setup loss: the pair goes to Other alone
        if share > 1e-9:
            book(cause, share * each, label, {**item, "lostS": lost(share)})
        rest = missing - share
        if rest > 1e-9:
            # compared rounded, as the note shows it (9.999999999999998 s is 10 s)
            kind = "Lost after the link came up" if window and lost(rest) >= UNSTABLE_LINK_S else "Other"
            book(kind, rest * each, label, {**item, "lostS": lost(rest)})
    out = [{**c, "pct": round(c["pct"], 2)} for c in causes.values() if c["pct"] > 1e-9]
    out.sort(key=lambda c: -c["pct"])
    return {"coverage": round(sum(m["coverage"] for m in pairs) / n * 100, 1), "measured": n, "na": na,
            "missing": round(sum(c["pct"] for c in causes.values()), 2),
            "webOnly": round(sum(web) / len(web) * 100, 1) if web else None, "nonWeb": nonweb,
            "clipped": clipped, "oneSided": one_sided, "coverageErrors": coverage_errors, "causes": out}


_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]


def _num(n, cap=False):
    """A count in words up to ten, digits above; cap capitalises it for the start of a sentence."""
    s = _WORDS[n] if 0 <= n < len(_WORDS) else str(n)
    return s[0].upper() + s[1:] if cap else s


_INTROS = {
    "Late open": "opened the app late",
    "App in the background": "had the app in the background",
    "Page reloaded mid-round": "reloaded the page mid-round",
    "Unknown, no telemetry": "came in late, with no telemetry to tell why",
}


def _player_sentence(cause, items):
    """One short intro for a cause tied to players: how many, never who. The rounds, times and losses stay in the items."""
    n = len({i.get("who") for i in items})
    intro = _INTROS[cause]
    sentence = f"One player {intro}" if n == 1 else f"{_num(n, True)} players {intro}"
    if cause == "Page reloaded mid-round":
        lives = [i.get("pageLives") for i in items if i.get("pageLives")]
        if lives:
            count = max(lives)
            detail = f"{_num(count)} page {'life' if count == 1 else 'lives'}"
            sentence += f" ({detail if n == 1 else 'up to ' + detail})"
    return sentence + "."


def _cause_sentence(cause, items):
    """One short factual sentence (or two) for a cause, from its items. No names, no account ids."""
    k = len(items)
    pairs = f"{_num(k)} pair-round{'s' if k != 1 else ''}"
    if cause == "Native players":
        w2n = k and all(i.get("native") for i in items)
        full = all(i.get("cov", 0) <= 0 for i in items)
        head = f"The {k} web-to-native pair-round{'s' if k != 1 else ''}" if w2n else f"The {k} pair-round{'s' if k != 1 else ''} with a native player"
        return head + (" had no video." if full else " had little video.")
    if cause in ("App in the background", "Late open", "Page reloaded mid-round", "Unknown, no telemetry"):
        return _player_sentence(cause, items)
    if cause == "Link never came up":
        return f"{_num(k, True)} pair-round{'s' if k != 1 else ''} never had video, though both players were in the round."
    if cause == "Log gap, cause unknown":
        return f"{_num(k, True)} pair-round{'s' if k != 1 else ''} had positive video coverage but a one-sided diagnostic-log gap, so the loss cause is unknown."
    if cause.endswith("link setup"):
        return f"{_num(k, True)} pair{'s' if k != 1 else ''} lost time at the start of the round."
    if cause == "Lost after the link came up":
        return f"{_num(k, True)} pair-round{'s' if k != 1 else ''} lost video after {'its' if k == 1 else 'their'} link first came up."
    # Other
    return f"Short drops and round edges across {pairs}."


def _tenths(values, target):
    """Round non-negative values to 0.1 so that they add up to target (also to 0.1): floors, then the largest remainders."""
    t = round(target * 10)
    floors = [int(v * 10 + 1e-9) for v in values]
    rem = sorted(range(len(values)), key=lambda i: -(values[i] * 10 - floors[i]))
    for i in rem[: max(0, t - sum(floors))]:
        floors[i] += 1
    return [f / 10 for f in floors]


def coverage_note(breakdown, web_only_pct):
    """The text under the page's video coverage box: where the missing share goes, one line per cause, by size with Other
    last, the causes adding up to the missing share to 0.1 %. No names. Ends with the web-only coverage when a native or
    other non-web player took part (n/a when no two web players shared a pair), else with nothing. Returns None when there is no coverage to explain."""
    b = breakdown or {}
    if b.get("coverage") is None:
        errors = b.get("coverageErrors", 0)
        return f"Video coverage is n/a: the coverage query failed for {_num(errors)} viewer{'s' if errors != 1 else ''}." if errors else None
    lines = [f"Where the missing {100 - round(b['coverage'])} % goes across pair-rounds where both players joined:", ""]
    causes = [dict(c, items=list(c.get("items", []))) for c in b.get("causes", [])]
    vals = _tenths([c["pct"] for c in causes], sum(c["pct"] for c in causes))
    keep = []
    for c, v in zip(causes, vals):
        c["v"] = v
        if v > 0:
            keep.append(c)
        else:  # rounds to 0.0 %: fold into Other so nothing is shown as 0.0
            other = next((x for x in causes if x["cause"] == "Other"), None)
            if other is None:
                other = {"cause": "Other", "pct": 0.0, "items": [], "v": 0.0}
                keep.append(other)
                causes.append(other)
            other["items"] += c["items"]
    keep.sort(key=lambda c: (c["cause"] == "Other", -c["v"]))
    for c in keep:
        if c["v"] > 0:
            label = "Video dropped after it came up" if c["cause"] == "Lost after the link came up" else c["cause"]
            lines.append(f"- {label}: {c['v']:.1f} %. {_cause_sentence(c['cause'], c['items'])}")
    clipped = b.get("clipped", 0)
    if clipped:
        lines.append(f"Telemetry at round edges was clipped for {_num(clipped)} viewer-round{'s' if clipped != 1 else ''}.")
    one_sided = b.get("oneSided", 0)
    if one_sided:
        lines.append(f"{_num(one_sided, True)} pair-round{'s' if one_sided != 1 else ''} used one direction because the other sent no coverage metrics.")
    errors = b.get("coverageErrors", 0)
    if errors:
        lines.append(f"The coverage query failed for {_num(errors)} viewer{'s' if errors != 1 else ''}; those directions are unavailable.")
    nonweb = b["nonWeb"] if "nonWeb" in b else any(c["cause"] == "Native players" for c in causes)
    if nonweb:
        lines.append("Between web players alone: " + (f"{round(web_only_pct)} %." if web_only_pct is not None else "n/a."))
    return "\n".join(lines)




def failure_groups(players_pull, names):
    """Failure and info events grouped by title (host request ids and numbers squashed)."""
    g = collections.defaultdict(lambda: {"count": 0, "accounts": set(), "times": []})
    for acct, p in players_pull.items():
        for e in p.get("events", []):
            if e["title"] == "game-log":
                continue
            title = re.sub(r"host:\d+ \(wire[^)]*\)", "host:N", e["title"])
            title = re.sub(r"\b\d{3,}\b", "N", title)[:90]
            row = g[(e["level"], title)]
            row["count"] += 1
            row["accounts"].add(acct)
            row["times"].append(e["timestamp"])
    out = []
    for (level, title), row in sorted(g.items(), key=lambda kv: (-kv[1]["count"], kv[0][1])):
        ts = sorted(row["times"])
        out.append({"title": title, "level": level, "count": row["count"],
                    "players": sorted(names.get(a) or SHORT(a) for a in row["accounts"]),
                    "first": cest(parse_ts(ts[0]), True), "last": cest(parse_ts(ts[-1]), True)})
    return out


def video_block(players_pull, names):
    """Worst across players and peers, except rttP50 and outKbps (medians), as in references/game-report.md."""
    by = collections.defaultdict(list)  # (metric name, stat) -> [(account, row)]
    for a, p in players_pull.items():
        for m in p.get("metrics", []):
            by[(m.get("metric.name"), m.get("stat"))].append((a, m))

    def vals(name, stat, key):
        return [(a, fnum(m.get(key))) for a, m in by.get((name, stat), []) if fnum(m.get(key)) is not None]

    def worst(name, stat, pick):
        """The highest (pick='max', from each row's max) or lowest (pick='min', from each row's p50) value."""
        v = [x for _, x in vals(name, stat, "max(value)" if pick == "max" else "p50(value)")]
        return (max(v) if pick == "max" else min(v)) if v else None

    def worst_row(name, stat, field="max(value)"):
        rows = [(a, m, fnum(m.get(field))) for a, m in by.get((name, stat), [])]
        return max((row for row in rows if row[2] is not None), key=lambda row: row[2], default=None)

    def pair_round(row, directed=False):
        if not row:
            return None
        account, metric, _ = row
        rnd, peer_tag = metric.get("round") or metric.get("rtc.round"), metric.get("rtc.peer")
        candidates = [metric] + [pair for pair in players_pull.get(account, {}).get("linkPairs", [])
                                 if str(pair.get("round")) == str(rnd)
                                 and str(pair.get("rtc.peer")) == str(peer_tag)]
        peer = None
        for candidate in candidates:
            ends = _pair_ends(candidate.get("rtc.pair"))
            if ends and account in ends:
                peer = next((end for end in ends if end != account), None)
                if peer:
                    break
        peer = peer or peer_tag
        label = lambda value: names.get(value) or value or "unknown"
        left, right = label(account), label(peer)
        pair = f"{left} receiving {right}" if directed else " ↔ ".join(sorted((left, right)))
        return {"account": account, "peer": peer, "round": int(rnd) if str(rnd).isdigit() else rnd,
                "path": metric.get("rtc.path"), "label": f"{pair}, round {rnd or 'n/a'}"}

    paths = collections.Counter(m.get("rtc.path") or "unknown" for _, m in by.get(("rtc.rtt_ms", "p50"), []))
    freeze = [x for _, x in vals("rtc.freeze_ms", "total", "max(value)")]
    limited = collections.defaultdict(lambda: collections.defaultdict(float))
    for a, m in by.get(("rtc.quality_limited_s", None), []) + by.get(("rtc.quality_limited_s", "total"), []):
        limited[m.get("reason") or "?"][a] += fnum(m.get("sum(value)")) or 0
    lim = []
    limited_senders = []
    for reason, per in sorted(limited.items()):
        top = sorted(per.items(), key=lambda kv: -kv[1])
        lim.append(f"{reason}: " + ", ".join(f"{names.get(a) or SHORT(a)} {round(s)} s" for a, s in top if s > 0))
        limited_senders += [{"reason": reason, "account": a, "name": names.get(a) or SHORT(a), "seconds": round(s)} for a, s in top if s > 0]
    # loss p95 alone reads as "the pair lost 99 %" when the link was clean while up (game 216), so the typical loss
    # goes beside it: the median p50, and the p50 of the pair-round holding the worst p95 (same grouping key)
    key = lambda a, m: (a, m.get("round"), m.get("rtc.peer"), m.get("rtc.path"), m.get("lowpower"))
    series = lambda stat, field: [(key(a, m), v) for a, m in by.get(("rtc.loss_pct", stat), []) if (v := fnum(m.get(field))) is not None]
    loss50, loss95 = series("p50", "p50(value)"), series("p95", "max(value)")
    worst_loss = max(loss95, key=lambda kv: kv[1]) if loss95 else None
    worst_p50 = [v for k, v in loss50 if k == worst_loss[0]] if worst_loss else []
    rtt50 = [x for _, x in vals("rtc.rtt_ms", "p50", "p50(value)")]
    kbps = [x for _, x in vals("rtc.out_kbps", "p50", "p50(value)")]
    # signalling round trip through the statement store (offer posted to answer received); emitted without a stat tag
    # an offer to a peer who was not there yet (rtc.signal_peer_present "false", #370) measures the peer's absence, not
    # the store: left out. Rows from builds before #374 carry no flag and count.
    present = [m for _, m in by.get(("rtc.signal_rtt_ms", None), []) if m.get("rtc.signal_peer_present") != "false"]
    sig50 = [v for v in (fnum(m.get("p50(value)")) for m in present) if v is not None]
    sigmax = [v for v in (fnum(m.get("max(value)")) for m in present) if v is not None]
    worst_loss_rows = [(a, m, v) for a, m in by.get(("rtc.loss_pct", "p95"), [])
                       if worst_loss and key(a, m) == worst_loss[0] and (v := fnum(m.get("max(value)"))) is not None]
    worst_loss_row = max(worst_loss_rows, key=lambda row: row[2], default=None)
    worst_rtt_row = worst_row("rtc.rtt_ms", "p95")
    worst_freeze_row = worst_row("rtc.freeze_ms", "total")
    return {"rttP50": round(median(rtt50)) if rtt50 else None, "rttP95": round(worst("rtc.rtt_ms", "p95", "max")) if rtt50 else None,
            "lossP95": f1(worst("rtc.loss_pct", "p95", "max")),
            "lossP50": f1(median([v for _, v in loss50])) if loss50 else None,
            "lossWorstPairP50": f1(median(worst_p50)) if worst_p50 else None,
            "jitterP95": f1(worst("rtc.jitter_ms", "p95", "max")),
            "inFps": f1(worst("rtc.in_fps", "p50", "min")), "outFps": f1(worst("rtc.out_fps", "p50", "min")),
            "inHeight": f1(worst("rtc.in_height", "p50", "min")), "outHeight": f1(worst("rtc.out_height", "p50", "min")),
            "outKbps": round(median(kbps)) if kbps else None,
            "freezeMs": round(max(freeze)) if freeze else None,
            "worstRtt": pair_round(worst_rtt_row), "worstLoss": pair_round(worst_loss_row),
            "worstFreeze": pair_round(worst_freeze_row, directed=True),
            "path": ", ".join(f"{k} {v}" for k, v in paths.most_common()) + " (peer-round samples)" if paths else None,
            "pathCounts": dict(paths), "connectionSamples": sum(paths.values()),
            "limited": "; ".join(lim) or None, "limitedSenders": limited_senders,
            "signalP50": round(median(sig50)) if sig50 else None, "signalMax": round(max(sigmax)) if sigmax else None}


def _replay_observation(entry):
    """The versioned replay payload carried by a saved game-log line."""
    if entry.get("tag") != "replay":
        return None, {}
    data = entry.get("data") or {}
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except (TypeError, ValueError):
            return None, {}
    return entry.get("message"), data.get("observation") or {}


def _pick(row, keys):
    return next((row.get(key) for key in keys if row.get(key) is not None), None)


def _report_round(at, windows):
    """The 1-based chain round nearest a saved wall-clock line.

    Signalling can happen in the handover/gap rather than inside play. Boundaries
    therefore split the gap between adjacent chain windows. The one-minute outer
    guard rejects unrelated setup/after-game lines without assuming synced phones.
    """
    if at is None or not windows:
        return None
    starts = [fnum(window[0]) for window in windows]
    ends = [fnum(window[1]) for window in windows]
    if any(value is None for value in starts + ends):
        return None
    if at < starts[0] - 60_000 or at > ends[-1] + 60_000:
        return None
    for index in range(len(windows) - 1):
        if at < (ends[index] + starts[index + 1]) / 2:
            return index + 1
    return len(windows)


def _correlation(entry):
    data = entry.get("data") or {}
    if not isinstance(data, dict):
        data = {}
    message = str(entry.get("message") or "")
    sid = _pick(data, ("sid", "sessionId", "rtc.sid"))
    gen = _pick(data, ("gen", "generation", "rtc.gen"))
    if sid is None and (match := re.search(r"\bsid[=: ]([^ )]+)", message)):
        sid = match.group(1)
    if gen is None and (match := re.search(r"\b(?:gen|generation)[=: ]([^ )]+)", message)):
        gen = match.group(1)
    return (str(sid) if sid is not None else None, str(gen) if gen is not None else None)


def _pair_saved_events(sent, received):
    """One-to-one matches, exact sid/gen first and conservative ordinal fallback.

    Old exported RTC lines do not expose statement payloads. When both sides kept
    the same number of records, chronological order is the sole unambiguous match.
    Unequal unlabelled streams are intentionally rejected rather than inventing an
    offset from potentially shifted messages.
    """
    pairs, used_sent, used_received = [], set(), set()
    by_id = collections.defaultdict(list)
    for index, event in enumerate(received):
        if any(event["correlation"]):
            by_id[event["correlation"]].append(index)
    for index, event in enumerate(sent):
        if not any(event["correlation"]):
            continue
        candidates = [other for other in by_id.get(event["correlation"], []) if other not in used_received]
        if len(candidates) == 1:
            other = candidates[0]
            pairs.append((event, received[other]))
            used_sent.add(index)
            used_received.add(other)
    remaining_sent = [event for index, event in enumerate(sent) if index not in used_sent]
    remaining_received = [event for index, event in enumerate(received) if index not in used_received]
    if len(remaining_sent) == len(remaining_received):
        pairs.extend(zip(remaining_sent, remaining_received))
    return pairs


def _rtc_log_signal_samples(logs, windows):
    """Cross-phone deltas from retained sender/receiver RTC log lines."""
    events = collections.defaultdict(lambda: {"send": [], "receive": []})
    outgoing = re.compile(r"\[jollity-rtc\] → (?:(lane) )?(offer|answer) to (\S+)")
    incoming = re.compile(r"\[jollity-rtc\] ← signal from (\S+) (offer|answer)")
    lane_answer = re.compile(r"\[jollity-rtc\] lane answer from (\S+)")
    for owner, log in logs.items():
        current_round = None
        for entry in sorted(log.get("entries", []), key=lambda row: fnum(row.get("ts")) or 0):
            message, data = str(entry.get("message") or ""), entry.get("data") or {}
            if message == "mesh opening" and isinstance(data, dict) and str(data.get("round")).lstrip("-").isdigit():
                current_round = int(data["round"]) + 1
            elif match := re.search(r"\[jollity-rtc\] round-link .*\bround=(\d+)", message):
                current_round = int(match.group(1))
            at = fnum(entry.get("ts"))
            # A saved mesh generation owns its signalling even when the handover
            # starts before the next chain play window. Wall time is only the
            # fallback for reduced/older captures without an explicit mesh open.
            rnd = current_round or _report_round(at, windows)
            if rnd is None or at is None:
                continue
            correlation = _correlation(entry)
            if match := outgoing.search(message):
                lane, kind, peer = match.groups()
                key = (rnd, owner, peer, ("lane-" if lane else "statement-") + kind)
                events[key]["send"].append({"at": at, "correlation": correlation})
                # The lane protocol has no separate "offer received" log. Sending
                # its answer is the retained receiver-side proof that the offer
                # arrived, so the same line closes the opposite lane-offer sample.
                if lane and kind == "answer":
                    key = (rnd, peer, owner, "lane-offer")
                    events[key]["receive"].append({"at": at, "correlation": correlation})
            elif match := incoming.search(message):
                peer, kind = match.groups()
                key = (rnd, peer, owner, "statement-" + kind)
                events[key]["receive"].append({"at": at, "correlation": correlation})
            elif match := lane_answer.search(message):
                peer = match.group(1)
                key = (rnd, peer, owner, "lane-answer")
                events[key]["receive"].append({"at": at, "correlation": correlation})
    out = collections.defaultdict(list)
    for (rnd, sender, receiver, _), sides in events.items():
        for sent, received in _pair_saved_events(sides["send"], sides["receive"]):
            out[(rnd, sender, receiver)].append(received["at"] - sent["at"])
    return out


def _rtcp_clock_records(logs):
    """Saved RTCP aggregate views keyed by (round, local phone, remote phone).

    Kept deliberately separate from signalling so a later capture source can be
    added without changing the group solve. Both replay and its human dev-log
    twin are accepted and then de-duplicated.
    """
    out, availability, seen = collections.defaultdict(list), collections.defaultdict(lambda: {"records": 0, "sampleCount": 0}), set()
    for owner, log in logs.items():
        for entry in log.get("entries", []):
            kind, obs = _replay_observation(entry)
            data = entry.get("data") or {}
            if not obs and isinstance(data, dict):
                obs = data
            peer = _pick(obs, ("peerId", "peer", "remoteId")) if isinstance(obs, dict) else None
            offset = fnum(_pick(obs, ("medianOffsetMs", "offsetMs", "clockOffsetMs"))) if isinstance(obs, dict) else None
            samples = fnum(_pick(obs, ("samples", "sampleCount", "n"))) if isinstance(obs, dict) else None
            source = str(_pick(obs, ("source", "clockSource")) or "") if isinstance(obs, dict) else ""
            if (kind not in ("rtcp-clock-offset", "rtc-clock-offset", "clock-agreement", "clock-offset")
                    and "remote-outbound" not in source):
                continue
            raw_round = _pick(obs, ("round", "roundIndex"))
            if not peer or not str(raw_round).lstrip("-").isdigit():
                continue
            # App round fields are 0-based, matching useMesh's roundRef.
            rnd = int(raw_round) + 1
            count = max(0, int(samples if samples is not None else 1))
            status = str(obs.get("status") or ("ok" if offset is not None else "unavailable"))
            reason = str(obs.get("reason") or "") or None
            browser = str(obs.get("browserBuild") or "unknown")
            host = str(obs.get("hostBuild") or "unknown")
            fingerprint = (owner, peer, rnd, obs.get("meshGeneration"), obs.get("link"),
                           status, reason, round(offset, 3) if offset is not None else None, count)
            if fingerprint in seen:
                continue
            seen.add(fingerprint)
            bucket = availability[(owner, browser, host, status, reason)]
            bucket["records"] += 1
            bucket["sampleCount"] += count
            if status == "ok" and offset is not None and count >= 3:
                out[(rnd, owner, peer)].append({"offsetMs": offset, "samples": count})
    return out, availability


def _least_squares_offsets(members, estimates):
    """Solve x_b-x_a=o_ab with the first member fixed at zero."""
    members = list(members)
    if len(members) < 2 or not estimates:
        return None
    index = {account: i for i, account in enumerate(members[1:])}
    n = len(index)
    matrix, rhs = [[0.0] * n for _ in range(n)], [0.0] * n
    for a, b, offset in estimates:
        coeff = {}
        if a in index: coeff[index[a]] = -1.0
        if b in index: coeff[index[b]] = 1.0
        for i, ci in coeff.items():
            rhs[i] += ci * offset
            for j, cj in coeff.items(): matrix[i][j] += ci * cj
    for col in range(n):
        pivot = max(range(col, n), key=lambda row: abs(matrix[row][col]))
        if abs(matrix[pivot][col]) < 1e-9:
            return None
        matrix[col], matrix[pivot] = matrix[pivot], matrix[col]
        rhs[col], rhs[pivot] = rhs[pivot], rhs[col]
        scale = matrix[col][col]
        matrix[col] = [value / scale for value in matrix[col]]
        rhs[col] /= scale
        for row in range(n):
            if row == col: continue
            scale = matrix[row][col]
            matrix[row] = [value - scale * pivot_value for value, pivot_value in zip(matrix[row], matrix[col])]
            rhs[row] -= scale * rhs[col]
    raw = {members[0]: 0.0, **{account: rhs[i] for account, i in index.items()}}
    centre = statistics.median(raw.values())
    return {account: value - centre for account, value in raw.items()}


def _largest_connected_component(members, estimates):
    """The largest member-ordered component touched by qualified pair estimates."""
    adjacent = collections.defaultdict(set)
    for a, b, _ in estimates:
        adjacent[a].add(b)
        adjacent[b].add(a)
    seen, best = set(), []
    for root in members:
        if root in seen or root not in adjacent:
            continue
        stack, component = [root], set()
        while stack:
            account = stack.pop()
            if account in component:
                continue
            component.add(account)
            stack.extend(adjacent[account] - component)
        seen.update(component)
        ordered = [account for account in members if account in component]
        if len(ordered) > len(best):
            best = ordered
    return best


def clock_agreement(groups, logs, names, windows=None):
    signalling = _rtc_log_signal_samples(logs, windows)
    rtcp, rtcp_availability = _rtcp_clock_records(logs)
    rows = []
    for group in groups or []:
        rnd, gid = group.get("round"), group.get("group")
        members = [row["account"] for row in group.get("members", [])]
        pairs, estimates = [], []
        for i, a in enumerate(members):
            for b in members[i + 1:]:
                ab, ba = signalling.get((rnd, a, b), []), signalling.get((rnd, b, a), [])
                pair = {"a": a, "b": b, "aName": names.get(a) or SHORT(a), "bName": names.get(b) or SHORT(b),
                        "samplesAB": len(ab), "samplesBA": len(ba), "medianDeltaABMs": None, "medianDeltaBAMs": None,
                        "offsetMs": None, "uncertaintyMs": None, "source": None}
                views_a, views_b = rtcp.get((rnd, a, b), []), rtcp.get((rnd, b, a), [])
                rtcp_samples_a = sum(row["samples"] for row in views_a)
                rtcp_samples_b = sum(row["samples"] for row in views_b)
                if views_a and views_b and rtcp_samples_a >= 5 and rtcp_samples_b >= 5:
                    # A's saved view is A-B, B's is B-A. The solver consumes B-A.
                    a_view = statistics.median(row["offsetMs"] for row in views_a)
                    b_view = statistics.median(row["offsetMs"] for row in views_b)
                    pair.update(samplesAB=rtcp_samples_a, samplesBA=rtcp_samples_b,
                                medianDeltaABMs=round(a_view, 1), medianDeltaBAMs=round(b_view, 1),
                                offsetMs=round(statistics.median((-a_view, b_view)), 1),
                                uncertaintyMs=round(abs(a_view + b_view), 1), source="rtcp", confidence="standard")
                    estimates.append((a, b, pair["offsetMs"]))
                elif len(ab) >= 4 and len(ba) >= 4:
                    med_ab, med_ba = statistics.median(ab), statistics.median(ba)
                    pair.update(medianDeltaABMs=round(med_ab, 1), medianDeltaBAMs=round(med_ba, 1),
                                offsetMs=round((med_ab - med_ba) / 2, 1), uncertaintyMs=round((med_ab + med_ba) / 2, 1),
                                source="signalling", confidence=("low" if min(len(ab), len(ba)) < 5 else "standard"))
                    estimates.append((a, b, pair["offsetMs"]))
                pairs.append(pair)
        component = _largest_connected_component(members, estimates)
        used_estimates = [estimate for estimate in estimates if estimate[0] in component and estimate[1] in component]
        offsets = _least_squares_offsets(component, used_estimates)
        for pair in pairs:
            pair["usedForClock"] = bool(pair["offsetMs"] is not None and pair["a"] in component and pair["b"] in component)
        sigma = statistics.pstdev(offsets.values()) if offsets and len(offsets) > 1 else None
        centre = statistics.median(offsets.values()) if offsets else None
        furthest = max(offsets, key=lambda account: abs(offsets[account] - centre)) if offsets else None
        rows.append({"round": rnd, "group": gid, "members": len(members), "phonesUsed": len(component), "pairs": pairs,
                     "offsetsMs": ({account: round(value, 1) for account, value in offsets.items()} if offsets else None),
                     "sigmaMs": round(sigma, 1) if sigma is not None else None,
                     "spreadMs": round(max(offsets.values()) - min(offsets.values()), 1) if offsets else None,
                     "furthest": ({"account": furthest, "name": names.get(furthest) or SHORT(furthest),
                                    "byMs": round(offsets[furthest] - centre, 1)} if furthest else None),
                     "qualifiedPairs": len(estimates), "totalPairs": len(pairs),
                     "lowConfidence": any(pair.get("usedForClock") and pair.get("confidence") == "low" for pair in pairs)})
    sigmas = [row["sigmaMs"] for row in rows if row["sigmaMs"] is not None]
    availability = [
        {"account": owner, "name": names.get(owner) or SHORT(owner), "browserBuild": browser,
         "hostBuild": host, "status": status, "reason": reason, **counts}
        for (owner, browser, host, status, reason), counts in sorted(rtcp_availability.items())
    ]
    return {"groups": rows, "medianSigmaMs": round(statistics.median(sigmas), 1) if sigmas else None,
            "worstSigmaMs": round(max(sigmas), 1) if sigmas else None, "rtcpAvailability": availability}


# THE UPLOAD LADDER (apps/jollity-app/lib/webrtc/send-adaptation-classifier.ts VIDEO_RUNGS): each phone steps its upload down this ladder when
# its upload bandwidth runs short, and the browser's encoder can lower size or frame rate further on its own
LADDER = [{"rung": "full", "kbps": 300, "fps": 24, "height": 360},
          {"rung": "lean", "kbps": 220, "fps": 24, "height": 360},
          {"rung": "low", "kbps": 140, "fps": 18, "height": 240},
          {"rung": "minimum", "kbps": 80, "fps": 12, "height": 180},
          {"rung": "survival", "kbps": 45, "fps": 8, "height": 120}]
LADDER_HEIGHTS = (360, 240, 180, 120)
LADDER_FPS = (24, 18, 12, 8)
FPS_TOLERANCE = 1  # a measured median within 1 frame per second of a ladder rate counts as that rate
ADAPTATION_NOTE = ("Each phone's upload adapts on a five-step ladder (full, lean, low, minimum, survival) when its upload bandwidth runs short; "
                   "the browser's encoder can lower size or frame rate further on its own.")
LINK_FAMILIES = {"rtc.in_fps": ("fps", "in"), "rtc.out_fps": ("fps", "out"), "rtc.in_height": ("height", "in"), "rtc.out_height": ("height", "out")}


HASHED_PAIR_RE = re.compile(r"g([^:]+):r(\d+):([0-9a-f]{12})")


def pair_link_hash(game, a, b):
    """The link part of a hashed rtc.pair, as apps/jollity-app/lib/journeys/rtc-pair.ts derives it."""
    low, high = sorted((a, b))
    return hashlib.blake2b(f"jollity.rtc.pair:{game}:{low}:{high}".encode(), digest_size=6).hexdigest()


def expand_pair_ids(data, game, accounts):
    """Rewrite each hashed rtc.pair ('g366:r1:659f4aa57360') in place into the 'g366:r1:A~B' form the readers parse.

    The app sends a hash of the two accounts instead of the accounts, so the roster finds them again. A hash no pair of
    the roster makes stays as it is, and the coverage reader then fails on it. Returns how many ids were rewritten.
    """
    roster = sorted(set(accounts))
    ends = {pair_link_hash(game, a, b): (a, b) for i, a in enumerate(roster) for b in roster[i + 1:]}
    count = 0

    def walk(node):
        nonlocal count
        items = node.items() if isinstance(node, dict) else enumerate(node) if isinstance(node, list) else ()
        for key, value in items:
            if key == "rtc.pair" and isinstance(value, str):
                match = HASHED_PAIR_RE.fullmatch(value)
                if match and match.group(3) in ends:
                    node[key] = f"g{match.group(1)}:r{match.group(2)}:{'~'.join(ends[match.group(3)])}"
                    count += 1
            else:
                walk(value)

    walk(data)
    return count


def _pair_ends(pair):
    """The two accounts of an rtc.pair id ('g254:r1:A~B'), or None."""
    ends = str(pair or "").rsplit(":", 1)[-1].split("~")
    return (ends[0], ends[1]) if len(ends) == 2 and all(ends) else None


FULL_ROUND_SHARE = 0.9


def full_rounds(players_pull, share=FULL_ROUND_SHARE):
    """{(account, round): True when its game.round.N step lasted at least `share` of that round's median step (the phone
    measured the whole round), False when it was shorter}. A phone with no step for the round (its game journey never
    finished) is absent: its measured span is unknown, not short. Each side's p50 is over its OWN round step's 3 s readings, so a phone that reloaded or opened late
    measured a different stretch of the round than its peer (game 254: deedee.08's round 1 lasted 13.6 s after a
    reload, and its links read received above sent)."""
    durations = collections.defaultdict(dict)
    for account, player in players_pull.items():
        for step in player.get("steps", []):
            op = str(step.get("span.op") or "")
            if op.startswith("game.round."):
                rnd, ms = op.rsplit(".", 1)[-1], fnum(step.get("span.duration")) or 0
                durations[rnd][account] = max(durations[rnd].get(account, 0), ms)
    out = {}
    for rnd, per in durations.items():
        typical = median(list(per.values()))
        out.update({(account, rnd): bool(typical and ms >= share * typical) for account, ms in per.items()})
    return out


def link_directions(players_pull, full=None):
    """Sent and received figures of the SAME link direction (one sender to one receiver in one round), joined on rtc.pair,
    which both ends of a link carry (apps/jollity-app/lib/journeys/rtc-pair.ts). Only directions both phones reported are kept, so the
    lowest sent and the lowest received can be compared. Both sides are the same statistic, the median of the round's
    3 s readings, but each over its own phone's round step, and the readings themselves never leave the phone, so the
    two cannot be cut to the stretch both phones measured. Every direction is kept (dropping the partial ones hid the
    worst links, game 254's survival link among them); a direction where one phone measured only part of the round
    (full_rounds) is marked partial, and received-above-sent is counted for whole-round and partial directions apart.
    A direction reported twice keeps its lower value. Returns {"fps": [...], "height": [...], "partial": {kind: n},
    "receivedAboveSent": {kind: {"links", "partialLinks", "maxGap", "maxGapWhole"}}}, each item {"round", "sender",
    "receiver", "sent", "received", "partial"}."""
    seen = {}
    for viewer, player in players_pull.items():
        for row in player.get("linkPairs", []):
            family = LINK_FAMILIES.get(row.get("metric.name"))
            value, ends = fnum(row.get("p50(value)")), _pair_ends(row.get("rtc.pair"))
            if not family or value is None or not ends or viewer not in ends or row.get("stat") not in (None, "p50"):
                continue
            other = ends[1] if ends[0] == viewer else ends[0]
            kind, side = family
            sender, receiver = (viewer, other) if side == "out" else (other, viewer)
            key = (kind, side, str(row.get("round")), sender, receiver)
            seen[key] = min(seen.get(key, value), value)
    out = {"fps": [], "height": [], "partial": {"fps": 0, "height": 0}, "spanUnknown": {"fps": 0, "height": 0}}
    for (kind, side, rnd, sender, receiver), sent in sorted(seen.items()):
        if side != "out":
            continue
        received = seen.get((kind, "in", rnd, sender, receiver))
        if received is None:
            continue
        # no round steps at all (full empty or None): nothing is flagged; a phone with no step for the round: span unknown
        sides = [full.get((sender, rnd)), full.get((receiver, rnd))] if full else [True, True]
        partial = False in sides
        unknown = not partial and None in sides
        out["partial"][kind] += partial
        out["spanUnknown"][kind] += unknown
        out[kind].append({"round": rnd, "sender": sender, "receiver": receiver, "sent": sent, "received": received, "partial": partial,
                          **({"spanUnknown": True} if unknown else {})})
    out["receivedAboveSent"] = {}
    for kind in ("fps", "height"):
        above = [d for d in out[kind] if d["received"] > d["sent"]]
        out["receivedAboveSent"][kind] = {"links": len(above), "partialLinks": sum(1 for d in above if d["partial"]),
                                          "maxGap": max((d["received"] - d["sent"] for d in above), default=0),
                                          "maxGapWhole": max((d["received"] - d["sent"] for d in above if not d["partial"]), default=0)}
    return out


def off_ladder_reason(value, standards, unit):
    """Why a value is off the ladder. A picture height at a ladder height over the square root of 2 is libwebrtc's own
    bandwidth downscale, which halves the pixel count (game 254: 254 px = 360 / 1.41, sent by three iPhones while their
    ladder step was full or lean, that is 360 px)."""
    if unit == "px":
        for standard in standards:
            if abs(value - standard / 2 ** 0.5) <= 2:
                return f"the browser's own downscale of {standard}, half the pixels; not a ladder step"
    return "not a ladder value"


def ladder_distribution(values, standards, unit, tolerance=0):
    """Counts at each ladder value (largest first); a value off the ladder gets a bucket of its own, labelled as such."""
    counts, other = collections.Counter(), collections.Counter()
    for value in values:
        hit = next((s for s in standards if abs(value - s) <= tolerance), None)
        if hit is None:
            other[round(value)] += 1
        else:
            counts[hit] += 1
    buckets = [{"label": f"{s} {unit}", "value": s, "count": counts[s]} for s in standards if counts[s]]
    buckets += [{"label": f"{v} {unit} ({off_ladder_reason(v, standards, unit)})", "value": v, "count": n, "offLadder": True} for v, n in other.items()]
    return {"samples": len(values), "buckets": sorted(buckets, key=lambda row: -row["value"])}


def _percentile(values, q):
    """Nearest-rank percentile, q in 0..1."""
    xs = sorted(values)
    if not xs:
        return None
    return xs[max(0, min(len(xs) - 1, -(-int(round(q * 100)) * len(xs) // 100) - 1))]


def quality_row(metric, unit, values, worst, better, stat, samples_label):
    """One row of the video quality table. P75 and P95 are the values 75 % and 95 % of the samples were at least as good
    as: the high tail when lower is better, the low tail when higher is better. Worst is given, so it can be the same
    figure the summary quotes."""
    values = [v for v in values if v is not None]
    tail = (lambda q: _percentile(values, q)) if better == "lower" else (lambda q: _percentile(values, 1 - q))
    pick = lambda v: None if v is None else (round(v) if abs(v) >= 100 or float(v).is_integer() else f1(v))
    return {"metric": metric, "unit": unit, "better": better, "stat": stat, "samples": len(values), "samplesLabel": samples_label,
            "p50": pick(_percentile(values, 0.5)), "p75": pick(tail(0.75)), "p95": pick(tail(0.95)),
            "worst": pick(worst) if values else None}


def video_table(players_pull, video, directions):
    """The Video quality table: one row per metric, P50 / P75 / P95 / Worst over pair-rounds (each pair-round's median),
    with Worst the figure the summary quotes (the worst moments for round-trip time, loss and jitter)."""
    by = collections.defaultdict(list)
    for p in players_pull.values():
        for m in p.get("metrics", []):
            by[(m.get("metric.name"), m.get("stat"))].append(m)
    p50 = lambda name: [fnum(m.get("p50(value)")) for m in by.get((name, "p50"), [])]
    present = [m for m in by.get(("rtc.signal_rtt_ms", None), []) if m.get("rtc.signal_peer_present") != "false"]
    pair_rounds = len(by.get(("rtc.rtt_ms", "p50"), []))
    frozen = [(fnum(m.get("max(value)")) or 0) / 1000 for m in by.get(("rtc.freeze_ms", "total"), [])]
    frozen += [0.0] * max(0, pair_rounds - len(frozen))  # a clean round sends no freeze point
    fps, height = directions.get("fps", []), directions.get("height", [])
    both = lambda n: f"{n} link directions both phones reported"
    rows = [
        quality_row("Video round-trip time", "ms", p50("rtc.rtt_ms"), video.get("rttP95"), "lower", "pair-round median; Worst is the worst pair-round's worst moments (95th percentile)", f"{len(p50('rtc.rtt_ms'))} link samples"),
        quality_row("Signalling round trip", "ms", [fnum(m.get("p50(value)")) for m in present], video.get("signalMax"), "lower", "per phone and peer, median; Worst is the slowest single offer", f"{len(present)} phone-peer samples"),
        quality_row("Packets lost", "%", p50("rtc.loss_pct"), video.get("lossP95"), "lower", "pair-round median; Worst is the worst pair-round's worst moments (95th percentile)", f"{len(p50('rtc.loss_pct'))} link samples"),
        quality_row("Jitter", "ms", p50("rtc.jitter_ms"), video.get("jitterP95"), "lower", "pair-round median; Worst is the worst pair-round's worst moments (95th percentile)", f"{len(p50('rtc.jitter_ms'))} link samples"),
        quality_row("Frames per second received", "fps", [d["received"] for d in fps], min((d["received"] for d in fps), default=None), "higher", "link-round median, links seen from both phones", both(len(fps))),
        quality_row("Frames per second sent", "fps", [d["sent"] for d in fps], min((d["sent"] for d in fps), default=None), "higher", "link-round median, links seen from both phones", both(len(fps))),
        quality_row("Picture height received", "px", [d["received"] for d in height], min((d["received"] for d in height), default=None), "higher", "link-round median, links seen from both phones", both(len(height))),
        quality_row("Picture height sent", "px", [d["sent"] for d in height], min((d["sent"] for d in height), default=None), "higher", "link-round median, links seen from both phones", both(len(height))),
        quality_row("Upload speed", "kbit/s", p50("rtc.out_kbps"), min((v for v in p50("rtc.out_kbps") if v is not None), default=None), "higher", "link-round median", f"{len(p50('rtc.out_kbps'))} link samples"),
        quality_row("Frozen video per link sample", "s", frozen, max(frozen, default=None), "lower", "seconds frozen in the round, 0 for a clean round", f"{len(frozen)} link samples"),
    ]
    return rows


def worst_link(directions):
    """The link direction with the lowest frame rate received and the one with the smallest picture received, each with
    what its sender sent: the same link seen from both phones, so the two figures can be compared."""
    out = {}
    for kind in ("fps", "height"):
        items = directions.get(kind, [])
        if items:
            worst = min(items, key=lambda d: (d["received"], d["sent"]))
            out[kind] = {"sent": worst["sent"], "received": worst["received"], "round": worst["round"], "samples": len(items),
                         "partial": bool(worst.get("partial"))}
    return out


def codec_kinds(players_pull, os_of=None):
    """Hardware or software video encoding and decoding, counted on the same link samples as the Links routes: one per
    phone per peer per round that carried a round-trip time (rtc.rtt_ms stat p50), joined on (account, round, rtc.peer).
    rtc.link rows also exist for seats whose player never came (game 254: 36 of 140), which carried no video and are
    left out. "not reported" is the browser saying nothing (rtc.*_kind unsupported)."""
    measured = {(a, str(m.get("round")), str(m.get("rtc.peer"))) for a, p in players_pull.items() for m in p.get("metrics", [])
                if m.get("metric.name") == "rtc.rtt_ms" and m.get("stat") == "p50"}
    grouped = collections.defaultdict(list)
    for account, p in players_pull.items():
        for r in p.get("linkKinds", []):
            key = (account, str(r.get("round")), str(r.get("rtc.peer")))
            if not measured or key in measured:
                grouped[key].append(r)
    if not grouped:
        return None
    # one row per link sample; a link whose coder changed mid-round has a row per kind, and counts as mixed (the rows
    # carry no frame counts to pick one), whatever order they came in
    def merged(rows, field):
        kinds = {r.get(field) or "unsupported" for r in rows}
        return kinds.pop() if len(kinds) == 1 else "mixed"
    picked = {key: {"rtc.encoder_kind": merged(rows, "rtc.encoder_kind"), "rtc.decoder_kind": merged(rows, "rtc.decoder_kind")}
              for key, rows in sorted(grouped.items())}
    count = lambda rows, field: {kind: sum(1 for r in rows if r[field] == kind) for kind in ("hardware", "software", "mixed", "unsupported")}
    rows = list(picked.values())
    by_platform = collections.defaultdict(list)
    for (account, _, _), r in picked.items():
        by_platform[str((os_of or {}).get(account) or "unknown").split(" ")[0]].append(r)
    return {"samples": len(rows), "samplesLabel": f"{len(rows)} link samples", "encoding": count(rows, "rtc.encoder_kind"),
            "decoding": count(rows, "rtc.decoder_kind"),
            "byPlatform": [{"platform": platform, "samples": len(pr), "encoding": count(pr, "rtc.encoder_kind"), "decoding": count(pr, "rtc.decoder_kind")}
                           for platform, pr in sorted(by_platform.items()) if pr]}


def send_ladder(players_pull):
    """How the upload ladder behaved: one rtc.send_adaptation.round transaction per sender per round
    (apps/jollity-app/lib/webrtc/send-adaptation-evidence.ts). max_rung is the lowest step reached (the index grows downwards)."""
    seconds, deepest, senders = collections.Counter(), {}, set()
    for account, p in players_pull.items():
        for row in p.get("sendRungs", []):
            senders.add(account)
            for item in LADDER:
                seconds[item["rung"]] += fnum(row.get(f"measurements.rtc.send.rung_{item['rung']}_s")) or 0
            low = fnum(row.get("max_rung"))
            if low is not None:
                deepest[account] = max(deepest.get(account, 0), int(low))
    if not senders:
        return None
    stepped = {a: d for a, d in deepest.items() if d > 0}
    by_rung = collections.Counter(LADDER[min(d, len(LADDER) - 1)]["rung"] for d in stepped.values())
    return {"senders": len(senders), "steppedDown": len(stepped),
            "lowestRung": [{"rung": item["rung"], "senders": by_rung[item["rung"]]} for item in LADDER if by_rung[item["rung"]]],
            "secondsByRung": [{"rung": item["rung"], "seconds": round(seconds[item["rung"]])} for item in LADDER],
            "ladder": LADDER}


def adaptations_block(players_pull, players, video, joined_accounts=None, directions=None):
    """Telemetry-backed ways phones reduced work or recovered during the report window."""
    by_name = collections.defaultdict(list)
    for account, player in players_pull.items():
        for row in player.get("metrics", []):
            by_name[row.get("metric.name")].append((account, row))

    joined_accounts = set(joined_accounts) if joined_accounts is not None else {player.get("id") for player in players}
    scoped_players = [player for player in players if not player.get("bot") and player.get("id") in joined_accounts]
    modes = collections.Counter(player.get("mode") or "unknown" for player in scoped_players)
    reasons = collections.Counter()
    for player in scoped_players:
        if player.get("mode") != "low power":
            continue
        for reason in (player.get("modeReason") or "unknown").split(", "):
            reasons[reason.replace(" ", "-")] += 1

    def link_key(account, row):
        return (account, row.get("round"), row.get("rtc.peer"))

    observed_links = {link_key(account, row) for metric in ("rtc.rtt_ms", "rtc.in_height", "rtc.out_height", "rtc.in_fps", "rtc.out_fps")
                      for account, row in by_name.get(metric, []) if row.get("stat") == "p50"}
    limited_links, limited_senders = set(), collections.defaultdict(set)
    limited_seconds = collections.Counter()
    limited_rows = []
    for account, row in by_name.get("rtc.quality_limited_s", []):
        if row.get("stat") != "total" or (fnum(row.get("sum(value)")) or 0) <= 0:
            continue
        reason, seconds = row.get("reason") or "other", fnum(row["sum(value)"])
        limited_rows.append((account, row, reason))
        limited_links.add(link_key(account, row))
        limited_senders[reason].add(account)
        limited_seconds[reason] += seconds
    quality_reasons = [{"reason": reason,
                        "links": len({link_key(account, row) for account, row, why in limited_rows if why == reason}),
                        "senders": len(limited_senders[reason]), "seconds": round(seconds, 3)}
                       for reason, seconds in sorted(limited_seconds.items())]
    heal_rows = by_name.get("rtc.heal_ms", [])
    freeze_rows = [(account, row) for account, row in by_name.get("rtc.freeze_ms", []) if row.get("stat") == "total"]
    step_counts = collections.Counter(step.get("span.op") for player in players_pull.values() for step in player.get("steps", []))

    directions = directions if directions is not None else link_directions(players_pull)
    heights, rates = directions.get("height", []), directions.get("fps", [])

    def worst_codec(metric):
        values = [fnum(row.get("max(value)")) for _, row in by_name.get(metric, []) if row.get("stat") == "p95"]
        values = [value for value in values if value is not None]
        return f1(max(values)) if values else None

    return {
        "lowPower": {"players": len(scoped_players), "scope": "joined players",
                     "lowPower": modes.get("low power", 0), "full": modes.get("full", 0),
                     "unknown": modes.get("unknown", 0),
                     "reasons": [{"reason": reason, "players": count} for reason, count in sorted(reasons.items())]},
        # the same link directions on both sides (seen from both phones), at the ladder's standard values
        "picture": {"scope": "link directions both phones reported",
                    "receivedHeight": ladder_distribution([d["received"] for d in heights], LADDER_HEIGHTS, "px"),
                    "sentHeight": ladder_distribution([d["sent"] for d in heights], LADDER_HEIGHTS, "px"),
                    "receivedFps": ladder_distribution([d["received"] for d in rates], LADDER_FPS, "fps", FPS_TOLERANCE),
                    "sentFps": ladder_distribution([d["sent"] for d in rates], LADDER_FPS, "fps", FPS_TOLERANCE)},
        "sendLadder": send_ladder(players_pull),
        "qualityLimits": {"links": len(observed_links | limited_links), "limitedLinks": len(limited_links),
                          "neverLimited": len((observed_links | limited_links) - limited_links), "reasons": quality_reasons},
        "signals": {"turnLinks": (video.get("pathCounts") or {}).get("relay", 0),
                    "connectionSamples": video.get("connectionSamples", 0),
                    "healEvents": round(sum(fnum(row.get("count(value)")) or 0 for _, row in heal_rows)),
                    "healedLinks": len({link_key(account, row) for account, row in heal_rows}),
                    "healSteps": step_counts.get("game.rtc.heal", 0),
                    "reconnectSteps": step_counts.get("game.rtc.reconnect", 0),
                    "stallSteps": step_counts.get("game.rtc.stall", 0),
                    "frozenLinks": sum(1 for _, row in freeze_rows if (fnum(row.get("sum(value)")) or 0) > 0),
                    "freezeSeconds": round(sum(fnum(row.get("sum(value)")) or 0 for _, row in freeze_rows) / 1000, 3),
                    "worstEncodeP95Ms": worst_codec("rtc.encode_ms"), "worstDecodeP95Ms": worst_codec("rtc.decode_ms")},
        "notes": ["Low power turns off visual effects such as animations, blur, and hero zoom; it does not change video size.",
                  ADAPTATION_NOTE],
    }


def device_class(root_rows, profile):
    """iPhones are pooled in the smoothness rows; every Android model stands alone."""
    r = root_rows[-1] if root_rows else {}
    os_ = (r.get("device.os") or (profile or {}).get("os") or "").lower()
    return "iPhones" if os_ == "ios" else (r.get("device.model") or "unknown device")


def player_mode(metrics):
    """'low power' when any metric row has lowpower on, 'full' when rows have only off, None when no row has the tag (an older build)."""
    tags = {m.get("lowpower") for m in metrics}
    return "low power" if "on" in tags else "full" if "off" in tags else None


def player_mode_reason(metrics):
    """Why low power came on, from the lowpower.reason tag of the rows that have lowpower on: 'debug menu', 'probe weak', ... (comma-joined when a reload gave two). None for a full player or an older build that sends no reason."""
    reasons = {str(m["lowpower.reason"]).replace("-", " ") for m in metrics if m.get("lowpower") == "on" and m.get("lowpower.reason") not in (None, "", "none")}
    return ", ".join(sorted(reasons)) or None


def player_probe(metrics):
    """The device probe from the ui.probe_* rows: {p95Ms, frames, version, thresholdMs}, plus samples/rule on v2 builds and stage/attempts on v5.

    One probe is one point of each metric. With more than one (a reload), p95Ms is the worst and
    frames the lowest. 'none' when the rows carry the tags but no probe point, None when no row has the tags.
    """
    # a v3 build also sends the median as ui.probe_frame_median_ms
    p95 = [m for m in metrics if m.get("metric.name") == "ui.probe_frame_ms" and fnum(m.get("max(value)")) is not None]
    p50 = [fnum(m.get("max(value)")) for m in metrics if m.get("metric.name") == "ui.probe_frame_median_ms" and fnum(m.get("max(value)")) is not None]
    frames = [fnum(m.get("min(value)")) for m in metrics if m.get("metric.name") == "ui.probe_frames" and fnum(m.get("min(value)")) is not None]
    if not p95 and not frames:
        return "none" if player_mode(metrics) else None
    rows = [m for m in metrics if m.get("metric.name") in ("ui.probe_frame_ms", "ui.probe_frames", "ui.probe_frame_median_ms")]
    texts = lambda key: ", ".join(sorted({str(m[key]) for m in rows if m.get(key) not in (None, "")})) or None
    out = {"p95Ms": f1(max(fnum(m["max(value)"]) for m in p95)) if p95 else None, "frames": round(min(frames)) if frames else None,
           "version": texts("probe.version"), "thresholdMs": texts("probe.threshold_ms")}
    if p50:
        out["medianMs"] = f1(max(p50))
    sample_rows = [m for m in metrics if m.get("metric.name") in ("ui.probe_sample_ms", "ui.probe_sample_frames")]
    if sample_rows:
        # a v2 build: p95Ms/frames above are the deciding sample (one point per device); the detail is per probe.sample
        by_sample = {}
        for m in sample_rows:
            slot = by_sample.setdefault(str(m.get("probe.sample") or "0"), {"p95Ms": None, "frames": None})
            if m["metric.name"] == "ui.probe_sample_ms" and fnum(m.get("max(value)")) is not None:
                slot["p95Ms"] = f1(max(slot["p95Ms"] or 0, fnum(m["max(value)"])))
            elif m["metric.name"] == "ui.probe_sample_frames" and fnum(m.get("min(value)")) is not None:
                v = round(fnum(m["min(value)"]))
                slot["frames"] = v if slot["frames"] is None else min(slot["frames"], v)
        out["samples"] = [by_sample[k] for k in sorted(by_sample, key=lambda k: int(k) if k.isdigit() else 0)]
    if out["version"] and out["version"] != "1":
        out["rule"] = texts("probe.rule")
        out["borderlineFromMs"] = texts("probe.borderline_from_ms")
        out["weakFromMs"] = texts("probe.weak_from_ms")
        # v5 on: countdown or late, and the samples that ended on a hidden page
        out["stage"] = texts("probe.stage")
        out["attempts"] = texts("probe.attempts")
    return out


def per_player_frames(players_pull):
    """Per player: scene -> {p50, p95, slow} (game.* scenes), and moment -> {avg, max}.

    A moment's avg is sum / count of the avg points; max is the worst of the max points.
    """
    per, moments = {}, {}
    for a, p in players_pull.items():
        scenes, mo = {}, {}
        for m in p.get("metrics", []):
            n, sc = m.get("metric.name"), m.get("scene")
            if n == "ui.frame_ms" and sc and sc.startswith("game.") and m.get("stat") in ("p50", "p95"):
                scenes.setdefault(sc, {})[m["stat"]] = fnum(m.get("p50(value)"))
            elif n == "ui.slow_frame_pct" and sc and sc.startswith("game."):
                scenes.setdefault(sc, {})["slow"] = fnum(m.get("p50(value)"))
            elif n == "ui.moment_frame_ms" and m.get("moment"):
                d = mo.setdefault(m["moment"], {"sum": 0.0, "n": 0.0, "max": None})
                if m.get("stat") == "avg" and fnum(m.get("sum(value)")) is not None:
                    d["sum"] += fnum(m["sum(value)"])
                    d["n"] += fnum(m.get("count(value)")) or 0
                elif m.get("stat") == "max" and fnum(m.get("max(value)")) is not None:
                    d["max"] = max(d["max"] or 0, fnum(m["max(value)"]))
        if scenes:
            per[a] = scenes
        if mo:
            moments[a] = {k: {"avg": v["sum"] / v["n"] if v["n"] else None, "max": v["max"]} for k, v in mo.items()}
    return per, moments


def scene_rows(per, cls_of, alone, label):
    """One row per scene and device group: the median of the players' p50, p95 and slow share. An iPhone in `alone` gets its own row."""
    rows = []
    for scene in sorted({s for sc in per.values() for s in sc}):
        groups = collections.defaultdict(list)
        for a, sc in per.items():
            if scene in sc:
                groups["iPhones" if cls_of[a] == "iPhones" and a not in alone else label(a)].append(sc[scene])
        for key, lst in sorted(groups.items(), key=lambda kv: (kv[0] == "iPhones", kv[0])):
            rows.append({"scene": (f"iPhones ({len(lst)}) · {scene}" if key == "iPhones" else f"{key} · {scene}"),
                         "p50": f1(median([x.get("p50") for x in lst])), "p95": f1(median([x.get("p95") for x in lst])),
                         "slowPct": f1(median([x.get("slow") for x in lst]))})
    return rows


MOMENTS = ["intro", "play", "turned", "warn", "ending", "gap"]


def moment_rows(moments, cls_of, slow_iphone, label, low_power):
    """Per OS family and moment: the median of each player's average frame and worst frame, plus a row for any player whose ending averages over 200 ms.

    A low power player is in no family: each one gets a row per moment."""
    rows = []
    for fam in ("iPhones", "Android"):
        members = [a for a in moments if (cls_of[a] == "iPhones") == (fam == "iPhones") and a not in slow_iphone and a not in low_power]
        for mo in MOMENTS:
            avgs = [moments[a][mo]["avg"] for a in members if mo in moments[a] and moments[a][mo]["avg"] is not None]
            if avgs:
                rows.append({"scene": f"{fam} ({len(avgs)}) · moment {mo} (avg / worst frame)", "p50": f1(median(avgs)),
                             "p95": f1(median([moments[a][mo]["max"] for a in members if mo in moments[a]])), "slowPct": None})
    for a in sorted(moments.keys() & low_power, key=label):
        for mo in MOMENTS:
            if mo in moments[a]:
                rows.append({"scene": f"{label(a)} · moment {mo} (avg / worst frame)", "p50": f1(moments[a][mo]["avg"]), "p95": f1(moments[a][mo]["max"]), "slowPct": None})
    for a, mo in moments.items():
        e = mo.get("ending") or {}
        if a not in low_power and (e.get("avg") or 0) >= SLOW_MOMENT_MS:
            rows.append({"scene": f"{label(a)} · moment ending (avg / worst frame)", "p50": f1(e["avg"]), "p95": f1(e["max"]), "slowPct": None})
    return rows


def smoothness_rows(players_pull, names):
    """Frame times of the game's scenes per device type, then per moment of the round per OS family.

    A group row is the median across its players. Every Android phone stands alone (the models
    differ); iPhones are pooled, except one with >= 25 % slow frames in the round, which gets its
    own row and stays out of the pool. A low power player stays out of every pool and gets rows of
    its own, labeled "low power".
    """
    per, moments = per_player_frames(players_pull)
    cls_of = {a: device_class(p.get("roots", []), p.get("profile")) for a, p in players_pull.items()}
    low_power = {a for a, p in players_pull.items() if player_mode(p.get("metrics", [])) == "low power"}
    slow_iphone = {a for a, sc in per.items() if cls_of[a] == "iPhones" and (sc.get("game.round", {}).get("slow") or 0) >= SLOW_PCT}
    def mode_text(a):
        reason = player_mode_reason(players_pull[a].get("metrics", []))
        return (f", low power ({reason})" if reason else ", low power") if a in low_power else ""
    label = lambda a: f"{names.get(a) or SHORT(a)} ({(players_pull[a].get('roots') or [{}])[-1].get('device.model') or '?'}{mode_text(a)})"
    return scene_rows(per, cls_of, slow_iphone | low_power, label) + moment_rows(moments, cls_of, slow_iphone, label, low_power)


STEP_ROWS = [("game-signup.tx.landed", "sign-up: tx landed"), ("join.peer.all", "join: all peers"), ("game.round.1", "game: round 1"),
             ("game.round.2", "game: round 2"), ("game.report.submit", "game: report submit"), ("game.report.landed", "game: report landed"),
             ("payoff.attestations.ready", "payoff: attestations ready"), ("payoff.chest.show", "payoff: chest shown")]


def metric_total(metrics, name):
    """Sum a metric's retained aggregates without changing the raw pull."""
    total = 0.0
    found = False
    for row in metrics:
        if row.get("metric.name") != name:
            continue
        value = fnum(row.get("sum(value)"))
        if value is not None:
            total += value
            found = True
    return total if found else None


def away_evidence(player):
    """The player's aggregate away duration and return count, which carry no interval timestamps."""
    metrics = player.get("metrics", [])
    away = metric_total(metrics, "app.away_ms")
    if away is None or away <= 0:
        return None
    resumed = metric_total(metrics, "app.resumed")
    if resumed is None:
        resumed = sum(fnum(row.get("count(value)")) or 0 for row in metrics if row.get("metric.name") == "app.away_ms")
    return away, round(resumed)


def compact_seconds(ms):
    seconds = round(ms / 1000, 1)
    return f"{seconds:g}"


def away_note(evidence):
    away, resumed = evidence
    times = "time" if resumed == 1 else "times"
    return f"may include up to {compact_seconds(away)} s away; the game screen was hidden {resumed} {times}"


def step_rows(players_pull, names):
    """Raw median and slowest step timings, with aggregate suspension evidence kept separate.

    app.away_ms is retained as a session aggregate, without interval timestamps. A step at least as
    long as that aggregate may include the absence, but the report must not subtract an unproven
    overlap. Such raw rows are labelled and a separate median excludes the candidates.
    """
    rows = []
    for op, label in STEP_ROWS:
        per = collections.defaultdict(list)
        for a, p in players_pull.items():
            for s in p.get("steps", []):
                if s.get("span.op") == op and fnum(s.get("span.duration")) is not None:
                    per[a].append(fnum(s["span.duration"]))
        if not per:
            continue
        meds = {a: max(v) for a, v in per.items()}  # a step can repeat (a reopened app): the longest one is the player's number
        slow = max(meds.items(), key=lambda kv: kv[1])
        flagged = {a: evidence for a in meds if (evidence := away_evidence(players_pull[a])) and meds[a] >= evidence[0]}
        rows.append({"step": f"all ({len(meds)}) · {label} (median)", "ms": round(statistics.median(meds.values()))})
        if len(meds) > 1:
            note = f"; {away_note(flagged[slow[0]])}" if slow[0] in flagged else ""
            rows.append({"step": f"{names.get(slow[0]) or SHORT(slow[0])} · {label} (slowest{note})", "ms": round(slow[1])})
        shown = {slow[0]} if len(meds) > 1 and slow[0] in flagged else set()
        for a in sorted(flagged.keys() - shown, key=lambda account: (-meds[account], names.get(account) or account)):
            rows.append({"step": f"{names.get(a) or SHORT(a)} · {label} ({away_note(flagged[a])})", "ms": round(meds[a])})
        if flagged:
            clean = [duration for a, duration in meds.items() if a not in flagged]
            rows.append({"step": f"all ({len(clean)}) · {label} (median excluding steps that may include away time)",
                         "ms": round(statistics.median(clean)) if clean else None})
    return rows


# --------------------------------------------------------------------------- per-player rows

def journey(roots, op):
    """The player's journeys of one kind for this game, as {outcome, ms, at, note?} (the last one's numbers), or None."""
    rs = [r for r in roots if r.get("span.op") == op]
    if not rs:
        return None
    seq = []
    for x in rs:
        o = x.get("journey.outcome") or "?"
        if not seq or seq[-1] != o:
            seq.append(o)
    seq = ["joined late" if o == "late" and op == "journey.join" else o for o in seq]
    j = {"outcome": ", then ".join(seq), "ms": round(fnum(rs[-1].get("span.duration")) or 0) or None, "at": rs[-1].get("timestamp")}
    if op == "journey.join" and rs[-1].get("journey.outcome") == "late":
        # a join that opened once play had begun is late, not isolated (#800): its own duration is not the time to video
        first = fnum(rs[-1].get("join.first_link_ms"))
        j["note"] = f"video after {first / 1000:.1f} s" if first is not None else "arrived after play began; time to first video is unavailable"
        j["ms"] = None
    if len(rs) > 1:
        j["note"] = (j["note"] + "; " if j.get("note") else "") + f"{len(rs)} journeys (ms is the last one): " + ", ".join(f"{x.get('journey.outcome') or '?'} {round(fnum(x.get('span.duration')) or 0)} ms" for x in rs)
    return j


def absent(outcome, note):
    return {"outcome": outcome, "ms": None, "note": note}


def _display_app(roots, profile, page):
    """Device, OS, host and release from already-partitioned app roots."""
    if not roots:
        return {"device": "unknown", "os": "unknown", "host": "unknown", "release": None}
    r = roots[-1]
    prof = profile or {}
    model, screen = prof.get("model") or "", prof.get("screen")
    m = re.match(r"iphone-([\d.]+)in", model)
    name = r.get("device.model") or "unknown"
    device = f"iPhone ({m.group(1)} in, {screen}, inferred)" if prof.get("modelSource") == "inferred" and m else (f"{name} ({screen})" if screen else name)
    o, v = (r.get("device.os") or "").lower(), r.get("device.os_version") or ""
    ua = re.search(r"iPhone OS (\d+(?:_\d+)+)", (page or {}).get("user_agent") or "")
    if o == "ios" and ua:  # the user agent has the patch level Sentry's tag drops
        v = ua.group(1).replace("_", ".")
    os_ = {"ios": "iOS", "android": "Android"}.get(o, o) + (f" {v}" if v else "") if o else "unknown"
    app, ver = r.get("host.app"), r.get("host.app_version")
    if not app:
        host = f"{r.get('host.kind')} host (no app name or version sent)" if r.get("host.kind") else "unknown"
    else:
        host = f"{app} {ver}" if ver else f"{app} ({(r.get('device.os') or '?').capitalize()}, no version sent)"
    return {"device": device, "os": os_, "host": host, "release": short_release(r)}


def display(roots, profile, page):
    """Device, OS, host and release from app roots only; worker roots carry none of these."""
    return _display_app(partition_roots(roots)[0], profile, page)


def merge_telemetry_health(merged, part):
    """Merge one game or nested session health part in place."""
    for key, value in part.items():
        if isinstance(value, dict):
            merge_telemetry_health(merged.setdefault(key, {}), value)
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            if key == "longest_wait_ms":
                merged[key] = max(merged.get(key, 0), value)
            else:
                merged[key] = merged.get(key, 0) + value


def telemetry_health(events):
    """All delivery-health parts for this player/game, summed without timing loss."""
    events = [e for e in events or [] if e.get("title") == "telemetry.health" and e.get("telemetryHealth")]
    if not events:
        return None
    merged = {}
    for event in events:
        merge_telemetry_health(merged, event["telemetryHealth"])
    merged["late_parts"] = sum(1 for event in events if event.get("telemetryHealthLate"))
    return merged


def telemetry_failures_exhausted(health):
    """Failed final attempts: failures which did not lead to a retry."""
    if not health:
        return 0
    failures = sum(int(health.get(f"failed_{reason}") or 0) for reason in ("fetch", "4xx", "429", "5xx", "timeout"))
    recovered = int(health.get("recovered_timeouts") or 0)
    return max(0, failures - int(health.get("retries") or 0) - recovered)


def telemetry_loss(health):
    """Queue drops plus failed final attempts (failures which did not lead to a retry)."""
    if not health:
        return 0
    return int(health.get("dropped_events") or 0) + int(health.get("dropped_metrics") or 0) + telemetry_failures_exhausted(health)


def telemetry_level(has_any, trail, health=None):
    """full: a log with a vote trail (so the round and the report can be followed). partial: anything less. none: nothing at all."""
    if telemetry_loss(health):
        return "partial"
    if trail:
        return "full"
    return "partial" if has_any else "none"


def trail_sentence(t):
    by = {"tap": "a tap", "auto-confirm": "the auto-confirm timer"}.get(t["filedBy"], t["filedBy"] or "unknown")
    return f"{t['taps']} taps, {t['defaults']} default seals, report filed by {by}"


def payoff_row(po, pay, c):
    """The payoff stage: the journey (or Sentry's payoff facts) plus what the chain says, or None."""
    if po or pay:
        po = po or {"outcome": pay.get("journey.outcome"), "ms": None}
        if c:
            add_note(po, f"{'attested' if c['attended'] else 'not attested'} {c['yesPerson']}/{c['noNotPerson']}")
            sb, sa = c.get("scoreBefore") or {}, c.get("scoreAfter") or {}
            if sb.get("score") is not None and sa.get("score") is not None:
                add_note(po, f"score {sb['score']} → {sa['score']}")
        if pay.get("chest.count"):
            add_note(po, f"{pay['chest.count']} collectable(s)")
        if pay.get("draw.won") == "true":
            add_note(po, "won the prize draw")
        if pay.get("membership.change") not in (None, "none"):
            add_note(po, f"app says {pay['membership.change']} (standing {pay.get('membership.standing')})")
        return po
    if c:
        return absent("not seen", f"{'reported' if c['sentReport'] else 'never reported'}; {'attested' if c['attended'] else 'not attested'} {c['yesPerson']}/{c['noNotPerson']}")
    return None


def draw_row(pull_player):
    """The Players table's Prize draw cell: the payoff journey's draw.show step and its draw.invited / draw.won, or None."""
    pay = pull_player.get("payoff") or {}
    shown = step_ended(pull_player, "payoff.draw.show")
    invited, won = pay.get("draw.invited"), pay.get("draw.won")
    if not shown and invited is None:
        return None
    outcome = "won" if won == "true" else "shown" if shown else "not shown"
    note = {"true": "in the draw", "false": "not in the draw"}.get(invited)
    return {"outcome": outcome, "ms": None, **({"note": note} if note else {})}


SIGNUP_SUCCESS = ("landed", "sent")


def signup_cell(roots, events, chain_row, reg, no_signup):
    """The Registration cell. The journeys' own outcomes stay as they are, each journey says where it ran (chat or app),
    a signup-broadcast event counts as an attempt when no journey exists, and when the chain registered the account
    but no journey ended in success the chain's registration is named beside it (block time, which runs about 30 s
    behind the phones' clocks, so it says "chain time")."""
    runs = [r for r in roots if r.get("span.op") == "journey.game-signup"]
    broadcasts = [e for e in events if (e.get("title") or "").startswith("signup-broadcast")]
    sg = journey(roots, "journey.game-signup")
    if sg:
        surfaces = list(dict.fromkeys("chat" if is_chat_root(r) else "app" for r in runs))
        sg["surface"] = ", ".join(surfaces)
        if sg.get("at"):
            add_note(sg, f"at {cest(parse_ts(sg['at']))}")
        add_note(sg, "from the " + ", then the ".join(surfaces))
    elif broadcasts:  # only the app sends signup-broadcast (apps/jollity-app/lib/telemetry/index.ts signupBroadcast)
        sg = {**absent("broadcast", f"no sign-up journey; the app broadcast a sign-up at {cest(parse_ts(broadcasts[0]['timestamp']), True)}"), "surface": "app"}
    elif chain_row:
        sg = absent("not seen", no_signup)
    if not sg:
        return None
    succeeded = any(o in SIGNUP_SUCCESS for o in (sg.get("outcome") or "").split(", then "))  # the best journey, not the last
    if sg.get("outcome") != "broadcast" and broadcasts and not succeeded:
        add_note(sg, f"the app broadcast a sign-up at {cest(parse_ts(broadcasts[-1]['timestamp']), True)}")
    if chain_row and not succeeded:
        at = (reg or {}).get("at")
        call = ((reg or {}).get("call") or "").split(".")[-1]
        try:
            when = f" {cest(parse_ts(at))} {tz_label(parse_ts(at))} chain time" if at else ""
        except ValueError:  # not a timestamp: say no time rather than a wrong one
            when = ""
        add_note(sg, f"registered on chain{when}{f' ({call})' if call else ''}" + ("" if sg.get("outcome") == "not seen" else "; success not observed"))
    return sg


def build_players(accounts, pull, chain_by, logs, trails, any7, joined_from_logs, mapping=None, reg_by=None,
                  page_window=None):
    """One row per account (registered ones, plus any other account Sentry or the logs saw)."""
    out = []
    for acct in accounts:
        p = pull["players"].get(acct, {})
        roots = p.get("roots", [])
        app_roots, chat_roots = partition_roots(roots)
        users = [r.get("user.username") for r in roots if r.get("user.username")]
        sentry_name = collections.Counter(users).most_common(1)[0][0] if users else None
        log_name = (logs.get(acct, {}).get("meta") or {}).get("username")
        mapped = (mapping or {}).get(acct)
        username = sentry_name or log_name or mapped
        source = "sentry" if sentry_name else "log" if log_name else "mapping" if mapped else None
        c, tr = chain_by.get(acct), trails.get(acct)
        dsp = _display_app(app_roots, p.get("profile"), p.get("page"))
        host_build = next((r.get("host.build") or r.get("host.build_number") or r.get("host.version_code")
                           for r in reversed(app_roots)
                           if r.get("host.build") or r.get("host.build_number") or r.get("host.version_code")), None)
        reg = (reg_by or {}).get(acct)
        if reg:
            reg = {**reg, "route": signup_route(roots, reg["route"], p.get("steps", []))}
        # the route is inferred from the call name, not observed, so the cell names the call and no surface
        no_signup = "no sign-up attempt in Sentry"
        sg = signup_cell(roots, p.get("events", []), c, reg, no_signup)
        jn = journey(roots, "journey.join")
        if jn:
            steps = [s for s in p.get("steps", []) if s.get("span.op") == "join.peer.all"]
            if steps:
                jn["peerAllMs"] = round(fnum(steps[-1].get("span.duration")) or 0)
                add_note(jn, f"peer.all {jn['peerAllMs'] / 1000:.1f} s")
        elif acct in joined_from_logs:
            jn = absent("log only", f"no join journey; the log shows the mesh open at {cest(parse_ts(joined_from_logs[acct]), True)}")
        gm = journey(roots, "journey.game") or (absent("log only", "no game journey") if tr else None)
        if gm and tr:
            add_note(gm, trail_sentence(tr))
        all_lives = page_lives(p, pull.get("game"))
        lives, earlier_lives = page_lives_in_window(all_lives, page_window)
        lives_note = page_lives_note(lives, earlier_lives) if len(lives) > 1 or any(
            life.get("end") not in ("played", "open") for life in lives
        ) else None
        if lives_note:
            gm = gm or absent("not seen", lives_note)
            if gm.get("note") != lives_note:
                add_note(gm, lives_note)
        po = payoff_row(journey(roots, "journey.payoff"), p.get("payoff") or {}, c)
        bot = p.get("bot")
        health = telemetry_health(p.get("events"))
        if bot:  # a scripted run on a CI runner: its device and build say nothing about real phones
            dsp = {"device": "bot", "os": "bot", "host": "bot", "hostBuild": None, "release": None}
            host_build = None
        row = {"username": username, "usernameSource": source, "id": acct, "device": dsp["device"], "os": dsp["os"], "host": dsp["host"], "hostBuild": host_build, "bot": bot,
               "signup": sg, "join": jn, "game": gm, "payoff": po, "draw": draw_row(p),
               "telemetry": telemetry_level(bool(roots or p.get("events") or any7.get(acct)), tr, health),
               "registered": bool(c), "sentReport": c["sentReport"] if c else None, "release": dsp["release"], "workerRelease": _latest_release(chat_roots),
               "mode": player_mode(p.get("metrics", [])), "modeReason": player_mode_reason(p.get("metrics", [])), "probe": player_probe(p.get("metrics", []))}
        if health:
            row["telemetryHealth"] = health
        if telemetry_loss(health):
            row["telemetryNote"] = ("Partial due to telemetry throttling: "
                                    f"{int(health.get('dropped_events') or 0)} event(s), "
                                    f"{int(health.get('dropped_metrics') or 0)} metric envelope(s) dropped, "
                                    f"{telemetry_failures_exhausted(health)} upload(s) exhausted retries")
        if reg:
            row["registration"] = reg
        if lives_note:
            row["pageLives"] = lives
        if c:
            row["chain"] = {k: c[k] for k in ("yesPerson", "noNotPerson", "groups", "attended", "reportTime")}
        if tr:
            row["voteTrail"] = {k: tr[k] for k in ("taps", "turns", "defaults", "filedBy")}
        out.append(row)
    out.sort(key=lambda r: (r["telemetry"] == "none", r["username"] is None, r["username"] or r["id"]))
    return out


# --------------------------------------------------------------------------- facts

@dataclasses.dataclass
class Ctx:
    """Everything a fact looks at. Built once in assemble()."""
    players: list
    chain: dict | None = None
    chain_by: dict = dataclasses.field(default_factory=dict)
    ties: list = dataclasses.field(default_factory=list)
    trails: dict = dataclasses.field(default_factory=dict)
    overrides: list = dataclasses.field(default_factory=list)
    logs: dict = dataclasses.field(default_factory=dict)
    pull: dict = dataclasses.field(default_factory=lambda: {"players": {}})
    links: dict | None = None
    kickoff: datetime.datetime | None = None
    seen: dict = dataclasses.field(default_factory=dict)
    joined: set | None = None

    @property
    def names(self):
        return {p["id"]: p["username"] or SHORT(p["id"]) for p in self.players}


def fact(kind, text, **extra):
    return {"kind": kind, "text": text, **extra}


PLATFORM_ERROR_PATTERNS = (
    (76, re.compile(r"subscription dropped|cannot select a metadata block|unknown follow subscription", re.I)),
    # pb#77 is the unpin_head timeout (wire 3,5) only; other wire methods' 120 s timeouts are not that bug.
    (77, re.compile(r"(?s)(?=.*\bwire\s*3\s*,\s*5\b).*TrUAPI request .*timed out after 120000ms", re.I)),
    (78, re.compile(r"BlockNotPinnedError|\bis not pinned\b", re.I)),
)


def _event_text(value):
    if isinstance(value, dict):
        return " ".join(_event_text(item) for item in value.values())
    if isinstance(value, list):
        return " ".join(_event_text(item) for item in value)
    return str(value or "")


def _platform_error_detail(number, text):
    if number == 77:
        wire = re.search(r"wire\s*(\d+)\s*,\s*(\d+)", text, re.I)
        if wire:
            method = f"wire {wire.group(1)},{wire.group(2)}"
            return method + (" (unpin_head)" if wire.groups() == ("3", "5") else "")
        return "wire method unknown"
    if number == 78:
        call = re.search(r"\(([^()]*(?:call|Ctx|storage|route|seat)[^()]*)\)", text, re.I)
        if not call:
            call = re.search(r"BlockNotPinnedError:\s*([\w-]+)", text, re.I)
        return call.group(1) if call else "call site unknown"
    return "chain read/createTransaction"


HEALTHY_DEVLOG = re.compile(r"^chain: (?:health recheck: healthy|health open: healthy|host answering during game after stuck transition"
                            r"|restart card cleared after a healthy probe)", re.I)


def _healthy_probes(account_pull, log):
    """(ts ms, session, structured) of one account's healthy chain probes: the chain.health 'recovered' event, and the devlog markers.
    Devlog lines repeat across exported copies, so they count once per (session, seq)."""
    out, seen = [], set()
    for event in (account_pull or {}).get("events", []):
        if event.get("title") == "chain.health" and event.get("chainHealthOutcome") == "recovered":
            try: out.append((parse_ts(event.get("timestamp")).timestamp() * 1000, event.get("session.id"), True))
            except (TypeError, ValueError): pass
    for entry in (log or {}).get("entries", []):
        if entry.get("ts") is None or not HEALTHY_DEVLOG.match(f"{entry.get('tag')}: {entry.get('message')}"):
            continue
        key = entry.get("_deliveryId") or (entry.get("sessionId"), entry["ts"], entry.get("message"))
        if key in seen:
            continue
        seen.add(key)
        session = entry.get("sessionId") or (str(entry["_deliveryId"]).rsplit(":", 1)[0] if entry.get("_deliveryId") else None)
        out.append((float(entry["ts"]), session, False))
    return out


def _session_at(log, timestamp):
    """The devlog session open at a time: the latest entry at or before it."""
    best = None
    for entry in (log or {}).get("entries", []):
        if entry.get("ts") is not None and entry["ts"] <= timestamp and entry.get("sessionId") and (best is None or entry["ts"] >= best["ts"]):
            best = entry
    return best["sessionId"] if best else None


def pb76_recovery(hit_ms, hit_session, probes, log):
    """Did the host's chain connection come back by itself after a pb#76 hit: same session, a later session (app restart), or not seen."""
    session = hit_session or _session_at(log, hit_ms)
    later = sorted(probe for probe in probes if probe[0] > hit_ms)
    # the structured event wins over a devlog line when both say the same session recovered
    same = [p for p in later if session is None or p[1] == session] if session else []
    if same:
        first = min(same, key=lambda p: (p[0], not p[2]))
        return {"kind": "self", "seconds": round((first[0] - hit_ms) / 1000)}
    other = [p for p in later if session and p[1] and p[1] != session]
    if other:
        return {"kind": "restart", "seconds": round((other[0][0] - hit_ms) / 1000)}
    return {"kind": "none"}


def known_platform_errors(players_pull, logs, players, participant_accounts=None, window=None):
    """Known platform-bugs recurrences from the two saved report sources.

    A full log can contain the same error as Sentry. Collapse the same player's
    same platform-bug occurrence when the timestamps are within two seconds.
    """
    player_by = {row["id"]: row for row in players}
    candidates = []
    for account, pulled in players_pull.items():
        if participant_accounts is not None and account not in participant_accounts:
            continue
        for event in pulled.get("events", []):
            if event.get("title") in ("game-log", "game-log-chunk"):
                continue
            try: timestamp = parse_ts(event.get("timestamp")).timestamp() * 1000
            except (TypeError, ValueError): continue
            if window is None or window[0].timestamp() * 1000 <= timestamp <= window[1].timestamp() * 1000:
                candidates.append((account, timestamp, _event_text(event), event.get("session.id")))
    for account, log in logs.items():
        if participant_accounts is not None and account not in participant_accounts:
            continue
        for entry in log.get("entries", []):
            if entry.get("ts") is not None:
                timestamp = float(entry["ts"])
                if window is None or window[0].timestamp() * 1000 <= timestamp <= window[1].timestamp() * 1000:
                    candidates.append((account, timestamp, _event_text(entry), entry.get("sessionId")))
    rows = {number: [] for number, _ in PLATFORM_ERROR_PATTERNS}
    probes = {}
    for account, timestamp, text, session in sorted(candidates, key=lambda row: row[1]):
        hit = next(((number, pattern) for number, pattern in PLATFORM_ERROR_PATTERNS if pattern.search(text)), None)
        if not hit:
            continue
        number, _ = hit
        if any(row["account"] == account and abs(row["timestampMs"] - timestamp) <= 2000 for row in rows[number]):
            continue
        player = player_by.get(account) or {}
        dt = datetime.datetime.fromtimestamp(timestamp / 1000, datetime.timezone.utc)
        recovery = None
        if number == 76:
            if account not in probes:
                probes[account] = _healthy_probes(players_pull.get(account), logs.get(account))
            recovery = pb76_recovery(timestamp, session, probes[account], logs.get(account))
        rows[number].append({"account": account, "name": player.get("username") or account[:8],
                             "device": player.get("device") or "unknown", "host": player.get("host") or "unknown",
                             "hostBuild": player.get("hostBuild"), "release": player.get("release"),
                             "at": f"{cest(dt, True)} {dt.astimezone(BERLIN).tzname()}",
                             "timestampMs": round(timestamp), "detail": _platform_error_detail(number, text),
                             **({"recovery": recovery} if recovery else {})})
    return {"total": sum(map(len, rows.values())),
            "window": ({"from": window[0].isoformat(), "to": window[1].isoformat(),
                        "label": local_window_label(*window)} if window else None),
            "scope": "registered or joined players only" if participant_accounts is not None else None,
            "bugs": [
        {"number": number, "count": len(rows[number]), "occurrences": rows[number]} for number, _ in PLATFORM_ERROR_PATTERNS
    ]}


def facts_overrides(c):
    nm = c.names
    out = []
    for o in c.overrides:
        eff = ""
        if "tally" in o:
            eff = (f"; {nm.get(o['target'])} got {o['tally'][0]}/{o['tally'][1]} on chain, {o['tallyIfKept'][0]}/{o['tallyIfKept'][1]} had it counted"
                   + (" (that would have changed the attestation)" if o["flips"] else ""))
        out.append(fact("late-override", f"{nm.get(o['reporter'])} changed {nm.get(o['target'])} to {o['verdict']} {o['sAfterBuild']} s after the report was built"
                        + (" and after it was signed" if o["afterSign"] else "") + eff, **o))
    for rep, t in c.trails.items():
        for o in t["overrides"]:
            if not o["late"] and o["sBeforeBuild"] is not None and o["sBeforeBuild"] < 1.5:
                out.append(fact("close-override", f"{nm.get(rep)} changed {nm.get(o['target'])} to {o['verdict']} only {o['sBeforeBuild']} s before the report was built (kept)", reporter=rep, target=o["target"]))
    return out


def facts_reported_no_telemetry(c):
    nt = [p for p in c.players if p["telemetry"] == "none" and p.get("sentReport")]
    if not nt:
        return []
    return [fact("reported-no-telemetry", f"{len(nt)} accounts reported on chain but sent no telemetry while the game was live (registration opened to settlement): " + ", ".join(SHORT(p["id"]) for p in nt),
                 accounts=[p["id"] for p in nt])]


def facts_reported_no_log(c):
    nlog = [p for p in c.players if p["telemetry"] == "partial" and p.get("sentReport") and p["id"] not in c.logs]
    if not nlog:
        return []
    return [fact("reported-no-log", f"{len(nlog)} reporter(s) with some telemetry sent no game log: " + ", ".join(c.names[p["id"]] for p in nlog), accounts=[p["id"] for p in nlog])]


def facts_backgrounded(c):
    hidden = hidden_seconds(c.links)
    out = []
    for p in c.players:
        gm = p.get("game") or {}
        if p.get("sentReport") and (gm.get("outcome") == "abandoned" or hidden.get(p["id"], 0) >= HIDDEN_S):
            hid = round(hidden.get(p["id"], 0))
            out.append(fact("backgrounded-reporter", f"{c.names[p['id']]} filed a report although the game journey is '{gm.get('outcome')}'"
                            + (f" and the app was out of view for {hid} s of the game" if hid else " (no hidden interval in the log)"), account=p["id"]))
    return out


def facts_away_turns(c):
    """Per player, the turns an away interval from the player's own log overlapped, so a report's verdicts can be read against presence."""
    record = (c.chain or {}).get("record")
    if not record:
        return []
    lag = clock_lag(c.logs.values(), record)
    out = []
    for p in c.players:
        if c.joined is not None and p["id"] not in c.joined:
            continue
        lg = c.logs.get(p["id"])
        if not lg:
            continue
        name = c.names[p["id"]]
        ivs, opens = away_intervals(lg), away_open(lg)
        turns = away_turns(ivs, record, lag, opens)
        if turns:
            def one(t):
                notes = [] if t["chain"] else ["wall clock"]
                if "open" in t["via"]:
                    notes.append("never returned in the log")
                if t["startedHidden"]:
                    notes.append("page started hidden, start is the install time")
                if t["keptRunning"] and not all_running:
                    notes.append("the page kept running")
                return f"round {t['round']} turn {t['turn']} ({t['overlapS']:g} s" + "".join(f", {n}" for n in notes) + ")"
            all_running = all(t["keptRunning"] for t in turns)
            lead = "had the game screen hidden, with the page still running, during " if all_running else "had the app away during "
            out.append(fact("away-turns", f"{name} {lead}" + ", ".join(one(t) for t in turns), account=p["id"], turns=turns))
        bad = away_unplaced(ivs, record, lag)
        if bad:
            out.append(fact("away-unplaced", f"{name}: {len(bad)} away interval(s) could not be placed on the schedule (edges run backwards)", account=p["id"]))
        if away_truncated(lg):
            out.append(fact("away-truncated", f"{name}: the log holds more than {AWAY_KEEP} away intervals; only the latest {AWAY_KEEP} were read", account=p["id"]))
    return out


def facts_clock_skew(c):
    """Report built on the phone vs the report's block time, minus the common chain offset."""
    deltas = {}
    for acct, t in c.trails.items():
        ch = c.chain_by.get(acct)
        if t.get("built") and ch and ch.get("reportTime"):
            deltas[acct] = (t["built"] - parse_ts(ch["reportTime"]).timestamp() * 1000) / 1000
    if len(deltas) < 3:
        return []
    mid = statistics.median(deltas.values())
    return [fact("clock-skew", f"{c.names.get(a)}'s phone clock is about {round(d - mid)} s {'ahead of' if d > mid else 'behind'} the others (report built vs its block time, after the common chain offset of {round(mid)} s)",
                 account=a, seconds=round(d - mid))
            for a, d in sorted(deltas.items(), key=lambda kv: -abs(kv[1] - mid)) if abs(d - mid) > SKEW_S]


def facts_span_clock_early(c):
    """A game journey stamped before kickoff: Sentry's span clock ran early."""
    out = []
    for p in c.players:
        gm = p.get("game")
        if gm and gm.get("at") and c.kickoff and (parse_ts(gm["at"]) - c.kickoff).total_seconds() < -SKEW_S:
            out.append(fact("span-clock-early", f"{c.names[p['id']]}'s game journey is stamped {round((c.kickoff - parse_ts(gm['at'])).total_seconds() / 60, 1)} min before kickoff (Sentry's span clock ran early; the log and error times are right)", account=p["id"]))
    return out


def facts_nameless(c):
    """Accounts with no username anywhere (the window, the logs, the mapping, 30 days of Sentry). An account with only
    chat-worker telemetry is expected here: the chat worker never sends a username."""
    nameless = [p for p in c.players if not p.get("username")]
    if not nameless:
        return []
    chat_only = [p for p in nameless if p.get("funnelStage") == "had the DIM2 chat running but did nothing" or (p.get("signup") or {}).get("surface") == "chat"]
    text = f"{len(nameless)} accounts have no username: {len(chat_only)} only used the chat, whose worker never sends one"
    rest = len(nameless) - len(chat_only)
    text += f"; {rest} sent no username in the window or the 30 days before it." if rest else "."
    return [fact("nameless", text, accounts=[p["id"] for p in nameless])]


def facts_bots(c):
    bots = [p for p in c.players if p.get("bot")]
    if not bots:
        return []
    return [fact("bots", f"{len(bots)} scripted bot players were in this game and are left out of the smoothness, device, host and video numbers (kept in the funnel, join, votes and report filing): "
                 + ", ".join(f"{c.names[p['id']]} ({p['bot']})" for p in bots), accounts=[p["id"] for p in bots])]


def facts_other_builds(c):
    """Not the game's most common release (a judgment, so the text says so)."""
    rel = collections.Counter(p["release"] for p in c.players if p.get("release"))
    if len(rel) < 2:
        return []
    main = rel.most_common(1)[0][0]
    old = [p for p in c.players if p.get("release") and p["release"] != main]
    return [fact("other-builds", f"{len(old)} players ran a release other than the most common one ({main}, {rel[main]} players): " + ", ".join(f"{c.names[p['id']]} {p['release']}" for p in old)
                 + ". 'Older' is not decided here: compare the hashes with the release history.", accounts=[p["id"] for p in old])]


def facts_lost_membership(c):
    """'Lost membership' shown to someone who was already a candidate."""
    out = []
    for p in c.players:
        po = c.pull["players"].get(p["id"], {}).get("payoff") or {}
        if po.get("membership.change") == "lost-membership":
            cb = (c.chain_by.get(p["id"]) or {}).get("scoreBefore") or {}
            if po.get("membership.standing") == "candidate" or cb.get("reachedPersonhood") is False:
                out.append(fact("lost-membership-candidate", f"{c.names[p['id']]} was shown 'lost membership' but was already a candidate (standing {po.get('membership.standing')}, score before {cb.get('score')}, reached personhood {cb.get('reachedPersonhood')})", account=p["id"]))
    return out


def facts_votes(c):
    tot = collections.Counter()
    for acct, t in c.trails.items():
        for tgt, v in t["verdicts"].items():
            tot["verdicts"] += 1
            tot["person" if v.get("verdict") == "person" else "notperson"] += 1
            if v.get("verdict") != "person" and v.get("personTurns") == 0 and v.get("notPersonTurns") == v.get("autoTurns"):
                tot["default"] += 1
                if tgt not in c.seen.get(acct, set()):
                    tot["default-never-seen"] += 1
    out = []
    if tot["verdicts"]:
        out.append(fact("vote-defaults", f"{tot['verdicts']} verdicts in {len(c.trails)} vote trails: {tot['person']} Person, {tot['notperson']} NotPerson; {tot['default']} NotPersons were pure default (no Person turn, every NotPerson sealed by the timer), {tot['default-never-seen']} of them for co-players the reporter never got video from"))
    low = sorted((t["taps"], c.names.get(a)) for a, t in c.trails.items() if t["taps"] <= 2)
    if low:
        out.append(fact("few-taps", f"{len(low)} of {len(c.trails)} trail reporters tapped twice or less: " + ", ".join(f"{n} {k}" for k, n in low)))
    return out


INVARIANT_KINDS = ("payoff-without-join", "log-stops-before-payoff", "funnel-out-of-order", "recovery-hold-never-ends")


def invariant_hits(logs):
    """The broken-invariant lines each player's own log carries: one per kind per session
    (apps/jollity-app/lib/invariants.ts), so a repeat means a repeat in another session. `data` is the line's
    JSON payload when the log kept it."""
    out = {}
    for account, log in logs.items():
        for entry in log.get("entries", []):
            if entry.get("tag") != "invariant":
                continue
            kind = str(entry.get("message") or "").split(":", 1)[0].strip()
            if kind not in INVARIANT_KINDS:
                continue
            data = entry.get("data") if isinstance(entry.get("data"), dict) else {}
            out.setdefault(account, []).append({"kind": kind, "at": entry.get("ts"), "detail": data})
    return out


def facts_invariants(c):
    """One fact per invariant kind a player's own log reported (apps/jollity-app/lib/invariants.ts). A kind
    missing here is not proof the invariant held: the line only exists if the session that
    broke it still had its log delivered."""
    hits = invariant_hits(c.logs)
    if not hits:
        return []
    out = []
    for kind in INVARIANT_KINDS:
        accounts = sorted(a for a, rows in hits.items() if any(row["kind"] == kind for row in rows))
        if not accounts:
            continue
        occurrences = sum(1 for rows in hits.values() for row in rows if row["kind"] == kind)
        detail = next(row["detail"] for rows in hits.values() for row in rows if row["kind"] == kind and row["detail"])
        out.append(fact("invariant", f"invariant {kind} was reported {occurrences} time(s) by {len(accounts)} player(s): "
                       + ", ".join(c.names.get(a) or SHORT(a) for a in accounts)
                       + (": " + ", ".join(f"{k}={v}" for k, v in sorted(detail.items())) if detail else ""),
                       invariant=kind, accounts=accounts, occurrences=occurrences))
    return out


def facts_chain(c):
    if not c.chain:
        return [fact("chain-missing", "the chain was not read (--no-chain): no kickoff, registered list, votes or attestations.")]
    nm = lambda a: c.names.get(a)
    accts = c.chain["accounts"]
    att = [a for a in accts if a["attended"]]
    out = [fact("chain-outcome", f"{len(accts)} registered, {sum(1 for a in accts if a['sentReport'])} reported, {len(att)} {'provisionally attested (interim read, before the settle)' if c.chain.get('interim') else 'attested'}: " + ", ".join(tally(a, nm) for a in att))]
    if c.ties:
        out.append(fact("chain-ties", "ties (a tie loses): " + ", ".join(tally(a, nm) for a in c.ties)))
    return out + [fact("chain-warning", w) for w in c.chain.get("warnings", [])]


FACTS = [facts_bots, facts_overrides, facts_reported_no_telemetry, facts_reported_no_log, facts_backgrounded, facts_away_turns, facts_clock_skew,
         facts_span_clock_early, facts_other_builds, facts_lost_membership, facts_votes, facts_invariants, facts_chain, facts_nameless]


def facts_list(c):
    """The notable mechanical findings. A starting checklist for Claude, not the limit of what to look at."""
    return [f for fn in FACTS for f in fn(c)]


# --------------------------------------------------------------------------- assembling everything

def _english(items):
    items = [str(x) for x in items]
    if len(items) < 2:
        return "".join(items)
    if len(items) == 2:
        return " and ".join(items)
    return ", ".join(items[:-1]) + ", and " + items[-1]


def _metric(value):
    if value is None:
        return "n/a"
    if isinstance(value, float) and not value.is_integer():
        return f"{value:,.1f}"
    return f"{int(value):,}"


def _stage(doc, key):
    return next((row for row in doc.get("funnel", []) if row.get("key") == key), {})


def _player_name(doc, account):
    player = next((p for p in doc.get("players", []) if p.get("id") == account), {})
    return player.get("username") or account[:8]


def _release_label(doc):
    if doc.get("reportRelease"):
        return doc["reportRelease"]
    releases = collections.Counter(p.get("release") for p in doc.get("players", []) if p.get("release"))
    release = releases.most_common(1)[0][0] if releases else None
    if not release:
        return "unknown"
    if release in RELEASE_LABEL_BY_APP_HASH:
        return RELEASE_LABEL_BY_APP_HASH[release]
    result = subprocess.run(["git", "tag", "--points-at", release], cwd=REPO, capture_output=True, text=True)
    if result.returncode == 0:
        tags = [tag.strip() for tag in result.stdout.splitlines() if re.fullmatch(r"v?\d+\.\d+\.\d+", tag.strip())]
        if tags:
            return tags[-1].removeprefix("v")
    return release


def _no_show_sentence(doc):
    dropped = _stage(doc, "joined").get("dropped", [])
    if not dropped:
        return None
    grouped = collections.OrderedDict()
    for row in dropped:
        reason = (row.get("reason") or "reason unknown").removeprefix("no-show: ")
        grouped.setdefault(reason, []).append(_player_name(doc, row["account"]))
    priority = lambda reason: (0 if reason.startswith("last app activity") else
                               1 if reason.startswith("signed up from the chat") else
                               2 if reason.startswith("on chain") else 3)
    people = [f"{_english(grouped[reason])} ({reason})" for reason in sorted(grouped, key=priority)]
    return f"{len(dropped)} registered but never joined: {_english(people)}."


def pull_gaps(pull):
    """The Sentry queries that failed after their retries: per query, the players it failed for (None for a game-wide
    query). A partial pull must not look complete, so the summary and the issues name each gap."""
    per = collections.defaultdict(list)
    for account, player in sorted((pull or {}).get("players", {}).items()):
        for name in (player.get("queryErrors") or {}):
            per[name].append(account)
        if player.get("extrasError"):  # pulls saved before queryErrors
            per["link pairing or upload ladder"].append(account)
    gaps = [{"query": name, "players": accounts} for name, accounts in sorted(per.items())]
    gaps += [{"query": name, "players": None} for name in sorted(((pull or {}).get("pullErrors") or {}))]
    return gaps


def gap_line(gap):
    if gap["players"] is None:
        return f"- Gap: the {gap['query']} query failed; the figures it feeds are missing or incomplete."
    n = len(gap["players"])
    return f"- Gap: the {gap['query']} query failed for {n} player{'s' if n != 1 else ''}; their numbers are missing."


def _telemetry_lines(doc):
    reported = set(_stage(doc, "reported").get("accounts", []))
    full = set((doc.get("logCoverage") or {}).get("fullAccounts", []))
    complete = len(reported & full)
    lines = [gap_line(gap) for gap in doc.get("pullGaps") or []]
    lines.append(f"- {complete} of {len(reported)} reporters have their complete end-of-game log in Sentry.")
    health = [p.get("telemetryHealth") for p in doc.get("players", []) if p.get("id") in reported and p.get("telemetryHealth")]
    refusal_keys = ("dropped_events", "dropped_metrics", "failed_429", "failed_429_local", "failed_429_server", "failed_4xx", "failed_5xx", "limited_2xx")
    refused = sum(int(h.get(k) or 0) for h in health for k in refusal_keys)
    if health:
        lines.append(f"- Sentry rate-limit counters are present for {len(health)} reporters; they record {refused} refused or dropped uploads.")
    else:
        lines.append("- Sentry rate-limit counters are n/a.")
    return lines


REVIEW_SECTION = "Claude review (judgment only)"
REVIEW_SLOT = "- [Add game-specific interpretation after checking the raw evidence; do not edit generated facts above.]"


def section(title):
    """A summary section heading: a blank line, then the title in bold on its own line (the page renders it bold)."""
    return ["", f"**{title}**"]


def player_waterfall(doc):
    """The Players section (Ionut's items 2 and 19): who telemetry came from and who the counts follow, the waterfall from
    there to the players who finished, then where they dropped out. Returns (intro, waterfall, losses); report-lint checks
    the arithmetic."""
    total = len(doc.get("players", []))
    live, registered = _stage(doc, "live").get("count") or 0, _stage(doc, "registered").get("count") or 0
    # finished = filed the end-of-game report; the end-screen stage depends on payoff telemetry arriving, so it can sit below attested.
    joined, finished = _stage(doc, "joined").get("count") or 0, _stage(doc, "reported").get("count") or 0
    chat_only = total - live
    intro = (f"- We picked up telemetry from {total} players during the game window; {chat_only} had only the DIM2 chat running "
             f"and didn't register or use the app, so the counts below follow the {live} who did." if chat_only else
             f"- We picked up telemetry from {total} players during the game window; the counts below follow all of them.")
    waterfall = f"- {total} players → {live} used the app or signed up → {registered} registered → {joined} joined → {finished} finished."
    losses = [(live - registered, "didn't register"), (registered - joined, "registered but never joined"), (joined - finished, "joined but didn't finish")]
    shown = [f"{n} {text}" for n, text in losses if n]
    return intro, waterfall, ("- Where they dropped out: " + ", ".join(shown) + "." if shown else "- Nobody dropped out.")


def coding_line(kinds):
    """Item 13 in plain words, per platform: the platforms that report it (how many of their link samples, and which kind),
    then the ones that don't."""
    if not kinds:
        return "- Hardware or software video coding: not measured on this build."

    def said(counts):
        parts = [f"{counts['hardware']} hardware", f"{counts['software']} software"] + ([f"{counts['mixed']} switched mid-round"] if counts.get("mixed") else [])
        return ", ".join(parts)

    reporting, silent = [], []
    for row in kinds.get("byPlatform", []):
        enc, dec, n = row["encoding"], row["decoding"], row["samples"]
        reported = n - min(enc["unsupported"], dec["unsupported"])
        if not reported:
            silent.append(f"{row['platform']} doesn't report it ({n} link sample{'s' if n != 1 else ''})")
            continue
        on = f"on all {n} of its link samples" if reported == n else f"on {reported} of its {n} link samples"
        what = (f"{enc['hardware']} hardware encoding and decoding, {enc['software']} software"
                + (f", {enc['mixed']} switched mid-round" if enc.get("mixed") else "")
                if enc == dec else f"encoding {said(enc)}; decoding {said(dec)}")
        reporting.append(f"{row['platform']} reported it {on} ({what})")
    return "- Hardware or software video coding: " + "; ".join(reporting + silent) + "."


def _link_lines(video):
    paths = video.get("pathCounts") or {}
    route_labels = (("stun", "STUN"), ("relay", "TURN"), ("direct", "Direct"))
    path_line = ", ".join(f"{label} {paths.get(key, 0)}" for key, label in route_labels)
    if paths.get("unknown"):
        path_line += f", Unknown {paths['unknown']}"
    lines = [*section("Links"),
             f"- How links connected, counted once per phone per peer per round ({sum(paths.values())} link samples, so a pair can count twice): {path_line}.",
             f"- Video round-trip time between the two phones: {_metric(video.get('rttP50'))} ms for the typical pair, {_metric(video.get('rttP95'))} ms for the worst pair ({(video.get('worstRtt') or {}).get('label') or 'pair and round n/a'}).",
             f"- Packets lost: typical pair {_metric(video.get('lossP50'))} %, worst pair {_metric(video.get('lossP95'))} % (at its worst moments; {(video.get('worstLoss') or {}).get('label') or 'pair and round n/a'})."]
    worst = video.get("worstLink") or {}
    pairing = video.get("pairing") or {}
    fps, height = worst.get("fps"), worst.get("height")
    if fps or height:
        parts = []
        if fps:
            parts.append(f"the link with the lowest frame rate received {_metric(fps['received'])} frames per second while its sender sent {_metric(fps['sent'])}")
        if height:
            parts.append(f"the link with the smallest picture received {_metric(height['received'])} pixels high while its sender sent {_metric(height['sent'])}")
        samples = (fps or height)["samples"]
        partial = (pairing.get("partial") or {}).get("fps" if fps else "height", 0)
        line = (f"- Lowest rates, on the {samples} link directions both phones reported (one phone sending to another in one round): {'; '.join(parts)}.")
        above = pairing.get("receivedAboveSent") or {}
        noisy = [(kind, above[kind]) for kind in ("fps", "height") if (above.get(kind) or {}).get("links")]
        if noisy:
            what = lambda kind: "frame-rate" if kind == "fps" else "picture-height"
            unit = lambda kind: " frames per second" if kind == "fps" else " pixels"
            def clause(kind, row):
                whole = row["links"] - row["partialLinks"]
                parts = ([f"{row['partialLinks']} partly measured" if whole else ("both partly measured" if row["links"] == 2 else "all partly measured" if row["links"] > 2 else "partly measured")]
                         if row["partialLinks"] else [])
                if whole:
                    parts.append(f"{whole} over the whole round, by at most {_metric(row['maxGapWhole'])}{unit(kind)}")
                return f"{row['links']} {what(kind)} direction{'s' if row['links'] != 1 else ''} ({'; '.join(parts)})"
            line += " Received reads above sent on " + " and ".join(clause(kind, row) for kind, row in noisy) + "."
            line += " Each phone sends one median per round, so the two sides can't be lined up second by second."
        if partial:
            line = line.replace(" (one phone sending to another in one round)", f" (one phone sending to another in one round; {partial} of them partly measured, because one phone reloaded or opened late)")
        unknown = (pairing.get("spanUnknown") or {}).get("fps" if fps else "height", 0)
        if unknown:
            line = line.replace(" in one round", f" in one round; {unknown} where one phone's measured span is unknown", 1)
        lines.append(line)
    else:
        lines.append("- Lowest rates: n/a (no link direction was reported by both phones).")
    lines.append(f"- The worst pair-round had {_metric((video.get('freezeMs') or 0) / 1000)} s of frozen video ({(video.get('worstFreeze') or {}).get('label') or 'pair and round n/a'}).")
    limited = video.get("limitedSenders") or []
    by_reason = collections.defaultdict(lambda: collections.defaultdict(float))
    for row in limited:
        by_reason[row.get("reason") or "other"][row["name"]] += row["seconds"]
    bandwidth = by_reason.get("bandwidth") or {}
    line = (f"- The browser's own encoder lowered the video of {len(bandwidth)} senders because their upload bandwidth was short "
            f"(the browser's built-in limit, separate from our upload ladder below), {_metric(round(sum(bandwidth.values())))} s in total across their links"
            if bandwidth else "- The browser's own encoder lowered no sender's video for bandwidth")
    cpu = by_reason.get("cpu") or {}
    line += (f"; {len(cpu)} for the processor, {_metric(round(sum(cpu.values())))} s." if cpu else "; none for the processor.")
    lines.append(line)
    lines.append(coding_line(video.get("codecKinds")))
    return lines


def _recovery_phrase(recovery):
    kind = (recovery or {}).get("kind")
    seconds = (recovery or {}).get("seconds") or 0
    span = f"{seconds} s" if seconds < 600 else f"{round(seconds / 60)} min" if seconds < 7200 else f"{round(seconds / 3600)} h"
    if kind in ("self", "restart") and seconds >= 600:  # a long gap is an idle phone, not a slow recovery
        return f", next healthy chain probe {span} later" + (" after an app restart" if kind == "restart" else "")
    if kind == "self":
        return f", recovered by itself after {span}"
    if kind == "restart":
        return f", recovered after an app restart ({span})"
    return ", not seen recovering" if kind == "none" else ""


def _known_platform_error_lines(known):
    parts = []
    for bug in known.get("bugs", []):
        if not bug["count"]:
            parts.append(f"pb#{bug['number']} 0")
            continue
        occurrences = "; ".join(
            f"{row['name']} ({row['device']}; {row['host']}"
            + (f" build {row['hostBuild']}" if row.get('hostBuild') else "")
            + (f"; release {row['release']}" if row.get('release') else "")
            + f") {row['at']} ({row['detail']})" + _recovery_phrase(row.get("recovery")) for row in bug["occurrences"])
        parts.append(f"pb#{bug['number']} {bug['count']}: {occurrences}")
    window = known.get("window") or {}
    scope = known.get("scope")
    prefix = (f"Window {window['label']}; {scope}; " if window.get("label") and scope else "")
    return [*section("Known platform errors"), "- " + prefix + "; ".join(parts) + "."]


LOW_POWER_REASONS = {
    "probe-weak": "because the device check found the phone slow",
    "probe-weak-confirmed": "because a second check confirmed it",
    "probe-no-verdict": "because the device check could not reach a verdict",
    "debug-menu": "chosen in the debug menu",
    "url": "set by a link setting",
    "manual": "chosen by the player",
}


def low_power_line(low):
    players, count = low.get("players", 0), low.get("lowPower", 0)
    if not count:
        line = f"- None of the {players} players ran in low power mode"
    else:
        reasons = ", ".join(f"{row['players']} {LOW_POWER_REASONS.get(row['reason'], 'for ' + row['reason'].replace('-', ' '))}"
                            for row in low.get("reasons", [])) or "no reason recorded"
        line = f"- {count} of the {players} players ran in low power mode: {reasons}"
    if low.get("unknown"):
        line += f" (mode unknown for {low['unknown']})"
    return line + "."


def _buckets_text(distribution):
    rows = sorted(distribution.get("buckets", []), key=lambda row: -(row.get("value") or 0))  # largest picture or rate first
    if not distribution.get("samples") or not rows:
        return "not measured"
    return ", ".join(f"{row['count']} at {row['label'].replace(' px', '').replace(' fps', '')}" for row in rows)


def ladder_line(ladder):
    if not ladder:
        return "- Our upload ladder (the app's own five steps, full to survival): not measured on this build."
    lowest = ", ".join(f"{row['senders']} to {row['rung']}" for row in ladder["lowestRung"]) or "none"
    seconds = ", ".join(f"{row['rung']} {_metric(row['seconds'])} s" for row in ladder["secondsByRung"])
    stepped = (f"{ladder['steppedDown']} of {ladder['senders']} senders stepped down at least once (lowest step reached: {lowest})"
               if ladder["steppedDown"] else f"none of {ladder['senders']} senders stepped down")
    return f"- Our upload ladder (the app's own five steps, full to survival): {stepped}. Time on each step, all senders and rounds: {seconds}."


def _adaptation_lines(adaptations):
    picture = adaptations.get("picture") or {}
    received_height, sent_height = picture.get("receivedHeight") or {}, picture.get("sentHeight") or {}
    received_fps, sent_fps = picture.get("receivedFps") or {}, picture.get("sentFps") or {}
    return [*section("Performance adaptations"),
            low_power_line(adaptations.get("lowPower") or {}),
            ladder_line(adaptations.get("sendLadder")),
            f"- Picture height in pixels, on the same {received_height.get('samples', 0)} link directions as under Links: received {_buckets_text(received_height)}; sent {_buckets_text(sent_height)}.",
            f"- Frames per second, on the same {received_fps.get('samples', 0)} link directions: received {_buckets_text(received_fps)}; sent {_buckets_text(sent_fps)}."]


def draft_report_text(doc):
    """Draft every factual report sentence. Reviewers only replace the marked judgment slot."""
    reported = _stage(doc, "reported")
    intro, waterfall, losses = player_waterfall(doc)
    header = interim_header(doc)
    summary = [*([header, ""] if header else []), f"Game {doc.get('game')} on {doc.get('env') or 'unknown'}, kickoff {cest(parse_ts(doc['kickoff'])) + ' ' + tz_label(parse_ts(doc['kickoff'])) if doc.get('kickoff') else 'n/a'}, release {_release_label(doc)}.",
               *section("Players"), intro, waterfall, losses]
    no_show = _no_show_sentence(doc)
    summary += [*section("Telemetry"), *_telemetry_lines(doc), *section("Video")]
    coverage = (doc.get("coverage") or {}).get("coverage")
    summary.append(f"- Coverage {_metric(round(coverage))} %." if coverage is not None else "- Coverage n/a.")
    player_coverage = doc.get("playerCoverage") or {}
    if player_coverage.get("coverage") is not None:
        summary.append(f"- Players saw a live host on {_metric(round(player_coverage['coverage']))} % of their turns "
                       f"(median {_metric(round(player_coverage['median']))} %). The rest were empty seats "
                       f"{_metric(round(player_coverage['emptySeatsPct']))} %, no-shows "
                       f"{_metric(round(player_coverage['noShowsPct']))} %, and no video "
                       f"{_metric(round(player_coverage['noVideoPct']))} %.")
    summary.extend(line for line in (doc.get("coverageNote") or "").splitlines() if line.startswith("- "))
    summary += _link_lines(doc.get("video") or {})
    summary += _adaptation_lines(doc.get("adaptations") or {})
    summary += _known_platform_error_lines(doc.get("knownPlatformErrors") or {})
    summary += [*section(REVIEW_SECTION), REVIEW_SLOT]
    doc["summary"] = "\n".join(summary)

    issues = []
    gaps = doc.get("pullGaps") or []
    if gaps:
        issues.append({"severity": "bad", "title": "Partial Sentry pull",
                       "detail": " ".join(gap_line(gap).removeprefix("- Gap: ") for gap in gaps),
                       "action": "Rerun the report; if a query keeps failing, check Sentry's status and the query in game-report-pull.py."})
    if reported.get("count"):
        full = len(set(reported.get("accounts", [])) & set((doc.get("logCoverage") or {}).get("fullAccounts", [])))
        issues.append({"severity": "good" if full == reported.get("count") else "warn", "title": "End-of-game log coverage",
                       "detail": f"{full} of {reported.get('count')} reporters have a complete end-of-game log in Sentry.",
                       "action": "Review missingReasons and the raw logs before publishing." if full != reported.get("count") else "Keep monitoring future games."})
    if no_show:
        issues.append({"severity": "warn", "title": f"{len(_stage(doc, 'joined').get('dropped', []))} registered players never joined",
                       "detail": no_show, "action": "Review each account's registration and app evidence."})
    defaults = next((f for f in doc.get("facts", []) if f.get("kind") == "vote-defaults"), None)
    if defaults:
        issues.append({"severity": "warn", "title": "Timer-default NotPerson verdicts", "detail": defaults["text"],
                       "action": "Review alongside link coverage and game-specific product issues."})
    for bug in (doc.get("knownPlatformErrors") or {}).get("bugs", []):
        if bug.get("count"):
            doc_rows = ", ".join(f"{row['name']} {row['at']} ({row['detail']})" for row in bug["occurrences"])
            issues.append({"severity": "warn", "title": f"platform-bugs #{bug['number']} recurred ({bug['count']})",
                           "detail": doc_rows, "action": f"Review and update platform-bugs #{bug['number']}."})
    doc["issues"] = issues

def assemble(game, pull, chain, links, logs, any7, kickoff_override=None, mapping=None, windows=None, release_label=None):
    """The report document from the pull, the chain reader's JSON, links.json and the parsed logs."""
    tr = {a: t for a, lg in logs.items() if (t := vote_trail(lg))}
    seen = {a: seen_accounts(lg) for a, lg in logs.items()}
    kickoff = chain["kickoff"] if chain else kickoff_override
    kdt = parse_ts(kickoff) if kickoff else None
    chain_by = {a["account"]: a for a in chain["accounts"]} if chain else {}
    joined_logs = {a: min(m) for a, lg in logs.items() if (m := game_mesh_opens(lg, game))}
    windows3 = report_windows(chain, pull)
    live_win = (windows3.start, windows3.end) if windows3 else None
    signup_win = (windows3.signup_from, windows3.end) if windows3 else None
    # the pull holds the chain's accounts, the tagged ones and the room keys', read from registration opening; an account that
    # is not on chain and only sent the previous game's payoff traffic (before live_win, no sign-up) is not in this report
    live_ev = {a: live_evidence(p, live_win, signup_win) for a, p in pull["players"].items()}
    accounts = sorted(a for a in pull["players"] if live_ev[a]["any"] or a in chain_by or a in joined_logs)
    reg_by = registration_by_account(chain)
    page_win = game_page_window(chain, pull)
    players = build_players(accounts, pull, chain_by, logs, tr, any7, joined_logs, mapping, reg_by, page_win)
    names = {p["id"]: p["username"] for p in players}
    sub = pull["players"]
    real = {a: p for a, p in sub.items() if not p.get("bot")}  # bots stay out of smoothness and video

    def has(a, op):
        return any(r.get("span.op") == op for r in sub[a].get("roots", []))

    if chain:
        registered = set(chain_by)
    else:  # no chain: a landed sign-up, or anyone who got as far as joining (which needs a seat)
        registered = {a for a in accounts if has(a, "journey.join") or has(a, "journey.game") or a in joined_logs
                      or any(r.get("span.op") == "journey.game-signup" and r.get("journey.outcome") in ("landed", "sent") for r in sub[a].get("roots", []))}
    # the person did something: opened the app, attempted a sign-up from the chat, or is on chain for this game (chain registration is the person's act)
    live = {a for a in accounts if a in registered or (live_ev[a]["any"] and (live_ev[a]["app"] or live_ev[a]["chatSignup"]))}
    chat_idle = sorted(a for a in accounts if live_ev[a]["any"] and a not in live)
    # the same cut as the link view, so the funnel and the links agree on who joined
    funnel_windows = play_windows(chain["record"], clock_lag(logs.values(), chain["record"])) if chain else None
    joined = game_presence_accounts(game, pull, chain, logs, rounds_presence_window(page_win, funnel_windows))
    played = {a for a in accounts if has(a, "journey.game") and not any(
        stopped in ((journey(sub[a].get("roots", []), "journey.game") or {}).get("outcome") or "").split(", then ")
        for stopped in ("abandoned", "isolated"))}
    reg_ends = (chain or {}).get("record", {}).get("registrationEnds")
    registration_close = datetime.datetime.fromtimestamp(float(reg_ends), datetime.timezone.utc) if reg_ends is not None else None
    why = lambda stage, a: funnel_reason(stage, a, sub[a], chain_by.get(a), kdt, ties_by_acct(chain), registration_close)
    note = window_note(windows3) if windows3 else ""
    pay = lambda a: sub[a].get("payoff") or {}
    humanity = {a for a in accounts if step_ended(sub[a], HUMANITY_STEP) or pay(a).get("membership.humanity") == "opened"}
    seen_draw = {a for a in accounts if step_ended(sub[a], "payoff.draw.show")}
    inv = sum(1 for a in seen_draw if pay(a).get("draw.invited") == "true")
    won = sum(1 for a in seen_draw if pay(a).get("draw.won") == "true")
    fn = funnel(live, {a for a in accounts if live_ev[a]["app"]}, registered, [
        ("joined", "joined the game", joined, "Any telemetry from or about this player during the game, or a report on chain.", True),
        ("played", "played every round", played, "Has a completed game journey.", True),
        ("reported", "report on chain", {a for a, c in chain_by.items() if c["sentReport"]}, "The chain holds this account's report.", True),
        ("attested", "report attested" + (" (provisional)" if chain and chain.get("interim") else ""), {a for a, c in chain_by.items() if c["attended"]}, ("The rule of the pallet, applied to the votes read so far, marks this account as attended" if chain and chain.get("interim") else "The chain marks this account as attended") + " (it reported, and its yes votes less 1, stopping at 0, reach its no votes).", True),
        ("draw", "saw the prize draw", seen_draw,
         f"The payoff journey's draw.show step ended (a draw the account was not entered in also ends it; draw.reason says why). Of these, {inv} invited (draw.invited true), {won} won (draw.won true). Counted within the attested accounts.", True),
        ("chest", "opened the chest", {a for a in accounts if step_ended(sub[a], "payoff.chest.show")},
         "The payoff journey's chest.show step ended (chest.outcome and chest.reason say what it showed).", True),
        ("endscreen", "finished the payoff", {a for a in accounts if payoff_shown(sub[a])},
         "The payoff journey ended 'shown': on the membership card in builds that had one, at the chest's hand-off to Humanity since.", True),
        ("humanity", "proceeded to Humanity", humanity,
         "Not measured yet (app telemetry pending)." if not humanity else "A payoff humanity.open step, or membership.humanity opened.", bool(humanity)),
    ], why, note, outside=sorted(registered - live), chat_signup={a for a in accounts if live_ev[a]["chatSignup"]})
    ctx_idle = {"label": "had the DIM2 chat running but did nothing", "count": len(chat_idle), "accounts": chat_idle,
                "note": "Only chat-worker telemetry in the window (the host runs the worker on its own); not part of the funnel.",
                "activity": {a: chat_activity(live_ev[a]["chatRoots"]) for a in chat_idle}}
    table = funnel_table(fn, ctx_idle)
    if chain and chain.get("interim"):
        for row in table["rows"]:
            if row.get("key") == "attested":
                row["stage"] += " (provisional)"
    stage_of = funnel_stage_by_account(fn)
    drop_of = {d["account"]: d["reason"] for st in fn for d in st["dropped"]}
    for p in players:
        p["funnelStage"] = stage_of.get(p["id"]) or (ctx_idle["label"] if p["id"] in set(chat_idle) else None)
        if p["id"] in drop_of:
            p["funnelDrop"] = drop_of[p["id"]]
    overrides = override_effects(tr, chain_by)
    ties = tied(chain["accounts"]) if chain else []
    envs = collections.Counter(r.get("environment") for p in (real or sub).values() for r in p.get("roots", []) if r.get("environment") and r.get("game.index") not in (None, ""))
    peer_all = [fnum(s.get("span.duration")) for p in sub.values() for s in p.get("steps", []) if s.get("span.op") == "join.peer.all"]
    groups = group_votes(chain, names) if chain else None
    metric_windows = windows or (play_windows(chain["record"], clock_lag(logs.values(), chain["record"])) if chain else None)
    error_window = platform_error_window(chain, pull, kdt)
    known_errors = known_platform_errors(sub, logs, players, registered | joined, error_window)
    metric_links = coverage_links_from_metrics(game, links, groups, sub, metric_windows, pull.get("sliceReleases")) if chain else None
    cov_breakdown = coverage_breakdown(metric_links, groups, reg_by, sub, game) if chain else None
    coverage_rounds = (chain or {}).get("record", {}).get("rounds") or 0
    has_coverage_seats = chain and all(len(row.get("groups", [])) >= coverage_rounds
                                       and len(row.get("positions", [])) >= coverage_rounds
                                       for row in chain.get("accounts", []))
    player_coverage = player_host_coverage(chain, joined, logs, links, metric_windows, names) if has_coverage_seats else None
    log_coverage = full_log_coverage(chain, sub)
    ctx = Ctx(players=players, chain=chain, chain_by=chain_by, ties=ties, trails=tr, overrides=overrides, logs=logs,
              pull=pull, links=links, kickoff=kdt, seen=seen, joined=joined)
    if links and links.get("players"):  # a player with no game log has no name in links; the report's own list has it
        links = {**links, "players": [{**lp, "username": lp.get("username") or names.get(lp.get("account"))} for lp in links["players"]]}
    video = video_block(real, names)
    directions = link_directions(real, full_rounds(real))
    video["table"] = video_table(real, video, directions)
    video["codecKinds"] = codec_kinds(real, {p["id"]: p.get("os") for p in players})
    video["worstLink"] = worst_link(directions)
    video["pairing"] = {"rule": "every link direction both phones reported; partial = one phone's round step under 90 % of the round's median (a reload or a late open)",
                        "samples": {kind: len(directions[kind]) for kind in ("fps", "height")},
                        "partial": directions["partial"], "spanUnknown": directions["spanUnknown"], "receivedAboveSent": directions["receivedAboveSent"]}
    doc = {
        "game": game, "env": envs.most_common(1)[0][0] if envs else None, "kickoff": kickoff,
        "timesNote": times_note(kdt) if kdt else "All times are Central European Time.",
        "reportRelease": release_label,
        "reportWindow": ({"from": windows3.signup_from.isoformat(), "evidenceFrom": windows3.start.isoformat(), "to": windows3.end.isoformat(),
                          "label": note} if windows3 else None),
        "stageDeadlines": {"registered": registration_close.isoformat() if registration_close else None,
                           "joined": kdt.isoformat() if kdt else None},
        "summary": None, "issues": None,
        "facts": facts_list(ctx),
        "knownPlatformErrors": known_errors,
        "funnel": fn,
        "funnelTable": table,
        "funnelChatIdle": ctx_idle,
        "join": {"peerAllMs": round(median(peer_all)) if peer_all else None},
        "players": players,
        "groups": groups,
        "voteTrails": {a: {**{k: t[k] for k in ("taps", "turns", "defaults", "filedBy")},
                           "builtAt": t["built"], "signedAt": t["signed"], "overrides": t["overrides"]} for a, t in tr.items()},
        "failures": failure_groups(sub, names),
        "video": video,
        "adaptations": adaptations_block(real, players, video, joined, directions),
        "smoothness": smoothness_rows(real, names),
        "steps": step_rows(sub, names),
        "payoffFacts": payoff_facts(chain, ties, tr, names, overrides, logs, fn, log_coverage),
        "logCoverage": log_coverage,
        "links": links,
        "coverage": cov_breakdown,
        "playerCoverage": player_coverage,
        "coverageNote": coverage_note(cov_breakdown, cov_breakdown and cov_breakdown.get("webOnly")),
        "pullGaps": pull_gaps(pull),
        "storyline": storyline(pull, chain, names, windows3, metric_windows, joined,
                               {d["account"]: (st["key"], st["stage"], d["reason"]) for st in fn for d in st["dropped"]}),
    }
    draft_report_text(doc)
    return doc


PUBLISH_REPORT_FIELDS = {
    "adaptations", "coverage", "coverageNote", "dataAsOf", "env", "funnel",
    "funnelTable", "game", "groups", "issues", "join", "kickoff",
    "notificationFunnel", "payoffFacts", "players", "pullGaps", "smoothness", "storyline",
    "knownPlatformErrors", "reportWindow", "steps", "summary", "video",
}

# This is the page's explicit data contract. A lint failure is intentional when
# the page starts reading a new report field: add it here, then decide whether it
# belongs in PUBLISH_REPORT_FIELDS rather than silently bloating every document.
PAGE_REPORT_FIELDS = {
    "adaptations", "chatOnlyCount", "coverage", "coverageNote", "dataAsOf",
    "env", "funnel", "funnelTable", "game", "groups", "issues", "join",
    "kickoff", "links", "linksDoc", "notificationFunnel", "payoffFacts",
    "players", "pullGaps", "reportWindow", "smoothness", "steps", "storyline", "summary", "video",
}

PUBLISH_PLAYER_FIELDS = {
    "device", "draw", "game", "host", "hostBuild", "id", "join", "label",
    "os", "payoff", "signup", "telemetry", "username",
}


def publish_contract_errors():
    available = PUBLISH_REPORT_FIELDS | {"chatOnlyCount", "links", "linksDoc"}
    return [f"page reads unpublished report field {field!r}" for field in sorted(PAGE_REPORT_FIELDS - available)]


def _short_link_accounts(links):
    """Replace repeated account strings with indexes into one account table."""
    if not links:
        return links
    accounts = []
    indexes = {}

    def short(account):
        if account is None:
            return None
        if account not in indexes:
            indexes[account] = len(accounts)
            accounts.append(account)
        return indexes[account]

    compact = {"game": links.get("game")}
    compact["players"] = [
        {**player, "account": short(player.get("account"))}
        for player in links.get("players", [])
    ]
    compact["matrix"] = [
        {**row, "a": short(row.get("a")), "b": short(row.get("b"))}
        for row in links.get("matrix", [])
    ]
    compact["timeline"] = [
        {**row, "viewer": short(row.get("viewer")), "peer": short(row.get("peer"))}
        for row in links.get("timeline", [])
    ]
    compact["events"] = [
        {**row, "account": short(row.get("account")),
         **({"peer": short(row.get("peer"))} if row.get("peer") is not None else {})}
        for row in links.get("events", [])
    ]
    compact["rounds"] = [
        {**row,
         **({"room": [short(account) for account in row["room"]]} if row.get("room") is not None else {}),
         **({"rooms": [[short(account) for account in room] for room in row["rooms"]]} if row.get("rooms") is not None else {})}
        for row in links.get("rounds", [])
    ]
    compact["accounts"] = accounts
    return compact


def publish_documents(doc):
    """Build the two small page documents without changing the full local report."""
    errors = publish_contract_errors()
    if errors:
        raise ValueError("report lint failed:\n- " + "\n- ".join(errors))
    game = doc["game"]
    live_accounts = set(next((row.get("accounts", []) for row in doc.get("funnel", []) if row.get("key") == "live"), []))
    published_players = [
        {key: player[key] for key in PUBLISH_PLAYER_FIELDS if key in player}
        for player in doc.get("players", []) if player.get("id") in live_accounts
    ]
    primary = {key: doc[key] for key in PUBLISH_REPORT_FIELDS if key in doc}
    primary.update({
        "players": published_players,
        "chatOnlyCount": max(0, len(doc.get("players", [])) - len(published_players)),
        "links": None,
        "linksDoc": f"g{game}-links",
    })
    companion = {"kind": "game-links", "game": game, "links": _short_link_accounts(doc.get("links"))}
    return primary, companion


def full_log_coverage(chain, pull_players):
    """Summarise full logs, recovered chunks and honest missing-log reasons."""
    if not chain:
        return None
    accounts = [account["account"] for account in chain.get("accounts", [])]
    def is_full(account):
        meta = pull_players.get(account, {}).get("log")
        if not meta:
            return False
        return meta.get("full") if "full" in meta else meta.get("stage") != "report"
    full_accounts = [account for account in accounts if is_full(account)]
    full = len(full_accounts)
    chunks = sum(1 for account in accounts if (pull_players.get(account, {}).get("log") or {}).get("chunks"))
    reasons = []
    for account in accounts:
        meta = pull_players.get(account, {}).get("log")
        if is_full(account):
            continue
        if meta and meta.get("chunks"):
            gaps = meta.get("missingSeqs") or []
            parts = meta.get("missingParts") or []
            evicted = meta.get("evictedOnDevice") or []
            if evicted:
                labels = ", ".join(f"game {item.get('gameIndex')} chunk {item.get('id')}" for item in evicted)
                reasons.append({"account": account, "reason": f"evicted on device: {labels}"})
            elif parts:
                missing = ", ".join(f"{part.get('seq')}:{part.get('part')}" for part in parts)
                reasons.append({"account": account, "reason": f"missing chunk parts: {missing}"})
            else:
                reasons.append({"account": account, "reason": "chunk sequence gaps: " + ", ".join(map(str, gaps)) if gaps else "full log missing; recovered from chunks"})
        elif meta and meta.get("stage") == "report":
            reasons.append({"account": account, "reason": "only the report-stage safety copy arrived"})
        else:
            reasons.append({"account": account, "reason": "no full log or chunk arrived"})
    return {"players": len(accounts), "fullLogs": full, "fullAccounts": full_accounts,
            "chunkLogs": chunks, "missingReasons": reasons}


def payoff_facts(chain, ties, trails, names, overrides, logs, fn, log_coverage=None):
    """The 'payoffFacts' label to text map, mechanical parts only."""
    nm = lambda a: names.get(a) or SHORT(a)
    pf = {"Funnel": " → ".join(f"{'not measured' if s['count'] is None else s['count']} {s['stage']}" for s in fn)}
    if chain:
        rec, accts = chain["record"], chain["accounts"]
        att = [a for a in accts if a["attended"]]
        pf["Groups"] = f"{rec['groups']} groups of up to {rec['maxGroupSize']} over {rec['rounds']} rounds; group = position in PlayerToIndex mod {rec['groups']}"
        pf["Votes on chain (for/against), attested"] = " · ".join(tally(a, nm) for a in att) or "none"
        pf["Votes on chain, ties (a tie loses)"] = " · ".join(tally(a, nm) for a in ties) or "none"
        rest = sorted((a for a in accts if not a["attended"] and a not in ties), key=lambda a: (-a["yesPerson"], a["noNotPerson"]))
        pf["Votes on chain, the rest"] = " · ".join(tally(a, nm) for a in rest)
        pf["Vote weight"] = "a co-player shared in both rounds counts twice; expectedMaxVoteWeight on chain: " + ", ".join(sorted({str(a['expectedMaxVoteWeight']) for a in accts}))
        changes = [f"{nm(a['account'])} {(a.get('scoreBefore') or {}).get('score')} → {(a.get('scoreAfter') or {}).get('score')}" for a in att]
        absent_n = len(accts) - len(att)
        pf["Score changes"] = " · ".join(changes) + (f" · {absent_n} others stay absent" if absent_n else "")
        pf["Prize draw"] = "; ".join(f"{len(d['winners'])} winner(s): " + ", ".join(nm(w) for w in d["winners"]) + f" ({d['tickets']} tickets)" for d in chain["draws"]) or "no draw scheduled"
        s = chain.get("settlement")
        rt = [a["reportTime"] for a in accts if a.get("reportTime")]
        if rt:
            pf["Settlement"] = f"reports landed {cest(parse_ts(min(rt)), True)}–{cest(parse_ts(max(rt)), True)} (block times); " + (f"GameEnded in block {s['block']} at {cest(parse_ts(s['time']), True)}" if s else "no GameEnded block found")
    if trails:
        filed = collections.Counter(t["filedBy"] for t in trails.values())
        pf["Who filed how"] = ", ".join(f"{n} by {k}" for k, n in filed.most_common()) + f" (of {len(trails)} vote trails)"
        pf["Taps per reporter"] = " · ".join(f"{nm(a)} {t['taps']}" + (f" ({t['turns']} turns)" if t["turns"] != 12 else "") for a, t in sorted(trails.items(), key=lambda kv: -kv[1]["taps"]))
        kept = [f"{nm(a)} on {nm(o['target'])} ({o['verdict']})" for a, t in trails.items() for o in t["overrides"] if not o["late"]]
        pf["Confirm-screen overrides"] = ("kept: " + " · ".join(kept) if kept else "none kept") + " · lost (after the build): " + (" · ".join(f"{nm(o['reporter'])} on {nm(o['target'])} (+{o['sAfterBuild']} s)" for o in overrides) or "none")
    pf["Game logs"] = f"{len(logs)} logs: " + " · ".join(f"{nm(a)} {len(lg['entries'])}" for a, lg in sorted(logs.items(), key=lambda kv: nm(kv[0])))
    if log_coverage:
        recovered = log_coverage.get("chunkLogs", 0)
        missing = len(log_coverage.get("missingReasons", []))
        pf["Log coverage"] = (f"{log_coverage['fullLogs']} of {log_coverage['players']} players have a full log; "
                              f"{recovered} have durable chunks; {missing} lack a full log (reasons listed in report data)")
    pf["Moments of the round"] = ("frame time per part of a turn: intro (host intro), play, turned (a tile voted), warn (auto-reject countdown), ending (the 2 s ending stage), gap (between rounds). "
                                  "Rows show the median typical frame and the median worst frame per device type")
    pf["Video numbers"] = "worst across players and peers, except round-trip p50 and kbps (the median)"
    return pf


# --------------------------------------------------------------------------- orchestration (network)

def sentry_window(game, pad_before=20, pad_after=10):
    """(start, end) from the first and last game.index event (spans and errors), padded; (None, None) when Sentry has none.
    Only used without the chain, which gives the window directly.

    A 90-day query only finds the day (Sentry samples long ranges: the first span came back 30
    minutes late), so the exact first and last come from a second query a day either side.
    """
    q = f"game.index:{game} !has:test.tag"
    rough = []
    for ds in ("spans", "errors"):
        for sort in ("timestamp", "-timestamp"):
            rough += [parse_ts(r["timestamp"]) for r in sentry.events(ds, q, ["timestamp"], sort=sort, per_page=1, period="90d")]
    if not rough:
        return None, None
    fmt = lambda d: d.strftime("%Y-%m-%dT%H:%M:%S")
    lo, hi = min(rough) - datetime.timedelta(hours=12), max(rough) + datetime.timedelta(hours=12)
    firsts, lasts = [], []
    for ds in ("spans", "errors"):
        for sort, bucket in (("timestamp", firsts), ("-timestamp", lasts)):
            bucket += [parse_ts(r["timestamp"]) for r in sentry.events(ds, q, ["timestamp"], sort=sort, per_page=1, start=fmt(lo), end=fmt(hi))]
    return min(firsts) - datetime.timedelta(minutes=pad_before), max(lasts) + datetime.timedelta(minutes=pad_after)


def registration_start(chain):
    """When registration opened on chain, less REG_SLACK_MIN; None when the chain reader could not find it."""
    return parse_ts(chain["registrationOpens"]) - datetime.timedelta(minutes=REG_SLACK_MIN) if chain.get("registrationOpens") else None


def chain_window(chain, pad_before=None):
    """Registration opened (the chain's block where the game was scheduled) to settlement (the GameEnded block time) + PAYOFF_MIN.

    pad_before (minutes before kickoff) overrides the start. Without a settlement block the end is kickoff + 25 min;
    without a registration time the start is kickoff - 20 min.
    """
    kd = parse_ts(chain["kickoff"])
    st = settle_time(chain) or kd + datetime.timedelta(minutes=15)
    if pad_before is not None:
        start = kd - datetime.timedelta(minutes=pad_before)
    else:
        start = registration_start(chain) or kd - datetime.timedelta(minutes=20)
    return start, st + (end_margin(chain) if settle_time(chain) else datetime.timedelta(minutes=PAYOFF_MIN))


def run_chain(game, out, ws=None, interim=False):
    """Runs the chain reader and returns its JSON. Raises RuntimeError with the tail of its output when it fails.

    interim: read the votes as of kickoff + 3 min, before the 1-hour settle (the chain JSON then has interim true and no settlement)."""
    cmd = ["npx", "tsx", "scripts/game-chain-report.mts", str(game), "--out", out] + (["--ws", ws] if ws else []) + (["--interim"] if interim else [])
    r = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(out):
        raise RuntimeError("the chain reader failed:\n" + "\n".join((r.stdout + r.stderr).strip().splitlines()[-8:]))
    return json.load(open(out))


@dataclasses.dataclass
class StoreRun:
    directory: str
    manifest: dict
    source: object
    chain_json: str
    sibling_usernames: dict


def _load_store_source():
    """The DuckDB reader is optional for ordinary live reports."""
    import store_source
    return store_source


@contextlib.contextmanager
def from_store(game, root=None, load_sibling_usernames=True):
    """Route a report through one passing stored game, and always restore live reads."""
    directory = store_paths.game_dir(game, root=root)
    manifest_path = os.path.join(directory, "manifest.json")
    try:
        with open(manifest_path, encoding="utf-8") as fh:
            manifest = json.load(fh)
    except (OSError, ValueError) as error:
        sys.exit(f"--from-store manifest is missing or unreadable: {manifest_path}: {error}")
    if manifest.get("pass") is not True:
        sys.exit(f"--from-store manifest did not pass: {manifest_path}")
    projects = list((manifest.get("projects") or {}).keys())
    if not projects:
        sys.exit(f"--from-store manifest has no projects: {manifest_path}")
    previous_projects = list(sentry.PROJECT_SLUGS)
    sentry.use_project(",".join(projects))
    source = None
    try:
        sibling_usernames = gl.usernames_under(store_paths.game_logs_root()) \
            if load_sibling_usernames else None
        try:
            module = _load_store_source()
            source = module.StoreSource(game, root=root)
        except ImportError:
            sys.exit("--from-store needs the skill venv: .claude/skills/dim2-sentry/.venv/bin/python")
        sentry.use_source(source)
        run = StoreRun(
            directory=directory,
            manifest=manifest,
            source=source,
            chain_json=os.path.join(directory, "chain.json"),
            sibling_usernames=sibling_usernames,
        )
        yield run
    finally:
        sentry.use_source(None)
        try:
            if source is not None:
                source.close()
        finally:
            sentry.use_project(",".join(previous_projects))


def _parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("game", type=int)
    ap.add_argument("--out", help="the full local report (default docs-internal/game-reports/g<N>/report.json)")
    ap.add_argument("--logs-dir", help="where the game logs go (default docs-internal/game-logs/game-<N>)")
    ap.add_argument("--usernames", default=USERNAMES,
                    help="account-to-username JSON (default: shared telemetry-store/usernames.json)")
    ap.add_argument("--sibling-usernames", help="account-to-username JSON for game-links")
    ap.add_argument("--chain-json", help="use this chain JSON instead of running the chain reader")
    ap.add_argument("--no-log-cache", action="store_true", help="download logs even when cached files exist")
    ap.add_argument("--ws", help="chain archive RPC (default: PEOPLE_WS, else the chain script's own default)")
    ap.add_argument("--pad-before", type=int, help="override: start the Sentry window this many minutes before kickoff (default: when registration opened, from the chain)")
    ap.add_argument("--interim", action="store_true", help="read the chain as of kickoff + 3 min, before the 1-hour settle: an interim report with provisional attestation (not with --chain-json)")
    ap.add_argument("--no-chain", action="store_true", help="skip the chain reader (no kickoff, votes or attestations)")
    ap.add_argument("--project",
                    help="the Sentry project(s) to read, a comma list: dim2-testing (which also reads jollity-next) for a game with bots that carried the test DSN (default: DIM2_SENTRY_PROJECT, else jollity-next)")
    ap.add_argument("--release-label", help="human release label for the generated headline, for example 0.1.37")
    ap.add_argument("--from-store", action="store_true", help="read telemetry from the local frozen store")
    ap.add_argument("--store-root", help="telemetry store root (default: DIM2_TELEMETRY_STORE, else the main checkout)")
    a = ap.parse_args(argv)
    if a.store_root and not a.from_store:
        ap.error("--store-root requires --from-store")
    if a.from_store and a.no_chain:
        ap.error("--from-store always uses the stored chain.json; --no-chain is unsupported")
    return a


def set_data_as_of(doc, store_run):
    """Stamp stored reports with the manifest's already-local snapshot time."""
    if store_run is not None:
        doc["dataAsOf"] = store_run.manifest["data_as_of_local"]


def validate_chain_input(chain_json, outdir):
    """Refuse a frozen input that this run would overwrite with chain.json."""
    if not chain_json:
        return
    source = os.path.abspath(chain_json)
    output = os.path.abspath(outdir)
    if os.path.commonpath([source, output]) == output:
        raise ValueError("--chain-json must point outside the report output directory")


def _run_report(a, store_run=None):
    if a.project and not store_run:
        sentry.use_project(a.project)
    g = a.game
    out = os.path.abspath(a.out or os.path.join(REPO, "docs-internal", "game-reports", f"g{g}", "report.json"))
    outdir = os.path.dirname(out)
    validate_chain_input(a.chain_json, outdir)
    logs_dir = os.path.abspath(a.logs_dir or os.path.join(REPO, "docs-internal", "game-logs", f"game-{g}"))
    os.makedirs(outdir, exist_ok=True)
    if not a.out and not os.path.exists(os.path.join(outdir, ".gitignore")):
        open(os.path.join(outdir, ".gitignore"), "w").write("*\n")  # the pull is large and holds raw telemetry: keep it out of git

    chain = None
    if a.no_chain:
        print(f"game {g}: no chain; finding the window in Sentry...", flush=True)
        w0, w1 = sentry_window(g, pad_before=a.pad_before if a.pad_before is not None else 20)
        if not w0:
            sys.exit(f"Sentry has no events for game {g}; nothing to build a window from.")
    elif a.chain_json:
        print("reading the supplied chain JSON...", flush=True)
        chain_out = os.path.join(outdir, "chain.json")
        shutil.copyfile(a.chain_json, chain_out)
        with open(chain_out, encoding="utf-8") as fh:
            chain = json.load(fh)
        provisional_attendance(chain)
        w0, w1 = chain_window(chain, a.pad_before)
    else:
        print("reading the chain (archive node)...", flush=True)
        try:
            chain = run_chain(g, os.path.join(outdir, "chain.json"), a.ws, a.interim)
        except RuntimeError as e:
            sys.exit(str(e))
        provisional_attendance(chain)
        w0, w1 = chain_window(chain, a.pad_before)
    fmt = lambda d: d.strftime("%Y-%m-%dT%H:%M:%S")
    print(f"window {fmt(w0)} to {fmt(w1)} UTC; pulling Sentry (this is the slow part)...", flush=True)
    logs, log_meta = puller.fetch_logs(g, fmt(w0), fmt(w1), logs_dir,
                                       use_cache=not a.no_log_cache)
    pull = puller.pull(g, fmt(w0), fmt(w1), extra_accounts=[x["account"] for x in chain["accounts"]] if chain else [], logs=logs, log_meta=log_meta,
                       untagged_from=fmt(registration_start(chain)) if chain and registration_start(chain) else None)
    roster = set(pull.get("players") or {}) | ({x["account"] for x in chain["accounts"]} if chain else set())
    expanded = expand_pair_ids(pull, g, roster) + expand_pair_ids(logs, g, roster)
    if expanded:
        print(f"rtc.pair: {expanded} hashed ids matched to their accounts", flush=True)
    json.dump(pull, open(os.path.join(outdir, "sentry-pull.json"), "w"), indent=1, default=str)

    print("link picture...", flush=True)
    windows = play_windows(chain["record"], clock_lag(logs.values(), chain["record"])) if chain and logs else None
    sibling_names = gl.read_json(a.sibling_usernames) if a.sibling_usernames else \
        (store_run.sibling_usernames if store_run else None)
    joined_for_links = game_presence_accounts(g, pull, chain, logs, rounds_presence_window(game_page_window(chain, pull), windows))
    links = gl.analyse(logs_dir, logs=logs,
                       chain_groups=chain_group_accounts(chain) if chain else None,
                       play_windows=windows, names=sibling_names,
                       joined_accounts=joined_for_links) if logs else None
    if links:
        for target in {os.path.join(logs_dir, "links.json"), os.path.join(outdir, "links.json")}:
            json.dump(links, open(target, "w"), indent=1)

    mapping = load_usernames(a.usernames)
    try:
        history = history_usernames(pull, mapping, fmt(w1))
    except sentry.OutOfStore:
        raise
    except Exception as e:  # the report stands without it
        print("username lookup failed:", e, file=sys.stderr)
        history = {}
    if history:
        mapping = {**mapping, **history}
        save_usernames(a.usernames, mapping)
        print(f"usernames: found {len(history)} more in the last 30 days of Sentry, saved to {a.usernames}")
    doc = assemble(g, pull, chain, links, logs, {}, mapping=mapping, windows=windows, release_label=a.release_label)
    set_data_as_of(doc, store_run)
    stage = {st["key"]: set(st["accounts"]) for st in doc["funnel"]}
    window = {"from": w0.isoformat(), "to": w1.isoformat(), "openedAt": cest(w0), "closedAt": cest(w1)}
    try:
        notif_rows = notification_rows(doc["env"], fmt(w0), fmt(w1))
        host_events = None  # older stored games have no host_reminders.json: the stage stays "not measured"
        if store_run:
            host_file = os.path.join(store_run.directory, "host_reminders.json")
            if os.path.exists(host_file):
                with open(host_file, encoding="utf-8") as fh:
                    host_events = json.load(fh)
        else:
            try:
                host_events = sentry.host_reminder_events(fmt(w0 - datetime.timedelta(hours=24)), fmt(w1))  # phones book at registration, often the evening before
            except (Exception, SystemExit) as e:  # no token or a failed pull: the stage stays "not measured"
                print("host reminder events failed:", e, file=sys.stderr)
        host_counts = host_reminder_counts(host_events, parse_ts(chain["kickoff"]), doc["env"]) if chain and chain.get("kickoff") else None
        doc["notificationFunnel"] = notification_funnel(
            notif_rows,
            set(chain_by_accounts(chain)) if chain else stage["registered"],
            stage["joined"],
            window,
            {p["id"]: p.get("username") for p in doc["players"]},
            host_counts,
        )
        if doc.get("storyline"):
            attach_reminders_fired(doc["storyline"], host_counts)
        if notif_rows.get("queryErrors"):
            doc["notificationFunnel"]["queryErrors"] = notif_rows["queryErrors"]
    except sentry.OutOfStore:
        raise
    except Exception as e:  # the report stands without it
        print("notification funnel failed:", e, file=sys.stderr)
        doc["notificationFunnel"] = None
    if chain and chain.get("interim"):
        doc["interim"] = {"at": chain["interimAt"]}
    draft_report_text(doc)
    try:
        report_lint.require_valid(doc)
        report_doc, links_doc = publish_documents(doc)
        report_lint.require_publishable((f"g{g}", report_doc), (f"g{g}-links", links_doc))
    except ValueError as error:
        sys.exit(str(error))
    publish_out = os.path.join(outdir, "report-publish.json")
    links_out = os.path.join(outdir, "report-links.json")
    with open(out, "w", encoding="utf-8") as report_file:
        json.dump(doc, report_file, indent=1, ensure_ascii=False)
    with open(publish_out, "w", encoding="utf-8") as publish_file:
        json.dump(report_doc, publish_file, indent=1, ensure_ascii=False)
    with open(links_out, "w", encoding="utf-8") as links_file:
        json.dump(links_doc, links_file, indent=1, ensure_ascii=False)
    learned = {p["id"]: p["username"] for p in doc["players"] if p["usernameSource"] in ("sentry", "log")}  # never the names filled from the mapping
    changed = {acct: name for acct, name in learned.items() if mapping.get(acct) != name}
    if changed:
        save_usernames(a.usernames, {**mapping, **changed})
        print(f"usernames: learned {len(changed)} new or changed, saved to {a.usernames}")

    print(f"\ngame {g} ({doc['env']}), kickoff {doc['kickoff']}: " + " → ".join(f"{'n/a' if s['count'] is None else s['count']} {s['stage'].split(' (')[0]}" for s in doc["funnel"]))
    print(f"{len(doc['players'])} players, {len(doc['facts'])} facts, {len(logs)} logs, links: {'yes' if links else 'no'}")
    print("full local report:", out)
    print("report document: ", publish_out)
    print("links document:  ", links_out)
    print("raw inputs:      ", outdir + "/{sentry-pull,chain,links}.json")
    print("game logs:       ", logs_dir)
    print("report lint:       passed")
    if os.path.abspath(a.usernames) == os.path.abspath(USERNAMES):
        print("usernames: pack the shared mapping with analytics/store-crypt.sh pack-usernames --force and commit analytics/usernames.tar.gz.enc")
    print("review the marked Claude judgment slot against the raw evidence; do not hand-edit generated facts.")


def main(argv=None):
    a = _parse_args(argv)
    if not a.from_store:
        return _run_report(a)
    with from_store(a.game, a.store_root,
                    load_sibling_usernames=not bool(a.sibling_usernames)) as store_run:
        if not a.chain_json:
            a.chain_json = store_run.chain_json
        print(f"from store: {store_run.directory} (telemetry as of {store_run.manifest.get('data_as_of_local')})")
        return _run_report(a, store_run)


if __name__ == "__main__":
    main()
