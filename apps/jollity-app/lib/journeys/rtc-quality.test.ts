// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../telemetry", async () => (await import("../telemetry/testing")).fakeTelemetryModule())

import { recorded, resetRecorded } from "../telemetry/testing"
import type { RtcSample } from "../webrtc/rtc-stats"
import { pairAttrs } from "./rtc-pair"
import { closeRtcRound, flushRtcCoverageSlice, noteLinkSeen, noteLinkStage, observeRtc, openRtcRound, recordResume, rtcCoverageVisibilityChanged, setRtcStandby, startRtcGame } from "./rtc-quality"

/** one 3 s reading of a link: cumulative counters advance by `step` */
function sample(n: number, over: { rtt?: number; lostPerStep?: number; cpu?: number; link?: number; freezeStep?: number } = {}): RtcSample {
  const t = n * 3000
  return {
    link: over.link ?? 1,
    at: t,
    rttMs: over.rtt ?? 100 + n * 10,
    localType: "relay",
    remoteType: "srflx",
    inbound: {
      id: "IV",
      fps: 20 + n,
      height: 640,
      jitterMs: 10 + n,
      packetsLost: n * (over.lostPerStep ?? 3),
      packetsReceived: n * 297,
      totalFreezesDuration: n * (over.freezeStep ?? 0),
    },
    outbound: {
      id: "OV",
      fps: 24,
      height: 480,
      bytesSent: n * 150_000,
      qualityLimitationDurations: { none: n * 3, cpu: n * (over.cpu ?? 0), bandwidth: 0 },
    },
  }
}

const feed = (peers: Record<string, RtcSample>, pairs: Record<string, string> = {}) =>
  observeRtc(Object.entries(peers).map(([id, quality]) => ({ id, pair: pairs[id] ?? "relay/srflx", quality })))

const metric = (name: string, attrs: Record<string, string> = {}) =>
  recorded.metrics.filter((point) => point.name === name && Object.entries(attrs).every(([key, value]) => point.attrs[key] === value))

beforeEach(() => {
  resetRecorded()
  startRtcGame()
})

