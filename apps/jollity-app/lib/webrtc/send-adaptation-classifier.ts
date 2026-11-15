// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Pure page-wide upload classification. This module deliberately has no
 * browser or framework imports so its policy can be exhaustively unit tested. */

export type SendRungIndex = number
export type SendRoute = "direct" | "relay" | "mixed" | "unknown"
type SendPressure = "bandwidth" | "cpu" | "mixed" | "healthy" | "unknown"

export interface VideoRung {
  index: SendRungIndex
  name: string
  maxBitrate: number
  maxFramerate: number
  targetShortSide: number
}

export type VideoRungField = "maxBitrate" | "scaleResolutionDownBy" | "maxFramerate"
export interface VideoRungSenderResult {
  id: string
  status: "applied" | "partial" | "pending" | "refused" | "missing"
  appliedFields: VideoRungField[]
  refusedFields: VideoRungField[]
  readBack?: { maxBitrate?: number; scaleResolutionDownBy?: number; maxFramerate?: number }
  encoded?: { width?: number; height?: number; fps?: number }
}

export interface VideoRungApplyResult {
  requested: SendRungIndex
  senders: VideoRungSenderResult[]
  uniform: boolean
}

/** The upload ladder, top rung first. "full" is a feed's ceiling: 360 on the
 *  short side at 24 fps and 300 kbps, about the bits per pixel 480 had at
 *  500 kbps, so the picture is as clean and only smaller. Five such feeds
 *  (1.5 Mbit/s) fit a phone's upload where 2.5 Mbit/s held phones back by
 *  bandwidth. It is also WebRTC's own starting estimate, so a new link sends
 *  at the cap from its first seconds instead of climbing to it. */
export const VIDEO_RUNGS: readonly VideoRung[] = [
  { index: 0, name: "full", maxBitrate: 300_000, maxFramerate: 24, targetShortSide: 360 },
  { index: 1, name: "lean", maxBitrate: 220_000, maxFramerate: 24, targetShortSide: 360 },
  { index: 2, name: "low", maxBitrate: 140_000, maxFramerate: 18, targetShortSide: 240 },
  { index: 3, name: "minimum", maxBitrate: 80_000, maxFramerate: 12, targetShortSide: 180 },
  { index: 4, name: "survival", maxBitrate: 45_000, maxFramerate: 8, targetShortSide: 120 },
] as const

export const FULL_VIDEO_RUNG = VIDEO_RUNGS.find((rung) => rung.name === "full")!
export const SEND_ADAPTATION_OBSERVE_MS = 3_000

export const rungAbove = (index: SendRungIndex, rungs: readonly VideoRung[] = VIDEO_RUNGS): VideoRung | undefined => {
  const position = rungs.findIndex((rung) => rung.index === index)
  return position > 0 ? rungs[position - 1] : undefined
}

export const rungBelow = (index: SendRungIndex, rungs: readonly VideoRung[] = VIDEO_RUNGS): VideoRung | undefined => {
  const position = rungs.findIndex((rung) => rung.index === index)
  return position >= 0 && position + 1 < rungs.length ? rungs[position + 1] : undefined
}

export const fitRung = (
  capacityKbps: number,
  activeSenders: number,
  headroomRatio = 0.75,
  rungs: readonly VideoRung[] = VIDEO_RUNGS,
): SendRungIndex => {
  if (activeSenders <= 0) return FULL_VIDEO_RUNG.index
  const budgetBps = capacityKbps * 1_000 * headroomRatio
  return rungs.find((rung) => rung.maxBitrate * activeSenders <= budgetBps)?.index ?? rungs.at(-1)!.index
}

interface EffectsHealthSnapshot {
  windowMs: number
  frameP95Ms?: number
  slowFrameShare?: number
  loafP95Ms?: number
  loafMaxMs?: number
}

export interface SendLinkWindow {
  id: string
  active: boolean
  valid: boolean
  durationMs?: number
  reason?: "none" | "bandwidth" | "cpu" | "other"
  reasonDurations?: Partial<Record<"none" | "bandwidth" | "cpu" | "other", number>>
  outKbps?: number
  targetKbps?: number
  availableKbps?: number
  queueMsPerPacket?: number
  rttMs?: number
  encodeMsPerFrame?: number
  encodeSeconds?: number
  framesEncoded?: number
  framesSent?: number
  payloadBytes?: number
  headerBytes?: number
  transportBytes?: number
  transportAllowanceBytes?: number
  encoderImplementation?: string
  powerEfficientEncoder?: boolean
  width?: number
  height?: number
  fps?: number
  route: SendRoute
}

export interface SendAdaptationWindow {
  atMs: number
  durationMs: number
  hidden: boolean
  networkType?: string
  links: SendLinkWindow[]
  /** The currently applied page rung. Every peer sender has this same cap. */
  rungMaxBitrate?: number
  effects: EffectsHealthSnapshot
}

