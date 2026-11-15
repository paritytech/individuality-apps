// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The video codecs each side asks for, and why RTX is not among them (#497).
 *
 * Game 228: an iOS 17.5 offerer could not apply the lane answer of a fresh
 * round-2 link ("Failed to add remote stream ssrc: 4041477088 to {mid: 1,
 * media_type: video}"). libwebrtc M111–M123, which WebKit shipped in iOS 17,
 * makes a default receive stream for a dummy SSRC that claims an RTX SSRC
 * arriving before any media packet; the answerer's BWE probes ride its RTX
 * SSRC from the moment it sets its answer, ahead of the answer on the data
 * channel. The `m120` model below is that rule, cut down from the M120
 * WebRtcVideoReceiveChannel (AddRecvStream, ValidateReceiveSsrcAvailability,
 * MaybeCreateDefaultReceiveStream): it is the dangerous ordering, made
 * deterministic, and it shows why a link with no RTX cannot hit it.
 *
 * #559 keeps RTX wherever the engine is known to be past the bug: an affected
 * engine leaves RTX out of its own list, and since only the offerer is
 * exposed and an RTX-free offer cannot be answered with RTX, that covers every
 * link it is on. The user agents below are the shapes our players send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { encodeChannelMessage, encodePeerConnectionSignal, USE_CASE_RENEGOTIATION } from "@jollity/statement-core"
import { FakePC, sdp, setupMesh } from "./test-pc"
import type { Mesh } from "./mesh"
import type { RtcEvent } from "./rtc-events"

const codec = (mimeType: string, sdpFmtpLine?: string): RTCRtpCodec => ({ mimeType, clockRate: 90000, ...(sdpFmtpLine ? { sdpFmtpLine } : {}) })
const VP8 = codec("video/VP8")
const VP8_RTX = codec("video/rtx", "apt=96")
const H264_BASE = codec("video/H264", "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f")
const H264_BASE_RTX = codec("video/rtx", "apt=102")
const H264_HIGH = codec("video/H264", "level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=640c1f")
const RED = codec("video/red")
const RED_RTX = codec("video/rtx", "apt=116")
const ULPFEC = codec("video/ulpfec")
const isRtx = (c: RTCRtpCodec) => c.mimeType.toLowerCase() === "video/rtx"

/** libwebrtc M120's receive-SSRC bookkeeping for one video m-section, the
 *  parts that decide this failure. Streams are keyed by their primary SSRC;
 *  every SSRC a stream holds, RTX included, is claimed. */
function m120() {
  const streams = new Map<number, { ssrcs: number[]; isDefault: boolean }>()
  const claimed = new Set<number>()
  const add = (ssrcs: number[], isDefault: boolean): boolean => {
    for (const ssrc of ssrcs) {
      const prev = streams.get(ssrc)
      if (!prev) continue
      if (isDefault || !prev.isDefault) return false
      prev.ssrcs.forEach((s) => claimed.delete(s))
      streams.delete(ssrc)
    }
    if (ssrcs.some((s) => claimed.has(s))) return false // ValidateReceiveSsrcAvailability
    ssrcs.forEach((s) => claimed.add(s))
    streams.set(ssrcs[0]!, { ssrcs: [...ssrcs], isDefault })
    return true
  }
  const recreateDefault = (ssrcs: number[]) => {
    for (const [key, stream] of streams) {
      if (!stream.isDefault) continue
      stream.ssrcs.forEach((s) => claimed.delete(s))
      streams.delete(key)
    }
    add(ssrcs, true)
  }
  return {
    /** an early packet on an SSRC the descriptions have not named yet */
    early(ssrc: number, rtx: boolean) {
      if ([...streams.values()].some((s) => s.ssrcs.includes(ssrc))) return
      if (rtx && ![...streams.values()].some((s) => s.isDefault)) recreateDefault([14795, ssrc]) // M111–M123 only
      else if (!rtx) recreateDefault([ssrc])
    },
    /** the answer is applied: BaseChannel → AddRecvStream(signaled) */
    signal: (ssrcs: number[]) => add(ssrcs, false),
  }
}

