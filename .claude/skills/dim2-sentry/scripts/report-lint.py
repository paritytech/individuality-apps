#!/usr/bin/env python3
# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""Fail-closed consistency checks for a generated DIM2 game report."""

import argparse
import datetime
import json
import re
import sys
from zoneinfo import ZoneInfo


SECTION_MARKERS = ("**Players**", "**Telemetry**", "**Video**", "**Links**", "**Performance adaptations**")
INTRO = re.compile(r"- We picked up telemetry from (\d+) players during the game window; (?:(\d+) had only the DIM2 chat running "
                   r"and didn't register or use the app, so the counts below follow the (\d+) who did\.|the counts below follow all of them\.)")
WATERFALL = re.compile(r"- (\d+) players → (\d+) used the app or signed up → (\d+) registered → (\d+) joined → (\d+) finished\.")
TRUNCATED_ENDINGS = (" afte", " befo", " registe", " timeo", " faile", " becau")
PUBLISH_DOCUMENT_MAX_BYTES = 240 * 1024
NOTICE_KINDS = ("push", "alarm", "calendar")


def serialized_bytes(doc):
    return len(json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def lint_publish_documents(*docs):
    errors = []
    for label, doc in docs:
        size = serialized_bytes(doc)
        if size > PUBLISH_DOCUMENT_MAX_BYTES:
            errors.append(f"{label} is {size:,} bytes, above the {PUBLISH_DOCUMENT_MAX_BYTES:,}-byte publishing limit")
    return errors


def require_publishable(*docs):
    errors = lint_publish_documents(*docs)
    if errors:
        raise ValueError("report lint failed:\n- " + "\n- ".join(errors))


def _stage(doc, key):
    return next((row for row in doc.get("funnel", []) if row.get("key") == key), {})


def _strings(value, path="$"):
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, dict):
        for key, child in value.items():
            yield from _strings(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _strings(child, f"{path}[{index}]")


def _local_datetime(iso):
    if not iso:
        return None
    return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ZoneInfo("Europe/Berlin"))


DATED_TIME = re.compile(r"\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})\s+([A-Z][a-z]{2})\s+([0-2]?\d):([0-5]\d)(?::([0-5]\d))?\b")
CLOCK_TIME = re.compile(r"\b([0-2]?\d):([0-5]\d)(?::([0-5]\d))?\b")


def _reason_times(reason, deadline):
    """Yield cited local datetimes; date-less legacy times remain on the deadline day."""
    covered = []
    for match in DATED_TIME.finditer(reason):
        day, month, hour, minute, second = match.groups()
        partial = datetime.datetime.strptime(f"2000 {day} {month} {hour}:{minute}:{second or '00'}", "%Y %d %b %H:%M:%S")
        choices = [partial.replace(year=deadline.year + offset, tzinfo=deadline.tzinfo) for offset in (-1, 0, 1)]
        yield min(choices, key=lambda value: abs(value - deadline))
        covered.append(match.span())
    for match in CLOCK_TIME.finditer(reason):
        if any(start <= match.start() and match.end() <= end for start, end in covered):
            continue
        hour, minute, second = match.groups()
        yield deadline.replace(hour=int(hour), minute=int(minute), second=int(second or 0), microsecond=0)


def _fmt(value):
    """A figure as the summary prints it (report-builder _metric)."""
    if isinstance(value, float) and not value.is_integer():
        return f"{value:.1f}"
    return f"{int(value):,}"


STORYLINE_MARK_KEYS = ("reported", "draw", "chest", "endscreen", "humanity")


