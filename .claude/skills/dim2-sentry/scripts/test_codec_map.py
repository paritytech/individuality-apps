"""Tests for codec-map.py on synthetic Sentry rows.  python3 -m unittest test_codec_map -v"""
import importlib.util
import os
import re
import unittest

spec = importlib.util.spec_from_file_location("codec_map", os.path.join(os.path.dirname(__file__), "codec-map.py"))
cm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cm)

A, B, C = ("5" + c * 47 for c in "ABC")
PAIR_AB = f"g9:r1:{A}~{B}"
PAIR_AC = f"g9:r1:{A}~{C}"
ANDROID = {"device.os": "android", "device.os_version": "14", "device.engine": "chromium-webview", "device.engine_version": "154", "host.app": "Polkadot", "host.app_version": "1.4.2"}
IPHONE = {"device.os": "ios", "device.os_version": "18.6.2"}


def row(pair, user, ctx, **attrs):
    return {"rtc.pair": pair, "user.id": user, **ctx, **attrs}


class Helpers(unittest.TestCase):
    def test_h264_profile(self):
        self.assertEqual(cm.h264_profile("packetization-mode=1;profile-level-id=42e01f"), "CB")
        self.assertEqual(cm.h264_profile("profile-level-id=42001f"), "B")
        self.assertEqual(cm.h264_profile("profile-level-id=4d001f"), "M")
        self.assertEqual(cm.h264_profile("profile-level-id=640c1f"), "CH")
        self.assertEqual(cm.h264_profile("profile-level-id=64001f"), "H")
        self.assertIsNone(cm.h264_profile(None))

    def test_codec_label(self):
        self.assertEqual(cm.codec_label("H264", "profile-level-id=42e01f"), "H264/CB")
        self.assertEqual(cm.codec_label("VP8"), "VP8")
        self.assertIsNone(cm.codec_label("unsupported"))

    def test_context_label(self):
        self.assertEqual(cm.context_label(ANDROID), "android 14 chromium-webview 154")
        self.assertEqual(cm.context_label(ANDROID, by_host=True), "android 14 chromium-webview 154 [Polkadot 1.4.2]")
        # iOS: no engine tag on older builds, WebKit inferred; the OS version keeps major.minor
        self.assertEqual(cm.context_label(IPHONE), "ios 18.6 webkit")
        self.assertEqual(cm.context_label(None), "unknown")
        self.assertEqual(cm.context_label({"device.os": "ios", "device.os_version": "16_0"}), "ios 16.0 webkit")

    def test_peer_of(self):
        self.assertEqual(cm.peer_of(PAIR_AB, A), B)
        self.assertEqual(cm.peer_of(PAIR_AB, B), A)
        self.assertIsNone(cm.peer_of(PAIR_AB, C))


class Kinds(unittest.TestCase):
    def test_end_kind(self):
        k = cm.end_kind
        self.assertEqual(k("ExternalDecoder", "software"), "sw")
        self.assertEqual(k("libvpx", "hardware"), "sw")  # a known software name beats an emitted kind
        # pre-fix builds called OMX.google.* hardware by its prefix
        self.assertEqual(k("OMX.google.h264.decoder", "hardware"), "sw")
        self.assertEqual(k("OMX.google.h264.decoder", "hardware", "true"), "hw")  # the efficient flag is the authority
        self.assertEqual(k("VideoToolbox", "hardware", "false"), "sw")
        self.assertEqual(k("OMX.google.h264.decoder", "hardware", "unsupported"), "sw")
        self.assertEqual(k("NdkVideoEncodeAccelerator", "hardware"), "hw")
        for name in ("VideoToolbox", "ExternalEncoder (MediaCodecVideoEncoder)", "NdkVideoEncodeAccelerator", "c2.qti.avc.decoder", "OMX.qcom.video.decoder.avc", "D3D11VideoDecoder", "VaapiVideoDecoder", "V4L2VideoDecoder", "MediaFoundationVideoEncodeAccelerator", "NVDEC", "OMX.SEC.avc.dec", "OMX.SEC.avc.enc"):
            self.assertEqual(k(name), "hw", name)
        for name in ("libvpx", "FFmpeg (fallback from: ExternalDecoder (MediaCodecVideoDecoder))", "OpenH264", "libaom", "dav1d", "SVT-AV1"):
            self.assertEqual(k(name), "sw", name)
        for name in ("OMX.google.h264.decoder", "OMX.SEC.avc.sw.dec", "OMX.SEC.avc.sw.enc", "c2.android.avc.decoder", "c2.google.avc.encoder"):
            self.assertEqual(k(name), "sw", name)
        self.assertEqual(k(None), "?")
        self.assertEqual(k("SimulcastEncoderAdapter"), "?")
        self.assertEqual(k("unsupported"), "n/r")
        self.assertEqual(k(None, "unsupported"), "n/r")
        self.assertEqual(k("VideoToolbox", "unsupported"), "hw")

    def test_kind_mix(self):
        self.assertEqual(cm.kind_mix(["hw"] * 9 + ["sw"] + ["?"] * 3), "HW 9 · SW 1 · ? 3")
        self.assertEqual(cm.kind_mix(["n/r", "n/r"]), "n/r 2")
        self.assertEqual(cm.kind_mix([]), "?")


