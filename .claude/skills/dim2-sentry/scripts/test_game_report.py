# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""Tests for the pure assembly functions of game-report.py.  python3 -m unittest test_game_report -v"""
import collections
import datetime
import importlib.util
import json
import os
import re
import tempfile
import types
import unittest
from unittest import mock

import sentry

spec = importlib.util.spec_from_file_location("game_report", os.path.join(os.path.dirname(__file__), "game-report.py"))
gr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gr)
pull_spec = importlib.util.spec_from_file_location("pull", os.path.join(os.path.dirname(__file__), "game-report-pull.py"))
grp = importlib.util.module_from_spec(pull_spec)
pull_spec.loader.exec_module(grp)
preview_spec = importlib.util.spec_from_file_location("local_report_preview", os.path.join(os.path.dirname(__file__), "local_report_preview.py"))
preview = importlib.util.module_from_spec(preview_spec)
preview_spec.loader.exec_module(preview)

T0 = 1_000_000_000_000
A, B, C, D = ("5" + c * 47 for c in "ABCD")
with open(os.path.join(os.path.dirname(__file__), "fixtures", "page-lives-g259-g835.json"), encoding="utf-8") as fh:
    PAGE_LIVES = json.load(fh)
with open(os.path.join(os.path.dirname(__file__), "fixtures", "away-facts-g260-g263-g264.json"), encoding="utf-8") as fh:
    AWAY_FACT_CASES = json.load(fh)["cases"]


class FromStoreWiringTest(unittest.TestCase):
    def store(self, root, game=7, passed=True):
        folder = os.path.join(root, "paseo", f"g{game}")
        os.makedirs(folder)
        with open(os.path.join(folder, "manifest.json"), "w", encoding="utf-8") as fh:
            json.dump({"pass": passed, "data_as_of_local": "17 Oct 2026, 09:00 CEST",
                       "projects": {"jollity-next": "1", "dim2-testing": "2"}}, fh)
        with open(os.path.join(folder, "chain.json"), "w", encoding="utf-8") as fh:
            json.dump({"game": game}, fh)
        return folder

    def test_from_store_sets_and_clears_source(self):
        with tempfile.TemporaryDirectory() as root:
            folder = self.store(root)
            source = mock.Mock()
            module = types.SimpleNamespace(StoreSource=mock.Mock(return_value=source))
            with mock.patch.object(gr, "_load_store_source", return_value=module), \
                 mock.patch.object(gr.gl, "usernames_under", return_value={"5A": "alice"}), \
                 mock.patch.object(gr.store_paths, "game_logs_root", return_value="/frozen/logs"), \
                 gr.from_store(7, root) as run:
                self.assertIs(gr.sentry.SOURCE, source)
                self.assertEqual(run.directory, folder)
                self.assertEqual(run.chain_json, os.path.join(folder, "chain.json"))
                self.assertEqual(run.sibling_usernames, {"5A": "alice"})
                self.assertEqual(gr.sentry.PROJECT_SLUGS, ["jollity-next", "dim2-testing"])
            self.assertIsNone(gr.sentry.SOURCE)
            source.close.assert_called_once_with()

    def test_from_store_sets_data_as_of(self):
        doc = {"game": 7}
        run = types.SimpleNamespace(manifest={"data_as_of_local": "17 Oct 2026, 09:00 CEST"})
        gr.set_data_as_of(doc, run)
        self.assertEqual(doc["dataAsOf"], "17 Oct 2026, 09:00 CEST")

    def test_live_has_no_data_as_of(self):
        doc = {"game": 7}
        gr.set_data_as_of(doc, None)
        self.assertNotIn("dataAsOf", doc)

    def test_from_store_fails_closed_without_local_data_as_of(self):
        with self.assertRaises(KeyError):
            gr.set_data_as_of({"game": 7}, types.SimpleNamespace(manifest={}))

    def test_page_header_meta_conditionally_shows_data_as_of(self):
        page = os.path.join(os.path.dirname(__file__), "..", "page", "game-reports.html")
        with open(page, encoding="utf-8") as fh:
            source = fh.read()
        self.assertIn('g.dataAsOf ? `Telemetry as of ${g.dataAsOf}` : null', source)

    def test_page_draws_the_player_storyline(self):
        page = os.path.join(os.path.dirname(__file__), "..", "page", "game-reports.html")
        with open(page, encoding="utf-8") as fh:
            source = fh.read()
        chart = source.index("g.storyline ? storylineBlock(g.storyline) : null")
        self.assertLess(source.index("coverageBlock(g),"), chart)
        self.assertLess(chart, source.index("(g.pullGaps || []).length ?"))
        self.assertNotIn('fold("Player journeys"', source)
        self.assertIn('const MARK_LABELS = { registered: "Registered", join: "Joined", reported: "Report" };', source)
        self.assertIn('const PAGE_LABELS = { draw: "Prize draw", chest: "Chest", endscreen: "End screen", humanity: "Humanity" };', source)
        self.assertIn('["end", null, "Last page"]', source)
        self.assertIn('["unseen", null, "Not seen on screen"]', source)
        self.assertIn('const NOTICE_KINDS = { push: "Notification", calendar: "Calendar Reminder", alarm: "Alarm" };', source)
        self.assertIn('...kinds.map((kind) => [`notice-${kind}`, null, NOTICE_KINDS[kind]])', source)
        self.assertIn('[`notice-${kinds[0]}-hollow`, null, "Not confirmed"]', source)
        self.assertIn('if (kind === "alarm") return ["rect"', source)
        self.assertIn('if (kind === "calendar") return ["polygon"', source)
        self.assertIn("cy = lineY(cx), kind = NOTICE_KINDS[n.kind] ? n.kind : \"push\"", source)
        self.assertIn('[...placed.filter((pm) => pm.m.key === "notice"), ...placed.filter((pm) => pm.m.key !== "notice")]', source)
        self.assertIn("const clock = hhmm;", source)
        self.assertIn('--notice: #d4a800;', source)
        self.assertIn('r.toFromReport ? ", its end is the first report" : ""', source)
        self.assertIn("(t < seat.to || (t === seat.to && !seat.cut))", source)
        self.assertIn('`tapped ${noticeWhat(n)}, which ${n.how === "returned" ? "brought the app back" : "opened the app"}, confirmed by the tap`', source)
        self.assertIn("...clip(seen)", source)
        self.assertIn("const pageLabel = (page) => page.label || PAGE_LABELS[page.key] || page.key;", source)
        self.assertIn("p.lastPage.link ? `tapped ${p.lastPage.link}` : `Last page: ${label}`", source)
        self.assertIn("`R${r.round}`", source)
        self.assertIn('p.label.slice(0, Math.max(1, Math.floor((w - 8) / CHAR_PX) - 1)) + "…"', source)
        for retired in ("lastRound", "Registered on chain", "Report on chain", "Last payoff screen", "Payoff screens reached", "No log after the page",
                        "end not known", "PAGE_SHORT", "Not joined yet", "WAIT_LINE", "joinX", "withSeconds", "y0 - 9", "EXPECTED_PATHS"):
            self.assertNotIn(retired, source)

    def test_page_joins_companion_link_documents(self):
        page = os.path.join(os.path.dirname(__file__), "..", "page", "game-reports.html")
        with open(page, encoding="utf-8") as fh:
            source = fh.read()
        self.assertIn('d.kind === "game-links"', source)
        self.assertIn('links.get(game.game)', source)
        self.assertIn('d.kind !== "game-links"', source)
        self.assertIn("function expandLinkAccounts(L)", source)
        self.assertIn("expandLinkAccounts(d.links)", source)

    def test_page_does_not_treat_ungrouped_rounds_as_bad_links(self):
        page = os.path.join(os.path.dirname(__file__), "..", "page", "game-reports.html")
        with open(page, encoding="utf-8") as fh:
            source = fh.read()
        self.assertIn('!["connected", "not-grouped", "never-joined"].includes(s.state)', source)
        self.assertIn(".lk-seg.not-grouped", source)
        self.assertIn("not grouped together in this round", source)

    def test_page_distinguishes_never_joined_from_unknown_links(self):
        page = os.path.join(os.path.dirname(__file__), "..", "page", "game-reports.html")
        with open(page, encoding="utf-8") as fh:
            source = fh.read()
        self.assertIn('"never-joined": "Never joined"', source)
        self.assertIn('m.state === "never-joined" ? "n/j"', source)
        self.assertIn('"n/j  never joined: no telemetry from or about them during the game, and no report"', source)
        self.assertIn('return absent.length === 1 ? `${absent[0]} never joined`', source)
        self.assertNotIn("never-player", source)
        self.assertNotIn('text: playerLabel(a)', source)
        self.assertIn("both joined but no log on either side", source)
        self.assertNotIn("† player never joined", source)
        self.assertNotIn("never-joined-name", source)
        self.assertIn(".lk-seg.never-joined", source)

    def test_page_has_an_in_page_link_table_screenshot_view(self):
        page = os.path.join(os.path.dirname(__file__), "..", "page", "game-reports.html")
        with open(page, encoding="utf-8") as fh:
            source = fh.read()
        self.assertIn("Show tables for a screenshot", source)
        self.assertIn("Back to the report", source)
        self.assertIn("function showLinkTables(game, roundBlocks)", source)
        self.assertIn("function closeLinkTables()", source)
        self.assertIn("/^#links-(\\d+)$/", source)
        self.assertIn(".link-shot .lk-groups { width: auto; flex-wrap: wrap; }", source)
        self.assertIn("body.link-shot-mode .wrap { display: none; }", source)

    def test_link_matrix_and_timeline_use_play_edges_with_legacy_fallbacks(self):
        page = os.path.join(os.path.dirname(__file__), "..", "page", "game-reports.html")
        with open(page, encoding="utf-8") as fh:
            source = fh.read()
        self.assertIn("const playStart = (r) => r.playStart ?? r.start;", source)
        self.assertIn("const playEnd = (r) => r.playEnd ?? r.end;", source)
        self.assertIn("${hms(playStart(r))} to ${hms(playEnd(r))}", source)
        self.assertIn("Math.min(...rounds.map((x) => playStart(x.r)))", source)
        self.assertIn("Math.max(...rounds.map((x) => playEnd(x.r)))", source)
        self.assertIn("for (const t of [playStart(r.r), playEnd(r.r)])", source)

    def test_from_store_refuses_without_venv_message(self):
        with tempfile.TemporaryDirectory() as root:
            self.store(root)
            with mock.patch.object(gr, "_load_store_source", side_effect=ImportError("duckdb")):
                with self.assertRaisesRegex(SystemExit, r"^--from-store needs the skill venv: \.claude/skills/dim2-sentry/\.venv/bin/python$"):
                    with gr.from_store(7, root):
                        pass
            self.assertIsNone(gr.sentry.SOURCE)

    def test_from_store_refuses_missing_or_failed_manifest(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(SystemExit, "manifest is missing"):
                with gr.from_store(7, root):
                    pass
            self.store(root, passed=False)
            with self.assertRaisesRegex(SystemExit, "manifest did not pass"):
                with gr.from_store(7, root):
                    pass

    def test_main_applies_stored_chain_and_sibling_defaults(self):
        with tempfile.TemporaryDirectory() as root:
            folder = self.store(root)
            source = mock.Mock()
            module = types.SimpleNamespace(StoreSource=mock.Mock(return_value=source))
            captured = {}
            def run(args, store_run=None):
                captured.update({"chain": args.chain_json, "siblings": store_run.sibling_usernames,
                                 "source": gr.sentry.SOURCE})
            with mock.patch.object(gr, "_load_store_source", return_value=module), \
                 mock.patch.object(gr.gl, "usernames_under", return_value={"5A": "alice"}), \
                 mock.patch.object(gr.store_paths, "game_logs_root", return_value="/frozen/logs"), \
                 mock.patch.object(gr, "_run_report", side_effect=run):
                gr.main(["7", "--from-store", "--store-root", root])
            self.assertEqual(captured["chain"], os.path.join(folder, "chain.json"))
            self.assertEqual(captured["siblings"], {"5A": "alice"})
            self.assertIs(captured["source"], source)
            self.assertIsNone(gr.sentry.SOURCE)

    def test_main_clears_and_closes_source_when_report_fails(self):
        with tempfile.TemporaryDirectory() as root:
            self.store(root)
            source = mock.Mock()
            module = types.SimpleNamespace(StoreSource=mock.Mock(return_value=source))
            with mock.patch.object(gr, "_load_store_source", return_value=module), \
                 mock.patch.object(gr.gl, "usernames_under", return_value={}), \
                 mock.patch.object(gr, "_run_report", side_effect=gr.sentry.OutOfStore("unsupported")):
                with self.assertRaisesRegex(gr.sentry.OutOfStore, "unsupported"):
                    gr.main(["7", "--from-store", "--store-root", root])
            self.assertIsNone(gr.sentry.SOURCE)
            source.close.assert_called_once_with()

    def test_default_sibling_scan_failure_also_clears_source(self):
        with tempfile.TemporaryDirectory() as root:
            self.store(root)
            source = mock.Mock()
            make_source = mock.Mock(return_value=source)
            module = types.SimpleNamespace(StoreSource=make_source)
            with mock.patch.object(gr, "_load_store_source", return_value=module), \
                 mock.patch.object(gr.gl, "usernames_under", side_effect=OSError("unreadable logs")):
                with self.assertRaisesRegex(OSError, "unreadable logs"):
                    with gr.from_store(7, root):
                        pass
            self.assertIsNone(gr.sentry.SOURCE)
            make_source.assert_not_called()

    def test_non_import_store_source_failure_restores_projects(self):
        with tempfile.TemporaryDirectory() as root:
            self.store(root)
            before = list(gr.sentry.PROJECT_SLUGS)
            module = types.SimpleNamespace(StoreSource=mock.Mock(
                side_effect=RuntimeError("duckdb refused")))
            with mock.patch.object(gr, "_load_store_source", return_value=module), \
                 mock.patch.object(gr.gl, "usernames_under", return_value={}):
                with self.assertRaisesRegex(RuntimeError, "duckdb refused"):
                    with gr.from_store(7, root):
                        pass
            self.assertIsNone(gr.sentry.SOURCE)
            self.assertEqual(gr.sentry.PROJECT_SLUGS, before)

    def test_explicit_sibling_file_skips_shared_log_scan(self):
        with tempfile.TemporaryDirectory() as root:
            self.store(root)
            sibling_file = os.path.join(root, "siblings.json")
            with open(sibling_file, "w", encoding="utf-8") as fh:
                json.dump({"5A": "alice"}, fh)
            source = mock.Mock()
            module = types.SimpleNamespace(StoreSource=mock.Mock(return_value=source))
            with mock.patch.object(gr, "_load_store_source", return_value=module), \
                 mock.patch.object(gr.gl, "usernames_under",
                                   side_effect=AssertionError("shared scan must not run")), \
                 mock.patch.object(gr, "_run_report"):
                gr.main(["7", "--from-store", "--store-root", root,
                         "--sibling-usernames", sibling_file])
            source.close.assert_called_once_with()

    def test_store_query_refusal_is_not_recorded_as_an_optional_gap(self):
        with mock.patch.object(gr.sentry, "events_all",
                               side_effect=gr.sentry.OutOfStore("synthetic unsupported query")):
            with self.assertRaisesRegex(gr.sentry.OutOfStore, "synthetic unsupported query"):
                gr.notification_rows("production", "start", "end")


def entry(t, tag, msg, data=None):
    e = {"ts": T0 + int(t * 1000), "tag": tag, "message": msg, "level": "info"}
    if data is not None:
        e["data"] = data
    return e


class PlayerHostCoverageTest(unittest.TestCase):
    FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "game-259-player-coverage.json")

    def game_259(self):
        """Replay real chain seats, seat log lines, log ends, and directional link segments retained for game 259."""
        with open(self.FIXTURE, encoding="utf-8") as fh:
            fixture = json.load(fh)
        chain = {"record": fixture["record"], "accounts": fixture["accounts"]}
        logs = collections.defaultdict(lambda: {"entries": []})
        for viewer, at, message in fixture["seatLines"]:
            logs[viewer]["entries"].append({"ts": at, "tag": "rtc", "message": message})
        for viewer, at in fixture["lastTs"].items():
            logs[viewer]["entries"].append({"ts": at, "tag": "fixture", "message": "last retained log timestamp"})
            logs[viewer]["entries"].sort(key=lambda item: item["ts"])
        timelines = collections.defaultdict(list)
        for viewer, peer, start, end in fixture["connectedSegments"]:
            timelines[(viewer, peer)].append({"from": start, "to": end, "state": "connected"})
        links = {"timeline": [{"viewer": viewer, "peer": peer, "segments": segments}
                              for (viewer, peer), segments in timelines.items()]}
        windows = gr.play_windows(chain["record"], fixture["clockLagS"])
        return fixture, chain, set(fixture["joined"]), dict(logs), links, windows

    def test_game_259_player_side_measure_is_pinned_to_retained_evidence(self):
        fixture, chain, joined, logs, links, windows = self.game_259()
        result = gr.player_host_coverage(chain, joined, logs, links, windows, fixture["names"])
        self.assertEqual((result["liveTurns"], result["turns"], result["coverage"]), (53, 150, 35.3))
        self.assertEqual((result["median"], result["range"]), (40, [0, 50]))
        self.assertEqual(
            (result["emptySeats"], result["noShows"], result["noVideo"]),
            (30, 34, 33),
        )
        self.assertEqual({item["username"]: item["liveTurns"] for item in result["players"]}, {
            "aphextwin.05": 4, "bigtava.05": 3, "damian.03": 2, "deedee.08": 5,
            "devdevdev.01": 4, "itsremy.01": 3, "nemanja.05": 3, "player.01": 4,
            "redherring.05": 3, "rogerjbos.02": 5, "sagepointseeder.01": 0,
            "theender.02": 3, "thegeorge.06": 5, "theorgazoid.07": 5, "valentyna.03": 4,
        })

    def test_live_or_weak_for_half_the_eight_second_stage_counts(self):
        chain = {"record": {"gameDate": 0, "rounds": 1, "maxGroupSize": 2}, "accounts": [
            {"account": A, "positions": [0], "groups": [0]},
            {"account": B, "positions": [1], "groups": [0]},
        ]}
        windows = gr.play_windows(chain["record"])
        host_play = windows[0][0] + 12_000 + 2_000
        logs = {A: {"entries": [
            {"ts": host_play, "message": f"[jollity-rtc] seat {B}: connecting → weak"},
            {"ts": host_play + 3_999, "message": f"[jollity-rtc] seat {B}: weak → no-signal"},
        ]}}
        self.assertEqual(gr.player_host_coverage(chain, {A, B}, logs, {}, windows)["liveTurns"], 0)
        logs[A]["entries"][1]["ts"] += 1
        self.assertEqual(gr.player_host_coverage(chain, {A, B}, logs, {}, windows)["liveTurns"], 1)

    def test_carried_seat_state_stops_at_the_viewers_last_log_line(self):
        chain = {"record": {"gameDate": 0, "rounds": 1, "maxGroupSize": 2}, "accounts": [
            {"account": A, "positions": [0], "groups": [0]},
            {"account": B, "positions": [1], "groups": [0]},
        ]}
        windows = gr.play_windows(chain["record"])
        host_play = windows[0][0] + 12_000 + 2_000
        logs = {A: {"entries": [
            {"ts": host_play, "message": f"[jollity-rtc] seat {B}: connecting → live"},
            {"ts": host_play + 3_000, "tag": "game", "message": "last retained line"},
        ]}}
        self.assertEqual(gr.player_host_coverage(chain, {A, B}, logs, {}, windows)["liveTurns"], 0)

    def test_hidden_stretches_do_not_count_as_live_seat_time(self):
        chain = {"record": {"gameDate": 0, "rounds": 1, "maxGroupSize": 2}, "accounts": [
            {"account": A, "positions": [0], "groups": [0]},
            {"account": B, "positions": [1], "groups": [0]},
        ]}
        windows = gr.play_windows(chain["record"])
        host_play = windows[0][0] + 12_000 + 2_000
        logs = {A: {"entries": [
            {"ts": host_play, "message": f"[jollity-rtc] seat {B}: connecting → live"},
            {"ts": host_play + 2_000, "tag": "camera", "message": "camera paused", "data": {"visible": False}},
            {"ts": host_play + 7_000, "tag": "camera", "message": "camera resumed"},
            {"ts": host_play + 8_000, "tag": "game", "message": "last retained line"},
        ]}}
        self.assertEqual(gr.player_host_coverage(chain, {A, B}, logs, {}, windows)["liveTurns"], 0)

    def test_joined_account_missing_from_chain_is_skipped_and_counted(self):
        chain = {"record": {"gameDate": 0, "rounds": 1, "maxGroupSize": 2}, "accounts": [
            {"account": A, "positions": [0], "groups": [0]},
            {"account": B, "positions": [1], "groups": [0]},
        ]}
        result = gr.player_host_coverage(chain, {A, B, C}, {}, {}, gr.play_windows(chain["record"]))
        self.assertEqual((result["turns"], result["missingChainPlayers"]), (2, 1))
        self.assertEqual(result["missingChainAccounts"], [C])

    def test_null_rounds_produces_an_empty_measure(self):
        chain = {"record": {"gameDate": 0, "rounds": None, "maxGroupSize": 2}, "accounts": [
            {"account": A, "positions": [], "groups": []},
        ]}
        result = gr.player_host_coverage(chain, {A}, {}, {}, gr.play_windows(chain["record"]))
        self.assertEqual((result["turns"], result["coverage"]), (0, None))

    def test_links_timeline_is_the_fallback_when_seat_lines_are_absent(self):
        chain = {"record": {"gameDate": 0, "rounds": 1, "maxGroupSize": 2}, "accounts": [
            {"account": A, "positions": [0], "groups": [0]},
            {"account": B, "positions": [1], "groups": [0]},
        ]}
        windows = gr.play_windows(chain["record"])
        host_play = windows[0][0] + 12_000 + 2_000
        links = {"timeline": [{"viewer": A, "peer": B, "segments": [
            {"from": host_play, "to": host_play + 4_000, "state": "connected"},
        ]}]}
        result = gr.player_host_coverage(chain, {A, B}, {A: {"entries": []}}, links, windows)
        self.assertEqual(result["liveTurns"], 1)
        self.assertEqual(result["players"][0]["source"], "links-timeline")

    def test_a_seat_line_after_the_turn_does_not_suppress_directional_fallback(self):
        chain = {"record": {"gameDate": 0, "rounds": 1, "maxGroupSize": 2}, "accounts": [
            {"account": A, "positions": [0], "groups": [0]},
            {"account": B, "positions": [1], "groups": [0]},
        ]}
        windows = gr.play_windows(chain["record"])
        host_play = windows[0][0] + 12_000 + 2_000
        logs = {A: {"entries": [
            {"ts": host_play + 9_000, "message": f"[jollity-rtc] seat {B}: connecting → no-signal"},
        ]}}
        links = {"timeline": [{"viewer": A, "peer": B, "segments": [
            {"from": host_play, "to": host_play + 8_000, "state": "connected"},
        ]}]}
        result = gr.player_host_coverage(chain, {A, B}, logs, links, windows)
        self.assertEqual(result["liveTurns"], 1)
        self.assertEqual(result["players"][0]["source"], "links-timeline")

    def test_summary_kickoff_label_follows_the_date(self):
        for kickoff, expect in (("2026-10-24T11:55:00Z", "kickoff 13:55 CEST,"), ("2026-10-26T11:55:00Z", "kickoff 12:55 CET,")):
            doc = {"game": 7, "env": "previewnet", "kickoff": kickoff, "players": [], "funnel": [],
                   "coverage": {"coverage": 82.1}, "coverageNote": None, "video": {}, "adaptations": {}}
            gr.draft_report_text(doc)
            self.assertIn(expect, doc["summary"])

    def test_summary_places_player_experience_next_to_pair_coverage(self):
        doc = {"game": 7, "env": "previewnet", "kickoff": None, "players": [], "funnel": [],
               "coverage": {"coverage": 82.1}, "coverageNote": None, "video": {}, "adaptations": {},
               "playerCoverage": {"coverage": 35.3, "median": 40, "emptySeatsPct": 20,
                                  "noShowsPct": 22.7, "noVideoPct": 22}}
        gr.draft_report_text(doc)
        lines = doc["summary"].splitlines()
        pair = lines.index("- Coverage 82 %.")
        self.assertEqual(lines[pair + 1], "- Players saw a live host on 35 % of their turns (median 40 %). "
                                            "The rest were empty seats 20 %, no-shows 23 %, and no video 22 %.")

    def test_lint_rejects_a_player_coverage_summary_or_partition_drift(self):
        doc = {"summary": "Players saw a live host on 35 % of their turns (median 40 %). The rest were empty seats 20 %, "
                          "no-shows 23 %, and no video 22 %.",
               "playerCoverage": {"coverage": 35.3, "median": 40, "emptySeatsPct": 20, "noShowsPct": 22.7,
                                  "noVideoPct": 22, "liveTurns": 53, "turns": 150,
                                  "emptySeats": 30, "noShows": 34, "noVideo": 33}}
        errors = gr.report_lint.lint_report(doc)
        self.assertFalse(any("player coverage" in error or "playerCoverage turn" in error for error in errors))
        doc["summary"] = doc["summary"].replace("35 %", "39 %")
        doc["playerCoverage"]["noVideo"] = 32
        errors = gr.report_lint.lint_report(doc)
        self.assertTrue(any("player coverage" in error for error in errors))
        self.assertTrue(any("playerCoverage turn outcomes" in error for error in errors))


def log(*entries):
    return {"meta": {}, "entries": list(entries)}


def verdicts(**kw):
    return {a: {"verdict": v, "personTurns": 0, "notPersonTurns": 1, "autoTurns": 1, "source": "majority"} for a, v in kw.items()}


def away_entry(t, hidden_s, shown_s, chain=True, via="visibility", **extra):
    d = {"hiddenAtMs": T0 + int(hidden_s * 1000), "shownAtMs": T0 + int(shown_s * 1000), "via": via,
         "hiddenChainS": T0 / 1000 + hidden_s if chain else None, "shownChainS": T0 / 1000 + shown_s if chain else None, **extra}
    return entry(t, "foreground", "away interval", d)


def open_entry(t, hidden_s, **extra):
    return entry(t, "foreground", "away open", {"hiddenAtMs": T0 + int(hidden_s * 1000), "hiddenChainS": T0 / 1000 + hidden_s, **extra})



def log_queries(full_rows, chunk_rows):
    """events_all for fetch_logs: since #789 the full-log rows are paginated through events_all too
    (full_log_rows), so one stand-in answers both queries by their title."""
    return lambda dataset, query, *a, **k: list(chunk_rows if "game-log-chunk" in query else full_rows)

