// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Numeric upload evidence is carried by manual transaction measurements.
 * User-defined span attributes arrive string-typed in Sentry EAP and are not
 * a valid aggregate transport for these values. */
import * as Sentry from "@sentry/react"
import { telemetryLive } from "./boot"
import { scopeTagAttrs } from "./scope-tags"

type MeasurementUnit = "bit_per_second" | "byte" | "millisecond" | "second" | "ratio" | "none"
export interface NumericMeasurement {
  value: number
  unit: MeasurementUnit
}

export type AdaptationMeasurementTransaction = "rtc.send_adaptation.change" | "rtc.send_adaptation.round"

const randomHex = (length: number): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(length / 2))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function captureMeasurementTransaction(
  name: AdaptationMeasurementTransaction,
  tags: Record<string, string>,
  measurements: Record<string, NumericMeasurement | undefined>,
  at: { startMs: number; endMs: number },
): "sent" | "skipped" | "too-many" {
  try {
    const finite = Object.fromEntries(
      Object.entries(measurements).filter((entry): entry is [string, NumericMeasurement] => entry[1] !== undefined && Number.isFinite(entry[1].value)),
    )
    const count = Object.keys(finite).length
    if (!Number.isFinite(at.startMs) || !Number.isFinite(at.endMs) || at.endMs < at.startMs || count === 0 || !telemetryLive()) return "skipped"
    if (count > 10) return "too-many"
    const traceId = randomHex(32)
    const spanId = randomHex(16)
    Sentry.captureEvent({
      type: "transaction",
      transaction: name,
      start_timestamp: at.startMs / 1_000,
      timestamp: at.endMs / 1_000,
      tags: { ...scopeTagAttrs(), ...tags },
      contexts: { trace: { trace_id: traceId, span_id: spanId, op: name, status: "ok" } },
      spans: [],
      measurements: finite,
    })
    return "sent"
  } catch {
    return "skipped"
  }
}