class Assemble(unittest.TestCase):
    def test_a_new_row_is_the_receiver_side_and_its_sender_is_read_off_the_peer(self):
        pulled = {
            "link": [
                row(PAIR_AB, A, ANDROID, **{"rtc.outcome": "video", "rtc.codec_in": "H264", "rtc.codec_in_fmtp": "profile-level-id=640c1f"}),
                row(PAIR_AB, B, IPHONE, **{"rtc.outcome": "connected-no-video", "rtc.last_stage": "connected", "rtc.codec_in": "H264", "rtc.codec_in_fmtp": "profile-level-id=42e01f"}),
            ],
            "ttff": [row(PAIR_AB, A, {}, value=1500)],
            "freeze": [row(PAIR_AB, A, {}, value=300), row(PAIR_AB, B, {}, value=0)],
        }
        ends = {e["receiver"]: e for e in cm.assemble(pulled)}
        self.assertEqual(ends[A]["sender"], B)
        self.assertEqual(cm.context_label(ends[A]["sender_ctx"]), "ios 18.6 webkit")
        self.assertEqual(ends[A]["codec"], "H264/CH")
        self.assertEqual(ends[A]["ttff_ms"], 1500)
        self.assertEqual(ends[B]["reasons"], ["connected-no-video@connected"])
        self.assertEqual(ends[A]["decoder"], "?")

    def test_the_realised_decoder_and_the_senders_encoder_ride_the_end(self):
        pulled = {"link": [
            row(PAIR_AB, A, ANDROID, **{"rtc.outcome": "video", "rtc.codec_in": "H264", "rtc.decoder": "c2.qti.avc.decoder", "rtc.decoder_kind": "hardware",
                                         "rtc.encoder": "FFmpeg (fallback from: x)", "rtc.encoder_kind": "software"}),
            row(PAIR_AB, B, IPHONE, **{"rtc.outcome": "video", "rtc.encoder": "unsupported", "rtc.decoder": "unsupported"})]}
        ends = {e["receiver"]: e for e in cm.assemble(pulled)}
        self.assertEqual(ends[A]["decoder"], "c2.qti.avc.decoder")
        self.assertEqual(ends[A]["encoder"], "?")  # the iPhone hides its encoder
        self.assertEqual(ends[B]["encoder"], "FFmpeg")

    def test_legacy_rows_take_the_codec_the_peer_sent_and_video_from_coverage_or_the_funnel(self):
        pulled = {
            "legacy": [row(PAIR_AB, A, ANDROID, **{"rtc.codec": "VP8"}), row(PAIR_AB, B, IPHONE, **{"rtc.codec": "H264", "rtc.codec_fmtp": "profile-level-id=42e01f"})],
            "coverage": [row(PAIR_AB, A, {}, value=93.0), row(PAIR_AB, B, {}, value=0.0)],
            "funnel": [row(PAIR_AB, A, ANDROID, stage="offer", value=1000), row(PAIR_AB, A, ANDROID, stage="first_frame", value=2600),
                       row(PAIR_AB, B, IPHONE, stage="offer", value=900), row(PAIR_AB, B, IPHONE, stage="connected", value=2000)],
            "legacy_freeze": [row(PAIR_AB, A, {}, value=450)],
        }
        ends = {e["receiver"]: e for e in cm.assemble(pulled)}
        # A received what B sent: B's legacy rtc.codec
        self.assertEqual(ends[A]["codec"], "H264/CB")
        self.assertEqual(ends[A]["outcome"], "video")
        self.assertEqual(ends[A]["ttff_ms"], 1600)
        self.assertEqual(ends[A]["freeze_ms"], 450)
        self.assertEqual(ends[B]["codec"], "VP8")
        self.assertEqual(ends[B]["outcome"], "connected-no-video")
        self.assertEqual(ends[B]["freeze_ms"], 0)

    def test_a_link_with_coverage_but_no_rtt_still_counts_as_summarised(self):
        # #632: rtc.rtt_ms is absent when no reading carried a round-trip time; coverage is still sent
        pulled = {
            "legacy_cov": [row(PAIR_AB, A, ANDROID, **{"rtc.codec": "VP8"})],
            "coverage": [row(PAIR_AB, A, {}, value=80.0)],
        }
        ends = {e["receiver"]: e for e in cm.assemble(pulled)}
        self.assertEqual(ends[A]["source"], "legacy")
        self.assertEqual(ends[A]["outcome"], "video")

    def test_a_link_with_only_funnel_points_still_counts_with_its_failure(self):
        pulled = {
            "funnel": [row(PAIR_AC, A, ANDROID, stage="offer", value=1000), row(PAIR_AC, A, ANDROID, stage="answer", value=1500)],
            "steps": [row(PAIR_AC, A, {}, **{"rtc.outcome": "failed", "rtc.last_stage": "answer", "rtc.ice": "checking"})],
            "reasons": [row(PAIR_AC, A, {}, **{"rtc.negotiation_reason": "ssrc-collision", "rtc.negotiation_stage": "answer"})],
        }
        [end] = cm.assemble(pulled)
        # a funnel-only link that reached first_frame counts as video
        [seen] = cm.assemble({"funnel": [row(PAIR_AC, A, ANDROID, stage="offer", value=10), row(PAIR_AC, A, ANDROID, stage="first_frame", value=40)]})
        self.assertEqual((seen["outcome"], seen["ttff_ms"]), ("video", 30))
        self.assertEqual(end["source"], "funnel")
        self.assertEqual(end["outcome"], "not-connected")  # failed-step evidence: a measured failure, not no data
        self.assertIsNone(end["sender_ctx"])
        self.assertEqual(end["codec"], "unknown")
        self.assertEqual(end["reasons"], ["join:failed@answer ice checking", "negotiation:answer:ssrc-collision"])