class AwayTurnsTest(unittest.TestCase):
    # gameDate = T0/1000; 3 seats: a turn is 12 s, a round 36 s of play, rounds start 43 s apart
    RECORD = {"gameDate": T0 // 1000, "maxGroupSize": 3, "rounds": 2}

    def ctx(self, lg):
        return gr.Ctx(players=[{"id": A, "username": "alice"}], chain={"record": self.RECORD}, logs={A: lg})

    def test_reads_only_well_formed_foreground_lines(self):
        lg = log(away_entry(1, 5, 9), entry(2, "foreground", "away interval cap reached", {"cap": 50}),
                 entry(3, "rtc", "away interval", {"hiddenAtMs": 1, "shownAtMs": 2}), entry(4, "foreground", "away interval", {"hiddenAtMs": "x"}))
        self.assertEqual(len(gr.away_intervals(lg)), 1)

    def test_interval_inside_one_turn(self):
        ivs = gr.away_intervals(log(away_entry(1, 14, 20)))
        self.assertEqual(gr.away_turns(ivs, self.RECORD), [{"round": 1, "turn": 2, "overlapS": 6.0, "via": ["visibility"], "chain": True, "startedHidden": False, "keptRunning": False}])

    def test_interval_spanning_turns_and_rounds(self):
        ivs = gr.away_intervals(log(away_entry(1, 30, 50)))  # turn 3 of round 1 (24-36), the gap, turn 1 of round 2 (43-55)
        self.assertEqual([(t["round"], t["turn"], t["overlapS"]) for t in gr.away_turns(ivs, self.RECORD)], [(1, 3, 6.0), (2, 1, 7.0)])

    def test_touching_edges_do_not_overlap(self):
        turns = gr.away_turns(gr.away_intervals(log(away_entry(1, 12, 24))), self.RECORD)
        self.assertEqual([t["turn"] for t in turns], [2])

    def test_wall_fallback_is_shifted_by_the_clock_lag(self):
        ivs = gr.away_intervals(log(away_entry(1, 14, 20, chain=False, via="freeze-detected")))
        turns = gr.away_turns(ivs, self.RECORD, lag_s=4)  # wall runs 4 s behind the schedule: the interval is 10-16 on it
        self.assertEqual([(t["turn"], t["overlapS"], t["chain"]) for t in turns], [(1, 2.0, False), (2, 4.0, False)])

    def test_a_sliver_chain_span_loses_to_the_much_larger_wall_span(self):
        # a freeze that the chain clock read as 0.5 s: the wall says 30 s
        iv = {"hiddenAtMs": T0 + 2000, "shownAtMs": T0 + 32000, "hiddenChainS": T0 / 1000 + 2, "shownChainS": T0 / 1000 + 2.5, "via": "freeze-detected"}
        turns = gr.away_turns([iv], self.RECORD)
        self.assertEqual([(t["turn"], t["chain"]) for t in turns], [(1, False), (2, False), (3, False)])

    def test_chain_span_kept_when_the_wall_agrees(self):
        iv = {"hiddenAtMs": T0 + 2000, "shownAtMs": T0 + 12500, "hiddenChainS": T0 / 1000 + 2, "shownChainS": T0 / 1000 + 12, "via": "visibility"}
        self.assertTrue(all(t["chain"] for t in gr.away_turns([iv], self.RECORD)))

    def test_backwards_interval_is_reported_not_dropped_silently(self):
        iv = {"hiddenAtMs": T0 + 9000, "shownAtMs": T0 + 8000, "hiddenChainS": None, "shownChainS": None, "via": "visibility"}
        self.assertEqual(gr.away_turns([iv], self.RECORD), [])
        self.assertEqual(gr.away_unplaced([iv], self.RECORD), [iv])
        facts = gr.facts_away_turns(self.ctx(log(entry(1, "foreground", "away interval", iv))))
        self.assertEqual([f["kind"] for f in facts], ["away-unplaced"])

    def test_unmatched_open_marker_runs_to_the_end_of_the_game(self):
        lg = log(open_entry(1, 20), away_entry(2, 1, 3), open_entry(3, 1))  # the second marker is closed by the interval at hide 1
        opens = gr.away_open(lg)
        self.assertEqual(len(opens), 1)
        turns = gr.away_turns(gr.away_intervals(lg), self.RECORD, opens=opens)
        self.assertEqual((turns[0]["round"], turns[0]["turn"], turns[0]["via"]), (1, 1, ["visibility"]))  # the closed interval
        self.assertEqual([(t["round"], t["turn"]) for t in turns if "open" in t["via"]], [(1, 2), (1, 3), (2, 1), (2, 2), (2, 3)])
        self.assertIn("never returned in the log", gr.facts_away_turns(self.ctx(lg))[0]["text"])

    def test_two_intervals_in_one_turn_add_up(self):
        ivs = gr.away_intervals(log(away_entry(1, 1, 3), away_entry(2, 6, 9, via="pageshow")))
        t = gr.away_turns(ivs, self.RECORD)
        self.assertEqual((len(t), t[0]["overlapS"], t[0]["via"]), (1, 5.0, ["pageshow", "visibility"]))

    def test_only_the_latest_intervals_are_read_and_the_cut_is_a_fact(self):
        lg = log(*[away_entry(i, i, i + 0.5) for i in range(1, gr.AWAY_KEEP + 4)])
        self.assertEqual(len(gr.away_intervals(lg)), gr.AWAY_KEEP)
        self.assertEqual(gr.away_intervals(lg)[-1]["hiddenAtMs"], T0 + (gr.AWAY_KEEP + 3) * 1000)
        self.assertIn("away-truncated", [f["kind"] for f in gr.facts_away_turns(self.ctx(lg))])

    def test_a_page_that_ran_through_the_hide_is_a_hidden_game_screen_not_an_app_away(self):
        lg = log(away_entry(1, 14, 20, ranHiddenMs=5_000, suspendedHidden=False))
        text = gr.facts_away_turns(self.ctx(lg))[0]["text"]
        self.assertIn("had the game screen hidden, with the page still running,", text)
        self.assertNotIn("had the app away", text)

    def test_a_suspended_or_old_interval_keeps_the_app_away_wording(self):
        for extra in ({"ranHiddenMs": 3_000, "suspendedHidden": True}, {"ranHiddenMs": 1_000, "suspendedHidden": False}, {}):
            text = gr.facts_away_turns(self.ctx(log(away_entry(1, 14, 20, **extra))))[0]["text"]
            self.assertIn("had the app away during", text)
            self.assertNotIn("kept running", text)

    def test_an_open_marker_with_an_away_running_line_kept_running(self):
        running = entry(2, "foreground", "away running", {"hiddenAtMs": T0 + 20_000, "hiddenMono": 1, "ranHiddenMs": 10_000, "from": "game", "fromStage": "game.round.play"})
        text = gr.facts_away_turns(self.ctx(log(open_entry(1, 20), running)))[0]["text"]
        self.assertIn("had the game screen hidden, with the page still running,", text)
        self.assertIn("never returned in the log", text)
        plain = gr.facts_away_turns(self.ctx(log(open_entry(1, 20))))[0]["text"]
        self.assertIn("had the app away during", plain)

    def test_mixed_intervals_name_the_running_turns(self):
        lg = log(away_entry(1, 1, 3), away_entry(2, 14, 20, ranHiddenMs=6_000, suspendedHidden=False))
        text = gr.facts_away_turns(self.ctx(lg))[0]["text"]
        self.assertIn("had the app away during", text)
        self.assertIn("round 1 turn 2 (6 s, the page kept running)", text)

    def test_page_started_hidden_is_labelled(self):
        facts = gr.facts_away_turns(self.ctx(log(away_entry(1, 1, 5, startedHidden=True))))
        self.assertIn("page started hidden", facts[0]["text"])

    def test_fact_names_the_player_and_turns_and_skips_players_without_intervals(self):
        ctx = gr.Ctx(players=[{"id": A, "username": "alice"}, {"id": B, "username": "bob"}], chain={"record": self.RECORD},
                     logs={A: log(away_entry(1, 14, 20)), B: log(entry(1, "rtc", "x"))})
        facts = gr.facts_away_turns(ctx)
        self.assertEqual([f["account"] for f in facts], [A])
        self.assertIn("round 1 turn 2 (6 s)", facts[0]["text"])

    def test_a_log_with_no_away_lines_adds_nothing(self):
        lg = log(entry(1, "vote", "tap"), entry(2, "rtc", "mesh open"))
        self.assertEqual(gr.facts_away_turns(self.ctx(lg)), [])
        self.assertEqual((gr.away_intervals(lg), gr.away_open(lg), gr.away_truncated(lg)), ([], [], False))

    def test_no_turns_without_intervals(self):
        self.assertEqual(gr.away_turns([], self.RECORD), [])

    def test_a_later_page_session_bounds_an_unmatched_open_marker(self):
        old = open_entry(1, 1)
        old["sessionId"] = "old"
        resumed = entry(2, "replay", "session.link")
        resumed.update(ts=T0 + 5000, sessionId="new")
        opens = gr.away_open(log(old, resumed))
        self.assertEqual(len(opens), 1)
        self.assertEqual(opens[0]["shownAtMs"], T0 + 5000)
        self.assertEqual(opens[0]["via"], "session-resumed")

    def test_saved_game_260_263_264_cases_do_not_invent_away_facts(self):
        facts = {}
        for case in AWAY_FACT_CASES:
            ctx = gr.Ctx(players=case["players"], chain={"record": case["record"]}, logs=case["logs"],
                         joined=set(case["joined"]))
            facts[case["game"]] = gr.facts_away_turns(ctx)

        self.assertEqual(len(facts[260]), 1)
        self.assertEqual(facts[260][0]["account"], "russel")
        self.assertIn("round 2 turn 6 (1.7 s)", facts[260][0]["text"])
        self.assertEqual(facts[263], [])
        self.assertEqual(facts[264], [])


class CompletenessOracleTest(unittest.TestCase):
    def line(self, ts=1000, session="s1", tag="rtc", message="joined"):
        return {"ts": ts, "sessionId": session, "tag": tag, "message": message}

    def test_matches_the_exact_four_field_identity_and_retains_occurrences(self):
        line = self.line()
        result = grp.compare_log_completeness([line, dict(line)], [line, dict(line)])
        self.assertTrue(result["ok"])
        self.assertEqual((result["expected"], result["delivered"]), (2, 2))

    def test_mask_safe_matches_the_typescript_contract(self):
        cases = {
            "Unauthorized": "Unau*horized",
            "no credentials": "no cr*dentials",
            "Bad PASSWORD here": "Bad PA*SWORD here",
            "client secret missing": "client se*ret missing",
            "AUTH failed": "AU*H failed",
            "Invalid.Payment": "Invalid.Payment",
        }
        self.assertEqual({text: grp.mask_safe(text) for text in cases}, cases)

    def test_device_truth_and_delivered_candidates_share_the_masked_identity(self):
        raw = self.line(message="Unauthorized")
        masked = self.line(message="Unau*horized")
        self.assertTrue(grp.compare_log_completeness([raw], [masked])["ok"])
        self.assertTrue(grp.compare_log_completeness([raw], [raw])["ok"])

    def test_game_835_raw_ip_and_sentry_scrubbed_line_share_one_occurrence(self):
        raw = self.line(message="candidate 10.130.0.115 reached the relay")
        scrubbed = self.line(message="candidate ************ reached the relay")
        self.assertEqual(grp.masked_log_line_key(raw), grp.masked_log_line_key(scrubbed))
        comparison = grp.compare_log_completeness([raw], [scrubbed])
        self.assertTrue(comparison["ok"])
        self.assertEqual((comparison["expected"], comparison["delivered"]), (1, 1))

    def test_ipv6_and_sentry_scrubbed_line_share_one_occurrence(self):
        raw = self.line(message="candidate 2001:db8::1 reached the relay")
        scrubbed = self.line(message="candidate *********** reached the relay")
        self.assertEqual(grp.masked_log_line_key(raw), grp.masked_log_line_key(scrubbed))

    def test_game_843_ip_ports_and_mapped_addresses_share_masked_occurrences(self):
        cases = [
            ("stats cand L:relay/udp 104.30.145.164:29235",
             "stats cand L:relay/udp **************:29235"),
            ("stats cand host/tcp 10.130.0.81:9",
             "stats cand host/tcp ***********:9"),
            ("stats cand host/tcp ::ffff:10.130.0.81:9",
             "stats cand host/tcp *******************:9"),
            ("stats cand host/tcp [2001:db8::1]:443",
             "stats cand host/tcp ***********:443"),
        ]
        for raw_message, scrubbed_message in cases:
            with self.subTest(raw=raw_message):
                raw = self.line(message=raw_message)
                scrubbed = self.line(message=scrubbed_message)
                self.assertEqual(grp.masked_log_line_key(raw), grp.masked_log_line_key(scrubbed))
                comparison = grp.compare_log_completeness(
                    [raw, dict(raw)], [scrubbed, dict(scrubbed)], require_no_double_count=True)
                self.assertTrue(comparison["ok"])
                self.assertEqual((comparison["expected"], comparison["delivered"]), (2, 2))

    def test_invalid_ip_port_candidate_is_left_unchanged(self):
        message = "candidate 999.30.145.164:70000 is not a valid endpoint"
        self.assertEqual(grp.mask_safe(message), message)

    def test_masked_and_raw_delivery_copies_are_deduplicated_before_compare(self):
        raw = self.line(message="Unauthorized")
        masked = self.line(message="Unau*horized")
        merged = grp.merge_log_sources([[raw]], log_sources=[[masked]])
        self.assertEqual(len(merged), 1)
        self.assertTrue(grp.compare_log_completeness([raw], merged, require_no_double_count=True)["ok"])

    def test_game_843_handover_identity_dedupes_across_chunks_and_report_output(self):
        wake = self.line(ts=1792281544411, message="screen wake lock refused") | {
            "tag": "wake", "_deliveryId": "g843-wake"}
        clock = self.line(ts=1792281544412, message="handover offset") | {
            "tag": "clock", "_deliveryId": "g843-clock"}
        chunks = [
            {"id": "handover", "beginId": "b", "seq": 1, "part": 0,
             "lines": [wake, clock, wake, clock], "_viaLogs": True},
            {"id": "rolling", "beginId": "b", "seq": 2, "part": 0,
             "lines": [wake, clock], "_viaLogs": True},
        ]
        stitched = grp.stitch_log_chunks(chunks)
        self.assertEqual(len(stitched["entries"]), 2)
        merged = grp.merge_log_sources([], [stitched["entries"]])
        expected = [{key: value for key, value in line.items() if key != "_deliveryId"}
                    for line in (wake, clock)]
        self.assertEqual(merged, expected)
        self.assertTrue(grp.compare_log_completeness(
            expected, merged, require_no_double_count=True)["ok"])

    def test_game_843_same_millisecond_repeats_count_once_per_capture_id(self):
        first = self.line(ts=1792281544411, message="same") | {"_deliveryId": "g843:1"}
        second = self.line(ts=1792281544411, message="same") | {"_deliveryId": "g843:2"}
        full = grp.merge_log_sources([[first, second]], keep_ids=True)
        merged_with_ids = grp.merge_log_sources(
            [full], [[dict(first), dict(second)]], keep_ids=True)
        self.assertEqual([line["_deliveryId"] for line in merged_with_ids], ["g843:1", "g843:2"])
        merged = grp.merge_log_sources([merged_with_ids])
        self.assertEqual(len(merged), 2)
        self.assertTrue(grp.compare_log_completeness(
            [{key: value for key, value in line.items() if key != "_deliveryId"}
             for line in (first, second)], merged, require_no_double_count=True)["ok"])

    def test_empty_truth_and_t12_extra_occurrence_are_red(self):
        self.assertFalse(grp.compare_log_completeness([], [self.line()])["ok"])
        result = grp.compare_log_completeness([self.line()], [self.line(), self.line()], require_no_double_count=True)
        self.assertFalse(result["ok"])
        self.assertEqual(len(result["duplicateDeliveries"]), 1)

    def test_every_missing_line_is_red(self):
        result = grp.compare_log_completeness([self.line(), self.line(1001, message="second")], [self.line()])
        self.assertFalse(result["ok"])
        self.assertEqual(result["missing"], [self.line(1001, message="second")])

    def test_eviction_receipt_is_retained_as_reported_evidence_not_a_wildcard(self):
        receipt = {"id": "g1:s1:begin:0:0", "gameIndex": 1}
        result = grp.compare_log_completeness([self.line()], [], {"evictedOnDevice": [receipt]})
        self.assertFalse(result["ok"])
        self.assertEqual(result["evictedOnDevice"], [receipt])

    def test_manifest_gap_is_red_even_when_a_full_log_covers_the_lines(self):
        line = self.line()
        result = grp.compare_log_completeness([line], [line], {"missingSeqs": [2], "missingParts": [{"seq": 2, "part": 0}]})
        self.assertFalse(result["ok"])
        self.assertEqual(result["missingSeqs"], [2])

    def test_t1_requires_both_the_full_log_and_checkpoint_chunks(self):
        line = self.line()
        self.assertFalse(grp.compare_log_completeness([line], [line], {"full": True}, require_full_and_chunks=True)["ok"])
        self.assertTrue(grp.compare_log_completeness([line], [line], {"full": True, "chunks": 2}, require_full_and_chunks=True)["ok"])

    def test_t6_requires_a_report_copy_and_checkpoint_chunks(self):
        line = self.line()
        self.assertFalse(grp.compare_log_completeness([line], [line], {"report": True}, require_report_and_chunks=True)["ok"])
        self.assertTrue(grp.compare_log_completeness([line], [line], {"report": True, "chunks": 1}, require_report_and_chunks=True)["ok"])

    def test_missing_sentry_received_time_is_red_when_chunk_lines_exist(self):
        line = self.line()
        result = grp.compare_log_completeness(
            [line], [line],
            {"chunkLineOccurrences": 1, "chunkAcceptances": [{"capturedAt": 1000, "lines": [line]}]}, fault_started_at="1970-01-01T00:00:00Z", recovered_at="1970-01-01T00:00:01Z", enforce_latency=True,
        )
        self.assertFalse(result["ok"])
        self.assertFalse(result["latencyEvidenceComplete"])

    def test_faulted_tail_delivery_over_sixty_seconds_is_red(self):
        result = grp.compare_log_completeness([self.line(ts=1000)], [self.line(ts=1000)], {"chunkLineOccurrences": 1, "chunkAcceptances": [{"receivedAt": "1970-01-01T00:01:02Z", "capturedAt": 0, "lines": [self.line(ts=1000)]}]}, fault_started_at="1970-01-01T00:00:00Z", recovered_at="1970-01-01T00:00:01Z", enforce_latency=True)
        self.assertFalse(result["ok"])
        self.assertEqual(result["latencyMs"], 61000)

    def test_fault_latency_starts_at_recovery(self):
        line = self.line(ts=1000)
        result = grp.compare_log_completeness([line], [line], {"chunkLineOccurrences": 1, "chunkAcceptances": [{"receivedAt": "1970-01-01T00:02:40Z", "capturedAt": 1_000, "lines": [line]}]}, fault_started_at="1970-01-01T00:00:00Z", recovered_at="1970-01-01T00:01:40Z", enforce_latency=True)
        self.assertTrue(result["ok"])
        self.assertEqual(result["latencyMs"], 60000)

    def test_chunk_accepted_before_recovery_does_not_enter_fault_latency(self):
        line = self.line(ts=1000)
        result = grp.compare_log_completeness([line], [line], {"chunkLineOccurrences": 1, "chunkAcceptances": [{"receivedAt": "1970-01-01T00:00:02Z", "capturedAt": 1_000, "lines": [line]}]}, fault_started_at="1970-01-01T00:00:00Z", recovered_at="1970-01-01T00:01:40Z", enforce_latency=True)
        self.assertTrue(result["ok"])
        self.assertIsNone(result["latencyMs"])

    def test_post_recovery_checkpoint_is_timed_from_checkpoint_not_fault_end(self):
        line = self.line(ts=159_000)
        result = grp.compare_log_completeness(
            [line], [line],
            {"chunkLineOccurrences": 1, "chunkAcceptances": [{"receivedAt": "1970-01-01T00:02:40Z", "capturedAt": 159_000, "lines": [line]}]},
            fault_started_at="1970-01-01T00:00:00Z", recovered_at="1970-01-01T00:01:40Z", enforce_latency=True,
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["latencyMs"], 1000)

    def test_fault_latency_fails_without_a_recovery_boundary(self):
        line = self.line()
        result = grp.compare_log_completeness(
            [line], [line],
            {"chunkLineOccurrences": 1, "chunkAcceptances": [{"receivedAt": "1970-01-01T00:00:02Z", "capturedAt": 1000, "lines": [line]}]},
            enforce_latency=True,
        )
        self.assertFalse(result["ok"])
        self.assertFalse(result["latencyEvidenceComplete"])

    @mock.patch.object(grp, "parse_ts", return_value=datetime.datetime.fromtimestamp(62, datetime.timezone.utc))
    def test_healthy_or_clock_offset_persona_is_exempt_from_acceptance_latency(self, _parse):
        line = self.line(ts=1000)
        result = grp.compare_log_completeness([line], [line], {"chunkLineOccurrences": 1, "chunkAcceptances": [{"lines": [line]}]})
        self.assertTrue(result["ok"])
        self.assertTrue(result["latencyEvidenceComplete"])

    def test_t12_allows_expected_full_log_chunk_overlap_but_rejects_a_source_overage(self):
        line = self.line()
        self.assertTrue(grp.compare_log_completeness([line], [line], require_no_double_count=True)["ok"])
        result = grp.compare_log_completeness([line], [line, line], require_no_double_count=True)
        self.assertFalse(result["ok"])
        self.assertEqual(result["duplicateDeliveries"], [line])

    def test_t12_ignores_full_log_lines_after_the_page_owned_cutoff(self):
        expected = self.line(ts=1000, message="checkpointed")
        post_cutoff = self.line(ts=3000, message="full-log tail")
        result = grp.compare_log_completeness(
            [expected, post_cutoff], [expected, post_cutoff],
            truth_cutoff_at=2000, require_no_double_count=True,
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["duplicateDeliveries"], [])
        self.assertEqual(result["excludedAfterCheckpoint"], 1)

    def test_t12_ignores_deliveries_before_page_truth_but_preserves_in_window_occurrences(self):
        first = self.line(ts=2000, message="same") | {"_deliveryId": "capture-a"}
        second = self.line(ts=2000, message="same") | {"_deliveryId": "capture-b"}
        before_truth = self.line(ts=1000, message="before truth") | {"_deliveryId": "capture-old"}
        after_cutoff = self.line(ts=3000, message="after cutoff") | {"_deliveryId": "capture-late"}
        delivered = grp.merge_log_sources(
            [[before_truth, first, second, after_cutoff]],
            [[dict(first), dict(second)]],
        )
        truth = [{key: value for key, value in line.items() if key != "_deliveryId"}
                 for line in (first, second)]
        result = grp.compare_log_completeness(
            truth, delivered, truth_cutoff_at=2500, require_no_double_count=True)
        self.assertTrue(result["ok"])
        self.assertEqual((result["expected"], result["delivered"]), (2, 2))
        self.assertEqual(result["duplicateDeliveries"], [])

    def test_truth_start_bound_does_not_hide_an_in_window_loss(self):
        before_truth = self.line(ts=500, message="before truth")
        sent = self.line(ts=1000, message="sent")
        missed = self.line(ts=1500, message="missed")
        result = grp.compare_log_completeness(
            [sent, missed], [before_truth, sent], truth_cutoff_at=2000,
            require_no_double_count=True,
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["missing"], [missed])
        self.assertEqual(result["duplicateDeliveries"], [])

    def test_unique_in_window_telemetry_absent_from_page_snapshot_is_not_a_duplicate(self):
        expected = self.line(ts=1000, message="checkpointed")
        page_shutdown = self.line(ts=1500, message="page.hidden")
        result = grp.compare_log_completeness(
            [expected], [expected, page_shutdown], truth_cutoff_at=2000,
            require_no_double_count=True,
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["duplicateDeliveries"], [])

    def test_truth_stops_at_last_page_checkpoint_without_hiding_an_earlier_loss(self):
        sent = self.line(ts=1000, message="sent")
        missed = self.line(ts=1500, message="missed before checkpoint")
        tail = self.line(ts=3000, message="after payoff send")
        red = grp.compare_log_completeness([sent, missed, tail], [sent], truth_cutoff_at=2000)
        self.assertFalse(red["ok"])
        self.assertEqual(red["missing"], [missed])
        green = grp.compare_log_completeness([sent, tail], [sent], truth_cutoff_at=2000)
        self.assertTrue(green["ok"])
        self.assertEqual((green["expected"], green["excludedAfterCheckpoint"]), (1, 1))

    def test_pre_fault_receipts_cannot_shrink_truth_past_a_lost_page_checkpoint(self):
        before = self.line(ts=1000, message="received before fault")
        after = self.line(ts=3000, message="page checkpointed after fault")
        meta = {"chunkLineOccurrences": 1, "chunkAcceptances": [{"receivedAt": "1970-01-01T00:00:01Z", "capturedAt": 1000, "lines": [before]}]}
        result = grp.compare_log_completeness([before, after], [before], meta, truth_cutoff_at=3000)
        self.assertFalse(result["ok"])
        self.assertEqual(result["missing"], [after])

    def test_full_log_with_unparseable_received_fails_with_a_clear_reason(self):
        line = self.line()
        result = grp.compare_log_completeness([line], [line], {"fullAcceptances": [{"id": "full-1", "receivedAt": "not-a-time", "lines": [line]}]})
        self.assertFalse(result["ok"])
        self.assertEqual(result["acceptanceErrors"], ["full log full-1 has no parseable Sentry received time"])

    def test_sentry_received_second_rounding_clamps_a_subsecond_negative_only(self):
        line = self.line(ts=1000)
        common = {"chunkLineOccurrences": 1, "chunkAcceptances": [{"receivedAt": "1970-01-01T00:00:01Z", "capturedAt": 1500, "lines": [line]}]}
        rounded = grp.compare_log_completeness([line], [line], common, fault_started_at="1970-01-01T00:00:00Z", recovered_at="1970-01-01T00:00:00Z", enforce_latency=True)
        self.assertTrue(rounded["ok"])
        self.assertEqual(rounded["latencyMs"], 0)
        too_early = {"chunkLineOccurrences": 1, "chunkAcceptances": [{**common["chunkAcceptances"][0], "capturedAt": 2501}]}
        self.assertFalse(grp.compare_log_completeness([line], [line], too_early, fault_started_at="1970-01-01T00:00:00Z", recovered_at="1970-01-01T00:00:00Z", enforce_latency=True)["ok"])

    def test_fault_window_line_only_in_full_log_is_timed_by_full_received(self):
        line = self.line(ts=1500)
        meta = {"chunkLineOccurrences": 1, "chunkAcceptances": [{"receivedAt": "1970-01-01T00:00:01Z", "capturedAt": 500, "lines": [self.line(ts=500, message="chunk")]}],
                "fullAcceptances": [{"receivedAt": "1970-01-01T00:01:03Z", "lines": [line]}]}
        result = grp.compare_log_completeness([line], [line], meta, fault_started_at="1970-01-01T00:00:01Z", recovered_at="1970-01-01T00:00:02Z", enforce_latency=True)
        self.assertFalse(result["ok"])
        self.assertEqual(result["latencyMs"], 61000)


class VoteTrailTest(unittest.TestCase):
    def test_counts_and_filed_by(self):
        lg = log(entry(1, "vote", "tap"), entry(2, "vote", "tap"),
                 entry(3, "vote", "turn sealed", {"auto": [B, C]}), entry(4, "vote", "turn sealed", {"auto": []}),
                 entry(10, "vote", "report built", {"filedBy": "auto-confirm", "players": {B: {"verdict": "notperson"}}}),
                 entry(10.3, "signtx", "signed"))
        t = gr.vote_trail(lg)
        self.assertEqual((t["taps"], t["turns"], t["defaults"], t["filedBy"]), (2, 2, 2, "auto-confirm"))
        self.assertEqual(t["signed"], T0 + 10300)

    def test_a_replayed_turn_override_and_its_undo_move_the_defaults(self):
        # #569: a tap on a re-opened sealed turn replaces its default; the undo of a replay ban restores it
        lg = log(entry(1, "vote", "turn sealed", {"auto": [B, C]}),
                 entry(2, "vote", "tap"), entry(2.1, "vote", "seal overridden", {"turn": 0, "target": B}))
        self.assertEqual(gr.vote_trail(lg)["defaults"], 1)
        lg = log(entry(1, "vote", "turn sealed", {"auto": [B, C]}),
                 entry(2, "vote", "tap"), entry(2.1, "vote", "seal overridden", {"turn": 0, "target": B}),
                 entry(3, "vote", "seal restored", {"turn": 0, "target": B}))
        self.assertEqual(gr.vote_trail(lg)["defaults"], 2)

    def test_no_vote_entries_means_no_trail(self):
        self.assertIsNone(gr.vote_trail(log(entry(1, "rtc", "mesh open"))))

    def test_override_before_build_is_kept_after_is_late(self):
        lg = log(entry(5, "vote", "override", {"target": B, "verdict": "person"}),
                 entry(10, "vote", "report built", {"filedBy": "tap", "players": verdicts(**{B: "person"})}),
                 entry(10.4, "signtx", "signed"),
                 entry(12.5, "vote", "override", {"target": B, "verdict": "notperson"}))
        o = gr.vote_trail(lg)["overrides"]
        self.assertFalse(o[0]["late"])
        self.assertEqual(o[0]["sBeforeBuild"], 5.0)
        self.assertTrue(o[1]["late"])
        self.assertTrue(o[1]["afterSign"])
        self.assertEqual(o[1]["sAfterBuild"], 2.5)


class OverrideEffectTest(unittest.TestCase):
    chain = {
        A: {"groups": [0, 1], "yesPerson": 0, "noNotPerson": 0, "sentReport": True},
        B: {"groups": [0, 1], "yesPerson": 3, "noNotPerson": 6, "sentReport": True},   # shares both rounds with A: weight 2
        C: {"groups": [0, 2], "yesPerson": 1, "noNotPerson": 1, "sentReport": True},   # shares one round: weight 1
    }

    def trails(self, ov_target, ov_verdict):
        lg = log(entry(10, "vote", "report built", {"filedBy": "auto-confirm", "players": verdicts(**{B: "notperson", C: "notperson"})}),
                 entry(12, "vote", "override", {"target": ov_target, "verdict": ov_verdict}))
        return {A: gr.vote_trail(lg)}

    def test_lost_person_override_can_flip_the_attestation(self):
        r = gr.override_effects(self.trails(B, "person"), self.chain)
        self.assertEqual(len(r), 1)
        self.assertEqual((r[0]["weight"], r[0]["tally"], r[0]["tallyIfKept"], r[0]["flips"]), (2, [3, 6], [5, 4], True))

    def test_lost_override_that_changes_nothing_decisive(self):
        r = gr.override_effects(self.trails(C, "person"), self.chain)
        self.assertEqual((r[0]["weight"], r[0]["tallyIfKept"], r[0]["flips"]), (1, [2, 0], True))  # 1/1 tie becomes 2/0

    def test_override_matching_the_built_verdict_is_not_lost(self):
        self.assertEqual(gr.override_effects(self.trails(B, "notperson"), self.chain), [])

    def test_early_override_is_not_listed(self):
        lg = log(entry(5, "vote", "override", {"target": B, "verdict": "person"}),
                 entry(10, "vote", "report built", {"filedBy": "tap", "players": verdicts(**{B: "person"})}))
        self.assertEqual(gr.override_effects({A: gr.vote_trail(lg)}, self.chain), [])

    def test_a_lost_override_on_an_unvoted_target_flips_only_when_it_rejects(self):
        chain_by = {A: {"groups": [0]}, B: {"groups": [0], "yesPerson": 0, "noNotPerson": 0, "sentReport": True}}

        def flips(built, override):
            lg = log(entry(10, "vote", "report built", {"filedBy": "auto-confirm", "players": verdicts(**{B: built})}),
                     entry(12, "vote", "override", {"target": B, "verdict": override}))
            return gr.override_effects({A: gr.vote_trail(lg)}, chain_by)[0]["flips"]

        self.assertFalse(flips("notperson", "person"))
        self.assertTrue(flips("person", "notperson"))

    def test_a_lost_override_on_a_target_who_never_reported_flips_nothing(self):
        chain_by = {A: {"groups": [0]}, B: {"groups": [0], "yesPerson": 1, "noNotPerson": 2, "sentReport": False}}
        lg = log(entry(10, "vote", "report built", {"filedBy": "auto-confirm", "players": verdicts(**{B: "notperson"})}),
                 entry(12, "vote", "override", {"target": B, "verdict": "person"}))
        r = gr.override_effects({A: gr.vote_trail(lg)}, chain_by)[0]
        self.assertEqual((r["weight"], r["tally"], r["tallyIfKept"], r["flips"]), (1, [1, 2], [2, 1], False))


class FunnelTest(unittest.TestCase):
    """Accounts: a chat-worker-only one (side line), a chat-only sign-up, an app-only non-registrant, a no-show, a full player
    and three players who reported and were attested but stopped at the draw, the chest and the end screen."""
    IDLE, CS, AP, NS, FP, D1, C1, E1, OUT = ("5" + c * 47 for c in "ICPNFDKEO")
    OPEN, SETTLE = "2026-10-15T10:00:00Z", "2026-10-15T12:00:00Z"

    @staticmethod
    def root(op, ts, outcome=None, **kw):
        r = {"span.op": op, "timestamp": ts, "journey.outcome": outcome, "span.duration": 10, "environment": "dim2.paseo", "game.index": "9"}
        if not op.startswith("chat."):
            r["host.kind"] = "android"
        return {**r, **kw}

    def doc(self, humanity=False, registered_without_telemetry=False, isolated_game=False, late_open=False, interim=False):
        R = self.root
        w = lambda hh: f"2026-10-15T{hh}+00:00"
        step = lambda op: {"span.op": op, "timestamp": w("11:10:00"), "span.duration": 5}

        def played(draw, chest, shown, extra=()):
            roots = [R("journey.app-open", w("10:40:00")), R("journey.join", w("11:01:00"), "full"), R("journey.game", w("11:05:00"), "done"),
                     R("journey.payoff", w("11:10:00"), "shown" if shown else "abandoned")]
            steps = [step(o) for o, on in (("payoff.draw.show", draw), ("payoff.chest.show", chest)) if on] + [step(o) for o in extra]
            return {"roots": roots, "steps": steps, "payoff": {"draw.reason": "not-in-draw"} if not draw else {}}

        pull = {"game": 9, "window": ["2026-10-15T10:00:00", "2026-10-15T12:00:00"], "tagged_accounts": [], "players": {
            self.IDLE: {"roots": [R("chat.poll.duration_ms", w("10:15:00")), R("chat.card.first_draw_ms", w("10:16:00"))],
                        "events": [{"title": "chat.start", "level": "info", "timestamp": w("10:15:00")}]},
            self.CS: {"roots": [R("chat.poll.duration_ms", w("10:20:00")), R("journey.game-signup", w("10:21:00"), "sent", **{"host.kind": None})]},
            self.AP: {"roots": [R("journey.app-open", w("10:10:00"), "ok"), R("journey.game-signup", w("10:11:00"), "failed", **{"journey.sad_reason": "no proof"})]},
            self.NS: {"roots": [R("journey.app-open", w("10:30:00"), "ok")]},
            self.FP: played(True, True, True, (["payoff.humanity.open"] if humanity else [])),
            self.D1: played(False, False, False),
            self.C1: played(True, False, False),
            self.E1: played(True, True, False),
            # telemetry only before registration opened: not in the report at all
            self.OUT: {"roots": [R("journey.app-open", w("09:00:00"))]}}}
        pull["players"][self.C1]["payoff"] = {"chest.reason": "read-failed"}
        if registered_without_telemetry:
            pull["players"][self.NS] = {"roots": []}
        late = "5" + "L" * 47
        if late_open:  # registered, and opened the app only after the last round's play had ended (before settlement)
            record = {"rounds": 1, "groups": 1, "maxGroupSize": 6, "gameDate": 1792065300}
            after = datetime.datetime.fromtimestamp(gr.play_windows(record)[-1][1] / 1000 + 30, datetime.timezone.utc)
            pull["players"][late] = {"roots": [R("journey.app-open", after.isoformat(), "ok")]}
        if isolated_game:
            game_root = next(r for r in pull["players"][self.FP]["roots"] if r["span.op"] == "journey.game")
            game_root["journey.outcome"] = "isolated"
        acct = lambda a, rep, att: {"account": a, "sentReport": rep, "attended": att, "yesPerson": 1, "noNotPerson": 0,
                                    "groups": [0], "reportTime": None, "expectedMaxVoteWeight": 2}
        chain = {"kickoff": "2026-10-15T11:00:00Z", "registrationOpens": self.OPEN, "settlement": {"time": self.SETTLE, "block": 1},
                 "record": {"rounds": 1, "groups": 1, "maxGroupSize": 6, "gameDate": 1792065300}, "draws": [], "warnings": [],
                 "accounts": [acct(self.CS, False, False), acct(self.NS, False, False)] + [acct(a, True, True) for a in (self.FP, self.D1, self.C1, self.E1)]}
        if late_open:
            chain["accounts"].append(acct(late, False, False))
        if interim:
            chain.update({"interim": True, "interimAt": "2026-10-15T11:03:00.000Z"})
        return gr.assemble(9, pull, chain, None, {}, {})

    def test_an_app_open_after_the_last_round_is_not_joined_in_the_funnel(self):
        late = "5" + "L" * 47
        d = self.doc(late_open=True)
        f = {s["key"]: s for s in d["funnel"]}
        self.assertIn(late, f["registered"]["accounts"])
        self.assertNotIn(late, f["joined"]["accounts"])
        self.assertEqual(f["joined"]["count"], 4)

    def test_stage_one_is_people_who_did_something_and_chat_worker_only_is_a_side_line(self):
        d = self.doc()
        f = {s["key"]: s for s in d["funnel"]}
        self.assertEqual(set(f["live"]["accounts"]), {self.CS, self.AP, self.NS, self.FP, self.D1, self.C1, self.E1})  # no IDLE, no OUT
        self.assertEqual(f["live"]["split"], {"openedApp": 6, "chatSignup": 1, "onChainOnly": 0})
        self.assertIn("sign-ups from registration opening 12:00, everything else from 12:10 (10 minutes after the previous game's settlement) to 14:10 CEST (10 minutes after settlement)", f["live"]["stage"])
        self.assertNotIn("7 days", json.dumps(d["funnel"]))
        side = d["funnelChatIdle"]
        self.assertEqual((side["label"], side["count"], side["accounts"]), ("had the DIM2 chat running but did nothing", 1, [self.IDLE]))
        self.assertEqual([s["key"] for s in d["funnel"]], ["live", "registered", "joined", "played", "reported", "attested", "draw", "chest", "endscreen", "humanity"])

    def test_counts_and_the_chat_signup_stays_in(self):
        d = self.doc()
        self.assertEqual([s["count"] for s in d["funnel"]], [7, 6, 4, 4, 4, 4, 3, 2, 1, None])
        self.assertIn(self.CS, {s["key"]: s for s in d["funnel"]}["registered"]["accounts"])

    def test_registered_account_with_no_telemetry_is_still_in_stage_one(self):
        d = self.doc(registered_without_telemetry=True)
        live = next(s for s in d["funnel"] if s["key"] == "live")
        self.assertIn(self.NS, live["accounts"])
        self.assertEqual(live["split"]["onChainOnly"], 1)
        joined = next(s for s in d["funnel"] if s["key"] == "joined")
        reason = next(row["reason"] for row in joined["dropped"] if row["account"] == self.NS)
        self.assertEqual(reason, "on chain, no sign-up or app telemetry in the window")

    def test_isolated_game_journey_is_not_played_every_round(self):
        d = self.doc(isolated_game=True)
        played = next(s for s in d["funnel"] if s["key"] == "played")
        self.assertNotIn(self.FP, played["accounts"])

    def test_subsets_hold_and_every_dropped_account_appears_once_with_a_reason(self):
        d = self.doc()
        by_n = {s["n"]: s for s in d["funnel"]}
        for s in d["funnel"]:
            if s["from"]:
                self.assertLessEqual(set(s["accounts"]), set(by_n[s["from"]]["accounts"]), s["stage"])
        dropped = [x for s in d["funnel"] for x in s["dropped"]]
        accts = [x["account"] for x in dropped]
        self.assertEqual(sorted(accts), sorted(set(accts)))
        self.assertEqual(set(accts) | set(d["funnel"][8]["accounts"]), set(d["funnel"][0]["accounts"]))
        by = {s["key"]: {x["account"]: x["reason"] for x in s["dropped"]} for s in d["funnel"]}
        self.assertEqual(by["registered"][self.AP], "sign-up failed: no proof")
        self.assertEqual(by["joined"][self.CS], "signed up from the chat, never opened the app")
        self.assertEqual(by["joined"][self.NS], "last app activity 12:30 CEST, before kickoff")
        self.assertEqual(by["draw"], {self.D1: "not-in-draw"})
        self.assertEqual(by["chest"], {self.C1: "chest read-failed"})
        self.assertEqual(by["endscreen"], {self.E1: "payoff journey abandoned"})

    def test_drop_reasons_label_times_cet_or_cest_from_the_date(self):
        for day, off, label in (("2026-10-24", 2, "CEST"), ("2026-10-26", 1, "CET")):
            h = lambda hour, minute: f"{hour - off:02d}:{minute:02d}"
            close = gr.parse_ts(f"{day}T{h(13, 52)}:30Z")
            late = {"roots": [self.root("journey.app-open", f"{day}T{h(13, 53)}:00Z")], "events": []}
            self.assertEqual(
                gr.funnel_reason("registered", self.AP, late, None, None, set(), registration_close=close),
                f"opened the app at 13:53 {label}, after registration closed at 13:52:30 {label}; no sign-up attempt.")
            kick = gr.parse_ts(f"{day}T{h(14, 0)}:00Z")
            early = {"roots": [self.root("journey.app-open", f"{day}T{h(12, 58)}:00Z")], "events": []}
            self.assertEqual(gr.funnel_reason("joined", self.AP, early, None, kick, set()),
                             f"last app activity 12:58 {label}, before kickoff")

    def test_russeltest_02_registration_drop_uses_only_pre_close_evidence_and_lists_later_context(self):
        close = gr.parse_ts("2026-10-15T11:52:30Z")
        long_title = "TrUAPI request host:836 (wire 3, 5) timed out after 120000ms without a response from the Polkadot app"
        p = {
            "roots": [self.root("journey.app-open", "2026-10-15T11:53:00Z")],
            "events": [
                {"title": long_title, "timestamp": "2026-10-15T12:01:00Z"},
                {"title": long_title, "timestamp": "2026-10-15T12:01:30Z"},
                {"title": long_title, "timestamp": "2026-10-15T12:02:00Z"},
                {"title": "TrUAPI request host:850 (wire 3, 1) timed out after 120000ms", "timestamp": "2026-10-15T12:03:00Z"},
            ],
        }

        reason = gr.funnel_reason("registered", self.AP, p, None, None, set(), registration_close=close)

        self.assertEqual(
            reason,
            "opened the app at 13:53 CEST, after registration closed at 13:52:30 CEST; no sign-up attempt. "
            "Later context: 4 Polkadot app requests timed out after 120 s at 14:01–14:03 CEST.",
        )

    def test_plain_failed_signup_does_not_repeat_failed(self):
        close = gr.parse_ts("2026-10-15T11:52:30Z")
        p = {"roots": [{"span.op": "journey.game-signup", "journey.outcome": "failed", "timestamp": "2026-10-15T11:50:00Z"}]}
        self.assertEqual(gr.funnel_reason("registered", self.AP, p, None, None, set(), close), "sign-up failed")

    def test_join_drop_uses_only_evidence_before_kickoff(self):
        kickoff = gr.parse_ts("2026-10-15T11:00:00Z")
        p = {
            "roots": [self.root("journey.app-open", "2026-10-15T10:58:00Z")],
            "events": [{"title": "host read timed out after 120000ms", "timestamp": "2026-10-15T11:02:00Z"}],
        }

        reason = gr.funnel_reason("joined", self.NS, p, None, kickoff, set())

        self.assertEqual(
            reason,
            "last app activity 12:58 CEST, before kickoff. Later context: Polkadot app request timed out after 120 s at 13:02 CEST.",
        )

    def test_join_drop_dates_evidence_from_an_earlier_day(self):
        kickoff = gr.parse_ts("2026-10-19T14:05:00Z")
        p = {"roots": [self.root("journey.app-open", "2026-10-17T16:20:00Z")]}

        reason = gr.funnel_reason("joined", self.NS, p, None, kickoff, set())

        self.assertEqual(reason, "last app activity Sat 17 Oct 18:20 CEST, before kickoff")

    def test_a_pre_deadline_timeout_reason_is_never_truncated(self):
        close = gr.parse_ts("2026-10-15T11:52:30Z")
        title = "TrUAPI request host:836 (wire 3, 5) timed out after 120000ms without a response from the Polkadot app"
        p = {"roots": [], "events": [{"title": title, "timestamp": "2026-10-15T11:50:00Z"}]}
        self.assertEqual(
            gr.funnel_reason("registered", self.AP, p, None, None, set(), registration_close=close),
            f"Polkadot app timeout: {title}",
        )

    def test_chest_and_end_screen_read_the_pulls_real_shape(self):
        # a step row and the payoff dict exactly as game-report-pull stores them for game 254
        p = {"roots": [], "steps": [{"span.op": "payoff.draw.show"}, {"span.op": "payoff.chest.show", "span.duration": 3}],
             "payoff": {"chest.count": "10", "chest.outcome": "collectables", "draw.invited": "true", "draw.won": "false",
                        "journey.outcome": "shown", "membership.change": "none"}}
        self.assertTrue(gr.step_ended(p, "payoff.chest.show"))
        self.assertTrue(gr.payoff_shown(p))
        self.assertFalse(gr.payoff_shown({"roots": [], "steps": [], "payoff": {"journey.outcome": "abandoned"}}))

    def test_the_split_has_three_buckets_that_sum_to_stage_one(self):
        app, chat_ok, chat_fail, chain_only = "5" + "1" * 47, "5" + "2" * 47, "5" + "3" * 47, "5" + "4" * 47
        live = {app, chat_ok, chat_fail, chain_only}
        f = gr.funnel(live, {app}, {app, chat_ok, chain_only}, [], lambda s, a: None, chat_signup={chat_ok, chat_fail})
        self.assertEqual(f[0]["split"], {"openedApp": 1, "chatSignup": 2, "onChainOnly": 1})
        self.assertEqual(sum(f[0]["split"].values()), f[0]["count"])
        self.assertEqual(f[0]["splitLabels"]["chatSignup"], "Signed up from the chat without opening the app")
        self.assertTrue(f[0]["stage"].startswith("entered from the app, chat sign-up, or chain"))
        self.assertEqual(
            [(row["key"], row["count"]) for row in f[0]["entryRows"]],
            [("openedApp", 1), ("chatSignup", 2), ("onChainOnly", 1)],
        )
        self.assertEqual(
            [(row["key"], row["count"]) for row in f[1]["sources"]],
            [("openedApp", 1), ("chatSignup", 1), ("onChainOnly", 1)],
        )

    def test_funnel_table_groups_registration_losses_and_collapses_the_clean_run(self):
        app_ok, app_early, app_late = ("5" + digit * 47 for digit in "123")
        chat_ok, chat_failed = ("5" + digit * 47 for digit in "45")
        chain_only = "5" + "6" * 47
        live = {app_ok, app_early, app_late, chat_ok, chat_failed, chain_only}
        registered = {app_ok, chat_ok, chain_only}

        def reason(_stage, account):
            return {
                app_early: "no sign-up attempt",
                app_late: "opened the app after registration closed; no sign-up attempt",
                chat_failed: "sign-up failed",
            }.get(account)

        clean_steps = [
            (key, key, registered, "", True)
            for key in ("joined", "played", "reported", "attested", "draw", "chest", "endscreen")
        ] + [("humanity", "humanity", set(), "Not measured yet", False)]
        rows = gr.funnel(
            live,
            {app_ok, app_early, app_late},
            registered,
            clean_steps,
            reason,
            chat_signup={chat_ok, chat_failed},
        )
        table = gr.funnel_table(rows, {"count": 8, "accounts": ["chat-only"]})

        self.assertEqual(sum(row["count"] for row in table["entries"]), table["entryTotal"])
        registration = table["rows"][0]
        self.assertEqual([(source["key"], source["count"]) for source in registration["sources"]],
                         [("openedApp", 1), ("chatSignup", 1), ("onChainOnly", 1)])
        self.assertEqual(
            [(group["text"], group["count"], group.get("afterDeadline", 0)) for group in registration["why"]],
            [("opened the app but never tried to sign up", 2, 1), ("chat sign-up failed", 1, 0)],
        )
        self.assertEqual(table["rows"][2]["key"], "playedToEnd")
        self.assertEqual(len(table["rows"][2]["collapsed"]), 6)
        self.assertEqual(table["rows"][3]["why"][0]["text"], "not measured yet")
        self.assertNotIn("text", table["side"])  # item 2: the intro says it; no side line
        self.assertEqual(table["side"]["count"], 8)

    def test_funnel_table_groups_dated_player_reasons_but_keeps_each_detail(self):
        a, b = "5" + "1" * 47, "5" + "2" * 47
        rows = gr.funnel(
            {a, b}, {a, b}, {a, b},
            [("joined", "joined", set(), "", True)],
            lambda _stage, account: {
                a: "last app activity Fri 16 Oct 16:14 CEST, before kickoff",
                b: "last app activity Sun 18 Oct 23:53 CEST, before kickoff",
            }[account],
        )
        joined = gr.funnel_table(rows, {"count": 0, "accounts": []})["rows"][1]
        self.assertEqual([(group["text"], group["count"]) for group in joined["why"]],
                         [("last app activity before kickoff", 2)])
        self.assertEqual([detail["reason"] for detail in joined["why"][0]["details"]], [
            "last app activity Fri 16 Oct 16:14 CEST, before kickoff",
            "last app activity Sun 18 Oct 23:53 CEST, before kickoff",
        ])

    def test_a_worker_failure_event_is_not_app_evidence(self):
        win = gr.live_window({"registrationOpens": self.OPEN, "settlement": {"time": self.SETTLE}}, {})
        ts = "2026-10-15T10:30:00+00:00"
        chat_signup = {"roots": [{"span.op": "journey.game-signup", "timestamp": ts, "journey.outcome": "failed"}],
                       "events": [{"title": "signup-failed: bind", "timestamp": ts}]}
        e = gr.live_evidence(chat_signup, win)
        self.assertEqual((e["app"], e["chatSignup"]), (False, True))
        self.assertEqual(gr.live_evidence({"events": [{"title": "chat.start", "timestamp": ts}]}, win)["app"], False)
        self.assertEqual(gr.live_evidence({"roots": [{"span.op": "pageload", "host.kind": "ios", "timestamp": ts}]}, win)["app"], True)

    def test_game_presence_uses_telemetry_from_or_about_a_player_and_chain_reports(self):
        window = (datetime.datetime(2026, 10, 15, 11, 0, tzinfo=datetime.timezone.utc),
                  datetime.datetime(2026, 10, 15, 12, 0, tzinfo=datetime.timezone.utc))
        chain = {"accounts": [
            {"account": A, "sentReport": False}, {"account": B, "sentReport": False},
            {"account": C, "sentReport": True}, {"account": D, "sentReport": False},
        ]}
        pull = {"players": {
            A: {"roots": [{"span.op": "journey.app-open", "host.kind": "ios", "timestamp": "2026-10-15T11:10:00+00:00"}]},
            B: {}, C: {},
            D: {"roots": [{"span.op": "journey.app-open", "host.kind": "ios", "timestamp": "2026-10-15T10:10:00+00:00"}]},
        }}
        log_ts = datetime.datetime(2026, 10, 15, 11, 15, tzinfo=datetime.timezone.utc).timestamp() * 1000
        logs = {A: {"entries": [{"ts": log_ts, "message": f"[jollity-rtc] pc {B} connected"}]}}
        self.assertEqual(gr.game_presence_accounts(7, pull, chain, logs, window), {A, B, C})

    def test_link_presence_ends_with_the_last_round_so_a_late_app_open_is_a_no_show(self):
        window = (datetime.datetime(2026, 10, 22, 9, 59, tzinfo=datetime.timezone.utc),
                  datetime.datetime(2026, 10, 22, 10, 3, tzinfo=datetime.timezone.utc))
        play_end = datetime.datetime(2026, 10, 22, 10, 2, 31, tzinfo=datetime.timezone.utc)
        windows = [(0, 1), (2, play_end.timestamp() * 1000)]
        chain = {"accounts": [{"account": A, "sentReport": False}, {"account": B, "sentReport": False}]}
        pull = {"players": {
            A: {"roots": [{"span.op": "journey.app-open", "host.kind": "ios", "timestamp": "2026-10-22T10:00:30+00:00"}]},
            B: {"roots": [{"span.op": "journey.app-open", "host.kind": "ios", "timestamp": "2026-10-22T10:02:42+00:00"}]},
        }}
        self.assertEqual(gr.game_presence_accounts(7, pull, chain, {}, window), {A, B})  # the page window alone counts B
        cut = gr.rounds_presence_window(window, windows)
        self.assertEqual(gr.game_presence_accounts(7, pull, chain, {}, cut), {A})
        self.assertEqual(gr.rounds_presence_window(window, None), window)
        self.assertIsNone(gr.rounds_presence_window(None, windows))

    def test_presence_starts_at_the_connect_stage_so_an_earlier_sign_up_is_a_no_show(self):
        # The page window opens at the previous game's end (g272: 12:03 CEST, kickoff 15:00). An app open at 14:58:50,
        # before the connect stage, is not presence in the game; one at 14:59:07, inside it, is.
        window = (datetime.datetime(2026, 10, 23, 10, 3, tzinfo=datetime.timezone.utc),
                  datetime.datetime(2026, 10, 23, 13, 13, tzinfo=datetime.timezone.utc))
        kickoff = datetime.datetime(2026, 10, 23, 13, 0, tzinfo=datetime.timezone.utc).timestamp() * 1000
        windows = [(kickoff, kickoff + 72_000), (kickoff + 90_000, kickoff + 162_000)]
        chain = {"accounts": [{"account": A, "sentReport": False}, {"account": B, "sentReport": False},
                              {"account": C, "sentReport": False}]}
        pull = {"players": {
            A: {"roots": [{"span.op": "journey.app-open", "host.kind": "ios", "timestamp": "2026-10-23T11:38:24+00:00"}]},
            B: {"roots": [{"span.op": "journey.app-open", "host.kind": "ios", "timestamp": "2026-10-23T12:58:50+00:00"}]},
            C: {"roots": [{"span.op": "journey.app-open", "host.kind": "ios", "timestamp": "2026-10-23T12:59:07+00:00"}]},
        }}
        self.assertEqual(gr.game_presence_accounts(7, pull, chain, {}, window), {A, B, C})  # the page window alone counts all three
        cut = gr.rounds_presence_window(window, windows)
        self.assertEqual(cut[0], datetime.datetime(2026, 10, 23, 12, 58, 54, tzinfo=datetime.timezone.utc))
        self.assertEqual(gr.game_presence_accounts(7, pull, chain, {}, cut), {C})

    def test_a_chest_step_two_minutes_after_settlement_counts(self):
        d = self.doc()
        # settlement is 12:00 UTC: the window now reaches 12:10, so a chest step at 12:02 is in and one at 12:11 is out
        self.assertEqual(gr.live_window({"registrationOpens": self.OPEN, "settlement": {"time": self.SETTLE}}, {})[1].isoformat(), "2026-10-15T12:10:00+00:00")
        self.assertEqual(gr.chain_window({"kickoff": "2026-10-15T11:00:00Z", "registrationOpens": self.OPEN, "settlement": {"time": self.SETTLE}})[1].isoformat(), "2026-10-15T12:10:00+00:00")
        self.assertEqual(gr.chain_window({"kickoff": "2026-10-15T11:00:00Z", "registrationOpens": self.OPEN, "settlement": None})[1].isoformat(), "2026-10-15T11:25:00+00:00")
        late = {"span.op": "payoff.chest.show", "timestamp": "2026-10-15T12:02:00+00:00"}
        win = gr.live_window({"registrationOpens": self.OPEN, "settlement": {"time": self.SETTLE}}, {})
        self.assertTrue(gr.live_evidence({"steps": [late]}, win)["any"])
        self.assertFalse(gr.live_evidence({"steps": [{**late, "timestamp": "2026-10-15T12:11:00+00:00"}]}, win)["any"])
        self.assertEqual(next(s for s in d["funnel"] if s["key"] == "chest")["count"], 2)

    def test_an_interim_chain_ends_its_windows_two_minutes_after_interim_at(self):
        chain = {"kickoff": "2026-10-15T11:00:00Z", "registrationOpens": self.OPEN, "settlement": None, "interim": True, "interimAt": "2026-10-15T11:03:00.000Z"}
        end = "2026-10-15T11:05:00+00:00"
        self.assertEqual(gr.chain_window(chain)[1].isoformat(), end)
        self.assertEqual(gr.live_window(chain, {})[1].isoformat(), end)
        self.assertEqual(gr.game_page_window(chain, {})[1].isoformat(), "2026-10-15T11:03:00+00:00")
        self.assertEqual(gr.platform_error_window(chain, {}, gr.parse_ts(chain["kickoff"]))[1].isoformat(), "2026-10-15T11:03:00+00:00")
        # a settled chain read with --interim still has a settlement: the normal margin applies
        settled = {**chain, "settlement": {"time": self.SETTLE}}
        self.assertEqual(gr.chain_window(settled)[1].isoformat(), "2026-10-15T12:10:00+00:00")

    def test_an_interim_chain_gets_provisional_attendance_and_a_header(self):
        row = lambda yes, no, sent, att=None: {"sentReport": sent, "yesPerson": yes, "noNotPerson": no, "attended": att}
        chain = {"interim": True, "interimAt": "2026-11-15T11:03:00.000Z",
                 "accounts": [row(3, 1, True), row(1, 1, True), row(5, 0, False), row(1, 0, True),
                              row(0, 0, True), row(0, 0, False), row(0, 1, True)]}
        gr.provisional_attendance(chain)
        self.assertEqual([a["attended"] for a in chain["accounts"]], [True, False, False, True, True, False, False])
        self.assertTrue(chain["attendedProvisional"])
        final = {"accounts": [row(3, 1, True)]}
        gr.provisional_attendance(final)
        self.assertIsNone(final["accounts"][0]["attended"])
        header = gr.interim_header({"interim": {"at": chain["interimAt"]}})
        self.assertTrue(header.startswith("Interim report (as of 12:03 CET, before the 1-hour settle)."))
        self.assertIn("provisional", header)
        self.assertIsNone(gr.interim_header({}))

    def test_the_attested_note_says_the_chain_marked_it_only_once_the_game_settled(self):
        note = lambda d: next(s for s in d["funnel"] if s["key"] == "attested")["note"]
        self.assertTrue(note(self.doc()).startswith("The chain marks this account as attended (it reported, and its yes votes less 1, stopping at 0"))
        interim = note(self.doc(interim=True))
        self.assertTrue(interim.startswith("The rule of the pallet, applied to the votes read so far, marks this account as attended"))
        self.assertNotIn("The chain marks", interim)

    def test_the_draw_stage_counts_invited_and_won(self):
        d = self.doc()
        draw = next(s for s in d["funnel"] if s["key"] == "draw")
        self.assertEqual(draw["stage"], "saw the prize draw")

    def test_humanity_is_not_measured_until_the_app_sends_it(self):
        h = self.doc()["funnel"][-1]
        self.assertEqual((h["count"], h["accounts"], h["dropped"], h["measured"]), (None, [], [], False))
        self.assertIn("Not measured yet", h["note"])
        h = self.doc(humanity=True)["funnel"][-1]
        self.assertEqual((h["count"], h["accounts"]), (1, [self.FP]))

    def test_without_evidence_the_reason_is_unknown(self):
        f = gr.funnel({A, B}, {A, B}, {A, B}, [("joined", "joined", {A}, "", True)], lambda stage, a: None)
        self.assertEqual(f[2]["dropped"], [{"account": B, "reason": "unknown"}])

    def test_players_carry_their_furthest_stage(self):
        d = self.doc()
        st = {p["id"]: p["funnelStage"] for p in d["players"]}
        names = {s["key"]: s["stage"] for s in d["funnel"]}
        self.assertEqual(st[self.FP], names["endscreen"])
        self.assertEqual(st[self.D1], names["attested"])
        self.assertEqual(st[self.C1], names["draw"])
        self.assertEqual(st[self.AP], names["live"])
        self.assertEqual(st[self.NS], names["registered"])
        self.assertEqual(st[self.IDLE], "had the DIM2 chat running but did nothing")
        self.assertNotIn(self.OUT, st)  # only traffic before the window: not in the report at all

    def test_the_evidence_window_starts_ten_minutes_after_registration_opened(self):
        chain = {"registrationOpens": self.OPEN, "settlement": {"time": self.SETTLE}}
        w = gr.live_window(chain, {})
        self.assertEqual((w[0].isoformat(), w[1].isoformat()), ("2026-10-15T10:10:00+00:00", "2026-10-15T12:10:00+00:00"))
        r = gr.report_windows(chain, {})
        self.assertEqual([d.isoformat() for d in r], ["2026-10-15T10:00:00+00:00", "2026-10-15T10:10:00+00:00", "2026-10-15T12:10:00+00:00"])


class WindowSplitTest(unittest.TestCase):
    """Ionut's rule: a report runs from the end of the previous game (its settlement + 10 min) to this game's end, but
    registration for this game opens at the previous settlement, so sign-ups keep that earlier start."""
    OPEN, SETTLE = "2026-10-15T10:00:00Z", "2026-10-15T12:00:00Z"
    REG, SU, PAYOFF, LATE = ("5" + c * 47 for c in "RSPL")

    def doc(self):
        R = FunnelTest.root
        at = lambda minutes: (datetime.datetime(2026, 10, 15, 10, 0, tzinfo=datetime.timezone.utc) + datetime.timedelta(minutes=minutes)).isoformat()
        pull = {"game": 9, "window": ["2026-10-15T10:00:00", "2026-10-15T12:00:00"], "tagged_accounts": [], "players": {
            self.REG: {"roots": []},
            self.SU: {"roots": [R("journey.game-signup", at(1), "sent")]},          # sign-up at previous settlement + 1 min
            self.PAYOFF: {"roots": [R("journey.payoff", at(1), "shown")]},          # previous game's payoff traffic
            self.LATE: {"roots": [R("journey.app-open", at(11), "ok")]}}}           # previous settlement + 11 min
        chain = {"kickoff": "2026-10-15T11:00:00Z", "registrationOpens": self.OPEN, "settlement": {"time": self.SETTLE, "block": 1},
                 "record": {"rounds": 1, "groups": 1, "maxGroupSize": 6, "gameDate": 1792065300}, "draws": [], "warnings": [],
                 "accounts": [{"account": self.REG, "sentReport": False, "attended": False, "yesPerson": 0, "noNotPerson": 0,
                              "groups": [0], "reportTime": None, "expectedMaxVoteWeight": 2}]}
        return gr.assemble(9, pull, chain, None, {}, {})

    def test_a_signup_just_after_registration_opened_is_counted(self):
        self.assertIn(self.SU, next(s for s in self.doc()["funnel"] if s["key"] == "live")["accounts"])

    def test_the_previous_games_payoff_traffic_is_not_counted(self):
        self.assertNotIn(self.PAYOFF, next(s for s in self.doc()["funnel"] if s["key"] == "live")["accounts"])

    def test_an_app_span_ten_minutes_after_registration_opened_is_counted(self):
        self.assertIn(self.LATE, next(s for s in self.doc()["funnel"] if s["key"] == "live")["accounts"])

    def test_the_window_note_names_both_starts(self):
        d = self.doc()
        self.assertEqual(d["reportWindow"]["label"], "sign-ups from registration opening 12:00, everything else from 12:10 "
                         "(10 minutes after the previous game's settlement) to 14:10 CEST (10 minutes after settlement)")
        self.assertEqual((d["reportWindow"]["from"], d["reportWindow"]["evidenceFrom"]), ("2026-10-15T10:00:00+00:00", "2026-10-15T10:10:00+00:00"))

    def test_the_note_gives_dates_when_the_window_crosses_days(self):
        w = gr.ReportWindows(*(datetime.datetime(2026, 10, 16, h, m, tzinfo=datetime.timezone.utc) for h, m in ((10, 0), (10, 10), (23, 10))))
        w = gr.ReportWindows(w.signup_from - datetime.timedelta(days=1), w.start - datetime.timedelta(days=1), w.end)
        self.assertIn("sign-ups from registration opening 15 Oct 12:00, everything else from 15 Oct 12:10", gr.window_note(w))


class GroupVotesTest(unittest.TestCase):
    def test_members_per_round_and_group(self):
        chain = {"record": {"rounds": 2}, "accounts": [
            {"account": A, "groups": [0, 1], "sentReport": True, "yesPerson": 2, "noNotPerson": 1, "attended": True},
            {"account": B, "groups": [0, 0], "sentReport": False, "yesPerson": 0, "noNotPerson": 3, "attended": False},
            {"account": C, "groups": [1, 0], "sentReport": True, "yesPerson": 1, "noNotPerson": 1, "attended": False}]}
        g = gr.group_votes(chain, {A: "a.01"})
        self.assertEqual([(x["round"], x["group"], x["seats"], x["reporters"]) for x in g],
                         [(1, 0, 2, 1), (1, 1, 1, 1), (2, 0, 2, 1), (2, 1, 1, 1)])
        self.assertEqual(g[0]["members"][0]["username"], "a.01")


def player(acct, name, tele, rep, rel="aaaaaaaa", game=None):
    return {"id": acct, "username": name, "telemetry": tele, "sentReport": rep, "release": rel, "game": game}


def chain_acc(a, y, n, att, report_time="2026-10-02T13:08:30.000Z"):
    return {"account": a, "yesPerson": y, "noNotPerson": n, "attended": att, "groups": [0, 0], "sentReport": True,
            "scoreBefore": {"score": 0, "reachedPersonhood": False}, "reportTime": report_time}


class FactsTest(unittest.TestCase):
    def players(self):
        return [player(A, "a.01", "full", True), player(B, "b.01", "none", True, None), player(C, "c.01", "full", False, "bbbbbbbb"), player(D, "d.01", "full", True)]

    def chain(self):
        return {"accounts": [chain_acc(A, 3, 6, False), chain_acc(B, 1, 1, False), chain_acc(C, 0, 0, False), chain_acc(D, 0, 0, False)], "warnings": ["w1"]}

    def ctx(self, **kw):
        ch = kw.pop("chain", self.chain())
        by = {a["account"]: a for a in ch["accounts"]}
        return gr.Ctx(players=kw.pop("players", self.players()), chain=ch, chain_by=by, ties=gr.tied(ch["accounts"]), **kw)

    def test_notable_findings(self):
        lg = log(entry(10, "vote", "report built", {"filedBy": "auto-confirm", "players": verdicts(**{A: "notperson"})}),
                 entry(12, "vote", "override", {"target": A, "verdict": "person"}))
        trails = {D: gr.vote_trail(lg)}
        ctx = self.ctx(trails=trails, logs={D: lg}, pull={"players": {C: {"payoff": {"membership.change": "lost-membership", "membership.standing": "candidate"}}}})
        ctx.overrides = gr.override_effects(trails, ctx.chain_by)
        facts = gr.facts_list(ctx)
        kinds = [f["kind"] for f in facts]
        for k in ("late-override", "reported-no-telemetry", "other-builds", "lost-membership-candidate", "chain-ties", "chain-warning"):
            self.assertIn(k, kinds)
        late = next(f for f in facts if f["kind"] == "late-override")
        self.assertIn("2.0 s after the report was built", late["text"])
        self.assertEqual(next(f for f in facts if f["kind"] == "reported-no-telemetry")["accounts"], [B])

    def test_invariant_lines_from_the_players_own_logs_become_facts(self):
        lg = log(entry(20, "invariant", "funnel-out-of-order", {"stage": "offer", "invariant.previous_stage": "connected"}),
                 entry(30, "invariant", "funnel-out-of-order", {"stage": "answer"}),
                 entry(40, "invariant", "recovery-hold-never-ends", {"invariant.peers_recovering": "2"}),
                 entry(50, "vote", "not an invariant line"))
        facts = gr.facts_invariants(self.ctx(logs={A: lg, D: log()}))
        self.assertEqual([f["invariant"] for f in facts], ["funnel-out-of-order", "recovery-hold-never-ends"])
        funnel, recovery = facts
        self.assertEqual(funnel["accounts"], [A])
        self.assertEqual(funnel["occurrences"], 2)
        self.assertIn("stage=offer", funnel["text"])
        self.assertEqual(recovery["occurrences"], 1)
        self.assertIn("invariant.peers_recovering=2", recovery["text"])

    def test_no_invariant_lines_means_no_facts(self):
        self.assertEqual(gr.facts_invariants(self.ctx(logs={A: log(entry(10, "vote", "report built"))})), [])

    def test_the_kind_list_matches_lib_invariants_ts(self):
        """INVARIANT_KINDS is a hand copy of apps/jollity-app/lib/invariants.ts's InvariantKind union. A kind
        added on one side and not the other silently drops its line from the report (or accepts a
        typo as a real invariant), so the two lists are compared here. (The new repo declares the
        kinds as a union type, not an `as const` array, so match the union's string literals.)"""
        source = os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "apps", "jollity-app", "lib", "invariants.ts")
        with open(source, encoding="utf-8") as fh:
            ts = fh.read()
        block = re.search(r"export type InvariantKind =\s*((?:\s*\|[^\n]+)+)", ts)
        self.assertIsNotNone(block, "apps/jollity-app/lib/invariants.ts has no InvariantKind union")
        kinds = re.findall(r'"([^"]+)"', block.group(1))
        self.assertEqual(kinds, list(gr.INVARIANT_KINDS))

    def test_no_chain_is_a_fact_of_its_own(self):
        facts = gr.facts_chain(gr.Ctx(players=self.players()))
        self.assertEqual([f["kind"] for f in facts], ["chain-missing"])

    def test_clock_skew_is_measured_against_the_common_chain_offset(self):
        # four reporters; the chain offset is ~ -10 s for everyone, D's phone is ~75 s ahead
        base = gr.parse_ts("2026-10-02T13:08:30.000Z").timestamp() * 1000
        trails = {acct: {"built": int(base + (built_s + 10) * 1000), "overrides": [], "verdicts": {}, "taps": 0, "turns": 0, "defaults": 0}
                  for acct, built_s in ((A, 20), (B, 21), (C, 20.5), (D, 95))}
        skew = gr.facts_clock_skew(self.ctx(trails=trails))
        self.assertEqual(len(skew), 1)
        self.assertEqual(skew[0]["account"], D)
        self.assertTrue(70 <= skew[0]["seconds"] <= 80)

    def test_backgrounded_reporter_from_the_game_journey_and_hidden_time(self):
        p = self.players()
        p[0]["game"] = {"outcome": "abandoned"}
        links = {"rounds": [{"start": T0, "end": T0 + 200_000}], "events": [{"at": T0 + 10_000, "account": D, "kind": "hidden"}, {"at": T0 + 150_000, "account": D, "kind": "shown"}]}
        facts = gr.facts_backgrounded(self.ctx(players=p, links=links))
        self.assertEqual(sorted(f["account"] for f in facts), sorted([A, D]))


