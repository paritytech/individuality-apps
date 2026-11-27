# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""Tests for game-links.py with small synthetic logs.  python3 -m unittest test_game_links -v"""
import importlib.util
import json
import os
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("game_links", os.path.join(os.path.dirname(__file__), "game-links.py"))
gl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gl)

T0 = 1_000_000_000_000
A, B, C, D = ("5" + c * 47 for c in "ABCD")


class Log:
    """Builds one player's log. Times are seconds after T0."""

    def __init__(self, acct, name, sid="s1"):
        self.acct, self.name, self.sid, self.entries = acct, name, sid, []

    def add(self, t, tag, msg, data=None):
        e = {"ts": T0 + int(t * 1000), "sessionId": self.sid, "level": "info", "tag": tag, "message": msg}
        if data is not None:
            e["data"] = data
        self.entries.append(e)
        return self

    def mesh(self, t, room_accts, game=7):
        room = f"g{game}:" + "_".join(room_accts)
        return self.add(t, "rtc", "mesh open", {"room": room, "self": self.acct, "peers": [a for a in room_accts if a != self.acct]})

    def game_mesh(self, t, game=7):
        """The single game-wide mesh of release 0.1.44 and later: room g<N>, no accounts in the name."""
        return self.add(t, "rtc", "mesh open", {"room": f"g{game}", "self": self.acct, "peers": []})

    def connect(self, t, peer, track=True):
        self.add(t, "rtc", f"[jollity-rtc] addPeer {peer} (answerer)")
        self.add(t + 0.1, "rtc", f"[jollity-rtc] pc {peer} connecting")
        self.add(t + 0.5, "rtc", f"[jollity-rtc] pc {peer} connected")
        if track:
            self.add(t + 0.7, "rtc", f"[jollity-rtc] ← track from {peer} streams: 1")
        return self

    def path(self, t, peer, local, remote, proto="udp"):
        return self.add(t, "rtc", f"[jollity-rtc] path {peer} {local}/{remote} {proto}")

    def close(self, t, peer):
        return self.add(t, "rtc", f"[jollity-rtc] channel close {peer}")

    def write(self, d):
        meta = {"address": self.acct, "username": self.name, "sessionId": self.sid, "gameIndex": None}
        with open(os.path.join(d, f"{self.name}.json"), "w") as f:
            json.dump({"meta": meta, "entries": self.entries}, f)


def run(logs, name="game-7", chain_groups=None, play_windows=None, joined_accounts=None):
    with tempfile.TemporaryDirectory() as root:
        d = os.path.join(root, name)
        os.mkdir(d)
        for lg in logs:
            lg.write(d)
        return gl.analyse(d, chain_groups=chain_groups, play_windows=play_windows,
                          joined_accounts=joined_accounts)


def pair(res, rnd, x, y):
    a, b = sorted((x, y))
    return next(m for m in res["matrix"] if m["round"] == rnd and m["a"] == a and m["b"] == b)