class Sps(unittest.TestCase):
    """The sender's SPS as the receiver's tap read it (rtc.sps, #629)."""

    def test_sps_label(self):
        self.assertEqual(cm.sps_label({"rtc.sps.outcome": "sps", "rtc.sps.poc_type": "0"}), "poc0")
        self.assertEqual(cm.sps_label({"rtc.sps.outcome": "sps", "rtc.sps.poc_type": "unknown"}), "poc?")
        self.assertEqual(cm.sps_label({"rtc.sps.outcome": "not-h264"}), "not-h264")
        self.assertEqual(cm.sps_label({"rtc.sps.outcome": "untapped", "rtc.sps.reason": "not-ready"}), "untapped:not-ready")
        self.assertIsNone(cm.sps_label(None))

    def test_an_end_takes_its_receivers_sps_row_and_a_kept_room_carries_it_into_round_2(self):
        pair_r2 = PAIR_AB.replace(":r1:", ":r2:")
        pulled = {
            "link": [row(PAIR_AB, A, ANDROID, **{"rtc.outcome": "video", "rtc.codec_in": "H264"}),
                     row(pair_r2, A, ANDROID, **{"rtc.outcome": "video", "rtc.codec_in": "H264"}),
                     row(PAIR_AB, B, IPHONE, **{"rtc.outcome": "video", "rtc.codec_in": "H264"})],
            # A's tap read B's SPS in round 1 only: the room was kept for round 2
            "sps": [row(PAIR_AB, A, {}, **{"rtc.sps.outcome": "sps", "rtc.sps.poc_type": "0"})],
        }
        ends = {(e["pair"], e["receiver"]): e for e in cm.assemble(pulled)}
        self.assertEqual(ends[(PAIR_AB, A)]["sps"], "poc0")
        self.assertEqual(ends[(pair_r2, A)]["sps"], "poc0")
        self.assertIsNone(ends[(PAIR_AB, B)]["sps"])

    def test_the_map_shows_the_senders_poc_type_per_group(self):
        def end(sps):
            return {"sender_ctx": IPHONE, "receiver_ctx": ANDROID, "codec": "H264/CB", "outcome": "video", "ttff_ms": 1000, "freeze_ms": 0, "reasons": [], "sps": sps}

        [r] = cm.matrix([end("poc0"), end("poc0"), end(None)])
        self.assertEqual(r["tx_sps"], "poc0:2 -:1")
        self.assertIn("tx sps", cm.render([r]))


