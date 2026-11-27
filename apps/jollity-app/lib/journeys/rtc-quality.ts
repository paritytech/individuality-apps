// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * LINK QUALITY PER ROUND, as Sentry metrics. Framework-free, no Sentry: it
 * speaks lib/telemetry's metrics doorway.
 *
 * useMesh hands every report of its 3 s getStats loop to `observeRtc` (no
 * timer of its own, no extra getStats). Each peer's readings become rates
 * (lib/webrtc/rtc-stats.ts rtcRates) and pile up in the open round. The game
 * trace opens the round with the round step and closes it wherever that step
 * ends (the next round, the confirm stage, the game's end, the page going):
 * `closeRtcRound` then sends ONE summary per peer and returns a line for the
 * round step's `rtc.summary`. The points leave with the SDK's own batching;
 * the game trace also flushes on every hidden edge, at the game's end and
 * when the app goes away. docs/metrics.md has every metric's unit and
 * attributes.
 *
 * THE BUDGET. A round is ~72 s, ~24 readings per peer. Sending each reading
 * would be ~2000 points a game; a summary per peer per round is computed
 * here, p50 and p95 by nearest rank:
 *
 *   rtc.rtt_ms, rtc.loss_pct, rtc.jitter_ms       stat p50 and p95
 *   rtc.in_fps, rtc.out_fps, rtc.in_height,
 *   rtc.out_height, rtc.out_kbps                   stat p50
 *   rtc.freeze_ms                                  stat total, when > 0
 *   rtc.quality_limited (count 1)                  per reason with time > 0
 *   rtc.quality_limited_s                          stat total, per reason with time > 0
 *   rtc.peer_paused (count, seconds)               when > 0
 *   rtc.jitter_buffer_ms, rtc.decode_ms,
 *   rtc.encode_ms                                  stat p50 and p95: ms per frame (device versus network, #263)
 *   rtc.out_available_kbps                         stat p50
 *   rtc.decoding_streams, rtc.decoded_pixels_per_s  once per round for the device, stat p50 and p95 over its ticks: streams whose frames decoded since the last tick, and Σ width×height×fps over them (#265); see emitDecodeLoad for rtc.decode_load ok|partial|unsupported
 *   rtc.frames_dropped, rtc.nack, rtc.pli          counts when > 0 (nack and pli by rtc.direction in|out)
 *   rtc.coverage_s, rtc.coverage_pct               always (0 included), see COVERAGE
 *   rtc.video_ms, rtc.present_ms                    first stats poll after 10 s + round/page tail (#421)
 *   rtc.path_changes (count)                       when > 0: times the selected path changed
 *   rtc.link (count 1), rtc.link.ttff_ms,
 *   rtc.link.freeze_ms                             THE LINK ROW, one per peer per round (rtc-link.ts): the round's
 *                                                  attributes plus rtc.outcome, rtc.last_stage, rtc.seen, rtc.rtx,
 *                                                  rtc.red, rtc.ulpfec, rtc.flexfec, rtc.rebuilds and rtc.role; for
 *                                                  a query that maps codecs and outcomes by link
 *   rtc.resume_ms                                  millisecond, per link and return (#557): from a phone's return from the background (side=self) or the far end's away flag clearing (side=peer) to the link's next increase in framesDecoded. side=self also carries keyframe.method (active-toggle|replace-track|none) and keyframe.verified (true|false|unsupported)
 *
 * A PAUSED peer (phone locked: no frames, next to no packets; see rtc-stats
 * rtcRates) sends no in_fps or in_height for those windows — they would read
 * 0 on a healthy link — and its paused seconds go out as rtc.peer_paused.
 *
 * COVERAGE (rtc.coverage_s, rtc.coverage_pct) is sent next to the
 * reload-safe slices (rtc.video_ms, rtc.present_ms): the seconds of the round
 * with live incoming video, over the round's seconds (wall clock, from the round step
 * opening to its closing, so a hidden page counts as uncovered). A reading
 * window is covered when the peer connection is `connected` AND the inbound
 * video's framesDecoded grew in it: a link that reads connected with frozen
 * frames covers nothing. A browser whose inbound stat has no framesDecoded
 * sends no coverage point and closeRtcRound says `unsupported` (the round step
 * then reads `rtc.unsupported: coverage`)
 * (a 0 there would read as a dead link; `coverage` is one of the categories
 * below). The device-side stats (#263) are
 * said the same way: iOS WebKit reports fewer than Chrome, so a category the
 * browser never carried all round is named in `rtc.unsupported` (decode_time,
 * encode_time, jitter_buffer, nack_pli, frames_dropped, decoder, encoder,
 * power_efficient, available_bitrate) and its metrics are left out.
 *
 * 15–20 points per peer per round, the link row's two or three included:
 * 2 peers over 2 rounds is ~70, a full group of 6 (5 peers) over 2 rounds ~180. The connection funnel adds up to
 * 5 points per peer per mesh open (lib/webrtc/funnel.ts). Points of one stat are per-round percentiles, so a
 * dashboard reads them with avg() or max() — a p95() over stat:p95 points is
 * a p95 of p95s. A clean round sends no freeze_ms point: the share of rounds
 * that froze is count(freeze_ms) / count(rtt_ms stat:p50).
 *
 * Every point carries the peer's codec as text, `rtc.encoder`, `rtc.decoder`,
 * `rtc.encoder_efficient`, `rtc.decoder_efficient`, `rtc.encoder_kind` and
 * `rtc.decoder_kind` (hardware|software, rtc-impl.ts), `rtc.codec` (negotiated, e.g. H264:
 * the sent one, else the received one) and `rtc.codec_fmtp` (profile-level-id,
 * packetization-mode), and per direction `rtc.codec_in`, `rtc.codec_in_fmtp`,
 * `rtc.codec_out`, `rtc.codec_out_fmtp` (`unsupported` where the browser says nothing), so a CPU limit reads next to a software encoder in
 * one query. Every point also carries rtc.path, round (1-based, as the step `round.N`),
 * rtc.peer, the peer's index in this game (never the account), and rtc.pair,
 * the link's id (lib/journeys/rtc-pair.ts, from the `pair` closeRtcRound is
 * given): a hash of the game and the two accounts that both ends of one link
 * compute alike, which rtc.peer cannot give, and from which neither account
 * is read back without the game's roster. No point carries an account. The
 * doorway adds host.kind, game.index and the device and network tags when set.
 * Every per-round point also carries the MEASURED SPAN (archive#829):
 * rtc.span_first_ms, rtc.span_last_ms and rtc.span_readings name the stretch
 * of the round the summary covers — the stats timestamps of the first and
 * last counted reading and how many readings that was — so a report can
 * compare the same stretch on both ends of a link instead of two medians
 * over different stretches. The timestamps are the stats reports' timestamps:
 * epoch ms read from the device's wall clock, so the two ends compare only as
 * well as their clocks agree, and a backward clock step can leave span_last
 * below span_first. A link the round never measured carries no span, only its
 * row.
 * The slice points deliberately omit codec/path attributes: they are summed
 * only by viewer, round and the stable pair, including across page sessions.
 */
import { pageHidden, watchPageActivity } from "../page-lifecycle"
import { recordCount, recordDistribution, type MetricUnit } from "../telemetry"
import { percentile } from "../telemetry/util"
import { decodeLoad, resolvedRelay, rtcRates, statsCoverage, type DecodeLoad, type RtcRates, type RtcSample } from "../webrtc/rtc-stats"
import { UNSUPPORTED } from "../webrtc/gather"
import { rtcPath, type RtcPath } from "./peer-path"
import type { ResumeEvent } from "../webrtc/rtc-events"
import type { FunnelStage } from "../webrtc/funnel"
import type { SdpVideo } from "../webrtc/sdp-video"
import { implKind } from "./rtc-impl"
import { linkRow } from "./rtc-link"

/** what observeRtc reads of a mesh report row */
export interface RtcReading {
  id: string
  /** the peer connection's state: a second only counts as covered while connected */
  conn?: string
  pair?: string
  quality?: RtcSample
  /** the repair formats the link negotiated, off its SDP (lib/webrtc/sdp-video.ts) */
  sdp?: SdpVideo
}

interface PeerRound {
  id: string
  /** a stats report of this round carried the peer (a peer seeded from the last room may never be) */
  reported: boolean
  index: number
  path: RtcPath
  rates: RtcRates[]
  /** seconds of windows where the link was connected and frames were decoded */
  coveredS: number
  /** reload-safe coverage accumulated for the open metric slice */
  slice: { videoMs: number; presentMs: number }
  /** last decoder observation, and whether its preceding interval was live */
  lastVideoAt?: number
  videoActive: boolean
  /** times the selected path changed this round (the first path is not one) */
  pathChanges: number
  /** EXPOSURE (#944): connected ms on each path this round, keyed
   *  `path|relay protocol` (the protocol empty off a relay), for
   *  rtc.link.path_ms: link-time on a TCP relay is what a torn-down relay
   *  rate is counted against */
  pathMs: Map<string, number>
  /** the relay protocol last read (rtc-stats resolvedRelay, `remote` when
   *  only the far end relays); absent while no reading was on a relay */
  relayProtocol?: string
  /** Per device-side stat category (rtc-stats.ts statsCoverage, and `coverage`,
   *  the inbound framesDecoded counter): true once some reading carried it.
   *  One still false at the close is unsupported on this browser. */
  stats: Map<string, boolean>
  /** the latest codec readings of the round: `name`/`fmtp` the sent codec,
   *  else the received one (rtc.codec); in/out per direction */
  codec: {
    encoder?: string
    decoder?: string
    encoderEfficient?: boolean
    decoderEfficient?: boolean
    name?: string
    fmtp?: string
    inName?: string
    inFmtp?: string
    outName?: string
    outFmtp?: string
  }
  // THE LINK ROW's facts (rtc-link.ts)
  /** some reading saw the connection `connected` */
  connected: boolean
  /** frames grew in some counted window */
  decoded: boolean
  /** the peer connections (rtc-stats `link`) the round's readings came from */
  links: Set<number>
  sdp?: SdpVideo
  /** THE MEASURED SPAN (archive#829): the `at` of the first and last counted
   *  reading of the round and how many readings that was, so a report can
   *  compare the same stretch on both ends of a link. Undefined `at` is not
   *  a reading. A link the round never measured keeps `spanReadings` 0. */
  spanFirstAt?: number
  spanLastAt?: number
  spanReadings: number
}

type Numeric = Exclude<keyof RtcRates, "limited" | "reasonDurations">

/** the metric set, in send order */
const SUMMARY: ReadonlyArray<{ name: string; field: Numeric; unit: MetricUnit; stats: ReadonlyArray<"p50" | "p95"> }> = [
  { name: "rtc.rtt_ms", field: "rttMs", unit: "millisecond", stats: ["p50", "p95"] },
  { name: "rtc.loss_pct", field: "lossPct", unit: "percent", stats: ["p50", "p95"] },
  { name: "rtc.jitter_ms", field: "jitterMs", unit: "millisecond", stats: ["p50", "p95"] },
  { name: "rtc.in_fps", field: "inFps", unit: "none", stats: ["p50"] },
  { name: "rtc.out_fps", field: "outFps", unit: "none", stats: ["p50"] },
  { name: "rtc.in_height", field: "inHeight", unit: "none", stats: ["p50"] },
  { name: "rtc.out_height", field: "outHeight", unit: "none", stats: ["p50"] },
  { name: "rtc.out_kbps", field: "outKbps", unit: "none", stats: ["p50"] },
  { name: "rtc.out_available_kbps", field: "availKbps", unit: "none", stats: ["p50"] },
  { name: "rtc.jitter_buffer_ms", field: "bufferMs", unit: "millisecond", stats: ["p50", "p95"] },
  { name: "rtc.decode_ms", field: "decodeMs", unit: "millisecond", stats: ["p50", "p95"] },
  { name: "rtc.encode_ms", field: "encodeMs", unit: "millisecond", stats: ["p50", "p95"] },
]

/** per-round totals sent as counts when above 0: the field, the name and the
 *  attributes that tell the series apart */
const TOTALS: ReadonlyArray<{ name: string; field: Numeric; attrs?: Record<string, string> }> = [
  { name: "rtc.frames_dropped", field: "framesDropped" },
  { name: "rtc.nack", field: "nackIn", attrs: { "rtc.direction": "in" } },
  { name: "rtc.nack", field: "nackOut", attrs: { "rtc.direction": "out" } },
  { name: "rtc.pli", field: "pliIn", attrs: { "rtc.direction": "in" } },
  { name: "rtc.pli", field: "pliOut", attrs: { "rtc.direction": "out" } },
]
const QUANTILE = { p50: 0.5, p95: 0.95 } as const

/** the round step's line, in order: field, rank, how to say it */
const LINE: ReadonlyArray<{ field: Numeric; q: number; say: (value: number) => string }> = [
  { field: "rttMs", q: 0.95, say: (value) => `rtt p95 ${Math.round(value)}ms` },
  { field: "lossPct", q: 0.95, say: (value) => `loss p95 ${value.toFixed(1)}%` },
  { field: "inFps", q: 0.5, say: (value) => `in ${Math.round(value)}fps` },
  { field: "outFps", q: 0.5, say: (value) => `out ${Math.round(value)}fps` },
]

/** a peer's pair id attributes in a round (lib/journeys/rtc-pair.ts), passed in
 *  by the trace, which knows the game and this device's account */
type PairOf = (peer: string, round: number) => Record<string, string>
const noPair: PairOf = () => ({})

let round: number | null = null
/** wall ms the open round began, the denominator of coverage */
let roundOpenedAt = 0
let peers = new Map<string, PeerRound>()
/** each peer's last reading, kept across rounds: the first window of a round
 *  runs from the last reading of the one before */
let last = new Map<string, RtcSample>()
/** peer index by id, for this game */
let indexOf = new Map<string, number>()
/** The reload-safe coverage point cadence. A killed page loses at most this
 *  open tail; the SDK drains recorded points on its own metric cadence. */
const RTC_COVERAGE_SLICE_MS = 10_000
const RTC_STATS_POLL_MS = 3_000
const RTC_STATS_GAP_MAX_MS = RTC_STATS_POLL_MS * 2
/** this device's decode load at each sampling tick of the open round (#265) */
let loads: DecodeLoad[] = []
let pairOf: PairOf = noPair
/** a peer's role attributes (rtc.role), passed in by the trace */
type RoleOf = (peer: string) => Record<string, string>
let roleOf: RoleOf = () => ({})
/** the funnel stamps of each link, by `<0-based round>|<peer>`: a room opens
 *  per group, so a link's stamps belong to the round its room opened for */
let stamps = new Map<string, Partial<Record<FunnelStage, number>>>()
/** the co-players on standby now: a LATER round's group, linked early and held
 *  back on purpose (#1069), so no part of this round's blame */
let standbyIds = new Set<string>()
/** the links stamped while on standby, by `<0-based round>|<peer>` */
const standbyLinks = new Set<string>()
/** co-players the session counted as seen (#603), this game */
let seenPeers = new Set<string>()
let sliceAccountedAt = 0
let sliceStartedAt = 0
let coverageVisible = true
/** monotonic time of a peer's preceding stats report; cleared over hidden time */
let videoObservedAt = new Map<string, number>()
let stopCoverageActivity = () => {}

const monotonicNow = (): number => (typeof performance === "undefined" ? 0 : performance.now())

function makePeer(id: string): PeerRound {
  return {
    id,
    reported: false,
    index: rtcPeerIndex(id),
    path: "unknown",
    rates: [],
    coveredS: 0,
    slice: { videoMs: 0, presentMs: 0 },
    videoActive: false,
    pathChanges: 0,
    pathMs: new Map(),
    stats: new Map(),
    codec: {},
    connected: false,
    decoded: false,
    links: new Set(),
    spanReadings: 0,
  }
}

/** Attribute visible time since the previous monotonic checkpoint to every
 *  peer known in this round. Date is deliberately never used: a clock jump or
 *  suspended WebView cannot inflate coverage. */
function accruePresence(now = monotonicNow()): void {
  const elapsed = Math.max(0, now - sliceAccountedAt)
  sliceAccountedAt = now
  if (round === null || !coverageVisible) return
  for (const peer of peers.values()) peer.slice.presentMs += elapsed
}

/** Close the small unobserved tail after a healthy decoder reading. One stats
 *  poll is the most we may infer; a longer gap stays loss. */
function creditVideoTail(now: number): void {
  for (const peer of peers.values()) {
    if (!peer.videoActive || peer.lastVideoAt === undefined) continue
    peer.slice.videoMs += Math.min(RTC_STATS_POLL_MS, Math.max(0, now - peer.lastVideoAt))
    peer.lastVideoAt = now
  }
}

/** Emit one complete or partial reload-safe slice. Accumulators reset before
 *  recording, so a stats edge and pagehide in one task cannot double-count
 *  the same tail. The SDK's own roughly five-second metric flush delivers it. */
export function flushRtcCoverageSlice(): void {
  if (round === null) return
  try {
    const now = monotonicNow()
    accruePresence(now)
    creditVideoTail(now)
    for (const peer of peers.values()) {
      const { presentMs, videoMs } = peer.slice
      peer.slice = { videoMs: 0, presentMs: 0 }
      if (!(presentMs > 0)) continue
      const pair = pairOf(peer.id, round + 1)
      if (!pair["rtc.pair"]) continue
      const attrs = { round: String(round + 1), "rtc.peer": String(peer.index), ...pair }
      recordDistribution("rtc.video_ms", videoMs, "millisecond", attrs)
      recordDistribution("rtc.present_ms", presentMs, "millisecond", attrs)
    }
    sliceStartedAt = now
  } catch {
    /* telemetry never breaks the mesh */
  }
}

/** The game trace's one visibility hook. Hidden time is a real loss in the
 *  chain-window denominator, but never client presence. */
export function rtcCoverageVisibilityChanged(hidden: boolean): void {
  if (round === null || hidden === !coverageVisible) return
  if (hidden) {
    accruePresence()
    flushRtcCoverageSlice()
    coverageVisible = false
    videoObservedAt.clear()
    for (const peer of peers.values()) peer.videoActive = false
    return
  }
  coverageVisible = true
  sliceAccountedAt = monotonicNow()
  sliceStartedAt = sliceAccountedAt
  videoObservedAt = new Map([...last.keys()].map((id) => [id, sliceAccountedAt]))
}

/** one report of the mesh's getStats loop */
export function observeRtc(readings: readonly RtcReading[]): void {
  try {
    const observedAt = monotonicNow()
    accruePresence(observedAt)
    // in the background the phone pauses video: those readings are not the link
    const counted = round !== null && !pageHidden()
    // a peer gone from the report restarts its window when it is back
    if (last.size > 0) {
      const present = new Set(readings.map((reading) => reading.id))
      for (const id of last.keys()) {
        if (!present.has(id)) {
          last.delete(id)
          videoObservedAt.delete(id)
          const peer = peers.get(id)
          if (peer) peer.videoActive = false
        }
      }
    }
    const windows: Array<{ prev?: RtcSample; cur: RtcSample }> = []
    for (const reading of readings) {
      let peer = round === null ? undefined : peers.get(reading.id)
      if (round !== null && !peer) {
        peer = makePeer(reading.id)
        peers.set(reading.id, peer)
      }
      if (peer) peer.reported = true
      const sample = reading.quality
      if (!sample) continue
      const before = last.get(reading.id)
      const rates = rtcRates(before, sample)
      last.set(reading.id, sample)
      const videoBefore = videoObservedAt.get(reading.id)
      videoObservedAt.set(reading.id, observedAt)
      if (!counted) continue
      if (!peer) continue
      if (sample.at !== undefined) {
        peer.spanReadings += 1
        peer.spanFirstAt ??= sample.at
        peer.spanLastAt = sample.at
      }
      noteDevice(peer, sample)
      peer.links.add(sample.link)
      if (reading.sdp) peer.sdp = reading.sdp
      windows.push({ prev: before, cur: sample })
      const path = rtcPath(reading.pair)
      if (path !== "unknown") peer.path = path
      const relay = sample.localType === "relay" ? resolvedRelay(sample).protocol : sample.remoteType === "relay" ? "remote" : undefined
      if (relay !== undefined) peer.relayProtocol = relay
      peer.rates.push(rates)
      // a covered second: the link is up AND frames came out of the decoder in it
      if (reading.conn === "connected") {
        peer.connected = true
        // exposure: the window since the last observation, on this reading's
        // path; capped like the video windows, so a stalled poll is not time on it
        if (videoBefore !== undefined && path !== "unknown") {
          const key = `${path}|${relay ?? ""}`
          peer.pathMs.set(key, (peer.pathMs.get(key) ?? 0) + Math.min(RTC_STATS_GAP_MAX_MS, Math.max(0, observedAt - videoBefore)))
        }
        const decoded = decodedSeconds(before, sample)
        if (decoded > 0) peer.decoded = true
        peer.coveredS += decoded
        peer.videoActive = decoded > 0
        if (peer.videoActive && videoBefore !== undefined) peer.slice.videoMs += Math.min(RTC_STATS_GAP_MAX_MS, Math.max(0, observedAt - videoBefore))
      } else {
        peer.videoActive = false
      }
      peer.lastVideoAt = observedAt
    }
    const load = decodeLoad(windows)
    if (load) loads.push(load)
    if (round !== null && observedAt - sliceStartedAt >= RTC_COVERAGE_SLICE_MS) flushRtcCoverageSlice()
  } catch {
    /* telemetry never breaks the mesh */
  }
}

/** fold one reading's device-side stats into the peer's round */
function noteDevice(peer: PeerRound, sample: RtcSample): void {
  for (const [category, has] of statsCoverage(sample)) peer.stats.set(category, (peer.stats.get(category) ?? false) || has)
  const { inbound, outbound } = sample
  if (inbound?.decoderImplementation !== undefined) peer.codec.decoder = inbound.decoderImplementation
  if (inbound?.powerEfficientDecoder !== undefined) peer.codec.decoderEfficient = inbound.powerEfficientDecoder
  if (outbound?.encoderImplementation !== undefined) peer.codec.encoder = outbound.encoderImplementation
  if (outbound?.powerEfficientEncoder !== undefined) peer.codec.encoderEfficient = outbound.powerEfficientEncoder
  // the codec we SEND (its profile is the open question on iOS), else the one we receive
  const negotiated = outbound?.codec !== undefined ? outbound : inbound?.codec !== undefined ? inbound : undefined
  if (negotiated) {
    peer.codec.name = negotiated.codec
    peer.codec.fmtp = negotiated.codecFmtp
  }
  if (inbound?.codec !== undefined) {
    peer.codec.inName = inbound.codec
    peer.codec.inFmtp = inbound.codecFmtp
  }
  if (outbound?.codec !== undefined) {
    peer.codec.outName = outbound.codec
    peer.codec.outFmtp = outbound.codecFmtp
  }
}

/** the categories this peer's browser never reported all round */
const unsupportedOf = (peer: PeerRound): string[] => [...peer.stats].filter(([, seen]) => !seen).map(([category]) => category)

/** the codec attributes: text, `unsupported` where the browser said nothing */
function codecAttrs(codec: PeerRound["codec"]): Record<string, string> {
  const say = (value: boolean | undefined) => (value === undefined ? UNSUPPORTED : String(value))
  return {
    "rtc.encoder": codec.encoder ?? UNSUPPORTED,
    "rtc.decoder": codec.decoder ?? UNSUPPORTED,
    "rtc.encoder_efficient": say(codec.encoderEfficient),
    "rtc.decoder_efficient": say(codec.decoderEfficient),
    "rtc.codec": codec.name ?? UNSUPPORTED,
    "rtc.codec_fmtp": codec.fmtp ?? UNSUPPORTED,
    "rtc.codec_in": codec.inName ?? UNSUPPORTED,
    "rtc.codec_in_fmtp": codec.inFmtp ?? UNSUPPORTED,
    "rtc.codec_out": codec.outName ?? UNSUPPORTED,
    "rtc.codec_out_fmtp": codec.outFmtp ?? UNSUPPORTED,
    "rtc.encoder_kind": implKind(codec.encoder, codec.encoderEfficient),
    "rtc.decoder_kind": implKind(codec.decoder, codec.decoderEfficient),
  }
}

/** A funnel stage a link reached (lib/webrtc/funnel.ts), in ms from its room's
 *  opening, filed under the 0-based round the room opened for. The first
 *  stamp of a stage stands, as in the funnel. */
export function noteLinkStage(id: string, round: number, stage: FunnelStage, ms: number): void {
  const key = `${round}|${id}`
  if (standbyIds.has(id)) standbyLinks.add(key)
  const stages = stamps.get(key) ?? {}
  stages[stage] ??= ms
  stamps.set(key, stages)
}

/** The mesh's roster of standby co-players (outside the playing round's group) */
export function setRtcStandby(ids: readonly string[]): void {
  standbyIds = new Set(ids)
}

/** is this peer on standby right now (its funnel points carry rtc.standby) */
export const isRtcStandby = (id: string): boolean => standbyIds.has(id)

/** The session counted this co-player as seen (#603): kept for the game */
export function noteLinkSeen(id: string): void {
  seenPeers.add(id)
}

/** a peer's selected path changed: counted into the open round, for rtc.path_changes */
export function countPathChange(id: string): void {
  const peer = peers.get(id)
  if (peer) peer.pathChanges += 1
}

/** a new game's trace begins: the peers are numbered afresh and no reading of
 *  an earlier game is a window. Runs at the join, so the join's funnel points
 *  carry the same peer index the rounds do. */
export function startRtcGame(): void {
  stopCoverageActivity()
  stopCoverageActivity = watchPageActivity((hidden) => rtcCoverageVisibilityChanged(hidden))
  round = null
  peers = new Map()
  last = new Map()
  indexOf = new Map()
  loads = []
  pairOf = noPair
  roleOf = () => ({})
  stamps = new Map()
  standbyIds = new Set()
  standbyLinks.clear()
  seenPeers = new Set()
  videoObservedAt = new Map()
}

/** a peer's index in this game, in the order the game first saw it (never the account) */
export function rtcPeerIndex(id: string): number {
  let index = indexOf.get(id)
  if (index === undefined) {
    index = indexOf.size
    indexOf.set(id, index)
  }
  return index
}

/** the round step `round.<next + 1>` opened */
export function openRtcRound(next: number, pair: PairOf = noPair, role: RoleOf = () => ({})): void {
  if (round === next) return
  if (round !== null) closeRtcRound()
  round = next
  roundOpenedAt = Date.now()
  loads = []
  pairOf = pair
  roleOf = role
  const now = monotonicNow()
  coverageVisible = !pageHidden()
  sliceAccountedAt = sliceStartedAt = now
  peers = new Map([...last.keys()].map((id) => [id, makePeer(id)]))
  videoObservedAt = new Map([...last.keys()].map((id) => [id, now]))
}

/** The seconds of the window between two readings of one link in which the
 *  decoder produced frames, else 0: a window needs the same connection and the
 *  same stream before and after, with a counter that grew. */
function decodedSeconds(prev: RtcSample | undefined, cur: RtcSample): number {
  const was = prev?.inbound
  const now = cur.inbound
  if (!prev || !was || !now || prev.link !== cur.link || was.id !== now.id) return 0
  if (prev.at === undefined || cur.at === undefined || was.framesDecoded === undefined || now.framesDecoded === undefined) return 0
  return now.framesDecoded > was.framesDecoded ? Math.max(0, (cur.at - prev.at) / 1000) : 0
}

/** one field of a window list, sorted once so every rank reads off it */
const series = (rates: readonly RtcRates[], field: Numeric): Float64Array =>
  Float64Array.from(rates.flatMap((rate) => (rate[field] === undefined ? [] : [rate[field] as number]))).sort()

/** the sum of one field over a peer's windows */
const total = (rates: readonly RtcRates[], field: Numeric): number => rates.reduce((sum, rate) => sum + (rate[field] ?? 0), 0)

/** seconds the encoder spent limited, by reason, over a peer's round */
function limitedReasons(rates: readonly RtcRates[]): Map<string, number> {
  const limited = new Map<string, number>()
  for (const rate of rates)
    for (const [reason, seconds] of Object.entries(rate.limited)) limited.set(reason, (limited.get(reason) ?? 0) + seconds)
  return limited
}

/** one peer's summary as metrics; adds the reasons it was limited by */
function emitPeer(peer: PeerRound, closing: number, limitedBy: Set<string>, roundS: number): void {
  // the codec is context of every point: a CPU limit beside a software encoder is the finding
  const attrs = linkAttrsOf(peer, closing)
  for (const metric of SUMMARY) {
    const sorted = series(peer.rates, metric.field)
    for (const stat of metric.stats) {
      const value = percentile(sorted, QUANTILE[stat])
      if (value !== undefined) recordDistribution(metric.name, value, metric.unit, { ...attrs, stat })
    }
  }
  const frozen = total(peer.rates, "freezeMs")
  if (frozen > 0) recordDistribution("rtc.freeze_ms", frozen, "millisecond", { ...attrs, stat: "total" })
  const paused = Math.round(total(peer.rates, "pausedS"))
  if (paused > 0) recordCount("rtc.peer_paused", paused, attrs)
  for (const { name, field, attrs: extra } of TOTALS) {
    const sum = total(peer.rates, field)
    if (sum > 0) recordCount(name, sum, { ...attrs, ...extra })
  }
  for (const [reason, seconds] of limitedReasons(peer.rates)) {
    if (!(seconds > 0)) continue
    limitedBy.add(reason)
    recordCount("rtc.quality_limited", 1, { ...attrs, reason })
    recordDistribution("rtc.quality_limited_s", seconds, "second", { ...attrs, reason, stat: "total" })
  }
  if (peer.pathChanges > 0) recordCount("rtc.path_changes", peer.pathChanges, attrs)
  emitLinkRow(peer, closing, attrs, frozen)
  // EXPOSURE: one point per path the link spent connected time on this round
  const base = Object.fromEntries(Object.entries(attrs).filter(([name]) => name !== "rtc.path" && name !== "rtc.relay_protocol"))
  for (const [key, ms] of peer.pathMs) {
    const [path, relay] = key.split("|")
    recordDistribution("rtc.link.path_ms", Math.round(ms), "millisecond", { ...base, "rtc.path": path, ...(relay ? { "rtc.relay_protocol": relay } : {}) })
  }
  // COVERAGE: always sent, 0 included — a pair with no video is the finding. A
  // stat with no frame counter cannot be measured, and is said so instead.
  if (peer.stats.get("coverage") !== false) {
    const covered = peer.coveredS
    // the readings can run a little past the round's own clock: never above 100
    const denominator = Math.max(roundS, covered)
    recordDistribution("rtc.coverage_s", covered, "second", attrs)
    recordDistribution("rtc.coverage_pct", denominator > 0 ? (covered / denominator) * 100 : 0, "percent", attrs)
  }
}

/** THE LINK ROW (rtc-link.ts): rtc.link, rtc.link.ttff_ms and rtc.link.freeze_ms,
 *  on the round's shared attributes plus the row's own and the link's role */
function emitLinkRow(peer: PeerRound, closing: number, attrs: Record<string, string>, frozenMs: number | undefined, standby = false): void {
  const row = linkRow({
    connected: peer.connected,
    // no frame counter all round: whether video came cannot be said
    video: peer.decoded ? true : peer.stats.get("coverage") === false ? undefined : false,
    stages: stamps.get(`${closing}|${peer.id}`) ?? {},
    sdp: peer.sdp,
    seen: seenPeers.has(peer.id),
    links: peer.links.size,
    freezeMs: frozenMs ?? 0,
  })
  // a standby link holds its video back on purpose: not a loss, whatever its funnel reached
  const rowAttrs = { ...attrs, ...roleOf(peer.id), ...row.attrs, ...(standby ? { "rtc.outcome": "standby" } : {}) }
  recordCount("rtc.link", 1, rowAttrs)
  if (row.ttffMs !== undefined) recordDistribution("rtc.link.ttff_ms", row.ttffMs, "millisecond", rowAttrs)
  // an unmeasured link had no video: not a 0 freeze
  if (frozenMs !== undefined) recordDistribution("rtc.link.freeze_ms", row.freezeMs, "millisecond", rowAttrs)
}

/** The round's decode load, once for the device (not per peer): p50 and p95 of
 *  the per-tick streams decoding at once and decoded pixels per second.
 *  Returns false when no tick could be measured (no framesDecoded): nothing is
 *  sent and the round step says `decode_load` unsupported. Otherwise
 *  rtc.decode_load says how many ticks had a size and rate:
 *   - every tick: "ok" on both points;
 *   - some: the streams points say "ok", the pixels points "partial" (over
 *     the ticks that had one);
 *   - none: the streams points say "unsupported" and no pixels point is
 *     sent, never a 0. */
function emitDecodeLoad(ticks: readonly DecodeLoad[], closing: number): boolean {
  if (ticks.length === 0) return false
  const base = { round: String(closing + 1) }
  const pixelTicks = ticks.flatMap((tick) => (tick.pixelsPerS === undefined ? [] : [tick.pixelsPerS]))
  const load = pixelTicks.length === ticks.length ? "ok" : pixelTicks.length > 0 ? "partial" : UNSUPPORTED
  const streams = Float64Array.from(ticks.map((tick) => tick.streams)).sort()
  const pixels = Float64Array.from(pixelTicks).sort()
  for (const stat of ["p50", "p95"] as const) {
    const q = QUANTILE[stat]
    const count = percentile(streams, q)
    if (count !== undefined) recordDistribution("rtc.decoding_streams", count, "none", { ...base, stat, "rtc.decode_load": load === "unsupported" ? load : "ok" })
    const rate = percentile(pixels, q)
    if (rate !== undefined) recordDistribution("rtc.decoded_pixels_per_s", rate, "none", { ...base, stat, "rtc.decode_load": load })
  }
  return true
}

/** Close the open round: one summary per peer as metrics, and the round
 *  step's line. `unsupported`: the categories some peer's stats never carried
 *  (`coverage`: no framesDecoded, so coverage was not measured; the device-side
 *  ones of statsCoverage), said on the round step, not sent as 0. Null when
 *  nothing was measured. */
export function closeRtcRound(): { summary: string; unsupported?: string } | null {
  const closing = round
  flushRtcCoverageSlice()
  const roundS = (Date.now() - roundOpenedAt) / 1000
  const measured = [...peers.values()].filter((peer) => peer.rates.length > 0)
  const unmeasured = closing === null ? [] : unmeasuredLinks(closing, measured)
  const ticks = loads
  loads = []
  round = null
  peers = new Map()
  videoObservedAt = new Map()
  if (closing === null) return null
  // a link with no reading all round still owes its row: not-connected is the finding (#632)
  for (const peer of unmeasured) attempt(() => emitLinkRow(peer, closing, linkAttrsOf(peer, closing), undefined, standbyLinks.has(`${closing}|${peer.id}`)))
  if (measured.length === 0) return null
  try {
    const limitedBy = new Set<string>()
    // one peer failing to emit must not take the others' summaries with it
    for (const peer of measured) attempt(() => emitPeer(peer, closing, limitedBy, roundS))
    const unsupported = [...new Set([...measured.flatMap(unsupportedOf), ...(emitDecodeLoad(ticks, closing) || !measured.some((peer) => peer.stats.get("coverage") === false) ? [] : ["decode_load"])])].sort().join(",")
    return { summary: summaryLine(measured, limitedBy), ...(unsupported ? { unsupported } : {}) }
  } catch {
    return null
  }
}

/** the links of the closing round that no stats reading measured: peers the
 *  round knew without a single rate, and links its room stamped a funnel
 *  stage for that no report ever carried */
function unmeasuredLinks(closing: number, measured: readonly PeerRound[]): PeerRound[] {
  const known = new Set([...measured, ...peers.values()].map((peer) => peer.id))
  // a peer seeded from the previous room that this round's reports never carried is not this round's link
  const out = [...peers.values()].filter((peer) => !measured.includes(peer) && (peer.reported || stamps.has(`${closing}|${peer.id}`)))
  const prefix = `${closing}|`
  for (const key of stamps.keys()) {
    const id = key.startsWith(prefix) ? key.slice(prefix.length) : undefined
    if (id !== undefined && !known.has(id)) {
      known.add(id)
      out.push(makePeer(id))
    }
  }
  return out
}

/** the attributes a link's points of a round share, as emitPeer builds them */
const linkAttrsOf = (peer: PeerRound, closing: number): Record<string, string> => ({
  "rtc.path": peer.path,
  ...(peer.relayProtocol ? { "rtc.relay_protocol": peer.relayProtocol } : {}),
  round: String(closing + 1),
  "rtc.peer": String(peer.index),
  ...pairOf(peer.id, closing + 1),
  ...codecAttrs(peer.codec),
  // THE MEASURED SPAN (archive#829): which stretch of the round the round's
  // points summarise, as the stats timestamps read them. A link with no
  // reading all round sends no span, only its row.
  ...(peer.spanReadings > 0 && peer.spanFirstAt !== undefined && peer.spanLastAt !== undefined
    ? {
        "rtc.span_first_ms": String(peer.spanFirstAt),
        "rtc.span_last_ms": String(peer.spanLastAt),
        "rtc.span_readings": String(peer.spanReadings),
      }
    : {}),
})

const attempt = (send: () => void): void => {
  try {
    send()
  } catch {
    /* telemetry never breaks the mesh */
  }
}

/** "3 peers: rtt p95 180ms, loss p95 1.2%, in 22fps, out 24fps, limited cpu" */
function summaryLine(measured: readonly PeerRound[], limitedBy: ReadonlySet<string>): string {
  const all = measured.flatMap((peer) => peer.rates)
  const parts: string[] = []
  for (const { field, q, say } of LINE) {
    const value = percentile(series(all, field), q)
    if (value !== undefined) parts.push(say(value))
  }
  if (limitedBy.size > 0) parts.push(`limited ${[...limitedBy].sort().join("+")}`)
  const head = `${measured.length} ${measured.length === 1 ? "peer" : "peers"}`
  return parts.length > 0 ? `${head}: ${parts.join(", ")}` : head
}

/** One link's time to its first new frame after a return (#557), as `rtc.resume_ms`.
 *  `attrs` are the link's: pair, peer index, round. A point per measured return;
 *  a link whose frames never came back sends none. */
export function recordResume(event: ResumeEvent, attrs: Record<string, string>): void {
  const keyframe: Record<string, string> = event.keyframe ? { "keyframe.method": event.keyframe.method, "keyframe.verified": event.keyframe.verified } : {}
  recordDistribution("rtc.resume_ms", event.ms, "millisecond", { ...attrs, side: event.side, ...keyframe })
}