describe("the round summary", () => {
  it("leaves a paused peer out of the inbound fps and height, and counts its paused seconds", () => {
    startRtcGame()
    openRtcRound(0)
    const locked = (n: number): RtcSample => {
      const base = sample(n)
      // playing for two readings, then the phone locks: no frames, no packets
      const frozen = Math.min(n, 2)
      return { ...base, inbound: { ...base.inbound!, fps: n <= 2 ? 24 : undefined, framesDecoded: frozen * 72, packetsReceived: frozen * 297 } }
    }
    for (let n = 0; n <= 6; n++) feed({ alice: locked(n) })
    closeRtcRound()
    // the two playing readings only: the paused ones would read 0
    expect(metric("rtc.in_fps", { stat: "p50" })[0].value).toBe(24)
    expect(metric("rtc.in_height", { stat: "p50" })[0].value).toBe(640)
    expect(metric("rtc.rtt_ms", { stat: "p50" })).toHaveLength(1)
    const [paused] = metric("rtc.peer_paused")
    expect(paused).toMatchObject({ type: "count", value: 12, attrs: { round: "1", "rtc.peer": "0" } })
  })

  it("sends one summary per peer per round, with the round, the peer index and the path", () => {
    startRtcGame()
    openRtcRound(0)
    for (let n = 0; n <= 10; n++) feed({ alice: sample(n), bob: sample(n) }, { bob: "host/host" })
    closeRtcRound()
    openRtcRound(1, (peer, round) => pairAttrs(5, "zed", peer, round))
    for (let n = 11; n <= 15; n++) feed({ alice: sample(n) })
    closeRtcRound()

    const rtt = metric("rtc.rtt_ms")
    // two stats each for alice and bob in round 1, and alice in round 2
    expect(rtt.map((point) => [point.attrs.round, point.attrs["rtc.peer"], point.attrs.stat])).toEqual([
      ["1", "0", "p50"],
      ["1", "0", "p95"],
      ["1", "1", "p50"],
      ["1", "1", "p95"],
      ["2", "0", "p50"],
      ["2", "0", "p95"],
    ])
    expect(metric("rtc.rtt_ms", { "rtc.peer": "1" })[0].attrs["rtc.path"]).toBe("direct")
    expect(metric("rtc.rtt_ms", { "rtc.peer": "0" })[0].attrs["rtc.path"]).toBe("relay")
    // no attribute carries an account, rtc.pair included
    startRtcGame()
    resetRecorded()
    openRtcRound(1, (peer, round) => pairAttrs(5, "zed", peer, round))
    feed({ alice: sample(0) })
    feed({ alice: sample(1) })
    closeRtcRound()
    expect(recorded.metrics.length).toBeGreaterThan(0)
    expect(recorded.metrics.every((point) => point.attrs["rtc.pair"] === "g5:r2:99e59b2b1d8e")).toBe(true)
    for (const point of recorded.metrics) expect(JSON.stringify(point.attrs)).not.toMatch(/alice|zed/)
    expect(rtt.every((point) => point.unit === "millisecond" && point.type === "distribution")).toBe(true)
  })

  it("computes p50 and p95 from the round's samples", () => {
    startRtcGame()
    openRtcRound(0)
    // rtt 100, 110, … 290 over 20 readings
    for (let n = 0; n < 20; n++) feed({ alice: sample(n) })
    closeRtcRound()
    expect(metric("rtc.rtt_ms", { stat: "p50" })[0].value).toBe(190)
    expect(metric("rtc.rtt_ms", { stat: "p95" })[0].value).toBe(280)
    // windowed: 3 of 300 packets lost in every window
    expect(metric("rtc.loss_pct", { stat: "p95" })[0].value).toBeCloseTo(1)
    expect(metric("rtc.loss_pct")[0].unit).toBe("percent")
    expect(metric("rtc.out_kbps", { stat: "p50" })[0].value).toBeCloseTo(400)
    expect(metric("rtc.in_height", { stat: "p50" })[0].value).toBe(640)
  })

  it("sends the metric set the budget allows: p50 and p95 for rtt, loss and jitter, p50 for the rest", () => {
    startRtcGame()
    openRtcRound(0)
    for (let n = 0; n < 5; n++) feed({ alice: sample(n, { cpu: 1, freezeStep: 0.2 }) })
    closeRtcRound()
    const names = recorded.metrics
      .filter((point) => !["rtc.video_ms", "rtc.present_ms"].includes(point.name))
      .map((point) => `${point.name}${point.attrs.stat ? `:${point.attrs.stat}` : ""}`)
    expect(names).toEqual([
      "rtc.rtt_ms:p50",
      "rtc.rtt_ms:p95",
      "rtc.loss_pct:p50",
      "rtc.loss_pct:p95",
      "rtc.jitter_ms:p50",
      "rtc.jitter_ms:p95",
      "rtc.in_fps:p50",
      "rtc.out_fps:p50",
      "rtc.in_height:p50",
      "rtc.out_height:p50",
      "rtc.out_kbps:p50",
      "rtc.freeze_ms:total",
      "rtc.quality_limited",
      "rtc.quality_limited_s:total",
      // the link row (rtc-link.ts): no ttff without this round's funnel stamps
      "rtc.link",
      "rtc.link.freeze_ms",
    ])
    expect(metric("rtc.freeze_ms")[0].value).toBeCloseTo(800)
    const [limited] = metric("rtc.quality_limited")
    expect(limited).toMatchObject({ type: "count", value: 1, attrs: { reason: "cpu", round: "1", "rtc.peer": "0" } })
    const [seconds] = metric("rtc.quality_limited_s")
    expect(seconds).toMatchObject({ value: 4, unit: "second", attrs: { reason: "cpu", stat: "total", round: "1", "rtc.peer": "0" } })
  })

  it("sends no freeze total and no limitation count for a clean round", () => {
    startRtcGame()
    openRtcRound(0)
    for (let n = 0; n < 5; n++) feed({ alice: sample(n) })
    closeRtcRound()
    expect(metric("rtc.freeze_ms")).toEqual([])
    expect(metric("rtc.quality_limited")).toEqual([])
    expect(metric("rtc.quality_limited_s")).toEqual([])
  })

  it("never flushes per round: the trace flushes at the game's end and on pagehide", () => {
    startRtcGame()
    openRtcRound(0)
    for (let n = 0; n < 3; n++) feed({ alice: sample(n) })
    closeRtcRound()
    expect(recorded.metricFlushes).toBe(0)
  })

  it("starts a returning peer's window afresh: a gap is not a rate", () => {
    startRtcGame()
    openRtcRound(0)
    feed({ bob: sample(0) })
    feed({ bob: sample(1) })
    feed({ alice: sample(2) }) // bob is gone from the report
    feed({ bob: sample(30, { lostPerStep: 1000 }) }) // and back, far on
    closeRtcRound()
    const loss = metric("rtc.loss_pct", { "rtc.peer": "0", stat: "p95" })
    expect(loss).toHaveLength(1)
    expect(loss[0].value).toBeLessThan(2) // one window, 3 of 300; never the 0 to 30 span
  })

  it("returns a short summary for the round step", () => {
    startRtcGame()
    openRtcRound(0)
    for (let n = 0; n < 20; n++) feed({ alice: sample(n, { cpu: 1 }), bob: sample(n) })
    expect(closeRtcRound()?.summary).toBe("2 peers: rtt p95 280ms, loss p95 1.0%, in 29fps, out 24fps, limited cpu")
  })

  it("counts nothing outside a round, and nothing twice", () => {
    startRtcGame()
    for (let n = 0; n < 5; n++) feed({ alice: sample(n) })
    expect(closeRtcRound()).toBeNull()
    openRtcRound(0)
    // the window from the last pre-round reading still counts as a rate
    feed({ alice: sample(5) })
    closeRtcRound()
    expect(closeRtcRound()).toBeNull()
    expect(metric("rtc.rtt_ms", { stat: "p50" })).toHaveLength(1)
    expect(metric("rtc.loss_pct", { stat: "p50" })).toHaveLength(1)
  })

  it("numbers the peers afresh for each game", () => {
    startRtcGame()
    openRtcRound(0)
    feed({ alice: sample(0) })
    feed({ alice: sample(1), bob: sample(1) })
    closeRtcRound()
    startRtcGame()
    openRtcRound(0)
    feed({ bob: sample(2) })
    closeRtcRound()
    expect(metric("rtc.rtt_ms", { stat: "p50" }).map((point) => point.attrs["rtc.peer"])).toEqual(["0", "1", "0"])
  })

  it("ignores readings taken while the page is hidden (the phone pauses video)", () => {
    const visibility = { state: "visible" as DocumentVisibilityState }
    vi.stubGlobal("document", {
      get visibilityState() {
        return visibility.state
      },
    })
    try {
      startRtcGame()
      openRtcRound(0)
      feed({ alice: sample(0) })
      feed({ alice: sample(1) })
      visibility.state = "hidden"
      feed({ alice: { ...sample(2), rttMs: 9_999 } })
      visibility.state = "visible"
      closeRtcRound()
      expect(metric("rtc.rtt_ms", { stat: "p95" })[0].value).toBe(110)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("the measured span of a round's readings (archive#829)", () => {
  it("carries the first and last reading timestamp and the reading count on every per-round point", () => {
    startRtcGame()
    openRtcRound(0)
    for (let n = 0; n <= 4; n++) feed({ alice: sample(n) })
    closeRtcRound()
    const span = { "rtc.span_first_ms": "0", "rtc.span_last_ms": "12000", "rtc.span_readings": "5" }
    expect(metric("rtc.rtt_ms", { stat: "p50" })[0].attrs).toMatchObject(span)
    expect(metric("rtc.in_fps", { stat: "p50" })[0].attrs).toMatchObject(span)
    expect(metric("rtc.link")[0].attrs).toMatchObject(span)
    // every per-round point of the peer carries it, not just the fps ones
    for (const point of recorded.metrics.filter((p) => p.attrs["rtc.peer"] === "0" && p.attrs.round === "1" && !["rtc.video_ms", "rtc.present_ms"].includes(p.name)))
      expect(point.attrs).toMatchObject(span)
  })

  it("names only the stretch a late-opening phone actually measured", () => {
    startRtcGame()
    openRtcRound(0)
    // the page reloaded mid-round: the first reading of this round is at 30 s
    for (let n = 10; n <= 14; n++) feed({ alice: sample(n) })
    closeRtcRound()
    expect(metric("rtc.in_fps", { stat: "p50" })[0].attrs).toMatchObject({
      "rtc.span_first_ms": "30000",
      "rtc.span_last_ms": "42000",
      "rtc.span_readings": "5",
    })
  })

  it("sends no span for a link the round never measured, and records nothing outside a round", () => {
    startRtcGame()
    openRtcRound(0)
    noteLinkStage("bob", 0, "offer", 400) // bob's room opened, but no reading ever carried him
    feed({ alice: sample(0) })
    feed({ alice: sample(1) })
    closeRtcRound()
    const unmeasured = metric("rtc.link").find((row) => row.attrs["rtc.last_stage"] === "offer")
    expect(unmeasured?.attrs).not.toHaveProperty("rtc.span_readings")
    expect(metric("rtc.rtt_ms")[0].attrs["rtc.span_readings"]).toBe("2")
    // a reading outside any round records nothing, span included
    resetRecorded()
    feed({ alice: sample(5) })
    expect(closeRtcRound()).toBeNull()
    expect(recorded.metrics).toEqual([])
  })
})

describe("video coverage per round (#256)", () => {
  beforeEach(() => vi.useFakeTimers())

  /** a 3 s reading: `decoded` is the cumulative framesDecoded counter */
  const reading = (n: number, decoded: number | undefined): RtcSample => ({
    link: 1,
    at: n * 3000,
    inbound: { id: "IV", ...(decoded === undefined ? {} : { framesDecoded: decoded }), packetsReceived: n * 300 },
  })
  /** one report of one peer, then the 3 s the next one is taken after */
  const report = (n: number, decoded: number | undefined, conn: RTCPeerConnectionState = "connected") => {
    observeRtc([{ id: "alice", conn, quality: reading(n, decoded) }])
    vi.advanceTimersByTime(3000)
  }
  const value = (name: string) => metric(name)[0]?.value

  it("counts only the seconds frames were decoded: a connected link with frozen framesDecoded counts none", () => {
    startRtcGame()
    openRtcRound(0)
    report(0, 100)
    for (let n = 1; n <= 10; n++) report(n, 100) // connected, nothing decoded for 30 s
    closeRtcRound()
    expect(metric("rtc.coverage_s")).toHaveLength(1)
    expect(value("rtc.coverage_s")).toBe(0)
    expect(value("rtc.coverage_pct")).toBe(0)
  })

  it("is the decoded seconds over the round's seconds, in seconds and percent", () => {
    startRtcGame()
    openRtcRound(0)
    report(0, 0)
    for (let n = 1; n <= 5; n++) report(n, n * 72) // 15 s decoding
    for (let n = 6; n <= 10; n++) report(n, 5 * 72) // 15 s frozen
    closeRtcRound()
    const [seconds] = metric("rtc.coverage_s")
    const [percent] = metric("rtc.coverage_pct")
    expect(seconds).toMatchObject({ value: 15, unit: "second", attrs: { round: "1", "rtc.peer": "0" } })
    expect(percent).toMatchObject({ unit: "percent", attrs: { round: "1", "rtc.peer": "0" } })
    expect(percent.value).toBeCloseTo((15 / 33) * 100) // the round ran 33 s on the clock
  })

  it("does not count a window of decoded frames on a link that is not connected", () => {
    startRtcGame()
    openRtcRound(0)
    report(0, 0)
    for (let n = 1; n <= 4; n++) report(n, n * 72, "disconnected")
    closeRtcRound()
    expect(value("rtc.coverage_s")).toBe(0)
  })

  it("never reads above 100 percent", () => {
    startRtcGame()
    openRtcRound(0)
    report(0, 0)
    for (let n = 1; n <= 3; n++) report(n, n * 72)
    vi.setSystemTime(Date.now() - 20_000) // a round clock that ran short of the readings
    closeRtcRound()
    expect(value("rtc.coverage_pct")).toBe(100)
  })

  it("sends a round of no video at all as 0, not as nothing", () => {
    startRtcGame()
    openRtcRound(0)
    for (let n = 0; n <= 4; n++) {
      observeRtc([{ id: "alice", conn: "connecting", quality: { link: 1, at: n * 3000 } }])
      vi.advanceTimersByTime(3000)
    }
    closeRtcRound()
    expect(value("rtc.coverage_s")).toBe(0)
    expect(value("rtc.coverage_pct")).toBe(0)
  })

  it("says unsupported, and sends no number, when the stats carry no decoded-frame counter", () => {
    startRtcGame()
    openRtcRound(0)
    for (let n = 0; n <= 5; n++) report(n, undefined)
    const closed = closeRtcRound()
    expect(metric("rtc.coverage_s")).toEqual([])
    expect(metric("rtc.coverage_pct")).toEqual([])
    expect(closed?.unsupported).toContain("coverage")
  })
})

describe("reload-safe video coverage slices (#421)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"))
  })

  const reading = (n: number, decoded: number): RtcSample => ({
    link: 1,
    at: n * 3000,
    inbound: { id: "IV", framesDecoded: decoded, packetsReceived: n * 300 },
  })
  const report = (n: number, decoded: number, conn: RTCPeerConnectionState = "connected") =>
    observeRtc([{ id: "alice", conn, quality: reading(n, decoded) }])
  const sliced = (name: string) => metric(name, { "rtc.pair": "g5:r1:99e59b2b1d8e" })
  const pair = (peer: string, round: number) => pairAttrs(5, "zed", peer, round)

  it("emits numeric video and presence every 10 monotonic seconds, then a partial round tail", () => {
    openRtcRound(0, pair)
    report(0, 0)
    vi.advanceTimersByTime(3000)
    report(1, 72)
    vi.advanceTimersByTime(3000)
    report(2, 144)
    vi.advanceTimersByTime(3000)
    report(3, 216)
    vi.advanceTimersByTime(3000)
    report(4, 288)

    expect(sliced("rtc.present_ms")).toEqual([
      expect.objectContaining({ value: 12_000, unit: "millisecond", attrs: expect.objectContaining({ round: "1", "rtc.peer": "0" }) }),
    ])
    expect(sliced("rtc.video_ms")).toEqual([expect.objectContaining({ value: 12_000, unit: "millisecond" })])

    vi.advanceTimersByTime(2000)
    closeRtcRound()
    expect(sliced("rtc.present_ms").map((point) => point.value)).toEqual([12_000, 2_000])
    expect(sliced("rtc.video_ms").map((point) => point.value)).toEqual([12_000, 2_000])
    // The legacy end-of-round comparison points remain until two live games agree.
    expect(metric("rtc.coverage_s")).toHaveLength(1)
    expect(metric("rtc.coverage_pct")).toHaveLength(1)
  })

  it("flushes once when a stats slice edge and pagehide land in the same tick", () => {
    openRtcRound(0, pair)
    report(0, 0)
    vi.advanceTimersByTime(3000)
    report(1, 72)
    vi.advanceTimersByTime(9000)
    report(4, 288) // the 12 s stats edge emitted and reset the slice
    flushRtcCoverageSlice()

    expect(sliced("rtc.present_ms")).toHaveLength(1)
    expect(sliced("rtc.video_ms")).toHaveLength(1)
  })

  it("excludes hidden time and starts a fresh slice when the page returns", () => {
    openRtcRound(0, pair)
    report(0, 0)
    vi.advanceTimersByTime(4000)
    rtcCoverageVisibilityChanged(true)
    expect(sliced("rtc.present_ms").map((point) => point.value)).toEqual([4000])

    vi.advanceTimersByTime(30_000)
    rtcCoverageVisibilityChanged(false)
    vi.advanceTimersByTime(3000)
    report(1, 72)
    flushRtcCoverageSlice()

    expect(sliced("rtc.present_ms").map((point) => point.value)).toEqual([4000, 3000])
    expect(sliced("rtc.video_ms").map((point) => point.value)).toEqual([0, 3000])
  })

  it("does not bridge video time across a missing peer observation", () => {
    openRtcRound(0, pair)
    report(0, 0)
    vi.advanceTimersByTime(3000)
    report(1, 72)
    vi.advanceTimersByTime(3000)
    observeRtc([])
    vi.advanceTimersByTime(3000)
    report(2, 144)
    vi.advanceTimersByTime(3000)
    report(3, 216)

    expect(sliced("rtc.present_ms").map((point) => point.value)).toEqual([12_000])
    expect(sliced("rtc.video_ms").map((point) => point.value)).toEqual([6000])
  })

  it("caps a delayed stats interval even when decoded frames eventually advance", () => {
    openRtcRound(0, pair)
    report(0, 0)
    vi.advanceTimersByTime(3000)
    report(1, 72)
    vi.advanceTimersByTime(30_000)
    report(2, 144)

    expect(sliced("rtc.present_ms").map((point) => point.value)).toEqual([33_000])
    expect(sliced("rtc.video_ms").map((point) => point.value)).toEqual([9000])
  })
})

