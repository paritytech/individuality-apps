"""Turn one DIM2 game's player logs into a per-pair WebRTC link picture.

Usage: python3 game-links.py <game-logs dir for one game> [--out links.json]

The directory holds one JSON file per player (docs-internal/game-logs/game-<N>/),
each {meta, entries[]}. Prints a short summary and writes the JSON (default
<dir>/links.json). Python 3, standard library only.

What the logs give us (verified on games 159-166):
- Rounds: every round opens a new mesh ("mesh open", data.room = "g<N>:<acct>_<acct>...").
  A round's groups are different rooms, so rooms whose first mesh open falls within
  ROUND_GAP_MS of each other are one round. The same room opened again is a rejoin.
- Round end: the highest-turn "vote turn sealed" of that round when the player logged
  votes, else the next mesh open, else the moment the peers' data channels closed for good.
- A link viewer->peer, per round, is the viewer's own view of "[jollity-rtc] pc <peer> ...",
  "<- track from <peer>", "self-heal: ..." and "media-stall: ..." lines inside the window
  from its mesh open to the round end.
- The selected path comes from "[jollity-rtc] path <peer> <local>/<remote> <proto>", which the
  app logs whenever a link's selected candidate pair is first set or changes (builds from the
  rtc-telemetry batch on; older logs print "stats cand" only for a failed link, so they have no
  path). The path in force at the round's end (the last path line at or before it, which may come
  from an earlier round: a path is logged only when it is set or changes) is the link's path: relay when either candidate
  is a relay, stun for a server-reflexive one, direct for two host candidates. A pair takes
  "relay" if either end's path is relay; a pair that is up (coverage live) over the relay gets
  the state "relay"; a partial or dead one keeps that state and carries path "relay" beside it.
  No path line at all (an older build) leaves the path "unknown" and the state as before.
- Coverage viewer->peer = share of the round window (cut to the chain's play window when analyse gets play_windows) in state "connected": the pc is up
  AND a track has arrived since the pc was last (re)built. Pair coverage is the min of both
  directions when both players have a log, else the one that exists.
"""
import argparse
import glob
import json
import os
import re
import statistics

ADDR = r"5[1-9A-HJ-NP-Za-km-z]{47}"
ADDR_RE = re.compile(ADDR)
ROUND_GAP_MS = 40_000
LIVE, PARTIAL = 0.9, 0.5
MIN_WINDOW_MS = 5_000


def state_of(cov):
    if cov is None:
        return "unknown"
    return "live" if cov >= LIVE else "partial" if cov >= PARTIAL else "dead"


def read_json(f):
    try:
        with open(f) as fh:
            return json.load(fh)
    except (ValueError, OSError):
        return None


def parse_log(d):
    """(account, {meta, entries}) from one parsed log file, or None when it is not a game log."""
    if not isinstance(d, dict) or "entries" not in d:
        return None
    meta = d.get("meta") or {}
    acct = meta.get("address")
    entries = sorted((e for e in d["entries"] if "ts" in e), key=lambda e: e["ts"])
    if not acct:  # fall back to "self" of a mesh open
        for e in entries:
            if e.get("message") == "mesh open" and (e.get("data") or {}).get("self"):
                acct = e["data"]["self"]
                break
    return (acct, {"meta": meta, "entries": entries}) if acct else None


def load_logs(path):
    logs = {}
    for f in sorted(glob.glob(os.path.join(path, "*.json"))):
        if os.path.basename(f) == "links.json":
            continue
        parsed = parse_log(read_json(f))
        if parsed:
            logs[parsed[0]] = parsed[1]
    return logs


def sibling_usernames(path):
    """account -> username from every game folder next to this one (names a player with no log here)."""
    return usernames_under(os.path.dirname(os.path.abspath(path)))


