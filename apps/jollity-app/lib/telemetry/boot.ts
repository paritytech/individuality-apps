// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE BOOT: start Sentry once, and the live rule every doorway function
 * checks. Its own module so that metrics.ts can use the same rule without
 * importing the index (which re-exports metrics: a cycle).
 */
import { devLog } from "../debug/log-store"
import { insideContainer } from "../host/container"
import { describeError } from "../host/error-detail"
import { DEBUG_LOGS } from "../debug/flag"
import { closeExpiredDeliveryHealth, LATE_UPLOAD_DELAY_MS, installHandoverSink, uploadLateGameLog } from "./game-log"
import { detectHostKind } from "./environment"
import { configFromEnvironment, setHostKind, startTelemetryWith, telemetryStarted, type TelemetryConfig } from "./init"
import { uploadLateTelemetryHealth } from "./health-event"
import { installGameLogOutbox } from "./game-log-outbox"

let booted = false

async function refineHostKind(config: TelemetryConfig): Promise<void> {
  try {
    const kind = detectHostKind({ ...config, inContainer: await insideContainer() })
    setHostKind(kind)
    devLog("telemetry", `host kind ${kind}`)
  } catch {
    /* the boot guess stands */
  }
}

/** Start Sentry once. A no-op without a DSN. */
export function startTelemetry(): void {
  if (booted) return
  booted = true
  try {
    const config = configFromEnvironment()
    if (!config || !startTelemetryWith(config)) return
    void refineHostKind(config)
    if (DEBUG_LOGS) {
      installHandoverSink()
      installGameLogOutbox()
    }
    setTimeout(() => {
      void closeExpiredDeliveryHealth()
        .catch((error: unknown) => {
          devLog("telemetry", "late game health could not be closed", { detail: describeError(error) }, "warn")
        })
        .finally(() => {
          void uploadLateTelemetryHealth().catch((error: unknown) => {
            devLog("telemetry", "late telemetry health upload failed", { detail: describeError(error) }, "warn")
            return false
          })
        })
      // The game log is primary evidence and must never wait behind health-
      // store recovery or the health event's idle/delivery path.
      if (DEBUG_LOGS)
        void uploadLateGameLog().catch((error: unknown) => {
          devLog("telemetry", "late game log upload failed", { detail: describeError(error) }, "warn")
          return false
        })
    }, LATE_UPLOAD_DELAY_MS)
  } catch {
    /* telemetry never breaks the app */
  }
}

/** Sentry is running. For sibling modules. */
export function telemetryLive(): boolean {
  try {
    startTelemetry()
    return telemetryStarted()
  } catch {
    return false
  }
}
