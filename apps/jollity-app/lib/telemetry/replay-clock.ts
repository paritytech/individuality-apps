// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  BIG_GAP_MS,
  DEAD_BAND_MS,
  PEER_AGREE_MS,
  PEER_CHECK_MS,
  PEER_MIN,
  PEER_PING_MS,
  PEER_RTT_MAX_MS,
  SPEEDS,
} from "../clock-sync"
import { captureReplayObservation } from "./replay-capture"

/** Describes the existing source rules, not a bound on chain delivery or clock error. */
const REPLAY_CLOCK_RULES = {
  version: 3,
  offsetUnit: "millisecond",
  deviceClock: "source-step-free-device-clock",
  anchorClock: "engine-block-timestamp",
  anchorSelection: "strictly-advancing-chain-timestamp",
  deadBandMs: DEAD_BAND_MS,
  bigGapMs: BIG_GAP_MS,
  peerRttMaxMs: PEER_RTT_MAX_MS,
  peerPingMs: PEER_PING_MS,
  peerMin: PEER_MIN,
  peerAgreeMs: PEER_AGREE_MS,
  peerCheckMs: PEER_CHECK_MS,
  speeds: SPEEDS,
  unchangedPregameCaptureIntervalMs: 30_000,
  deliveryLatency: "unknown",
  alignmentUncertainty: "not-measured",
} as const

/** Passive evidence only. Never treat the block timestamp as its receipt time. */
export function captureReplayClock(
  kind: "clock-anchor" | "clock-decision" | "clock-state",
  evidence: Record<string, unknown>,
): void {
  try {
    captureReplayObservation(kind, { ...evidence, rules: REPLAY_CLOCK_RULES })
  } catch {
    // Instrumentation must never affect the source clock, even with a broken sink.
  }
}

/** Source device time is supplied by the caller; never substitute the shared clock. */
export function replayClockReceipt(deviceMs: number) {
  const sample = (read: () => number) => {
    try {
      const value = read()
      return Number.isFinite(value) ? value : null
    } catch {
      return null
    }
  }
  return {
    deviceMs,
    wallMs: sample(() => Date.now()),
    monotonicMs: sample(() => typeof performance !== "undefined" ? performance.now() : NaN),
    // The three reads are sequential, not a measured synchronization experiment.
    sampling: "sequential-callback-samples",
  }
}

/** Each source owns its gate. Active game anchors stay complete; ordinary pregame
 * receipts are periodic, with corrections and state changes captured immediately. */
export function createReplayClockAnchorCapture() {
  let lastCapturedDeviceMs: number | undefined
  let lastState: string | undefined
  return (evidence: Record<string, unknown>, deviceMs: number, active: boolean, state: unknown) => {
    try {
      const key = JSON.stringify(state)
      const changed = lastState !== key || evidence.beforeOffsetMs !== evidence.afterOffsetMs
      if (!active && !changed && lastCapturedDeviceMs !== undefined && deviceMs - lastCapturedDeviceMs < 30_000) return
      lastCapturedDeviceMs = deviceMs
      lastState = key
      captureReplayClock("clock-anchor", evidence)
    } catch {
      // The gate and the sink are both best effort.
    }
  }
}