describe("the M120 receive rule (the dangerous ordering)", () => {
  const MEDIA = 4041477088
  const RTX = 1234567

  it("refuses an answer whose RTX SSRC probed in before any media packet", () => {
    const channel = m120()
    channel.early(RTX, true)
    expect(channel.signal([MEDIA, RTX])).toBe(false)
  })

  it("accepts the same answer once a media packet came first", () => {
    const channel = m120()
    channel.early(MEDIA, false)
    channel.early(RTX, true)
    expect(channel.signal([MEDIA, RTX])).toBe(true)
  })

  it("accepts an answer without RTX however early its packets come", () => {
    const channel = m120()
    channel.early(MEDIA, false)
    expect(channel.signal([MEDIA])).toBe(true)
    expect(m120().signal([MEDIA])).toBe(true)
  })
})

describe("the video codec preferences (#497)", () => {
  it("put the sendable baseline H.264 first and leave every RTX out", async () => {
    const { videoCodecPreferences } = await import("./mesh")
    const recv = [VP8, VP8_RTX, H264_HIGH, H264_BASE, H264_BASE_RTX, RED, RED_RTX, ULPFEC]
    const prefs = videoCodecPreferences(recv, [H264_HIGH, H264_BASE, VP8])
    expect(prefs).toEqual([H264_BASE, H264_HIGH, VP8, RED, ULPFEC])
  })

  it("leave RTX out when the browser has no H.264 to send", async () => {
    const { videoCodecPreferences } = await import("./mesh")
    expect(videoCodecPreferences([VP8, VP8_RTX, RED, RED_RTX, ULPFEC], [VP8])).toEqual([VP8, RED, ULPFEC])
    expect(videoCodecPreferences([VP8, VP8_RTX], null)).toEqual([VP8])
  })
})

const UA = {
  ios17: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  ios16: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  ios18: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  ipad17: "Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  crios17: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1",
  safari17: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  safari18: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
  macWebView: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  androidWebView: "Mozilla/5.0 (Linux; Android 16; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36",
  androidOld: "Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36",
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0",
}

describe("which engines keep RTX (#559)", () => {
  it.each([
    ["iOS 18 WKWebView", UA.ios18, true],
    ["Android WebView on Chromium 141", UA.androidWebView, true],
    ["desktop Chrome 141", UA.chromeMac, true],
    ["Safari 18", UA.safari18, true],
    ["iOS 17 WKWebView", UA.ios17, false],
    ["iOS 16", UA.ios16, false],
    ["iPadOS 17", UA.ipad17, false],
    ["Chrome on iOS 17 (WebKit underneath)", UA.crios17, false],
    ["Safari 17", UA.safari17, false],
    ["Android WebView on Chromium 120 (M111–M123)", UA.androidOld, false],
    ["a macOS WKWebView with no version", UA.macWebView, false],
    ["Firefox", UA.firefox, false],
    ["no user agent", "", false],
  ])("%s", async (_label, ua, safe) => {
    const { rtxSafeEngine } = await import("./mesh")
    expect(rtxSafeEngine(ua)).toBe(safe)
  })

  it("never trusts a Chrome token on a WebKit engine (a host spoofing desktop Chrome on an iPhone)", async () => {
    const { rtxSafeEngine } = await import("./mesh")
    expect(rtxSafeEngine(UA.chromeMac, "Apple Computer, Inc.")).toBe(false)
    expect(rtxSafeEngine(UA.chromeMac, "Google Inc.")).toBe(true)
    expect(rtxSafeEngine(UA.safari18, "Apple Computer, Inc.")).toBe(true)
    expect(rtxSafeEngine(UA.ios18, "Apple Computer, Inc.")).toBe(true)
  })

  it("keeps every RTX entry, in place, when the engine is safe", async () => {
    const { videoCodecPreferences } = await import("./mesh")
    const recv = [VP8, VP8_RTX, H264_HIGH, H264_BASE, H264_BASE_RTX, RED, RED_RTX, ULPFEC]
    const prefs = videoCodecPreferences(recv, [H264_HIGH, H264_BASE, VP8], true)
    expect(prefs).toEqual([H264_BASE, H264_HIGH, VP8, VP8_RTX, H264_BASE_RTX, RED, RED_RTX, ULPFEC])
  })
})

