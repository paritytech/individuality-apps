#!/usr/bin/env python3
# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

"""The codec map: which sender and receiver devices, over which codec, get video, and how well.

  python3 codec-map.py [--days 7 | --start ISO --end ISO] [--include-bots] [--by-host] [--min-links 1] [--json FILE]

Read-only against Sentry (tracemetrics + spans). One LINK END is one viewer's side of one link in one round
(rtc.pair + user.id): the viewer is the RECEIVER, the other account in the pair is the SENDER, and the codec is
the one the receiver decoded. Rows are grouped by sender context x receiver context x codec, where a context is
OS + version + browser engine + engine major (iOS: WebKit, its version is the OS version), plus the host app
with --by-host. Per group: links, "no data" (links with no round summary, unmeasured or no-summary: not counted below), the share of the
MEASURED links that got video, median time to first frame (first offer to first
decoded frame), p95 inbound freeze per link-round, and the top reasons the rest failed. median, p95 and failures are over measured links only. Beside the encoder and decoder names, "tx enc hw/sw" and "rx dec hw/sw" count each end's kind, e.g. "HW 9 · SW 1 · ? 3": the
power-efficient flag when the row has one (rtc.*_efficient), else a known software name, else the kind the row carries
(rtc.encoder_kind / rtc.decoder_kind), else inferred from the name (end_kind); n/r = the browser does not report it (Safari), ? = no data (old build or an unrecognised name). Beside the codec: what the
sender's device says of encoding it and the receiver's of decoding it (navigator.mediaCapabilities, rtc.cap.* tags:
hw, sw, no, unsupported, ? = build without the probe), and how many links ran H.264 on a receiver that decodes it in
software while it has VP8 in hardware. "tx sps" is the sender's H.264 pic_order_cnt_type as the receiver's encoded-transform
tap read it (rtc.sps, #629): poc0 / poc1 / poc2, not-h264, untapped:<reason>, - = no tap on that end (bots tap; real
players only at the build's NEXT_PUBLIC_SPS_TAP_RATE). POC type 0 is the suspected trigger of the Snapdragon frame hold
(#558); the VUI fields are not shown because libwebrtc rewrites them before the tap sees the frame. A second table lists every device context's answers per codec.

Where the numbers come from (newest first; the script mixes builds):
  rtc.link / rtc.link.ttff_ms / rtc.link.freeze_ms   the per-link row (apps/jollity-app/lib/journeys/rtc-link.ts), new builds
  rtc.rtt_ms stat:p50 or rtc.coverage_pct (a link with no RTT reading sends no rtt) + rtc.freeze_ms + rtc.funnel_ms   the same facts on older builds
  rtc.funnel_ms with no row at all                   links that never got a round summary (the denominator):
                                                     outcome video when first_frame was stamped, else no-summary
  rtc.sps                                           the receiver's tap of the sender's SPS, once per link (a room kept
                                                     for round 2 is matched by game and accounts)
  join.rtc.peer steps (spans) rtc.outcome failed/pending, rtc.negotiation_error, rtc.codec_guard   failure reasons
The sender's context is read off the sender's own points (every metric carries the device scope tags); a sender
with no telemetry (a native app, an old build) shows as "unknown". Bots (test.tag) are left out unless
--include-bots. Times printed are local (the machine's zone).
"""
import argparse, collections, datetime, json, os, re, statistics, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

CAP_CODECS = ["h264", "h264_high", "vp8", "vp9", "av1"]
CAP_FIELDS = [f"rtc.cap.{c}.{d}" for c in CAP_CODECS for d in ("encode", "decode")]
CTX = ["user.id", "device.os", "device.os_version", "device.engine", "device.engine_version", "device.model", "host.app", "host.app_version",
       "release", "test.tag"] + CAP_FIELDS
LINK_FIELDS = CTX + ["rtc.pair", "round", "game.index", "rtc.role", "rtc.outcome", "rtc.last_stage", "rtc.seen", "rtc.codec", "rtc.codec_fmtp",
                     "rtc.codec_in", "rtc.codec_in_fmtp", "rtc.codec_out", "rtc.codec_out_fmtp", "rtc.decoder", "rtc.decoder_kind",
                     "rtc.encoder", "rtc.encoder_kind", "rtc.encoder_efficient", "rtc.decoder_efficient", "rtc.rtx", "rtc.red", "rtc.ulpfec", "rtc.rebuilds", "rtc.path"]