/** a reading that also carries what Chrome reports of the device's side: the
 *  counters advance by a fixed step so every window reads the same */
function deviceSample(n: number, over: { cpu?: number; encoder?: string; decoder?: string; efficient?: boolean } = {}): RtcSample {
  const base = sample(n, { cpu: over.cpu })
  const frames = n * 72
  return {
    ...base,
    outgoingKbps: 900,
    inbound: {
      ...base.inbound!,
      framesDecoded: frames,
      framesDropped: n * 2,
      nackCount: n * 4,
      pliCount: n,
      jitterBufferDelay: frames * 0.06,
      jitterBufferEmittedCount: frames,
      totalDecodeTime: frames * 0.025,
      ...(over.decoder ? { decoderImplementation: over.decoder, powerEfficientDecoder: over.efficient ?? false } : {}),
    },
    outbound: {
      ...base.outbound!,
      framesEncoded: frames,
      nackCount: n * 5,
      pliCount: n * 2,
      totalEncodeTime: frames * 0.03,
      ...(over.encoder ? { encoderImplementation: over.encoder, powerEfficientEncoder: over.efficient ?? false } : {}),
    },
  }
}

describe("the negotiated codec (#556)", () => {
  const withCodec = (n: number, codec?: string, fmtp?: string): RtcSample => {
    const base = deviceSample(n)
    return { ...base, outbound: { ...base.outbound!, ...(codec ? { codec, ...(fmtp ? { codecFmtp: fmtp } : {}) } : {}) } }
  }
  const play = (make: (n: number) => RtcSample) => {
    startRtcGame()
    openRtcRound(0)
    for (let n = 0; n < 6; n++) feed({ alice: make(n) })
    return closeRtcRound()
  }

  it("puts the codec and its fmtp on every point", () => {
    play((n) => withCodec(n, "H264", "packetization-mode=1;profile-level-id=42e01f"))
    const codec = { "rtc.codec": "H264", "rtc.codec_fmtp": "packetization-mode=1;profile-level-id=42e01f" }
    expect(metric("rtc.rtt_ms", { stat: "p50" })[0].attrs).toMatchObject(codec)
    expect(metric("rtc.decode_ms")[0].attrs).toMatchObject(codec)
  })

  it("says unsupported where the stats carry no codec", () => {
    play((n) => withCodec(n))
    expect(metric("rtc.rtt_ms", { stat: "p50" })[0].attrs).toMatchObject({ "rtc.codec": "unsupported", "rtc.codec_fmtp": "unsupported" })
  })
})

