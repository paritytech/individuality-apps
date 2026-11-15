// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * Boots the debug log and Sentry on the client. Mounted once in the root layout.
 *
 * `initTelemetry` starts the on-device debug log (lib/debug/telemetry.ts) and
 * installs the global error hooks; it MUST run in the browser, never during
 * SSR/prerender, so it lives in this effect. `startTelemetry` (Sentry, only
 * with a DSN) runs whatever DEBUG_LOGS says: it is idempotent, and any
 * telemetry call made earlier has already started it.
 */
import { useEffect } from "react"
import { DEBUG_LOGS } from "@/lib/debug/flag"
import { initTelemetry } from "@/lib/debug/telemetry"
import { checkWorkerHeartbeat, startTelemetry } from "@/lib/telemetry"
import { WORKER_HEARTBEAT_GRACE_MS } from "@/lib/telemetry/worker-heartbeat"
import { startClockTracking } from "@/lib/telemetry/clock"
import { watchForegroundReturns } from "@/lib/telemetry/foreground"
import { watchLongSuspensionReload } from "@/lib/resume-reload"
import { watchStartOver } from "@/lib/start-over"
import { DebugTools } from "./debug-tools"

export function DebugBoot() {
  useEffect(() => {
    const stopClock = startClockTracking()
    startTelemetry()
    const workerHeartbeat = setTimeout(() => void checkWorkerHeartbeat(), WORKER_HEARTBEAT_GRACE_MS)
    const stopResumeReload = watchLongSuspensionReload()
    // back from another product the game was handed over to: start over (#465)
    const stopStartOver = watchStartOver()
    const stopForeground = watchForegroundReturns()
    if (DEBUG_LOGS) initTelemetry()
    return () => {
      clearTimeout(workerHeartbeat)
      stopClock()
      stopForeground()
      stopResumeReload()
      stopStartOver()
    }
  }, [])
  if (!DEBUG_LOGS) return null
  return <DebugTools />
}