def usernames_under(root):
    """account -> username from every <root>/game-*/*.json log (a later game folder wins)."""
    names = {}
    for f in sorted(glob.glob(os.path.join(root, "game-*", "*.json")), key=lambda f: (int(m.group(1)) if (m := re.search(r"game-(\d+)$", os.path.dirname(f))) else 0, f)):
        d = read_json(f)
        m = (d.get("meta") or {}) if isinstance(d, dict) else {}
        if m.get("address") and m.get("username"):
            names[m["address"]] = m["username"]
    return names


def room_accounts(room):
    return room.split(":", 1)[1].split("_") if room and ":" in room else []


def mesh_opens(entries):
    out = []
    for e in entries:
        d = e.get("data") or {}
        if e.get("message") == "mesh open" and d.get("room"):
            out.append({"ts": e["ts"], "room": d["room"]})
    return out


def final_close_end(entries, ws, limit):
    """When the data channels of the round closed for good (peers whose last channel event is a close)."""
    last = {}
    for e in entries:
        if e["ts"] < ws or e["ts"] > limit:
            continue
        m = re.match(r"\[jollity-rtc\] channel (open|close) (" + ADDR + ")", e.get("message", ""))
        if m:
            last[m.group(2)] = (m.group(1), e["ts"])
    closed = [t for k, t in last.values() if k == "close"]
    if last and len(closed) * 2 >= len(last):
        return max(closed)
    return None


def is_game_room(room):
    """The single game-wide room of release 0.1.44 and later: "g<N>", no accounts in the name."""
    return bool(re.fullmatch(r"g\d+", room or ""))


def build_rounds(logs):
    """Cluster each room's first mesh open into rounds. Returns (rounds, room->round index, first opens).

    A game-wide room (g<N>) spans every round, so it takes no part in the clustering when per-group rooms
    exist (a mixed game: 0.1.43 phones still open a room per group and round). It then has no entry in
    room->round, and view_windows gives its viewers a window for every round. A game with nothing but
    the game-wide room keeps it as the one cluster, which analyse splits by the chain's play windows."""
    first = {}  # room -> earliest ts
    for acct, lg in logs.items():
        for mo in mesh_opens(lg["entries"]):
            first[mo["room"]] = min(first.get(mo["room"], mo["ts"]), mo["ts"])
    rooms = sorted(first, key=lambda r: first[r])
    if any(not is_game_room(r) for r in rooms):
        rooms = [r for r in rooms if not is_game_room(r)]
    clusters = []
    for r in rooms:
        if clusters and first[r] - first[clusters[-1][-1]] <= ROUND_GAP_MS:
            clusters[-1].append(r)
        else:
            clusters.append([r])
    room_round = {r: i for i, c in enumerate(clusters) for r in c}
    return clusters, room_round, first


def view_windows(lg, room_round, n_rounds):
    """Per round the viewer's window: (room, start, end) or None."""
    es = lg["entries"]
    opens = mesh_opens(es)
    last_ts = es[-1]["ts"] if es else 0
    res = {}
    # a viewer's round may have several opens of the same room (rejoin): first opens, rejoins noted elsewhere
    by_round = {}
    wide = [mo for mo in opens if mo["room"] not in room_round]  # the game-wide room: every round, see build_rounds
    for mo in opens:
        if mo["room"] in room_round:
            by_round.setdefault(room_round[mo["room"]], []).append(mo)
    seals = {}
    for e in es:
        d = e.get("data") or {}
        if e.get("tag") == "vote" and e.get("message") == "turn sealed" and "round" in d and "turn" in d:
            cur = seals.get(d["round"])
            if cur is None or d["turn"] >= cur[0]:
                seals[d["round"]] = (d["turn"], e["ts"])
    vote_rounds = sorted(seals)
    rounds_sorted = sorted(by_round)
    for k, r in enumerate(rounds_sorted):
        mo = by_round[r][0]
        ws = mo["ts"]
        nxt = by_round[rounds_sorted[k + 1]][0]["ts"] if k + 1 < len(rounds_sorted) else None
        end = None
        # vote rounds are 0-based and appear in the same order as this viewer's mesh opens
        # (only trusted when the counts agree, i.e. the log saw every round it had a mesh for).
        if len(vote_rounds) == len(rounds_sorted) and seals:
            end = seals[vote_rounds[k]][1]
        if end is None or end < ws:
            end = nxt
        if end is None or end < ws:
            end = final_close_end(es, ws, last_ts)
        if end is None or end < ws:
            end = last_ts
        if nxt is not None:
            end = min(end, nxt)
        end = min(end, last_ts)
        res[r] = {"room": mo["room"], "start": ws, "ownEnd": end, "lastTs": last_ts}
    if wide:
        res["wide"] = {"room": wide[0]["room"], "start": wide[0]["ts"], "ownEnd": last_ts, "lastTs": last_ts}
    return res