describe("network versus device (#263)", () => {
  const play = (make: (n: number) => RtcSample, readings = 6) => {
    startRtcGame()
    openRtcRound(0)
    for (let n = 0; n < readings; n++) feed({ alice: make(n) })
    return closeRtcRound()
  }

  it("sends the per-frame jitter buffer, decode and encode time, and the available bitrate", () => {
    play((n) => deviceSample(n, { encoder: "OpenH264", decoder: "libvpx" }))
    expect(metric("rtc.jitter_buffer_ms", { stat: "p50" })[0]).toMatchObject({ value: expect.closeTo(60), unit: "millisecond" })
    expect(metric("rtc.decode_ms", { stat: "p95" })[0]).toMatchObject({ value: expect.closeTo(25), unit: "millisecond" })
    expect(metric("rtc.encode_ms", { stat: "p50" })[0]).toMatchObject({ value: expect.closeTo(30), unit: "millisecond" })
    expect(metric("rtc.out_available_kbps", { stat: "p50" })[0]).toMatchObject({ value: 900, unit: "none" })
  })

  it("counts the round's dropped frames, NACKs and PLIs, by direction", () => {
    play((n) => deviceSample(n))
    // 5 windows of 2 dropped frames, 4 NACKs and 1 PLI inbound
    expect(metric("rtc.frames_dropped")[0]).toMatchObject({ type: "count", value: 10, attrs: { round: "1", "rtc.peer": "0" } })
    expect(metric("rtc.nack", { "rtc.direction": "in" })[0].value).toBe(20)
    expect(metric("rtc.nack", { "rtc.direction": "out" })[0].value).toBe(25)
    expect(metric("rtc.pli", { "rtc.direction": "in" })[0].value).toBe(5)
    expect(metric("rtc.pli", { "rtc.direction": "out" })[0].value).toBe(10)
  })

  it("puts the encoder and decoder on every point, so CPU-limited video is tied to a software codec", () => {
    play((n) => deviceSample(n, { cpu: 1, encoder: "OpenH264", decoder: "libvpx", efficient: false }))
    const codec = { "rtc.encoder": "OpenH264", "rtc.decoder": "libvpx", "rtc.encoder_efficient": "false", "rtc.decoder_efficient": "false" }
    expect(metric("rtc.quality_limited", { reason: "cpu" })[0].attrs).toMatchObject(codec)
    expect(metric("rtc.rtt_ms", { stat: "p50" })[0].attrs).toMatchObject({ ...codec, round: "1", "rtc.peer": "0" })
    expect(metric("rtc.decode_ms")[0].attrs).toMatchObject(codec)
    expect(metric("rtc.codec")).toEqual([])
  })

  it("says a hardware codec is power efficient", () => {
    play((n) => deviceSample(n, { encoder: "VideoToolbox", decoder: "VideoToolbox", efficient: true }))
    expect(metric("rtc.rtt_ms")[0].attrs).toMatchObject({ "rtc.encoder": "VideoToolbox", "rtc.encoder_efficient": "true", "rtc.decoder_efficient": "true" })
  })

  it("says unsupported, and sends no number, for what the browser does not report (iOS WebKit)", () => {
    const closed = play((n) => sample(n))
    expect(metric("rtc.rtt_ms")[0].attrs).toMatchObject({
      "rtc.encoder": "unsupported",
      "rtc.decoder": "unsupported",
      "rtc.encoder_efficient": "unsupported",
      "rtc.decoder_efficient": "unsupported",
    })
    for (const name of ["rtc.jitter_buffer_ms", "rtc.decode_ms", "rtc.encode_ms", "rtc.out_available_kbps", "rtc.frames_dropped", "rtc.nack", "rtc.pli"])
      expect(metric(name)).toEqual([])
    expect(closed?.unsupported?.split(",")).toEqual(expect.arrayContaining(["coverage", "decode_time", "encode_time", "jitter_buffer", "nack_pli", "frames_dropped", "decoder", "encoder", "power_efficient"]))
  })

  it("does not call a category unsupported once any reading of the round carried it", () => {
    const closed = play((n) => (n < 3 ? sample(n) : deviceSample(n, { encoder: "libvpx", decoder: "libvpx" })))
    expect(closed?.unsupported ?? "").not.toContain("decode_time")
    expect(closed?.unsupported ?? "").not.toMatch(/(^|,)encoder/)
  })

  it("keeps a clean round from sending counts of nothing", () => {
    play((n) => ({ ...deviceSample(n, { encoder: "libvpx", decoder: "libvpx" }), inbound: { ...deviceSample(n).inbound!, framesDropped: 0, nackCount: 0, pliCount: 0 } }))
    expect(metric("rtc.frames_dropped")).toEqual([])
    expect(metric("rtc.nack", { "rtc.direction": "in" })).toEqual([])
  })
})