const sendLane = (pc: FakePC, tag: "Offer" | "Answer", value: string) => {
  const frame = encodeChannelMessage({ id: USE_CASE_RENEGOTIATION, data: encodePeerConnectionSignal({ tag, value }) })
  ;(pc.channels[0]!.onmessage as (event: { data: unknown }) => void)({ data: new Uint8Array(frame).buffer })
}

/** a camera with one video track, and a PC that records the codecs its transceiver is given */
function camera() {
  const track = { kind: "video" } as MediaStreamTrack
  return { getVideoTracks: () => [track], getTracks: () => [track] }
}
function recordCodecs(pc: FakePC) {
  const prefs: RTCRtpCodec[][] = []
  const sender = { getParameters: () => ({ encodings: [] }), setParameters: async () => {} }
  const transceiver = { sender, setCodecPreferences: (codecs: RTCRtpCodec[]) => prefs.push(codecs) }
  const senders: unknown[] = []
  Object.assign(pc, {
    addTrack: () => (senders.push(sender), sender),
    getSenders: () => senders,
    getTransceivers: () => (senders.length ? [transceiver] : []),
  })
  return prefs
}

describe("a link's tracks are added with RTX-free codecs on an unknown engine (#497)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it.each([
    ["with H.264", [H264_BASE, H264_BASE_RTX, VP8, VP8_RTX], [H264_BASE, VP8]],
    ["without H.264", [VP8, VP8_RTX, RED, RED_RTX], [VP8, RED]],
  ])("when the channel opens, %s", async (_label, recv, want) => {
    vi.stubGlobal("navigator", { userAgent: "" })
    vi.stubGlobal("RTCRtpReceiver", { getCapabilities: () => ({ codecs: recv, headerExtensions: [] }) })
    vi.stubGlobal("RTCRtpSender", { getCapabilities: () => ({ codecs: recv.filter((c) => !isRtx(c)), headerExtensions: [] }) })
    const { mesh, pc } = await setupMesh("a", "b", {}, camera())
    const prefs = recordCodecs(pc)
    pc.channels[0]!.readyState = "open"
    ;(pc.channels[0]!.onopen as () => void)()
    expect(prefs).toEqual([want])
    mesh.close()
  })
})

describe("a link's codecs follow this browser's engine (#559)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it.each([
    ["an iOS 17 phone leaves RTX out", UA.ios17, [H264_BASE, VP8]],
    ["an iOS 18 phone keeps it", UA.ios18, [H264_BASE, H264_BASE_RTX, VP8, VP8_RTX]],
    ["an Android WebView keeps it", UA.androidWebView, [H264_BASE, H264_BASE_RTX, VP8, VP8_RTX]],
  ])("%s", async (_label, ua, want) => {
    const recv = [H264_BASE, H264_BASE_RTX, VP8, VP8_RTX]
    vi.stubGlobal("navigator", { userAgent: ua })
    vi.stubGlobal("RTCRtpReceiver", { getCapabilities: () => ({ codecs: recv, headerExtensions: [] }) })
    vi.stubGlobal("RTCRtpSender", { getCapabilities: () => ({ codecs: recv.filter((c) => !isRtx(c)), headerExtensions: [] }) })
    const { mesh, pc } = await setupMesh("a", "b", {}, camera())
    const prefs = recordCodecs(pc)
    pc.channels[0]!.readyState = "open"
    ;(pc.channels[0]!.onopen as () => void)()
    expect(prefs).toEqual([want])
    mesh.close()
  })
})