def _storyline_errors(doc):
    story = doc.get("storyline")
    if not story:
        return []
    errors = []
    players = story.get("players") or []
    reached = {p["id"]: {e.get("key") for e in p.get("events", [])} | set(p.get("pages", []))
               | set(p.get("screensUndated", [])) | ({"reported"} if p.get("reportUndated") else set())
               for p in players}
    ids = {p["id"] for p in players}
    registered = _stage(doc, "registered")
    if registered.get("count") is not None and "accounts" in registered and not set(registered["accounts"]) <= ids:
        errors.append("storyline registered accounts disagree with the funnel")
    for key in STORYLINE_MARK_KEYS:
        stage = _stage(doc, key)
        if stage.get("count") is None or "accounts" not in stage:
            continue
        marked = {account for account, keys in reached.items() if key in keys}
        # funnel stages narrow one into the next, so a row there must carry the mark, and a mark may sit outside the row
        if not set(stage["accounts"]) <= marked:
            errors.append(f"storyline {key} accounts disagree with the funnel")
    joined = _stage(doc, "joined")
    for r in story.get("rounds") or []:
        if any(account not in ids for group in r.get("groups") or [] for account in group):
            errors.append(f"storyline round {r.get('round')} names an account with no row")
        if "accounts" in joined and any(account not in joined["accounts"] for group in r.get("groups") or [] for account in group):
            errors.append(f"storyline round {r.get('round')} names an account that did not join")
    for p in players:
        times = [_local_datetime(e.get("at")) for e in p.get("events", [])]
        if times != sorted(times):
            errors.append(f"storyline events of {p['id']} are not in time order")
        pages, last = p.get("pages") or [], p.get("lastPage")
        if (last or {}).get("key") != (pages[-1] if pages else None) or last and not _local_datetime(last.get("at")):
            errors.append(f"storyline last page of {p['id']} disagrees with its pages")
        stretches = [(_local_datetime(st.get("from")), _local_datetime(st.get("to"))) for st in p.get("onScreen") or []]
        if any(not a or not b or b <= a for a, b in stretches) or any(b > c for (_, b), (c, _) in zip(stretches, stretches[1:])):
            errors.append(f"storyline on-screen stretches of {p['id']} are not in time order or overlap")
        taps = [_local_datetime(n.get("at")) for n in p.get("notifications") or []]
        if not all(taps) or taps != sorted(taps) or any(n.get("how") not in ("opened", "returned") for n in p.get("notifications") or []):
            errors.append(f"storyline notifications of {p['id']} are undated, out of order or not a tap")
        due = [_local_datetime(n.get("at")) for n in p.get("expectedNotices") or []]
        if not all(due) or due != sorted(due) or any(n.get("kind") not in NOTICE_KINDS for n in p.get("expectedNotices") or []):
            errors.append(f"storyline expected notices of {p['id']} are undated, out of order or of no known kind")
        if last and ("link" in last or "label" in last) and (last.get("key") != "humanity" or not str(last.get("link") or "").startswith(str(last.get("label") or "-"))):
            errors.append(f"storyline last page of {p['id']} names a link that is not its Humanity hand-off")
    phases = story.get("phases") or []
    starts = [_local_datetime(phase["from"]) for phase in phases]
    if starts != sorted(starts):
        errors.append("storyline phases are not in time order")
    for phase in phases:
        if _local_datetime(phase["to"]) < _local_datetime(phase["from"]):
            errors.append(f"storyline phase {phase.get('key')} ends before it starts")
    return errors