def is_final_close(entries, peer, t, we):
    """A channel close that is not a rebuild: no addPeer/pc connecting/connected for the peer around it."""
    for e in entries:
        m = e.get("message", "")
        if peer not in m or not m.startswith("[jollity-rtc]"):
            continue
        if t - 1500 <= e["ts"] <= we and ("] addPeer" in m or re.search(r"\] pc \S+ (connecting|connected)", m)):
            return False
    return True


PATH_RE = re.compile(r"\[jollity-rtc\] path (" + ADDR + r") (\w+)/(\w+)(?: (\w+))?")


def classify_path(local, remote):
    # mirrors rtcPath in apps/jollity-app/lib/journeys/peer-path.ts; both tests list the same cases
    types = (local, remote)
    if "relay" in types:
        return "relay"
    if "srflx" in types or "prflx" in types:
        return "stun"
    if types == ("host", "host"):
        return "direct"
    return "unknown"


def link_path(entries, peer, we):
    """The path viewer->peer is on at `we`: the last path line for the peer at or before it.
    Not only inside the round: the app logs a path when it is first set or changes, so a pair
    regrouped into the next round on the same route logs nothing new there."""
    path = "unknown"
    for e in entries:
        if e["ts"] > we:
            break
        m = PATH_RE.match(e.get("message", ""))
        if m and m.group(1) == peer:
            path = classify_path(m.group(2), m.group(3))
    return path


def pair_path(a, b):
    """Relay wins over what the other end saw; unknown only when neither end knew."""
    known = [p for p in (a, b) if p and p != "unknown"]
    if "relay" in known:
        return "relay"
    for p in ("stun", "direct"):
        if p in known:
            return p
    return "unknown"