class HiddenSecondsTest(unittest.TestCase):
    rounds = [{"start": T0, "end": T0 + 200_000}]

    def test_sums_hidden_intervals_inside_the_rounds(self):
        ev = [{"at": T0 + 10_000, "account": A, "kind": "hidden"}, {"at": T0 + 40_000, "account": A, "kind": "shown"},
              {"at": T0 + 100_000, "account": A, "kind": "hidden"}, {"at": T0 + 130_000, "account": A, "kind": "shown"}]
        self.assertEqual(gr.hidden_seconds({"rounds": self.rounds, "events": ev})[A], 60)

    def test_clips_to_the_rounds_and_ignores_other_accounts(self):
        ev = [{"at": T0 - 50_000, "account": A, "kind": "hidden"}, {"at": T0 + 20_000, "account": A, "kind": "shown"},
              {"at": T0 + 190_000, "account": B, "kind": "hidden"}, {"at": T0 + 400_000, "account": B, "kind": "shown"}]
        h = gr.hidden_seconds({"rounds": self.rounds, "events": ev})
        self.assertEqual((h[A], h[B]), (20, 10))

    def test_game_259_hidden_time_starts_at_play_not_the_early_mesh(self):
        rounds = [
            {"start": T0, "end": T0 + 134_400, "playStart": T0 + 62_400, "playEnd": T0 + 134_400},
            {"start": T0 + 134_200, "end": T0 + 213_400,
             "playStart": T0 + 141_400, "playEnd": T0 + 213_400},
        ]
        ev = [
            {"at": T0 + 10_000, "account": A, "kind": "hidden"},
            {"at": T0 + 70_000, "account": A, "kind": "shown"},
            {"at": T0 + 130_000, "account": A, "kind": "hidden"},
            {"at": T0 + 150_000, "account": A, "kind": "shown"},
        ]
        self.assertAlmostEqual(gr.hidden_seconds({"rounds": rounds, "events": ev})[A], 27.6)

    def test_no_links_or_rounds_is_empty(self):
        self.assertEqual(dict(gr.hidden_seconds(None)), {})
        self.assertEqual(dict(gr.hidden_seconds({"rounds": [], "events": []})), {})


class StepRowsTest(unittest.TestCase):
    def player(self, duration, away_ms=None, resumed=None):
        metrics = []
        if away_ms is not None:
            metrics.append({"metric.name": "app.away_ms", "sum(value)": away_ms, "count(value)": 1})
        if resumed is not None:
            metrics.append({"metric.name": "app.resumed", "sum(value)": resumed, "count(value)": resumed})
        return {"steps": [{"span.op": "game-signup.tx.landed", "span.duration": duration}], "metrics": metrics}

    def test_suspended_observation_keeps_raw_duration_and_adds_an_exclusion_median(self):
        players = {
            A: self.player(3_031_000, away_ms=3_000_000, resumed=1),
            B: self.player(30_000),
            C: self.player(40_000),
        }
        raw = json.loads(json.dumps(players))

        rows = gr.step_rows(players, {A: "suspended.01", B: "b.01", C: "c.01"})

        self.assertEqual(rows, [
            {"step": "all (3) · sign-up: tx landed (median)", "ms": 40_000},
            {"step": "suspended.01 · sign-up: tx landed (slowest; may include up to 3000 s away; the game screen was hidden 1 time)", "ms": 3_031_000},
            {"step": "all (2) · sign-up: tx landed (median excluding steps that may include away time)", "ms": 35_000},
        ])
        self.assertEqual(players, raw)

    def test_flagged_non_slowest_step_gets_its_own_raw_evidence_row(self):
        players = {
            A: self.player(50_000, away_ms=30_000, resumed=2),
            B: self.player(100_000),
        }

        rows = gr.step_rows(players, {A: "suspended.01", B: "b.01"})

        self.assertEqual(rows, [
            {"step": "all (2) · sign-up: tx landed (median)", "ms": 75_000},
            {"step": "b.01 · sign-up: tx landed (slowest)", "ms": 100_000},
            {"step": "suspended.01 · sign-up: tx landed (may include up to 30 s away; the game screen was hidden 2 times)", "ms": 50_000},
            {"step": "all (1) · sign-up: tx landed (median excluding steps that may include away time)", "ms": 100_000},
        ])

    def test_a_step_shorter_than_total_away_time_is_unchanged(self):
        players = {A: self.player(20_000, away_ms=30_000, resumed=1), B: self.player(10_000)}

        rows = gr.step_rows(players, {A: "a.01", B: "b.01"})

        self.assertEqual(rows, [
            {"step": "all (2) · sign-up: tx landed (median)", "ms": 15_000},
            {"step": "a.01 · sign-up: tx landed (slowest)", "ms": 20_000},
        ])