class ParsedLogs(unittest.TestCase):
    def test_seat_state_events_parse_the_player_side_face_state(self):
        log = Log(A, "ann")
        log.add(1, "rtc", f"[jollity-rtc] seat {B}: ∅ → connecting")
        log.add(2, "rtc", f"[jollity-rtc] seat {B}: connecting → live")
        log.add(7, "rtc", f"[jollity-rtc] seat {B}: live → weak")
        log.add(9, "rtc", f"[jollity-rtc] seat {B}: weak → no-signal")
        self.assertEqual(gl.seat_state_events(A, {"entries": log.entries}), [
            {"at": T0 + 1_000, "account": A, "peer": B, "state": "connecting"},
            {"at": T0 + 2_000, "account": A, "peer": B, "state": "live"},
            {"at": T0 + 7_000, "account": A, "peer": B, "state": "weak"},
            {"at": T0 + 9_000, "account": A, "peer": B, "state": "no-signal"},
        ])

    def test_analyse_keeps_seat_states_for_repeatable_reports(self):
        la = Log(A, "ann").mesh(0, [A, B])
        la.add(2, "rtc", f"[jollity-rtc] seat {B}: connecting → live")
        result = run([la])
        self.assertEqual(result["seatStates"], [
            {"at": T0 + 2_000, "account": A, "peer": B, "state": "live"},
        ])

    def test_analyse_uses_given_names(self):
        la = Log(A, None).mesh(0, [A, B]).connect(1, B).close(100, B)
        parsed = {A: {"meta": {"address": A}, "entries": la.entries}}
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "game-7")
            os.mkdir(path)
            with mock.patch.object(
                    gl, "sibling_usernames", side_effect=AssertionError("read sibling folders")):
                result = gl.analyse(path, logs=parsed, names={A: "player-given-25"})
        player = next(item for item in result["players"] if item["account"] == A)
        self.assertEqual(player["username"], "player-given-25")

    def test_parse_log_keys_a_log_by_its_account_and_sorts_entries(self):
        acct, lg = gl.parse_log({"meta": {"address": A}, "entries": [{"ts": 5, "message": "b"}, {"ts": 1, "message": "a"}, {"message": "no ts"}]})
        self.assertEqual((acct, [e["ts"] for e in lg["entries"]]), (A, [1, 5]))
        self.assertIsNone(gl.parse_log({"meta": {}}))
        self.assertIsNone(gl.parse_log({"meta": {}, "entries": [{"ts": 1, "message": "x"}]}))  # no account anywhere

    def test_analyse_takes_already_parsed_logs(self):
        la = Log(A, "ann").mesh(0, [A, B]).connect(1, B).close(100, B)
        lb = Log(B, "bob").mesh(0, [A, B]).connect(1, A).close(100, A)
        parsed = dict(gl.parse_log({"meta": {"address": x.acct, "username": x.name}, "entries": x.entries}) for x in (la, lb))
        with tempfile.TemporaryDirectory() as root:
            d = os.path.join(root, "game-7")
            os.mkdir(d)  # empty: nothing is read from disk
            res = gl.analyse(d, logs=parsed)
        self.assertEqual(pair(res, 1, A, B)["state"], "live")


# the same cases as apps/jollity-app/lib/journeys/peer-path.test.ts
PATH_CASES = [
    ("host", "host", "direct"),
    ("srflx", "host", "stun"),
    ("prflx", "srflx", "stun"),
    ("relay", "srflx", "relay"),
    ("host", "relay", "relay"),
    ("?", "?", "unknown"),
]