describe("decode load (#265)", () => {
  /** n-th reading of a peer decoding 24 fps of a 320x240 stream */
  const decoding = (n: number, over: { width?: number; fps?: number; stalled?: boolean } = {}): RtcSample => {
    const base = sample(n)
    return { ...base, inbound: { ...base.inbound!, width: over.width ?? 320, height: 240, fps: over.fps ?? 24, framesDecoded: over.stalled ? 0 : n * 72 } }
  }
  const play = (peers: Array<(n: number) => RtcSample>, readings = 5) => {
    startRtcGame()
    openRtcRound(0)
    for (let n = 0; n < readings; n++) feed(Object.fromEntries(peers.map((make, i) => [`p${i}`, make(n)])))
    return closeRtcRound()
  }

  it("sums streams decoding and pixels per second across peers, once per round", () => {
    const closed = play([(n) => decoding(n), (n) => decoding(n, { width: 640 }), (n) => decoding(n, { stalled: true })])
    expect(metric("rtc.decoding_streams", { stat: "p50" })).toHaveLength(1)
    expect(metric("rtc.decoding_streams", { stat: "p50" })[0]).toMatchObject({ value: 2, unit: "none", attrs: { round: "1", "rtc.decode_load": "ok" } })
    expect(metric("rtc.decoded_pixels_per_s", { stat: "p95" })[0]).toMatchObject({ value: 320 * 240 * 24 + 640 * 240 * 24, unit: "none" })
    expect(closed?.unsupported ?? "").not.toContain("decode_load")
  })

  it("reads a stalled decoder as 0 streams, not as unsupported", () => {
    play([(n) => decoding(n, { stalled: true })])
    expect(metric("rtc.decoding_streams", { stat: "p50" })[0].value).toBe(0)
    expect(metric("rtc.decoded_pixels_per_s", { stat: "p50" })[0].value).toBe(0)
  })

  it("takes the rate from the frames decoded over the window, not the stat's fps", () => {
    play([(n) => decoding(n, { fps: 60 })])
    expect(metric("rtc.decoded_pixels_per_s", { stat: "p50" })[0].value).toBeCloseTo(320 * 240 * 24)
  })

  it("does not call decode_load unsupported for a supported browser's round with no tick", () => {
    startRtcGame()
    openRtcRound(0)
    feed({ p0: decoding(0) })
    const closed = closeRtcRound()
    expect(metric("rtc.decoding_streams")).toEqual([])
    expect(closed?.unsupported ?? "").not.toContain("decode_load")
  })

  it("says unsupported, with no pixels point, when a decoding stream has no size", () => {
    play([(n) => ({ ...decoding(n), inbound: { ...decoding(n).inbound!, width: undefined, height: undefined } })])
    expect(metric("rtc.decoding_streams", { stat: "p50" })[0].attrs["rtc.decode_load"]).toBe("unsupported")
    expect(metric("rtc.decoded_pixels_per_s")).toEqual([])
  })

  it("sends nothing and names decode_load unsupported when the browser has no frame counter", () => {
    const closed = play([(n) => sample(n)])
    expect(metric("rtc.decoding_streams")).toEqual([])
    expect(metric("rtc.decoded_pixels_per_s")).toEqual([])
    expect(closed?.unsupported?.split(",")).toContain("decode_load")
  })
})