LEGACY_FIELDS = CTX + ["rtc.pair", "round", "game.index", "rtc.codec", "rtc.codec_fmtp", "rtc.decoder", "rtc.encoder", "rtc.path"]
VALUE_FIELDS = ["rtc.pair", "user.id", "value"]
FUNNEL_FIELDS = CTX + ["rtc.pair", "stage", "rtc.role", "value"]
STEP_FIELDS = ["rtc.pair", "user.id", "rtc.outcome", "rtc.last_stage", "rtc.ice"]
REASON_FIELDS = ["rtc.pair", "user.id", "rtc.negotiation_reason", "rtc.negotiation_stage", "rtc.codec_guard_reason"]
SPS_FIELDS = ["rtc.pair", "user.id", "rtc.sps.outcome", "rtc.sps.reason", "rtc.sps.poc_type"]
UNKNOWN = "unknown"
MISSING = (None, "", "unsupported")


# ---------------------------------------------------------------- pure helpers (tested in test_codec_map.py)

def h264_profile(fmtp):
    """profile-level-id to a short profile name: CB, B, M, E, CH, H; None when there is none."""
    m = re.search(r"profile-level-id=([0-9a-fA-F]{6})", fmtp or "")
    if not m:
        return None
    idc, iop = int(m.group(1)[0:2], 16), int(m.group(1)[2:4], 16)
    if idc == 0x42:
        return "CB" if iop & 0x40 else "B"
    if idc == 0x4D:
        return "CB" if iop & 0x80 else "M"
    if idc == 0x58:
        return "E"
    if idc == 0x64:
        return "CH" if iop & 0x0C == 0x0C else "H"
    return m.group(1).lower()


def codec_label(codec, fmtp=None):
    """'H264/CB' (with the profile), 'VP8'; None when the codec is unknown."""
    if codec in MISSING:
        return None
    if codec.upper() == "H264":
        profile = h264_profile(fmtp)
        return f"H264/{profile}" if profile else "H264"
    return codec


def _major(version, parts=1):
    if version in MISSING:
        return ""
    # some hosts send an iOS version the way the user agent spells it, 16_0
    return ".".join(str(version).replace("_", ".").split(".")[:parts])


def context_label(row, by_host=False):
    """'android 14 chromium-webview 154', 'ios 18.6 webkit'. iOS keeps major.minor: its WebKit is the OS's."""
    if not row or row.get("device.os") in MISSING:
        return UNKNOWN
    os_name = row["device.os"]
    version = _major(row.get("device.os_version"), 2 if os_name in ("ios", "macos") else 1)
    engine = row.get("device.engine")
    if engine in MISSING:
        engine = "webkit" if os_name == "ios" else "?"
    label = " ".join(part for part in (os_name, version, engine, _major(row.get("device.engine_version"))) if part)
    if by_host and row.get("host.app") not in MISSING:
        label += f" [{row['host.app']}{' ' + str(row['host.app_version']) if row.get('host.app_version') not in MISSING else ''}]"
    return label


def cap_id(codec):
    """The media-caps codec id of a map codec label: H264/CB -> h264, H264/CH or H -> h264_high, VP8 -> vp8."""
    base = (codec or "").rstrip("?")
    if base.startswith("H264"):
        return "h264_high" if base in ("H264/CH", "H264/H") else "h264"
    return base.lower() if base.lower() in CAP_CODECS else None


def cap_of(ctx, codec, direction):
    """What a device said of a codec (media-caps.ts): hw, sw, no, unsupported; '?' when its build did not probe."""
    cid = cap_id(codec)
    value = (ctx or {}).get(f"rtc.cap.{cid}.{direction}") if cid else None
    return value if value not in (None, "") else "?"


def h264_against_vp8(end):
    """H.264 was chosen but the receiver decodes it in software (or not) while it has VP8 in hardware."""
    if cap_id(end["codec"]) not in ("h264", "h264_high"):
        return False
    ctx = end.get("receiver_ctx") or {}
    return cap_of(ctx, end["codec"], "decode") in ("sw", "no") and ctx.get("rtc.cap.vp8.decode") == "hw"