class GameLinks(unittest.TestCase):
    def test_classify_path_matches_the_app(self):
        for local, remote, want in PATH_CASES:
            self.assertEqual(gl.classify_path(local, remote), want, f"{local}/{remote}")

    def test_connected_pair_is_live_and_seen_by_both(self):
        la = Log(A, "ann").mesh(0, [A, B]).connect(1, B).close(100, B)
        lb = Log(B, "bob").mesh(0, [A, B]).connect(1, A).close(100, A)
        res = run([la, lb])
        m = pair(res, 1, A, B)
        self.assertEqual((m["state"], m["seenBy"]), ("live", "both"))
        self.assertGreater(m["coverage"], 0.95)
        self.assertEqual(len(res["rounds"]), 1)
        self.assertEqual(res["game"], 7)

    def test_drop_then_reconnect_is_partial(self):
        la = Log(A, "ann").mesh(0, [A, B]).connect(1, B)
        la.add(40, "rtc", f"[jollity-rtc] pc {B} disconnected")
        la.add(45, "rtc", f"[jollity-rtc] self-heal: ICE restart {B} (attempt 1)")
        la.add(70, "rtc", f"[jollity-rtc] pc {B} connected")
        la.close(100, B)
        res = run([la])
        m = pair(res, 1, A, B)
        self.assertEqual(m["state"], "partial")
        self.assertEqual(m["seenBy"], "a")
        segs = next(t for t in res["timeline"] if t["viewer"] == A and t["peer"] == B)["segments"]
        states = [s["state"] for s in segs]
        self.assertEqual(states[0], "connecting")
        self.assertIn("reconnecting", states)
        self.assertEqual(states[-1], "connected")
        self.assertTrue(any(e["kind"] == "restart" for e in res["events"]))

    def test_never_connected_is_dead(self):
        la = Log(A, "ann").mesh(0, [A, B])
        la.add(1, "rtc", f"[jollity-rtc] addPeer {B} (initiator)")
        la.add(2, "rtc", f"[jollity-rtc] → offer to {B}")
        la.add(90, "rtc", "[jollity-rtc] noise")
        res = run([la])
        m = pair(res, 1, A, B)
        self.assertEqual(m["state"], "dead")
        self.assertEqual(m["coverage"], 0)

    def test_player_without_log_is_listed_and_unknown(self):
        la = Log(A, "ann").mesh(0, [A, B, C]).connect(1, B).connect(1, C).close(100, B)
        lb = Log(B, "bob").mesh(0, [A, B, C]).connect(1, A).connect(1, C).close(100, A)
        res = run([la, lb])
        by = {p["account"]: p for p in res["players"]}
        self.assertFalse(by[C]["hasLog"])
        self.assertTrue(by[A]["hasLog"])
        self.assertEqual(len(res["players"]), 3)
        m = pair(res, 1, A, C)
        self.assertEqual(m["seenBy"], "a")  # only a can see it
        self.assertEqual(m["state"], "live")

    def test_pair_with_no_log_on_either_side_is_unknown(self):
        la = Log(A, "ann").mesh(0, [A, B, C, D]).connect(1, B).close(100, B)
        res = run([la])
        m = pair(res, 1, C, D)
        self.assertEqual(m["state"], "unknown")
        self.assertIsNone(m["coverage"])

    def test_never_joined_pair_is_neutral_and_not_covered(self):
        la = Log(A, "ann").mesh(0, [A, B, C]).connect(1, B).connect(1, C).close(100, B)
        lb = Log(B, "bob").mesh(0, [A, B, C]).connect(1, A).connect(1, C).close(100, A)
        res = run([la, lb], joined_accounts={A, B})
        self.assertEqual((pair(res, 1, A, C)["state"], pair(res, 1, A, C)["coverage"]),
                         ("never-joined", None))
        self.assertFalse(next(player for player in res["players"] if player["account"] == C)["joined"])
        timeline = next(row for row in res["timeline"] if row["viewer"] == A and row["peer"] == C)
        self.assertEqual({segment["state"] for segment in timeline["segments"]}, {"never-joined"})

    def test_pair_coverage_is_min_of_both_sides(self):
        la = Log(A, "ann").mesh(0, [A, B]).connect(1, B).close(100, B)
        lb = Log(B, "bob").mesh(0, [A, B]).connect(1, A)
        lb.add(30, "rtc", f"[jollity-rtc] media-stall: {A} connected but no inbound video → ICE restart")
        lb.close(100, A)
        m = pair(run([la, lb]), 1, A, B)
        self.assertEqual(m["seenBy"], "both")
        self.assertLess(m["coverage"], 0.5)
        self.assertEqual(m["state"], "dead")

    def test_two_rounds_have_their_own_rooms_and_windows(self):
        la = Log(A, "ann").mesh(0, [A, B]).connect(1, B)
        la.add(100, "vote", "turn sealed", {"turn": 5, "round": 0, "host": "none"})
        la.mesh(100, [A, C]).connect(101, C)
        la.add(180, "vote", "turn sealed", {"turn": 11, "round": 1, "host": "none"})
        la.close(180, C)
        lb = Log(B, "bob").mesh(0, [A, B]).connect(1, A)
        lb.add(100, "vote", "turn sealed", {"turn": 5, "round": 0, "host": "none"})
        lc = Log(C, "cat").mesh(2, [A, C]).mesh(100, [A, C])  # same room twice = a rejoin, not a round
        res = run([la, lb])
        self.assertEqual(len(res["rounds"]), 2)
        r1, r2 = res["rounds"]
        self.assertLess(r1["end"], r2["start"] + 1)
        self.assertEqual(sorted(r1["room"]), sorted([A, B]))
        self.assertEqual(sorted(r2["room"]), sorted([A, C]))
        self.assertEqual(pair(res, 1, A, B)["state"], "live")
        self.assertEqual(pair(res, 2, A, C)["state"], "live")
        self.assertFalse(any(m["round"] == 2 and B in (m["a"], m["b"]) for m in res["matrix"]))

    def test_rejoin_and_restart_cut_do_not_crash(self):
        la = Log(A, "ann").mesh(0, [A, B]).connect(1, B)
        la.sid = "s2"
        la.mesh(50, [A, B]).connect(51, B)  # the same room again in a new session
        la.close(100, B)
        res = run([la])
        kinds = {e["kind"] for e in res["events"]}
        self.assertIn("rejoin", kinds)
        self.assertIn("session-start", kinds)
        self.assertEqual(len(res["rounds"]), 1)

    def test_hidden_viewer_shows_as_away(self):
        la = Log(A, "ann").mesh(0, [A, B]).connect(1, B)
        la.add(30, "camera", "camera paused", {"visible": False})
        la.add(50, "camera", "camera resumed")
        la.close(100, B)
        res = run([la])
        segs = next(t for t in res["timeline"] if t["viewer"] == A)["segments"]
        self.assertTrue(any(s["state"] == "away" and s["from"] == T0 + 30_000 and s["to"] == T0 + 50_000 for s in segs))
        self.assertEqual({e["kind"] for e in res["events"] if e["kind"] in ("hidden", "shown")}, {"hidden", "shown"})
        self.assertGreater(pair(res, 1, A, B)["coverage"], 0.9)  # away is a display overlay, not a coverage loss

    def test_a_connected_link_over_the_relay_is_marked_relay(self):
        la = Log(A, "ann").mesh(0, [A, B]).connect(1, B).path(2, B, "relay", "srflx", "tls").close(100, B)
        lb = Log(B, "bob").mesh(0, [A, B]).connect(1, A).path(2, A, "srflx", "relay", "udp").close(100, A)
        res = run([la, lb])
        m = pair(res, 1, A, B)
        self.assertEqual((m["state"], m["path"]), ("relay", "relay"))
        self.assertGreater(m["coverage"], 0.9)  # up all round: only the path makes it a relay link
        segs = next(t["segments"] for t in res["timeline"] if t["viewer"] == A and t["peer"] == B)
        self.assertTrue(any(s["state"] == "connected" and s["path"] == "relay" for s in segs))

    def test_connected_timeline_segments_use_the_route_in_force_at_the_end(self):
        la = (Log(A, "ann").mesh(0, [A, B]).connect(1, B)
              .path(2, B, "relay", "srflx", "tls")
              .path(50, B, "host", "host", "udp").close(100, B))
        res = run([la])
        segs = [s for t in res["timeline"] if t["viewer"] == A and t["peer"] == B
                for s in t["segments"] if s["state"] == "connected"]
        self.assertEqual([s["path"] for s in segs], ["direct"])

    def test_a_relay_seen_from_one_end_alone_marks_the_pair(self):
        la = Log(A, "ann").mesh(0, [A, B]).connect(1, B).path(2, B, "host", "relay", "udp").close(100, B)
        lb = Log(B, "bob").mesh(0, [A, B]).connect(1, A).close(100, A)  # an older build: no path line
        m = pair(run([la, lb]), 1, A, B)
        self.assertEqual((m["state"], m["path"]), ("relay", "relay"))

    def test_direct_and_stun_links_stay_live_and_name_their_path(self):
        la = Log(A, "ann").mesh(0, [A, B, C]).connect(1, B).connect(1, C)
        la.path(2, B, "host", "host", "udp").path(2, C, "srflx", "srflx", "udp").close(100, B)
        res = run([la])
        self.assertEqual((pair(res, 1, A, B)["state"], pair(res, 1, A, B)["path"]), ("live", "direct"))
        self.assertEqual((pair(res, 1, A, C)["state"], pair(res, 1, A, C)["path"]), ("live", "stun"))

    def test_the_path_in_force_at_the_end_wins(self):
        la = Log(A, "ann").mesh(0, [A, B]).connect(1, B).path(2, B, "relay", "relay", "udp").path(50, B, "host", "host", "udp").close(100, B)
        m = pair(run([la]), 1, A, B)
        self.assertEqual((m["state"], m["path"]), ("live", "direct"))

    def test_a_log_with_no_path_line_has_an_unknown_path_and_the_old_state(self):
        la = Log(A, "ann").mesh(0, [A, B]).connect(1, B).close(100, B)
        m = pair(run([la]), 1, A, B)
        self.assertEqual((m["state"], m["path"]), ("live", "unknown"))

    def test_a_dead_relay_link_stays_dead(self):
        la = Log(A, "ann").mesh(0, [A, B])
        la.add(1, "rtc", f"[jollity-rtc] addPeer {B} (initiator)").path(2, B, "relay", "relay", "udp")
        la.add(90, "rtc", "[jollity-rtc] noise")
        m = pair(run([la]), 1, A, B)
        self.assertEqual((m["state"], m["path"]), ("dead", "relay"))

    def test_path_changes_are_events(self):
        la = Log(A, "ann").mesh(0, [A, B]).connect(1, B).path(2, B, "relay", "srflx", "tls").path(40, B, "host", "host", "udp").close(100, B)
        res = run([la])
        paths = [e for e in res["events"] if e["kind"] == "path"]
        self.assertEqual([(e["peer"], e["detail"]) for e in paths], [(B, "relay/srflx tls"), (B, "host/host udp")])

    def test_a_pair_regrouped_on_the_same_route_keeps_its_path_in_the_next_round(self):
        # the app logs a path only when it is set or changes: round 2 has no line of its own
        la = Log(A, "ann").mesh(0, [A, B]).connect(1, B).path(2, B, "relay", "srflx", "tls")
        la.add(100, "vote", "turn sealed", {"turn": 5, "round": 0, "host": "none"})
        la.mesh(100, [A, B, C]).connect(101, B).connect(101, C)  # a new room, so a new round, with B again
        la.add(180, "vote", "turn sealed", {"turn": 11, "round": 1, "host": "none"})
        la.close(180, B)
        res = run([la])
        self.assertEqual(len(res["rounds"]), 2)
        self.assertEqual((pair(res, 1, A, B)["path"], pair(res, 2, A, B)["path"]), ("relay", "relay"))
        self.assertEqual(pair(res, 2, A, C)["path"], "unknown")  # a new peer has no line yet
        b_segments = next(t["segments"] for t in res["timeline"] if t["viewer"] == A and t["peer"] == B)
        self.assertTrue(all(s["path"] == "relay" for s in b_segments
                            if s["state"] == "connected" and s["from"] >= T0 + 100_000))

    def test_empty_folder(self):
        res = run([])
        self.assertEqual(res["matrix"], [])
        self.assertEqual(res["rounds"], [])