describe("rtc.resume_ms (#557)", () => {
  it("sends one millisecond point per return, with the side and the link's attributes", () => {
    recordResume({ side: "peer", ms: 2400 }, { "rtc.pair": "g1:r1:2de71ac1b9c8", round: "1" })
    const [point] = metric("rtc.resume_ms")
    expect(point).toMatchObject({ value: 2400, unit: "millisecond", attrs: { side: "peer", "rtc.pair": "g1:r1:2de71ac1b9c8", round: "1" } })
    expect(point.attrs).not.toHaveProperty("keyframe.method")
  })

  it("names the keyframe method on our own return", () => {
    recordResume({ side: "self", ms: 900, keyframe: { method: "replace-track", verified: "true" } }, {})
    expect(metric("rtc.resume_ms", { side: "self", "keyframe.method": "replace-track", "keyframe.verified": "true" })).toHaveLength(1)
  })
})

describe("the link row (codec map)", () => {
  /** a playing link: frames decode, the codecs differ by direction */
  const playing = (n: number, link = 1): RtcSample => {
    const base = sample(n, { link, freezeStep: 0.1 })
    return {
      ...base,
      inbound: { ...base.inbound!, framesDecoded: n * 60, codec: "VP8", decoderImplementation: "FFmpeg (fallback from: ExternalDecoder)" },
      outbound: { ...base.outbound!, codec: "H264", codecFmtp: "packetization-mode=1;profile-level-id=42e01f", encoderImplementation: "OpenH264", powerEfficientEncoder: false },
    }
  }
  const sdp = { rtx: false, red: true, ulpfec: true, flexfec: false }
  const role = (peer: string) => ({ "rtc.role": "zed" < peer ? "initiator" : "answerer" })

  it("every round point names the codec of each direction and the implementation kinds; rtc.codec stays the sent one", () => {
    openRtcRound(0)
    for (let n = 0; n <= 3; n++) observeRtc([{ id: "alice", conn: "connected", quality: playing(n) }])
    closeRtcRound()
    expect(metric("rtc.rtt_ms", { stat: "p50" })[0].attrs).toMatchObject({
      "rtc.codec": "H264",
      "rtc.codec_out": "H264",
      "rtc.codec_out_fmtp": "packetization-mode=1;profile-level-id=42e01f",
      "rtc.codec_in": "VP8",
      "rtc.codec_in_fmtp": "unsupported",
      "rtc.encoder_kind": "software",
      "rtc.decoder_kind": "software",
    })
  })

  it("sends one rtc.link row per link per round, with its outcome, stage, seen, repair formats and role", () => {
    openRtcRound(0, (peer, round) => pairAttrs(5, "zed", peer, round), role)
    noteLinkStage("alice", 0, "offer", 1000)
    noteLinkStage("alice", 0, "connected", 1800)
    noteLinkStage("alice", 0, "first_frame", 2500)
    for (let n = 0; n <= 3; n++) observeRtc([{ id: "alice", conn: "connected", quality: playing(n), sdp }])
    noteLinkSeen("alice")
    closeRtcRound()
    const [row] = metric("rtc.link")
    expect(row).toMatchObject({ type: "count", value: 1 })
    expect(row.attrs).toMatchObject({
      "rtc.outcome": "video",
      "rtc.last_stage": "first_frame",
      "rtc.seen": "true",
      "rtc.rtx": "false",
      "rtc.red": "true",
      "rtc.rebuilds": "0",
      "rtc.role": "answerer",
      "rtc.codec_in": "VP8",
      "rtc.pair": "g5:r1:99e59b2b1d8e",
      round: "1",
    })
    expect(metric("rtc.link.ttff_ms")).toMatchObject([{ value: 1500, unit: "millisecond", attrs: { "rtc.outcome": "video" } }])
    // three windows of 0.1 s freeze each
    expect(metric("rtc.link.freeze_ms")[0].value).toBeCloseTo(300)
  })

  it("a link that never connected still gets its row, and a clean one a 0 freeze", () => {
    openRtcRound(0)
    noteLinkStage("bob", 0, "offer", 500)
    for (let n = 0; n <= 3; n++) observeRtc([{ id: "bob", conn: "connecting", quality: { link: 1, at: n * 3000 } }])
    closeRtcRound()
    expect(metric("rtc.link")[0].attrs).toMatchObject({ "rtc.outcome": "not-connected", "rtc.last_stage": "offer", "rtc.seen": "false", "rtc.rtx": "unsupported" })
    expect(metric("rtc.link.ttff_ms")).toHaveLength(0)
    expect(metric("rtc.link.freeze_ms")[0].value).toBe(0)
  })

  it("counts the connections a link went through as rebuilds, and keeps the stamps to their round", () => {
    openRtcRound(0)
    noteLinkStage("alice", 0, "offer", 1000)
    observeRtc([{ id: "alice", conn: "connected", quality: playing(0, 1) }])
    observeRtc([{ id: "alice", conn: "connected", quality: playing(1, 1) }])
    observeRtc([{ id: "alice", conn: "connected", quality: playing(2, 2) }])
    observeRtc([{ id: "alice", conn: "connected", quality: playing(3, 2) }])
    closeRtcRound()
    expect(metric("rtc.link", { round: "1" })[0].attrs["rtc.rebuilds"]).toBe("1")
    openRtcRound(1)
    for (let n = 4; n <= 6; n++) observeRtc([{ id: "alice", conn: "connected", quality: playing(n, 2) }])
    closeRtcRound()
    // round 2 kept round 1's room: no stamps of its own
    expect(metric("rtc.link", { round: "2" })[0].attrs).toMatchObject({ "rtc.last_stage": "carried", "rtc.rebuilds": "0", "rtc.outcome": "video" })
  })

  it("a new game forgets the stamps and who was seen", () => {
    openRtcRound(0)
    noteLinkStage("alice", 0, "first_frame", 900)
    noteLinkSeen("alice")
    startRtcGame()
    openRtcRound(0)
    for (let n = 0; n <= 2; n++) observeRtc([{ id: "alice", conn: "connected", quality: playing(n) }])
    closeRtcRound()
    expect(metric("rtc.link")[0].attrs).toMatchObject({ "rtc.seen": "false", "rtc.last_stage": "carried" })
  })

  it("gives a link that never produced a stats reading its row too, so every link-round has one (#632)", () => {
    openRtcRound(0, (peer, round) => pairAttrs(5, "zed", peer, round))
    // bob's room opened and stamped an offer, but no stats report ever carried him
    noteLinkStage("bob", 0, "offer", 400)
    // carl was in the report without a quality sample (a getStats that came back empty)
    observeRtc([{ id: "carl", conn: "connecting" }])
    observeRtc([{ id: "alice", conn: "connected", quality: playing(0) }])
    observeRtc([{ id: "alice", conn: "connected", quality: playing(1) }])
    closeRtcRound()
    const rows = metric("rtc.link")
    expect(rows.map((row) => row.attrs["rtc.pair"]).sort()).toEqual(["g5:r1:4224c61e9f7e", "g5:r1:99e59b2b1d8e", "g5:r1:ced1e637c4d8"])
    expect(metric("rtc.link", { "rtc.pair": "g5:r1:ced1e637c4d8" })[0].attrs).toMatchObject({ "rtc.outcome": "not-connected", "rtc.last_stage": "offer", round: "1" })
    expect(metric("rtc.link", { "rtc.pair": "g5:r1:4224c61e9f7e" })[0].attrs["rtc.outcome"]).toBe("not-connected")
    // a link with no video has no freeze figure, not a 0
    expect(metric("rtc.link.freeze_ms")).toHaveLength(1)
    // no stats, no distributions: only the row
    expect(metric("rtc.rtt_ms", { "rtc.pair": "g5:r1:ced1e637c4d8" })).toHaveLength(0)
  })

  it("tags a next-round co-player's link as standby, not not-connected, and leaves the group's rows alone (#1156)", () => {
    openRtcRound(0, (peer, round) => pairAttrs(5, "zed", peer, round))
    setRtcStandby(["bob"])
    // bob is on standby: stamped through connected, never measured
    noteLinkStage("bob", 0, "connected", 900)
    noteLinkStage("carl", 0, "offer", 400)
    for (let n = 0; n <= 2; n++) observeRtc([{ id: "alice", conn: "connected", quality: playing(n) }])
    closeRtcRound()
    expect(metric("rtc.link", { "rtc.pair": "g5:r1:ced1e637c4d8" })[0].attrs).toMatchObject({ "rtc.outcome": "standby", "rtc.last_stage": "connected" })
    expect(metric("rtc.link", { "rtc.pair": "g5:r1:4224c61e9f7e" })[0].attrs["rtc.outcome"]).toBe("not-connected")
    expect(metric("rtc.link", { "rtc.pair": "g5:r1:99e59b2b1d8e" })[0].attrs["rtc.outcome"]).toBe("video")
  })

  it("a round with no stats at all still yields its rows, and closing again emits nothing twice", () => {
    openRtcRound(0, (peer, round) => pairAttrs(5, "zed", peer, round))
    noteLinkStage("bob", 0, "offer", 400)
    expect(closeRtcRound()).toBeNull()
    expect(metric("rtc.link")).toHaveLength(1)
    expect(closeRtcRound()).toBeNull()
    openRtcRound(1, (peer, round) => pairAttrs(5, "zed", peer, round))
    closeRtcRound()
    expect(metric("rtc.link")).toHaveLength(1)
  })

  it("one peer failing to emit does not take the others' summaries with it", () => {
    openRtcRound(0, (peer, round) => {
      if (peer === "alice") throw new Error("boom")
      return pairAttrs(5, "zed", peer, round)
    })
    for (let n = 0; n <= 2; n++) observeRtc([{ id: "alice", conn: "connected", quality: playing(n) }, { id: "bob", conn: "connected", quality: playing(n) }])
    closeRtcRound()
    expect(metric("rtc.link", { "rtc.pair": "g5:r1:ced1e637c4d8" })).toHaveLength(1)
  })

  it("sends no phantom row for last round's co-players when the room regrouped", () => {
    const pair = (peer: string, round: number) => pairAttrs(5, "zed", peer, round)
    openRtcRound(0, pair)
    for (let n = 0; n <= 2; n++) observeRtc([{ id: "alice", conn: "connected", quality: playing(n) }, { id: "bob", conn: "connected", quality: playing(n) }])
    closeRtcRound()
    resetRecorded()
    openRtcRound(1, pair)
    for (let n = 3; n <= 5; n++) observeRtc([{ id: "carl", conn: "connected", quality: playing(n) }])
    closeRtcRound()
    expect(metric("rtc.link").map((row) => row.attrs["rtc.pair"])).toEqual(["g5:r2:4224c61e9f7e"])
  })
})

