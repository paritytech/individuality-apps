// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { decodeLoad, keyFramesEncoded, readStats, relayPairEvidenceSignature, rtcRates, type RtcSample } from "./rtc-stats"
import { turnTransport } from "./path-mode"
import { chromeStats, first, second } from "./test-stats"

describe("readStats, the negotiated codec (#556)", () => {
  const h264 = { type: "codec", id: "C1", mimeType: "video/H264", sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f" }
  const vp8 = { type: "codec", id: "C2", mimeType: "video/VP8" }
  const rtp = (type: string, codecId?: string) => ({ type, id: `${type}-v`, kind: "video", ...(codecId ? { codecId } : {}) })

  it("follows both codecIds to the codec report and trims the fmtp", () => {
    const { quality } = readStats(new Map<string, unknown>([["C1", h264], ["C2", vp8], ["i", rtp("inbound-rtp", "C2")], ["o", rtp("outbound-rtp", "C1")]]), 1)
    expect(quality.inbound).toMatchObject({ codec: "VP8" })
    expect(quality.inbound?.codecFmtp).toBeUndefined()
    expect(quality.outbound).toMatchObject({ codec: "H264", codecFmtp: "packetization-mode=1;profile-level-id=640c1f" })
  })

  it("leaves the codec out when codecId is missing or names no report", () => {
    const { quality } = readStats(new Map<string, unknown>([["C1", h264], ["i", rtp("inbound-rtp")], ["o", rtp("outbound-rtp", "gone")]]), 1)
    expect(quality.inbound?.codec).toBeUndefined()
    expect(quality.outbound?.codec).toBeUndefined()
    expect(quality.outbound?.codecFmtp).toBeUndefined()
  })
})

describe("readStats", () => {
  it("treats a rebuilt peer connection as a new relay lifecycle even when its pair id is reused", () => {
    const shared = { transportId: "CPa", pairState: "succeeded", localType: "relay", relayEndpoint: "turn:relay.example:3478" }
    expect(relayPairEvidenceSignature({ link: 1, ...shared })).not.toBe(relayPairEvidenceSignature({ link: 2, ...shared }))
  })
  it("counts the frames of every inbound video stream of the link", () => {
    const report = (...decoded: number[]) => new Map(decoded.map((n, i) => [`IT${i}`, { type: "inbound-rtp", kind: "video", id: `IT${i}`, framesDecoded: n }]))
    expect(readStats(report(200), 1).frames).toBe(200)
    expect(readStats(report(200, 0), 1).frames).toBe(200) // an idle receiver beside the live one
    expect(readStats(report(0, 200), 1).frames).toBe(200) // in either order
    expect(readStats(report(200, 50), 1).frames).toBe(250) // a stream replacing another, both still listed
  })

  it("reads the pair and the quality off the transport's selected pair", () => {
    const read = readStats(first, 1)
    // CPb (host/host) comes first in the report, but CPa (relay/srflx) is the
    // one the transport selected: rtc.path must say relay
    expect(read.pair).toBe("relay/srflx")
    expect(read.frames).toBe(200)
    const sample = read.quality
    expect(sample.link).toBe(1)
    expect(sample.at).toBe(10_000)
    // the transport's selected pair, not the first nominated one
    expect(sample.rttMs).toBeCloseTo(182)
    expect(sample.outgoingKbps).toBe(1250)
    expect(sample).toMatchObject({ transportId: "CPa", transportBytesSent: 1_100_000, transportAllowanceBytesSent: 138_000 })
    expect(sample).toMatchObject({ localType: "relay", remoteType: "srflx", networkType: "cellular", protocol: "udp", relayProtocol: "tls" })
    expect(sample).toMatchObject({
      pairState: "succeeded",
      nominated: true,
      relayHost: "turn.example.org",
      relayEndpoint: "turn:turn.example.org:3478?transport=tcp",
      transportBytesReceived: 2_200_000,
      transportPacketsSent: 1_000,
      transportPacketsReceived: 2_000,
      requestsSent: 14,
      responsesReceived: 13,
      consentRequestsSent: 9,
      lastPacketReceivedAt: 9_988,
    })
    expect(JSON.stringify(sample)).not.toContain("user:secret")
    expect(sample.inbound).toEqual({
      id: "IT01V",
      fps: 22,
      width: 480,
      height: 640,
      framesDecoded: 200,
      framesDropped: 3,
      freezeCount: 1,
      totalFreezesDuration: 0.2,
      jitterMs: 12,
      packetsLost: 10,
      packetsReceived: 990,
      nackCount: 10,
      pliCount: 1,
      jitterBufferDelay: 10,
      jitterBufferEmittedCount: 200,
      totalDecodeTime: 0.8,
      decoderImplementation: "libvpx",
      powerEfficientDecoder: false,
    })
    expect(sample.outbound).toEqual({
      id: "OT01V",
      fps: 24,
      width: 360,
      height: 480,
      framesEncoded: 1000,
      qualityLimitationReason: "cpu",
      qualityLimitationDurations: { none: 10, cpu: 1, bandwidth: 0, other: 0 },
      bytesSent: 1_000_000,
      retransmittedPacketsSent: 4,
      packetsSent: 900,
      nackCount: 20,
      pliCount: 2,
      totalEncodeTime: 6,
      encoderImplementation: "OpenH264",
      powerEfficientEncoder: false,
    })
  })

  it("keeps a credential-free IPv6 TURN endpoint", () => {
    const stats = new Map(first)
    stats.set("Irelay", { ...(stats.get("Irelay") as Record<string, unknown>), url: "turns:user:password@[2001:db8::1]:5349?transport=TCP" })
    const sample = readStats(stats, 1).quality
    expect(sample.relayHost).toBe("[2001:db8::1]")
    expect(sample.relayEndpoint).toBe("turns:[2001:db8::1]:5349?transport=tcp")
    expect(JSON.stringify(sample)).not.toContain("password")
  })

  // WebKit reports no relayProtocol, so an iPhone's relay is known only from
  // the TURN url. The reader's own copy of the url rule must say what
  // turnTransport (path-mode, which picks the ICE servers) says of each url.
  it.each([
    "turn:user:secret@turn.example.org:3478?transport=tcp",
    "turns:u:p@turn.example.org:5349?transport=tcp",
    "turn:turn.example.net:3478?transport=udp",
    "turns:user:password@[2001:db8::1]:5349?transport=TCP",
    "turn:turn.cloudflare.com:3478",
    "turn:turn.cloudflare.com:3478?transport=tcp",
    "turn:turn.cloudflare.com:80?transport=tcp",
    "turns:turn.cloudflare.com:5349?transport=tcp",
    "TURN:turn.cloudflare.com:3478?transport=TCP",
  ])("names the relay transport of %s as turnTransport does", (url) => {
    const stats = new Map(first)
    stats.set("Irelay", { ...(stats.get("Irelay") as Record<string, unknown>), url })
    expect(readStats(stats, 1).quality.relayTransport).toBe(turnTransport(url))
  })

  it("names no relay transport for a url that is not a TURN server's", () => {
    const stats = new Map(first)
    stats.set("Irelay", { ...(stats.get("Irelay") as Record<string, unknown>), url: "stun:stun.example.org:3478" })
    expect(readStats(stats, 1).quality).not.toHaveProperty("relayTransport")
  })

  it("falls back to the nominated pair when no transport names one (Safari)", () => {
    const stats = chromeStats({ t: 1, decoded: 0, lost: 0, received: 0, bytesSent: 0, freezes: 0, cpu: 0 })
    stats.delete("T01")
    stats.set("CPa", { ...stats.get("CPa")!, nominated: false, state: "in-progress" }) // only CPb is in use
    const sample = readStats(stats, 1).quality
    expect(sample.rttMs).toBeCloseTo(4)
    expect(sample.localType).toBe("host")
    expect(readStats(stats, 1).pair).toBe("host/host")
  })

  it("aggregates every transport's selected pair and keeps the most conservative packet allowance", () => {
    const stats = new Map(second)
    stats.set("T02", { type: "transport", id: "T02", selectedCandidatePairId: "CPc" })
    stats.set("CPc", { type: "candidate-pair", id: "CPc", localCandidateId: "Ihost", remoteCandidateId: "Rhost", bytesSent: 500_000, packetsSent: 500 })
    const sample = readStats(stats, 1).quality
    expect(sample).toMatchObject({
      transportId: "CPa\u001fCPc",
      transportBytesSent: 1_765_000,
      transportAllowanceBytesSent: 182_700,
    })
  })

  it("picks the same pair however a transport-less (Safari) report orders two succeeded ones", () => {
    const make = (order: string[]) => {
      const stats = chromeStats({ t: 1, decoded: 0, lost: 0, received: 0, bytesSent: 0, freezes: 0, cpu: 0 })
      stats.delete("T01")
      const pairs = new Map(order.map((id) => [id, stats.get(id)!]))
      for (const id of ["CPa", "CPb"]) stats.delete(id)
      for (const [id, pair] of pairs) stats.set(id, { ...pair, nominated: false })
      return stats
    }
    // both pairs succeeded and neither is nominated or selected: the report's order must not decide
    expect(readStats(make(["CPa", "CPb"]), 1).pair).toBe(readStats(make(["CPb", "CPa"]), 1).pair)
  })

  it("prefers a nominated pair over one that merely succeeded, whatever the order", () => {
    const stats = chromeStats({ t: 1, decoded: 0, lost: 0, received: 0, bytesSent: 0, freezes: 0, cpu: 0 })
    stats.delete("T01")
    stats.set("CPb", { ...stats.get("CPb")!, nominated: false })
    expect(readStats(stats, 1).pair).toBe("relay/srflx") // CPa is nominated, although CPb comes first
  })

  it("leaves the protocol out when the browser does not report it (WebKit has no relayProtocol)", () => {
    const stats = chromeStats({ t: 1, decoded: 0, lost: 0, received: 0, bytesSent: 0, freezes: 0, cpu: 0 })
    const relay = stats.get("Irelay") as Record<string, unknown>
    delete relay.protocol
    delete relay.relayProtocol
    const sample = readStats(stats, 1).quality
    expect(sample.localType).toBe("relay")
    expect(sample.protocol).toBeUndefined()
    expect(sample.relayProtocol).toBeUndefined()
  })

  it("leaves out the stats a browser does not report, rather than inventing them", () => {
    const stats = chromeStats({ t: 10_000, decoded: 200, lost: 10, received: 990, bytesSent: 1_000_000, freezes: 0.2, cpu: 1 })
    for (const id of ["IT01V", "OT01V"])
      for (const key of ["nackCount", "pliCount", "jitterBufferDelay", "jitterBufferEmittedCount", "totalDecodeTime", "totalEncodeTime", "decoderImplementation", "encoderImplementation", "powerEfficientDecoder", "powerEfficientEncoder"])
        delete (stats.get(id) as Record<string, unknown>)[key]
    const sample = readStats(stats, 1).quality
    expect(sample.inbound).not.toHaveProperty("decoderImplementation")
    expect(sample.inbound).not.toHaveProperty("totalDecodeTime")
    expect(sample.outbound).not.toHaveProperty("nackCount")
    expect(sample.outbound).not.toHaveProperty("powerEfficientEncoder")
  })

  it("reads outbound frames sent and track identifier for camera diagnostics", () => {
    const stats = chromeStats({ t: 1, decoded: 0, lost: 0, received: 0, bytesSent: 0, freezes: 0, cpu: 0 })
    const outbound = stats.get("OT01V") as Record<string, unknown>
    outbound.framesSent = 77
    outbound.trackIdentifier = "browser-track-id"
    expect(readStats(stats, 1).quality.outbound).toMatchObject({ framesSent: 77, trackIdentifier: "browser-track-id" })
  })

  it("reads the outbound encoder target bitrate and leaves it absent when unsupported", () => {
    const stats = chromeStats({ t: 1, decoded: 0, lost: 0, received: 0, bytesSent: 0, freezes: 0, cpu: 0 })
    const outbound = stats.get("OT01V") as Record<string, unknown>
    outbound.targetBitrate = 45_000
    expect(readStats(stats, 1).quality.outbound).toMatchObject({ targetBitrate: 45_000 })
    delete outbound.targetBitrate
    expect(readStats(stats, 1).quality.outbound).not.toHaveProperty("targetBitrate")
  })

  it("reads cumulative send queue and header-byte counters", () => {
    const stats = chromeStats({ t: 1, decoded: 0, lost: 0, received: 0, bytesSent: 0, freezes: 0, cpu: 0 })
    const outbound = stats.get("OT01V") as Record<string, unknown>
    outbound.totalPacketSendDelay = 1.25
    outbound.headerBytesSent = 4321
    expect(readStats(stats, 1).quality.outbound).toMatchObject({ totalPacketSendDelay: 1.25, headerBytesSent: 4321 })
  })

  it("reads an empty report as nothing", () => {
    expect(readStats(new Map(), 1)).toEqual({ pair: undefined, frames: undefined, quality: { link: 1 } })
  })
})

describe("rtcRates", () => {
  const queued = (
    at: number,
    values: Partial<NonNullable<RtcSample["outbound"]>>,
    link = 1,
  ): RtcSample => ({
    link,
    at,
    outbound: { id: "outbound-video", ...values },
  })

  it("derives packet queue milliseconds per sent packet and encode seconds", () => {
    const prev = queued(1_000, { packetsSent: 100, totalPacketSendDelay: 1, framesEncoded: 50, framesSent: 48, totalEncodeTime: 2 })
    const cur = queued(4_000, { packetsSent: 120, totalPacketSendDelay: 1.4, framesEncoded: 60, framesSent: 58, totalEncodeTime: 2.3 })
    const rates = rtcRates(prev, cur)
    expect(rates).toMatchObject({
      windowMs: 3_000,
      packetsSent: 20,
      framesEncoded: 10,
      framesSent: 10,
    })
    expect(rates.queueMsPerPacket).toBeCloseTo(20)
    expect(rates.encodeMs).toBeCloseTo(30)
    expect(rates.encodeSeconds).toBeCloseTo(0.3)
  })

  it.each([
    ["counter reset", queued(1_000, { packetsSent: 120, totalPacketSendDelay: 2 }), queued(4_000, { packetsSent: 2, totalPacketSendDelay: 0.01 })],
    ["no packets", queued(1_000, { packetsSent: 10, totalPacketSendDelay: 1 }), queued(4_000, { packetsSent: 10, totalPacketSendDelay: 1.2 })],
    ["missing delay", queued(1_000, { packetsSent: 10 }), queued(4_000, { packetsSent: 20 })],
  ])("leaves queue unknown for %s", (_name, prev, cur) => {
    expect(rtcRates(prev, cur).queueMsPerPacket).toBeUndefined()
  })

  it("treats link changes and throttled timer gaps as baseline-only", () => {
    const prev = queued(1_000, { packetsSent: 10, totalPacketSendDelay: 1, totalEncodeTime: 1, framesEncoded: 10 })
    const gap = queued(8_001, { packetsSent: 20, totalPacketSendDelay: 2, totalEncodeTime: 2, framesEncoded: 20 })
    const changed = queued(4_000, { packetsSent: 20, totalPacketSendDelay: 2, totalEncodeTime: 2, framesEncoded: 20 }, 2)
    expect(rtcRates(prev, gap)).toMatchObject({ limited: {} })
    expect(rtcRates(prev, gap).windowMs).toBeUndefined()
    expect(rtcRates(prev, gap).encodeSeconds).toBeUndefined()
    expect(rtcRates(prev, changed).windowMs).toBeUndefined()
  })

  it("treats an outbound stream change as baseline-only", () => {
    const prev = queued(1_000, { packetsSent: 10, totalPacketSendDelay: 1, totalEncodeTime: 1, framesEncoded: 10 })
    const changed: RtcSample = {
      link: 1,
      at: 4_000,
      outbound: { id: "replacement-video", packetsSent: 20, totalPacketSendDelay: 2, totalEncodeTime: 2, framesEncoded: 20 },
    }
    expect(rtcRates(prev, changed).windowMs).toBeUndefined()
    expect(rtcRates(prev, changed).queueMsPerPacket).toBeUndefined()
  })

  it("turns two consecutive samples into rates over the window", () => {
    const rates = rtcRates(readStats(first, 1).quality, readStats(second, 1).quality)
    expect(rates.rttMs).toBeCloseTo(182)
    expect(rates.jitterMs).toBeCloseTo(12)
    // 12 lost of 600 in the window, not the cumulative 22 of 1600
    expect(rates.lossPct).toBeCloseTo(2)
    expect(rates.inFps).toBe(22)
    expect(rates.outFps).toBe(24)
    expect(rates.inHeight).toBe(640)
    expect(rates.outHeight).toBe(480)
    // 150 000 bytes in 3 s
    expect(rates.outKbps).toBeCloseTo(400)
    expect(rates.freezeMs).toBeCloseTo(450)
    expect(rates.limited).toEqual({ cpu: 1.5 })
  })

  it("has no windowed rates for a first sample, but keeps the instant ones", () => {
    const rates = rtcRates(undefined, readStats(first, 1).quality)
    expect(rates.rttMs).toBeCloseTo(182)
    expect(rates.inFps).toBe(22)
    expect(rates.lossPct).toBeUndefined()
    expect(rates.outKbps).toBeUndefined()
    expect(rates.freezeMs).toBeUndefined()
    expect(rates.limited).toEqual({})
  })

  it("keeps the instantaneous encoder target without requiring a prior sample", () => {
    expect(rtcRates(undefined, { link: 1, at: 1_000, outbound: { id: "video", targetBitrate: 45_000 } }).targetKbps).toBe(45)
  })

  it("never subtracts a rebuilt connection's counters from the old one's", () => {
    const rebuilt = readStats(chromeStats({ t: 16_000, decoded: 900, lost: 50, received: 5_000, bytesSent: 9_000_000, freezes: 3, cpu: 9 }), 2).quality
    const rates = rtcRates(readStats(second, 1).quality, rebuilt)
    expect(rates.lossPct).toBeUndefined()
    expect(rates.outKbps).toBeUndefined()
    expect(rates.limited).toEqual({})
  })

  it("drops a counter that went backwards", () => {
    const reset = readStats(chromeStats({ t: 16_000, decoded: 10, lost: 0, received: 20, bytesSent: 5_000, freezes: 0, cpu: 0 }), 1).quality
    const rates = rtcRates(readStats(second, 1).quality, reset)
    expect(rates.lossPct).toBeUndefined()
    expect(rates.outKbps).toBeUndefined()
    expect(rates.freezeMs).toBeUndefined()
  })

  it("derives fps from frame counts where the browser gives no framesPerSecond", () => {
    const strip = (sample: RtcSample): RtcSample => ({ ...sample, inbound: { ...sample.inbound!, fps: undefined } })
    const rates = rtcRates(strip(readStats(first, 1).quality), strip(readStats(second, 1).quality))
    expect(rates.inFps).toBeCloseTo(22)
  })

  it("reads each reason the encoder was limited by in the window", () => {
    const later = readStats(chromeStats({ t: 16_000, decoded: 330, lost: 22, received: 2_000, bytesSent: 1_300_000, freezes: 0.65, cpu: 2.5, bandwidth: 2 }), 1).quality
    expect(rtcRates(readStats(second, 1).quality, later).limited).toEqual({ bandwidth: 2 })
  })
})

describe("rtcRates, network versus device", () => {
  const rates = rtcRates(readStats(first, 1).quality, readStats(second, 1).quality)

  it("reads the window's dropped frames, NACKs and PLIs, in and out", () => {
    // framesDropped stays 3 in the fixture: nothing was dropped in the window
    expect(rates.framesDropped).toBe(0)
    // inbound: NACKs we sent (12 more lost); outbound: NACKs the peer sent us
    expect(rates.nackIn).toBe(12)
    expect(rates.nackOut).toBe(3)
    expect(rates.pliIn).toBe(0)
    expect(rates.pliOut).toBe(0)
  })

  it("reads per-frame jitter buffer, decode and encode time over the window", () => {
    expect(rates.bufferMs).toBeCloseTo(50)
    expect(rates.decodeMs).toBeCloseTo(4)
    expect(rates.encodeMs).toBeCloseTo(6)
  })

  it("reads the available outgoing bitrate of the selected pair", () => {
    expect(rates.availKbps).toBe(1250)
  })

  it("reads selected-pair byte growth without crossing a pair change", () => {
    expect(rates.transportBytesSent).toBe(165_000)
    expect(rates.transportAllowanceBytesSent).toBe(20_700)
    const changed = { ...readStats(second, 1).quality, transportId: "replacement" }
    expect(rtcRates(readStats(first, 1).quality, changed).transportBytesSent).toBeUndefined()
  })

  it("has no per-frame time without a frame in the window", () => {
    const still = readStats(chromeStats({ t: 13_000, decoded: 200, lost: 10, received: 990, bytesSent: 1_000_000, freezes: 0.2, cpu: 1 }), 1).quality
    const idle = rtcRates(readStats(first, 1).quality, still)
    expect(idle.decodeMs).toBeUndefined()
    expect(idle.bufferMs).toBeUndefined()
    expect(idle.encodeMs).toBeUndefined()
  })
})

describe("a paused peer (its phone locked: no frames, next to no packets)", () => {
  /** one inbound reading; framesPerSecond is absent once no frame arrives */
  const reading = (at: number, decoded: number, received: number, fps?: number): RtcSample => ({
    link: 1,
    at,
    rttMs: 40,
    inbound: { id: "IV", ...(fps !== undefined ? { fps } : {}), height: 640, framesDecoded: decoded, packetsReceived: received, packetsLost: 0 },
  })

  it("reads no inbound fps or height, and counts the window as paused, while rtt still reads", () => {
    const rates = rtcRates(reading(10_000, 500, 4_000, 24), reading(13_000, 500, 4_001))
    expect(rates.inFps).toBeUndefined()
    expect(rates.inHeight).toBeUndefined()
    expect(rates.pausedS).toBe(3)
    expect(rates.rttMs).toBe(40)
  })

  it("is not paused when packets still arrive: a decoder that stalls is a real zero", () => {
    const rates = rtcRates(reading(10_000, 500, 4_000, 24), reading(13_000, 500, 4_900))
    expect(rates.inFps).toBe(0)
    expect(rates.inHeight).toBe(640)
    expect(rates.pausedS).toBeUndefined()
  })

  it("is not paused without a frame counter to tell", () => {
    const strip = (sample: RtcSample): RtcSample => ({ ...sample, inbound: { ...sample.inbound!, framesDecoded: undefined } })
    const rates = rtcRates(strip(reading(10_000, 500, 4_000, 24)), strip(reading(13_000, 500, 4_000, 20)))
    expect(rates.inFps).toBe(20)
    expect(rates.pausedS).toBeUndefined()
  })
})

describe("decodeLoad (#265)", () => {
  const at = (t: number, inbound: RtcSample["inbound"], link = 1): RtcSample => ({ link, at: t, inbound })
  const v = (over: Partial<NonNullable<RtcSample["inbound"]>>) => ({ id: "IV", width: 100, height: 50, framesDecoded: 0, ...over })

  it("counts streams whose frames grew and sums width x height x fps", () => {
    const load = decodeLoad([
      { prev: at(0, v({})), cur: at(3000, v({ framesDecoded: 90, fps: 30 })) },
      { prev: at(0, v({})), cur: at(3000, v({ framesDecoded: 0, fps: 30 })) },
    ])
    expect(load).toEqual({ streams: 1, pixelsPerS: 100 * 50 * 30 })
  })

  it("leaves out streams it cannot judge, and is undefined when none can be", () => {
    expect(decodeLoad([])).toBeUndefined()
    expect(decodeLoad([{ cur: at(3000, v({ framesDecoded: 5 })) }])).toBeUndefined()
    expect(decodeLoad([{ prev: at(0, v({}), 1), cur: at(3000, v({ framesDecoded: 5 }), 2) }])).toBeUndefined()
    expect(decodeLoad([{ prev: at(0, v({ framesDecoded: undefined })), cur: at(3000, v({ framesDecoded: undefined })) }])).toBeUndefined()
    expect(decodeLoad([{ prev: at(0, v({ framesDecoded: 9 })), cur: at(3000, v({ framesDecoded: 3 })) }])).toBeUndefined()
  })

  it("gives no pixel sum when a decoding stream lacks its size", () => {
    expect(decodeLoad([{ prev: at(0, v({})), cur: at(3000, v({ framesDecoded: 30, width: undefined })) }])).toEqual({ streams: 1 })
  })
})

/**
 * THE FIELDS THE READER READS, ROW BY ROW.
 *
 * This is a READER regression test, not a browser capture: `report` below is a
 * hand-written Chrome-shaped fixture, so it cannot notice Chrome renaming a
 * field — only that `readStats` stopped turning a field into its `RtcSample`
 * path. The browser half of the story is the WebKit fixture at the end of this
 * block, which exercises the reader's pair fallback on the report shape that
 * engine actually produces. A real-engine snapshot (`getStats` from Chromium
 * and WebKit under Playwright) is the only thing that would catch a rename, and
 * it is deliberately not here.
 *
 * Each row is [stat type, raw field, JS type, RtcSample path, value], so a row
 * goes red whether the fixture lost the field or the reader stopped reading it.
 * The unit conversions (s -> ms, bit/s -> kbit/s) live in the expected values.
 */
describe("readStats reads every field of the report shape it was written against", () => {
  /** A representative Chrome report for one relayed peer: every field the app
   *  reads, with the units the browser reports them in (seconds, bits/s). */
  const report = new Map<string, Record<string, unknown>>(Object.entries({
    T1: { type: "transport", id: "T1", timestamp: 1_000_000, selectedCandidatePairId: "CP1" },
    CP1: {
      type: "candidate-pair", id: "CP1", timestamp: 1_000_000, nominated: true, state: "succeeded",
      localCandidateId: "LC1", remoteCandidateId: "RC1",
      currentRoundTripTime: 0.05, availableOutgoingBitrate: 900_000,
      bytesSent: 500_000, bytesReceived: 400_000, packetsSent: 500, packetsReceived: 450,
      requestsSent: 3, responsesReceived: 2, consentRequestsSent: 1, lastPacketReceivedTimestamp: 999_000,
    },
    LC1: { type: "local-candidate", id: "LC1", candidateType: "relay", protocol: "udp", relayProtocol: "tls", networkType: "wifi", url: "turns:u:p@turn.example.org:5349?transport=tcp" },
    RC1: { type: "remote-candidate", id: "RC1", candidateType: "srflx" },
    C1: { type: "codec", id: "C1", mimeType: "video/H264", sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f" },
    IV: {
      type: "inbound-rtp", id: "IV", kind: "video", timestamp: 1_000_000,
      framesPerSecond: 24, frameWidth: 480, frameHeight: 640, framesDecoded: 720, framesDropped: 2,
      freezeCount: 1, totalFreezesDuration: 0.3, jitter: 0.012, packetsLost: 4, packetsReceived: 800,
      nackCount: 3, pliCount: 1, jitterBufferDelay: 36, jitterBufferEmittedCount: 720,
      totalDecodeTime: 2.88, decoderImplementation: "libvpx", powerEfficientDecoder: false, codecId: "C1",
    },
    OV: {
      type: "outbound-rtp", id: "OV", kind: "video", timestamp: 1_000_000,
      framesPerSecond: 25, frameWidth: 360, frameHeight: 480, framesEncoded: 750, framesSent: 748,
      trackIdentifier: "track-1", qualityLimitationReason: "bandwidth", targetBitrate: 1_200_000,
      qualityLimitationDurations: { none: 10, cpu: 2, bandwidth: 3, other: 0 },
      bytesSent: 500_000, headerBytesSent: 12_000, retransmittedPacketsSent: 5, packetsSent: 500,
      totalPacketSendDelay: 0.75, nackCount: 2, pliCount: 1, totalEncodeTime: 4.5,
      encoderImplementation: "OpenH264", powerEfficientEncoder: true, codecId: "C1", keyFramesEncoded: 7,
    },
  }))

  const sample = readStats(report, 3)
  const at = (path: string): unknown =>
    path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], sample)

  /** [stat type, raw field, JS type in the report, RtcSample path, expected value] */
  const CONTRACT: [string, string, string, string, unknown][] = [
    ["transport", "selectedCandidatePairId", "string", "quality.transportId", "CP1"],
    ["candidate-pair", "nominated", "boolean", "quality.nominated", true],
    ["candidate-pair", "state", "string", "quality.pairState", "succeeded"],
    ["candidate-pair", "localCandidateId", "string", "quality.localType", "relay"],
    ["candidate-pair", "remoteCandidateId", "string", "quality.remoteType", "srflx"],
    ["candidate-pair", "currentRoundTripTime", "number", "quality.rttMs", 50], // s -> ms
    ["candidate-pair", "availableOutgoingBitrate", "number", "quality.outgoingKbps", 900], // bit/s -> kbit/s
    ["candidate-pair", "bytesSent", "number", "quality.transportBytesSent", 500_000],
    ["candidate-pair", "bytesReceived", "number", "quality.transportBytesReceived", 400_000],
    ["candidate-pair", "packetsSent", "number", "quality.transportPacketsSent", 500],
    ["candidate-pair", "packetsReceived", "number", "quality.transportPacketsReceived", 450],
    ["candidate-pair", "requestsSent", "number", "quality.requestsSent", 3],
    ["candidate-pair", "responsesReceived", "number", "quality.responsesReceived", 2],
    ["candidate-pair", "consentRequestsSent", "number", "quality.consentRequestsSent", 1],
    ["candidate-pair", "lastPacketReceivedTimestamp", "number", "quality.lastPacketReceivedAt", 999_000],
    ["local-candidate", "candidateType", "string", "quality.localType", "relay"],
    ["local-candidate", "protocol", "string", "quality.protocol", "udp"],
    ["local-candidate", "relayProtocol", "string", "quality.relayProtocol", "tls"],
    ["local-candidate", "networkType", "string", "quality.networkType", "wifi"],
    ["local-candidate", "url", "string", "quality.relayEndpoint", "turns:turn.example.org:5349?transport=tcp"],
    ["local-candidate", "url", "string", "quality.relayTransport", "tls"],
    ["codec", "mimeType", "string", "quality.inbound.codec", "H264"],
    ["codec", "sdpFmtpLine", "string", "quality.outbound.codecFmtp", "packetization-mode=1;profile-level-id=42e01f"],
    ["inbound-rtp", "kind", "string", "quality.inbound.id", "IV"],
    ["inbound-rtp", "timestamp", "number", "quality.at", 1_000_000],
    ["inbound-rtp", "framesPerSecond", "number", "quality.inbound.fps", 24],
    ["inbound-rtp", "frameWidth", "number", "quality.inbound.width", 480],
    ["inbound-rtp", "frameHeight", "number", "quality.inbound.height", 640],
    ["inbound-rtp", "framesDecoded", "number", "quality.inbound.framesDecoded", 720],
    ["inbound-rtp", "framesDropped", "number", "quality.inbound.framesDropped", 2],
    ["inbound-rtp", "freezeCount", "number", "quality.inbound.freezeCount", 1],
    ["inbound-rtp", "totalFreezesDuration", "number", "quality.inbound.totalFreezesDuration", 0.3],
    ["inbound-rtp", "jitter", "number", "quality.inbound.jitterMs", 12], // s -> ms
    ["inbound-rtp", "packetsLost", "number", "quality.inbound.packetsLost", 4],
    ["inbound-rtp", "packetsReceived", "number", "quality.inbound.packetsReceived", 800],
    ["inbound-rtp", "nackCount", "number", "quality.inbound.nackCount", 3],
    ["inbound-rtp", "pliCount", "number", "quality.inbound.pliCount", 1],
    ["inbound-rtp", "jitterBufferDelay", "number", "quality.inbound.jitterBufferDelay", 36],
    ["inbound-rtp", "jitterBufferEmittedCount", "number", "quality.inbound.jitterBufferEmittedCount", 720],
    ["inbound-rtp", "totalDecodeTime", "number", "quality.inbound.totalDecodeTime", 2.88],
    ["inbound-rtp", "decoderImplementation", "string", "quality.inbound.decoderImplementation", "libvpx"],
    ["inbound-rtp", "powerEfficientDecoder", "boolean", "quality.inbound.powerEfficientDecoder", false],
    ["inbound-rtp", "codecId", "string", "quality.inbound.codec", "H264"],
    ["outbound-rtp", "framesPerSecond", "number", "quality.outbound.fps", 25],
    ["outbound-rtp", "frameWidth", "number", "quality.outbound.width", 360],
    ["outbound-rtp", "frameHeight", "number", "quality.outbound.height", 480],
    ["outbound-rtp", "framesEncoded", "number", "quality.outbound.framesEncoded", 750],
    ["outbound-rtp", "framesSent", "number", "quality.outbound.framesSent", 748],
    ["outbound-rtp", "trackIdentifier", "string", "quality.outbound.trackIdentifier", "track-1"],
    ["outbound-rtp", "qualityLimitationReason", "string", "quality.outbound.qualityLimitationReason", "bandwidth"],
    ["outbound-rtp", "targetBitrate", "number", "quality.outbound.targetBitrate", 1_200_000],
    ["outbound-rtp", "qualityLimitationDurations", "object", "quality.outbound.qualityLimitationDurations", { none: 10, cpu: 2, bandwidth: 3, other: 0 }],
    ["outbound-rtp", "bytesSent", "number", "quality.outbound.bytesSent", 500_000],
    ["outbound-rtp", "headerBytesSent", "number", "quality.outbound.headerBytesSent", 12_000],
    ["outbound-rtp", "retransmittedPacketsSent", "number", "quality.outbound.retransmittedPacketsSent", 5],
    ["outbound-rtp", "packetsSent", "number", "quality.outbound.packetsSent", 500],
    ["outbound-rtp", "totalPacketSendDelay", "number", "quality.outbound.totalPacketSendDelay", 0.75],
    ["outbound-rtp", "nackCount", "number", "quality.outbound.nackCount", 2],
    ["outbound-rtp", "pliCount", "number", "quality.outbound.pliCount", 1],
    ["outbound-rtp", "totalEncodeTime", "number", "quality.outbound.totalEncodeTime", 4.5],
    ["outbound-rtp", "encoderImplementation", "string", "quality.outbound.encoderImplementation", "OpenH264"],
    ["outbound-rtp", "powerEfficientEncoder", "boolean", "quality.outbound.powerEfficientEncoder", true],
    ["outbound-rtp", "codecId", "string", "quality.outbound.codec", "H264"],
  ]

  it.each(CONTRACT)("%s.%s (%s) -> %s", (type, field, jsType, path, expected) => {
    const stat = [...report.values()].find((entry) => entry.type === type && entry[field] !== undefined)
    expect(
      stat,
      `The fixture has no ${type} entry carrying \`${field}\`, so this row no longer covers the reader. Restore the ` +
        `field in the fixture, or delete the row with the reader path it describes.`,
    ).toBeDefined()
    expect(typeof stat![field], `The fixture's ${type}.${field} is no longer a ${jsType}.`).toBe(jsType)
    expect(
      at(path),
      `readStats no longer surfaces ${path}, which came from ${type}.${field}. It feeds the link-quality journeys ` +
        `(rtc.path, rtc.signal), the relay diagnosis and the replay receiver's counters; a lost one is a silent hole ` +
        `in the game log, not a crash. If the reader changed on purpose, move this row with it.`,
    ).toEqual(expected)
  })

  it("pairs the selected transport's candidates and frames the link", () => {
    expect(sample.pair, "the pair string is the join key of rtc.path; it reads the selected transport's local and remote candidate types").toBe("relay/srflx")
    expect(sample.frames, "frames is summed over EVERY inbound video stream, not just the last one").toBe(720)
    expect(sample.quality.link, "the link generation keys the counters; a rebuilt RTCPeerConnection must not continue another's").toBe(3)
    expect(sample.quality.relayHost, "relayHost is derived from the candidate URL, never the credentials").toBe("turn.example.org")
    expect(sample.quality.transportAllowanceBytesSent, "the IP/UDP/TURN/TLS allowance is computed from packetsSent and the candidate's protocol").toBe(69_000)
  })

  it("keyFramesEncoded sums the outbound video counter the keyframe probe waits on", () => {
    expect(
      keyFramesEncoded(report),
      "The keyframe probe (mesh.ts probeFrames) compares this counter before and after forcing a keyframe; a reader " +
        "that stops finding outbound-rtp.keyFramesEncoded makes every forced keyframe read as 'no effect'.",
    ).toBe(7)
  })

  it("omits an absent field instead of writing undefined, so a snapshot keeps its shape", () => {
    const bare = new Map<string, Record<string, unknown>>([["OV", { type: "outbound-rtp", id: "OV", kind: "video", timestamp: 5 }]])
    const { quality } = readStats(bare, 1)
    expect(quality.outbound, "an outbound video stream must still be reported when only its id is present").toEqual({ id: "OV" } satisfies Partial<RtcSample["outbound"]>)
    expect(Object.keys(quality.outbound!).sort(), "readStats wrote an undefined-valued key: `put` drops absent readings on purpose").toEqual(["id"])
  })
})

