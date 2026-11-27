import importlib.util
import os
import unittest


HERE = os.path.dirname(__file__)
spec = importlib.util.spec_from_file_location("report_lint", os.path.join(HERE, "report-lint.py"))
rl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rl)


def report():
    accounts = [f"account-{n}" for n in range(29)]
    live = accounts[:21]
    registered = accounts[:18]
    summary = """Game 254 on dim2.paseo, kickoff 13:55 CEST, release 0.1.37.

**Players**
- We picked up telemetry from 29 players during the game window; 8 had only the DIM2 chat running and didn't register or use the app, so the counts below follow the 21 who did.
- 29 players → 21 used the app or signed up → 18 registered → 14 joined → 14 finished.
- Where they dropped out: 3 didn't register, 4 registered but never joined.

**Telemetry**
- 14 of 14 reporters have their complete end-of-game log in Sentry.

**Video**
- Coverage 82 %.

**Links**
- How links connected: STUN 29, TURN 24, Direct 5.
- Packets lost: typical pair 0 %, worst pair 41.9 % (at its worst moments).
- The browser's own encoder lowered the video of 3 senders because their upload bandwidth was short (the browser's built-in limit, separate from our upload ladder below), 12 s in total across their links; none for the processor.

**Performance adaptations**
- 2 of the 14 players ran in low power mode: 2 because the device check found the phone slow.
- Picture height in pixels, on the same 58 link directions as under Links: received 58 at 360; sent 58 at 360.
- Frames per second, on the same 0 link directions: received not measured; sent not measured.
"""
    return {
        "summary": summary,
        "players": [{"id": account} for account in accounts],
        "reportWindow": {"from": "2026-10-15T09:49:24+00:00", "to": "2026-10-15T12:08:00+00:00", "label": "sign-ups from registration opening 11:49, everything else from 11:59 (10 minutes after the previous game's settlement) to 14:08 CEST (10 minutes after settlement)"},
        "stageDeadlines": {"registered": "2026-10-15T11:52:30+00:00"},
        "funnel": [
            {"key": "live", "stage": "entered from the app, chat sign-up, or chain (sign-ups from registration opening 11:49, everything else from 11:59 (10 minutes after the previous game's settlement) to 14:08 CEST (10 minutes after settlement))",
             "count": 21, "accounts": live, "dropped": [], "split": {"openedApp": 17, "chatSignup": 3, "onChainOnly": 1},
             "splitLabels": {"openedApp": "Opened the app (SPA)", "chatSignup": "Signed up from the chat without opening the app", "onChainOnly": "On chain only, no sign-up or app telemetry"}},
            {"key": "registered", "stage": "registered on chain", "count": 18, "accounts": registered, "dropped": [],
             "note": "Counted from the chain's registrations for this game."},
            *[{"key": key, "count": 14, "accounts": accounts[:14], "dropped": []}
              for key in ("joined", "played", "reported", "attested", "draw", "chest", "endscreen")],
        ],
        "funnelTable": {"entryTotal": 21, "intro": "We picked up telemetry from 29 players during the game window; 8 had only the DIM2 chat running and didn't register or use the app; the table follows the 21 who did.",
                        "entries": [{"key": "openedApp", "count": 17, "accounts": live[:17]},
                                    {"key": "chatSignup", "count": 3, "accounts": live[17:20]},
                                    {"key": "onChainOnly", "count": 1, "accounts": live[20:21]}],
                        "rows": [{"key": "registered", "count": 18,
                                  "sources": [{"key": "openedApp", "count": 15}, {"key": "chatSignup", "count": 2}, {"key": "onChainOnly", "count": 1}]}],
                        "side": {"count": 8, "accounts": accounts[21:]}},
        "funnelChatIdle": {"count": 8, "accounts": accounts[21:]},
        "video": {"pathCounts": {"stun": 29, "relay": 24, "direct": 5}, "lossP50": 0.0, "lossP95": 41.9, "rttP95": 1149,
                  "limitedSenders": [{"reason": "bandwidth", "name": "player-simonl-65", "seconds": 12}],
                  "table": [{"metric": "Packets lost", "worst": 41.9}, {"metric": "Video round-trip time", "worst": 1149}]},
        "adaptations": {"lowPower": {"players": 14, "scope": "joined players", "lowPower": 2, "full": 12, "unknown": 0,
                                      "reasons": [{"reason": "probe-weak", "players": 2}]},
                        "qualityLimits": {"links": 58, "limitedLinks": 3, "neverLimited": 55,
                                          "reasons": [{"reason": "bandwidth", "links": 3, "senders": 3, "seconds": 12.0}]},
                        "picture": {"receivedHeight": {"samples": 58, "buckets": [{"label": "360 px", "count": 58}]},
                                    "sentHeight": {"samples": 58, "buckets": [{"label": "360 px", "count": 58}]}},
                        "signals": {"turnLinks": 24, "connectionSamples": 58}},
        "coverage": {"coverage": 82.0, "measured": 52},
        "notificationFunnel": {"windowFrom": "2026-10-15T09:49:24+00:00", "windowTo": "2026-10-15T12:08:00+00:00",
                               "steps": [{"key": "asked", "count": 22, "accounts": accounts[:22]}]},
    }