class SmallPiecesTest(unittest.TestCase):
    def test_telemetry_level(self):
        self.assertEqual(gr.telemetry_level(True, {"taps": 1}), "full")
        self.assertEqual(gr.telemetry_level(True, None), "partial")
        self.assertEqual(gr.telemetry_level(False, None), "none")
        self.assertEqual(gr.telemetry_level(True, {"taps": 1}, {"dropped_events": 1}), "partial")

    def test_telemetry_health_merges_every_summary_and_flags_late_parts(self):
        health = {"dropped_events": 2, "dropped_metrics": 3, "retries": 5, "longest_wait_ms": 800,
                  "session": {"retries": 3, "longest_wait_ms": 700}}
        events = [{"title": "other", "telemetryHealth": {"dropped_events": 99}},
                  {"title": "telemetry.health", "telemetryHealth": {"dropped_events": 1, "longest_wait_ms": 1200,
                                                                      "session": {"retries": 2, "longest_wait_ms": 900}}},
                  {"title": "telemetry.health", "telemetryHealth": health, "telemetryHealthLate": True}]
        merged = {"dropped_events": 3, "dropped_metrics": 3, "retries": 5, "longest_wait_ms": 1200,
                  "session": {"retries": 5, "longest_wait_ms": 900}, "late_parts": 1}
        self.assertEqual(gr.telemetry_health(events), merged)
        self.assertEqual(gr.telemetry_loss(merged), 6)
        self.assertEqual(gr.telemetry_loss({"failed_5xx": 6, "retries": 5}), 1)
        self.assertEqual(gr.telemetry_loss({"failed_5xx": 1, "retries": 1}), 0)
        self.assertEqual(gr.telemetry_loss({"failed_timeout": 1, "recovered_timeouts": 1}), 0)

    def test_times_note_names_the_zone(self):
        self.assertIn("CEST", gr.times_note(gr.parse_ts("2026-10-02T13:06:00Z")))
        self.assertIn("CET", gr.times_note(gr.parse_ts("2026-12-02T13:06:00Z")))

    def test_add_note_joins_with_a_semicolon(self):
        j = {"outcome": "x"}
        gr.add_note(j, "one")
        gr.add_note(j, "two")
        self.assertEqual(j["note"], "one; two")

    def test_tally_and_tied(self):
        accts = [chain_acc(A, 2, 2, False), chain_acc(B, 0, 0, False), chain_acc(C, 3, 1, True)]
        self.assertEqual([a["account"] for a in gr.tied(accts)], [A])  # a 0/0 is not a tie
        self.assertEqual(gr.tally(accts[2], lambda a: "c.01"), "c.01 3/1")

    def test_display_collects_device_os_host_and_release(self):
        roots = [{"device.os": "ios", "device.os_version": "17.5", "device.model": "iPhone", "host.kind": "ios", "host.app": "Polkadot App", "host.app_version": "0.10.0",
                  "release": "jollity-next@bdffec72038e88626e8e73565094e2dadf06c73d7574971683e6c5a2bab2448a"}]
        d = gr.display(roots, {"model": "iphone-6.1in", "modelSource": "inferred", "screen": "414x896"}, {"user_agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X)"})
        self.assertEqual(d, {"device": "iPhone (6.1 in, 414x896, inferred)", "os": "iOS 17.5.1", "host": "Polkadot App 0.10.0", "release": "bdffec72"})

    def test_display_for_an_android_host_with_no_name_and_for_no_roots(self):
        d = gr.display([{"device.os": "android", "device.os_version": "16", "device.model": "Pixel 10a", "host.kind": "android"}], {"screen": "412x924"}, None)
        self.assertEqual((d["device"], d["os"], d["host"]), ("Pixel 10a (412x924)", "Android 16", "android host (no app name or version sent)"))
        self.assertEqual(gr.display([], None, None)["host"], "unknown")

    def test_display_uses_only_app_roots_and_reports_the_worker_release_separately(self):
        app = {"span.op": "journey.game", "host.kind": "ios", "host.app": "Polkadot App", "host.app_version": "0.10.0",
               "device.os": "ios", "device.os_version": "18.7", "device.model": "iPhone", "release": "jollity-next@app123456789"}
        worker = {"span.op": "chat.poll.duration_ms", "sdk.name": "jollity.chat-worker", "surface": "chat",
                  "device.os": "android", "device.model": "wrong", "release": "jollity-next@worker987654321"}
        roots = [app, worker]
        self.assertEqual(gr.display(roots, None, None), {
            "device": "iPhone", "os": "iOS 18.7", "host": "Polkadot App 0.10.0", "release": "app12345",
        })
        self.assertEqual(gr.worker_release(roots), "worker98")

    def test_a_player_with_only_worker_roots_has_no_app_device_or_release(self):
        worker = {"span.op": "chat.poll.duration_ms", "sdk.name": "jollity.chat-worker", "release": "jollity-next@worker987654321"}
        self.assertEqual(gr.display([worker], {"model": "wrong", "screen": "1x1"}, {"user_agent": "wrong"}),
                         {"device": "unknown", "os": "unknown", "host": "unknown", "release": None})
        self.assertEqual(gr.worker_release([worker]), "worker98")

    def test_app_root_requires_host_kind_and_rejects_chat_ops(self):
        self.assertTrue(gr.is_app_root({"host.kind": "ios", "span.op": "journey.game"}))
        self.assertFalse(gr.is_app_root({"span.op": "journey.game"}))
        self.assertFalse(gr.is_app_root({"host.kind": "ios", "span.op": "chat.poll.duration_ms"}))
        self.assertFalse(gr.is_app_root({"host.kind": "ios", "sdk.name": "jollity.chat-worker", "span.op": "journey.game-signup"}))
        self.assertTrue(gr.is_chat_root({"span.op": "journey.game-signup"}))  # legacy saved pull without sdk.name/surface

    def test_chat_signup_route_wins_over_the_chain_calls_web_fallback(self):
        roots = [{"span.op": "journey.game-signup", "sdk.name": "jollity.chat-worker", "surface": "chat", "signup.route": "free", "journey.outcome": "sent"}]
        self.assertEqual(gr.signup_route(roots, "web"), "chat")
        self.assertEqual(gr.signup_route([{"span.op": "journey.game-signup", "host.kind": "ios", "signup.route": "returning"}], "other"), "web")
        self.assertEqual(gr.signup_route([{"span.op": "journey.game-signup", "host.kind": "ios"}], "other"), "other")

    def test_landed_app_signup_beats_an_earlier_failed_chat_attempt_and_reads_its_route_step(self):
        roots = [
            {"span.op": "journey.game-signup", "journey.outcome": "failed", "signup.route": "free",
             "timestamp": "2026-10-02T12:00:00+00:00", "span.duration": 1000},
            {"span.op": "journey.game-signup", "journey.outcome": "landed", "host.kind": "ios",
             "timestamp": "2026-10-02T12:01:00+00:00", "span.duration": 5000},
        ]
        steps = [{"transaction": "journey.game-signup", "span.op": "route", "signup.route": "returning",
                  "timestamp": "2026-10-02T12:01:02+00:00"}]
        self.assertEqual(gr.signup_route(roots, "other", steps), "web")

    def test_latest_signup_is_used_when_none_landed(self):
        roots = [{"span.op": "journey.game-signup", "journey.outcome": "failed", "signup.route": "free"},
                 {"span.op": "journey.game-signup", "journey.outcome": "not-eligible", "host.kind": "ios", "signup.route": "person"}]
        self.assertEqual(gr.signup_route(roots, "other"), "web")

    def test_player_registration_uses_the_signup_journey_surface_and_keeps_chain_evidence(self):
        roots = [{"span.op": "journey.game-signup", "sdk.name": "jollity.chat-worker", "surface": "chat",
                  "signup.route": "free", "release": "jollity-next@worker987654321", "timestamp": "2026-10-02T12:30:00+00:00"}]
        chain = {"yesPerson": 0, "noNotPerson": 0, "groups": [0], "attended": False, "sentReport": False,
                 "reportTime": None, "scoreBefore": None, "scoreAfter": None}
        rows = gr.build_players([A], {"players": {A: {"roots": roots}}}, {A: chain}, {}, {}, {}, set(),
                                reg_by={A: {"route": "web", "call": "Game.sign_up_with_account_lite_invite", "at": "block-time"}})
        self.assertEqual(rows[0]["registration"], {
            "route": "chat", "call": "Game.sign_up_with_account_lite_invite", "at": "block-time",
        })
        self.assertEqual(rows[0]["workerRelease"], "worker98")

    def test_full_log_coverage_counts_only_full_logs_for_chain_players(self):
        chain = {"accounts": [{"account": A}, {"account": B}, {"account": C}]}
        players = {A: {"log": {"stage": "payoff", "full": True}},
                   B: {"log": {"stage": "report", "full": False}},
                   D: {"log": {"stage": "late", "full": True}}}
        coverage = gr.full_log_coverage(chain, players)
        self.assertEqual(coverage, {"players": 3, "fullLogs": 1, "fullAccounts": [A], "chunkLogs": 0, "missingReasons": [
            {"account": B, "reason": "only the report-stage safety copy arrived"},
            {"account": C, "reason": "no full log or chunk arrived"},
        ]})
        facts = gr.payoff_facts(None, [], {}, {}, [], {}, [], coverage)
        self.assertEqual(facts["Log coverage"],
                         "1 of 3 players have a full log; 0 have durable chunks; 2 lack a full log (reasons listed in report data)")

    def test_saved_pull_log_without_stage_or_full_is_a_legacy_full_log(self):
        chain = {"accounts": [{"account": A}, {"account": B}, {"account": C}]}
        players = {A: {"log": {"event": "old-full"}}, B: {"log": {"stage": "report"}}, C: {"log": None}}
        self.assertEqual(gr.full_log_coverage(chain, players)["fullLogs"], 1)

    def test_chunk_stitching_is_exact_once_and_reports_sequence_gaps(self):
        first = {"id": "same", "seq": 1, "part": 0, "checkpoint": "round-1", "lines": [
            {"ts": 2, "sessionId": "s", "level": "info", "tag": "rtc", "message": "two"},
            {"ts": 1, "sessionId": "s", "level": "info", "tag": "rtc", "message": "one"},
        ]}
        third = {"id": "third", "seq": 3, "part": 0, "checkpoint": "report", "lines": [
            {"ts": 3, "sessionId": "s", "level": "info", "tag": "rtc", "message": "three"},
        ]}
        stitched = grp.stitch_log_chunks([first, first, third])
        self.assertEqual([e["message"] for e in stitched["entries"]], ["one", "two", "three"])
        self.assertEqual((stitched["chunks"], stitched["checkpoints"], stitched["missingSeqs"]),
                         (2, ["round-1", "report"], [2]))

    def test_chunk_stitching_uses_manifest_for_missing_edge_sequences_and_keeps_identical_lines(self):
        same = {"ts": 1, "sessionId": "s", "level": "info", "tag": "rtc", "message": "same"}
        middle = {"id": "middle", "seq": 2, "part": 0, "checkpoint": "round-1", "lines": [same, same]}
        manifest = [{"id": "first", "seq": 1, "part": 0}, {"id": "middle", "seq": 2, "part": 0}, {"id": "last", "seq": 3, "part": 0}]
        stitched = grp.stitch_log_chunks([middle], manifest)
        self.assertEqual([e["message"] for e in stitched["entries"]], ["same", "same"])
        self.assertEqual(stitched["missingSeqs"], [1, 3])
        self.assertEqual([(part["seq"], part["part"]) for part in stitched["missingParts"]], [(1, 0), (3, 0)])

    def test_chunk_stitching_orders_repeated_game_begins_before_their_sequences(self):
        later = {"id": "7:s:b-begin:1:0", "beginId": "b-begin", "seq": 1, "part": 0, "capturedAt": 2, "checkpoint": "report",
                 "lines": [{"ts": 2, "sessionId": "s", "level": "info", "tag": "game", "message": "later"}]}
        earlier = {"id": "7:s:a-begin:1:0", "beginId": "a-begin", "seq": 1, "part": 0, "capturedAt": 1, "checkpoint": "round-1",
                   "lines": [{"ts": 1, "sessionId": "s", "level": "info", "tag": "game", "message": "earlier"}]}
        stitched = grp.stitch_log_chunks([later, earlier])
        self.assertEqual([entry["message"] for entry in stitched["entries"]], ["earlier", "later"])
        self.assertEqual(stitched["checkpoints"], ["round-1", "report"])

    def test_chunk_stitching_reports_device_evictions_without_calling_them_lost(self):
        chunk = {"id": "kept", "beginId": "begin", "seq": 2, "part": 0,
                 "evictedOnDevice": [{"id": "old", "gameIndex": 6}], "lines": []}
        stitched = grp.stitch_log_chunks([chunk])
        self.assertEqual(stitched["evictedOnDevice"], [{"id": "old", "gameIndex": 6}])
        coverage = gr.full_log_coverage(
            {"accounts": [{"account": A}]},
            {A: {"log": {"stage": "chunk", "full": False, "chunks": 1, "evictedOnDevice": stitched["evictedOnDevice"]}}},
        )
        self.assertEqual(coverage["missingReasons"], [{
            "account": A,
            "reason": "evicted on device: game 6 chunk old",
        }])

    def test_journey_sequences_outcomes_and_keeps_the_last_numbers(self):
        roots = [{"span.op": "journey.join", "journey.outcome": "full", "span.duration": 10000, "timestamp": "t1"},
                 {"span.op": "journey.join", "journey.outcome": "isolated", "span.duration": 300, "timestamp": "t2"}, {"span.op": "pageload"}]
        j = gr.journey(roots, "journey.join")
        self.assertEqual((j["outcome"], j["ms"], j["at"]), ("full, then isolated", 300, "t2"))
        self.assertIsNone(gr.journey(roots, "journey.game"))

    def test_a_late_join_reads_as_joined_late_with_its_time_to_video(self):
        roots = [{"span.op": "journey.join", "journey.outcome": "late", "span.duration": 700, "timestamp": "t1", "join.first_link_ms": 4200}]
        j = gr.journey(roots, "journey.join")
        self.assertEqual(j["outcome"], "joined late")
        self.assertEqual(j["note"], "video after 4.2 s")
        self.assertIsNone(j["ms"])
        none = gr.journey([{"span.op": "journey.join", "journey.outcome": "late", "span.duration": 700, "timestamp": "t1"}], "journey.join")
        self.assertEqual(none["outcome"], "joined late")
        self.assertEqual(none["note"], "arrived after play began; time to first video is unavailable")
        self.assertNotIn("no video link", none["note"])
        # a late outcome on another journey kind is left alone
        self.assertEqual(gr.journey([{"span.op": "journey.game", "journey.outcome": "late"}], "journey.game")["outcome"], "late")

    def test_an_old_isolated_join_stays_readable(self):
        j = gr.journey([{"span.op": "journey.join", "journey.outcome": "isolated", "span.duration": 300, "timestamp": "t"}], "journey.join")
        self.assertEqual((j["outcome"], j["ms"]), ("isolated", 300))

    def test_the_chain_window_starts_when_registration_opened_and_ends_10_min_after_settlement(self):
        w0, w1 = gr.chain_window({"kickoff": "2026-10-02T13:06:00.000Z", "registrationOpens": "2026-10-02T12:20:00.000Z", "settlement": {"time": "2026-10-02T13:09:00.000Z"}})
        self.assertEqual((w0.isoformat(), w1.isoformat()), ("2026-10-02T12:20:00+00:00", "2026-10-02T13:19:00+00:00"))

    def test_pad_before_overrides_and_a_missing_registration_time_falls_back_to_20_min(self):
        ch = {"kickoff": "2026-10-02T13:06:00.000Z", "registrationOpens": "2026-10-02T12:20:00.000Z", "settlement": None}
        self.assertEqual(gr.chain_window(ch, pad_before=60)[0].isoformat(), "2026-10-02T12:06:00+00:00")
        self.assertEqual(gr.chain_window({**ch, "registrationOpens": None})[0].isoformat(), "2026-10-02T12:46:00+00:00")

    def test_untagged_rows_before_registration_opened_are_the_game_before(self):
        self.assertTrue(gr.puller.other_game({"timestamp": "2026-10-02T12:04:43+00:00"}, 166, "2026-10-02T12:20:00"))
        self.assertFalse(gr.puller.other_game({"timestamp": "2026-10-02T12:30:00+00:00"}, 166, "2026-10-02T12:20:00"))
        self.assertFalse(gr.puller.other_game({"timestamp": "2026-10-02T12:04:43+00:00", "game.index": "166"}, 166, "2026-10-02T12:20:00"))

    def test_run_chain_raises_with_the_tail_of_the_output(self):
        import tempfile
        from unittest import mock
        fake = mock.Mock(returncode=1, stdout="", stderr="boom: no archive")
        with mock.patch.object(gr.subprocess, "run", return_value=fake), tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(RuntimeError, "boom: no archive"):
                gr.run_chain(7, os.path.join(d, "c.json"))

    def test_game_log_filename_as_in_the_folder(self):
        self.assertEqual(gr.puller.game_log_filename("theender.02", A, "35f74e66abcd"), "theender.02-35f74e66.json")
        self.assertEqual(gr.puller.game_log_filename(None, A, "a5096864ffff"), "5AAAAAAA-a5096864.json")

    def test_other_game_rows_are_dropped_but_untagged_ones_kept(self):
        self.assertTrue(gr.puller.other_game({"game.index": "165"}, 166))
        self.assertFalse(gr.puller.other_game({"game.index": "166"}, 166))
        self.assertFalse(gr.puller.other_game({"game.index": None}, 166))
        self.assertFalse(gr.puller.other_game({}, 166))

    def test_a_step_belongs_to_the_game_when_it_sits_inside_a_tagged_root_of_its_journey(self):
        roots = [{"span.op": "journey.join", "game.index": "166", "timestamp": "2026-10-02T13:05:40+00:00", "span.duration": 27000},
                 {"span.op": "journey.join", "game.index": "165", "timestamp": "2026-10-02T12:05:40+00:00", "span.duration": 27000}]
        inside = {"transaction": "journey.join", "timestamp": "2026-10-02T13:05:50+00:00"}
        other_game = {"transaction": "journey.join", "timestamp": "2026-10-02T12:05:50+00:00"}
        other_journey = {"transaction": "journey.game", "timestamp": "2026-10-02T13:05:50+00:00"}
        self.assertTrue(gr.puller.step_in_game(inside, roots, 166))
        self.assertFalse(gr.puller.step_in_game(other_game, roots, 166))
        self.assertFalse(gr.puller.step_in_game(other_journey, roots, 166))

    def test_fetch_logs_reuses_a_cached_file_and_downloads_the_rest(self):
        import tempfile
        from unittest import mock
        body = lambda acct: json.dumps({"meta": {"address": acct, "username": acct[:2]}, "entries": [{"ts": 1, "message": "x"}]}).encode()
        rows = [{"id": "aaaaaaaa11", "user.id": A, "timestamp": "t"}, {"id": "bbbbbbbb22", "user.id": B, "timestamp": "t"}]
        downloads = []

        def get(url, params=None, raw=False):
            if url.endswith("/attachments/"):
                return [{"id": "att", "name": "log.json", "size": 5}]
            downloads.append(url)
            return body(B)

        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "ann-aaaaaaaa.json"), "wb") as f:
                f.write(body(A))
            with mock.patch.object(gr.puller, "events_all", side_effect=log_queries(rows, [])), mock.patch.object(gr.puller, "get", side_effect=get):
                logs, meta = gr.puller.fetch_logs(7, "s", "e", d)
            self.assertEqual(sorted(logs), sorted([A, B]))
            self.assertEqual(len(downloads), 1)
            self.assertIn("bbbbbbbb22", downloads[0])
            self.assertTrue(os.path.exists(os.path.join(d, f"{B[:2]}-bbbbbbbb.json")))
            self.assertEqual(meta[A]["file"], "ann-aaaaaaaa.json")

    def test_fetch_logs_keeps_the_fullest_of_a_players_two_logs(self):
        entries = lambda n: [{"ts": i, "message": "x"} for i in range(n)]
        bodies = {"aaaaaaaa11": {"meta": {"address": A, "username": "ann"}, "entries": entries(9)},
                  "bbbbbbbb22": {"meta": {"address": A, "username": "ann"}, "entries": entries(3)}}
        rows = [{"id": "aaaaaaaa11", "user.id": A, "timestamp": "t2", "game_log.stage": "payoff"},
                {"id": "bbbbbbbb22", "user.id": A, "timestamp": "t1", "game_log.stage": "payoff"}]

        def get(url, params=None, raw=False):
            if url.endswith("/attachments/"):
                return [{"id": "att", "name": "log.json", "size": 5}]
            return json.dumps(bodies["aaaaaaaa11" if "aaaaaaaa11" in url else "bbbbbbbb22"]).encode()

        for order in (rows, rows[::-1]):
            with mock.patch.object(gr.puller, "events_all", side_effect=log_queries(order, [])), mock.patch.object(gr.puller, "get", side_effect=get):
                logs, meta = gr.puller.fetch_logs(7, "s", "e")
            self.assertEqual(len(logs[A]["entries"]), 9)
            self.assertEqual((meta[A]["entries"], meta[A]["event"]), (9, "aaaaaaaa11"))

    def test_fetch_logs_merges_distinct_lines_from_every_full_document(self):
        bodies = {"aaaaaaaa11": {"meta": {"address": A}, "entries": [{"ts": 1, "sessionId": "s", "tag": "rtc", "message": "first"}]},
                  "bbbbbbbb22": {"meta": {"address": A}, "entries": [{"ts": 2, "sessionId": "s", "tag": "rtc", "message": "second"}]}}
        rows = [{"id": key, "user.id": A, "timestamp": key, "game_log.stage": "payoff"} for key in bodies]
        def get(url, params=None, raw=False):
            if url.endswith("/attachments/"):
                return [{"id": "att", "name": "log.json", "size": 5}]
            return json.dumps(bodies["aaaaaaaa11" if "aaaaaaaa11" in url else "bbbbbbbb22"]).encode()
        with mock.patch.object(gr.puller, "events_all", side_effect=log_queries(rows, [])), mock.patch.object(gr.puller, "get", side_effect=get):
            logs, meta = gr.puller.fetch_logs(7, "s", "e")
        self.assertEqual([line["message"] for line in logs[A]["entries"]], ["first", "second"])
        self.assertEqual(meta[A]["documents"], 2)

    def test_fetch_logs_prefers_a_full_copy_over_a_report_copy_with_more_entries(self):
        entries = lambda n: [{"ts": i, "message": "x"} for i in range(n)]
        bodies = {"aaaaaaaa11": {"meta": {"address": A, "username": "ann"}, "entries": entries(9)},
                  "bbbbbbbb22": {"meta": {"address": A, "username": "ann"}, "entries": entries(3)}}
        rows = [{"id": "aaaaaaaa11", "user.id": A, "timestamp": "t2", "game_log.stage": "report"},
                {"id": "bbbbbbbb22", "user.id": A, "timestamp": "t1", "game_log.stage": "payoff"}]

        def get(url, params=None, raw=False):
            if url.endswith("/attachments/"):
                return [{"id": "att", "name": "log.json", "size": 5}]
            return json.dumps(bodies["aaaaaaaa11" if "aaaaaaaa11" in url else "bbbbbbbb22"]).encode()

        for order in (rows, rows[::-1]):
            with mock.patch.object(gr.puller, "events_all", side_effect=log_queries(order, [])), mock.patch.object(gr.puller, "get", side_effect=get):
                logs, meta = gr.puller.fetch_logs(7, "s", "e")
            self.assertEqual((meta[A]["entries"], meta[A]["event"]), (3, "bbbbbbbb22"))
            self.assertEqual((meta[A]["stage"], meta[A]["full"]), ("payoff", True))

    def test_a_report_stage_copy_is_not_counted_as_a_full_log(self):
        body = {"meta": {"address": A, "username": "ann"}, "entries": [{"ts": 1, "message": "x"}]}
        rows = [{"id": "aaaaaaaa11", "user.id": A, "timestamp": "t", "game_log.stage": "report"}]

        def get(url, params=None, raw=False):
            return [{"id": "att", "name": "log.json", "size": 5}] if url.endswith("/attachments/") else json.dumps(body).encode()

        with mock.patch.object(gr.puller, "events_all", side_effect=log_queries(rows, [])), mock.patch.object(gr.puller, "get", side_effect=get):
            _, meta = gr.puller.fetch_logs(7, "s", "e")
        self.assertEqual((meta[A]["stage"], meta[A]["full"]), ("report", False))

    def test_fetch_logs_attributes_userless_chunks_and_merges_missing_sessions_into_full_log(self):
        full = {"meta": {"address": A, "username": "ann"},
                "entries": [{"ts": 2, "sessionId": "s2", "tag": "rtc", "message": "new"}],
                "gameLogManifest": {"chunks": [{"id": "old", "seq": 1, "part": 0, "status": "pending"}]}}
        chunk = {"id": "old", "gameIndex": 7, "sessionId": "s1", "account": A, "deviceId": "device-x",
                 "seq": 1, "part": 0, "checkpoint": "round-1", "capturedAt": 1,
                 "lines": [{"ts": 1, "sessionId": "s1", "tag": "rtc", "message": "old"}]}
        full_rows = [{"id": "full000011", "user.id": A, "timestamp": "t", "game_log.stage": "payoff"}]
        chunk_rows = [{"id": "chunk00011", "user.id": None, "timestamp": "client-time", "received": "server-time", "game_log.stage": "chunk"}]

        def get(url, params=None, raw=False):
            if url.endswith("/attachments/"):
                return [{"id": "att", "name": "log.json", "size": 5}]
            return json.dumps(chunk if "chunk00011" in url else full).encode()

        with mock.patch.object(gr.puller, "events_all", side_effect=log_queries(full_rows, chunk_rows)), mock.patch.object(gr.puller, "get", side_effect=get):
            logs, meta = gr.puller.fetch_logs(7, "s", "e")
        self.assertEqual([entry["message"] for entry in logs[A]["entries"]], ["old", "new"])
        self.assertEqual(logs[A]["meta"]["source"], "full+chunks")
        self.assertEqual(meta[A]["missingSeqs"], [])
        self.assertEqual(meta[A]["chunkAcceptances"][0]["receivedAt"], "server-time")
        self.assertEqual(meta[A]["chunkAcceptances"][0]["capturedAt"], 1)
        self.assertNotIn("truthCutoffAt", meta[A])

    def test_fetch_logs_requests_sentry_received_and_never_falls_back_to_client_timestamp(self):
        seen_fields = []
        def events_all(_dataset, _query, fields, **_kwargs):
            seen_fields.extend(fields)
            return []
        with mock.patch.object(gr.puller, "_events", return_value=[]), mock.patch.object(gr.puller, "events_all", side_effect=events_all):
            gr.puller.fetch_logs(7, "s", "e")
        self.assertIn("received", seen_fields)
        self.assertNotIn("dateReceived", seen_fields)

    def test_fetch_logs_treats_expected_full_chunk_overlap_as_one_occurrence(self):
        line = {"ts": 1, "sessionId": "s", "tag": "rtc", "message": "same"}
        full = {"meta": {"address": A, "exportedAt": "1970-01-01T00:00:02Z"}, "entries": [line]}
        chunk = {"id": "c", "account": A, "sessionId": "s", "seq": 1, "part": 0, "capturedAt": 1, "lines": [line]}
        full_rows = [{"id": "full", "user.id": A, "timestamp": "t", "received": "1970-01-01T00:00:03Z", "game_log.stage": "payoff"}]
        chunk_rows = [{"id": "chunk", "user.id": A, "received": "r", "game_log.stage": "chunk"}]
        def get(url, params=None, raw=False):
            if url.endswith("/attachments/"):
                return [{"id": "att", "name": "log.json", "size": 5}]
            return json.dumps(chunk if "chunk" in url else full).encode()
        with mock.patch.object(gr.puller, "events_all", side_effect=log_queries(full_rows, chunk_rows)), mock.patch.object(gr.puller, "get", side_effect=get):
            logs, meta = gr.puller.fetch_logs(7, "s", "e")
        self.assertEqual(logs[A]["entries"], [line])
        self.assertNotIn("crossSourceDuplicates", meta[A])
        self.assertEqual(meta[A]["fullAcceptances"][0]["receivedAt"], "1970-01-01T00:00:03Z")
        self.assertNotIn("truthCutoffAt", meta[A])

    def test_chunk_data_is_normalised_before_merge_and_chunk_only_analysis(self):
        chunk = {"id": "c1", "sessionId": "s1", "seq": 1, "part": 0, "capturedAt": 1,
                 "lines": [{"ts": 1, "sessionId": "s1", "tag": "vote", "message": "report built",
                            "data": '{"filedBy":"player","players":{}}'}]}
        stitched = gr.puller.stitch_log_chunks([chunk])
        self.assertEqual(stitched["entries"][0]["data"]["filedBy"], "player")
        self.assertEqual(gr.vote_trail({"entries": stitched["entries"]})["filedBy"], "player")

    def test_video_block_takes_worst_values_and_medians(self):
        pp = {A: {"metrics": [
            {"metric.name": "rtc.rtt_ms", "stat": "p50", "p50(value)": 80, "max(value)": 80, "rtc.path": "stun"},
            {"metric.name": "rtc.rtt_ms", "stat": "p50", "p50(value)": 100, "max(value)": 100, "rtc.path": "direct"},
            {"metric.name": "rtc.rtt_ms", "stat": "p95", "p50(value)": 300, "max(value)": 300, "round": "1", "rtc.peer": B},
            {"metric.name": "rtc.freeze_ms", "stat": "total", "sum(value)": 400, "max(value)": 400, "p50(value)": 400, "round": "2", "rtc.peer": B}]},
            B: {"metrics": [
                {"metric.name": "rtc.rtt_ms", "stat": "p95", "p50(value)": 900, "max(value)": 900, "round": "3", "rtc.peer": A},
                {"metric.name": "rtc.in_fps", "stat": "p50", "p50(value)": 4, "max(value)": 4},
                {"metric.name": "rtc.in_fps", "stat": "p50", "p50(value)": 1, "max(value)": 1},
                {"metric.name": "rtc.freeze_ms", "stat": "total", "sum(value)": 100, "max(value)": 100, "p50(value)": 100},
                {"metric.name": "rtc.freeze_ms", "stat": "total", "sum(value)": 50, "max(value)": 50, "p50(value)": 50}]}}
        v = gr.video_block(pp, {})
        self.assertEqual((v["rttP50"], v["rttP95"], v["freezeMs"], v["inFps"]), (90, 900, 400, 1.0))
        self.assertIn("stun 1", v["path"])
        self.assertEqual(v["worstRtt"]["round"], 3)
        self.assertEqual(v["worstFreeze"]["round"], 2)
        self.assertIn("receiving", v["worstFreeze"]["label"])

    def test_video_block_resolves_a_short_peer_id_from_the_full_pair(self):
        pair = f"g264:r2:{A}~{B}"
        pp = {A: {"metrics": [
            {"metric.name": "rtc.rtt_ms", "stat": "p50", "p50(value)": 80, "max(value)": 80},
            {"metric.name": "rtc.rtt_ms", "stat": "p95", "p50(value)": 300, "max(value)": 300,
             "round": "2", "rtc.peer": "4"},
        ], "linkPairs": [{"metric.name": "rtc.in_fps", "round": "2", "rtc.peer": "4", "rtc.pair": pair}]}}
        video = gr.video_block(pp, {A: "alice.01", B: "bob.01"})
        self.assertEqual(video["worstRtt"]["peer"], B)
        self.assertEqual(video["worstRtt"]["label"], "alice.01 ↔ bob.01, round 2")

    def test_video_summary_with_unnamed_pair_accounts_is_lint_clean(self):
        pair = f"g264:r2:{A}~{B}"
        pp = {A: {"metrics": [
            {"metric.name": "rtc.rtt_ms", "stat": "p50", "p50(value)": 80, "max(value)": 80},
            {"metric.name": "rtc.rtt_ms", "stat": "p95", "p50(value)": 300, "max(value)": 300,
             "round": "2", "rtc.peer": "4"},
        ], "linkPairs": [{"metric.name": "rtc.in_fps", "round": "2", "rtc.peer": "4", "rtc.pair": pair}]}}
        video = gr.video_block(pp, {})
        summary = "\n".join(gr._link_lines(video))
        errors = gr.report_lint.lint_report({"summary": summary})
        self.assertFalse(any("looks truncated" in error for error in errors), errors)


    def test_video_block_puts_the_typical_loss_beside_the_worst_moments(self):
        # game 216: the worst pair lost 99 % in its worst moments, 0 to 2.4 % while its link was up
        loss = lambda stat, v, rnd, peer: {"metric.name": "rtc.loss_pct", "stat": stat, "p50(value)": v, "max(value)": v, "round": rnd, "rtc.peer": peer}
        pp = {A: {"metrics": [loss("p95", 99.0, "2", "3"), loss("p50", 2.4, "2", "3"),
                              loss("p95", 3.0, "1", "2"), loss("p50", 0.5, "1", "2")]},
              B: {"metrics": [loss("p95", 1.0, "1", "1"), loss("p50", 0.2, "1", "1")]}}
        v = gr.video_block(pp, {})
        self.assertEqual((v["lossP95"], v["lossWorstPairP50"], v["lossP50"]), (99.0, 2.4, 0.5))
        self.assertEqual(v["worstLoss"]["round"], 2)

    def test_video_block_loss_rows_that_differ_by_path_stay_apart(self):
        loss = lambda stat, v, path: {"metric.name": "rtc.loss_pct", "stat": stat, "p50(value)": v, "max(value)": v, "round": "1", "rtc.peer": "2", "rtc.path": path}
        pp = {A: {"metrics": [loss("p95", 40.0, "relay"), loss("p50", 8.0, "relay"), loss("p95", 5.0, "stun"), loss("p50", 1.0, "stun")]}}
        v = gr.video_block(pp, {})
        self.assertEqual((v["lossP95"], v["lossWorstPairP50"], v["lossP50"]), (40.0, 8.0, 4.5))


class ClockAgreementTest(unittest.TestCase):
    def signal(self, logs, sender, receiver, sent, received, lane=False, correlation=None):
        prefix = "lane " if lane else ""
        data = {"sid": correlation} if correlation else None
        logs[sender]["entries"].append({"ts": sent, "tag": "rtc", "message": f"[jollity-rtc] → {prefix}answer to {receiver}", "data": data})
        received_message = (f"[jollity-rtc] lane answer from {sender}" if lane else
                            f"[jollity-rtc] ← signal from {sender} answer")
        logs[receiver]["entries"].append({"ts": received, "tag": "rtc", "message": received_message, "data": data})

    def pair(self, logs, a, b, offset_b_minus_a, start, count=5):
        # Symmetric 100 ms path: receive-send = remote clock offset + path.
        for i in range(count):
            at = start + i * 1_000
            self.signal(logs, a, b, at, at + 100 + offset_b_minus_a)
            self.signal(logs, b, a, at + 10_000, at + 10_100 - offset_b_minus_a, lane=True)

    def test_bidirectional_samples_solve_group_offsets(self):
        logs = {A: {"entries": []}, B: {"entries": []}, C: {"entries": []}}
        # B clock is +20 ms vs A; C is -10 ms vs A, symmetric network latency 100 ms.
        self.pair(logs, A, B, 20, 100_000)
        self.pair(logs, A, C, -10, 130_000)
        self.pair(logs, B, C, -30, 160_000)
        groups = [{"round": 1, "group": 0, "members": [{"account": a} for a in (A, B, C)]}]
        result = gr.clock_agreement(groups, logs, {A: "alice", B: "bob", C: "cara"}, [(90_000, 200_000)])
        row = result["groups"][0]
        self.assertEqual(row["qualifiedPairs"], 3)
        self.assertEqual(row["offsetsMs"], {A: 0.0, B: 20.0, C: -10.0})
        self.assertEqual((row["sigmaMs"], row["spreadMs"]), (12.5, 30.0))

    def test_saved_g263_round_one_group_three_solves_without_its_no_show(self):
        george = "5G1c9k2VrqSUhXkFYEBbbviH5PodGT6k5gPY8Ha1jJ6eAFLt"
        spender = "5GnTeUr54J47DVvpB1nUQ1uLfm8zj3ttZhWrZoq526oNSUNf"
        no_show = "5GVijdkmrMAvdHmaLPKdjvaCvbHrzoXr68f6XjQYXs2KDzxv"
        deedee = "5HpUeKD6Xw4CmwCeS79oQT3MZgphWhnkRYg3AoeTLmqVXty5"
        franzi = "5HZ1aFoazeDHBWS5mrrNvXP4iJ78EXsGtan2pKVVDNXqt1x8"
        connected = (george, spender, deedee, franzi)
        offsets = {george: 0, spender: 2, deedee: -71, franzi: 4}
        logs = {account: {"entries": []} for account in (*connected, no_show)}
        start = 100_000
        for i, a in enumerate(connected):
            for b in connected[i + 1:]:
                self.pair(logs, a, b, offsets[b] - offsets[a], start, count=4)
                start += 20_000
        members = (george, spender, no_show, deedee, franzi)
        names = {george: "thegeorge.06", spender: "bigspender.01", no_show: "shawnphone.01",
                 deedee: "deedee.09", franzi: "franzi.01"}
        result = gr.clock_agreement(
            [{"round": 1, "group": 3, "members": [{"account": account} for account in members]}],
            logs, names, [(90_000, 240_000)])
        row = result["groups"][0]
        self.assertEqual((row["phonesUsed"], row["members"], row["qualifiedPairs"], row["totalPairs"]), (4, 5, 6, 10))
        self.assertIsNotNone(row["sigmaMs"])
        self.assertTrue(row["lowConfidence"])

    def test_clock_component_reports_three_of_four_phones(self):
        logs = {account: {"entries": []} for account in (A, B, C, D)}
        self.pair(logs, A, B, 20, 100_000)
        self.pair(logs, A, C, -10, 130_000)
        self.pair(logs, B, C, -30, 160_000)
        result = gr.clock_agreement(
            [{"round": 1, "group": 0, "members": [{"account": account} for account in (A, B, C, D)]}],
            logs, {A: "alice", B: "bob", C: "cara", D: "dora"}, [(90_000, 200_000)])
        row = result["groups"][0]
        self.assertEqual((row["phonesUsed"], row["members"]), (3, 4))

    def test_fewer_than_four_legacy_messages_in_either_direction_is_na(self):
        logs = {A: {"entries": []}, B: {"entries": []}}
        for i in range(5):
            self.signal(logs, A, B, 100_000 + i * 1_000, 100_110 + i * 1_000)
        for i in range(3):
            self.signal(logs, B, A, 120_000 + i * 1_000, 120_090 + i * 1_000)
        result = gr.clock_agreement([{"round": 1, "group": 0, "members": [{"account": A}, {"account": B}]}], logs, {}, [(90_000, 140_000)])
        self.assertIsNone(result["groups"][0]["sigmaMs"])

    def test_unbalanced_unlabelled_rtc_lines_are_not_guessed(self):
        logs = {A: {"entries": []}, B: {"entries": []}}
        for i in range(5):
            self.signal(logs, A, B, 100_000 + i * 1_000, 100_110 + i * 1_000)
        # One receipt is missing from the saved receiver log: ordinal pairing is ambiguous.
        logs[B]["entries"].pop()
        samples = gr._rtc_log_signal_samples(logs, [(90_000, 140_000)])
        self.assertEqual(samples[(1, A, B)], [])

    def test_sid_matching_keeps_exact_pair_when_unrelated_receipt_is_missing(self):
        sent = [{"at": 100, "correlation": ("kept", "4")},
                {"at": 200, "correlation": ("missing", "4")}]
        received = [{"at": 130, "correlation": ("kept", "4")}]
        pairs = gr._pair_saved_events(sent, received)
        self.assertEqual([(left["at"], right["at"]) for left, right in pairs], [(100, 130)])

    def test_rtcp_views_are_preferred_over_signalling(self):
        logs = {A: {"entries": []}, B: {"entries": []}}
        self.pair(logs, A, B, 20, 100_000)
        for owner, peer, offset in ((A, B, -41), (B, A, 39)):
            logs[owner]["entries"].append({"ts": 130_000, "tag": "replay", "message": "rtcp-clock-offset", "data": {"observation": {
                "peerId": peer, "round": 0, "link": 1, "meshGeneration": 1, "sampleCount": 6,
                "medianOffsetMs": offset, "status": "ok", "source": "remote-outbound-rtp",
                "browserBuild": "webkit/620", "hostBuild": "58",
            }}})
        result = gr.clock_agreement([{"round": 1, "group": 0, "members": [{"account": A}, {"account": B}]}], logs, {}, [(90_000, 150_000)])
        row = result["groups"][0]
        self.assertEqual(row["pairs"][0]["source"], "rtcp")
        self.assertEqual((row["pairs"][0]["offsetMs"], row["pairs"][0]["uncertaintyMs"]), (40.0, 2.0))
        self.assertEqual([(row["status"], row["records"], row["sampleCount"]) for row in result["rtcpAvailability"]],
                         [("ok", 1, 6), ("ok", 1, 6)])

    def test_rtcp_unavailable_records_are_counted_but_never_used_as_offsets(self):
        logs = {A: {"entries": [{"ts": 130_000, "tag": "replay", "message": "rtcp-clock-offset", "data": {"observation": {
            "peerId": B, "round": 0, "link": 2, "meshGeneration": 1, "sampleCount": 2,
            "status": "unavailable", "reason": "not-enough-samples", "source": "remote-outbound-rtp",
            "browserBuild": "chromium/155", "hostBuild": "unknown",
        }}}]}, B: {"entries": []}}
        result = gr.clock_agreement([{"round": 1, "group": 0, "members": [{"account": A}, {"account": B}]}], logs, {A: "alice"})
        self.assertIsNone(result["groups"][0]["pairs"][0]["offsetMs"])
        self.assertEqual(result["rtcpAvailability"], [{"account": A, "name": "alice", "browserBuild": "chromium/155",
            "hostBuild": "unknown", "status": "unavailable", "reason": "not-enough-samples", "records": 1, "sampleCount": 2}])

    def test_rtcp_needs_five_samples_in_each_phone_view_before_it_replaces_signalling(self):
        logs = {A: {"entries": []}, B: {"entries": []}}
        self.pair(logs, A, B, 20, 100_000)
        for owner, peer, offset in ((A, B, -41), (B, A, 39)):
            logs[owner]["entries"].append({"ts": 130_000, "tag": "replay", "message": "rtcp-clock-offset", "data": {"observation": {
                "peerId": peer, "round": 0, "link": 1, "meshGeneration": 1, "sampleCount": 4,
                "medianOffsetMs": offset, "status": "ok", "source": "remote-outbound-rtp",
            }}})
        pair = gr.clock_agreement([{"round": 1, "group": 0, "members": [{"account": A}, {"account": B}]}],
                                  logs, {}, [(90_000, 150_000)])["groups"][0]["pairs"][0]
        self.assertEqual((pair["source"], pair["offsetMs"]), ("signalling", 20.0))

    def test_saved_g263_fixture_reproduces_known_offsets_as_low_confidence_report_pairs(self):
        path = os.path.join(os.path.dirname(__file__), "fixtures", "game-263-clock-lines.json")
        with open(path, encoding="utf-8") as fh:
            fixture = json.load(fh)
        samples = gr._rtc_log_signal_samples(fixture["logs"], fixture["windows"])
        for expected in fixture["expected"]["pairs"]:
            ab = samples[(1, expected["a"], expected["b"])]
            ba = samples[(1, expected["b"], expected["a"])]
            estimate = (gr.statistics.median(ab) - gr.statistics.median(ba)) / 2
            self.assertAlmostEqual(estimate, expected["offsetMs"], delta=expected["toleranceMs"])
        result = gr.clock_agreement(fixture["groups"], fixture["logs"], fixture["names"], fixture["windows"])
        reported = {(row["pairs"][0]["a"], row["pairs"][0]["b"]): row["pairs"][0] for row in result["groups"]}
        for expected in fixture["expected"]["pairs"]:
            pair = reported[(expected["a"], expected["b"])]
            self.assertAlmostEqual(pair["offsetMs"], expected["offsetMs"], delta=expected["toleranceMs"])
            self.assertEqual((pair["source"], pair["confidence"], pair["samplesAB"], pair["samplesBA"]),
                             ("signalling", "low", 4, 4))