def analyse_link(entries, peer, ws, we, hidden, play=None):
    """State segments for one viewer->peer inside [ws, we]. Returns (segments, coverage).

    `play` (optional, (start, end)): coverage is the connected share of [ws, we] cut to the play window; the segments stay whole."""
    pat = re.compile(re.escape(peer))
    state, ever, pc_up, track = "connecting", False, False, False
    # Use the same per-link route evidence as the matrix: the path in force at
    # this round/window's end. Route changes remain available as timeline events.
    path = link_path(entries, peer, we)
    segs = []
    cur_from = ws

    def append_segment(end):
        if end <= cur_from:
            return
        segment = {"from": cur_from, "to": end, "state": state}
        if state == "connected":
            segment["path"] = path
        segs.append(segment)

    def flip(ts, new):
        nonlocal state, cur_from
        if new != state:
            append_segment(ts)
            cur_from, state = ts, new

    def connected_or(ts):
        nonlocal ever
        if pc_up and track:
            ever = True
            flip(ts, "connected")
        else:
            flip(ts, "reconnecting" if ever else "connecting")

    for e in entries:
        if e["ts"] < ws or e["ts"] > we:
            continue
        m = e.get("message", "")
        if not m.startswith("[jollity-rtc]") or not pat.search(m):
            continue
        t = e["ts"]
        if "] addPeer" in m:
            pc_up, track = False, False
            flip(t, "reconnecting" if ever else "connecting")
        elif re.search(r"\] pc \S+ connecting", m):
            pc_up, track = False, False
            flip(t, "reconnecting" if ever else "connecting")
        elif re.search(r"\] pc \S+ connected", m):
            pc_up = True
            connected_or(t)
        elif re.search(r"\] pc \S+ disconnected", m):
            pc_up = False
            flip(t, "reconnecting")
        elif re.search(r"\] pc \S+ failed", m):
            pc_up = False
            flip(t, "failed")
        elif "← track from" in m:
            track = True
            connected_or(t)
        elif "self-heal: rebuild" in m:
            pc_up, track = False, False
            flip(t, "reconnecting")
        elif re.search(r"\] channel close", m):
            if is_final_close(entries, peer, t, we):
                pc_up, track = False, False
                flip(t, "disconnected")
        elif "self-heal: ICE restart" in m:
            flip(t, "reconnecting")
        elif "media-stall:" in m:
            track = False
            flip(t, "reconnecting")
    append_segment(we)
    lo, hi = (ws, we) if play is None else (max(ws, play[0]), min(we, play[1]))
    cov = None
    if hi - lo >= MIN_WINDOW_MS:
        up = sum(max(0, min(s["to"], hi) - max(s["from"], lo)) for s in segs if s["state"] == "connected")
        cov = round(up / (hi - lo), 3)
    # overlay "away" while the viewer's page was hidden: drawn for the timeline only
    shown = overlay_away(segs, hidden, ws, we)
    return shown, cov


def overlay_away(segs, hidden, ws, we):
    out = []
    for s in segs:
        pieces = [(s["from"], s["to"])]
        for h0, h1 in hidden:
            nxt = []
            for p in pieces:
                if len(p) == 3:  # already away under an earlier hidden span
                    nxt.append(p)
                    continue
                a, b = p
                if h1 <= a or h0 >= b:
                    nxt.append((a, b))
                    continue
                if h0 > a:
                    nxt.append((a, h0))
                nxt.append((max(a, h0), min(b, h1), "away"))
                if h1 < b:
                    nxt.append((h1, b))
            pieces = nxt
        for p in pieces:
            state = p[2] if len(p) == 3 else s["state"]
            piece = {"from": p[0], "to": p[1], "state": state}
            if state == "connected":
                piece["path"] = s["path"]
            out.append(piece)
    merged = []
    for s in out:
        if (merged and merged[-1]["state"] == s["state"]
                and merged[-1].get("path") == s.get("path")
                and merged[-1]["to"] == s["from"]):
            merged[-1]["to"] = s["to"]
        else:
            merged.append(dict(s))
    return merged


def hidden_intervals(entries):
    out, start = [], None
    last = entries[-1]["ts"] if entries else 0
    for e in entries:
        if e.get("tag") != "camera":
            continue
        m, d = e.get("message", ""), e.get("data") or {}
        if (m in ("camera paused", "camera track ended")) and d.get("visible") is False:
            if start is None:
                start = e["ts"]
        elif m == "camera resumed" or (m == "reopening the camera" and d.get("reason") == "back in front"):
            if start is not None:
                out.append((start, e["ts"]))
                start = None
    if start is not None:
        out.append((start, last))
    return out