class Matrix(unittest.TestCase):
    def test_groups_by_sender_receiver_codec_and_judges(self):
        def end(receiver_ctx, outcome, ttff, freeze, reasons=()):
            return {"sender_ctx": IPHONE, "receiver_ctx": receiver_ctx, "codec": "H264/CB", "outcome": outcome, "ttff_ms": ttff, "freeze_ms": freeze, "reasons": list(reasons)}

        ends = [end(ANDROID, "video", 1000, 0), end(ANDROID, "video", 3000, 200), end(ANDROID, "connected-no-video", None, 0, ["connected-no-video@connected"]),
                end(ANDROID, "video", 2000, 9000)]
        [r] = cm.matrix(ends)
        self.assertEqual((r["sender"], r["receiver"], r["codec"]), ("ios 18.6 webkit", "android 14 chromium-webview 154", "H264/CB"))
        self.assertEqual((r["links"], r["video"], r["success_pct"]), (4, 3, 75))
        self.assertEqual(r["ttff_p50_ms"], 2000)
        self.assertEqual(r["freeze_p95_ms"], 9000)
        self.assertEqual(r["failures"], "connected-no-video@connected x1")
        self.assertIn("ios 18.6 webkit", cm.render([r]))
        self.assertEqual(cm.matrix(ends, min_links=5), [])


class Capabilities(unittest.TestCase):
    def test_cap_columns_and_the_h264_software_case(self):
        rx = {**ANDROID, "user.id": A, "device.model": "SM-A515F", "rtc.cap.h264.decode": "sw", "rtc.cap.vp8.decode": "hw", "rtc.cap.h264.encode": "sw"}
        tx = {**IPHONE, "user.id": B, "device.model": "iphone-6.1in", "rtc.cap.h264.encode": "hw", "rtc.cap.h264.decode": "hw"}
        ends = [{"sender_ctx": tx, "receiver_ctx": rx, "codec": "H264/CB", "outcome": "video", "ttff_ms": 1000, "freeze_ms": 0, "reasons": []},
                {"sender_ctx": rx, "receiver_ctx": tx, "codec": "H264/CB", "outcome": "video", "ttff_ms": 1000, "freeze_ms": 0, "reasons": []}]
        rows = {r["receiver"]: r for r in cm.matrix(ends)}
        android = rows["android 14 chromium-webview 154"]
        self.assertEqual((android["enc_cap"], android["dec_cap"], android["h264_sw_vp8_hw"]), ("hw", "sw", 1))
        self.assertEqual(rows["ios 18.6 webkit"]["h264_sw_vp8_hw"], 0)
        self.assertIn("h264 sw/vp8 hw", cm.render(list(rows.values())))
        caps = {r["model"]: r for r in cm.capabilities(ends)}
        self.assertEqual(caps["SM-A515F"]["h264"], "sw/sw")
        self.assertEqual(caps["SM-A515F"]["vp8"], "?/hw")
        self.assertEqual(caps["iphone-6.1in"]["devices"], 1)
        self.assertIn("vp8 enc/dec", cm.render_caps(list(caps.values())))

    def test_cap_id(self):
        self.assertEqual(cm.cap_id("H264/CB"), "h264")
        self.assertEqual(cm.cap_id("H264/CH?"), "h264_high")
        self.assertEqual(cm.cap_id("VP9"), "vp9")
        self.assertIsNone(cm.cap_id("unknown"))
        self.assertEqual(cm.cap_of(None, "VP8", "decode"), "?")


