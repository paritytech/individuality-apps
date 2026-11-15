// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

interface RtcpClockSample {
  senderReportId: string
  remoteTimestampMs: number
  receiptTimestampMs: number
  rttMs: number
  offsetMs: number
  source: "remote-outbound-rtp"
}

type RtcpClockUnavailableReason =
  | "no-remote-outbound-report"
  | "no-remote-timestamp"
  | "no-round-trip-time"
  | "remote-timestamp-never-advanced"
  | "not-enough-samples"
  | "stats-threw"

export interface RtcpClockEvidence {
  samples: RtcpClockSample[]
  unavailableReason?: Exclude<RtcpClockUnavailableReason, "remote-timestamp-never-advanced" | "not-enough-samples">
}

type StatsRecord = {
  id?: unknown
  type?: unknown
  kind?: unknown
  mediaType?: unknown
  remoteId?: unknown
  remoteTimestamp?: unknown
  timestamp?: unknown
  roundTripTime?: unknown
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

/** Extract wall-clock evidence from the same stats snapshot already used for
 * receiver quality. Nothing here changes a connection or feeds a game clock. */
export function readRtcpClockEvidence(report: RTCStatsReport): RtcpClockEvidence {
  try {
    const entries: StatsRecord[] = []
    report.forEach((entry) => entries.push(entry as StatsRecord))
    const byId = new Map(entries.flatMap((entry) => typeof entry.id === "string" ? [[entry.id, entry] as const] : []))
    const samples: RtcpClockSample[] = []
    let remoteReports = 0
    let remoteTimestamps = 0
    let roundTripTimes = 0
    for (const inbound of entries) {
      if (inbound.type !== "inbound-rtp" || (inbound.kind ?? inbound.mediaType) !== "video" || typeof inbound.remoteId !== "string") continue
      const remote = byId.get(inbound.remoteId)
      if (remote?.type !== "remote-outbound-rtp") continue
      remoteReports++
      if (!finite(remote.remoteTimestamp) || !finite(remote.timestamp)) continue
      remoteTimestamps++
      if (!finite(remote.roundTripTime) || remote.roundTripTime < 0) continue
      roundTripTimes++
      const rttMs = remote.roundTripTime * 1_000
      samples.push({
        senderReportId: inbound.remoteId,
        remoteTimestampMs: remote.remoteTimestamp,
        receiptTimestampMs: remote.timestamp,
        rttMs,
        offsetMs: remote.timestamp - remote.remoteTimestamp - rttMs / 2,
        source: "remote-outbound-rtp",
      })
    }
    if (samples.length > 0) return { samples }
    const unavailableReason = remoteReports === 0
      ? "no-remote-outbound-report"
      : remoteTimestamps === 0
        ? "no-remote-timestamp"
        : roundTripTimes === 0
          ? "no-round-trip-time"
          : "no-remote-outbound-report"
    return { samples, unavailableReason }
  } catch {
    return { samples: [], unavailableReason: "stats-threw" }
  }
}

type Row = { id: string; statsLink?: number; rtcpClock?: RtcpClockEvidence }
type Emit = (payload: Record<string, unknown>) => void
type Aggregate = {
  peerId: string
  link: number
  round: number
  gameIndex: number | null
  offsets: number[]
  rtts: number[]
  sawDuplicate: boolean
  unavailableReason?: RtcpClockEvidence["unavailableReason"]
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

/** One aggregate per physical peer link and round. A sender report is counted
 * once even though the three-second poll can return it repeatedly. */
export class RtcpClockObserver {
  private readonly aggregates = new Map<string, Aggregate>()
  private readonly lastSenderReports = new Map<string, number>()

  constructor(
    private readonly scope: {
      roomKey: string
      groupId: string
      selfId: string
      meshGeneration: number
      browserBuild: string
      hostBuild: string
    },
    private readonly emit: Emit,
  ) {}

  observe(rows: readonly Row[], gameIndex: number | null, round: number | null): void {
    try {
      const active = new Set<string>()
      for (const row of rows) {
        const link = row.statsLink
        if (round === null || !Number.isInteger(round) || !finite(link)) continue
        const key = `${row.id}\u0000${link}\u0000${round}`
        active.add(key)
        for (const [otherKey, aggregate] of this.aggregates) {
          if (aggregate.peerId === row.id && otherKey !== key) this.finish(otherKey)
        }
        let aggregate = this.aggregates.get(key)
        if (!aggregate) {
          aggregate = { peerId: row.id, link, round, gameIndex, offsets: [], rtts: [], sawDuplicate: false }
          this.aggregates.set(key, aggregate)
        }
        if (row.rtcpClock?.unavailableReason) aggregate.unavailableReason = row.rtcpClock.unavailableReason
        for (const sample of row.rtcpClock?.samples ?? []) {
          if (!finite(sample.remoteTimestampMs) || !finite(sample.offsetMs) || !finite(sample.rttMs) || sample.rttMs < 0) continue
          const senderKey = `${row.id}\u0000${link}\u0000${sample.senderReportId}`
          const previousTimestamp = this.lastSenderReports.get(senderKey)
          if (previousTimestamp === sample.remoteTimestampMs) {
            aggregate.sawDuplicate = true
            continue
          }
          this.lastSenderReports.set(senderKey, sample.remoteTimestampMs)
          aggregate.offsets.push(sample.offsetMs)
          aggregate.rtts.push(sample.rttMs)
        }
      }
      for (const [key] of this.aggregates) if (!active.has(key)) this.finish(key)
    } catch {
      // Observation must never interrupt receiver quality or health decisions.
    }
  }

  flush(): void {
    try {
      for (const key of [...this.aggregates.keys()]) this.finish(key)
      this.lastSenderReports.clear()
    } catch {
      // A failed diagnostic sink must not escape effect cleanup.
    }
  }

  private finish(key: string): void {
    const aggregate = this.aggregates.get(key)
    this.aggregates.delete(key)
    if (!aggregate) return
    const available = aggregate.offsets.length >= 3
    const reason: RtcpClockUnavailableReason | undefined = available
      ? undefined
      : aggregate.offsets.length <= 1 && aggregate.sawDuplicate
        ? "remote-timestamp-never-advanced"
        : aggregate.offsets.length > 0
          ? "not-enough-samples"
          : aggregate.unavailableReason ?? "not-enough-samples"
    try {
      this.emit({
        roomKey: this.scope.roomKey,
        groupId: this.scope.groupId,
        selfId: this.scope.selfId,
        meshGeneration: this.scope.meshGeneration,
        peerId: aggregate.peerId,
        gameIndex: aggregate.gameIndex,
        round: aggregate.round,
        link: aggregate.link,
        sampleCount: aggregate.offsets.length,
        browserBuild: this.scope.browserBuild,
        hostBuild: this.scope.hostBuild,
        status: available ? "ok" : "unavailable",
        ...(reason ? { reason } : {
          medianOffsetMs: median(aggregate.offsets),
          minOffsetMs: Math.min(...aggregate.offsets),
          maxOffsetMs: Math.max(...aggregate.offsets),
          medianRttMs: median(aggregate.rtts),
        }),
        source: "remote-outbound-rtp",
      })
    } catch {
      // Telemetry stays best-effort and observe-only.
    }
  }
}