describe("link time on each path (#944)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-10T12:00:00Z"))
  })

  // an iPhone's relay: WebKit names no relayProtocol, the TURN url says tcp
  const relayed = (n: number): RtcSample => ({
    link: 1,
    at: n * 3000,
    localType: "relay",
    remoteType: "srflx",
    relayTransport: "tcp",
    inbound: { id: "IV", framesDecoded: n * 72, packetsReceived: n * 300 },
  })
  const direct = (n: number): RtcSample => ({ ...relayed(n), localType: "host", remoteType: "host", relayTransport: undefined })
  const report = (quality: RtcSample, conn: RTCPeerConnectionState = "connected") =>
    observeRtc([{ id: "alice", conn, pair: `${quality.localType}/${quality.remoteType}`, quality }])
  const pathMs = () =>
    metric("rtc.link.path_ms").map((point) => ({ ms: point.value, unit: point.unit, path: point.attrs["rtc.path"], relay: point.attrs["rtc.relay_protocol"] }))

  it("sums connected time per path and relay protocol, an iPhone's protocol read off its TURN url", () => {
    openRtcRound(0)
    report(relayed(0)) // the first reading opens the window, it holds no time yet
    for (let n = 1; n <= 2; n++) {
      vi.advanceTimersByTime(3000)
      report(relayed(n))
    }
    for (let n = 3; n <= 4; n++) {
      vi.advanceTimersByTime(3000)
      report(direct(n))
    }
    closeRtcRound()
    expect(pathMs()).toEqual([
      { ms: 6000, unit: "millisecond", path: "relay", relay: "tcp" },
      { ms: 6000, unit: "millisecond", path: "direct", relay: undefined },
    ])
  })

  it("counts no more than two polls for a stalled one, and nothing while the link is down", () => {
    openRtcRound(0)
    report(relayed(0))
    vi.advanceTimersByTime(3000)
    report(relayed(1)) // +3 s
    vi.advanceTimersByTime(20_000)
    report(relayed(2)) // a stalled poll: capped at 6 s
    vi.advanceTimersByTime(3000)
    report(relayed(3), "disconnected") // down: not time on the path
    vi.advanceTimersByTime(3000)
    report(relayed(4)) // +3 s
    closeRtcRound()
    expect(pathMs()).toEqual([{ ms: 12_000, unit: "millisecond", path: "relay", relay: "tcp" }])
  })

  it("names the relay protocol on the round's link metrics", () => {
    openRtcRound(0)
    for (let n = 0; n <= 2; n++) {
      report(relayed(n))
      vi.advanceTimersByTime(3000)
    }
    closeRtcRound()
    expect(metric("rtc.link").map((row) => row.attrs["rtc.relay_protocol"])).toEqual(["tcp"])
  })
})