class KnownPlatformErrorsTest(unittest.TestCase):
    def players(self):
        return [{"id": A, "username": "pgherveoua.01", "device": "iPhone 15", "host": "Nova 1.2", "hostBuild": "55", "release": "aaa"},
                {"id": B, "username": "devdevdev.01", "device": "Pixel 9", "host": "Polkadot 2.0", "hostBuild": "77", "release": "bbb"}]

    def test_g263_g264_expectations_and_warning_facts(self):
        g263 = gr.known_platform_errors({A: {"events": []}}, {A: {"entries": [{"ts": gr.parse_ts("2026-10-20T14:10:52Z").timestamp() * 1000,
            "tag": "chain", "message": "Block 0x1 is not pinned (stop-call)"}]}}, self.players())
        self.assertEqual([(row["number"], row["count"]) for row in g263["bugs"]], [(76, 0), (77, 0), (78, 1)])
        self.assertEqual(g263["bugs"][2]["occurrences"][0]["at"], "16:10:52 CEST")
        self.assertEqual(g263["bugs"][2]["occurrences"][0]["detail"], "stop-call")
        g264 = gr.known_platform_errors({B: {"events": [{"title": "createTransaction failed: subscription dropped", "timestamp": "2026-10-20T15:20:40Z"}]}}, {}, self.players())
        self.assertEqual([(row["number"], row["count"]) for row in g264["bugs"]], [(76, 1), (77, 0), (78, 0)])
        self.assertEqual(g264["bugs"][0]["occurrences"][0]["at"], "17:20:40 CEST")
        self.assertIn("pb#77 0", "\n".join(gr._known_platform_error_lines(g264)))

    def test_timeout_is_split_by_wire_method_and_duplicate_sources_collapse(self):
        title = "TrUAPI request host:836 (wire 3, 5) timed out after 120000ms"
        at = gr.parse_ts("2026-10-20T15:00:00Z")
        result = gr.known_platform_errors({A: {"events": [{"title": title, "timestamp": at.isoformat()}]}},
            {A: {"entries": [{"ts": at.timestamp() * 1000 + 500, "tag": "error", "message": title}]}}, self.players())
        bug = result["bugs"][1]
        self.assertEqual(bug["count"], 1)
        self.assertEqual(bug["occurrences"][0]["detail"], "wire 3,5 (unpin_head)")

    def test_scope_excludes_non_players_and_events_outside_the_game_window(self):
        inside = gr.parse_ts("2026-10-18T14:30:00Z")
        title = "TrUAPI request host:836 (wire 3, 5) timed out after 120000ms"
        pull = {
            A: {"events": [
                {"title": title, "timestamp": "2026-10-17T14:30:00Z"},
                {"title": title, "timestamp": inside.isoformat()},
            ]},
            B: {"events": [{"title": title, "timestamp": inside.isoformat()}]},
        }
        window = (gr.parse_ts("2026-10-18T14:00:00Z"), gr.parse_ts("2026-10-18T16:00:00Z"))
        result = gr.known_platform_errors(pull, {}, self.players(), {A}, window)
        bug = result["bugs"][1]
        self.assertEqual((bug["count"], bug["occurrences"][0]["account"]), (1, A))
        rendered = "\n".join(gr._known_platform_error_lines(result))
        self.assertIn("16:00 to 18:00 CEST; registered or joined players only", rendered)

    def test_unnamed_player_uses_account_prefix_without_ellipsis(self):
        title = "createTransaction failed: subscription dropped"
        result = gr.known_platform_errors(
            {A: {"events": [{"title": title, "timestamp": "2026-10-18T14:30:00Z"}]}}, {},
            [{"id": A, "username": None}], {A},
            (gr.parse_ts("2026-10-18T14:00:00Z"), gr.parse_ts("2026-10-18T16:00:00Z")))
        rendered = "\n".join(gr._known_platform_error_lines(result))
        self.assertIn(A[:8], rendered)
        self.assertNotIn("…", rendered)

    def test_regular_game_counts_platform_errors_from_registration_opening(self):
        # A 3 h cadence: the pull runs from the previous settlement, over 3 h; nothing before registration is cut.
        chain = {"registrationOpens": "2026-10-23T13:03:00Z", "kickoff": "2026-10-23T16:00:00Z",
                 "settlement": {"time": "2026-10-23T16:02:00Z"}}
        pull = {"window": ["2026-10-23T13:03:00Z", "2026-10-23T16:12:00Z"]}
        start, end = gr.platform_error_window(chain, pull, gr.parse_ts(chain["kickoff"]))
        self.assertEqual((start.isoformat(), end.isoformat()),
                         ("2026-10-23T13:03:00+00:00", "2026-10-23T16:02:00+00:00"))

    def test_morning_game_after_the_overnight_gap_keeps_its_full_window(self):
        # Registration opens at the previous evening's settlement, ~18 h before a 12:00 CEST kickoff.
        chain = {"registrationOpens": "2026-10-22T16:03:00Z", "kickoff": "2026-10-23T10:00:00Z",
                 "settlement": {"time": "2026-10-23T10:02:00Z"}}
        start, _ = gr.platform_error_window(chain, {"window": ["2026-10-22T16:03:00Z", "2026-10-23T10:12:00Z"]},
                                            gr.parse_ts(chain["kickoff"]))
        self.assertEqual(start.isoformat(), "2026-10-22T16:03:00+00:00")

    def test_pb76_counts_the_unknown_follow_subscription_wording(self):
        pull = {A: {"events": [{"title": 'RpcError: HostFailure: remote_chain_head_call: unknown follow subscription id "c12:host:9"',
                                "timestamp": "2026-10-18T14:30:00Z"}]}}
        window = (gr.parse_ts("2026-10-18T14:00:00Z"), gr.parse_ts("2026-10-18T16:00:00Z"))
        bug = gr.known_platform_errors(pull, {}, self.players(), {A}, window)["bugs"][0]
        self.assertEqual((bug["number"], bug["count"]), (76, 1))

    def test_pb76_counts_a_chain_health_log_by_its_error_attribute(self):
        pull = {A: {"events": [{"title": "chain.health", "timestamp": "2026-10-18T14:30:00Z",
                                "chainHealthError": 'RpcError: HostFailure: remote_chain_head_call: unknown follow subscription id "c1:host:2"'}]}}
        window = (gr.parse_ts("2026-10-18T14:00:00Z"), gr.parse_ts("2026-10-18T16:00:00Z"))
        self.assertEqual(gr.known_platform_errors(pull, {}, self.players(), {A}, window)["bugs"][0]["count"], 1)

    def recovery(self, entries, events=()):
        base = gr.parse_ts("2026-10-18T14:30:00Z").timestamp() * 1000
        lines = [{"ts": base + at * 1000, "sessionId": sess, "tag": "chain", "message": msg, "_deliveryId": f"{sess}:{seq}"}
                 for at, sess, seq, msg in entries]
        window = (gr.parse_ts("2026-10-18T14:00:00Z"), gr.parse_ts("2026-10-18T16:00:00Z"))
        result = gr.known_platform_errors({A: {"events": list(events)}}, {A: {"entries": lines}}, self.players(), {A}, window)
        row = result["bugs"][0]["occurrences"][0]
        return row["recovery"], "\n".join(gr._known_platform_error_lines(result))

    FAIL = "health recheck: host-chain-lost (subscription dropped)"

    def test_pb76_recovery_same_session_is_self(self):
        recovery, text = self.recovery([(0, "s1", 1, self.FAIL), (28, "s1", 2, "health recheck: healthy")])
        self.assertEqual(recovery, {"kind": "self", "seconds": 28})
        self.assertIn("(chain read/createTransaction), recovered by itself after 28 s", text)

    def test_pb76_recovery_only_in_a_later_session_is_a_restart(self):
        recovery, text = self.recovery([(0, "s1", 1, self.FAIL), (90, "s2", 1, "health open: healthy")])
        self.assertEqual(recovery, {"kind": "restart", "seconds": 90})
        self.assertIn("recovered after an app restart (90 s)", text)

    def test_pb76_without_a_healthy_probe_is_not_seen_recovering(self):
        recovery, text = self.recovery([(0, "s1", 1, self.FAIL), (40, "s1", 2, "health recheck: host-chain-lost")])
        self.assertEqual(recovery, {"kind": "none"})
        self.assertIn("not seen recovering", text)

    def test_pb76_duplicated_devlog_copies_count_once_and_structured_event_wins(self):
        dup = [(0, "s1", 1, self.FAIL), (10, "s1", 2, "health recheck: healthy"), (10, "s1", 2, "health recheck: healthy")]
        recovery, _ = self.recovery(dup)
        self.assertEqual(recovery, {"kind": "self", "seconds": 10})
        probes = gr._healthy_probes({}, {"entries": [{"ts": 1, "sessionId": "s1", "tag": "chain", "message": "health recheck: healthy", "_deliveryId": "s1:2"}] * 2})
        self.assertEqual(len(probes), 1)
        recovered = {"title": "chain.health", "timestamp": "2026-10-18T14:30:07Z", "session.id": "s1", "chainHealthOutcome": "recovered"}
        failed = {"title": "chain.health", "timestamp": "2026-10-18T14:30:00Z", "session.id": "s1",
                  "chainHealthError": "RpcError: unknown follow subscription id x"}
        recovery, _ = self.recovery([(10, "s1", 2, "health recheck: healthy")], [failed, recovered])
        self.assertEqual(recovery, {"kind": "self", "seconds": 7})

    def test_pb77_is_the_unpin_head_timeout_only(self):
        inside = gr.parse_ts("2026-10-18T14:30:00Z")
        pull = {A: {"events": [
            {"title": "TrUAPI request host:836 (wire 7, 1) timed out after 120000ms", "timestamp": inside.isoformat()},
            {"title": "TrUAPI request host:837 (wire 3, 5) timed out after 120000ms", "timestamp": "2026-10-18T14:31:00Z"},
        ]}}
        window = (gr.parse_ts("2026-10-18T14:00:00Z"), gr.parse_ts("2026-10-18T16:00:00Z"))
        bug = gr.known_platform_errors(pull, {}, self.players(), {A}, window)["bugs"][1]
        self.assertEqual((bug["number"], bug["count"], bug["occurrences"][0]["detail"]), (77, 1, "wire 3,5 (unpin_head)"))

    def test_long_pull_caps_platform_error_start_at_two_hours_before_kickoff(self):
        chain = {"registrationOpens": "2026-10-16T14:08:00Z", "kickoff": "2026-10-19T14:00:00Z",
                 "settlement": {"time": "2026-10-19T14:18:00Z"}}
        pull = {"window": ["2026-10-16T14:08:00Z", "2026-10-19T14:28:00Z"]}
        start, end = gr.platform_error_window(chain, pull, gr.parse_ts(chain["kickoff"]))
        self.assertEqual((start.isoformat(), end.isoformat()),
                         ("2026-10-19T12:00:00+00:00", "2026-10-19T14:18:00+00:00"))

def frame_metrics(p50):
    return [{"metric.name": "ui.frame_ms", "scene": "game.round", "stat": "p50", "p50(value)": p50},
            {"metric.name": "ui.frame_ms", "scene": "game.round", "stat": "p95", "p50(value)": p50 * 2},
            {"metric.name": "rtc.freeze_ms", "stat": "total", "sum(value)": p50 * 100, "max(value)": p50 * 100, "p50(value)": p50 * 100}]