E, F = "5" + "E" * 47, "5" + "F" * 47


class ChainGroups(unittest.TestCase):
    def test_a_chain_group_nobody_logged_is_an_extra_room_of_unknown_pairs(self):
        la = Log(A, "ann").mesh(0, [A, B]).connect(1, B).close(100, B)
        res = run([la], chain_groups=[[[A, B], [C, D, E]]])
        self.assertEqual(len(res["rounds"][0]["rooms"]), 2)
        self.assertEqual(sorted(res["rounds"][0]["rooms"][1]), sorted([C, D, E]))
        for x, y in ((C, D), (C, E), (D, E)):
            m = pair(res, 1, x, y)
            self.assertEqual((m["coverage"], m["state"], m["seenBy"], m["group"]), (None, "unknown", "both", 1))
        by = {p["account"]: p for p in res["players"]}
        self.assertFalse(by[C]["hasLog"] or by[D]["hasLog"] or by[E]["hasLog"])
        self.assertEqual(pair(res, 1, A, B)["state"], "live")

    def test_rooms_follow_the_chain_group_order_not_the_first_mesh_open(self):
        la = Log(A, "ann").mesh(0, [A, B]).connect(1, B).close(100, B)
        lc = Log(C, "cat").mesh(5, [C, D]).connect(6, D).close(100, D)
        res = run([la, lc])
        self.assertEqual([sorted(r) for r in res["rounds"][0]["rooms"]], [sorted([A, B]), sorted([C, D])])
        res = run([la, lc], chain_groups=[[[C, D], [A, B]]])
        self.assertEqual([sorted(r) for r in res["rounds"][0]["rooms"]], [sorted([C, D]), sorted([A, B])])
        self.assertEqual(pair(res, 1, C, D)["group"], 0)
        self.assertEqual(pair(res, 1, A, B)["group"], 1)

    def test_a_room_matching_no_chain_group_goes_after_the_matched_ones(self):
        la = Log(A, "ann").mesh(0, [A, B]).connect(1, B).close(100, B)
        lc = Log(C, "cat").mesh(5, [C, D]).connect(6, D).close(100, D)
        res = run([la, lc], chain_groups=[[[E, F], [C, D]]])
        rooms = [sorted(r) for r in res["rounds"][0]["rooms"]]
        self.assertEqual(rooms, [sorted([E, F]), sorted([C, D]), sorted([A, B])])

    def test_chain_rounds_nobody_saw_are_not_invented(self):
        la = Log(A, "ann").mesh(0, [A, B]).connect(1, B).close(100, B)
        res = run([la], chain_groups=[[[A, B]], [[A, C], [B, D]]])
        self.assertEqual(len(res["rounds"]), 1)

    def test_without_chain_groups_nothing_changes(self):
        la = Log(A, "ann").mesh(0, [A, B]).connect(1, B).close(100, B)
        res = run([la])
        self.assertEqual(len(res["rounds"][0]["rooms"]), 1)