def events_for(acct, lg, windows):
    es = lg["entries"]
    out = []
    seen_rooms, prev_sid = set(), None
    for e in es:
        m, d, t = e.get("message", ""), e.get("data") or {}, e["ts"]
        sid = e.get("sessionId")
        if prev_sid is not None and sid and sid != prev_sid:
            out.append({"at": t, "account": acct, "kind": "session-start", "detail": "new session " + sid[:8]})
        if sid:
            prev_sid = sid
        if e.get("tag") == "session" and m.endswith("start") and not out_has(out, t, "session-start"):
            out.append({"at": t, "account": acct, "kind": "session-start", "detail": m})
        if m == "mesh open" and d.get("room"):
            if d["room"] in seen_rooms:
                out.append({"at": t, "account": acct, "kind": "rejoin", "detail": "mesh reopened for the same room"})
            seen_rooms.add(d["room"])
        mm = re.match(r"\[jollity-rtc\] self-heal: (ICE restart|rebuild) (" + ADDR + r") \(attempt (\d+)\)", m)
        if mm:
            out.append({"at": t, "account": acct, "peer": mm.group(2), "kind": "restart",
                        "detail": f"{mm.group(1)} (attempt {mm.group(3)})"})
        mm = PATH_RE.match(m)
        if mm:
            out.append({"at": t, "account": acct, "peer": mm.group(1), "kind": "path",
                        "detail": f"{mm.group(2)}/{mm.group(3)}" + (f" {mm.group(4)}" if mm.group(4) else "")})
        mm = re.match(r"\[jollity-rtc\] media-stall: (" + ADDR + ")", m)
        if mm:
            out.append({"at": t, "account": acct, "peer": mm.group(1), "kind": "restart",
                        "detail": "media stall, ICE restart"})
        mm = re.match(r"\[jollity-rtc\] onRtc error from (" + ADDR + r") (.*)", m)
        if mm and "m-lines" in mm.group(2):
            out.append({"at": t, "account": acct, "peer": mm.group(1), "kind": "m-line-error",
                        "detail": "m-line order mismatch in the remote offer"})
    for h0, h1 in hidden_intervals(es):
        out.append({"at": h0, "account": acct, "kind": "hidden", "detail": "app out of view"})
        out.append({"at": h1, "account": acct, "kind": "shown", "detail": "app back in view"})
    return out


def seat_state_events(acct, lg):
    """The face state the app rendered for each peer, as viewer-side evidence.

    These lines are deliberately separate from the peer-connection timeline: a
    connected track can still render as no-signal, while live and weak both mean
    the host's face was visible.
    """
    out = []
    pattern = re.compile(r"^\[jollity-rtc\] seat (" + ADDR + r"): .* (?:→|->) ([a-z-]+)$")
    for entry in lg.get("entries", []):
        match = pattern.match(entry.get("message", ""))
        if match and isinstance(entry.get("ts"), (int, float)):
            out.append({"at": entry["ts"], "account": acct, "peer": match.group(1), "state": match.group(2)})
    return sorted(out, key=lambda item: (item["at"], item["peer"]))


def out_has(events, t, kind):
    return any(e["at"] == t and e["kind"] == kind for e in events)


def apply_chain_groups(clusters, room_round, first, chain_groups):
    """Add a room for every chain group no log saw, and order each round's rooms by chain group index (in place)."""
    for i, groups in enumerate(chain_groups or []):
        if i >= len(clusters):
            break
        real = list(clusters[i])
        seen = set().union(*(room_accounts(r) for r in real)) if real else set()
        mid = statistics.median([first[r] for r in real]) if real else 0
        for accts in groups:
            if seen.isdisjoint(accts):
                room = "chain:" + "_".join(sorted(accts))
                clusters[i].append(room)
                room_round[room] = i
                first[room] = mid

        def chain_index(room):
            members = set(room_accounts(room))
            return next((gi for gi, accts in enumerate(groups) if members & set(accts)), len(groups))
        clusters[i].sort(key=chain_index)  # stable: unmatched rooms keep their order, after the matched