class UsernameMappingTest(unittest.TestCase):
    def test_local_preview_injects_both_documents_through_the_database_stub(self):
        html = preview.build_preview("<html><script>app()</script></html>", [{"game": 260}, {"kind": "game-links", "game": 260}])
        self.assertIn('window.claude = { use: async (name)', html)
        self.assertIn('"kind": "game-links"', html)
        self.assertLess(html.index("window.claude"), html.index("app()"))

    def test_chain_json_must_live_outside_the_report_output_directory(self):
        with tempfile.TemporaryDirectory() as root:
            outdir = os.path.join(root, "g260")
            os.makedirs(outdir)
            gr.validate_chain_input(os.path.join(root, "chain.json"), outdir)
            with self.assertRaisesRegex(ValueError, "outside the report output directory"):
                gr.validate_chain_input(os.path.join(outdir, "source-chain.json"), outdir)

    def test_publish_documents_move_links_to_a_companion(self):
        source = {
            "game": 260,
            "clockAgreement": {"medianSigmaMs": 4.2},
            "players": [
                {"id": "alice", "username": "Alice", "device": "phone", "telemetryHealth": {"private": "large"}},
                {"id": "chat", "username": "Chat only", "device": "phone"},
            ],
            "funnel": [{"key": "live", "accounts": ["alice"]}],
            "storyline": {"from": "2026-10-15T09:00:00+00:00", "to": "2026-10-15T12:00:00+00:00", "marks": [], "rounds": [], "phases": [],
                          "players": [{"id": "alice", "username": "Alice", "bot": False,
                                       "events": [{"key": "registered", "at": "2026-10-15T10:00:00+00:00"}]}]},
            "failures": [{"large": "private"}],
            "links": {
                "players": [
                    {"account": "aphex", "username": "aphextwin.05", "hasLog": True, "joined": True},
                    {"account": "daemia", "username": "daemia.03", "hasLog": True, "joined": True},
                    {"account": "dev", "username": "devdevdev.01", "hasLog": True, "joined": True},
                    {"account": "franzi", "username": "franzi.01", "hasLog": True, "joined": True},
                    {"account": "gavin", "username": "gavofyork.07", "hasLog": True, "joined": True},
                    {"account": "absent", "username": "absent.01", "hasLog": False, "joined": False},
                ],
                "matrix": [
                    {"round": 1, "a": "gavin", "b": "aphex", "coverage": 0.265, "state": "dead"},
                    {"round": 1, "a": "aphex", "b": "absent", "coverage": None, "state": "never-joined"},
                ],
                "timeline": [{"viewer": "alice", "peer": "bob", "segments": []}],
                "events": [{"account": "alice", "peer": "bob", "kind": "restart"}],
                "rounds": [{"round": 1, "room": ["alice", "bob"], "rooms": [["alice", "bob"]]}],
                "seatStates": [{"account": "alice"}],
            },
        }
        report, links = gr.publish_documents(source)
        self.assertIsNone(report["links"])
        self.assertEqual(report["linksDoc"], "g260-links")
        self.assertEqual(report["chatOnlyCount"], 1)
        self.assertEqual([player["id"] for player in report["players"]], ["alice"])
        self.assertNotIn("telemetryHealth", report["players"][0])
        self.assertNotIn("failures", report)
        self.assertNotIn("clockAgreement", report)
        self.assertEqual(report["storyline"], source["storyline"])
        self.assertNotIn("storyline", links)
        self.assertEqual(links["links"]["accounts"][:5], ["aphex", "daemia", "dev", "franzi", "gavin"])
        self.assertEqual(links["links"]["matrix"][0], {"round": 1, "a": 4, "b": 0, "coverage": 0.265, "state": "dead"})
        self.assertEqual(links["links"]["matrix"][1]["state"], "never-joined")
        self.assertEqual(links["links"]["players"][0]["joined"], True)
        self.assertEqual(links["links"]["players"][5]["joined"], False)
        self.assertNotIn("seatStates", links["links"])
        self.assertIn("telemetryHealth", source["players"][0])
        self.assertIn("seatStates", source["links"])

    def test_publish_contract_covers_every_page_field(self):
        self.assertEqual(gr.publish_contract_errors(), [])

    def test_main_passes_flags_through(self):
        import tempfile
        chain = {"accounts": [], "record": {"rounds": 0},
                 "kickoff": "2026-10-02T13:00:00Z"}
        doc = {
            "game": 7, "env": "production", "kickoff": "2026-10-02 15:00 CEST", "facts": [], "links": None,
            "players": [{"id": B, "username": "learned.01", "usernameSource": "log"}],
            "funnel": [
                {"key": "registered", "stage": "registered", "accounts": [], "count": 0},
                {"key": "joined", "stage": "joined", "accounts": [], "count": 0},
            ],
            "storyline": {"from": "2026-10-02T12:00:00+00:00", "to": "2026-10-02T14:00:00+00:00", "marks": [], "rounds": [], "phases": [],
                          "players": [{"id": B, "username": "learned.01", "bot": False, "events": []}]},
        }
        w0 = datetime.datetime(2026, 10, 2, 12, tzinfo=datetime.timezone.utc)
        w1 = datetime.datetime(2026, 10, 2, 14, tzinfo=datetime.timezone.utc)
        fired = datetime.datetime(2026, 10, 2, 12, 55, tzinfo=datetime.timezone.utc)
        with tempfile.TemporaryDirectory() as root:
            out = os.path.join(root, "out", "report.json")
            logs_dir = os.path.join(root, "logs")
            usernames = os.path.join(root, "usernames.json")
            sibling = os.path.join(root, "sibling.json")
            chain_json = os.path.join(root, "given-chain.json")
            with open(sibling, "w", encoding="utf-8") as fh:
                json.dump({A: "sibling.01"}, fh)
            with open(chain_json, "w", encoding="utf-8") as fh:
                json.dump(chain, fh)
            argv = ["game-report.py", "7", "--out", out, "--logs-dir", logs_dir,
                    "--usernames", usernames, "--sibling-usernames", sibling,
                    "--chain-json", chain_json, "--no-log-cache"]
            with mock.patch.object(gr.sys, "argv", argv), \
                 mock.patch.object(gr, "run_chain") as run_chain, \
                 mock.patch.object(gr, "chain_window", return_value=(w0, w1)), \
                 mock.patch.object(gr.puller, "fetch_logs", return_value=({A: {"meta": {}, "entries": []}}, {})) as fetch_logs, \
                 mock.patch.object(gr.puller, "pull", return_value={}), \
                 mock.patch.object(gr, "play_windows", return_value=[]), \
                 mock.patch.object(gr, "clock_lag", return_value=0), \
                 mock.patch.object(gr.gl, "analyse", return_value=None) as analyse, \
                 mock.patch.object(gr, "load_usernames", return_value={}) as load_usernames, \
                 mock.patch.object(gr, "history_usernames", return_value={A: "history.01"}), \
                 mock.patch.object(gr, "save_usernames") as save_usernames, \
                 mock.patch.object(gr, "assemble", return_value=doc), \
                 mock.patch.object(gr, "notification_rows", return_value={}), \
                 mock.patch.object(gr, "notification_funnel", return_value={}), \
                 mock.patch.object(gr.sentry, "host_reminder_events", return_value=[]), \
                 mock.patch.object(gr, "host_reminder_counts", return_value={"firedAt": fired}), \
                 mock.patch.object(gr, "draft_report_text"), \
                 mock.patch.object(gr.report_lint, "require_valid"):
                gr.main()

            run_chain.assert_not_called()
            fetch_logs.assert_called_once_with(7, w0.strftime("%Y-%m-%dT%H:%M:%S"),
                                               w1.strftime("%Y-%m-%dT%H:%M:%S"), logs_dir,
                                               use_cache=False)
            self.assertEqual(analyse.call_args.kwargs["names"], {A: "sibling.01"})
            load_usernames.assert_called_once_with(usernames)
            self.assertTrue(save_usernames.call_args_list)
            self.assertTrue(all(call.args[0] == usernames
                                for call in save_usernames.call_args_list))
            with open(os.path.join(root, "out", "chain.json"), encoding="utf-8") as fh:
                self.assertEqual(json.load(fh), chain)
            self.assertEqual(doc["storyline"]["marks"], [{"key": "remindersFired", "at": fired.isoformat()}])
            with open(os.path.join(root, "out", "report-publish.json"), encoding="utf-8") as fh:
                self.assertEqual(json.load(fh)["storyline"], doc["storyline"])

    """Our own account -> username mapping (data/usernames.json): fills what Sentry and the logs lack."""

    def pull(self, name=None):
        root = {"span.op": "journey.game", "timestamp": "2026-10-02T13:00:00+00:00", "environment": "production", "game.index": "7", "span.duration": 10}
        if name:
            root["user.username"] = name
        return {"game": 7, "tagged_accounts": [A], "players": {A: {"roots": [root]}}}

    def row(self, pull, logs=None, mapping=None):
        return gr.assemble(7, pull, None, None, logs or {}, {}, mapping=mapping)["players"][0]

    def test_mapping_fills_a_player_nobody_else_named(self):
        r = self.row(self.pull(), mapping={A: "gabcrispino.01"})
        self.assertEqual((r["username"], r["usernameSource"]), ("gabcrispino.01", "mapping"))

    def test_sentry_name_wins_over_the_mapping(self):
        r = self.row(self.pull("sentry.01"), mapping={A: "old.01"})
        self.assertEqual((r["username"], r["usernameSource"]), ("sentry.01", "sentry"))

    def test_log_name_wins_over_the_mapping(self):
        r = self.row(self.pull(), logs={A: {"meta": {"username": "log.01"}, "entries": []}}, mapping={A: "old.01"})
        self.assertEqual((r["username"], r["usernameSource"]), ("log.01", "log"))

    def test_no_name_anywhere_stays_null(self):
        r = self.row(self.pull(), mapping={B: "other.01"})
        self.assertEqual((r["username"], r["usernameSource"]), (None, None))

    def test_a_registered_player_with_no_game_log_gets_a_username_in_links(self):
        links = {"players": [{"account": A, "username": None, "hasLog": False}, {"account": B, "username": "logged.01", "hasLog": True}, {"account": C, "username": None, "hasLog": False}]}
        d = gr.assemble(7, self.pull(), None, links, {}, {}, mapping={A: "gabcrispino.01"})
        self.assertEqual([p["username"] for p in d["links"]["players"]], ["gabcrispino.01", "logged.01", None])
        self.assertIsNone(links["players"][0]["username"])  # the input is left alone

    def test_file_round_trip_and_missing_file(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "data", "usernames.json")
            self.assertEqual(gr.load_usernames(path), {})
            gr.save_usernames(path, {B: "b.01", A: "a.01"})
            self.assertEqual(gr.load_usernames(path), {A: "a.01", B: "b.01"})
            self.assertEqual(list(json.load(open(path))), [A, B])  # sorted, so a diff only shows what changed
            open(path, "w").write("not json")
            self.assertEqual(gr.load_usernames(path), {})  # a corrupt file cannot crash the run

    def test_shared_master_overrides_the_read_only_seed(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            seed = os.path.join(d, "seed.json")
            master = os.path.join(d, "usernames.json")
            json.dump({A: "seed.01", B: "seed.02"}, open(seed, "w"))
            json.dump({A: "master.01"}, open(master, "w"))
            with mock.patch.object(gr, "SHARED_USERNAMES", master), mock.patch.object(gr, "USERNAMES_SEED", seed):
                self.assertEqual(gr.load_usernames(master), {A: "master.01", B: "seed.02"})

    def test_custom_file_never_inherits_the_tracked_seed(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            seed = os.path.join(d, "seed.json")
            custom = os.path.join(d, "custom.json")
            json.dump({A: "seed.01"}, open(seed, "w"))
            json.dump({B: "custom.01"}, open(custom, "w"))
            with mock.patch.object(gr, "USERNAMES_SEED", seed):
                self.assertEqual(gr.load_usernames(custom), {B: "custom.01"})

    def test_seed_reads_every_archived_game(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            def put(game, fname, meta):
                os.makedirs(os.path.join(d, game), exist_ok=True)
                json.dump({"meta": meta, "entries": []}, open(os.path.join(d, game, fname), "w"))
            put("game-159", "a.json", {"address": A, "username": "a.01"})
            put("game-160", "a.json", {"address": A, "username": "a.02"})   # the later game wins
            put("game-160", "b.json", {"address": B, "username": None})     # no name: nothing to learn
            put("game-160", "c.json", {"username": "c.01"})                 # no address: nothing to key it by
            open(os.path.join(d, "game-160", "links.json"), "w").write("{}")
            open(os.path.join(d, "game-160", "broken.json"), "w").write("not json")
            self.assertEqual(gr.gl.usernames_under(d), {A: "a.02"})


class BotTest(unittest.TestCase):
    def pull(self):
        def root(op, tag=None, env="production"):
            r = {"span.op": op, "timestamp": "2026-10-02T13:00:00+00:00", "environment": env, "game.index": "7", "device.os": "android", "host.kind": "android",
                 "device.model": "Pixel", "release": "jollity-next@abcdef123456", "span.duration": 10}
            if tag:
                r["test.tag"] = tag
            return r
        real = {"roots": [root("journey.join"), root("journey.game")], "metrics": frame_metrics(10), "bot": None}
        bot = {"roots": [root("journey.join", "e2e-bot", "local"), root("journey.game", "e2e-bot", "local")], "metrics": frame_metrics(900), "bot": "e2e-bot"}
        return {"game": 7, "tagged_accounts": [A, B], "players": {A: real, B: bot}}

    def doc(self):
        pull = self.pull()
        pull["players"][A]["roots"][0]["user.username"] = "real.01"
        pull["players"][B]["roots"][0]["user.username"] = "jollityeea.69"
        return gr.assemble(7, pull, None, None, {}, {}, kickoff_override="2026-10-02T13:05:00Z")

    def test_bot_stays_in_the_funnel_but_not_in_smoothness_or_video(self):
        d = self.doc()
        by = {s["stage"]: s for s in d["funnel"]}
        self.assertEqual(by["joined the game"]["count"], 2)
        self.assertEqual(by["played every round"]["count"], 2)
        self.assertEqual([(r["scene"], r["p50"]) for r in d["smoothness"]], [("real.01 (Pixel) · game.round", 10.0)])
        self.assertEqual(d["video"]["freezeMs"], 1000)
        self.assertEqual(d["env"], "production")

    def test_bot_row_has_no_device_and_the_fact_lists_it(self):
        d = self.doc()
        bot = next(p for p in d["players"] if p["id"] == B)
        real = next(p for p in d["players"] if p["id"] == A)
        self.assertEqual((bot["bot"], bot["device"], bot["host"], bot["release"]), ("e2e-bot", "bot", "bot", None))
        self.assertIsNone(real["bot"])
        self.assertEqual(real["device"], "Pixel")
        f = next(f for f in d["facts"] if f["kind"] == "bots")
        self.assertIn("jollityeea.69 (e2e-bot)", f["text"])
        self.assertEqual(f["accounts"], [B])
        self.assertNotIn("real.01", f["text"])

    def test_no_bots_no_fact(self):
        pull = self.pull()
        del pull["players"][B]
        d = gr.assemble(7, pull, None, None, {}, {})
        self.assertFalse([f for f in d["facts"] if f["kind"] == "bots"])

    def test_bot_tag_needs_an_e2e_prefix(self):
        self.assertEqual(grp.bot_tag([{"test.tag": None}], [{"id": 1}, {"test.tag": "e2e-bot"}]), "e2e-bot")
        self.assertIsNone(grp.bot_tag([{"test.tag": "manual"}, {}]))
        self.assertIsNone(grp.bot_tag([]))

    def test_event_tag_reads_the_event_apis_tag_list(self):
        e = {"tags": [{"key": "game.index", "value": "237"}, {"key": "telemetry.health_late", "value": "true"}]}
        self.assertEqual(grp.event_tag(e, "telemetry.health_late"), "true")
        self.assertIsNone(grp.event_tag(e, "missing"))
        self.assertIsNone(grp.event_tag({"tags": None}, "telemetry.health_late"))
        self.assertIsNone(grp.event_tag({}, "telemetry.health_late"))

    def test_metric_pull_keeps_the_pair_identity_for_coverage(self):
        self.assertIn("rtc.pair", grp.COVERAGE_METRIC_FIELDS)
        self.assertNotIn("rtc.pair", grp.METRIC_FIELDS)

    def test_one_viewers_coverage_query_failure_is_recorded_not_raised(self):
        with mock.patch.object(grp.sentry, "events", return_value=[{"count(value)": 1}]), \
                mock.patch.object(grp, "events_all", side_effect=RuntimeError("bad query")):
            rows, reason = grp.coverage_metrics(["s1"], 7, "start", "end")
        self.assertEqual(rows, [])
        self.assertEqual(reason, "coverage query failed")


class SentryPaginationTest(unittest.TestCase):
    class Response:
        def __init__(self, rows, link=""):
            self.body = json.dumps({"data": rows}).encode()
            self.headers = {"Link": link}

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def read(self):
            return self.body

    def test_events_all_follows_only_a_next_page_with_results(self):
        link = '<https://de.sentry.io/api/0/next?cursor=2>; rel="next"; results="true"'
        pages = [self.Response([{"n": 1}], link), self.Response([{"n": 2}])]
        with mock.patch.object(sentry, "_open", side_effect=pages) as opened:
            self.assertEqual(sentry.events_all("tracemetrics", "q", ["metric.name"]), [{"n": 1}, {"n": 2}])
        self.assertIsNone(opened.call_args_list[1].args[1])


class SignalRttTest(unittest.TestCase):
    def test_offers_to_an_absent_peer_are_left_out(self):
        rows = [{"metric.name": "rtc.signal_rtt_ms", "stat": None, "p50(value)": 2000, "max(value)": 3000, "rtc.signal_peer_present": "true"},
                {"metric.name": "rtc.signal_rtt_ms", "stat": None, "p50(value)": 70000, "max(value)": 74000, "rtc.signal_peer_present": "false"},
                {"metric.name": "rtc.signal_rtt_ms", "stat": None, "p50(value)": 4000, "max(value)": 5000}]
        v = gr.video_block({"x": {"metrics": rows}}, {})
        self.assertEqual((v["signalP50"], v["signalMax"]), (3000, 5000))


class PlayWindowsTest(unittest.TestCase):
    REC = {"gameDate": 1000, "rounds": 2, "maxGroupSize": 6}

    def test_rounds_follow_the_apps_schedule(self):
        # 72 s of play per round (6 seats x 12 s), 7 s between rounds
        self.assertEqual(gr.play_windows(self.REC), [(1_000_000, 1_072_000), (1_079_000, 1_151_000)])

    def test_the_clock_lag_shifts_every_window(self):
        self.assertEqual(gr.play_windows(self.REC, lag_s=7.5)[1], (1_086_500, 1_158_500))

    def test_no_rounds_no_windows(self):
        self.assertEqual(gr.play_windows({"gameDate": 1000, "rounds": 0, "maxGroupSize": 6}), [])

    def test_the_lag_is_the_median_offset_of_the_turn_seals(self):
        def seal(t, rnd, turn):
            return entry(t, "vote", "turn sealed", {"round": rnd, "turn": turn})
        rec = {"gameDate": T0 // 1000, "rounds": 2, "maxGroupSize": 6}
        # turn 0 of round 0 ends at +12 s, turn 5 at +72 s, turn 6 (the first of round 1) at +91 s
        a = log(seal(19.1, 0, 0), seal(79.3, 0, 5), seal(98.3, 1, 6))
        b = log(seal(19.5, 0, 0), seal(79.5, 0, 5), seal(98.5, 1, 6))
        self.assertAlmostEqual(gr.clock_lag([a, b], rec), 7.4, places=2)

    def test_no_seals_no_lag(self):
        self.assertEqual(gr.clock_lag([log(entry(1, "rtc", "mesh open"))], self.REC), 0)


class MetricCoverageTest(unittest.TestCase):
    WINDOWS = [(100_000, 200_000)]
    GROUPS = [{"round": 1, "group": 0, "members": [
        {"account": A, "username": "a", "reported": True},
        {"account": B, "username": "b", "reported": True},
    ]}]
    PAIR = f"g7:r1:{min(A, B)}~{max(A, B)}"

    def point(self, name, value):
        return {"metric.name": name, "round": "1", "rtc.pair": self.PAIR, "sum(value)": value}

    def player(self, *points):
        return {"metrics": list(points)}

    def build(self, players, slice_releases=None):
        return gr.coverage_links_from_metrics(7, {}, self.GROUPS, players, self.WINDOWS, slice_releases)

    def game_root(self, start_ms, end_ms):
        return {
            "span.op": "journey.game",
            "timestamp": gr.datetime.datetime.fromtimestamp(
                start_ms / 1000, gr.datetime.timezone.utc
            ).isoformat(),
            "span.duration": end_ms - start_ms,
        }

    def joined(self, players, timeline=()):
        diagnostic = {
            "players": [
                {"account": account, "joined": True}
                for account in (A, B, C, D)
            ],
            "timeline": list(timeline),
        }
        return gr._coverage_joined_accounts(diagnostic, players, self.WINDOWS)

    def test_game_journey_ending_before_first_play_start_is_not_joined(self):
        self.assertNotIn(A, self.joined({A: {"roots": [self.game_root(60_000, 99_999)]}}))

    def test_game_journey_ending_during_shared_clock_play_is_joined(self):
        self.assertIn(A, self.joined({A: {"roots": [self.game_root(60_000, 100_001)]}}))

    def test_self_observed_page_clock_timeline_is_not_participation_proof(self):
        timeline = [{
            "viewer": A,
            "peer": B,
            "segments": [{"from": 100_000, "to": 200_000, "state": "connected"}],
        }]
        self.assertNotIn(A, self.joined({}, timeline))

    def test_g292_stealth_stays_joined_when_a_peer_saw_it_connected_during_play(self):
        timeline = [{
            "viewer": A,
            "peer": B,
            "segments": [{"from": 100_000, "to": 200_000, "state": "connected"}],
        }]
        self.assertIn(B, self.joined({}, timeline))

    def test_g293_stale_peer_connection_under_ten_seconds_is_not_joined(self):
        timeline = [{
            "viewer": A,
            "peer": B,
            "segments": [{"from": 99_000, "to": 102_800, "state": "connected"}],
        }]
        self.assertNotIn(B, self.joined({}, timeline))

    def test_g288_call_case_stays_joined_when_its_game_journey_reached_play(self):
        self.assertIn(A, self.joined({A: {"roots": [self.game_root(60_000, 150_000)]}}))

    def test_sums_a_viewers_slices_across_reload_sessions_against_the_chain_window(self):
        # Separate rows model slices from the sessions before and after the reload;
        # the missing 20 s remains loss against the 100 s chain window.
        links = self.build({
            A: self.player(self.point("rtc.present_ms", 30_000), self.point("rtc.video_ms", 30_000),
                           self.point("rtc.present_ms", 50_000), self.point("rtc.video_ms", 50_000)),
            B: self.player(self.point("rtc.present_ms", 100_000), self.point("rtc.video_ms", 100_000)),
        })
        self.assertEqual(links["matrix"], [{
            "round": 1, "group": 0, "a": A, "b": B, "coverage": 0.8,
            "seenBy": "both", "coverageSource": "metrics", "clipped": 0,
        }])

    def test_one_direction_is_used_and_marked_while_no_directions_is_na(self):
        one = self.build({A: self.player(self.point("rtc.present_ms", 75_000), self.point("rtc.video_ms", 75_000)), B: self.player()})
        self.assertEqual(one["matrix"][0]["coverage"], 0.75)
        self.assertEqual(one["matrix"][0]["seenBy"], "one")
        none = self.build({A: self.player(), B: self.player()})
        self.assertIsNone(none["matrix"][0]["coverage"])
        self.assertEqual(none["matrix"][0]["seenBy"], "neither")

    def test_clips_each_viewer_round_to_the_chain_window_and_the_note_says_so(self):
        links = self.build({
            A: self.player(self.point("rtc.present_ms", 103_001), self.point("rtc.video_ms", 103_001)),
            B: self.player(self.point("rtc.present_ms", 100_000), self.point("rtc.video_ms", 100_000)),
        })
        self.assertEqual(links["matrix"][0]["coverage"], 1.0)
        self.assertEqual(links["matrix"][0]["clipped"], 1)
        breakdown = gr.coverage_breakdown(links, self.GROUPS, {}, {A: {"roots": []}, B: {"roots": []}})
        self.assertEqual(breakdown["clipped"], 1)
        self.assertIn("clipped for one viewer-round", gr.coverage_note(breakdown, breakdown["webOnly"]))

    def test_the_rendered_note_says_when_one_direction_was_missing(self):
        links = self.build({A: self.player(self.point("rtc.present_ms", 75_000), self.point("rtc.video_ms", 75_000)), B: self.player()})
        breakdown = gr.coverage_breakdown(links, self.GROUPS, {}, {})
        self.assertEqual(breakdown["oneSided"], 1)
        self.assertIn("used one direction", gr.coverage_note(breakdown, breakdown["webOnly"]))

    def test_missing_pair_is_loss_when_the_viewer_has_coverage_telemetry_elsewhere(self):
        groups = self.GROUPS + [{**self.GROUPS[0], "round": 2}]
        windows = self.WINDOWS + [(210_000, 310_000)]
        links = gr.coverage_links_from_metrics(7, {}, groups, {
            A: self.player(self.point("rtc.present_ms", 100_000), self.point("rtc.video_ms", 100_000)),
            B: self.player(self.point("rtc.present_ms", 100_000), self.point("rtc.video_ms", 100_000)),
        }, windows)
        self.assertEqual([(m["round"], m["coverage"], m["seenBy"]) for m in links["matrix"]],
                         [(1, 1.0, "both"), (2, 0.0, "both")])

    def test_joined_nonreporter_pair_is_expected_coverage(self):
        groups = [{"round": 1, "group": 0, "members": [
            {"account": A, "username": "a", "reported": True},
            {"account": B, "username": "b", "reported": False},
            {"account": C, "username": "c", "reported": False},
        ]}]
        diagnostic = {"players": [
            {"account": A, "joined": True},
            {"account": B, "joined": True},
            {"account": C, "joined": True},
        ], "timeline": [
            {"viewer": B, "peer": A, "segments": [{"from": 100_000, "to": 200_000, "state": "connected"}]},
            {"viewer": A, "peer": B, "segments": [{"from": 100_000, "to": 200_000, "state": "connected"}]},
        ]}
        links = gr.coverage_links_from_metrics(7, diagnostic, groups, {
            A: self.player(self.point("rtc.present_ms", 75_000), self.point("rtc.video_ms", 75_000)),
            B: self.player(self.point("rtc.present_ms", 100_000), self.point("rtc.video_ms", 100_000)),
            C: {"roots": [{"span.op": "journey.join"}], "metrics": []},
        }, self.WINDOWS)
        breakdown = gr.coverage_breakdown(links, groups, {}, {})
        self.assertEqual((breakdown["coverage"], breakdown["measured"]), (75.0, 1))

    def test_game_session_proves_joined_without_a_report(self):
        groups = [{"round": 1, "group": 0, "members": [
            {"account": A, "username": "a", "reported": True},
            {"account": B, "username": "b", "reported": False},
        ]}]
        diagnostic = {"players": [{"account": A, "joined": True}, {"account": B, "joined": True}]}
        players = {
            A: {"roots": [self.game_root(60_000, 150_000)], "metrics": [
                self.point("rtc.present_ms", 75_000), self.point("rtc.video_ms", 75_000),
            ]},
            B: {"roots": [self.game_root(60_000, 150_000)], "metrics": [
                self.point("rtc.present_ms", 100_000), self.point("rtc.video_ms", 100_000),
            ]},
        }
        links = gr.coverage_links_from_metrics(7, diagnostic, groups, players, self.WINDOWS)
        self.assertEqual(links["matrix"][0]["coverage"], 0.75)

    def test_a_hashed_pair_id_reads_as_its_two_accounts(self):
        # Given
        hashed = f"g7:r1:{gr.pair_link_hash(7, A, B)}"
        players = {A: self.player({**self.point("rtc.present_ms", 1), "rtc.pair": hashed})}

        # When
        count = gr.expand_pair_ids(players, 7, [A, B])

        # Then
        self.assertEqual(count, 1)
        self.assertEqual(players[A]["metrics"][0]["rtc.pair"], f"g7:r1:{min(A, B)}~{max(A, B)}")

    def test_a_hashed_pair_id_outside_the_roster_stays_and_fails(self):
        # Given
        players = {A: self.player({**self.point("rtc.present_ms", 1), "rtc.pair": "g7:r1:0123456789ab"})}

        # When
        count = gr.expand_pair_ids(players, 7, [A, B])

        # Then
        self.assertEqual(count, 0)
        with self.assertRaisesRegex(ValueError, "invalid rtc.pair"):
            self.build(players)

    def test_pair_format_drift_fails_instead_of_turning_into_false_loss(self):
        bad = {A: self.player({**self.point("rtc.present_ms", 1), "rtc.pair": "future-format"})}
        with self.assertRaisesRegex(ValueError, "invalid rtc.pair"):
            self.build(bad)

    REL = "jollity-next@new"
    OLD = "jollity-next@old"
    SLICE_RELEASES = [REL]

    def rooted(self, release, *points, op="journey.game"):
        return {"roots": [{"span.op": op, "release": release}], "metrics": list(points)}

    def test_game_telemetry_without_coverage_rows_is_loss_not_na(self):
        links = self.build({A: self.rooted(self.REL), B: self.rooted(self.REL)}, self.SLICE_RELEASES)
        self.assertEqual((links["matrix"][0]["coverage"], links["matrix"][0]["seenBy"]), (0.0, "both"))

    def test_a_current_build_backgrounded_all_game_is_loss(self):
        # a build sends slices only while visible, so legacy zeros and no slices is real loss on a slice-capable release
        legacy = self.point("rtc.coverage_pct", 0)
        links = self.build({A: self.rooted(self.REL, legacy), B: self.rooted(self.REL, legacy)}, self.SLICE_RELEASES)
        self.assertEqual((links["matrix"][0]["coverage"], links["matrix"][0]["seenBy"]), (0.0, "both"))

    def test_a_pre_slice_build_is_unavailable_and_the_other_end_decides(self):
        # game 209: bigtava.05 on v0.1.25 sent the legacy coverage but no slices
        links = self.build({
            A: self.player(self.point("rtc.present_ms", 90_000), self.point("rtc.video_ms", 80_000)),
            B: self.rooted(self.OLD, self.point("rtc.coverage_pct", 95)),
        }, self.SLICE_RELEASES)
        self.assertEqual((links["matrix"][0]["coverage"], links["matrix"][0]["seenBy"]), (0.8, "one"))

    def test_a_pre_slice_build_without_legacy_rows_is_unavailable_too(self):
        links = self.build({
            A: self.player(self.point("rtc.present_ms", 90_000), self.point("rtc.video_ms", 80_000)),
            B: self.rooted(self.OLD),
        }, self.SLICE_RELEASES)
        self.assertEqual((links["matrix"][0]["coverage"], links["matrix"][0]["seenBy"]), (0.8, "one"))

    def test_a_viewer_whose_game_telemetry_never_arrived_is_unavailable(self):
        # game 216: nemanja.05 and bigtava.05 sent app-open and sign-up only, yet
        # every co-player had their video; their side is no data, not zero
        links = self.build({
            A: self.player(self.point("rtc.present_ms", 100_000), self.point("rtc.video_ms", 100_000)),
            B: self.rooted(self.REL, op="journey.app-open"),
        }, self.SLICE_RELEASES)
        self.assertEqual((links["matrix"][0]["coverage"], links["matrix"][0]["seenBy"]), (1.0, "one"))

    def test_coverage_query_failure_stays_unavailable_and_is_explained(self):
        links = self.build({A: {"roots": [{}], "metrics": [], "coverage_error": "coverage query failed"},
                            B: {"roots": [{}], "metrics": [], "coverage_error": "coverage query failed"}})
        breakdown = gr.coverage_breakdown(links, self.GROUPS, {}, {})
        self.assertIsNone(breakdown["coverage"])
        self.assertEqual(breakdown["coverageErrors"], 2)
        self.assertIn("query failed for two viewers", gr.coverage_note(breakdown, None))


class CoverageBreakdownTest(unittest.TestCase):
    """Play of round 1 runs 100 s..200 s (in ms below); the handover is 60 s before it."""
    PS, PE = 100_000, 200_000

    def seg(self, *s):
        return [{"from": f, "to": t, "state": st} for f, t, st in s]

    def links(self, cov, tl, groups=((A, B),)):
        matrix = [{"round": 1, "group": 0, "a": a, "b": b, "coverage": cov.get((a, b)), "seenBy": "both"} for a, b in groups]
        timeline = [{"viewer": v, "peer": p, "segments": sg} for (v, p), sg in tl.items()]
        return {"rounds": [{"round": 1, "start": 50_000, "end": 200_000, "playStart": self.PS, "playEnd": self.PE}], "matrix": matrix, "timeline": timeline}

    def groups(self, *accts, reported=True):
        return [{"round": 1, "group": 0, "members": [{"account": a, "username": a[1:3] + "x", "reported": reported if a != D else False} for a in accts]}]

    def pull(self, sessions):
        """sessions: {account: [(session id, ms) or (session id, ms, span op)]}; a join or game op is tagged with the game."""
        def root(x):
            r = {"session.id": x[0], "host.kind": "ios",
                 "timestamp": gr.datetime.datetime.fromtimestamp(x[1] / 1000, gr.datetime.timezone.utc).isoformat()}
            if len(x) > 2:
                r.update({"span.op": x[2], "game.index": "7"})
            return r
        return {a: {"roots": [root(x) for x in ss]} for a, ss in sessions.items()}

    def fixture(self, name):
        with open(os.path.join(os.path.dirname(__file__), "fixtures", name)) as f:
            return json.load(f)

    def test_native_players_take_the_whole_missing_share(self):
        links = self.links({(A, B): 0.2}, {})
        b = gr.coverage_breakdown(links, self.groups(A, B), {B: {"route": "other"}}, {})
        self.assertEqual((b["coverage"], b["measured"], b["na"], b["missing"]), (20.0, 1, 0, 80.0))
        self.assertEqual([(c["cause"], c["pct"]) for c in b["causes"]], [("Native players", 80.0)])

    def test_a_player_back_from_the_background(self):
        tl = {(A, B): self.seg((60_000, 130_000, "connecting"), (130_000, 200_000, "connected")),
              (B, A): self.seg((50_000, 200_000, "connected"))}
        links = self.links({(A, B): 0.7}, tl)
        # A's own view starts at 130 s, in a session open since 10 s: before the handover at 40 s
        pull = self.pull({A: [("s1", 10_000), ("s1", 120_000)]})
        tl[(A, B)] = self.seg((130_000, 200_000, "connected"))
        b = gr.coverage_breakdown(self.links({(A, B): 0.7}, tl), self.groups(A, B), {}, pull)
        self.assertEqual([(c["cause"], c["pct"]) for c in b["causes"]], [("App in the background", 30.0)])

    def test_a_player_who_opened_the_app_late(self):
        tl = {(A, B): self.seg((130_000, 200_000, "connected")), (B, A): self.seg((50_000, 200_000, "connected"))}
        pull = self.pull({A: [("s2", 120_000)]})
        b = gr.coverage_breakdown(self.links({(A, B): 0.7}, tl), self.groups(A, B), {}, pull)
        self.assertEqual([(c["cause"], c["pct"]) for c in b["causes"]], [("Late open", 30.0)])

    def test_a_late_player_with_no_telemetry_is_unknown(self):
        # A's view starts after play and A has no Sentry session at all: background or slow link cannot be told apart
        tl = {(A, B): self.seg((130_000, 200_000, "connected")), (B, A): self.seg((50_000, 200_000, "connected"))}
        b = gr.coverage_breakdown(self.links({(A, B): 0.7}, tl), self.groups(A, B), {}, {})
        self.assertEqual([(c["cause"], c["pct"]) for c in b["causes"]], [("Unknown, no telemetry", 30.0)])

    def test_a_player_with_a_log_but_no_view_of_the_round_missed_it(self):
        # A logs (round 2 only, say) but has no segment in round 1; B saw the link never come up. A's session began after play.
        tl = {(B, A): self.seg((50_000, 200_000, "connecting"))}
        links = self.links({(A, B): 0.0}, tl)
        links["players"] = [{"account": A, "hasLog": True}, {"account": B, "hasLog": True}]
        b = gr.coverage_breakdown(links, self.groups(A, B), {}, self.pull({A: [("s3", 150_000)]}))
        self.assertEqual([(c["cause"], c["pct"]) for c in b["causes"]], [("Late open", 100.0)])
        self.assertNotIn("backS", b["causes"][0]["items"][0])
        note = gr.coverage_note(b, b["webOnly"])
        self.assertIn("- Late open: 100.0 %. One player opened the app late.", note)
        self.assertNotRegex(note, r"(?:arrived|came back) \d+(?:\.\d+)? s")
        b = gr.coverage_breakdown(links, self.groups(A, B), {}, {})
        self.assertEqual([(c["cause"], c["pct"]) for c in b["causes"]], [("Unknown, no telemetry", 100.0)])
        b = gr.coverage_breakdown(links, self.groups(A, B), {}, self.pull({A: [("s3", 10_000), ("s3", 250_000)]}))
        self.assertEqual([(c["cause"], c["pct"]) for c in b["causes"]], [("App in the background", 100.0)])

    def test_game_251_positive_coverage_with_one_missing_log_view_is_unknown_log_gap(self):
        fixture = self.fixture("game-251-one-sided-log-gap.json")
        links = fixture["links"]
        groups = fixture["groups"]
        pull = fixture["pullPlayers"]
        b = gr.coverage_breakdown(links, groups, {}, pull)
        self.assertEqual(fixture["game"], 251)
        self.assertEqual(links["matrix"][0]["coverage"], 0.6)
        self.assertEqual([(c["cause"], c["pct"]) for c in b["causes"]], [("Log gap, cause unknown", 40.0)])
        self.assertNotIn("backS", b["causes"][0]["items"][0])
        note = gr.coverage_note(b, b["webOnly"])
        self.assertIn("Log gap, cause unknown", note)
        self.assertNotRegex(note, r"(?:arrived|came back|first saw) \d+(?:\.\d+)? s")

    def test_positive_coverage_with_both_logs_empty_may_be_classified_as_absence(self):
        links = self.links({(A, B): 0.6}, {})
        links["players"] = [{"account": A, "hasLog": True}, {"account": B, "hasLog": True}]
        b = gr.coverage_breakdown(links, self.groups(A, B), {}, self.pull({A: [("s3", 150_000)]}))
        self.assertEqual([c["cause"] for c in b["causes"]], ["Late open"])
        note = gr.coverage_note(b, b["webOnly"])
        self.assertIn("- Late open: 40.0 %. One player opened the app late.", note)
        self.assertNotRegex(note, r"(?:arrived|came back|first saw) \d+(?:\.\d+)? s")

    def test_a_later_round_view_is_not_rendered_as_seconds_into_the_absent_round(self):
        links = self.links({(A, B): 0.0}, {})
        links["rounds"].append({"round": 2, "start": 220_000, "end": 350_000,
                                "playStart": 250_000, "playEnd": 350_000})
        links["timeline"] = [{"viewer": A, "peer": B,
                              "segments": self.seg((250_000, 350_000, "connected"))}]
        links["players"] = [{"account": A, "hasLog": True}, {"account": B, "hasLog": True}]
        b = gr.coverage_breakdown(links, self.groups(A, B), {}, self.pull({A: [("s3", 150_000)]}))
        item = b["causes"][0]["items"][0]
        self.assertEqual(item["seenAgainRound"], 2)
        self.assertNotIn("backS", item)
        note = gr.coverage_note(b, b["webOnly"])
        self.assertNotIn("150 s into round 1", note)
        self.assertNotIn("missed round", note)

    def test_both_present_and_the_link_never_came_up(self):
        tl = {(A, B): self.seg((50_000, 200_000, "connecting")), (B, A): self.seg((50_000, 200_000, "connecting"))}
        links = self.links({(A, B): 0.0}, tl)
        links["players"] = [{"account": A, "hasLog": True}, {"account": B, "hasLog": True}]
        b = gr.coverage_breakdown(links, self.groups(A, B), {}, {})
        self.assertEqual([(c["cause"], c["pct"]) for c in b["causes"]], [("Link never came up", 100.0)])

    def test_a_late_arrival_with_no_video_is_late_open_not_never_came_up(self):
        # B has been in the round from its start; A's session began at 190 s, after play started at 100 s, and no video ever came up
        tl = {(A, B): self.seg((190_000, 200_000, "connecting")), (B, A): self.seg((50_000, 200_000, "connecting"))}
        links = self.links({(A, B): 0.0}, tl)
        links["players"] = [{"account": A, "hasLog": True}, {"account": B, "hasLog": True}]
        pull = self.pull({A: [("s4", 190_000)], B: [("s5", 10_000)]})
        b = gr.coverage_breakdown(links, self.groups(A, B), {}, pull)
        self.assertEqual([(c["cause"], c["pct"]) for c in b["causes"]], [("Late open", 100.0)])
        # the same pair with both sessions running before the handover is still a link that never came up
        pull = self.pull({A: [("s4", 10_000)], B: [("s5", 10_000)]})
        tl[(A, B)] = self.seg((50_000, 200_000, "connecting"))
        links = self.links({(A, B): 0.0}, tl)
        links["players"] = [{"account": A, "hasLog": True}, {"account": B, "hasLog": True}]
        b = gr.coverage_breakdown(links, self.groups(A, B), {}, pull)
        self.assertEqual([(c["cause"], c["pct"]) for c in b["causes"]], [("Link never came up", 100.0)])

    def test_a_relayed_link_counts_as_up(self):
        tl = {(A, B): self.seg((50_000, 110_000, "connecting"), (110_000, 200_000, "relay")), (B, A): self.seg((50_000, 110_000, "connecting"), (110_000, 200_000, "relay"))}
        b = gr.coverage_breakdown(self.links({(A, B): 0.9}, tl), self.groups(A, B), {}, {})
        self.assertEqual([(c["cause"], c["pct"]) for c in b["causes"]], [("Round 1 link setup", 10.0)])

    def test_both_present_and_connecting_late_is_link_setup(self):
        tl = {(A, B): self.seg((50_000, 110_000, "connecting"), (110_000, 200_000, "connected")),
              (B, A): self.seg((50_000, 108_000, "connecting"), (108_000, 200_000, "connected"))}
        b = gr.coverage_breakdown(self.links({(A, B): 0.9}, tl), self.groups(A, B), {}, {})
        self.assertEqual([(c["cause"], c["pct"]) for c in b["causes"]], [("Round 1 link setup", 10.0)])

    def test_a_drop_after_setup_is_its_own_cause_and_the_split_adds_up(self):
        tl = {(A, B): self.seg((50_000, 110_000, "connecting"), (110_000, 150_000, "connected"), (150_000, 170_000, "connecting"), (170_000, 200_000, "connected"))}
        b = gr.coverage_breakdown(self.links({(A, B): 0.7}, tl), self.groups(A, B), {}, {})
        self.assertEqual([(c["cause"], c["pct"]) for c in b["causes"]], [("Lost after the link came up", 20.0), ("Round 1 link setup", 10.0)])
        self.assertEqual(b["missing"], 30.0)
        # each cause quotes only its own seconds (game 216: "lost 48 s at the start" for a pair that lost 0.4 s to setup)
        lost = {c["cause"]: [i["lostS"] for i in c["items"]] for c in b["causes"]}
        self.assertEqual(lost, {"Lost after the link came up": [20.0], "Round 1 link setup": [10.0]})
        self.assertIn("- Round 1 link setup: 10.0 %. One pair lost time at the start of the round.", gr.coverage_note(b, b["webOnly"]))

    def test_a_pair_up_within_a_twentieth_of_a_second_is_not_a_setup_loss(self):
        tl = {(A, B): self.seg((50_000, 100_020, "connecting"), (100_020, 150_000, "connected"), (150_000, 170_000, "connecting"), (170_000, 200_000, "connected"))}
        b = gr.coverage_breakdown(self.links({(A, B): 0.8}, tl), self.groups(A, B), {}, {})
        self.assertEqual([(c["cause"], c["pct"]) for c in b["causes"]], [("Lost after the link came up", 20.0)])

    def test_a_long_drop_after_setup_is_an_unstable_link_not_other(self):
        # game 216: a pair live 8 % of the round sat in "Other" next to 0.4 s round edges
        tl = {(A, B): self.seg((50_000, 100_000, "connecting"), (100_000, 110_000, "connected"), (110_000, 200_000, "reconnecting"))}
        b = gr.coverage_breakdown(self.links({(A, B): 0.1}, tl), self.groups(A, B), {}, {})
        self.assertEqual([(c["cause"], c["pct"]) for c in b["causes"]], [("Lost after the link came up", 90.0)])
        self.assertIn("- Video dropped after it came up: 90.0 %. One pair-round lost video after its link first came up.\n", gr.coverage_note(b, b["webOnly"]) + "\n")

    def test_ten_seconds_lost_is_unstable_despite_float_error(self):
        tl = {(A, B): self.seg((50_000, 200_000, "connected"))}
        b = gr.coverage_breakdown(self.links({(A, B): 0.9}, tl), self.groups(A, B), {}, {})  # (1 - 0.9) * 100 is 9.999999999999998
        self.assertEqual([c["cause"] for c in b["causes"]], ["Lost after the link came up"])

    def test_the_sentence_for_several_pair_rounds_gives_both_ranges(self):
        items = [{"cov": 0.33, "lostS": 66.0}, {"cov": 0.08, "lostS": 33.0}]
        self.assertEqual(gr._cause_sentence("Lost after the link came up", items),
                         "Two pair-rounds lost video after their link first came up.")

    def test_causes_come_out_by_pct_descending_and_na_is_counted(self):
        pairs = ((A, B), (A, C), (B, C), (A, D))
        tl = {(A, B): self.seg((50_000, 200_000, "connected")), (A, C): self.seg((50_000, 110_000, "connecting"), (110_000, 200_000, "connected"))}
        links = self.links({(A, B): 1.0, (A, C): 0.9, (B, C): 0.0, (A, D): 0.5}, tl, pairs)
        b = gr.coverage_breakdown(links, self.groups(A, B, C, D), {C: {"route": "other"}}, {})
        # (A, D) is not expected (D did not report); (B, C) is native; (A, C) is native too (C), so setup does not show
        self.assertEqual((b["measured"], b["na"]), (3, 0))
        self.assertEqual([c["cause"] for c in b["causes"]], ["Native players"])
        links["matrix"][0]["coverage"] = None
        self.assertEqual(gr.coverage_breakdown(links, self.groups(A, B, C, D), {}, {})["na"], 1)

    def test_a_page_replaced_mid_round_is_a_reload_not_a_late_open(self):
        # A joined in session s1 (before the handover), then the page was replaced: s2 began at 120 s, after play started at 100 s
        tl = {(A, B): self.seg((130_000, 200_000, "connected")), (B, A): self.seg((50_000, 200_000, "connected"))}
        pull = self.pull({A: [("s1", 10_000, "journey.join"), ("s2", 120_000)]})
        b = gr.coverage_breakdown(self.links({(A, B): 0.7}, tl), self.groups(A, B), {}, pull)
        self.assertEqual([(c["cause"], c["pct"]) for c in b["causes"]], [("Page reloaded mid-round", 30.0)])
        self.assertEqual(b["causes"][0]["items"][0]["reloadS"], 20.0)
        # the same session start with nothing before it that was in the game is a late open
        pull = self.pull({A: [("s1", 10_000), ("s2", 120_000)]})
        b = gr.coverage_breakdown(self.links({(A, B): 0.7}, tl), self.groups(A, B), {}, pull)
        self.assertEqual([c["cause"] for c in b["causes"]], ["Late open"])

    def test_a_background_kill_diagnostic_in_the_new_session_marks_a_reload(self):
        tl = {(A, B): self.seg((130_000, 200_000, "connected")), (B, A): self.seg((50_000, 200_000, "connected"))}
        pull = self.pull({A: [("s2", 120_000)]})
        pull[A]["events"] = [{
            "timestamp": "1970-01-01T00:02:00+00:00",
            "title": "previous-session-end",
            "session.id": "s2",
            "previous.game": "7",
            "previous.turn": "1",
            "failure": {"kind": "unclean-exit", "reason": "in-game"},
        }]
        b = gr.coverage_breakdown(self.links({(A, B): 0.7}, tl), self.groups(A, B), {}, pull, game=7)
        self.assertEqual([c["cause"] for c in b["causes"]], ["Page reloaded mid-round"])
        self.assertEqual(b["causes"][0]["items"][0]["reloadS"], 20.0)

    def test_game_259_three_page_lives_are_counted_from_previous_session_ends(self):
        evidence = PAGE_LIVES["game259"]
        page_ends = [
            grp._page_end_with_detail(row, evidence["details"][row["id"]])
            for row in grp.previous_session_ends(evidence["errors"], "errors")
        ]
        player = {"roots": evidence["roots"], "pageEnds": page_ends}

        lives = gr.page_lives(player, game=259)
        self.assertEqual([life["end"] for life in lives], ["host-reload", "crash-or-kill-foreground", "played"])
        self.assertEqual(
            gr.page_lives_note(lives),
            "3 page lives during the game: 1 ended with a host reload, 1 was killed in the foreground",
        )
        self.assertEqual(lives[-1]["startedAt"], "2026-10-16T14:05:49+00:00")
        self.assertEqual(
            gr._session_start(player, gr.parse_ts("2026-10-16T14:05:51+00:00").timestamp() * 1000),
            gr.parse_ts("2026-10-16T14:05:49+00:00").timestamp() * 1000,
        )

        tl = {(A, B): self.seg((150_000, 200_000, "connected")), (B, A): self.seg((50_000, 200_000, "connected"))}
        pull = self.pull({A: [("page-1", 103_700, "journey.game"), ("page-2", 119_000),
                              ("page-3", 142_000, "journey.game")]})
        pull[A]["pageEnds"] = [
            {**page_ends[0], "session.id": "page-2", "previous.game": "7"},
            {**page_ends[1], "session.id": "page-3", "previous.game": "7"},
        ]
        b = gr.coverage_breakdown(self.links({(A, B): 0.5}, tl), self.groups(A, B), {}, pull, game=7)
        self.assertEqual([c["cause"] for c in b["causes"]], ["Page reloaded mid-round"])
        self.assertEqual(b["causes"][0]["items"][0]["pageLives"], 3)
        self.assertEqual(
            gr._player_sentence("Page reloaded mid-round", b["causes"][0]["items"]),
            "One player reloaded the page mid-round (three page lives).",
        )

        rows = gr.build_players(
            [A], {"game": 7, "players": {A: pull[A]}}, {}, {}, {}, {}, set(),
        )
        self.assertEqual([life["end"] for life in rows[0]["pageLives"]],
                         ["host-reload", "crash-or-kill-foreground", "played"])
        self.assertIn(
            "3 page lives during the game: 1 ended with a host reload, 1 was killed in the foreground",
            rows[0]["game"]["note"],
        )

    def test_player_page_lives_are_limited_to_kickoff_handover_through_settlement(self):
        lives = [
            {"sessionId": "old-1", "startedAt": "2026-10-16T13:00:00+00:00", "endedAt": "2026-10-16T13:05:00+00:00", "end": "host-reload"},
            {"sessionId": "old-2", "startedAt": "2026-10-16T13:30:00+00:00", "lastSeenAt": "2026-10-16T13:45:00+00:00", "end": "open"},
            {"sessionId": "game-1", "startedAt": "2026-10-16T13:59:30+00:00", "endedAt": "2026-10-16T14:05:00+00:00", "end": "host-reload"},
            {"sessionId": "game-2", "startedAt": "2026-10-16T14:05:00+00:00", "endedAt": "2026-10-16T14:07:00+00:00", "end": "host-reload"},
            {"sessionId": "game-3", "startedAt": "2026-10-16T14:07:00+00:00", "end": "open"},
            {"sessionId": "later", "startedAt": "2026-10-16T14:21:00+00:00", "end": "open"},
        ]
        window = (gr.parse_ts("2026-10-16T13:59:00+00:00"), gr.parse_ts("2026-10-16T14:20:00+00:00"))
        kept, earlier = gr.page_lives_in_window(lives, window)
        self.assertEqual([life["sessionId"] for life in kept], ["game-1", "game-2", "game-3"])
        self.assertEqual(earlier, 2)
        self.assertEqual(
            gr.page_lives_note(kept, earlier),
            "3 page lives during the game: 2 ended with a host reload; 2 earlier sessions were omitted",
        )

    def test_a_foreground_kill_before_play_is_a_page_end_not_a_mid_round_reload(self):
        for end in ("crash-or-kill-foreground", "host-reload"):
            with self.subTest(end=end):
                pull = self.pull({A: [("page-2", 120_000, "journey.app-open")]})
                pull[A]["roots"][0]["host.kind"] = "ios"
                pull[A]["pageEnds"] = [{
                    "timestamp": "1970-01-01T00:02:00+00:00", "session.id": "page-2",
                    "previous.session.session_id": "record-page-1", "previous.end": end,
                    "previous.game": "7", "previous.in_game": False, "previous.turn": "unknown",
                    "previous.session.open_journeys": "join",
                }]

                self.assertEqual([life["end"] for life in gr.page_lives(pull[A], game=7)], [end, "open"])
                cause, _started = gr._session_cause(pull[A], self.PS, 130_000, game=7)
                self.assertEqual(cause, "Late open")

    def test_page_end_mid_round_uses_only_the_app_gameplay_signals(self):
        self.assertTrue(gr._page_end_mid_round({"previous.turn": "1"}))
        self.assertTrue(gr._page_end_mid_round({"previous.session.open_journeys": "join,game"}))
        self.assertFalse(gr._page_end_mid_round({
            "previous.turn": "unknown", "previous.in_game": False,
            "previous.session.open_journeys": "home-first-status,join",
        }))

        evidence = PAGE_LIVES["game259"]
        row = next(row for row in evidence["errors"] if row["id"].startswith("1e9803c8"))
        context = evidence["details"][row["id"]]["contexts"]["previous.session"]
        real_waiting_room_end = {
            **row,
            "previous.session.session_id": context["session_id"],
            "previous.session.open_journeys": context["open_journeys"],
            "previous.session.open_journey_steps": context["open_journey_steps"],
        }
        self.assertEqual(real_waiting_room_end["previous.in_game"], "True")
        self.assertFalse(gr._page_end_mid_round(real_waiting_room_end))

        pull = self.pull({A: [(real_waiting_room_end["session.id"], 120_000, "journey.app-open")]})
        pull[A]["pageEnds"] = [{**real_waiting_room_end, "previous.game": "7"}]
        pull[A]["events"] = [{
            **real_waiting_room_end,
            "previous.game": "7",
            "failure": {"kind": "unclean-exit", "reason": "in-game", "open_journeys": "join"},
        }]
        cause, _started = gr._session_cause(pull[A], self.PS, 130_000, game=7)
        self.assertEqual(cause, "Late open")

    def test_an_unclean_exit_from_another_session_does_not_hide_a_real_late_open(self):
        tl = {(A, B): self.seg((130_000, 200_000, "connected")), (B, A): self.seg((50_000, 200_000, "connected"))}
        pull = self.pull({A: [("s2", 120_000)]})
        pull[A]["events"] = [{
            "timestamp": "1970-01-01T00:01:00+00:00",
            "title": "previous-session-end",
            "session.id": "older-session",
            "previous.game": "7",
            "failure": {"kind": "unclean-exit", "reason": "in-game"},
        }]
        b = gr.coverage_breakdown(self.links({(A, B): 0.7}, tl), self.groups(A, B), {}, pull, game=7)
        self.assertEqual([c["cause"] for c in b["causes"]], ["Late open"])

    def test_an_unclean_exit_from_another_game_does_not_hide_a_real_late_open(self):
        tl = {(A, B): self.seg((130_000, 200_000, "connected")), (B, A): self.seg((50_000, 200_000, "connected"))}
        pull = self.pull({A: [("s2", 120_000)]})
        pull[A]["events"] = [{
            "timestamp": "1970-01-01T00:02:00+00:00",
            "title": "previous-session-end",
            "session.id": "s2",
            "previous.game": "6",
            "failure": {"kind": "unclean-exit", "reason": "in-game"},
        }]
        b = gr.coverage_breakdown(self.links({(A, B): 0.7}, tl), self.groups(A, B), {}, pull, game=7)
        self.assertEqual([c["cause"] for c in b["causes"]], ["Late open"])

    def test_a_rejoin_in_the_game_log_also_marks_a_reload(self):
        tl = {(A, B): self.seg((130_000, 200_000, "connected")), (B, A): self.seg((50_000, 200_000, "connected"))}
        links = self.links({(A, B): 0.7}, tl)
        links["events"] = [{"at": 125_000, "account": A, "kind": "rejoin", "detail": "mesh reopened for the same room"}]
        b = gr.coverage_breakdown(links, self.groups(A, B), {}, self.pull({A: [("s2", 120_000)]}))
        self.assertEqual([c["cause"] for c in b["causes"]], ["Page reloaded mid-round"])


    def test_registration_routes_from_the_chain_reader(self):
        chain = {"accounts": [{"account": A, "registrationCall": "Game.sign_up_with_account_lite_invite", "registeredAt": "t"},
                              {"account": B, "registrationCall": "Game.sign_up_with_invite", "registeredAt": "u"}, {"account": C}]}
        self.assertEqual(gr.registration_by_account(chain), {A: {"at": "t", "route": "web", "call": "Game.sign_up_with_account_lite_invite"},
                                                              B: {"at": "u", "route": "other", "call": "Game.sign_up_with_invite"}})


    def test_returning_and_deposit_sign_ups_are_web(self):
        # theender.02 in game 166: a returning player signs up with sign_up_with_account (routes B and C), still the web app
        chain = {"accounts": [{"account": A, "registrationCall": "Game.sign_up_with_account", "registeredAt": "t"}]}
        self.assertEqual(gr.registration_by_account(chain)[A]["route"], "web")

class CoverageNoteTest(unittest.TestCase):
    """coverage_note() writes the text under the coverage box from a breakdown. It never names a player."""

    def item(self, **kw):
        return {"round": 1, "native": False, "cov": 0.9, "lostS": 1.0, **kw}

    def native_game(self):
        # shaped like game 206: 57 % coverage, 43 % missing, native players the bulk of it
        return {"coverage": 56.9, "measured": 29, "na": 0, "missing": 43.1, "nonWeb": True, "webOnly": 97.2, "causes": [
            {"cause": "Other", "pct": 0.13, "pairs": ["x"], "items": [self.item(lostS=0.4), self.item(lostS=0.6)]},
            {"cause": "Native players", "pct": 41.38, "pairs": ["kamamama.01 - 5GqD"], "items": [self.item(native=True, cov=0, lostS=72.0) for _ in range(12)]},
            {"cause": "Round 2 link setup", "pct": 0.2, "pairs": ["y"], "items": [self.item(round=2, lostS=0.8), self.item(round=2, lostS=1.2), self.item(round=2, lostS=1.8)]},
            {"cause": "App in the background", "pct": 1.39, "pairs": ["z"], "items": [
                self.item(who="P", backS=10.0, connectS=14.0, silent=True, cameraMs=1300.0), self.item(who="P", backS=10.0, connectS=16.0, silent=True, cameraMs=1300.0)]},
        ]}

    def test_a_game_with_native_players(self):
        note = gr.coverage_note(self.native_game(), 97.2)
        lines = note.split("\n")
        self.assertEqual(lines[:2], ["Where the missing 43 % goes across pair-rounds where both players joined:", ""])
        lines = lines[1:]  # the cause lines start at index 1
        self.assertEqual([l.split(":")[0] for l in lines[1:-1]], ["- Native players", "- App in the background", "- Round 2 link setup", "- Other"])
        self.assertIn("- Native players: 41.4 %. The 12 web-to-native pair-rounds had no video.", lines)
        self.assertEqual(lines[2], "- App in the background: 1.4 %. One player had the app in the background.")
        self.assertEqual(lines[3], "- Round 2 link setup: 0.2 %. Three pairs lost time at the start of the round.")
        self.assertEqual(lines[4], "- Other: 0.1 %. Short drops and round edges across two pair-rounds.")
        self.assertEqual(lines[-1], "Between web players alone: 97 %.")

    def test_an_all_web_game_has_no_platform_line(self):
        b = {"coverage": 90.0, "measured": 6, "na": 0, "missing": 10.0, "nonWeb": False, "webOnly": 90.0,
             "causes": [{"cause": "Round 1 link setup", "pct": 10.0, "pairs": [], "items": [self.item(lostS=2.0)]}]}
        note = gr.coverage_note(b, 90.0)
        self.assertNotIn("Every player was on the web app", note)
        self.assertNotIn("Between web players", note)
        self.assertEqual(note, "Where the missing 10 % goes across pair-rounds where both players joined:\n\n- Round 1 link setup: 10.0 %. One pair lost time at the start of the round.")

    def test_no_names_or_account_ids_and_no_points(self):
        b = self.native_game()
        for c in b["causes"]:
            c["pairs"] = ["fredferkel.01 - " + A, "theender.02 - " + B]
        note = gr.coverage_note(b, 97.2)
        for banned in ("fredferkel", "theender", "kamamama", A, B, "5GqD", "point"):
            self.assertNotIn(banned, note)
        self.assertEqual(note.count("%"), 1 + 4 + 1)  # header, four causes, the web-only line

    def test_the_causes_add_up_to_the_missing_share(self):
        import re
        note = gr.coverage_note(self.native_game(), 97.2)
        shown = [float(x) for x in re.findall(r": (\d+\.\d) %\.", note)]
        self.assertAlmostEqual(sum(shown), 43.1, places=6)
        # an awkward split still adds up to its total to 0.1
        b = {"coverage": 66.6, "measured": 3, "na": 0, "missing": 33.4, "nonWeb": False, "causes": [
            {"cause": c, "pct": p, "pairs": [], "items": [self.item()]} for c, p in (("Link never came up", 11.14), ("Round 1 link setup", 11.13), ("Other", 11.13))]}
        shown = [float(x) for x in re.findall(r": (\d+\.\d) %\.", gr.coverage_note(b, None))]
        self.assertAlmostEqual(sum(shown), 33.4, places=6)

    def test_a_cause_that_rounds_to_nothing_folds_into_other(self):
        b = self.native_game()
        b["causes"].append({"cause": "Late open", "pct": 0.01, "pairs": [], "items": [self.item()]})
        note = gr.coverage_note(b, 97.2)
        self.assertNotIn("Late open", note)
        self.assertNotIn(": 0.0 %", note)

    def test_a_reload_sentence_is_the_intro_alone(self):
        items = [{"round": 1, "who": "a", "cov": 0.09, "lostS": 63.0, "connectS": 63.0, "reloadS": 41.7},
                 {"round": 1, "who": "a", "cov": 0.06, "lostS": 64.5, "connectS": 64.5, "reloadS": 41.7}]
        self.assertEqual(gr._player_sentence("Page reloaded mid-round", items), "One player reloaded the page mid-round.")

    def test_the_reloaded_page_has_its_own_category(self):
        item = self.item(who="P", reloadS=53.8, backS=61.1, connectS=62.5, silent=True)
        b = {"coverage": 90.0, "measured": 6, "na": 0, "missing": 10.0, "nonWeb": False, "webOnly": 90.0, "causes": [
            {"cause": "Page reloaded mid-round", "pct": 7.5, "pairs": ["fredferkel.01 - player.01"], "items": [item, dict(item), dict(item)]},
            {"cause": "Other", "pct": 2.5, "pairs": [], "items": [self.item(lostS=3.0)]}]}
        note = gr.coverage_note(b, 90.0)
        self.assertIn("- Page reloaded mid-round: 7.5 %. One player reloaded the page mid-round.\n", note + "\n")
        self.assertNotIn("Late open", note)
        self.assertNotIn("fredferkel", note)

    def late(self, who, round, back, lost, cov=0.5, **kw):
        return self.item(round=round, who=who, backS=back, lostS=lost, cov=cov, absentRound=cov <= 0, silent=True, **kw)

    def late_note(self, items, cause="Late open"):
        b = {"coverage": 77.6, "measured": 10, "na": 0, "missing": 22.4, "nonWeb": False, "webOnly": 77.6,
             "causes": [{"cause": cause, "pct": 22.4, "pairs": ["x - y"], "items": items}]}
        return gr.coverage_note(b, 77.6).split("\n")[2]

    def game_208_items(self, who="P"):
        return ([self.late(who, 1, 107.0, 96.0, cov=0) for _ in range(2)]
                + [self.late(who, 2, 28.0, lost) for lost in (3.4, 20.0, 35.0)])

    def test_game_208_late_open_is_one_short_line(self):
        self.assertEqual(self.late_note(self.game_208_items()), "- Late open: 22.4 %. One player opened the app late.")

    def test_two_late_players_are_counted_not_told(self):
        note = self.late_note(self.game_208_items("P") + [self.late("Q", 1, 20.0, 10.0)])
        self.assertEqual(note, "- Late open: 22.4 %. Two players opened the app late.")

    def test_background_and_reload_are_one_short_line(self):
        items = [self.late("P", 1, 40.0, 5.0), self.late("P", 2, 22.0, 9.0), self.late("Q", 1, 3.4, 6.6, reloadS=1.0)]
        self.assertEqual(self.late_note(items, "App in the background"), "- App in the background: 22.4 %. Two players had the app in the background.")
        self.assertEqual(self.late_note(items[:2], "Page reloaded mid-round"), "- Page reloaded mid-round: 22.4 %. One player reloaded the page mid-round.")

    def test_every_cause_line_is_a_label_a_percent_and_one_sentence(self):
        item = self.item(who="P", backS=10.0, lostS=3.0, reloadS=2.0, connectS=12.0)
        causes = ["Native players", "App in the background", "Late open", "Page reloaded mid-round", "Unknown, no telemetry", "Link never came up",
                  "Log gap, cause unknown", "Round 1 link setup", "Lost after the link came up", "Other"]
        for cause in causes:
            for items in ([item], [item, dict(item, who="Q", round=2)]):
                sentence = gr._cause_sentence(cause, items)
                self.assertEqual(len(re.findall(r"[.!?](?:\s|$)", sentence)), 1, sentence)
                self.assertFalse(re.search(r"\d+(?:\.\d+)? s\b|into round|before that|% of the round", sentence), sentence)

    def test_late_notes_carry_no_usernames_or_ids(self):
        items = [dict(i, who=A) for i in self.game_208_items()]
        b = {"coverage": 77.6, "measured": 10, "na": 0, "missing": 22.4, "nonWeb": False, "webOnly": 77.6,
             "causes": [{"cause": "Late open", "pct": 22.4, "pairs": ["fredferkel.01 - " + B], "items": items}]}
        note = gr.coverage_note(b, 77.6)
        for banned in ("fredferkel", A, B, "5AAAA"):
            self.assertNotIn(banned, note)

    def test_no_coverage_means_no_note(self):
        self.assertIsNone(gr.coverage_note({"coverage": None, "causes": []}, None))
        self.assertIsNone(gr.coverage_note(None, None))

    def test_web_only_without_a_web_pair_is_n_a(self):
        b = self.native_game()
        self.assertEqual(gr.coverage_note(b, None).split("\n")[-1], "Between web players alone: n/a.")


def moment_metrics(avg, worst):
    return [{"metric.name": "ui.moment_frame_ms", "moment": mo, "stat": "avg", "sum(value)": avg * 10, "count(value)": 10} for mo in ("play", "ending")] + \
           [{"metric.name": "ui.moment_frame_ms", "moment": mo, "stat": "max", "max(value)": worst} for mo in ("play", "ending")]


def probe_metrics(p95, frames):
    attrs = {"probe.version": "1", "probe.threshold_ms": "50"}
    return [{"metric.name": "ui.probe_frame_ms", "stat": "p95", "p50(value)": p95, "max(value)": p95, "min(value)": p95, "count(value)": 1, "sum(value)": p95, **attrs},
            {"metric.name": "ui.probe_frames", "p50(value)": frames, "max(value)": frames, "min(value)": frames, "count(value)": 1, "sum(value)": frames, **attrs}]


def tag(rows, lowpower, probe):
    return [{**r, "lowpower": lowpower, "probe": probe} for r in rows]


class LowPowerTest(unittest.TestCase):
    """The mode and the device probe of each player, and the low power rows of the smoothness block."""

    def pull(self, tags=True, c_os="ios", c_model="iPhone"):
        def root(name, os_="ios", model="iPhone"):
            return {"span.op": "journey.game", "timestamp": "2026-10-02T13:00:00+00:00", "environment": "production", "game.index": "7",
                    "device.os": os_, "device.model": model, "user.username": name, "span.duration": 10}

        def metrics(p50, avg, low, probe=None):
            rows = frame_metrics(p50) + moment_metrics(avg, avg * 3)
            return tag(rows + (probe or []), "on" if low else "off", "done" if probe else "none") if tags else rows

        players = {A: {"roots": [root("a.01")], "metrics": metrics(10, 12, False, probe_metrics(22.4, 118))},
                   B: {"roots": [root("b.01")], "metrics": metrics(14, 16, False)},
                   C: {"roots": [root("c.01", c_os, c_model)], "metrics": metrics(40, 60, True, probe_metrics(58.2, 41))}}
        if not tags:
            del players[C]
        return {"game": 7, "tagged_accounts": sorted(players), "players": players}

    def doc(self, pull):
        return gr.assemble(7, pull, None, None, {}, {}, kickoff_override="2026-10-02T13:05:00Z")

    def test_mode_from_the_lowpower_tag(self):
        self.assertEqual(gr.player_mode([{"lowpower": "off"}, {"lowpower": "on"}]), "low power")
        self.assertEqual(gr.player_mode([{"lowpower": "off"}, {"lowpower": ""}]), "full")
        self.assertIsNone(gr.player_mode([{"lowpower": ""}, {}]))
        self.assertIsNone(gr.player_mode([]))

    def test_mode_reason_from_the_reason_tag(self):
        row = lambda lp, why: {"lowpower": lp, "lowpower.reason": why}
        self.assertEqual(gr.player_mode_reason([row("off", "none"), row("on", "debug-menu")]), "debug menu")
        self.assertEqual(gr.player_mode_reason([row("on", "probe-weak-confirmed")]), "probe weak confirmed")
        self.assertEqual(gr.player_mode_reason([row("on", "probe-weak"), row("on", "debug-menu")]), "debug menu, probe weak")
        self.assertIsNone(gr.player_mode_reason([row("off", "none")]))
        self.assertIsNone(gr.player_mode_reason([{"lowpower": "on"}]))  # an older build sends no reason

    def test_probe_reads_the_median_from_its_own_metric(self):
        p50 = {"metric.name": "ui.probe_frame_median_ms", "max(value)": 33.3, "min(value)": 33.3, "probe.version": "3"}
        out = gr.player_probe(tag(probe_metrics(58.24, 41) + [p50], "off", "done"))
        self.assertEqual((out["p95Ms"], out["medianMs"]), (58.2, 33.3))

    def test_report_shows_the_reason_beside_low_power(self):
        pull = self.pull()
        for r in pull["players"][C]["metrics"]:
            r["lowpower.reason"] = "debug-menu"
        by = {p["id"]: p for p in self.doc(pull)["players"]}
        self.assertEqual((by[C]["mode"], by[C]["modeReason"]), ("low power", "debug menu"))
        self.assertIsNone(by[A]["modeReason"])
        self.assertTrue(any("low power (debug menu)" in r["scene"] for r in self.doc(pull)["smoothness"]))

    def test_probe_numbers_or_none(self):
        self.assertEqual(gr.player_probe(tag(probe_metrics(58.24, 41), "on", "done")), {"p95Ms": 58.2, "frames": 41, "version": "1", "thresholdMs": "50"})
        self.assertEqual(gr.player_probe(tag(frame_metrics(10), "off", "none")), "none")
        self.assertIsNone(gr.player_probe(frame_metrics(10)))

    def test_probe_v2_reports_the_deciding_value_and_every_sample(self):
        attrs = {"probe.version": "2", "probe.rule": "weak-confirmed", "probe.borderline_from_ms": "45", "probe.weak_from_ms": "60", "probe.samples": "2"}
        rows = [{**r, **attrs} for r in probe_metrics(52, 90)]
        for n, p95, frames in (("1", 50, 94), ("2", 52, 90)):
            for r in probe_metrics(p95, frames):
                name = "ui.probe_sample_ms" if r["metric.name"] == "ui.probe_frame_ms" else "ui.probe_sample_frames"
                rows.append({**r, **attrs, "metric.name": name, "probe.sample": n})
        for r in rows:
            r.pop("probe.threshold_ms", None)
        probe = gr.player_probe(tag(rows, "on", "done"))
        self.assertEqual((probe["p95Ms"], probe["frames"]), (52.0, 90))
        self.assertEqual(probe["samples"], [{"p95Ms": 50.0, "frames": 94}, {"p95Ms": 52.0, "frames": 90}])
        self.assertEqual((probe["rule"], probe["version"], probe["weakFromMs"], probe["thresholdMs"]), ("weak-confirmed", "2", "60", None))
        self.assertEqual((probe["stage"], probe["attempts"]), (None, None))

    def test_probe_v5_reports_the_stage_and_the_attempts_of_each_load(self):
        attrs = {"probe.version": "5", "probe.rule": "clear", "probe.borderline_from_ms": "45", "probe.weak_from_ms": "60", "probe.samples": "1"}
        # a reload: one probe per page load, so the grouped rows split by stage and attempts
        rows = [{**r, **attrs, "probe.stage": "countdown", "probe.attempts": "0"} for r in probe_metrics(30, 110)]
        rows += [{**r, **attrs, "probe.stage": "late", "probe.attempts": "2"} for r in probe_metrics(41, 96)]
        probe = gr.player_probe(tag(rows, "off", "done"))
        self.assertEqual((probe["p95Ms"], probe["frames"]), (41.0, 96))
        self.assertEqual((probe["stage"], probe["attempts"]), ("countdown, late", "0, 2"))
        self.assertEqual(gr.player_probe(tag(rows[2:], "off", "done"))["stage"], "late")

    def test_probe_v1_keeps_the_single_sample_shape(self):
        probe = gr.player_probe(tag(probe_metrics(50, 94), "on", "done"))
        self.assertNotIn("samples", probe)
        self.assertEqual(probe["thresholdMs"], "50")

    def test_player_rows_carry_the_mode_and_the_probe(self):
        by = {p["id"]: p for p in self.doc(self.pull())["players"]}
        self.assertEqual((by[A]["mode"], by[A]["probe"]["p95Ms"], by[A]["probe"]["frames"]), ("full", 22.4, 118))
        self.assertEqual((by[B]["mode"], by[B]["probe"]), ("full", "none"))
        self.assertEqual((by[C]["mode"], by[C]["probe"]), ("low power", {"p95Ms": 58.2, "frames": 41, "version": "1", "thresholdMs": "50"}))

    def test_a_low_power_iphone_stays_out_of_the_pools_and_gets_its_own_rows(self):
        rows = [(r["scene"], r["p50"], r["p95"]) for r in self.doc(self.pull())["smoothness"]]
        self.assertEqual(rows, [
            ("c.01 (iPhone, low power) · game.round", 40.0, 80.0),
            ("iPhones (2) · game.round", 12.0, 24.0),
            ("iPhones (2) · moment play (avg / worst frame)", 14.0, 42.0),
            ("iPhones (2) · moment ending (avg / worst frame)", 14.0, 42.0),
            ("c.01 (iPhone, low power) · moment play (avg / worst frame)", 60.0, 180.0),
            ("c.01 (iPhone, low power) · moment ending (avg / worst frame)", 60.0, 180.0),
        ])

    def test_a_low_power_android_is_labeled_and_out_of_the_android_pool(self):
        scenes = [r["scene"] for r in self.doc(self.pull(c_os="android", c_model="Pixel"))["smoothness"]]
        self.assertIn("c.01 (Pixel, low power) · game.round", scenes)
        self.assertNotIn("Android (1) · moment play (avg / worst frame)", scenes)
        self.assertIn("c.01 (Pixel, low power) · moment ending (avg / worst frame)", scenes)
        self.assertEqual(scenes.count("c.01 (Pixel, low power) · moment ending (avg / worst frame)"), 1)  # no extra slow-ending row

    def test_an_old_pull_gives_the_same_report_as_before(self):
        old = self.doc(self.pull(tags=False))
        self.assertEqual([(r["scene"], r["p50"], r["p95"]) for r in old["smoothness"]], [
            ("iPhones (2) · game.round", 12.0, 24.0),
            ("iPhones (2) · moment play (avg / worst frame)", 14.0, 42.0),
            ("iPhones (2) · moment ending (avg / worst frame)", 14.0, 42.0),
        ])
        self.assertEqual([(p["mode"], p["probe"]) for p in old["players"]], [(None, None), (None, None)])
        # full mode players with the new tags: every field but the two new ones is the same
        new = self.pull()
        del new["players"][C]
        new = self.doc(new)
        strip = lambda d: {**d, "summary": None, "adaptations": None,
                           "players": [{k: v for k, v in p.items() if k not in ("mode", "probe")} for p in d["players"]]}
        self.assertEqual(strip(old), strip(new))


class AdaptationsTest(unittest.TestCase):
    def test_summary_explains_adaptations_in_plain_english(self):
        adaptations = {
            "lowPower": {"players": 14, "lowPower": 5, "full": 9,
                         "reasons": [{"reason": "probe-weak", "players": 4},
                                     {"reason": "probe-weak-confirmed", "players": 1}]},
            "sendLadder": {"senders": 14, "steppedDown": 9,
                           "lowestRung": [{"rung": "lean", "senders": 6}, {"rung": "survival", "senders": 3}],
                           "secondsByRung": [{"rung": "full", "seconds": 900}, {"rung": "lean", "seconds": 600}, {"rung": "low", "seconds": 0},
                                             {"rung": "minimum", "seconds": 0}, {"rung": "survival", "seconds": 40}]},
            "picture": {
                "receivedHeight": gr.ladder_distribution([360] * 50 + [254] * 9 + [240, 120], gr.LADDER_HEIGHTS, "px"),
                "sentHeight": gr.ladder_distribution([360] * 50 + [254] * 9 + [180, 240], gr.LADDER_HEIGHTS, "px"),
                "receivedFps": gr.ladder_distribution([24] * 10 + [23, 11], gr.LADDER_FPS, "fps", gr.FPS_TOLERANCE),
                "sentFps": gr.ladder_distribution([24] * 10 + [14, 8], gr.LADDER_FPS, "fps", gr.FPS_TOLERANCE),
            },
        }
        self.assertEqual(gr._adaptation_lines(adaptations), [
            "",
            "**Performance adaptations**",
            "- 5 of the 14 players ran in low power mode: 4 because the device check found the phone slow, 1 because a second check confirmed it.",
            "- Our upload ladder (the app's own five steps, full to survival): 9 of 14 senders stepped down at least once (lowest step reached: 6 to lean, 3 to survival). Time on each step, all senders and rounds: full 900 s, lean 600 s, low 0 s, minimum 0 s, survival 40 s.",
            "- Picture height in pixels, on the same 61 link directions as under Links: received 50 at 360, 9 at 254 (the browser's own downscale of 360, half the pixels; not a ladder step), 1 at 240, 1 at 120; sent 50 at 360, 9 at 254 (the browser's own downscale of 360, half the pixels; not a ladder step), 1 at 240, 1 at 180.",
            "- Frames per second, on the same 12 link directions: received 11 at 24, 1 at 12; sent 10 at 24, 1 at 14 (not a ladder value), 1 at 8.",
        ])

    def test_ladder_buckets_use_the_standard_values_and_flag_others(self):
        dist = gr.ladder_distribution([360, 360, 254, 120, 23.0, 300], gr.LADDER_HEIGHTS, "px")
        self.assertEqual([(b["label"], b["count"]) for b in dist["buckets"]],
                         [("360 px", 2), ("300 px (not a ladder value)", 1), ("254 px (the browser's own downscale of 360, half the pixels; not a ladder step)", 1), ("120 px", 1), ("23 px (not a ladder value)", 1)])
        self.assertEqual(dist["samples"], 6)

    def test_sent_and_received_are_joined_on_the_pair_id(self):
        pair = "g254:r1:" + A + "~" + B
        row = lambda name, value: {"metric.name": name, "stat": "p50", "round": "1", "rtc.pair": pair, "p50(value)": value}
        pull = {A: {"linkPairs": [row("rtc.out_fps", 8), row("rtc.in_fps", 24), row("rtc.out_height", 180)]},
                B: {"linkPairs": [row("rtc.in_fps", 11), row("rtc.in_fps", 9), row("rtc.out_fps", 24)]}}
        d = gr.link_directions(pull)
        # A sends to B (A's out, B's in; the lower of B's two rows); B sends to A (B's out, A's in); A's height has no receiver row
        self.assertEqual(d["fps"], [{"round": "1", "sender": A, "receiver": B, "sent": 8, "received": 9, "partial": False},
                                    {"round": "1", "sender": B, "receiver": A, "sent": 24, "received": 24, "partial": False}])
        self.assertEqual(d["height"], [])
        self.assertEqual(gr.worst_link(d), {"fps": {"sent": 8, "received": 9, "round": "1", "samples": 2, "partial": False}})
        self.assertEqual(d["receivedAboveSent"]["fps"], {"links": 1, "partialLinks": 0, "maxGap": 1, "maxGapWhole": 1})

    def test_a_phone_that_measured_part_of_the_round_is_kept_and_marked_partial(self):
        """Game 254: deedee.08 reloaded and its round 1 step lasted 13.6 s, so its medians cover a different stretch.
        Dropping such directions hid the survival link, so they stay, marked."""
        pair = "g254:r1:" + A + "~" + B
        row = lambda name, value: {"metric.name": name, "stat": "p50", "round": "1", "rtc.pair": pair, "p50(value)": value}
        step = lambda ms: {"span.op": "game.round.1", "span.duration": ms}
        C = "5" + "c" * 47
        pull = {A: {"linkPairs": [row("rtc.out_fps", 8)], "steps": [step(72000)]},
                B: {"linkPairs": [row("rtc.in_fps", 24)], "steps": [step(13600)]},
                C: {"steps": [step(72100)]}}
        full = gr.full_rounds(pull)
        self.assertEqual(full, {(A, "1"): True, (B, "1"): False, (C, "1"): True})
        d = gr.link_directions(pull, full)
        self.assertEqual(([x["partial"] for x in d["fps"]], d["partial"]["fps"]), ([True], 1))
        self.assertEqual(d["receivedAboveSent"]["fps"], {"links": 1, "partialLinks": 1, "maxGap": 16, "maxGapWhole": 0})
        self.assertFalse(gr.link_directions(pull)["fps"][0]["partial"])

    def test_a_phone_with_no_round_step_has_an_unknown_span_not_a_partial_one(self):
        pair = "g254:r1:" + A + "~" + B
        row = lambda name, value: {"metric.name": name, "stat": "p50", "round": "1", "rtc.pair": pair, "p50(value)": value}
        pull = {A: {"linkPairs": [row("rtc.out_fps", 24)], "steps": [{"span.op": "game.round.1", "span.duration": 72000}]},
                B: {"linkPairs": [row("rtc.in_fps", 24)], "steps": []}}
        d = gr.link_directions(pull, gr.full_rounds(pull))
        self.assertEqual((d["partial"]["fps"], d["spanUnknown"]["fps"], d["fps"][0].get("spanUnknown")), (0, 1, True))
        nobody = {A: {"linkPairs": [row("rtc.out_fps", 24)]}, B: {"linkPairs": [row("rtc.in_fps", 24)]}}
        d = gr.link_directions(nobody, gr.full_rounds(nobody))
        self.assertEqual((d["partial"]["fps"], d["spanUnknown"]["fps"]), (0, 0))

    def test_lowest_rates_line_keeps_partial_directions_and_splits_received_above_sent(self):
        video = {"worstLink": {"fps": {"sent": 8, "received": 9, "round": "1", "samples": 104, "partial": True}},
                 "pairing": {"partial": {"fps": 28, "height": 28},
                             "receivedAboveSent": {"fps": {"links": 7, "partialLinks": 4, "maxGap": 16, "maxGapWhole": 8},
                                                   "height": {"links": 2, "partialLinks": 2, "maxGap": 106, "maxGapWhole": 0}}}}
        line = next(l for l in gr._link_lines(video) if l.startswith("- Lowest rates"))
        self.assertIn("on the 104 link directions both phones reported (one phone sending to another in one round; 28 of them partly measured", line)
        self.assertIn("Received reads above sent on 7 frame-rate directions (4 partly measured; 3 over the whole round, by at most 8 frames per second) "
                      "and 2 picture-height directions (both partly measured).", line)

    def test_codec_kinds_count_only_link_samples_that_carried_video(self):
        """Game 254: 36 of 140 rtc.link rows were seats whose player never came; the unit is the Links one (104)."""
        rtt = lambda peer: {"metric.name": "rtc.rtt_ms", "stat": "p50", "round": "1", "rtc.peer": peer}
        kinds = gr.codec_kinds({A: {"metrics": [rtt("0")], "linkKinds": [{"round": "1", "rtc.peer": "0", "rtc.encoder_kind": "hardware"},
                                                                         {"round": "1", "rtc.peer": "1"}]}})
        self.assertEqual((kinds["samples"], kinds["samplesLabel"], kinds["encoding"]["hardware"]), (1, "1 link samples", 1))

    def test_coding_line_names_the_platform_that_reports(self):
        kinds = gr.codec_kinds({A: {"linkKinds": [{"round": "1", "rtc.peer": str(i), "rtc.encoder_kind": "hardware", "rtc.decoder_kind": "hardware"} for i in range(3)]},
                                B: {"linkKinds": [{"round": "1", "rtc.peer": str(i)} for i in range(7)]}}, {A: "Android 16", B: "iOS 18.7"})
        self.assertEqual(gr.coding_line(kinds), "- Hardware or software video coding: Android reported it on all 3 of its link samples "
                         "(3 hardware encoding and decoding, 0 software); iOS doesn't report it (7 link samples).")

    def test_a_link_that_switched_coder_mid_round_counts_as_mixed_in_any_order(self):
        rows = [{"round": "1", "rtc.peer": "0", "rtc.encoder_kind": "hardware", "rtc.decoder_kind": "hardware"},
                {"round": "1", "rtc.peer": "0", "rtc.encoder_kind": "software", "rtc.decoder_kind": "hardware"}]
        for order in (rows, rows[::-1]):
            kinds = gr.codec_kinds({A: {"linkKinds": order}}, {A: "Android 16"})
            self.assertEqual((kinds["samples"], kinds["encoding"]["mixed"], kinds["decoding"]["hardware"]), (1, 1, 1))

    def test_video_table_tails_and_worst_match_the_summary_figures(self):
        rows = [{"metric.name": "rtc.rtt_ms", "stat": "p50", "p50(value)": v} for v in range(1, 101)]
        rows += [{"metric.name": "rtc.freeze_ms", "stat": "total", "max(value)": 4000}]
        table = gr.video_table({A: {"metrics": rows}}, {"rttP95": 1149}, {"fps": [{"sent": s, "received": s} for s in range(1, 101)], "height": []})
        by = {r["metric"]: r for r in table}
        self.assertEqual((by["Video round-trip time"]["p50"], by["Video round-trip time"]["p95"], by["Video round-trip time"]["worst"]), (50, 95, 1149))
        self.assertEqual((by["Frames per second received"]["p75"], by["Frames per second received"]["p95"], by["Frames per second received"]["worst"]), (25, 5, 1))
        self.assertEqual((by["Frozen video per link sample"]["samples"], by["Frozen video per link sample"]["worst"]), (100, 4))

    def test_draw_cell_from_the_payoff_step_and_tags(self):
        step = {"steps": [{"span.op": "payoff.draw.show", "span.duration": 1000}]}
        self.assertEqual(gr.draw_row({**step, "payoff": {"draw.invited": "true", "draw.won": "true"}}), {"outcome": "won", "ms": None, "note": "in the draw"})
        self.assertEqual(gr.draw_row({**step, "payoff": {"draw.invited": "false"}}), {"outcome": "shown", "ms": None, "note": "not in the draw"})
        self.assertEqual(gr.draw_row({"steps": [], "payoff": {"draw.invited": "true"}})["outcome"], "not shown")
        self.assertIsNone(gr.draw_row({"steps": [], "payoff": {}}))

    def test_send_ladder_and_codec_kinds(self):
        rung = lambda low, full, lean: {"max_rung": str(low), "measurements.rtc.send.rung_full_s": full, "measurements.rtc.send.rung_lean_s": lean}
        ladder = gr.send_ladder({A: {"sendRungs": [rung(0, 70, 0), rung(1, 30, 40)]}, B: {"sendRungs": [rung(0, 72, 0)]}})
        self.assertEqual((ladder["senders"], ladder["steppedDown"], ladder["lowestRung"]), (2, 1, [{"rung": "lean", "senders": 1}]))
        self.assertEqual(ladder["secondsByRung"][:2], [{"rung": "full", "seconds": 172}, {"rung": "lean", "seconds": 40}])
        kinds = gr.codec_kinds({A: {"linkKinds": [{"round": "1", "rtc.peer": "0", "rtc.encoder_kind": "hardware", "rtc.decoder_kind": "software"}, {"round": "1", "rtc.peer": "1"}]}})
        self.assertEqual(kinds["encoding"], {"hardware": 1, "software": 0, "mixed": 0, "unsupported": 1})
        self.assertEqual(kinds["decoding"], {"hardware": 0, "software": 1, "mixed": 0, "unsupported": 1})

    def test_builds_raw_link_distributions_limits_and_recovery_signals(self):
        def metric(name, value, stat="p50", peer="b", reason=None):
            return {"metric.name": name, "stat": stat, "round": "1", "rtc.peer": peer,
                    "reason": reason, "p50(value)": value, "max(value)": value,
                    "count(value)": 1, "sum(value)": value}
        rows = [metric("rtc.rtt_ms", 42), metric("rtc.in_height", 180), metric("rtc.out_height", 360),
                metric("rtc.in_fps", 14), metric("rtc.out_fps", 30),
                metric("rtc.quality_limited_s", 3.5, "total", reason="bandwidth"),
                metric("rtc.heal_ms", 80, None), metric("rtc.freeze_ms", 2500, "total"),
                metric("rtc.encode_ms", 12, "p95"), metric("rtc.decode_ms", 8, "p95")]
        block = gr.adaptations_block({A: {"metrics": rows}},
            [{"id": A, "mode": "low power", "modeReason": "probe weak", "bot": None},
             {"id": B, "mode": "full", "modeReason": None, "bot": None}],
            {"pathCounts": {"relay": 1}, "connectionSamples": 1}, {A})
        self.assertEqual(block["lowPower"] | {"reasons": []},
                         {"players": 1, "scope": "joined players", "lowPower": 1, "full": 0, "unknown": 0, "reasons": []})
        self.assertEqual(block["lowPower"]["reasons"], [{"reason": "probe-weak", "players": 1}])
        self.assertEqual(block["picture"]["receivedHeight"], {"samples": 0, "buckets": []})  # no rtc.pair rows: no link seen from both phones
        self.assertEqual(block["qualityLimits"], {"links": 1, "limitedLinks": 1, "neverLimited": 0,
                                                   "reasons": [{"reason": "bandwidth", "links": 1, "senders": 1, "seconds": 3.5}]})
        self.assertEqual((block["signals"]["healEvents"], block["signals"]["freezeSeconds"],
                          block["signals"]["worstEncodeP95Ms"]), (1, 2.5, 12.0))


class DraftReportTextTest(unittest.TestCase):
    def test_deployed_app_hash_maps_to_release_label(self):
        self.assertEqual(gr._release_label({"players": [{"release": "246bcd99"}]}), "0.1.37")

    def test_release_hash_maps_to_semver_tag(self):
        completed = mock.Mock(returncode=0, stdout="v0.1.37\n", stderr="")
        with mock.patch.object(gr.subprocess, "run", return_value=completed):
            self.assertEqual(gr._release_label({"players": [{"release": "1b51bb0b"}]}), "0.1.37")

    def test_summary_carries_video_causes_and_omits_clock_agreement(self):
        account = "5" + "a" * 47
        stages = []
        for key in ("live", "registered", "joined", "played", "reported", "attested", "draw", "chest", "endscreen"):
            stages.append({"key": key, "count": 1, "accounts": [account], "dropped": []})
        doc = {
            "game": 254, "env": "dim2.paseo", "kickoff": "2026-10-15T11:55:00Z", "reportRelease": "0.1.37",
            "players": [{"id": account, "username": "player.01", "telemetryHealth": {}}], "funnel": stages,
            "funnelChatIdle": {"count": 0}, "reportWindow": {"label": "11:49 to 14:08 CEST"},
            "logCoverage": {"fullAccounts": [account]}, "coverage": {"coverage": 82.0},
            "coverageNote": "Where the missing 18 % goes:\n- Late open: 7.5 %. Two players opened the app late.\n- Other: 1.6 %. Short drops.",
            "video": {"pathCounts": {"stun": 1, "relay": 0, "direct": 0}}, "facts": [],
            "clockAgreement": {"medianSigmaMs": None, "worstSigmaMs": None, "groups": [{"round": 1, "group": 0,
                "sigmaMs": None, "pairs": [{"aName": "a", "bName": "b", "samplesAB": 5, "samplesBA": 4,
                    "medianDeltaABMs": None, "medianDeltaBAMs": None, "offsetMs": None, "uncertaintyMs": None}]}]},
            "knownPlatformErrors": {"bugs": [
                {"number": 76, "count": 1, "occurrences": [{"name": "player.01", "device": "iPhone", "host": "Nova", "hostBuild": "55", "release": "abc", "at": "17:20:40 CEST", "detail": "chain read/createTransaction"}]},
                {"number": 77, "count": 0, "occurrences": []}, {"number": 78, "count": 0, "occurrences": []}]},
        }
        gr.draft_report_text(doc)
        self.assertIn("\n**Video**\n- Coverage 82 %.\n- Late open: 7.5 %. Two players opened the app late.\n- Other: 1.6 %. Short drops.\n", doc["summary"])
        self.assertIn("\n\n**Players**\n- We picked up telemetry from 1 players during the game window; the counts below follow all of them.\n- 1 players → 1 used the app or signed up → 1 registered → 1 joined → 1 finished.\n", doc["summary"])
        self.assertNotIn("mechanical cause breakdown is in the video coverage box", doc["summary"])
        self.assertNotIn("**Clock agreement**", doc["summary"])
        self.assertNotIn("Round 1 group 0: n/a", doc["summary"])
        self.assertIn("pb#76 1", doc["summary"])
        self.assertIn("pb#77 0", doc["summary"])
        self.assertIn("platform-bugs #76 recurred (1)", [issue["title"] for issue in doc["issues"]])


class SignupCellTest(unittest.TestCase):
    REG = {"at": "2026-10-15T11:34:24.000Z", "route": "web", "call": "Game.sign_up_with_account"}

    def test_a_failed_chat_journey_on_a_registered_account_names_the_chain_registration(self):
        roots = [{"span.op": "journey.game-signup", "journey.outcome": "failed", "sdk.name": "jollity.chat-worker", "surface": "chat",
                  "timestamp": "2026-10-15T11:34:33+00:00", "span.duration": 241388}]
        cell = gr.signup_cell(roots, [], {"account": "x"}, self.REG, "no attempt")
        self.assertEqual(cell["outcome"], "failed")
        self.assertEqual(cell["surface"], "chat")
        self.assertEqual(cell["note"], "at 13:34; from the chat; registered on chain 13:34 CEST chain time (sign_up_with_account); success not observed")

    def test_a_broadcast_without_a_journey_is_an_attempt_and_a_later_app_broadcast_is_noted(self):
        cell = gr.signup_cell([], [{"title": "signup-broadcast", "timestamp": "2026-10-15T10:34:28+00:00"}], {"account": "x"}, None, "no attempt")
        self.assertEqual((cell["outcome"], cell["surface"], cell["note"]), ("broadcast", "app", "no sign-up journey; the app broadcast a sign-up at 12:34:28; registered on chain; success not observed"))
        roots = [{"span.op": "journey.game-signup", "journey.outcome": "failed", "surface": "chat", "timestamp": "2026-10-15T10:34:03+00:00"}]
        cell = gr.signup_cell(roots, [{"title": "signup-broadcast", "timestamp": "2026-10-15T10:34:28+00:00"}], None, None, "no attempt")
        self.assertIn("from the chat; the app broadcast a sign-up at 12:34:28", cell["note"])

    def test_a_landed_journey_followed_by_a_failed_retry_counts_as_success(self):
        roots = [{"span.op": "journey.game-signup", "journey.outcome": o, "host.kind": "ios", "timestamp": "2026-10-15T10:00:00+00:00"} for o in ("landed", "failed")]
        cell = gr.signup_cell(roots, [{"title": "signup-broadcast", "timestamp": "2026-10-15T10:00:01+00:00"}], {"account": "x"}, self.REG, "no attempt")
        self.assertEqual(cell["outcome"], "landed, then failed")
        self.assertNotIn("success not observed", cell["note"])
        self.assertNotIn("broadcast", cell["note"])

    def test_no_journey_names_the_chain_call_and_no_inferred_surface(self):
        cell = gr.signup_cell([], [], {"account": "x"}, self.REG, "no sign-up attempt in Sentry")
        self.assertEqual((cell["outcome"], cell["note"]), ("not seen", "no sign-up attempt in Sentry; registered on chain 13:34 CEST chain time (sign_up_with_account)"))

    def test_a_landed_app_journey_is_left_alone(self):
        roots = [{"span.op": "journey.game-signup", "journey.outcome": "landed", "host.kind": "ios", "timestamp": "2026-10-15T10:00:00+00:00"}]
        cell = gr.signup_cell(roots, [], {"account": "x"}, self.REG, "no attempt")
        self.assertEqual((cell["surface"], cell["note"]), ("app", "at 12:00; from the app"))


class UsernameHistoryTest(unittest.TestCase):
    def test_nameless_accounts_are_looked_up_over_30_days_and_the_most_used_name_wins(self):
        pull = {"players": {"5CaE": {"roots": []}, "5Named": {"roots": [{"user.username": "a.01"}]}, "5Mapped": {"roots": []}}}
        calls = []

        def rows(dataset, query, fields, **kw):
            calls.append((dataset, query, kw["start"], kw["end"]))
            return [{"user.id": "5CaE", "user.username": "old.01", "count()": 2}, {"user.id": "5CaE", "user.username": "msksym.01", "count()": 69}]

        with mock.patch.object(gr.sentry, "events_all", side_effect=rows):
            found = gr.history_usernames(pull, {"5Mapped": "m.01"}, "2026-10-15T12:08:00")
        self.assertEqual(found, {"5CaE": "msksym.01"})
        self.assertEqual({c[0] for c in calls}, {"spans", "errors", "logs", "tracemetrics"})
        self.assertEqual(calls[0][1], "user.id:[5CaE] has:user.username")
        self.assertEqual(calls[0][2], "2026-09-15T12:08:00")

    def test_history_reads_user_name_from_logs_and_metrics_and_username_from_events(self):
        pull = {"players": {"5Log": {"roots": []}, "5Metric": {"roots": []}, "5Event": {"roots": []}}}
        def rows(dataset, query, fields, **kw):
            if dataset == "logs":
                return [{"user.id": "5Log", "user.name": "log.01", "count()": 4}]
            if dataset == "tracemetrics":
                return [{"user.id": "5Metric", "user.name": "metric.01", "count(value)": 3}]
            return [{"user.id": "5Event", "user.username": "event.01", "count()": 2}]
        with mock.patch.object(gr.sentry, "events_all", side_effect=rows):
            found = gr.history_usernames(pull, {}, "2026-10-15T12:08:00")
        self.assertEqual(found, {"5Log": "log.01", "5Metric": "metric.01", "5Event": "event.01"})

    def test_one_history_dataset_failure_keeps_names_from_the_other_datasets(self):
        pull = {"players": {"5Log": {"roots": []}}}
        def rows(dataset, query, fields, **kw):
            if dataset == "spans":
                raise RuntimeError("spans unavailable")
            if dataset == "logs":
                return [{"user.id": "5Log", "user.name": "log.01", "count()": 1}]
            return []
        with mock.patch.object(gr.sentry, "events_all", side_effect=rows):
            self.assertEqual(gr.history_usernames(pull, {}, "2026-10-15T12:08:00"), {"5Log": "log.01"})

    def test_history_out_of_store_in_logs_and_metrics_only_skips_those_names(self):
        pull = {"players": {"5Event": {"roots": []}, "5Log": {"roots": []}}}
        def rows(dataset, query, fields, **kw):
            if dataset in ("logs", "tracemetrics"):
                raise gr.sentry.OutOfStore(f"{dataset} not in the store")
            return [{"user.id": "5Event", "user.username": "event.01", "count()": 2}]
        with mock.patch.object(gr.sentry, "events_all", side_effect=rows):
            self.assertEqual(gr.history_usernames(pull, {}, "2026-10-15T12:08:00"), {"5Event": "event.01"})

    def test_history_out_of_store_fails_closed(self):
        pull = {"players": {"5Log": {"roots": []}}}
        with mock.patch.object(
                gr.sentry, "events_all",
                side_effect=gr.sentry.OutOfStore("history unavailable")):
            with self.assertRaisesRegex(gr.sentry.OutOfStore, "history unavailable"):
                gr.history_usernames(pull, {}, "2026-10-15T12:08:00")

    def test_nameless_fact_says_chat_only_accounts_never_send_a_name(self):
        ctx = gr.Ctx(players=[{"id": "a", "username": None, "funnelStage": "had the DIM2 chat running but did nothing"},
                              {"id": "b", "username": None, "signup": {"surface": "chat"}},
                              {"id": "c", "username": None}, {"id": "d", "username": "d.01"}])
        [f] = gr.facts_nameless(ctx)
        self.assertEqual(f["text"], "3 accounts have no username: 2 only used the chat, whose worker never sends one; 1 sent no username in the window or the 30 days before it.")


class PlayerWaterfallTest(unittest.TestCase):
    def test_finished_counts_reporters_not_end_screen_telemetry(self):
        # g271's shape: 13 filed a report, payoff telemetry reached the end screen for 9 of them.
        counts = {"live": 24, "registered": 16, "joined": 14, "played": 13, "reported": 13, "attested": 13, "endscreen": 9}
        doc = {"players": [{}] * 48, "funnel": [{"key": k, "count": n} for k, n in counts.items()]}
        _, waterfall, losses = gr.player_waterfall(doc)
        self.assertEqual(waterfall, "- 48 players → 24 used the app or signed up → 16 registered → 14 joined → 13 finished.")
        self.assertEqual(losses, "- Where they dropped out: 8 didn't register, 2 registered but never joined, 1 joined but didn't finish.")


class PullGapsTest(unittest.TestCase):
    def test_failed_queries_become_a_summary_line_an_issue_and_lint_checks_them(self):
        pull = {"players": {"a": {"queryErrors": {"metrics": "HTTP 500"}}, "b": {"queryErrors": {"metrics": "HTTP 500"}}, "c": {}},
                "pullErrors": {"tagged accounts": "HTTP 502"}}
        gaps = gr.pull_gaps(pull)
        self.assertEqual(gaps, [{"query": "metrics", "players": ["a", "b"]}, {"query": "tagged accounts", "players": None}])
        self.assertEqual(gr.gap_line(gaps[0]), "- Gap: the metrics query failed for 2 players; their numbers are missing.")
        doc = {"pullGaps": gaps, "summary": "", "issues": []}
        errors = gr.report_lint.lint_report(doc)
        self.assertTrue(any("hides the failed metrics query" in e for e in errors))
        self.assertTrue(any("has no issue" in e for e in errors))


if __name__ == "__main__":
    unittest.main()


class NotificationFunnelTest(unittest.TestCase):
    def test_notification_rows_union_legacy_events_and_counter_metrics(self):
        def rows(dataset, query, fields, **kw):
            if dataset == "tracemetrics":
                metric = "chat.notif.permission" if "permission" in query else "chat.notif.book"
                group = {"outcome": "granted"} if "permission" in query else {"complete": "true"}
                return [{"user.id": "5Metric", "metric.name": metric, "sum(value)": 1, **group}]
            if dataset == "errors" and "chat.count:" in query:
                return [{"user.id": "5Legacy", "count()": 1}]
            return []
        with mock.patch.object(gr.sentry, "events_all", side_effect=rows), \
             mock.patch.object(gr.puller, "metric_groups", side_effect=lambda q, f, s, e: rows("tracemetrics", q, f)):
            found = gr.notification_rows("production", "start", "end")
        self.assertEqual({r["user.id"] for r in found["permission"]}, {"5Legacy", "5Metric"})
        self.assertEqual({r["user.id"] for r in found["book"]}, {"5Legacy", "5Metric"})

    def test_notification_query_failures_are_isolated_and_recorded(self):
        def rows(dataset, query, fields, **kw):
            if dataset == "spans" or (dataset == "tracemetrics" and "permission" in query):
                raise RuntimeError(dataset + " unavailable")
            if dataset == "errors" and "chat.count:" not in query:
                return [{"user.id": "5Legacy"}]
            if dataset == "tracemetrics":
                return [{"user.id": "5Metric", "metric.name": "chat.start", "sum(value)": 1}]
            return []
        with mock.patch.object(gr.sentry, "events_all", side_effect=rows), \
             mock.patch.object(gr.puller, "metric_groups", side_effect=lambda q, f, s, e: rows("tracemetrics", q, f)):
            found = gr.notification_rows("production", "start", "end")
        self.assertEqual({row["user.id"] for row in found["chat"]}, {"5Legacy", "5Metric"})
        self.assertEqual(set(found["queryErrors"]), {"chat spans", "chat permission metrics"})
    KICKOFF = datetime.datetime(2026, 11, 3, 13, 0, tzinfo=datetime.timezone.utc)

    def host_event(self, name, device, minutes_before=1, product="dim2.paseo", platform="ios"):
        at = (self.KICKOFF - datetime.timedelta(minutes=minutes_before)).timestamp() * 1000
        return {"title": f"host.reminder.{name}", "user": device, "product_id": product, "starts_at_unix_ms": at, "platform": platform}

    def test_host_reminder_counts_window_product_and_distinct_devices(self):
        ev = [self.host_event("fired", "phone-1"), self.host_event("fired", "phone-1"), self.host_event("fired", "phone-2"),
              self.host_event("fired", "phone-3", minutes_before=30),                 # reminder for an earlier game
              self.host_event("fired", "phone-4", minutes_before=10),                 # edge of the window, kept
              self.host_event("fired", "phone-5", product="dim2.other"),
              self.host_event("tapped", "phone-1", product=None), self.host_event("product_opened", "phone-2", product=None),
              self.host_event("scheduled", "phone-1"), self.host_event("scheduled", "phone-6")]
        c = gr.host_reminder_counts(ev, self.KICKOFF, "dim2.paseo")
        self.assertEqual((c["scheduled"], c["fired"], c["tapped"], c["opened"]), (2, 3, 1, 1))
        self.assertEqual(c["firedAt"], self.KICKOFF - datetime.timedelta(minutes=10))

    def test_host_reminder_counts_split_platforms_and_book_on_any_event(self):
        ev = [self.host_event("fired", "ios-1"), self.host_event("scheduled", "ios-2"),           # a fired-only device is booked
              self.host_event("fired", "and-1", platform="android"), self.host_event("tapped", "and-1", platform="android"),
              self.host_event("product_opened", "and-2", platform="android"),
              self.host_event("fired", "same", platform="android"), self.host_event("fired", "same")]  # one id on both hosts = two phones
        c = gr.host_reminder_counts(ev, self.KICKOFF, "dim2.paseo")
        self.assertEqual((c["booked"], c["bookedIos"], c["bookedAndroid"]), (6, 3, 3))
        self.assertEqual((c["fired"], c["firedIos"], c["firedAndroid"]), (4, 2, 2))

    def test_shown_stage_is_measured_with_host_events_and_unmeasured_without(self):
        rows = {"chat": [], "permission": [], "book": []}
        host = gr.host_reminder_counts([self.host_event("fired", "phone-1"), self.host_event("tapped", "phone-1")], self.KICKOFF, "dim2.paseo")
        shown = {s["key"]: s for s in gr.notification_funnel(rows, set(), set(), {}, host=host)["steps"]}["shown"]
        self.assertEqual((shown["count"], shown["measured"]), (1, True))
        self.assertEqual((shown["count"], shown["label"]), (1, "Game reminder booked on the phone (host)"))
        self.assertIn("Booked on 1 phone (iOS 1, Android 0). Went off at 13:59 CET on 1 (Android 0, iOS 1; iOS only records it while the Polkadot app is running, so the iOS figure is a floor); 1 tapped it and 0 had the game opened", shown["note"])
        self.assertNotIn("is not measured", gr.notification_funnel(rows, set(), set(), {}, host=host)["window"])
        n = gr.notification_funnel(rows, set(), set(), {}, host=gr.host_reminder_counts([], self.KICKOFF, "dim2.paseo"))
        zero = {s["key"]: s for s in n["steps"]}["shown"]
        self.assertEqual((zero["count"], zero["measured"]), (0, True))
        old = {s["key"]: s for s in gr.notification_funnel(rows, set(), set(), {})["steps"]}["shown"]
        self.assertEqual(old, {"key": "shown", "label": "Notification shown on the phone", "count": None, "measured": False,
                               "note": "Not measured: no signal tells us a notification appeared"})
        self.assertIsNone(gr.host_reminder_counts(None, self.KICKOFF, "dim2.paseo"))

    def rows(self):
        U = lambda c: "5" + c * 47
        a, b, c, d, e = U("a"), U("b"), U("c"), U("d"), U("e")
        return (a, b, c, d, e), {
            "chat": [{"user.id": x} for x in (a, b, c, d, e)] + [{"user.id": None}, {}],
            "permission": [{"user.id": a, "outcome": "granted"}, {"user.id": b, "outcome": "not-granted"}, {"user.id": c, "outcome": "granted"},
                           {"user.id": d, "outcome": "not-granted"}, {"user.id": None, "outcome": "granted"}],
            "book": [{"user.id": a, "complete": "true"}, {"user.id": b, "complete": "true"}, {"user.id": c, "complete": "false"},
                     {"user.id": e, "complete": "true"}, {"user.id": None, "complete": "true"}]}

    def test_a_failed_or_timed_out_request_is_counted_apart_from_not_granted(self):
        (a, b, c, d, e), rows = self.rows()
        rows["permission"] += [{"user.id": e, "outcome": "failed", "error_class": "TypeError"}]
        n = gr.notification_funnel(rows, {a}, {a}, {})
        by = {s["key"]: s for s in n["steps"]}
        self.assertEqual(by["granted"]["note"], "2 not granted: declined or notifications off; 1 more: the permission request failed or timed out")
        self.assertEqual(n["sideCounts"]["permissionFailed"], 1)
        self.assertEqual(n["sideCounts"]["permissionUnknown"], 0)
        self.assertEqual(n["sideCounts"]["bookedAllFailed"], 1)

    def test_the_granted_note_does_not_count_failures_when_nobody_was_asked(self):
        n = gr.notification_funnel({"chat": [{"user.id": "5" + "a" * 47}], "permission": [], "book": []}, set(), set(), {})
        by = {s["key"]: s for s in n["steps"]}
        self.assertEqual(by["granted"]["note"], "No phone was asked for permission in the window")

    def g259(self):
        # game 259: 24 running, 20 asked, 8 granted; 9 booked all (8 granted + 1 timed out), 14 refused (11 asked not granted, 3 did not ask), 1 never tried
        U = lambda i: f"5{i:03d}" * 12
        ids = [U(i) for i in range(24)]
        granted, timed, declined, silent = ids[:8], ids[8], ids[9:20], ids[20:23]
        never = ids[23]
        # 20 asked = 8 granted + 1 timed out + 11 declined; the 3 that did not ask are ids[20:23]
        rows = {"chat": [{"user.id": x} for x in ids],
                "permission": [{"user.id": x, "outcome": "granted"} for x in granted] + [{"user.id": timed, "outcome": "timed-out"}]
                              + [{"user.id": x, "outcome": "not-granted"} for x in declined],
                "book": [{"user.id": x, "complete": "true"} for x in granted + [timed]]
                        + [{"user.id": x, "complete": "false"} for x in declined + silent]}
        return rows, never

    def test_side_text_counts_on_the_tables_own_basis(self):
        rows, _ = self.g259()
        n = gr.notification_funnel(rows, set(), set(), {})
        by = {s["key"]: s["count"] for s in n["steps"]}
        self.assertEqual((by["chatRunning"], by["asked"], by["granted"], by["grantedBooked"]), (24, 20, 8, 8))
        self.assertEqual(n["side"], "Reminders: 23 of the 24 accounts tried to book them (1 never did). "
                                    "The 9 that booked every reminder are the 8 with permission granted plus 1 whose permission request timed out. "
                                    "The 14 with a booking refused are 11 whose permission was checked but wasn't granted and 3 with no permission check during the window.")
        c = n["sideCounts"]
        self.assertEqual((c["triedToBook"], c["fullyBooked"], c["refused"], c["neverTried"]), (23, 9, 14, 1))
        self.assertEqual(c["bookedAllGranted"] + c["bookedAllDeclined"] + c["bookedAllFailed"] + c["bookedAllDidNotAsk"], c["fullyBooked"])
        self.assertEqual(c["refusedAskedNotGranted"] + c["refusedFailed"] + c["refusedDidNotAsk"] + c["refusedGranted"], c["refused"])
        asked_not_granted = by["asked"] - by["granted"]  # the table's asked minus granted, failed or timed-out included
        self.assertEqual(c["refusedAskedNotGranted"] + c["refusedFailed"] + c["bookedAllDeclined"] + c["bookedAllFailed"], asked_not_granted)
        self.assertEqual((c["refusedAskedNotGranted"], c["refusedDidNotAsk"], c["refusedGranted"], c["bookedAllFailed"]), (11, 3, 0, 1))

    def test_side_text_flags_granted_refusals_and_silent_bookers(self):
        U = lambda i: f"6{i:03d}" * 12
        g, s, r = U(1), U(2), U(3)
        rows = {"chat": [], "permission": [{"user.id": g, "outcome": "granted"}, {"user.id": r, "outcome": "granted"}],
                "book": [{"user.id": g, "complete": "true"}, {"user.id": s, "complete": "true"}, {"user.id": r, "complete": "false"}]}
        n = gr.notification_funnel(rows, set(), set(), {})
        self.assertEqual(n["side"], "Reminders: all 3 accounts tried to book them. The 2 that booked every reminder are the 1 with permission granted plus 1 with no permission check. "
                                    "The 1 with a booking refused is 1 that was granted.")

    def test_side_text_wording_for_zero_and_none_booked(self):
        self.assertEqual(gr.notification_funnel({}, set(), set(), {})["side"], "Reminders: no account tried to book them.")
        U = "7" * 48
        rows = {"chat": [], "permission": [{"user.id": U, "outcome": "not-granted"}], "book": [{"user.id": U, "complete": "false"}]}
        n = gr.notification_funnel(rows, set(), set(), {})
        self.assertEqual(n["side"], "Reminders: the 1 account tried to book them. None booked every reminder. The 1 with a booking refused is 1 whose permission was checked but wasn't granted.")

    def test_book_query_does_not_request_the_permission_tag(self):
        calls = []
        orig = gr.sentry.events_all
        gr.sentry.events_all = lambda ds, q, fields, **kw: calls.append((q, fields)) or []
        try:
            with mock.patch.object(gr.puller, "metric_groups", side_effect=lambda q, f, s, e: calls.append((q, f)) or []):
                gr.notification_rows("previewnet", "s", "e")
        finally:
            gr.sentry.events_all = orig
        book = [f for q, f in calls if "chat.notif.book" in q]
        self.assertEqual(book, [["user.id", "complete", "count()"],
                                ["user.id", "user.name", "metric.name", "complete", "count(value)", "sum(value)"]])
        self.assertTrue(all("outcome" not in fields for fields in book))

    def test_a_chat_account_outside_the_game_is_not_counted(self):
        (a, b, c, d, e), rows = self.rows()
        out = "5" + "z" * 47
        rows["chat"].append({"user.id": out})
        rows["permission"].append({"user.id": out, "outcome": "granted"})
        rows["book"].append({"user.id": out, "complete": "true"})
        n = gr.notification_funnel(rows, {a}, {a}, {}, players={a, b, c, d, e})
        self.assertEqual([s["count"] for s in n["steps"]][:4], [5, 4, 2, 1])
        self.assertNotIn(out, sum((s.get("accounts", []) for s in n["steps"]), []))
        self.assertIn("5 of the game's 5 accounts had the DIM2 chat running", n["window"])
        self.assertEqual(n["sideCounts"]["triedToBook"], 4)

    def test_steps_side_and_dropped_rows_without_a_user(self):
        (a, b, c, d, e), rows = self.rows()
        names = {a: "ann.01", b: "bob.01", c: "cy.01", d: "dee.01", e: None}
        n = gr.notification_funnel(rows, {a, b}, {a}, {
            "from": "2026-10-16T14:08:00+00:00", "to": "2026-10-19T14:18:00+00:00",
            "openedAt": "16:08", "closedAt": "16:18",
        }, players=names)
        by = {s["key"]: s for s in n["steps"]}
        self.assertEqual([s["count"] for s in n["steps"]], [5, 4, 2, 1, None, 1, 1])
        self.assertEqual(by["asked"]["note"],
                         "1 had no check in the window; likely the chat was already running from before it")
        self.assertEqual(by["asked"]["label"], "Chat checked notification permission")
        self.assertEqual(by["granted"]["label"], "Permission granted, now or earlier")
        self.assertEqual(by["asked"]["details"], [{
            "account": e,
            "label": "one without a username",
            "reason": "no permission check in the window; likely the chat was already running from before it",
        }])
        self.assertIn("2 not granted", by["granted"]["note"])
        self.assertEqual(by["grantedBooked"]["note"], "1 had permission and all reminders booked. 1 more had all reminders booked but no permission check during the game window, so we don't know whether they could.")
        self.assertEqual(by["shown"]["measured"], False)
        self.assertEqual(by["registered"]["label"], "Of those 1: registered for the game")
        self.assertIsInstance(n["window"], str)
        self.assertIsInstance(n["side"], str)
        self.assertTrue(n["window"].startswith("Game window: registration opened Fri 16 Oct 16:08 to Mon 19 Oct 16:18 CEST, ending 10 minutes after settlement. 5 of the game's 5 accounts had the DIM2 chat running."))
        self.assertIn("A permission check shows a prompt only the first time on a phone; after that the host answers silently.", n["window"])
        self.assertEqual(n["side"], "Reminders: 4 of the 5 accounts tried to book them (1 never did). The 3 that booked every reminder are the 1 with permission granted plus 1 whose permission was checked but wasn't granted plus 1 with no permission check. "
                                    "The 1 with a booking refused is 1 that was granted.")
        self.assertEqual((n["windowFrom"], n["windowTo"]),
                         ("2026-10-16T14:08:00+00:00", "2026-10-19T14:18:00+00:00"))

    def test_report_window_label_includes_dates_when_it_spans_days(self):
        self.assertEqual(
            gr.local_window_label(gr.parse_ts("2026-10-16T14:08:00Z"), gr.parse_ts("2026-10-19T14:18:00Z")),
            "Fri 16 Oct 16:08 to Mon 19 Oct 16:18 CEST",
        )


class StorylineTest(unittest.TestCase):
    WIN = (gr.parse_ts("2026-10-15T09:00:00Z"), gr.parse_ts("2026-10-15T12:00:00Z"))
    SETTLE = "2026-10-15T11:20:00Z"

    @staticmethod
    def root(op, ts, outcome=None, **kw):
        r = {"span.op": op, "timestamp": ts, "journey.outcome": outcome, "span.duration": 10, "environment": "dim2.paseo", "game.index": "9"}
        if not op.startswith("chat."):
            r["host.kind"] = "android"
        return {**r, **kw}

    def chain(self, groups):
        return {"record": {"gameDate": 1792058400, "rounds": len(groups[0]), "maxGroupSize": 2},
                "kickoff": "2026-10-15T11:00:00Z", "settlement": {"time": self.SETTLE},
                "accounts": [{"account": a, "groups": g, "sentReport": True, "reportTime": "2026-10-15T11:10:00Z", "attended": True,
                              "registeredAt": "2026-10-14T18:00:00Z", "registrationCall": "Game.sign_up_with_account"}
                             for a, g in zip((A, B, C, D), groups)]}

    def windows(self):
        return gr.ReportWindows(gr.parse_ts("2026-10-14T17:00:00Z"), self.WIN[0], self.WIN[1])

    def test_events_of_one_player_in_time_order(self):
        R = self.root
        p = {"roots": [R("journey.payoff", "2026-10-15T11:21:00Z", "shown", **{"span.duration": 4000}),
                       R("journey.game", "2026-10-15T11:05:00Z", "completed", **{"span.duration": 150000}),
                       R("journey.join", "2026-10-15T11:00:00Z", "full"),
                       R("journey.game-signup", "2026-10-14T18:30:00Z", "failed"),
                       R("journey.app-open", "2026-10-15T10:00:00Z", "ok"),
                       R("chat.poll.duration_ms", "2026-10-15T09:30:00Z")],
             "steps": [{"span.op": "chest.show", "timestamp": "2026-10-15T11:20:40Z"},
                       {"span.op": "payoff.draw.show", "timestamp": "2026-10-15T11:20:30Z"}]}
        chain_row = {"sentReport": True, "reportTime": "2026-10-15T11:10:00Z", "attended": True}

        events = gr.storyline_events(p, chain_row, {"at": "2026-10-14T18:00:00Z"}, self.WIN)
        pages = gr.storyline_pages(p)

        self.assertEqual([e["key"] for e in events], ["registered", "join", "reported"])
        self.assertEqual(next(e for e in events if e["key"] == "join")["outcome"], "full")
        self.assertEqual(pages, {"pages": ["draw", "chest", "endscreen"],
                                 "lastPage": {"key": "endscreen", "at": gr.parse_ts("2026-10-15T11:21:04Z").isoformat()}})

    @staticmethod
    def point(name, ts, session="s1", value=1.0, **kw):
        return {"metric.name": name, "timestamp": ts, "session.id": session, "value": value, **kw}

    def test_on_screen_runs_from_an_open_or_a_return_to_the_next_hide_or_the_last_journey(self):
        R, P = self.root, self.point
        p = {"roots": [R("journey.app-open", "2026-10-15T10:00:00Z", "ready", **{"session.id": "s1", "wall.time.start": "1792058400000", "wall.time.end": "1792058400500"}),
                       R("journey.game", "2026-10-15T10:01:00Z", "completed", **{"session.id": "s1", "span.duration": 300000}),
                       R("network.turn-receipt", "2026-10-15T10:20:00Z", **{"session.id": "s1", "span.duration": 60000}),
                       R("journey.home-first-status", "2026-10-15T10:30:00Z", "shown", **{"session.id": "s2"}),
                       R("chat.poll.duration_ms", "2026-10-15T09:00:00Z", **{"session.id": "s3", "span.duration": 9000000})],
             "foreground": [P("app.away_ms", "2026-10-15T10:03:00Z", value=60000.0, **{"app.return_source": "other"}),
                            P("app.away_ms", "2026-10-15T10:31:00Z", session="s2", value=20000.0, **{"app.return_source": "other"})]}

        screen = gr.storyline_screen(p)

        self.assertEqual(screen, [
            {"from": "2026-10-15T10:00:00+00:00", "to": "2026-10-15T10:02:00+00:00", "start": "open", "end": "away"},
            {"from": "2026-10-15T10:03:00+00:00", "to": "2026-10-15T10:06:00+00:00", "start": "return", "end": "lastJourney"}])
        self.assertIsNone(gr.storyline_screen({"roots": p["roots"]}))
        self.assertEqual(gr.storyline_screen({"roots": p["roots"][3:], "foreground": []}), [])

    def test_two_sessions_on_screen_at_once_give_one_stretch(self):
        # Given
        R = self.root
        p = {"roots": [R("journey.app-open", "2026-10-15T10:00:00Z", "ready", **{"session.id": "s1", "wall.time.start": "1792058400000", "wall.time.end": "1792058400500"}),
                       R("journey.game", "2026-10-15T10:01:00Z", "completed", **{"session.id": "s1", "span.duration": 300000}),
                       R("journey.app-open", "2026-10-15T10:04:00Z", "ready", **{"session.id": "s2", "wall.time.start": "1792058640000", "wall.time.end": "1792058640500"}),
                       R("journey.game", "2026-10-15T10:04:30Z", "completed", **{"session.id": "s2", "span.duration": 300000})],
             "foreground": []}

        # When
        screen = gr.storyline_screen(p)

        # Then
        self.assertEqual(screen, [
            {"from": "2026-10-15T10:00:00+00:00", "to": "2026-10-15T10:09:30+00:00", "start": "open", "end": "lastJourney"}])

    def test_notifications_are_the_taps_that_opened_or_brought_back_the_app(self):
        P = self.point
        p = {"foreground": [P("app.away_ms", "2026-10-15T10:40:00Z", value=5000.0, **{"app.return_source": "notification", "notification.moment": "start-5m"}),
                            P("app.away_ms", "2026-10-15T10:30:00Z", value=5000.0, **{"app.return_source": "other"}),
                            P("app.opened_from_notification", "2026-10-15T09:00:00Z", **{"app.return_source": "notification"})]}

        self.assertEqual(gr.storyline_notifications(p), [
            {"at": "2026-10-15T09:00:00+00:00", "how": "opened", "kind": "push"},
            {"at": "2026-10-15T10:40:00+00:00", "how": "returned", "kind": "push", "moment": "start-5m"}])

    def test_expected_notices_are_the_host_alarm_and_its_calendar_alert(self):
        kickoff = "2026-10-15T11:00:00Z"
        moments = lambda registered: [(n["at"][11:19], n["moment"], n["kind"]) for n in gr.storyline_expected_notices(registered, kickoff)]

        self.assertEqual(moments("2026-10-14T18:00:00Z"), [("10:54:00", "calendar", "calendar"), ("10:59:00", "host-alarm", "alarm")])
        self.assertEqual(moments("2026-10-15T10:00:00Z"), [("10:59:00", "host-alarm", "alarm")])
        self.assertEqual(moments("2026-10-15T10:48:00Z"), [("10:59:00", "host-alarm", "alarm")])
        self.assertEqual(moments("2026-10-15T10:59:30Z"), [])
        self.assertEqual(gr.storyline_expected_notices(None, kickoff), [])

    def test_the_last_round_ends_at_its_first_report_when_one_lands_before_the_schedule_end(self):
        rounds = [{"round": 1, "from": "2026-10-15T11:00:00+00:00", "to": "2026-10-15T11:01:12+00:00", "groups": [[A, B]]},
                  {"round": 2, "from": "2026-10-15T11:01:19+00:00", "to": "2026-10-15T11:02:31+00:00", "groups": [[A], [B]]}]
        chain = {"accounts": [{"account": A, "sentReport": True, "reportTime": "2026-10-15T11:02:28Z"},
                              {"account": B, "sentReport": True, "reportTime": "2026-10-15T11:02:24Z"},
                              {"account": C, "sentReport": True, "reportTime": "2026-10-15T11:01:00Z"}]}

        gr.last_round_ends_at_first_report(rounds, chain)

        self.assertEqual((rounds[1]["to"], rounds[1].get("toFromReport")), ("2026-10-15T11:02:24+00:00", True))
        self.assertNotIn("toFromReport", rounds[0])
        late = [{"round": 1, "from": "2026-10-15T11:00:00+00:00", "to": "2026-10-15T11:01:12+00:00", "groups": [[A]]}]
        gr.last_round_ends_at_first_report(late, {"accounts": [{"account": A, "sentReport": True, "reportTime": "2026-10-15T11:03:00Z"}]})
        self.assertEqual((late[0]["to"], late[0].get("toFromReport")), ("2026-10-15T11:01:12+00:00", None))

    def test_storyline_rows_carry_the_taps_and_the_stretches_on_screen(self):
        R = self.root
        pull = {"players": {A: {"roots": [R("journey.app-open", "2026-10-15T10:58:00Z", "ready", **{"session.id": "s1"})],
                                "foreground": [self.point("app.opened_from_notification", "2026-10-15T10:58:00Z")]},
                            B: {"roots": []}}}
        s = gr.storyline(pull, self.chain([[0, 0], [0, 0], [1, 1], [1, 1]]), {}, self.windows(), [], {A, B})
        rows = {p["id"]: p for p in s["players"]}

        self.assertEqual(rows[A]["notifications"], [{"at": "2026-10-15T10:58:00+00:00", "how": "opened", "kind": "push"}])
        self.assertEqual([st["start"] for st in rows[A]["onScreen"]], ["open"])
        self.assertNotIn("notifications", rows[B])
        self.assertNotIn("onScreen", rows[B])

    def test_last_page_is_the_last_screen_reached_at_its_first_showing(self):
        R = self.root
        p = {"roots": [R("journey.humanity", "2026-10-15T11:25:00Z"),
                       R("journey.humanity", "2026-10-15T11:28:00Z"),
                       R("journey.home-first-status", "2026-10-15T11:26:00Z", **{"span.duration": 2500}),
                       R("journey.app-open", "2026-10-15T11:30:00Z")],
             "steps": [{"span.op": "chest.show", "timestamp": "2026-10-15T11:20:40Z"}],
             "pageEnds": [{"timestamp": "2026-10-15T11:26:01Z"}]}

        pages = gr.storyline_pages(p)

        self.assertEqual(pages, {"pages": ["chest", "humanity"],
                                 "lastPage": {"key": "humanity", "at": gr.parse_ts("2026-10-15T11:25:00Z").isoformat(),
                                              "label": "pocket/open?product=peopl.paseo",
                                              "link": "pocket/open?product=peopl.paseo&card=humanity"}})

    def test_humanity_end_names_the_link_the_app_opened(self):
        # Given
        def last(**root):
            return gr.storyline_pages({"roots": [self.root("journey.humanity", "2026-10-15T11:25:00Z", "requested", **root)]})["lastPage"]

        # When
        ios, desktop = last(**{"host.kind": "ios"}), last(**{"host.kind": "desktop", "environment": "dim2.test"})
        gateway, browser = last(environment="dim2.dotapps.io"), last(**{"host.kind": "browser", "environment": "local"})

        # Then
        self.assertEqual((ios["label"], ios["link"]), ("pocket/open?product=peopl.paseo", "pocket/open?product=peopl.paseo&card=humanity"))
        self.assertEqual((desktop["label"], desktop["link"]), ("peopl.test", "peopl.test"))
        self.assertEqual(gateway["link"], "pocket/open?product=peopl.dot&card=humanity")
        self.assertEqual(browser["link"], "peopl.paseo")

    def test_humanity_end_keeps_its_name_without_the_host_kind_or_the_environment(self):
        for missing in ({"host.kind": None}, {"environment": None}, {"environment": "unknown"}):
            root = self.root("journey.humanity", "2026-10-15T11:25:00Z", "requested", **missing)

            last = gr.storyline_pages({"roots": [root]})["lastPage"]

            self.assertEqual(set(last), {"key", "at"}, missing)

    def test_no_payoff_screen_gives_no_page(self):
        p = {"roots": [], "steps": []}
        events = gr.storyline_events(p, None, {"at": "2026-10-14T18:00:00Z"}, self.WIN)
        self.assertEqual([e["key"] for e in events], ["registered"])
        self.assertEqual(gr.storyline_pages(p), {"pages": []})

    def test_events_outside_the_window_are_left_out(self):
        p = {"roots": [self.root("journey.join", "2026-10-15T08:00:00Z", "full")]}
        events = gr.storyline_events(p, None, None, self.WIN)
        self.assertNotIn("join", [e["key"] for e in events])

    def test_storyline_bundles_groups_per_round(self):
        chain = self.chain([[0, 0], [0, 1], [1, 1], [1, 0]])
        pull = {"players": {a: {"roots": [self.root("chat.poll.duration_ms", "2026-10-15T09:30:00Z")]} for a in (D, C, B, A)}}
        names = {A: "zed.01", B: "amy.01", C: "kim.01", D: "bob.01"}
        play = gr.play_windows(chain["record"])

        s = gr.storyline(pull, chain, names, self.windows(), play, {A, B, C})

        self.assertEqual(s["rounds"][0]["groups"], [[A, B], [C]])
        self.assertEqual(s["rounds"][1]["groups"], [[A], [B, C]])
        self.assertEqual([(gr.parse_ts(r["from"]).timestamp() * 1000, gr.parse_ts(r["to"]).timestamp() * 1000) for r in s["rounds"]], play)
        self.assertEqual([p["id"] for p in s["players"]], [A, B, C, D])
        self.assertEqual([m["key"] for m in s["marks"]], ["kickoff", "settlement"])
        self.assertIn("phases", s)

    def phase_chain(self):
        chain = self.chain([[0], [0]])
        chain["registrationOpens"] = "2026-10-14T17:00:00Z"
        chain["record"].update({"registrationEnds": 1792061850, "shuffleDeadline": 1792061970, "reportEnds": 1792062300})
        return chain

    def test_phases_follow_the_chain_record(self):
        chain = self.phase_chain()
        at = lambda iso: gr.parse_ts(iso).isoformat()

        phases = gr.storyline_phases(chain, self.windows())

        self.assertEqual([(p["key"], p["label"], p["from"], p["to"]) for p in phases], [
            ("registration", "Registration", at("2026-10-14T17:00:00Z"), at("2026-10-15T10:57:30Z")),
            ("shuffle", "Shuffle", at("2026-10-15T10:57:30Z"), at("2026-10-15T10:59:30Z")),
            ("reporting", "Reporting", at("2026-10-15T10:59:30Z"), at(self.SETTLE)),
            ("playerProcess", "Player Process", at(self.SETTLE), self.WIN[1].isoformat())])
        self.assertEqual([p.get("open") for p in phases], [None, None, None, True])
        self.assertEqual([(p.get("toIsDeadline"), p.get("fromIsDeadline")) for p in phases],
                         [(None, None), (True, None), (None, True), (None, None)])

    def test_phases_leave_out_what_the_chain_lacks(self):
        keys = lambda chain: [p["key"] for p in gr.storyline_phases(chain, self.windows())]
        no_opens = self.phase_chain()
        del no_opens["registrationOpens"]
        no_shuffle = self.phase_chain()
        del no_shuffle["record"]["shuffleDeadline"]
        no_settle = self.phase_chain()
        del no_settle["settlement"]

        reporting = next(p for p in gr.storyline_phases(no_settle, self.windows()) if p["key"] == "reporting")

        self.assertEqual(keys(no_opens), ["shuffle", "reporting", "playerProcess"])
        self.assertEqual(keys(no_shuffle), ["registration", "playerProcess"])
        self.assertNotIn("playerProcess", keys(no_settle))
        self.assertEqual(reporting["to"], gr.parse_ts("2026-10-15T11:05:00Z").isoformat())

    def test_storyline_puts_unseated_players_by_name_and_bots_last(self):
        chain = self.chain([[0], [0]])
        extra = {"5" + c * 47: c for c in "XYZ"}
        chain["accounts"] += [{"account": a, "groups": [], "registeredAt": "2026-10-14T19:00:00Z",
                               "registrationCall": "Game.sign_up_with_account"} for a in extra]
        pull = {"players": {**{a: {} for a in (A, B)}, **{a: {"bot": c == "X"} for a, c in extra.items()}}}
        names = {A: "zed.01", B: "amy.01", **{a: f"{c.lower()}.01" for a, c in extra.items()}}
        x, y, z = extra

        s = gr.storyline(pull, chain, names, self.windows(), gr.play_windows(chain["record"]), {A, B})

        self.assertEqual([p["id"] for p in s["players"]], [A, B, y, z, x])

    def test_storyline_leaves_out_accounts_that_never_registered(self):
        chain = self.chain([[0], [0]])
        chat_only = "5" + "Q" * 47
        pull = {"players": {a: {"roots": [self.root("chat.poll.duration_ms", "2026-10-15T09:30:00Z")]} for a in (A, B, chat_only)}}

        s = gr.storyline(pull, chain, {}, self.windows(), gr.play_windows(chain["record"]), {A, B})

        self.assertEqual([p["id"] for p in s["players"]], [A, B])

    def test_storyline_keeps_a_chain_account_the_reader_could_not_date(self):
        chain = self.chain([[0], [0], [0]])
        chain["accounts"][1].update({"registeredAt": None, "registrationCall": None, "reportTime": None})
        chain["accounts"][2].update({"sentReport": False, "reportTime": None})
        pull = {"players": {A: {}, B: {}, C: {}}}

        s = gr.storyline(pull, chain, {}, self.windows(), gr.play_windows(chain["record"]), {A, B, C})

        undated = next(p for p in s["players"] if p["id"] == B)
        self.assertEqual(undated["events"], [])
        self.assertTrue(undated["reportUndated"])
        self.assertNotIn("reportUndated", next(p for p in s["players"] if p["id"] == A))
        self.assertNotIn("reportUndated", next(p for p in s["players"] if p["id"] == C))

    def test_payoff_screens_follow_the_funnel_predicates(self):
        p = {"roots": [], "steps": [{"span.op": "chest.show"}, {"span.op": "payoff.draw.show", "timestamp": "2026-10-15T11:20:30Z"}]}

        pages = gr.storyline_pages(p)

        self.assertEqual(pages, {"pages": ["draw"], "lastPage": {"key": "draw", "at": gr.parse_ts("2026-10-15T11:20:30Z").isoformat()}})

    def test_storyline_flags_payoff_screens_it_cannot_date(self):
        chain = self.chain([[0], [0]])
        pull = {"players": {A: {"steps": [{"span.op": "chest.show"}]},
                            B: {"steps": [{"span.op": "chest.show"}, {"span.op": "payoff.draw.show", "timestamp": "2026-10-15T11:20:30Z"}]}}}

        s = gr.storyline(pull, chain, {}, self.windows(), gr.play_windows(chain["record"]), {A, B})

        by = {p["id"]: p for p in s["players"]}
        self.assertEqual((by[A]["screensUndated"], by[A]["pages"], by[A].get("lastPage")), (["chest"], [], None))
        self.assertEqual((by[B]["screensUndated"], by[B]["pages"], by[B]["lastPage"]["key"]), (["chest"], ["draw"], "draw"))

    def test_storyline_note_says_what_went_wrong_from_the_join_and_the_funnel(self):
        chain = self.chain([[0], [0], [0]])
        pull = {"players": {A: {"roots": [self.root("journey.join", "2026-10-15T10:01:10Z", "late")]},
                            B: {"roots": [self.root("journey.join", "2026-10-15T09:59:00Z", "partial")]},
                            C: {"roots": [self.root("journey.join", "2026-10-15T09:59:00Z", "full")]}}}
        drops = {A: ("attested", "report attested", "not attested: 2 for, 7 against"),
                 B: ("played", "played every round", "unknown")}

        s = gr.storyline(pull, chain, {}, self.windows(), gr.play_windows(chain["record"]), {A, B, C}, drops)

        note = {p["id"]: p.get("note") for p in s["players"]}
        self.assertEqual(note[A], "joined 70 s late, not attested: 2 for, 7 against")
        self.assertEqual(note[B], "partial join, no completed game journey")
        self.assertIsNone(note[C])

    def test_storyline_note_keeps_the_funnel_reason_of_a_player_who_never_joined(self):
        self.assertEqual(gr.storyline_note([], ("joined", "joined the game", "last app activity 09:39 CET, before kickoff"), None),
                         "never joined: last app activity 09:39 CET, before kickoff")
        self.assertEqual(gr.storyline_note([], ("reported", "report on chain", "no report on chain"), None), "no report on chain")
        self.assertEqual(gr.storyline_note([], ("attested", "report attested", "unknown"), None), "missed report attested")
        self.assertIsNone(gr.storyline_note([{"key": "join", "at": "2026-10-15T11:00:00Z", "outcome": "full"}], None, None))

    def test_storyline_without_a_chain_is_none(self):
        self.assertIsNone(gr.storyline({"players": {A: {}}}, None, {}, self.windows(), [], set()))
        self.assertIsNone(gr.storyline({"players": {A: {}}}, self.chain([[0]]), {}, None, [], set()))

    def test_reminders_fired_mark_needs_a_host_measure(self):
        s = {"marks": [{"key": "kickoff", "at": "2026-10-15T11:00:00+00:00"}], "players": []}

        gr.attach_reminders_fired(s, None)
        gr.attach_reminders_fired(s, {"firedAt": None})

        self.assertEqual([m["key"] for m in s["marks"]], ["kickoff"])
        fired = datetime.datetime(2026, 10, 15, 10, 50, tzinfo=datetime.timezone.utc)
        gr.attach_reminders_fired(s, {"firedAt": fired})
        self.assertEqual([m["key"] for m in s["marks"]], ["remindersFired", "kickoff"])
        self.assertEqual(s["marks"][0]["at"], fired.isoformat())