class PlayWindows(unittest.TestCase):
    """Coverage counts only the play window of a round: the mesh opens 60 s before play, the play lasts 72 s."""

    PLAY = [(T0 + 60_000, T0 + 132_000)]

    def log(self, connect_at):
        return Log(A, "ann").mesh(0, [A, B]).connect(connect_at, B).add(132, "vote", "turn sealed", {"round": 0, "turn": 5})

    def test_a_link_up_before_play_is_whole_over_play(self):
        old = pair(run([self.log(30)]), 1, A, B)["coverage"]
        res = run([self.log(30)], play_windows=self.PLAY)
        self.assertLess(old, 0.8)  # the connect phase counted against it
        self.assertEqual(pair(res, 1, A, B)["coverage"], 1.0)
        self.assertEqual(pair(res, 1, A, B)["state"], "live")

    def test_a_link_two_seconds_into_play_is_97_percent(self):
        res = run([self.log(61.3)], play_windows=self.PLAY)
        self.assertAlmostEqual(pair(res, 1, A, B)["coverage"], 70 / 72, places=2)

    def test_a_carried_link_is_neutral_after_the_chain_regroups_the_pair(self):
        la = Log(A, "ann").mesh(0, [A, B]).connect(1, B).close(200, B)
        windows = [(T0 + 10_000, T0 + 90_000), (T0 + 100_000, T0 + 180_000)]
        groups = [[[A, B]], [[A, C], [B, D]]]
        res = run([la], chain_groups=groups, play_windows=windows)
        self.assertEqual(len(res["rounds"]), 2)
        self.assertFalse(any(row["round"] == 2 and {row["a"], row["b"]} == {A, B} for row in res["matrix"]))
        segments = next(row["segments"] for row in res["timeline"] if row["viewer"] == A and row["peer"] == B)
        self.assertTrue(any(row["state"] == "not-grouped" and row["from"] == windows[1][0]
                            and row["to"] == windows[1][1] for row in segments))
        self.assertFalse(any(row["state"] == "connected" and row["from"] >= windows[1][0] for row in segments))

    def test_without_play_windows_the_old_numbers_hold(self):
        res = run([self.log(30)])
        self.assertAlmostEqual(pair(res, 1, A, B)["coverage"], (132 - 30.7) / 132, places=2)

    def test_rounds_carry_their_play_window(self):
        res = run([self.log(30)], play_windows=self.PLAY)
        self.assertEqual((res["rounds"][0]["playStart"], res["rounds"][0]["playEnd"]), self.PLAY[0])
        self.assertNotIn("playStart", run([self.log(30)])["rounds"][0])

    def test_the_timeline_still_shows_the_whole_connect_story(self):
        res = run([self.log(30)], play_windows=self.PLAY)
        segs = res["timeline"][0]["segments"]
        self.assertEqual(segs[0]["from"], T0)
        self.assertEqual(segs[0]["state"], "connecting")

    def test_a_log_that_stops_inside_play_is_measured_over_what_it_covers(self):
        la = Log(A, "ann").mesh(0, [A, B]).connect(30, B).add(96, "rtc", "tick")
        res = run([la], play_windows=self.PLAY)
        self.assertEqual(pair(res, 1, A, B)["coverage"], 1.0)

    def test_a_viewer_whose_window_misses_play_has_no_coverage(self):
        la = Log(A, "ann").mesh(0, [A, B]).connect(30, B).add(50, "rtc", "tick")
        res = run([la], play_windows=self.PLAY)
        self.assertIsNone(pair(res, 1, A, B)["coverage"])