def lint_report(doc):
    errors = []
    funnel = doc.get("funnel") or []
    for row in funnel:
        if row.get("count") is not None and row.get("count") != len(row.get("accounts", [])):
            errors.append(f"funnel {row.get('key')} count {row.get('count')} != {len(row.get('accounts', []))} accounts")
        for dropped in row.get("dropped", []):
            if dropped.get("account") in row.get("accounts", []):
                errors.append(f"funnel {row.get('key')} drops an account it includes")

    live = _stage(doc, "live")
    split = live.get("split") or {}
    if split and sum(split.values()) != live.get("count"):
        errors.append(f"stage-one split sums to {sum(split.values())}, not {live.get('count')}")
    if split and set(split) != {"openedApp", "chatSignup", "onChainOnly"}:
        errors.append("stage-one split keys changed")
    if split and set((live.get("splitLabels") or {})) != set(split):
        errors.append("stage-one split labels are incomplete")

    idle = doc.get("funnelChatIdle") or {}
    idle_count = idle.get("count", doc.get("chatOnlyCount", 0))
    total_players = len(doc.get("players", [])) + (doc.get("chatOnlyCount", 0) if "chatOnlyCount" in doc else 0)
    if live.get("count") is not None and live.get("count") + idle_count != total_players:
        errors.append("player total does not equal stage one plus chat-only accounts")

    window = doc.get("reportWindow") or {}
    expected_stage = "entered from the app, chat sign-up, or chain"
    if window.get("label"):
        expected_stage += f" ({window['label']})"
    if live.get("stage") != expected_stage:
        errors.append(f"stage-one label does not match reportWindow: expected {expected_stage!r}")
    registered = _stage(doc, "registered")
    if registered.get("note") != "Counted from the chain's registrations for this game.":
        errors.append("registered-stage note is not the approved exact text")

    notification = doc.get("notificationFunnel")
    if notification:
        if notification.get("windowFrom") != window.get("from") or notification.get("windowTo") != window.get("to"):
            errors.append("notification funnel window does not match reportWindow")
        for row in notification.get("steps", []):
            if row.get("count") is not None and row.get("accounts") is not None and row["count"] != len(row["accounts"]):
                errors.append(f"notification {row.get('key')} count does not match accounts")

    errors += _storyline_errors(doc)

    summary = doc.get("summary") or ""
    summary_lines = summary.splitlines()
    positions = [summary.find(marker) for marker in SECTION_MARKERS]
    if any(position < 0 for position in positions) or positions != sorted(positions):
        errors.append("summary sections are missing or out of order (Players, Telemetry, Video, Links, Performance adaptations)")
    for index, line in enumerate(summary_lines):
        if line.startswith("**") and (index == 0 or summary_lines[index - 1] != ""):
            errors.append(f"summary section {line} needs a blank line before it")
        if line.startswith("  -") or re.match(r"- .*:$", line):
            errors.append(f"summary uses the old nested-bullet shape: {line!r}")
    total = total_players
    progress = {key: _stage(doc, key).get("count") or 0 for key in ("joined", "reported")}
    live_n = live.get("count") or 0
    intro = INTRO.search(summary)
    if not intro or int(intro.group(1)) != total or (intro.group(2) is not None and (int(intro.group(2)) != total - live_n or int(intro.group(3)) != live_n)):
        errors.append(f"summary Players intro does not say {total} players, {total - live_n} chat-only, following {live_n}")
    found = WATERFALL.search(summary)
    expected = (total, live_n, registered.get("count") or 0, progress["joined"], progress["reported"])
    if not found or tuple(int(n) for n in found.groups()) != expected:
        errors.append(f"summary player waterfall does not agree with the funnel (expected {' → '.join(map(str, expected))})")
    losses = next((line for line in summary_lines if line.startswith("- Where they dropped out: ")), None)
    lost = sum(int(n) for n in re.findall(r"(\d+) ", losses or ""))
    if live_n != progress["reported"] and lost != live_n - progress["reported"]:
        errors.append(f"summary losses add up to {lost}, not {live_n - progress['reported']}")
    if re.search(r"more only had the chat running", summary):
        errors.append("summary uses the retired 'more only had the chat running' phrasing")
    if re.search(rf"\b{live.get('count')} opened the app\b", summary):
        errors.append("summary labels the whole entry total as opened the app")

    table = doc.get("funnelTable") or {}
    entries = table.get("entries") or []
    if table.get("entryTotal") != live.get("count") or sum(row.get("count", 0) for row in entries) != live.get("count"):
        errors.append("funnel table entry rows do not add up to the entry total")
    entry_accounts = [account for row in entries for account in row.get("accounts", [])]
    if len(entry_accounts) != len(set(entry_accounts)) or set(entry_accounts) != set(live.get("accounts", [])):
        errors.append("funnel table entry accounts are not an exact partition")
    table_registered = next((row for row in table.get("rows", []) if row.get("key") == "registered"), {})
    if table_registered.get("count") != registered.get("count") or sum(row.get("count", 0) for row in table_registered.get("sources", [])) != registered.get("count"):
        errors.append("funnel table registered sources do not add up")
    if (table.get("side") or {}).get("text"):
        errors.append("funnel table still carries the retired chat-only side line")
    if (table.get("side") or {}).get("count") != idle_count:
        errors.append("funnel table chat-only side count does not agree")
    intro = table.get("intro")
    if intro is not None and not intro.startswith(f"We picked up telemetry from {total_players} players during the game window;"):
        errors.append("funnel table intro does not count every player in the window")
    coverage = (doc.get("coverage") or {}).get("coverage")
    if coverage is not None and f"Coverage {round(coverage):,} %." not in summary:
        errors.append("summary coverage does not agree with structured coverage")
    player_coverage = doc.get("playerCoverage") or {}
    if player_coverage.get("coverage") is not None:
        expected_player_coverage = (f"Players saw a live host on {round(player_coverage['coverage']):,} % of their turns "
                                    f"(median {round(player_coverage['median']):,} %). The rest were empty seats "
                                    f"{round(player_coverage['emptySeatsPct']):,} %, no-shows "
                                    f"{round(player_coverage['noShowsPct']):,} %, and no video "
                                    f"{round(player_coverage['noVideoPct']):,} %.")
        if expected_player_coverage not in summary:
            errors.append("summary player coverage does not agree with structured playerCoverage")
        classified = sum(player_coverage.get(key, 0) for key in ("liveTurns", "emptySeats", "noShows", "noVideo"))
        if classified != player_coverage.get("turns"):
            errors.append("playerCoverage turn outcomes do not add up to turns")

    coverage_note = doc.get("coverageNote") or ""
    coverage_text = summary + "\n" + coverage_note
    if "in their own view" in coverage_text:
        errors.append("video wording exposes the viewer-perspective implementation detail")
    for cause in (doc.get("coverage") or {}).get("causes", []):
        label = "Video dropped after it came up" if cause.get("cause") == "Lost after the link came up" else cause.get("cause")
        lines = [line for line in coverage_text.splitlines() if label and label in line]
        if not lines:
            continue
        for line in lines:
            for sentence in re.split(r"(?<=[.!?])\s+", line):
                times = [float(value) for value in re.findall(r"(?:about )?(\d+(?:\.\d+)?) s into round", sentence)]
                losses = [float(high or low) for low, high in re.findall(r"lost (?:about )?(\d+(?:\.\d+)?)(?: to (\d+(?:\.\d+)?))? s", sentence)]
                if "before that" in sentence.lower() and times and losses and max(losses) > min(times):
                    errors.append(f"{label} says more video was lost before an event than the elapsed round time allows")
            player_times = {}
            for item in cause.get("items", []):
                if item.get("who") is not None and item.get("backS") is not None:
                    key = (item["who"], item.get("round"))
                    player_times[key] = min(player_times.get(key, item["backS"]), item["backS"])
            distinct_times = {round(value, 1) for value in player_times.values()}
            shown_times = {float(value) for value in re.findall(r"(?:about )?(\d+(?:\.\d+)?) s into round", line)}
            if shown_times and len(distinct_times) > 1 and len(shown_times) < len(distinct_times):
                errors.append(f"{label} merges distinct player video times into one timestamp")

    paths = (doc.get("video") or {}).get("pathCounts") or {}
    if paths:
        expected_path = ", ".join(f"{label} {paths.get(key, 0)}" for key, label in (("stun", "STUN"), ("relay", "TURN"), ("direct", "Direct")))
        if paths.get("unknown"):
            expected_path += f", Unknown {paths['unknown']}"
        if expected_path not in summary:
            errors.append(f"summary link-path counts do not agree with video.pathCounts ({expected_path})")

    for gap in doc.get("pullGaps") or []:
        if f"the {gap['query']} query failed" not in summary:
            errors.append(f"summary hides the failed {gap['query']} query")
        if not any(issue.get("title") == "Partial Sentry pull" for issue in doc.get("issues") or []):
            errors.append("a partial Sentry pull has no issue")
    video = doc.get("video") or {}
    pairing = video.get("pairing") or {}
    for kind in ("fps", "height"):
        paired = (pairing.get("samples") or {}).get(kind)
        dist = ((doc.get("adaptations") or {}).get("picture") or {}).get("receivedFps" if kind == "fps" else "receivedHeight") or {}
        if paired is not None and dist and dist.get("samples") != paired:
            errors.append(f"{kind} distribution counts {dist.get('samples')} link directions, the pairing {paired}")
    if re.search(r"% for the worst pair", summary):
        errors.append("summary gives the worst pair two packet-loss figures")
    if video.get("lossP95") is not None and f"worst pair {_fmt(video['lossP95'])} %" not in summary:
        errors.append("summary packet loss for the worst pair does not agree with video.lossP95")
    quoted = {"Video round-trip time": video.get("rttP95"), "Packets lost": video.get("lossP95")}
    for row in video.get("table") or []:
        if row.get("metric") in quoted and quoted[row["metric"]] is not None and row.get("worst") != quoted[row["metric"]]:
            errors.append(f"video table Worst for {row['metric']} ({row.get('worst')}) is not the summary's figure ({quoted[row['metric']]})")
    bandwidth_line = next((line for line in summary_lines if "because their upload bandwidth was short" in line), "")
    if bandwidth_line and "upload ladder" not in bandwidth_line:
        errors.append("summary bandwidth line does not say it is the browser's limit, not the upload ladder")
    if any(row.get("name") and row["name"] in bandwidth_line for row in video.get("limitedSenders") or []):
        errors.append("summary bandwidth line names senders (names belong in Performance adaptations)")

    adaptations = doc.get("adaptations") or {}
    low = adaptations.get("lowPower") or {}
    if low:
        if sum(low.get(key, 0) for key in ("lowPower", "full", "unknown")) != low.get("players"):
            errors.append("adaptation low-power mode counts do not equal players")
        joined_count = _stage(doc, "joined").get("count", 0)
        if low.get("scope") != "joined players" or low.get("players") != joined_count:
            errors.append("adaptation low-power population is not the players who joined")
        expected = (f"- {low.get('lowPower', 0)} of the {low.get('players', 0)} players ran in low power mode" if low.get("lowPower")
                    else f"- None of the {low.get('players', 0)} players ran in low power mode")
        if expected not in summary or "full effects" in summary:
            errors.append("summary low-power counts do not agree with adaptations")
    limits = adaptations.get("qualityLimits") or {}
    if limits and limits.get("limitedLinks", 0) + limits.get("neverLimited", 0) != limits.get("links", 0):
        errors.append("adaptation limited and never-limited link counts do not equal links")
    picture = adaptations.get("picture") or {}
    for key, line_start in (("receivedHeight", "- Picture height in pixels, on the same "), ("receivedFps", "- Frames per second, on the same ")):
        for side in (key, key.replace("received", "sent")):
            dist = picture.get(side) or {}
            if dist and sum(row.get("count", 0) for row in dist.get("buckets", [])) != dist.get("samples"):
                errors.append(f"adaptation {side} buckets do not equal samples")
        dist = picture.get(key) or {}
        if dist:
            line = next((line for line in summary_lines if line.startswith(line_start)), "")
            if not line.startswith(f"{line_start}{dist.get('samples', 0)} link directions"):
                errors.append(f"summary {key} sample count does not agree with adaptations")
    for jargon in ("probe-weak", "Per-link-per-round p50 distributions", "Senders limited by WebRTC"):
        if jargon in summary:
            errors.append(f"adaptation summary contains internal wording: {jargon}")
    signals = adaptations.get("signals") or {}
    paths = (doc.get("video") or {}).get("pathCounts") or {}
    if signals and (signals.get("turnLinks") != paths.get("relay", 0)
                    or signals.get("connectionSamples") != sum(paths.values())):
        errors.append("adaptation TURN counts do not reuse the Links route counts")

    deadlines = doc.get("stageDeadlines") or {}
    for row in funnel:
        deadline = _local_datetime(deadlines.get(row.get("key")))
        if deadline is None:
            continue
        for dropped in row.get("dropped", []):
            reason = dropped.get("reason") or ""
            later_context = any(text in reason.lower() for text in ("later", "after registration closed", "doesn't explain", "don't explain", "do not explain"))
            for at in _reason_times(reason, deadline):
                if at > deadline and not later_context:
                    errors.append(f"{row.get('key')} drop for {dropped.get('account')} cites evidence after its deadline")

    for path, text in _strings(doc):
        low = text.lower().rstrip()
        if "7 days" in low:
            errors.append(f"{path} contains the obsolete 7-day window label")
        if ((path.endswith(".reason") or path == "$.summary") and "…" in text) or low.endswith(TRUNCATED_ENDINGS):
            errors.append(f"{path} looks truncated")

    return errors


def require_valid(doc):
    errors = lint_report(doc)
    if errors:
        raise ValueError("report lint failed:\n- " + "\n- ".join(errors))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("report")
    args = parser.parse_args()
    doc = json.load(open(args.report))
    errors = lint_report(doc)
    errors.extend(lint_publish_documents((args.report, doc)))
    if errors:
        print("report lint failed:", file=sys.stderr)
        for error in errors:
            print("- " + error, file=sys.stderr)
        return 1
    print("report lint passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
