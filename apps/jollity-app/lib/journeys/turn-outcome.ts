// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What happened to the relay credentials for one mesh open (lib/webrtc/ice.ts
 * TurnOutcome), written onto the journey it belongs to: `turn.received`
 * (true, false or cached), `turn.stage` and `turn.status` ("none" where the
 * outcome has none, so a later success never leaves an old refusal's values
 * beside it). A failure is the `turn-unavailable` kind, once per outcome, its
 * fingerprint the stage; the server's reason goes there alone, in the event's
 * context, masked for Sentry's scrubbing (mask-text.ts) and capped. Seconds left on good
 * credentials are a metric.
 */
import { recordDistribution, reportFailure, type Journey } from "../telemetry"
import type { TurnOutcome } from "../webrtc/ice"
import { maskSafe } from "./mask-text"

const REASON_CAP = 120

/** the server's text, with the masked words defused and capped */
export const cleanReason = (raw: string): string => maskSafe(raw).slice(0, REASON_CAP)

/** `round` is the 1-based round the mesh opened in */
export function recordTurnOutcome(journey: Journey, outcome: TurnOutcome, round: number): void {
  const failed = outcome.received === "false"
  journey.set({
    "turn.received": outcome.received,
    "turn.source": outcome.source ?? (outcome.received === "cached" ? "cache-hit" : "mesh"),
    "turn.stage": failed ? outcome.stage : "none",
    "turn.status": failed && outcome.status !== undefined ? String(outcome.status) : "none",
  })
  if (!failed) {
    recordDistribution("rtc.turn_ttl_left_s", outcome.ttlLeftS, "second", { "turn.received": outcome.received, round: String(round) })
    return
  }
  reportFailure(
    "turn-unavailable",
    { reason: outcome.cause ?? outcome.stage, context: { ...(outcome.status !== undefined ? { status: String(outcome.status) } : {}), detail: cleanReason(outcome.reason) } },
    journey,
  )
}