class SameGroupTwoRounds(unittest.TestCase):
    """A group that plays both rounds together opens its mesh once; the chain's two play windows still make two rounds."""

    PLAY = [(T0 + 60_000, T0 + 132_000), (T0 + 139_000, T0 + 211_000)]
    GAME_259_PLAY = [(T0 + 62_400, T0 + 134_400), (T0 + 141_400, T0 + 213_400)]

    def logs(self):
        room = [A, B, C, D]
        out = []
        for acct, name in zip(room, ("ann", "bob", "cy", "dee")):
            lg = Log(acct, name).mesh(0, room)
            for peer in room:
                if peer != acct:
                    lg.connect(30, peer)
            if acct == A:  # ann loses bob for 20 s inside round 2 only
                lg.add(150, "rtc", f"[jollity-rtc] pc {B} disconnected")
                lg.add(170, "rtc", f"[jollity-rtc] pc {B} connected")
                lg.add(170.2, "rtc", f"[jollity-rtc] ← track from {B} streams: 1")
            lg.add(215, "rtc", "tick")
            out.append(lg)
        return out

    def test_six_pairs_in_each_of_two_rounds_each_with_its_own_window(self):
        res = run(self.logs(), play_windows=self.PLAY)
        self.assertEqual(len(res["matrix"]), 12)
        self.assertEqual([m["round"] for m in res["matrix"]].count(1), 6)
        self.assertEqual([m["round"] for m in res["matrix"]].count(2), 6)
        self.assertEqual([(r["playStart"], r["playEnd"]) for r in res["rounds"]], self.PLAY)
        self.assertEqual(len(res["rounds"]), 2)

    def test_late_first_open_stays_in_chain_round_one(self):
        first = Log(A, "ann").mesh(0, [A, B]).connect(1, B).mesh(139, [A, C]).connect(140, C).add(215, "rtc", "tick")
        late = Log(C, "cy").mesh(66, [C, D]).connect(67, D).add(215, "rtc", "tick")
        res = run([first, late], play_windows=self.PLAY, name="game-260")
        self.assertEqual(len(res["rounds"]), 2)
        self.assertIn(sorted([C, D]), [sorted(room) for room in res["rounds"][0]["rooms"]])
        self.assertEqual([(row["playStart"], row["playEnd"]) for row in res["rounds"]], self.PLAY)

    def test_each_round_uses_exactly_its_distinct_chain_groups(self):
        first = Log(A, "ann").mesh(0, [A, B]).connect(1, B).mesh(139, [A, C]).connect(140, C).add(215, "rtc", "tick")
        late = Log(C, "cy").mesh(66, [C, D]).connect(67, D).add(215, "rtc", "tick")
        groups = [[[A, B], [C, D]], [[A, C], [B, D]]]
        res = run([first, late], chain_groups=groups, play_windows=self.PLAY, name="game-260")
        actual = [[set(room) for room in row["rooms"]] for row in res["rounds"]]
        expected = [[set(room) for room in round_groups] for round_groups in groups]
        self.assertEqual(actual, expected)
        self.assertNotEqual(actual[0], actual[1])
        self.assertEqual(
            [{row["a"], row["b"]} for row in res["matrix"] if row["round"] == 2],
            [{A, C}, {B, D}],
        )

    def test_game_259_rounds_keep_the_chain_play_edges_not_the_mesh_edges(self):
        res = run(self.logs(), play_windows=self.GAME_259_PLAY, name="game-259")
        self.assertEqual(
            [(r["playStart"], r["playEnd"], r["playEnd"] - r["playStart"]) for r in res["rounds"]],
            [(T0 + 62_400, T0 + 134_400, 72_000), (T0 + 141_400, T0 + 213_400, 72_000)],
        )
        self.assertLess(res["rounds"][0]["start"], res["rounds"][0]["playStart"])

    def test_round_two_coverage_is_computed_over_its_own_window(self):
        res = run(self.logs(), play_windows=self.PLAY)
        self.assertEqual(pair(res, 1, A, B)["coverage"], 1.0)
        self.assertAlmostEqual(pair(res, 2, A, B)["coverage"], 1 - 20.2 / 72, places=2)
        self.assertEqual(pair(res, 2, C, D)["coverage"], 1.0)

    def test_the_timeline_does_not_repeat_a_segment_across_rounds(self):
        res = run(self.logs(), play_windows=self.PLAY)
        segs = next(t["segments"] for t in res["timeline"] if t["viewer"] == A and t["peer"] == B)
        self.assertEqual(sorted(segs, key=lambda x: x["from"]), segs)
        self.assertTrue(all(x["to"] <= y["from"] + 1 for x, y in zip(segs, segs[1:])))

    def test_without_play_windows_the_group_stays_one_round(self):
        res = run(self.logs())
        self.assertEqual(len(res["rounds"]), 1)
        self.assertEqual(len(res["matrix"]), 6)