def storyline_of(doc):
    keys = {row["key"]: set(row["accounts"]) for row in doc["funnel"] if row["key"] in ("registered", *rl.STORYLINE_MARK_KEYS)}
    players = []
    for minute, player in enumerate(doc["players"]):
        account = player["id"]
        at = lambda second: f"2026-10-15T11:{minute:02d}:{second:02d}+00:00"
        events = [{"key": key, "at": at(second)} for second, key in enumerate(("registered", "reported")) if account in keys.get(key, ())]
        screens = [key for key in ("draw", "chest", "endscreen", "humanity") if account in keys.get(key, ())]
        last = {"lastPage": {"key": screens[-1], "at": at(10 + len(screens))}} if screens else {}
        players.append({"id": account, "username": None, "bot": False, "events": events, "pages": screens, **last,
                        "notifications": [{"at": at(1), "how": "opened", "kind": "push"}],
                        "expectedNotices": [{"at": at(3), "moment": "calendar", "kind": "calendar"}, {"at": at(4), "moment": "host-alarm", "kind": "alarm"}],
                        "onScreen": [{"from": at(2), "to": at(5), "start": "open", "end": "away"},
                                     {"from": at(7), "to": at(9), "start": "return", "end": "lastJourney"}]})
    return {"from": "2026-10-15T09:49:24+00:00", "to": "2026-10-15T12:08:00+00:00", "marks": [],
            "rounds": [{"round": 1, "from": "2026-10-15T11:00:00+00:00", "to": "2026-10-15T11:01:12+00:00",
                        "groups": [[p["id"] for p in players[:6]]]}],
            "phases": [{"key": "shuffle", "label": "Shuffle", "from": "2026-10-15T10:57:30+00:00", "to": "2026-10-15T10:59:30+00:00"},
                       {"key": "reporting", "label": "Reporting", "from": "2026-10-15T10:59:30+00:00", "to": "2026-10-15T11:03:00+00:00"}],
            "players": players}