describe("a same-pair regroup (#497)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("brings the new link's media up while the old one closes, without spending the negotiation rebuild", async () => {
    const events: RtcEvent[] = []
    const onRtcEvent = (_peer: string, event: RtcEvent) => events.push(event)
    const { mesh: round1, pc: old } = await setupMesh("a", "b", { onRtcEvent })
    round1.setRound(1)
    old.channels[0]!.readyState = "open"
    await old.onnegotiationneeded!()
    sendLane(old, "Answer", sdp("222", { media: ["video"] }))
    await vi.waitFor(() => expect(old.signalingState).toBe("stable"))

    // the round-2 room: a new mesh forms for the same pair as the old one closes
    const MeshClass = round1.constructor as typeof Mesh
    const local = { getVideoTracks: () => [], getTracks: () => [] } as unknown as MediaStream
    const round2 = new MeshClass("a", local, {}, () => {}, () => {}, () => {}, () => {}, { onRtcEvent })
    round2.setRound(2)
    round2.addPeer("b")
    round1.close()
    const fresh = FakePC.last[1]!
    expect(old.close).toHaveBeenCalled()

    fresh.channels[0]!.readyState = "open"
    await fresh.onnegotiationneeded!()
    expect(fresh.signalingState).toBe("have-local-offer")
    sendLane(fresh, "Answer", sdp("333", { media: ["video"] }))
    await vi.waitFor(() => expect(fresh.signalingState).toBe("stable"))

    expect(events.filter((e) => e.kind === "negotiation_error")).toEqual([])
    expect(FakePC.last).toHaveLength(2)
    round2.close()
  })
})

/**
 * Real SDP, not the fake PC's: headless Chrome 153 (Playwright) ran the
 * shipped videoCodecPreferences on its own capabilities, set them on a
 * transceiver carrying a canvas track, and wrote a lane offer, plus an answer
 * to a stock offer that still carries RTX (a native or older peer). The stock
 * offer is kept beside them to show what the preference path removes.
 * Re-capture after changing videoCodecPreferences: the first test fails until
 * the fixture matches the function again.
 */
describe("the lane SDP a real browser writes with these preferences (#497)", () => {
  it("is captured from the current videoCodecPreferences", async () => {
    const { videoCodecPreferences } = await import("./mesh")
    const { default: fixture } = await import("./fixtures/chrome-lane-sdp.json")
    expect(videoCodecPreferences(fixture.recv, fixture.send)).toEqual(fixture.prefs)
  })

  it("negotiates no RTX payload and no FID group in the offer or the answer, while the stock offer had both", async () => {
    const { default: fixture } = await import("./fixtures/chrome-lane-sdp.json")
    expect(fixture.stockOffer).toMatch(/rtx\/90000/)
    expect(fixture.stockOffer).toMatch(/a=ssrc-group:FID/)
    for (const sdp of [fixture.laneOffer, fixture.laneAnswer]) {
      expect(sdp).toMatch(/^m=video /m)
      expect(sdp).toMatch(/^a=ssrc:\d+ /m) // it still sends video, on one SSRC
      expect(sdp).not.toMatch(/rtx\/90000/)
      expect(sdp).not.toMatch(/a=ssrc-group:FID/)
    }
  })
})

/**
 * The exposed side's second layer (#559). An RTX-unsafe offerer is kept out of
 * game 228 by its own codec preferences alone; when they do not hold, the
 * lane offer is rewritten without RTX before it is sent, and telemetry says
 * which way they failed.
 */
describe("stripVideoRtx (#559)", () => {
  it("takes every video RTX payload type, the FID group and the RTX SSRC out of a real Chrome offer", async () => {
    const { stripVideoRtx } = await import("./mesh")
    const { default: fixture } = await import("./fixtures/chrome-lane-sdp.json")
    const stripped = stripVideoRtx(fixture.stockOffer)
    expect(stripped).not.toMatch(/rtx\/90000/)
    expect(stripped).not.toMatch(/a=ssrc-group:FID/)
    expect(stripped).not.toMatch(/^a=(?:rtpmap|fmtp|rtcp-fb):(?:97|103|119) /m)
    expect(stripped).toMatch(/^m=video 9 UDP\/TLS\/RTP\/SAVPF 96 102 104 108 114 116 39 45 98 100 118 120\r?$/m)
    expect(stripped).toMatch(/^a=ssrc:4040790161 cname:/m) // the media SSRC stays
    expect(stripped).not.toMatch(/^a=ssrc:3177631953 /m) // the RTX one goes
    expect(stripped).toMatch(/^a=rtpmap:118 red\/90000/m) // RED and ULPFEC ride the media SSRC
    expect(stripped).toMatch(/^m=application 9 UDP\/DTLS\/SCTP webrtc-datachannel/m)
    expect(stripped.includes("\r\n")).toBe(fixture.stockOffer.includes("\r\n"))
  })

  it("leaves an SDP without RTX as it was", async () => {
    const { stripVideoRtx } = await import("./mesh")
    const { default: fixture } = await import("./fixtures/chrome-lane-sdp.json")
    expect(stripVideoRtx(fixture.laneOffer)).toBe(fixture.laneOffer)
  })
})