class GameWideRoom(unittest.TestCase):
    """Since release 0.1.44 one mesh serves the whole game (room g<N>, no accounts in the name),
    so the two rounds share a room: rounds are told apart by the chain's play windows, not by room."""

    PLAY = [(T0 + 60_000, T0 + 132_000), (T0 + 139_000, T0 + 211_000)]

    def test_one_game_room_gives_coverage_for_both_rounds(self):
        logs = []
        for acct, peer, name in ((A, B, "ann"), (B, A, "bob")):
            lg = Log(acct, name).game_mesh(0).connect(30, peer)
            if acct == A:  # ann loses bob for 20 s inside round 2 only
                lg.add(150, "rtc", f"[jollity-rtc] pc {B} disconnected")
                lg.add(170, "rtc", f"[jollity-rtc] pc {B} connected")
                lg.add(170.2, "rtc", f"[jollity-rtc] ← track from {B} streams: 1")
            logs.append(lg.add(215, "rtc", "tick"))
        groups = [[[A, B]], [[A, B]]]
        res = run(logs, chain_groups=groups, play_windows=self.PLAY)
        self.assertEqual(len(res["rounds"]), 2)
        self.assertEqual(pair(res, 1, A, B)["coverage"], 1.0)
        self.assertAlmostEqual(pair(res, 2, A, B)["coverage"], 1 - 20.2 / 72, places=2)

    def mixed_logs(self):
        """A and B run the new build (g7); C-F the old one, which opens a room per group and round."""
        E, F = "5" + "E" * 47, "5" + "F" * 47
        logs = []
        for acct, peer, name in ((A, B, "ann"), (B, A, "bob")):
            lg = Log(acct, name).game_mesh(0).connect(30, peer)
            logs.append(lg.add(215, "rtc", "tick"))
        for acct, name, r1, r2 in ((C, "cy", D, E), (D, "dee", C, F), (E, "eve", F, C), (F, "fay", E, D)):
            lg = Log(acct, name).mesh(2, sorted([acct, r1])).connect(30, r1)
            lg.mesh(130, sorted([acct, r2])).connect(131, r2)
            logs.append(lg.add(215, "rtc", "tick"))
        groups = [[[A, B], [C, D], [E, F]], [[A, B], [C, E], [D, F]]]
        return logs, groups, (E, F)

    def test_mixed_game_measures_new_and_old_phones_and_round_two_of_the_new(self):
        logs, groups, (E, F) = self.mixed_logs()
        res = run(logs, chain_groups=groups, play_windows=self.PLAY)
        self.assertEqual(len(res["rounds"]), 2)
        for rnd in (1, 2):
            self.assertEqual(pair(res, rnd, A, B)["coverage"], 1.0, rnd)
        self.assertEqual(pair(res, 1, C, D)["coverage"], 1.0)
        self.assertEqual(pair(res, 2, C, E)["coverage"], 1.0)
        self.assertIsNotNone(pair(res, 2, D, F)["coverage"])

    def test_pre_1069_per_group_rooms_still_split_the_rounds(self):
        logs, groups, (E, F) = self.mixed_logs()
        old = [lg for lg in logs if lg.acct not in (A, B)]
        res = run(old, chain_groups=[[[C, D], [E, F]], [[C, E], [D, F]]], play_windows=self.PLAY)
        self.assertEqual([len(r["rooms"]) for r in res["rounds"]], [2, 2])
        self.assertEqual(pair(res, 1, C, D)["coverage"], 1.0)
        self.assertEqual(pair(res, 2, C, E)["coverage"], 1.0)
        self.assertEqual(pair(res, 2, D, F)["coverage"], 1.0)


class OverlayAway(unittest.TestCase):
    def test_two_hidden_spans_inside_one_segment(self):
        # game 274: a viewer hid the page twice during one connected stretch, and the second pass met the first's away piece
        segs = [{"from": 0, "to": 100, "state": "connected", "path": "direct"}]
        shown = gl.overlay_away(segs, [(10, 20), (15, 30), (50, 60)], 0, 100)
        self.assertEqual([(s["from"], s["to"], s["state"]) for s in shown],
                         [(0, 10, "connected"), (10, 30, "away"), (30, 50, "connected"), (50, 60, "away"), (60, 100, "connected")])


if __name__ == "__main__":
    unittest.main()