export interface SendWindowSummary {
  atMs: number
  durationMs: number
  hidden: boolean
  networkType?: string
  effects: EffectsHealthSnapshot
  activeSenders: number
  validSenders: number
  actualKbps?: number
  /** Coverage and classification of the encoder's own per-link congestion
   * target against the currently applied rung cap. */
  targetBitrateCoverage: number
  targetNearCapShare: number
  bandwidthLowTargetShare: number
  payloadBytes?: number
  headerBytes?: number
  transportBytes?: number
  transportAllowanceBytes?: number
  /** RTP bytes from exactly the links represented by transportBytes. */
  transportCoveredPayloadBytes?: number
  transportCoveredHeaderBytes?: number
  /** Per-link coverage denominator; selected-pair churn excludes only the
   * affected peer rather than blanking every sender in the window. */
  transportCoveredSenderSeconds?: number
  transportExpectedSenderSeconds?: number
  availableKbps?: number
  queueMsPerPacket?: number
  rttMs?: number
  baselineRttMs?: number
  bandwidthShare: number
  cpuShare: number
  noneShare: number
  stalledShare: number
  encodeMsPerFrame?: number
  encodeShare?: number
  encoderImplementations: string[]
  powerEfficientEncoder?: boolean
  route: SendRoute
  pressure: SendPressure
  severe: boolean
  baselineOnly?: boolean
}