describe("the offer guard on an RTX-unsafe engine (#559)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** a PC whose browser ignores the codec preferences: its offer carries RTX */
  async function rtxOfferer(ua: string, vendor: string) {
    vi.stubGlobal("navigator", { userAgent: ua, vendor })
    const { default: fixture } = await import("./fixtures/chrome-lane-sdp.json")
    const events: RtcEvent[] = []
    const { mesh, pc } = await setupMesh("a", "b", { onRtcEvent: (_peer: string, event: RtcEvent) => events.push(event) })
    const calls: string[] = []
    pc.setLocalDescription = async (desc?: { type: string; sdp?: string }) => {
      calls.push(desc?.type ?? "implicit")
      if (desc?.type === "rollback") {
        pc.localDescription = null
        pc.signalingState = "stable"
        return
      }
      pc.localDescription = { type: "offer", sdp: desc?.sdp ?? fixture.stockOffer }
      pc.signalingState = "have-local-offer"
    }
    Object.assign(pc, { createOffer: async () => ({ type: "offer", sdp: fixture.stockOffer }) })
    pc.channels[0]!.readyState = "open"
    await pc.onnegotiationneeded!()
    const sent = (pc.channels[0]!.send.mock.calls as unknown[][]).map(([bytes]) => new TextDecoder("latin1").decode(bytes as Uint8Array))
    return { mesh, pc, events, calls, sent }
  }

  it("rolls the RTX offer back and sends one without RTX, the same text it set locally", async () => {
    const { mesh, pc, events, calls, sent } = await rtxOfferer(UA.ios17, "Apple Computer, Inc.")
    expect(calls).toEqual(["implicit", "rollback", "offer"])
    expect(pc.signalingState).toBe("have-local-offer")
    expect(pc.localDescription!.sdp).not.toMatch(/rtx\/90000/)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain("m=video")
    expect(sent[0]).not.toContain("rtx/90000")
    expect(sent[0]).toContain(pc.localDescription!.sdp.split(/\r?\n/).find((l) => l.startsWith("m=video"))!)
    expect(events).toContainEqual({ kind: "codec_guard", reason: "offer-rtx" })
    mesh.close()
  })

  it("sends a safe engine's RTX offer untouched", async () => {
    const { mesh, events, calls, sent } = await rtxOfferer(UA.androidWebView, "Google Inc.")
    expect(calls).toEqual(["implicit"])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain("rtx/90000")
    expect(events.filter((e) => e.kind === "codec_guard")).toEqual([])
    mesh.close()
  })

  it.each([
    ["missing", UA.ios17, "prefs-missing", undefined],
    ["refused", UA.ios17, "prefs-refused", () => {
      throw new DOMException("bad codec", "InvalidModificationError")
    }],
    ["missing on a safe engine", UA.androidWebView, null, undefined],
  ])("says when the codec preferences are %s", async (_label, ua, reason, setCodecPreferences) => {
    vi.stubGlobal("navigator", { userAgent: ua, vendor: "" })
    vi.stubGlobal("RTCRtpReceiver", { getCapabilities: () => ({ codecs: [VP8, VP8_RTX], headerExtensions: [] }) })
    vi.stubGlobal("RTCRtpSender", { getCapabilities: () => ({ codecs: [VP8], headerExtensions: [] }) })
    const events: RtcEvent[] = []
    const { mesh, pc } = await setupMesh("a", "b", { onRtcEvent: (_peer: string, event: RtcEvent) => events.push(event) }, camera())
    const sender = { getParameters: () => ({ encodings: [] }), setParameters: async () => {} }
    const transceiver = { sender, ...(setCodecPreferences ? { setCodecPreferences } : {}) }
    Object.assign(pc, { addTrack: () => sender, getTransceivers: () => [transceiver] })
    pc.channels[0]!.readyState = "open"
    ;(pc.channels[0]!.onopen as () => void)()
    expect(events.filter((e) => e.kind === "codec_guard")).toEqual(reason ? [{ kind: "codec_guard", reason }] : [])
    mesh.close()
  })
})
