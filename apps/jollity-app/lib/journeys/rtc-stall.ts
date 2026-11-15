// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE HEALTH LADDER'S STALLS AS TELEMETRY: a `connection_stalled` event is an
 * `rtc.stall` step (lib/journeys/game-trace.ts stallChanged), carrying the
 * ladder's reason and the last submit error, both masked for Sentry's
 * scrubbing (mask-text.ts); its `connection_recovered` ends the step with how it recovered and
 * sends `rtc.stall_ms`, how long the stall lasted.
 */
import { recordDistribution } from "../telemetry"
import { UNSUPPORTED } from "../webrtc/gather"
import { cleanReason } from "./turn-outcome"

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? cleanReason(value) : undefined)

/** what a `connection_stalled` event adds to its step */
export function stallStartAttrs(detail: Record<string, unknown> | undefined): Record<string, string> {
  const reason = text(detail?.reason)
  const lastError = text(detail?.lastError)
  return { ...(reason ? { "rtc.stall_reason": reason } : {}), ...(lastError ? { "rtc.last_error": lastError } : {}) }
}

/** `recoveredVia` of a `connection_recovered` event: self-heal, or a reconnect that was tapped */
export function recoveredVia(detail: Record<string, unknown> | undefined): string {
  return text(detail?.recoveredVia) ?? UNSUPPORTED
}

export function recordStall(detail: Record<string, unknown> | undefined, layer: string, attrs: Record<string, string>): void {
  recordDistribution("rtc.stall_ms", detail?.stallMs as number, "millisecond", { "rtc.layer": layer, "rtc.recovered_via": recoveredVia(detail), ...attrs })
}