export const medianValue = (values: number[]): number | undefined => {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const sumKnown = (values: Array<number | undefined>): number | undefined =>
  values.some((value) => value === undefined) ? undefined : (values as number[]).reduce((sum, value) => sum + value, 0)

const minKnown = (values: Array<number | undefined>): number | undefined =>
  values.some((value) => value === undefined) ? undefined : Math.min(...(values as number[]))

const aggregateRoute = (routes: SendRoute[]): SendRoute => {
  const known = new Set(routes.filter((route) => route !== "unknown"))
  if (!known.size) return "unknown"
  if (known.size > 1 || known.has("mixed")) return "mixed"
  return [...known][0]
}

export function summarizeSendWindow(window: SendAdaptationWindow, baselines: ReadonlyMap<string, number> = new Map()): SendWindowSummary {
  const active = window.links.filter((link) => link.active)
  const valid = active.filter((link) => link.valid)
  const count = valid.length
  const share = (reason: SendLinkWindow["reason"]) => (count ? valid.filter((link) => link.reason === reason).length / count : 0)
  const encodeSeconds = valid.map((link) => link.encodeSeconds).filter((value): value is number => value !== undefined)
  const durations = valid.map((link) => link.durationMs).filter((value): value is number => value !== undefined && value > 0)
  const windowSeconds = medianValue(durations)?.valueOf()
  const implementations = [...new Set(valid.map((link) => link.encoderImplementation).filter((value): value is string => Boolean(value)))].sort()
  const power = valid.map((link) => link.powerEfficientEncoder).filter((value): value is boolean => value !== undefined)
  const rungMaxBitrate = window.rungMaxBitrate
  const targetRatios = rungMaxBitrate && rungMaxBitrate > 0
    ? valid.map((link) => link.targetKbps === undefined ? undefined : (link.targetKbps * 1_000) / rungMaxBitrate)
    : valid.map(() => undefined)
  const targetBitrateCoverage = count ? targetRatios.filter((ratio) => ratio !== undefined).length / count : 0
  const targetNearCapShare = count ? targetRatios.filter((ratio) => ratio !== undefined && ratio >= 0.85).length / count : 0
  const bandwidthLowTargetShare = count
    ? valid.filter((link, index) => link.reason === "bandwidth" && targetRatios[index] !== undefined && targetRatios[index]! < 0.85).length / count
    : 0
  const transportCovered = valid.filter(
    (link) => link.durationMs !== undefined
      && link.durationMs > 0
      && link.payloadBytes !== undefined
      && link.headerBytes !== undefined
      && link.transportBytes !== undefined
      && link.transportAllowanceBytes !== undefined,
  )
  const expectedSenderSeconds = valid.reduce((sum, link) => sum + Math.max(0, link.durationMs ?? 0) / 1_000, 0)
  const coveredSenderSeconds = transportCovered.reduce((sum, link) => sum + link.durationMs! / 1_000, 0)
  const summary: SendWindowSummary = {
    atMs: window.atMs,
    durationMs: window.durationMs,
    hidden: window.hidden,
    networkType: window.networkType,
    effects: window.effects,
    activeSenders: active.length,
    validSenders: count,
    actualKbps: sumKnown(valid.map((link) => link.outKbps)),
    targetBitrateCoverage,
    targetNearCapShare,
    bandwidthLowTargetShare,
    payloadBytes: sumKnown(valid.map((link) => link.payloadBytes)),
    headerBytes: sumKnown(valid.map((link) => link.headerBytes)),
    transportBytes: transportCovered.length ? transportCovered.reduce((sum, link) => sum + link.transportBytes!, 0) : undefined,
    transportAllowanceBytes: transportCovered.length ? transportCovered.reduce((sum, link) => sum + link.transportAllowanceBytes!, 0) : undefined,
    transportCoveredPayloadBytes: transportCovered.length ? transportCovered.reduce((sum, link) => sum + link.payloadBytes!, 0) : undefined,
    transportCoveredHeaderBytes: transportCovered.length ? transportCovered.reduce((sum, link) => sum + link.headerBytes!, 0) : undefined,
    transportCoveredSenderSeconds: coveredSenderSeconds || undefined,
    transportExpectedSenderSeconds: expectedSenderSeconds || undefined,
    // PeerConnections on one page observe the same uplink bottleneck. Summing
    // their estimates manufactures capacity; the lowest complete estimate is
    // conservative and remains safe across BUNDLE and multi-PC meshes.
    availableKbps: minKnown(valid.map((link) => link.availableKbps)),
    queueMsPerPacket: medianValue(valid.map((link) => link.queueMsPerPacket).filter((value): value is number => value !== undefined)),
    rttMs: medianValue(valid.map((link) => link.rttMs).filter((value): value is number => value !== undefined)),
    baselineRttMs: medianValue(valid.map((link) => baselines.get(link.id)).filter((value): value is number => value !== undefined)),
    bandwidthShare: share("bandwidth"),
    cpuShare: share("cpu"),
    noneShare: share("none"),
    stalledShare: count ? valid.filter((link) => link.framesEncoded === 0 && (link.outKbps ?? Infinity) <= 5).length / count : 0,
    encodeMsPerFrame: medianValue(valid.map((link) => link.encodeMsPerFrame).filter((value): value is number => value !== undefined)),
    encodeShare: windowSeconds && encodeSeconds.length ? encodeSeconds.reduce((sum, value) => sum + value, 0) / (windowSeconds / 1_000) : undefined,
    encoderImplementations: implementations,
    powerEfficientEncoder: power.length ? power.every(Boolean) : undefined,
    route: aggregateRoute(valid.map((link) => link.route)),
    pressure: "unknown",
    severe: false,
    baselineOnly: !count || count !== active.length,
  }
  return { ...summary, ...classifySendWindow(summary) }
}

export function classifySendWindow(summary: SendWindowSummary): Pick<SendWindowSummary, "pressure" | "severe"> {
  if (summary.hidden || summary.validSenders === 0) return { pressure: "unknown", severe: false }
  const queuePressure = (summary.queueMsPerPacket ?? -Infinity) >= 10
  const absoluteRttPressure = (summary.rttMs ?? -Infinity) >= 250
  // Path changes can legitimately move a very low Wi-Fi RTT to a higher
  // cellular RTT. Keep the historical absolute floor so that a frozen 21 ms
  // baseline does not make an otherwise healthy 65 ms route look congested.
  const relativeRttCeiling = summary.baselineRttMs === undefined ? undefined : Math.max(200, 1.25 * summary.baselineRttMs)
  const relativeRttPressure = relativeRttCeiling !== undefined && (summary.rttMs ?? -Infinity) >= relativeRttCeiling
  const targetsCompleteAndNearCap = summary.targetBitrateCoverage === 1 && summary.targetNearCapShare === 1
  // A complete near-cap target says congestion control is still asking the
  // encoder for our whole rung. On a naturally high-latency path, absolute
  // RTT alone therefore cannot prove upload pressure; queue or a low/missing
  // target still can.
  const absoluteRttCorroborates = absoluteRttPressure && (!targetsCompleteAndNearCap || queuePressure)
  const reasonCorroborated =
    summary.bandwidthShare >= 0.5
    && (queuePressure
      || absoluteRttCorroborates
      || relativeRttPressure
      || summary.bandwidthLowTargetShare > 0)
  const bandwidth = reasonCorroborated
  const severe = summary.stalledShare >= 0.5 && (summary.queueMsPerPacket ?? -Infinity) >= 100
  if (bandwidth || severe) return { pressure: "bandwidth", severe }

  const cpu = summary.cpuShare >= 0.5
  if (cpu) return { pressure: "cpu", severe: false }

  const queueValuesHealthy = summary.queueMsPerPacket !== undefined && summary.queueMsPerPacket < 10
  const relativeRttHealthy = relativeRttCeiling === undefined || summary.rttMs! < relativeRttCeiling
  const rttValuesHealthy = summary.rttMs !== undefined && summary.rttMs < 250 && relativeRttHealthy
  const targetsHealthy = targetsCompleteAndNearCap
  const targetlessHealthy =
    summary.targetBitrateCoverage === 0
    && summary.noneShare > 0.5
    && summary.bandwidthShare < 0.5
  if (((summary.noneShare >= 0.5 || summary.bandwidthShare >= 0.5) && targetsHealthy || targetlessHealthy) && queueValuesHealthy && rttValuesHealthy)
    return { pressure: "healthy", severe: false }
  if (summary.bandwidthShare > 0 && summary.cpuShare > 0) return { pressure: "mixed", severe: false }
  return { pressure: "unknown", severe: false }
}