/**
 * A WEBKIT-SHAPED REPORT, for the reader's fallback path.
 *
 * WebKit's `getStats()` names no selected candidate pair on the transport
 * (`selectedCandidatePairId` is absent), so the reader must choose one itself:
 * a nominated, succeeded pair before a merely succeeded one, and the lower id
 * between equals. It also reports no `relayProtocol`, no `networkType`, no
 * `powerEfficient*` and no `qualityLimitationDurations`, which the reader must
 * leave absent rather than invent.
 *
 * Hand-written, like the Chrome fixture above: it pins the READER's behaviour
 * on that shape, not WebKit's current field names.
 */
describe("readStats on a WebKit-shaped report (no selectedCandidatePairId)", () => {
  const webkit = new Map<string, Record<string, unknown>>(Object.entries({
    T1: { type: "transport", id: "T1", timestamp: 2_000_000 }, // no selectedCandidatePairId
    // listed first, but merely succeeded: the reader must not pick it
    CPold: {
      type: "candidate-pair", id: "CPold", timestamp: 2_000_000, state: "succeeded",
      localCandidateId: "Lhost", remoteCandidateId: "Rhost", currentRoundTripTime: 0.008,
    },
    CP1: {
      type: "candidate-pair", id: "CP1", timestamp: 2_000_000, nominated: true, state: "succeeded",
      localCandidateId: "Lrelay", remoteCandidateId: "Rsrflx",
      currentRoundTripTime: 0.062, bytesSent: 300_000, bytesReceived: 250_000,
      packetsSent: 300, packetsReceived: 260, requestsSent: 2, responsesReceived: 2, consentRequestsSent: 1,
    },
    Lhost: { type: "local-candidate", id: "Lhost", candidateType: "host", protocol: "udp" },
    Lrelay: { type: "local-candidate", id: "Lrelay", candidateType: "relay", protocol: "udp", url: "turn:turn.example.net:3478?transport=udp" },
    Rhost: { type: "remote-candidate", id: "Rhost", candidateType: "host" },
    Rsrflx: { type: "remote-candidate", id: "Rsrflx", candidateType: "srflx" },
    IV: {
      type: "inbound-rtp", id: "IV", kind: "video", timestamp: 2_000_000,
      framesPerSecond: 15, frameWidth: 320, frameHeight: 240, framesDecoded: 300,
      jitter: 0.02, packetsLost: 1, packetsReceived: 400,
    },
    OV: {
      type: "outbound-rtp", id: "OV", kind: "video", timestamp: 2_000_000,
      framesPerSecond: 15, frameWidth: 320, frameHeight: 240, framesEncoded: 310,
      bytesSent: 300_000, packetsSent: 300,
    },
  }))

  it("chooses the nominated, succeeded pair the report's order does not decide", () => {
    const read = readStats(webkit, 2)
    expect(read.pair, "WebKit names no selected pair, so the reader must pick the nominated one, not the first listed").toBe("relay/srflx")
    expect(read.quality.transportId, "the chosen pair is the transport id the counters key on").toBe("CP1")
    expect(read.quality.rttMs).toBeCloseTo(62)
    expect(read.quality.pairState).toBe("succeeded")
    expect(read.quality.nominated).toBe(true)
  })

  it("reports the same pair however the report orders the two succeeded ones", () => {
    const reordered = new Map<string, Record<string, unknown>>()
    for (const [id, stat] of webkit) if (id !== "CPold") reordered.set(id, stat)
    reordered.set("CPold", webkit.get("CPold")!)
    const first = readStats(webkit, 2)
    const second = readStats(reordered, 2)
    expect(second.pair, "the fallback must not read the report's order as a path change").toBe(first.pair)
    expect(second.quality.transportId).toBe(first.quality.transportId)
  })

  it("leaves the fields WebKit does not report absent, rather than inventing them", () => {
    const { quality } = readStats(webkit, 2)
    for (const key of ["relayProtocol", "networkType", "outgoingKbps"] as const)
      expect(quality, `WebKit reports no ${key}; the reader must leave it out of the sample`).not.toHaveProperty(key)
    expect(quality.inbound, "powerEfficientDecoder is a Chrome field; WebKit does not report it").not.toHaveProperty("powerEfficientDecoder")
    expect(quality.outbound, "qualityLimitationDurations is a Chrome field; WebKit does not report it").not.toHaveProperty("qualityLimitationDurations")
  })

  it("still derives the relay host from a credential-free TURN URL", () => {
    expect(readStats(webkit, 2).quality.relayHost).toBe("turn.example.net")
    expect(readStats(webkit, 2).quality.relayEndpoint).toBe("turn:turn.example.net:3478?transport=udp")
  })

  it("names the relay's transport from that URL, the only place WebKit says it", () => {
    expect(readStats(webkit, 2).quality.relayTransport).toBe("udp")
  })
})