def analyse(path, logs=None, chain_groups=None, play_windows=None, names=None, joined_accounts=None):
    """The link picture for the logs in `path`, or for already-parsed `logs` ({account: {meta, entries}}); `path` still names the game and the sibling folders.

    `chain_groups` (optional): per round, the chain's groups in group-index order, each a list of accounts. A group no logged player sat in becomes a room of unknown pairs, and the rooms follow the chain's order.

    `play_windows` (optional): per round, (start_ms, end_ms) of the play as the chain schedules it. Coverage is then counted over the part of each viewer's window inside it, not over the connect phase or the gap between rounds; the timeline keeps the whole story, and each round gains playStart and playEnd.

    `joined_accounts` (optional): the report funnel's joined set. Pairs involving an account outside it are marked never-joined and excluded from coverage. Omit it for standalone/legacy analysis where join evidence is unavailable."""
    if logs is None:
        logs = load_logs(path)
    names = sibling_usernames(path) if names is None else names
    m = re.search(r"(\d+)\s*$", os.path.basename(os.path.abspath(path)))
    game = int(m.group(1)) if m else None
    if game is None:
        for lg in logs.values():
            if lg["meta"].get("gameIndex") is not None:
                game = lg["meta"]["gameIndex"]
                break

    clusters, room_round, first = build_rounds(logs)
    if play_windows and len(clusters) > len(play_windows):
        # Late first opens can split one chain round into multiple time clusters. Anchor those
        # clusters to the chain's authoritative play starts before building viewer windows.
        aligned = [[] for _ in play_windows]
        starts = [window[0] for window in play_windows]
        for rooms in clusters:
            opened = min(first[room] for room in rooms)
            index = max((i for i, start in enumerate(starts) if start <= opened), default=0)
            aligned[min(index, len(aligned) - 1)].extend(rooms)
        clusters = [rooms for rooms in aligned if rooms]
        room_round = {room: i for i, rooms in enumerate(clusters) for room in rooms}
    if chain_groups and play_windows and len(chain_groups) == len(play_windows):
        # Prefer the chain membership itself over first-open timing.  A late
        # room in round 1 can otherwise look like a new round, while a room
        # whose membership recurs across rounds remains timing-ambiguous and
        # keeps the temporal assignment for the split-window logic below.
        reassigned = [[] for _ in play_windows]
        for old_index, rooms in enumerate(clusters):
            for room in rooms:
                members = set(room_accounts(room))
                matches = [round_index for round_index, groups in enumerate(chain_groups)
                           if any(members == set(group) for group in groups)]
                reassigned[matches[0] if len(matches) == 1 else min(old_index, len(reassigned) - 1)].append(room)
        if all(reassigned):
            clusters = reassigned
            room_round = {room: i for i, rooms in enumerate(clusters) for room in rooms}
    else:
        apply_chain_groups(clusters, room_round, first, chain_groups)

    accounts = set(logs)
    for r in room_round:
        accounts.update(room_accounts(r))
    for groups in chain_groups or []:
        for group in groups:
            accounts.update(group)
    joined = set(accounts) if joined_accounts is None else set(joined_accounts)
    players = []
    for a in sorted(accounts, key=lambda x: ((logs.get(x, {}).get("meta", {}).get("username") or names.get(x) or "~"), x)):
        u = (logs.get(a, {}).get("meta", {}) or {}).get("username") or names.get(a)
        players.append({"account": a, "username": u, "hasLog": a in logs, "joined": a in joined})

    # per-viewer windows, per mesh cluster (a mesh opens when the group changes)
    windows = {a: view_windows(lg, room_round, len(clusters)) for a, lg in logs.items()}

    cstart, cend = [], []
    for i, rooms in enumerate(clusters):
        starts = [first[r] for r in rooms]
        ends = [w[i]["ownEnd"] for w in windows.values() if i in w and w[i]["ownEnd"] > w[i]["start"]]
        start = int(statistics.median(starts))
        cstart.append(start)
        cend.append(int(statistics.median(ends)) if ends else (int(min(first[r] for r in clusters[i + 1])) if i + 1 < len(clusters) else start))

    # One output round per play window of the chain. The mesh only reopens when the group changes, so a group that
    # plays several rounds together is one cluster: its windows are assigned to it by time, and it is split there.
    pws_of = [[] for _ in clusters]
    if play_windows and len(play_windows) > len(clusters) and clusters:
        for pw in play_windows:
            pws_of[max([i for i in range(len(clusters)) if cstart[i] <= pw[0]] or [0])].append(pw)
    elif play_windows:
        pws_of = [[play_windows[i]] if i < len(play_windows) else [] for i in range(len(clusters))]
    subs = []  # per output round: (cluster index, index within the cluster, sub-rounds in the cluster, play window or None)
    for i, pws in enumerate(pws_of):
        for si, pw in enumerate(pws or [None]):
            subs.append((i, si, len(pws or [None]), pw))

    def output_rooms(n, cluster_index):
        if chain_groups and n < len(chain_groups):
            authoritative = [list(group) for group in chain_groups[n]]
            if play_windows:
                # A report with chain timing uses the chain's groups exactly.
                # Observed mesh rooms are evidence, never extra groups.
                return authoritative
            assigned = set().union(*(set(group) for group in authoritative)) if authoritative else set()
            unmatched = []
            for room in clusters[cluster_index]:
                remainder = sorted(set(room_accounts(room)) - assigned)
                if remainder:
                    unmatched.append(remainder)
            return authoritative + unmatched
        return [room_accounts(room) for room in clusters[cluster_index]]

    rounds = []
    for n, (i, si, k, pw) in enumerate(subs):
        rooms = output_rooms(n, i)
        start = cstart[i] if si == 0 else subs[n - 1][3][1]
        end = cend[i] if si == k - 1 else pw[1]
        rounds.append({"round": n + 1, "start": start, "end": end, "room": sorted({a for room in rooms for a in room}),
                       "rooms": rooms})
        if pw:
            rounds[-1]["playStart"], rounds[-1]["playEnd"] = pw

    # every viewer is measured to the round's end as the group saw it (median), so a player who
    # left early is penalised for the time after; a log that stops sooner is cut at its last line
    vw = {}  # (account, round index) -> {room, start, end, warm}; warm is where the viewer's mesh opened
    for a, w in windows.items():
        for n, (i, si, k, pw) in enumerate(subs):
            v = w.get(i)
            carried = si > 0
            if not v and w.get("wide"):
                # one game-wide mesh: its link is already up when a later round starts, and the rounds are told apart by time
                v, carried = w["wide"], n > 0
            if not v:
                continue
            start = max(rounds[n]["start"], v["start"]) if carried else v["start"]
            end = min(rounds[n]["end"], v["lastTs"])
            if end > start:
                vw[(a, n)] = {"room": v["room"], "start": start, "end": end, "warm": v["start"], "carried": carried}

    cov = {}       # (round, viewer, peer) -> coverage or None
    paths = {}     # (round, viewer, peer) -> relay | stun | direct | unknown
    timeline = []
    def grouped_peers(account, round_index):
        return next((set(room) - {account} for room in rounds[round_index]["rooms"] if account in room), set())

    for a, lg in logs.items():
        hid = hidden_intervals(lg["entries"])
        per_peer = {peer: [] for n in range(len(rounds)) for peer in grouped_peers(a, n)}
        for n, (i, si, k, pw) in enumerate(subs):
            w = vw.get((a, n))
            peers = grouped_peers(a, n)
            for peer in per_peer:
                if peer not in peers:
                    start = rounds[n].get("playStart", rounds[n]["start"])
                    end = rounds[n].get("playEnd", rounds[n]["end"])
                    if end > start:
                        per_peer[peer].append({"from": start, "to": end, "state": "not-grouped"})
                    continue
                if a not in joined or peer not in joined:
                    start = rounds[n].get("playStart", rounds[n]["start"])
                    end = rounds[n].get("playEnd", rounds[n]["end"])
                    if end > start:
                        per_peer[peer].append({"from": start, "to": end, "state": "never-joined"})
                    continue
                if not w:
                    continue
                # a later round of the same mesh is read from where the mesh opened (the link is already up), then cut to the round
                segs, c = analyse_link(lg["entries"], peer, w["warm"] if w["carried"] else w["start"], w["end"], hid, pw)
                if w["carried"]:
                    segs = [{**sg, "from": max(sg["from"], w["start"]), "to": min(sg["to"], w["end"])} for sg in segs
                            if min(sg["to"], w["end"]) > max(sg["from"], w["start"])]
                cov[(n + 1, a, peer)] = c
                paths[(n + 1, a, peer)] = link_path(lg["entries"], peer, w["end"])
                per_peer.setdefault(peer, []).extend(segs)
        for peer, segs in per_peer.items():
            timeline.append({"viewer": a, "peer": peer, "segments": segs})

    matrix = []
    for n, (i, si, k, pw) in enumerate(subs):
        for gi, room in enumerate(rounds[n]["rooms"]):
            accts = sorted(room)
            for x in range(len(accts)):
                for y in range(x + 1, len(accts)):
                    a, b = accts[x], accts[y]
                    ca, cb = cov.get((n + 1, a, b)), cov.get((n + 1, b, a))
                    ha, hb = a in logs and (n + 1, a, b) in cov, b in logs and (n + 1, b, a) in cov
                    vals = [v for v in (ca, cb) if v is not None]
                    c = min(vals) if vals else None
                    seen = "both" if (ha and hb and ca is not None and cb is not None) else "a" if ca is not None else "b" if cb is not None else None
                    path = pair_path(paths.get((n + 1, a, b)), paths.get((n + 1, b, a)))
                    never_joined = a not in joined or b not in joined
                    if never_joined:
                        c = None
                    state = "never-joined" if never_joined else state_of(c)
                    if state == "live" and path == "relay":
                        state = "relay"
                    matrix.append({"round": n + 1, "group": gi, "a": a, "b": b, "coverage": c,
                                   "seenBy": seen or ("a" if a in logs else "b" if b in logs else "both"),
                                   "path": path, "state": state})
    events = []
    seat_states = []
    for a, lg in logs.items():
        events.extend(events_for(a, lg, windows[a]))
        seat_states.extend(seat_state_events(a, lg))
    events.sort(key=lambda e: (e["at"], e["account"]))
    seat_states.sort(key=lambda e: (e["at"], e["account"], e["peer"]))
    timeline.sort(key=lambda t: (t["viewer"], t["peer"]))
    return {"game": game, "players": players, "rounds": rounds, "matrix": matrix,
            "timeline": timeline, "events": events, "seatStates": seat_states}