class ReportLintTest(unittest.TestCase):
    def test_valid_report(self):
        self.assertEqual(rl.lint_report(report()), [])

    def test_finished_follows_the_reported_stage_not_the_end_screen(self):
        # g271's shape: every reporter counts as finished even when end-screen telemetry is short.
        doc = report()
        end = next(row for row in doc["funnel"] if row["key"] == "endscreen")
        end["count"], end["accounts"] = 9, end["accounts"][:9]
        self.assertEqual(rl.lint_report(doc), [])
        next(row for row in doc["funnel"] if row["key"] == "reported")["count"] = 13
        self.assertTrue(any("waterfall does not agree" in error for error in rl.lint_report(doc)))

    def test_storyline_must_agree_with_the_funnel(self):
        doc = report()
        doc["storyline"] = storyline_of(doc)
        self.assertEqual(rl.lint_report(doc), [])
        del doc["storyline"]["players"][0]
        self.assertTrue(any("storyline registered accounts disagree with the funnel" in error for error in rl.lint_report(doc)))

    def test_storyline_must_carry_every_mark_the_funnel_lists(self):
        for key in ("reported", "draw", "chest", "endscreen", "humanity"):
            with self.subTest(key=key):
                doc = report()
                if not any(row["key"] == key for row in doc["funnel"]):
                    doc["funnel"].append({**doc["funnel"][-1], "key": key})
                doc["storyline"] = storyline_of(doc)
                self.assertEqual(rl.lint_report(doc), [])
                account = next(row for row in doc["funnel"] if row["key"] == key)["accounts"][0]
                player = next(p for p in doc["storyline"]["players"] if p["id"] == account)
                player["pages"] = [page for page in player["pages"] if page != key]
                player["events"] = [e for e in player["events"] if e["key"] != key]

                self.assertIn(f"storyline {key} accounts disagree with the funnel", rl.lint_report(doc))

    def test_storyline_rows_the_reader_could_not_date_pass(self):
        doc = report()
        doc["storyline"] = storyline_of(doc)
        player = doc["storyline"]["players"][0]
        self.assertTrue(player["pages"])
        player["screensUndated"] = player["pages"]
        player["events"], player["pages"] = [], []
        del player["lastPage"]
        player["reportUndated"] = True
        self.assertEqual(rl.lint_report(doc), [])

    def test_storyline_pages_must_name_the_funnel_screens(self):
        doc = report()
        doc["storyline"] = storyline_of(doc)
        player = next(p for p in doc["storyline"]["players"] if p["pages"])
        player["pages"].pop(0)
        self.assertTrue(any("accounts disagree with the funnel" in error for error in rl.lint_report(doc)))

    def test_storyline_link_belongs_to_the_humanity_hand_off(self):
        doc = report()
        doc["storyline"] = storyline_of(doc)
        player = next(p for p in doc["storyline"]["players"] if p.get("lastPage"))
        hand_off = {"at": player["lastPage"]["at"], "key": "humanity", "label": "pocket/open?product=peopl.paseo",
                    "link": "pocket/open?product=peopl.paseo&card=humanity"}
        error = f"storyline last page of {player['id']} names a link that is not its Humanity hand-off"
        for broken, expected in (({}, False), ({"key": "chest"}, True), ({"label": "peopl.test"}, True), ({"link": None}, True)):
            with self.subTest(broken=broken):
                player["lastPage"] = {**hand_off, **broken}
                player["pages"] = [page for page in player["pages"] if page != player["lastPage"]["key"]] + [player["lastPage"]["key"]]

                self.assertEqual(error in rl.lint_report(doc), expected)

    def test_storyline_last_page_is_the_last_of_its_pages(self):
        doc = report()
        doc["storyline"] = storyline_of(doc)
        player = next(p for p in doc["storyline"]["players"] if len(p["pages"]) > 1)
        bare = next(p for p in doc["storyline"]["players"] if not p["pages"])
        error = f"storyline last page of {player['id']} disagrees with its pages"
        last = player["lastPage"]
        self.assertEqual(rl.lint_report(doc), [])
        player["lastPage"] = {**last, "key": player["pages"][0]}
        self.assertIn(error, rl.lint_report(doc))
        player["lastPage"] = {**last, "at": None}
        self.assertIn(error, rl.lint_report(doc))
        del player["lastPage"]
        self.assertIn(error, rl.lint_report(doc))
        player["lastPage"] = last
        bare["lastPage"] = last
        self.assertEqual(rl.lint_report(doc), [f"storyline last page of {bare['id']} disagrees with its pages"])

    def test_storyline_on_screen_stretches_are_in_order_and_apart(self):
        doc = report()
        doc["storyline"] = storyline_of(doc)
        player = doc["storyline"]["players"][0]
        error = f"storyline on-screen stretches of {player['id']} are not in time order or overlap"
        first, second = player["onScreen"]
        self.assertEqual(rl.lint_report(doc), [])
        player["onScreen"] = [second, first]
        self.assertIn(error, rl.lint_report(doc))
        player["onScreen"] = [{**first, "to": first["from"]}]
        self.assertIn(error, rl.lint_report(doc))
        player["onScreen"] = [first, {**second, "from": first["from"]}]
        self.assertIn(error, rl.lint_report(doc))
        player["onScreen"] = [{**first, "to": None}]
        self.assertIn(error, rl.lint_report(doc))

    def test_storyline_notifications_are_dated_taps_in_order(self):
        doc = report()
        doc["storyline"] = storyline_of(doc)
        player = doc["storyline"]["players"][0]
        error = f"storyline notifications of {player['id']} are undated, out of order or not a tap"
        tap = player["notifications"][0]
        later = {**tap, "at": player["onScreen"][1]["to"], "how": "returned"}
        player["notifications"] = [tap, later]
        self.assertEqual(rl.lint_report(doc), [])
        player["notifications"] = [later, tap]
        self.assertIn(error, rl.lint_report(doc))
        player["notifications"] = [{**tap, "at": None}]
        self.assertIn(error, rl.lint_report(doc))
        player["notifications"] = [{**tap, "how": "delivered"}]
        self.assertIn(error, rl.lint_report(doc))

    def test_storyline_expected_notices_are_dated_in_order_and_of_a_known_kind(self):
        doc = report()
        doc["storyline"] = storyline_of(doc)
        player = doc["storyline"]["players"][0]
        error = f"storyline expected notices of {player['id']} are undated, out of order or of no known kind"
        calendar, alarm = player["expectedNotices"]
        self.assertEqual(rl.lint_report(doc), [])
        player["expectedNotices"] = [alarm, calendar]
        self.assertIn(error, rl.lint_report(doc))
        player["expectedNotices"] = [{**calendar, "at": None}]
        self.assertIn(error, rl.lint_report(doc))
        player["expectedNotices"] = [{**calendar, "kind": "pill"}]
        self.assertIn(error, rl.lint_report(doc))

    def test_storyline_rounds_name_only_its_rows(self):
        doc = report()
        doc["storyline"] = storyline_of(doc)
        doc["storyline"]["rounds"][0]["groups"].append(["stranger"])
        self.assertIn("storyline round 1 names an account with no row", rl.lint_report(doc))

    def test_storyline_rounds_name_only_joined_accounts(self):
        doc = report()
        doc["storyline"] = storyline_of(doc)
        doc["storyline"]["rounds"][0]["groups"].append(["account-15"])
        self.assertEqual(rl.lint_report(doc), ["storyline round 1 names an account that did not join"])

    def test_storyline_events_run_in_time_order(self):
        doc = report()
        doc["storyline"] = storyline_of(doc)
        doc["storyline"]["players"][0]["events"].reverse()
        self.assertIn("storyline events of account-0 are not in time order", rl.lint_report(doc))

    def test_storyline_phases_run_in_time_order(self):
        doc = report()
        doc["storyline"] = storyline_of(doc)
        self.assertEqual(rl.lint_report(doc), [])
        phases = doc["storyline"]["phases"]
        phases.reverse()
        self.assertIn("storyline phases are not in time order", rl.lint_report(doc))
        phases.reverse()
        phases[0]["to"] = "2026-10-15T10:57:00+00:00"
        self.assertIn("storyline phase shuffle ends before it starts", rl.lint_report(doc))
        phases[0]["to"] = phases[0]["from"]
        self.assertEqual(rl.lint_report(doc), [])

    def test_a_report_without_a_storyline_passes(self):
        doc = report()
        self.assertNotIn("storyline", doc)
        self.assertEqual(rl.lint_report(doc), [])

    def test_storyline_of_sixty_players_fits_the_cap(self):
        doc = report()
        story_players = [{"id": "5" + f"{n:02d}" * 23 + "x", "username": f"player.{n:02d}", "bot": False,
                          "events": [{"key": "registered", "at": f"2026-10-15T11:{n:02d}:00+00:00"},
                                     {"key": "join", "at": f"2026-10-15T11:{n:02d}:01+00:00", "outcome": "full"},
                                     {"key": "reported", "at": f"2026-10-15T11:{n:02d}:02+00:00"}],
                          "pages": ["draw", "chest", "endscreen", "humanity"],
                          "lastPage": {"key": "humanity", "at": f"2026-10-15T11:{n:02d}:06+00:00"}}
                         for n in range(60)]
        doc["storyline"] = {"from": "2026-10-15T09:49:24+00:00", "to": "2026-10-15T12:08:00+00:00", "marks": [],
                            "rounds": [], "players": story_players}
        self.assertLess(rl.serialized_bytes(doc) - rl.serialized_bytes(report()), 60 * 1024)
        self.assertEqual(rl.lint_publish_documents(("g1", doc)), [])

    def test_trimmed_publish_report_uses_chat_only_count_for_the_total(self):
        doc = report()
        doc["players"] = doc["players"][:21]
        doc["chatOnlyCount"] = 8
        doc.pop("funnelChatIdle")
        self.assertEqual(rl.lint_report(doc), [])

    def test_catches_internal_adaptation_wording(self):
        doc = report()
        doc["summary"] += "- Senders limited by WebRTC: bandwidth 3.\n"
        self.assertTrue(any("internal wording" in error for error in rl.lint_report(doc)))

    def test_catches_cut_reason(self):
        doc = report()
        doc["funnel"][1]["dropped"] = [{"account": "x", "reason": "Polkadot app request timed out afte"}]
        self.assertTrue(any("truncated" in error for error in rl.lint_report(doc)))

    def test_catches_29_vs_18_summary_confusion(self):
        doc = report()
        doc["summary"] = doc["summary"].replace("→ 21 used the app", "→ 18 used the app")
        self.assertTrue(any("player waterfall" in error for error in rl.lint_report(doc)))

    def test_catches_losses_that_do_not_add_up_and_the_retired_phrasing(self):
        doc = report()
        doc["summary"] = doc["summary"].replace("3 didn't register", "2 didn't register").replace(
            "4 registered but never joined.", "4 registered but never joined. 8 more only had the chat running.").replace("8 had only", "7 had only")
        errors = rl.lint_report(doc)
        self.assertTrue(any("losses add up" in error for error in errors))
        self.assertTrue(any("retired" in error for error in errors))
        self.assertTrue(any("Players intro" in error for error in errors))

    def test_catches_old_nested_shape_and_missing_blank_line(self):
        doc = report()
        doc["summary"] = doc["summary"].replace("\n\n**Telemetry**\n", "\n**Telemetry**\n  - nested\n")
        errors = rl.lint_report(doc)
        self.assertTrue(any("blank line" in error for error in errors))
        self.assertTrue(any("nested-bullet" in error for error in errors))

    def test_catches_two_loss_figures_for_the_worst_pair_and_named_bandwidth_senders(self):
        doc = report()
        doc["summary"] = doc["summary"].replace("typical pair 0 %, worst pair 41.9 % (at its worst moments)",
                                                "0 % typically and 0 % for the worst pair, with 41.9 % at that pair's worst moments").replace(
            "12 s in total across their links", "12 s in total across their links: player-simonl-65 12 s").replace("separate from our upload ladder below", "a limit")
        errors = rl.lint_report(doc)
        self.assertTrue(any("two packet-loss figures" in error for error in errors))
        self.assertTrue(any("names senders" in error for error in errors))
        self.assertTrue(any("not the upload ladder" in error for error in errors))

    def test_table_worst_must_be_the_summary_figure(self):
        doc = report()
        doc["video"]["table"][1]["worst"] = 900
        self.assertTrue(any("Worst for Video round-trip time" in error for error in rl.lint_report(doc)))

    def test_funnel_intro_counts_every_player(self):
        doc = report()
        doc["funnelTable"]["intro"] = doc["funnelTable"]["intro"].replace("from 29", "from 21")
        self.assertTrue(any("intro" in error for error in rl.lint_report(doc)))

    def test_catches_funnel_table_partition_and_registered_source_mismatch(self):
        doc = report()
        doc["funnelTable"]["entries"][0]["count"] = 16
        doc["funnelTable"]["rows"][0]["sources"][0]["count"] = 14
        errors = rl.lint_report(doc)
        self.assertTrue(any("entry rows" in error for error in errors))
        self.assertTrue(any("registered sources" in error for error in errors))

    def test_catches_obsolete_seven_day_window(self):
        doc = report()
        doc["funnel"][0]["stage"] += " (7 days before kickoff)"
        self.assertTrue(any("7-day" in error for error in rl.lint_report(doc)))

    def test_catches_missing_links(self):
        doc = report()
        doc["summary"] = doc["summary"].replace("**Links**", "**Network**")
        self.assertTrue(any("missing or out of order" in error for error in rl.lint_report(doc)))

    def test_catches_58_vs_52_path_wording(self):
        doc = report()
        doc["summary"] = doc["summary"].replace("STUN 29, TURN 24, Direct 5", "STUN 26, TURN 21, Direct 5")
        self.assertTrue(any("link-path counts" in error for error in rl.lint_report(doc)))

    def test_catches_adaptation_count_disagreement(self):
        doc = report()
        doc["adaptations"]["lowPower"]["full"] = 26
        doc["adaptations"]["picture"]["receivedHeight"]["buckets"][0]["count"] = 57
        errors = rl.lint_report(doc)
        self.assertTrue(any("low-power mode counts" in error for error in errors))
        self.assertTrue(any("receivedHeight buckets" in error for error in errors))

    def test_catches_wrong_joined_scope_and_independent_turn_count(self):
        doc = report()
        doc["adaptations"]["lowPower"]["players"] = 29
        doc["adaptations"]["lowPower"]["full"] = 27
        doc["adaptations"]["signals"]["turnLinks"] = 22
        errors = rl.lint_report(doc)
        self.assertTrue(any("population" in error for error in errors))
        self.assertTrue(any("TURN counts" in error for error in errors))

    def test_rejects_cause_after_deadline_but_allows_later_context(self):
        doc = report()
        doc["funnel"][1]["dropped"] = [{"account": "x", "reason": "request timed out at 14:01 CEST"}]
        self.assertTrue(any("after its deadline" in error for error in rl.lint_report(doc)))
        doc["funnel"][1]["dropped"][0]["reason"] += ", later context that does not explain the drop"
        self.assertFalse(any("after its deadline" in error for error in rl.lint_report(doc)))

    def test_multiday_reason_compares_the_full_local_timestamp(self):
        doc = report()
        doc["stageDeadlines"]["registered"] = "2026-10-19T14:05:00+00:00"
        doc["funnel"][1]["dropped"] = [{"account": "x", "reason": "last app activity Sat 17 Oct 18:20 CEST, before kickoff"}]
        self.assertFalse(any("after its deadline" in error for error in rl.lint_report(doc)))

        doc["funnel"][1]["dropped"][0]["reason"] = "last app activity Mon 19 Oct 18:20 CEST, before kickoff"
        self.assertTrue(any("after its deadline" in error for error in rl.lint_report(doc)))

    def test_publish_document_size_is_fail_closed_with_headroom(self):
        small = {"data": "x" * 100}
        large = {"data": "x" * rl.PUBLISH_DOCUMENT_MAX_BYTES}
        self.assertEqual(rl.lint_publish_documents(("small", small)), [])
        self.assertTrue(any("above" in error for error in rl.lint_publish_documents(("large", large))))

    def test_rejects_impossible_video_timing_and_viewer_language(self):
        doc = report()
        doc["coverage"]["causes"] = [{
            "cause": "Page reloaded mid-round",
            "items": [{"round": 1, "cov": 0.1, "lostS": 46.0, "reloadS": 45.0, "connectS": 46.0}],
        }]
        doc["coverageNote"] = "- Page reloaded mid-round: 8.0 %. They reloaded 45 s into round 1 and first saw the peer in their own view; four pairs lost 46 s before that."
        errors = rl.lint_report(doc)
        self.assertTrue(any("viewer-perspective" in error for error in errors))
        self.assertTrue(any("elapsed round time" in error for error in errors))
        doc["coverageNote"] = "- Page reloaded mid-round: 8.0 %. Video came up about 46 s into round 1; four pairs lost 46 s before that."
        errors = rl.lint_report(doc)
        self.assertFalse(any("viewer-perspective" in error or "elapsed round time" in error for error in errors))

    def test_rejects_the_two_g254_timing_regressions(self):
        doc = report()
        doc["coverage"]["causes"] = [{
            "cause": "Late open",
            "items": [{"round": 1, "who": "a", "backS": 54.4, "cov": 0.2, "lostS": 57.4}],
        }]
        doc["coverageNote"] = "- Late open: 7.5 %. Video came up about 54 s into round 1 (four pairs lost 56 to 57 s each before that)."
        self.assertTrue(any("elapsed round time" in error for error in rl.lint_report(doc)))

        doc["coverage"]["causes"] = [{
            "cause": "App in the background",
            "items": [
                {"round": 1, "who": "a", "backS": 1.1, "cov": 0.95, "lostS": 2.9},
                {"round": 1, "who": "b", "backS": 3.4, "cov": 0.86, "lostS": 7.7},
            ],
        }]
        doc["coverageNote"] = "- App in the background: 0.7 %. Two players had the app in the background. Video came back about 1.1 s into round 1; their two pairs lost 2.9 to 7.7 s each before that."
        errors = rl.lint_report(doc)
        self.assertTrue(any("elapsed round time" in error for error in errors))
        self.assertTrue(any("distinct player video times" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
