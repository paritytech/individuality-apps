// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * SIGNALLING HEALTH AS TELEMETRY: statement-store problems look like ICE
 * problems, so they are recorded where a dashboard can tell them apart.
 *
 *  - `rtc.signal_rtt_ms`        distribution, offer sent to answer received
 *    (lib/webrtc/offer-clock.ts; one device's monotonic clock, never a wall clock), by `rtc.signal_via` (statement | channel)
 *    and `rtc.signal_peer_present` ("true" | "false": the peer had been heard
 *    from within the presence window when the offer was posted). "false" rows
 *    include the peer's absence (74 s to a backgrounded app has been seen, #370) and
 *    are not signalling health: filter on "true" for that
 *  - `rtc.signal_rtt_from_seen_ms`  distribution, for an offer to an ABSENT
 *    peer: the peer's first frame after the offer to its answer, how fast a late
 *    peer answers (same attributes; none when the answer was the first frame)
 *  - `rtc.signal_problems`      counter, one per submit that backed off
 *    (`retry`), gave up (`failed`), by `rtc.signal_event`, `rtc.signal_frame`
 *    (desc | cand | presence) and `rtc.signal_reason` (timeout | error; a
 *    retry is always error, only a give-up can be timeout); under
 *    the pair of the peer it was for, when it was for one
 *  - `rtc.signal_slot_wait_ms`  distribution, a frame's wait for one of the
 *    concurrent submit slots, the transport's backpressure (told from 1 s)
 *  - `rtc.signal_replaced`      counter, a frame that waited for its channel
 *    (one submit in flight per channel) and was replaced by a newer,
 *    different one before it was sent, by `rtc.signal_frame`; under the pair
 *    of the peer it was for, when it was for one
 *  - `rtc.store_margin_ms`      distribution, the store clock's acceptance
 *    margin over chain time, sent when a re-stamp after the node's
 *    `alreadyExpired` was accepted (lib/store-clock.ts): near 0 on a live
 *    network, the chain's lag on a dev node. By `rtc.store_base` (chain | device)
 *  - `rtc.store_calibration`    counter, one waiting-room calibration
 *    (lib/store-calibration.ts) by `rtc.store_outcome` (accepted | learned |
 *    rejected | failed); with `rtc.store_calibration_ms` (its duration) and
 *    `rtc.store_calibration_margin_ms` (the margin afterwards), both numbers
 *  - `rtc.store_time_rejected`  counter, a statement rejected for time on both
 *    stamps, once a session until the margin moves
 *  - `rtc.store_interrupted`    counter, the host ended the room's statement
 *    subscription (lib/host/statement-store.ts), by `rtc.store_reason`
 *  - `rtc.store_resubscribe`    counter, the subscription opened again after
 *    that, by `rtc.store_attempt` (reopenings since pages last flowed)
 *
 * The events come from the statement-core transport's `onSubmit` hook
 * (packages/jollity-statement-core/src/statementTransport.ts), which carries no frame
 * contents; the engine imports nothing from the app.
 */
import { recordCount, recordDistribution } from "../telemetry"
import type { StoreCalibration, StoreClockEvent, SubmitEvent } from "@jollity/statement-core"
import type { SignalRttEvent } from "../webrtc/rtc-events"
import { cleanReason } from "./turn-outcome"

export function recordSignalRtt(event: SignalRttEvent, attrs: Record<string, string>): void {
  const rtt = { ...attrs, "rtc.signal_via": event.via, "rtc.signal_peer_present": String(event.peerPresent) }
  recordDistribution("rtc.signal_rtt_ms", event.ms, "millisecond", rtt)
  if (event.fromSeenMs !== undefined) recordDistribution("rtc.signal_rtt_from_seen_ms", event.fromSeenMs, "millisecond", rtt)
}

/** timeout or error: the one thing worth grouping a submit's failure by */
function submitReason(event: Extract<SubmitEvent, { kind: "retry" | "failed" }>): "timeout" | "error" {
  return event.kind === "failed" && event.timedOut ? "timeout" : "error"
}

/** `attrs` are the pair's, peer index and round, or the round alone for a room-level frame */
export function recordSubmitEvent(event: SubmitEvent, attrs: Record<string, string>): void {
  const frame = { "rtc.signal_frame": event.frame }
  if (event.kind === "slot_wait") {
    recordDistribution("rtc.signal_slot_wait_ms", event.waitedMs, "millisecond", { ...frame, ...attrs })
    return
  }
  if (event.kind === "replaced") {
    recordCount("rtc.signal_replaced", 1, { ...frame, ...attrs })
    return
  }
  recordCount("rtc.signal_problems", 1, { "rtc.signal_event": event.kind, ...frame, "rtc.signal_reason": submitReason(event), ...attrs })
}

/** the attributes of a failed submit's step: the error, masked for Sentry's scrubbing (mask-text.ts) and capped */
export function submitFailureAttrs(event: Extract<SubmitEvent, { kind: "failed" }>): Record<string, string> {
  return { "rtc.signal_frame": event.frame, "rtc.signal_reason": submitReason(event), "rtc.signal_error": cleanReason(event.reason) }
}

/** the store clock learned its margin, or a statement failed on both stamps */
export function recordStoreClockEvent(event: StoreClockEvent): void {
  const base = { "rtc.store_base": event.base }
  if (event.kind === "learned") recordDistribution("rtc.store_margin_ms", event.marginMs, "millisecond", base)
  else recordCount("rtc.store_time_rejected", 1, base)
}

/** a waiting-room calibration finished: its outcome, duration and margin */
export function recordStoreCalibration(result: StoreCalibration): void {
  const outcome = { "rtc.store_outcome": result.outcome }
  recordCount("rtc.store_calibration", 1, outcome)
  recordDistribution("rtc.store_calibration_ms", result.durationMs, "millisecond", outcome)
  recordDistribution("rtc.store_calibration_margin_ms", result.marginMs, "millisecond", outcome)
}

/** the host ended the statement subscription */
export function recordStoreInterrupted(reason: string): void {
  recordCount("rtc.store_interrupted", 1, { "rtc.store_reason": cleanReason(reason) })
}

/** the statement subscription was opened again after the host ended it */
export function recordStoreResubscribe(attempt: number): void {
  recordCount("rtc.store_resubscribe", 1, { "rtc.store_attempt": String(attempt) })
}