class OnlyMeasured(unittest.TestCase):
    def test_no_data_ends_stay_out_of_the_percentage_and_averages(self):
        def end(outcome, ttff=None, freeze=0, reasons=(), enc="VideoToolbox", dec="libvpx"):
            ctx = {"device.os": "android", "device.os_version": "14"}
            return {"outcome": outcome, "codec": "VP8", "ttff_ms": ttff, "freeze_ms": freeze, "reasons": list(reasons),
                    "encoder_kind": cm.end_kind(enc), "decoder_kind": cm.end_kind(dec), "sender_ctx": ctx, "receiver_ctx": ctx}
        ends = [end("video", 1000, 100), end("video", 3000, 200), end("no-video", reasons=["no-video@offer"]),
                end("unmeasured", reasons=["unmeasured@none"]), end("no-summary", freeze=99999, reasons=["no-summary@offer"])]
        [r] = cm.matrix(ends)
        self.assertEqual((r["links"], r["measured"], r["no_data"], r["video"], r["success_pct"]), (5, 3, 2, 2, 67))
        self.assertEqual((r["ttff_p50_ms"], r["freeze_p95_ms"]), (2000, 200))
        self.assertEqual(r["failures"], "no-video@offer x1")
        self.assertEqual((r["tx_enc_kind"], r["rx_dec_kind"]), ("HW 5", "SW 5"))
        out = cm.render([r])
        self.assertIn("no data", out)
        self.assertIn("tx enc hw/sw", out)
        self.assertIn("rx dec hw/sw", out)

    def test_a_group_with_nothing_measured_has_no_percentage(self):
        ctx = {"device.os": "ios", "device.os_version": "18.6"}
        e = {"outcome": "unmeasured", "codec": "VP8", "ttff_ms": None, "freeze_ms": 0, "reasons": ["unmeasured@none"], "sender_ctx": ctx, "receiver_ctx": ctx}
        [r] = cm.matrix([e])
        self.assertIsNone(r["success_pct"])
        self.assertIn("-", cm.render([r]))

    def test_connected_unmeasured_is_no_data(self):
        ctx = {"device.os": "android", "device.os_version": "14"}
        def end(outcome, ttff=None, freeze=0, reasons=()):
            return {"outcome": outcome, "codec": "VP8", "ttff_ms": ttff, "freeze_ms": freeze, "reasons": list(reasons), "sender_ctx": ctx, "receiver_ctx": ctx}
        [r] = cm.matrix([end("video", 2000, 100), end("connected-unmeasured", 9000, 50000, ["connected-unmeasured@connected"])])
        self.assertEqual((r["measured"], r["no_data"], r["success_pct"]), (1, 1, 100))
        self.assertEqual((r["ttff_p50_ms"], r["freeze_p95_ms"], r["failures"]), (2000, 100, ""))

    def test_standby_is_no_data_not_a_failure(self):
        ctx = {"device.os": "android", "device.os_version": "14"}
        def end(outcome, reasons=()):
            return {"outcome": outcome, "codec": "VP8", "ttff_ms": None, "freeze_ms": 0, "reasons": list(reasons), "sender_ctx": ctx, "receiver_ctx": ctx}
        [r] = cm.matrix([end("video"), end("standby", ["standby@connected"])])
        self.assertEqual((r["measured"], r["no_data"], r["success_pct"], r["failures"]), (1, 1, 100, ""))

    def test_a_pre_fix_row_shows_no_kind_suffix_and_the_corrected_kind(self):
        pulled = {"link": [row(PAIR_AB, A, ANDROID, **{"rtc.outcome": "video", "rtc.codec_in": "VP8", "rtc.decoder": "OMX.google.h264.decoder",
                                                      "rtc.decoder_kind": "hardware", "rtc.decoder_efficient": "unsupported"})]}
        ends = {e["receiver"]: e for e in cm.assemble(pulled)}
        self.assertEqual(ends[A]["decoder"], "OMX.google.h264.decoder")
        [r] = cm.matrix([ends[A]])
        out = cm.render([r])
        self.assertNotIn("(hardware)", out)
        self.assertEqual(r["rx_dec_kind"], "SW 1")