def _mix(values):
    counts = collections.Counter(values)
    if not counts:
        return "?"
    if len(counts) == 1:
        return next(iter(counts))
    return " ".join(f"{v}:{n}" for v, n in counts.most_common())


def impl_label(name):
    """'c2.qti.avc.decoder', 'FFmpeg': the implementation in use (before any '(fallback from: ...)'). No kind: hw/sw has its own column."""
    if name in MISSING:
        return "?"
    family = str(name).split("(")[0].strip() or "?"
    return family


# outcomes that say nothing about whether video flowed. Data: video, connected-no-video, not-connected, no-video
# (rtc-link.ts) and the legacy ones. No data: legacy unmeasured / no-summary, new connected-unmeasured (no frame counter), standby (a next-round link held back on purpose, #1156), unknown
NO_DATA = ("unmeasured", "no-summary", "connected-unmeasured", "standby", UNKNOWN)
# the hw/sw name rules: apps/jollity-app/lib/journeys/codec-impl-patterns.json, shared with rtc-impl.ts (see its _note)
PATTERNS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "apps", "jollity-app", "lib", "journeys")
with open(os.path.join(PATTERNS_DIR, "codec-impl-patterns.json")) as _f:
    _PATTERNS = json.load(_f)
_HW_NAME = re.compile(_PATTERNS["hardware"], re.I)
_SW_NAME = re.compile(_PATTERNS["software"], re.I)


def end_kind(name, kind=None, efficient=None):
    """One link end's implementation kind: 'hw', 'sw', 'n/r' (the browser does not report it, Safari) or '?' (no data, old build).
    The browser's power-efficient flag (rtc.encoder_efficient / rtc.decoder_efficient, true/false) is the authority; without
    it a known software name wins, then the row's own kind (rtc.encoder_kind / rtc.decoder_kind, 'hardware'/'software'/
    'unsupported'), then the hardware name inference. Names are matched on the family, before any '(fallback from: ...)'. Mirrors apps/jollity-app/lib/journeys/rtc-impl.ts."""
    if efficient in ("true", True):
        return "hw"
    if efficient in ("false", False):
        return "sw"
    family = "" if name in (None, "") else str(name).split("(")[0].strip()
    if family == "unsupported":
        family = ""
        kind = kind or "unsupported"
    if family and _SW_NAME.search(family):
        return "sw"  # a known software name beats an emitted kind: builds before the OMX.google/c2.android fix said hardware for them
    if kind == "hardware":
        return "hw"
    if kind == "software":
        return "sw"
    if family and _HW_NAME.search(family):
        return "hw"
    if kind == "unsupported":
        return "n/r"
    return "?"


def kind_mix(kinds):
    """'HW 9 · SW 1 · ? 3': the count of each kind, zeros left out."""
    counts = collections.Counter(kinds)
    parts = [f"{label.upper() if label in ('hw', 'sw') else label} {counts[label]}" for label in ("hw", "sw", "n/r", "?") if counts[label]]
    return " · ".join(parts) or "?"


def peer_of(pair, user):
    """The other account of 'g<game>:r<round>:<a>~<b>', or None."""
    accounts = (pair or "").rsplit(":", 1)[-1].split("~")
    if len(accounts) != 2 or user not in accounts:
        return None
    return accounts[1] if accounts[0] == user else accounts[0]


def sps_label(row):
    """'poc0' for a parsed SPS, the outcome otherwise ('not-h264', 'untapped:not-ready'); None for no row."""
    if not row:
        return None
    outcome = row.get("rtc.sps.outcome") or UNKNOWN
    if outcome == "sps":
        poc = row.get("rtc.sps.poc_type")
        return f"poc{poc if poc not in MISSING and poc != UNKNOWN else '?'}"
    if outcome == "untapped" and row.get("rtc.sps.reason") not in MISSING:
        return f"untapped:{row['rtc.sps.reason']}"
    return outcome


def _game_pair(pair):
    """'g9:r2:a~b' -> 'g9:a~b': a room kept across rounds is tapped once, in its first round."""
    parts = (pair or "").split(":")
    return f"{parts[0]}:{parts[-1]}" if len(parts) == 3 else pair


def _key(row):
    return (row.get("rtc.pair"), row.get("user.id"))


def _usable(row):
    return row.get("rtc.pair") not in MISSING and row.get("user.id") not in MISSING


