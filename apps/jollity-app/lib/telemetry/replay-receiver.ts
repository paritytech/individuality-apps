// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { InboundVideo, RtcSample } from "../webrtc/rtc-stats"

/** Passive evidence from the mesh's existing getStats poll. It deliberately
 * does not diagnose why a stream changed or share the sender's rate fields. */
export interface ReplayReceiverScope {
  roomKey: string
  selfId: string
  meshGeneration: number
}

type Row = { id: string; quality?: RtcSample }
type Emit = (payload: Record<string, unknown>) => void
export interface ReplayReceiverPoll {
  startedMonotonicMs: number
  completedMonotonicMs: number
  roundAtRequest: number | null
  roundAtCompletion: number | null
}
type Previous = { sample?: RtcSample; signature: string; emittedAt: number; round: number | null }

const HEARTBEAT_MS = 15_000
const MAX_WINDOW_MS = 6_000
const COUNTERS = ["framesDecoded", "framesDropped", "packetsReceived", "packetsLost", "freezeCount", "totalFreezesDuration", "nackCount", "pliCount", "jitterMs", "jitterBufferDelay", "jitterBufferEmittedCount", "totalDecodeTime"] as const
const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined

// Browser-provided strings cannot make one observation exceed the log line
// budget. Bound UTF-8 bytes too (a character need not be one byte).
function text(value: unknown, limit = 96): string | undefined {
  if (typeof value !== "string" || !value) return undefined
  let result = value.slice(0, limit)
  const encoder = new TextEncoder()
  while (encoder.encode(result).length > limit) result = result.slice(0, -1)
  return result
}

function bucket(fps: number | undefined): string {
  if (fps === undefined) return "unknown"
  return fps === 0 ? "zero" : fps < 8 ? "under-8" : fps < 15 ? "8-15" : fps < 24 ? "15-24" : "24-plus"
}

function counterReset(before: InboundVideo, after: InboundVideo): boolean {
  return (["framesDecoded", "packetsReceived"] as const).some((key) => {
    const was = finite(before[key])
    const now = finite(after[key])
    return was !== undefined && now !== undefined && now < was
  })
}

export class ReplayReceiverObserver {
  private readonly previous = new Map<string, Previous>()

  constructor(private readonly scope: ReplayReceiverScope, private readonly emit: Emit) {}

  /** Lifecycle edges can arrive without any intervening stats poll. */
  reset(): void {
    this.previous.clear()
  }

  /** Called synchronously after the existing report resolves. Missing and
   * hidden samples break rate continuity; they never manufacture a zero FPS. */
  observe(rows: readonly Row[], nowMs: number, hidden: boolean, gameIndex: number | null, round: number | null, poll?: ReplayReceiverPoll): void {
    // Lifecycle evidence already records backgrounding. Suppress receiver rows
    // there, and never measure across the suspension on the first visible poll.
    if (hidden) {
      this.reset()
      return
    }
    const present = new Set(rows.map((row) => row.id))
    for (const peer of this.previous.keys()) if (!present.has(peer)) this.previous.delete(peer)
    for (const row of rows) {
      const prior = this.previous.get(row.id)
      const sample = row.quality
      const incoming = sample?.inbound
      const before = prior?.sample
      const sameStream = !!incoming?.id && !!before?.inbound && before.link === sample?.link && before.inbound.id === incoming.id
      const at = finite(sample?.at)
      const beforeAt = finite(before?.at)
      const interval = sameStream && at !== undefined && beforeAt !== undefined ? at - beforeAt : undefined
      const stale = interval !== undefined && interval <= 0
      const reset = sameStream && counterReset(before!.inbound!, incoming!)
      const trustedWindow = !reset && interval !== undefined && interval > 0 && interval <= MAX_WINDOW_MS
      const decodedBefore = finite(before?.inbound?.framesDecoded)
      const decodedNow = finite(incoming?.framesDecoded)
      const decodedDelta = trustedWindow && decodedBefore !== undefined && decodedNow !== undefined ? decodedNow - decodedBefore : undefined
      const rawFps = finite(incoming?.fps)
      const reportedFps = rawFps !== undefined && rawFps >= 0 ? rawFps : undefined
      const derivedFps = decodedDelta !== undefined && decodedDelta >= 0 ? decodedDelta * 1_000 / interval! : undefined
      const fps = stale ? undefined : reportedFps ?? derivedFps
      const decoding = stale ? "unknown" : decodedDelta !== undefined ? decodedDelta > 0 ? "decoding" : "no-decoded-frames" : fps === undefined ? "unknown" : fps > 0 ? "decoding" : "no-decoded-frames"
      const sampleState = !incoming ? "missing" : stale ? "stale" : reset ? "counter-reset" : trustedWindow ? "window" : "baseline"
      const path = sample ? {
        pairId: text(sample.transportId), localType: text(sample.localType), remoteType: text(sample.remoteType),
        protocol: text(sample.protocol), relayProtocol: text(sample.relayProtocol), networkType: text(sample.networkType),
      } : undefined
      // Window availability is provenance, not a quality change: the second
      // steady sample should not produce a redundant row just for having one.
      const quality = {
        inbound: !!incoming, link: sample?.link, streamId: text(incoming?.id, 128), hidden,
        width: finite(incoming?.width), height: finite(incoming?.height), fpsBucket: bucket(fps), decoding,
        codec: text(incoming?.codec), codecFmtp: text(incoming?.codecFmtp), path,
      }
      const observedRound = poll && poll.roundAtRequest !== poll.roundAtCompletion ? null : round
      const signature = JSON.stringify([quality, stale, reset, incoming?.id, sample?.transportId, gameIndex, observedRound])
      const reason = !prior ? "first-observation" : signature !== prior.signature ? "observed-change" : nowMs - prior.emittedAt >= HEARTBEAT_MS ? "heartbeat" : undefined
      if (reason) {
        const counters: Record<string, number> = {}
        for (const key of COUNTERS) {
          const value = finite(incoming?.[key])
          if (value !== undefined) counters[key] = value
        }
        try { this.emit({
          // These are app-controlled room/account identities. A full room key
          // contains every participant; clipping it would merge distinct rooms.
          ...quality, roomKey: this.scope.roomKey, selfId: this.scope.selfId,
          meshGeneration: this.scope.meshGeneration, peerId: row.id, gameIndex,
          round: observedRound,
          ...(poll ? { poll } : {}),
          direction: "incoming", reason, sampleState, sampleTimestampMs: at, reportedFps, fps,
          fpsSource: fps === undefined ? undefined : reportedFps !== undefined ? "reported" : "decoded-counter-window",
          ...(trustedWindow ? { windowStartTimestampMs: beforeAt, windowEndTimestampMs: at, windowMs: interval,
            windowRoundStart: prior?.round ?? null, windowRoundEnd: observedRound } : {}),
          ...(decodedDelta !== undefined ? { framesDecodedDelta: decodedDelta, derivedFps } : {}),
          counters, decoderImplementation: text(incoming?.decoderImplementation), powerEfficientDecoder: incoming?.powerEfficientDecoder,
        }) } catch { /* a failed diagnostic sink must not interrupt the poll */ }
      }
      this.previous.set(row.id, {
        // A repeated/out-of-order report must not move the accepted baseline
        // backwards. Visibility and missing input always end continuity.
        sample: !incoming ? undefined : stale ? before : sample,
        signature, emittedAt: reason ? nowMs : prior!.emittedAt, round: observedRound,
      })
    }
  }
}