class FailedLinks(unittest.TestCase):
    """Only a funnel-only end that never connected and has a FAILED join step is a measured failure."""
    FAILED = {"rtc.outcome": "failed", "rtc.last_stage": "answer"}

    def end(self, source="funnel", stages=("offer", "answer"), **extra):
        pulled = {"funnel": [row(PAIR_AB, B, ANDROID, stage=s, value=1000 + i) for i, s in enumerate(stages)], **extra}
        if source == "legacy":
            pulled["legacy"] = [row(PAIR_AB, B, ANDROID, **{"rtc.codec": "VP8"})]
        [e] = [e for e in cm.assemble(pulled) if e["receiver"] == B]
        return e

    def test_a_funnel_end_that_never_connected_and_failed_is_a_measured_failure(self):
        e = self.end(steps=[row(PAIR_AB, B, ANDROID, **self.FAILED)])
        self.assertEqual(e["outcome"], "not-connected")
        self.assertEqual(e["reasons"][0], "join:failed@answer")
        [r] = cm.matrix([e])
        self.assertEqual((r["measured"], r["no_data"], r["video"], r["success_pct"]), (1, 0, 0, 0))
        self.assertIn("join:failed@answer x1", r["failures"])

    def test_everything_else_stays_no_data(self):
        failed = [row(PAIR_AB, B, ANDROID, **self.FAILED)]
        cases = {
            "legacy end (it has a working candidate pair) with a failed step": self.end("legacy", steps=failed),
            "pending step": self.end(steps=[row(PAIR_AB, B, ANDROID, **{"rtc.outcome": "pending", "rtc.last_stage": "answer"})]),
            "codec guard": self.end(reasons=[row(PAIR_AB, B, ANDROID, **{"rtc.codec_guard_reason": "prefs-missing"})]),
            "negotiation error": self.end(reasons=[row(PAIR_AB, B, ANDROID, **{"rtc.negotiation_reason": "bad-sdp", "rtc.negotiation_stage": "answer"})]),
            "funnel that reached connected": self.end(stages=("offer", "answer", "connected"), steps=failed),
            "no evidence": self.end(),
        }
        for label, e in cases.items():
            self.assertIn(e["outcome"], ("unmeasured", "no-summary"), label)
        self.assertIn("join:pending@answer", cases["pending step"]["reasons"][0])  # still a reason

    def test_several_join_attempts_give_one_verdict_in_any_row_order(self):
        failed = row(PAIR_AB, B, ANDROID, **self.FAILED)
        pending = row(PAIR_AB, B, ANDROID, **{"rtc.outcome": "pending", "rtc.last_stage": "offer"})
        seen = []
        for steps in ([failed, pending], [pending, failed]):
            e = self.end(steps=steps)
            seen.append((e["outcome"], e["reasons"]))
        self.assertEqual(seen[0], seen[1])
        self.assertEqual(seen[0], ("not-connected", ["join:failed@answer"]))
        # pending rows alone stay no data, whatever the order
        both = [pending, row(PAIR_AB, B, ANDROID, **{"rtc.outcome": "pending", "rtc.last_stage": "answer"})]
        self.assertEqual({self.end(steps=s)["reasons"][0] for s in (both, both[::-1])}, {"join:pending@answer"})
        self.assertEqual(self.end(steps=both)["outcome"], "no-summary")


class NameRuleParity(unittest.TestCase):
    """rtc-impl.ts and codec-map.py read the same JSON, case-insensitively."""
    def test_both_sides_read_the_one_json(self):
        with open(os.path.join(cm.PATTERNS_DIR, "rtc-impl.ts")) as f:
            ts = f.read()
        self.assertIn('import patterns from "./codec-impl-patterns.json"', ts)
        self.assertIn('new RegExp(patterns.hardware, "i")', ts)
        self.assertIn('new RegExp(patterns.software, "i")', ts)
        self.assertTrue(cm._HW_NAME.flags & re.I and cm._SW_NAME.flags & re.I)


if __name__ == "__main__":
    unittest.main()