def assemble(pulled):
    """Every link end in the pull, one dict each: pair, receiver, sender, source, outcome, codec, ttff_ms,
    freeze_ms, reasons (a list), receiver/sender context rows."""
    ends = {}
    contexts = {}
    for name in ("link", "legacy", "legacy_cov", "funnel"):
        for row in pulled.get(name, []):
            if row.get("user.id") not in MISSING and row.get("device.os") not in MISSING:
                contexts.setdefault(row["user.id"], row)
    for row in filter(_usable, pulled.get("link", [])):
        ends.setdefault(_key(row), {**row, "source": "row"})
    # rtc.rtt_ms is absent when no reading of the round carried a round-trip time (#632), so the summary's
    # other always-sent point, rtc.coverage_pct, marks a link end too
    for row in filter(_usable, pulled.get("legacy", []) + pulled.get("legacy_cov", [])):
        ends.setdefault(_key(row), {**row, "source": "legacy"})

    stages = collections.defaultdict(dict)
    for row in filter(_usable, pulled.get("funnel", [])):
        stage, value = row.get("stage"), row.get("value")
        if stage and isinstance(value, (int, float)):
            got = stages[_key(row)]
            got[stage] = min(value, got.get(stage, value))
            if _key(row) not in ends:
                ends[_key(row)] = {**row, "source": "funnel"}

    def values(name, pick=max):
        out = {}
        for row in filter(_usable, pulled.get(name, [])):
            if isinstance(row.get("value"), (int, float)):
                out[_key(row)] = pick(row["value"], out.get(_key(row), row["value"]))
        return out

    ttff_new, freeze_new = values("ttff", min), values("freeze")
    freeze_old, coverage = values("legacy_freeze"), values("coverage")
    # a pair can have several join attempts (reload, rejoin) in no stable order: failed beats pending, ties by stage then ice
    steps = {}
    for r in filter(_usable, pulled.get("steps", [])):
        rank = lambda x: (x.get("rtc.outcome") != "failed", str(x.get("rtc.last_stage")), str(x.get("rtc.ice")))
        if _key(r) not in steps or rank(r) < rank(steps[_key(r)]):
            steps[_key(r)] = r
    sps, sps_game = {}, {}
    for r in filter(_usable, pulled.get("sps", [])):
        sps.setdefault(_key(r), r)
        sps_game.setdefault((_game_pair(r["rtc.pair"]), r["user.id"]), r)
    reasons = collections.defaultdict(list)
    for row in filter(_usable, pulled.get("reasons", [])):
        if row.get("rtc.codec_guard_reason") not in MISSING:
            reasons[_key(row)].append(f"codec_guard:{row['rtc.codec_guard_reason']}")
        elif row.get("rtc.negotiation_reason") not in MISSING:
            reasons[_key(row)].append(f"negotiation:{row.get('rtc.negotiation_stage') or '?'}:{row['rtc.negotiation_reason']}")

    out = []
    for key, end in ends.items():
        pair, user = key
        sender = peer_of(pair, user)
        peer_end = ends.get((pair, sender), {})
        got = stages.get(key, {})
        if end["source"] == "row":
            outcome = end.get("rtc.outcome") or UNKNOWN
            ttff = ttff_new.get(key)
            freeze = freeze_new.get(key, 0)
        else:
            if "first_frame" in got or (coverage.get(key) or 0) > 0:
                outcome = "video"
            elif end["source"] == "legacy" and key in coverage:
                outcome = "connected-no-video" if "connected" in got else "no-video"
            elif end["source"] == "legacy":
                outcome = "unmeasured"
            else:
                # funnel points and no round summary: what the link did after its last stage is not known
                outcome = "no-summary"
            ttff = got["first_frame"] - got["offer"] if "first_frame" in got and "offer" in got and got["first_frame"] >= got["offer"] else None
            freeze = freeze_old.get(key, 0)
        codec = codec_label(end.get("rtc.codec_in"), end.get("rtc.codec_in_fmtp")) \
            or codec_label(peer_end.get("rtc.codec_out"), peer_end.get("rtc.codec_out_fmtp")) \
            or (codec_label(peer_end.get("rtc.codec"), peer_end.get("rtc.codec_fmtp")) if peer_end.get("source") == "legacy" else None) \
            or ((codec_label(end.get("rtc.codec"), end.get("rtc.codec_fmtp")) or "") + "?" if end.get("rtc.codec") not in MISSING else UNKNOWN)
        why = list(reasons.get(key, []))
        step = steps.get(key)
        failed = step and step.get("rtc.outcome") == "failed"
        # only a funnel-only end that never connected and has a failed join step is a measured failure; a pending step, a codec
        # guard or a negotiation error is a reason alone, and a legacy end (it has an rtt reading) did connect
        if outcome == "no-summary" and failed and "connected" not in got:
            outcome = "not-connected"
        if outcome != "video":
            if step and step.get("rtc.outcome") in ("failed", "pending"):
                why.insert(0, f"join:{step['rtc.outcome']}@{step.get('rtc.last_stage') or 'none'}" + (f" ice {step['rtc.ice']}" if step.get("rtc.ice") not in MISSING else ""))
            else:
                last = end.get("rtc.last_stage") if end["source"] == "row" else next((s for s in ("connected", "ice_checking", "answer", "offer") if s in got), None)
                why.insert(0, f"{outcome}@{last or 'none'}")
        out.append({"pair": pair, "receiver": user, "sender": sender, "source": end["source"], "outcome": outcome, "codec": codec,
                    "decoder": impl_label(end.get("rtc.decoder")),
                    "decoder_kind": end_kind(end.get("rtc.decoder"), end.get("rtc.decoder_kind"), end.get("rtc.decoder_efficient")),
                    "encoder_kind": end_kind(peer_end.get("rtc.encoder"), peer_end.get("rtc.encoder_kind"), peer_end.get("rtc.encoder_efficient")),
                    "encoder": impl_label(peer_end.get("rtc.encoder")),
                    "ttff_ms": ttff, "freeze_ms": freeze, "reasons": why,
                    "sps": sps_label(sps.get(key) or sps_game.get((_game_pair(pair), user))),
                    "receiver_ctx": contexts.get(user, end), "sender_ctx": contexts.get(sender)})
    return out