def summary(res):
    name = {p["account"]: p["username"] or p["account"][:8] for p in res["players"]}
    L = [f"game {res['game']}: {len(res['players'])} players ({sum(1 for p in res['players'] if not p['hasLog'])} without a log), "
         f"{len(res['rounds'])} round(s), {len(res['matrix'])} pairs"]
    for r in res["rounds"]:
        ms = [m for m in res["matrix"] if m["round"] == r["round"]]
        c = {s: sum(1 for m in ms if m["state"] == s) for s in ("live", "relay", "partial", "dead", "unknown")}
        L.append(f"  round {r['round']}: {len(r['rooms'])} group(s), {(r['end'] - r['start']) / 1000:.0f}s; "
                 + ", ".join(f"{v} {k}" for k, v in c.items()))
        for m in ms:
            if m["state"] in ("partial", "dead"):
                cv = "?" if m["coverage"] is None else f"{m['coverage'] * 100:.0f}%"
                L.append(f"    {m['state']:7} {name[m['a']]} - {name[m['b']]} {cv} (seen by {m['seenBy']})")
    kinds = {}
    for e in res["events"]:
        kinds[e["kind"]] = kinds.get(e["kind"], 0) + 1
    L.append("  events: " + (", ".join(f"{v} {k}" for k, v in sorted(kinds.items())) or "none"))
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("dir")
    ap.add_argument("--out")
    a = ap.parse_args()
    res = analyse(a.dir)
    out = a.out or os.path.join(a.dir, "links.json")
    with open(out, "w") as f:
        json.dump(res, f, indent=1)
        f.write("\n")
    print(summary(res))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
