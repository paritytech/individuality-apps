// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE CONNECTION FUNNEL AS A METRIC: `rtc.funnel_ms`, one point per stage a
 * link reaches (lib/webrtc/funnel.ts), in ms from the mesh opening, from each
 * end. Count pairs per stage with count(value) by stage; the time between two
 * stages is the difference of their points under one rtc.pair. A pair that
 * never connects has no connected point: its join rtc.peer step names the last
 * stage it reached (`rtc.last_stage`).
 */
import { recordDistribution } from "../telemetry"
import { isInitiator, type StageEvent } from "../webrtc/funnel"

/** which end of the link this device is, as `rtc.role` */
export function roleAttrs(self: string | null, peer: string): Record<string, string> {
  return self === null ? {} : { "rtc.role": isInitiator(self, peer) ? "initiator" : "answerer" }
}

/** `attrs` are the link's: pair, peer index, round, role */
export function recordFunnelStage(event: StageEvent, attrs: Record<string, string>): void {
  recordDistribution("rtc.funnel_ms", event.ms, "millisecond", { stage: event.stage, ...attrs })
}