def _p95(values):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, -(-95 * len(ordered) // 100) - 1)]


def matrix(ends, by_host=False, min_links=1):
    """Rows of the codec map, most links first."""
    groups = collections.defaultdict(list)
    for end in ends:
        groups[(context_label(end["sender_ctx"], by_host), context_label(end["receiver_ctx"], by_host), end["codec"])].append(end)
    rows = []
    for (sender, receiver, codec), group in groups.items():
        if len(group) < min_links:
            continue
        # unmeasured / no-summary ends are not data: they stay out of the %, the averages and the failures
        measured = [end for end in group if end["outcome"] not in NO_DATA]
        ok = sum(1 for end in measured if end["outcome"] == "video")
        ttffs = [end["ttff_ms"] for end in measured if isinstance(end["ttff_ms"], (int, float))]
        reasons = collections.Counter(reason for end in measured for reason in end["reasons"])
        rows.append({"sender": sender, "receiver": receiver, "codec": codec, "links": len(group), "measured": len(measured), "no_data": len(group) - len(measured), "video": ok,
                     "tx_enc_kind": kind_mix(end.get("encoder_kind", "?") for end in group),
                     "rx_dec_kind": kind_mix(end.get("decoder_kind", "?") for end in group),
                     "enc_cap": _mix(cap_of(end["sender_ctx"], codec, "encode") for end in group),
                     "dec_cap": _mix(cap_of(end["receiver_ctx"], codec, "decode") for end in group),
                     "encoder": _mix(end.get("encoder", "?") for end in group),
                     "decoder": _mix(end.get("decoder", "?") for end in group),
                     "h264_sw_vp8_hw": sum(1 for end in group if h264_against_vp8(end)),
                     "tx_sps": _mix(end.get("sps") or "-" for end in group),
                     "success_pct": round(100 * ok / len(measured)) if measured else None, "ttff_p50_ms": round(statistics.median(ttffs)) if ttffs else None,
                     "freeze_p95_ms": _p95([end["freeze_ms"] or 0 for end in measured]),
                     "failures": ", ".join(f"{reason} x{n}" for reason, n in reasons.most_common(3))})
    rows.sort(key=lambda row: (-row["links"], row["sender"], row["receiver"], row["codec"]))
    return rows


def render(rows):
    head = ["sender", "receiver", "codec", "tx encoder", "tx enc hw/sw", "tx enc cap", "tx sps", "rx decoder", "rx dec hw/sw", "rx dec cap", "links", "no data", "video %", "ttff p50", "freeze p95", "h264 sw/vp8 hw", "top failures"]
    cells = [[r["sender"], r["receiver"], r["codec"], r["encoder"], r.get("tx_enc_kind", "?"), r["enc_cap"], r.get("tx_sps", "-"), r["decoder"], r.get("rx_dec_kind", "?"), r["dec_cap"], str(r["links"]), str(r.get("no_data") or "-"),
              "-" if r["success_pct"] is None else f"{r['success_pct']}%",
              "-" if r["ttff_p50_ms"] is None else f"{r['ttff_p50_ms'] / 1000:.1f}s",
              "-" if r["freeze_p95_ms"] is None else f"{r['freeze_p95_ms'] / 1000:.1f}s", str(r["h264_sw_vp8_hw"] or "-"), r["failures"] or "-"] for r in rows]
    widths = [max(len(c) for c in col) for col in zip(head, *cells)]
    lines = ["  ".join(c.ljust(w) for c, w in zip(head, widths)).rstrip()]
    lines += ["  ".join(c.ljust(w) for c, w in zip(row, widths)).rstrip() for row in cells]
    return "\n".join(lines)


def capabilities(ends, by_host=False):
    """Per device context and model: what each codec encodes/decodes as (hw, sw, no, unsupported, ? = not probed),
    and how many devices said so. One row per distinct answer set."""
    devices = {}
    for end in ends:
        for ctx in (end["receiver_ctx"], end["sender_ctx"]):
            if ctx and ctx.get("user.id"):
                devices[ctx["user.id"]] = ctx
    groups = collections.Counter()
    for ctx in devices.values():
        answers = tuple(f"{(ctx.get(f'rtc.cap.{c}.encode') or '?')}/{(ctx.get(f'rtc.cap.{c}.decode') or '?')}" for c in CAP_CODECS)
        groups[(context_label(ctx, by_host), ctx.get("device.model") or "-", answers)] += 1
    return [{"context": label, "model": model, "devices": n, **dict(zip(CAP_CODECS, answers))}
            for (label, model, answers), n in sorted(groups.items(), key=lambda item: (-item[1], item[0]))]


def render_caps(rows):
    head = ["context", "model", "devices"] + [f"{c} enc/dec" for c in CAP_CODECS]
    cells = [[r["context"], r["model"], str(r["devices"])] + [r[c] for c in CAP_CODECS] for r in rows]
    widths = [max(len(c) for c in col) for col in zip(head, *cells)]
    return "\n".join("  ".join(c.ljust(w) for c, w in zip(row, widths)).rstrip() for row in [head] + cells)


# ---------------------------------------------------------------- Sentry

def queries(bots):
    """The Sentry queries, by pull name: (dataset, query, fields). Printed with --print-queries."""
    nb = "" if bots else " !has:test.tag"
    return {
        "link": ("tracemetrics", "metric.name:rtc.link" + nb, LINK_FIELDS),
        "ttff": ("tracemetrics", "metric.name:rtc.link.ttff_ms" + nb, VALUE_FIELDS),
        "freeze": ("tracemetrics", "metric.name:rtc.link.freeze_ms" + nb, VALUE_FIELDS),
        "legacy": ("tracemetrics", "metric.name:rtc.rtt_ms stat:p50" + nb, LEGACY_FIELDS),
        "legacy_cov": ("tracemetrics", "metric.name:rtc.coverage_pct" + nb, LEGACY_FIELDS),
        "legacy_freeze": ("tracemetrics", "metric.name:rtc.freeze_ms stat:total" + nb, VALUE_FIELDS),
        "coverage": ("tracemetrics", "metric.name:rtc.coverage_pct" + nb, VALUE_FIELDS),
        "funnel": ("tracemetrics", "metric.name:rtc.funnel_ms stage:[offer,first_frame,connected,ice_checking,answer]" + nb, FUNNEL_FIELDS),
        "steps": ("spans", "span.op:join.rtc.peer rtc.outcome:[failed,pending]" + nb, STEP_FIELDS),
        "reasons": ("tracemetrics", "metric.name:[rtc.negotiation_error,rtc.codec_guard]" + nb, REASON_FIELDS),
        "sps": ("tracemetrics", "metric.name:rtc.sps" + nb, SPS_FIELDS),
    }


CHANGE_QUERIES = {
    "impl_change": ("tracemetrics", "metric.name:rtc.impl_change", ["device.os", "device.os_version", "rtc.direction", "rtc.impl_from", "rtc.impl",
                                                                       "rtc.impl_kind_from", "rtc.impl_kind", "rtc.codec_from", "rtc.codec", "count(value)"]),
    "decoder_change": ("spans", "span.op:game.rtc.decoder_change", ["device.os", "device.os_version", "rtc.decoder_from", "rtc.decoder",
                                                                     "rtc.codec_from", "rtc.codec", "count()"]),
}


def pull(window, bots):
    from sentry import events_all
    out = {}
    for name, (dataset, query, fields) in queries(bots).items():
        out[name] = events_all(dataset, query, fields, per_page=100, **window)
    for name, (dataset, query, fields) in CHANGE_QUERIES.items():
        out[name] = events_all(dataset, query + ("" if bots else " !has:test.tag"), fields, per_page=100, **window)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--start", help="ISO UTC")
    ap.add_argument("--end", help="ISO UTC")
    ap.add_argument("--include-bots", action="store_true", help="keep scripted runs (test.tag e2e-*)")
    ap.add_argument("--by-host", action="store_true", help="add the host app and its version to each context")
    ap.add_argument("--min-links", type=int, default=1)
    ap.add_argument("--json", help="write the link ends and the map here")
    ap.add_argument("--print-queries", action="store_true", help="print the Sentry queries and stop")
    a = ap.parse_args()
    if a.print_queries:
        for name, (dataset, query, fields) in {**queries(a.include_bots), **CHANGE_QUERIES}.items():
            print(f"{name:14} {dataset:12} {query}\n{'':27} fields: {', '.join(fields)}")
        return
    window = {"start": a.start, "end": a.end} if a.start and a.end else {"period": f"{a.days}d"}
    pulled = pull(window, a.include_bots)
    ends = assemble(pulled)
    rows = matrix(ends, a.by_host, a.min_links)
    now = datetime.datetime.now().astimezone()
    sources = collections.Counter(end["source"] for end in ends)
    print(f"Codec map, {a.start + ' to ' + a.end + ' UTC' if a.start else 'last ' + str(a.days) + ' days'}, made {now:%Y-%m-%d %H:%M %Z}"
          f"{' (bots included)' if a.include_bots else ' (bots left out)'}")
    print(f"{len(ends)} link ends (receiver side of one link in one round): {dict(sources)}; "
          f"{sum(1 for e in ends if e['sender_ctx'] is None)} with an unknown sender\n")
    print(render(rows) if rows else "(no links)")
    caps = capabilities(ends, a.by_host)
    if any(any(r[c] != "?/?" for c in CAP_CODECS) for r in caps):
        print("\nWhat each device says it can do (navigator.mediaCapabilities, webrtc, 360p 300 kbit/s 24 fps; encode/decode):")
        print(render_caps(caps))
    else:
        print("\n(no device has sent rtc.cap.* yet: the media-capabilities probe ships with this build)")
    changes = [r for r in pulled.get("impl_change", [])] + [r for r in pulled.get("decoder_change", [])]
    if changes:
        print("\nImplementation and codec changes mid-call:")
        for r in changes:
            n = r.get("count(value)") or r.get("count()")
            frm = r.get("rtc.impl_from") or r.get("rtc.decoder_from")
            to = r.get("rtc.impl") or r.get("rtc.decoder")
            kinds = f" ({r['rtc.impl_kind_from']}->{r['rtc.impl_kind']})" if r.get("rtc.impl_kind") else ""
            print(f"  {r.get('device.os')} {r.get('device.os_version')} {r.get('rtc.direction') or 'in'}: {frm} -> {to}{kinds}, "
                  f"codec {r.get('rtc.codec_from')} -> {r.get('rtc.codec')}: {int(n or 0)}")
    if a.json:
        with open(a.json, "w") as f:
            json.dump({"ends": ends, "map": rows, "capabilities": caps}, f, indent=1, default=str)


if __name__ == "__main__":
    main()
