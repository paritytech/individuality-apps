// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The app-open permission check: anything missing sends the player to the
 * gate, which asks and returns. Fully granted players never see the gate.
 *
 * DEV ESCAPE HATCH: `NEXT_PUBLIC_SKIP_PERMISSION_GATE=1` (development builds
 * only — both are build-time constants, so production folds this away). The
 * gate is a one-time pass through /permissions whose camera step needs a real
 * camera; a headless browser has none, and a local run that only wants the home screen has no reason to click
 * through. It skips the CHECK, not the grants — the camera prompt still comes,
 * and the open still ends "ready" and asks telemetry's grant (gateCheckFor),
 * or a headless run would send nothing to Sentry.
 */
const SKIP_GATE =
  process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_SKIP_PERMISSION_GATE === "1"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { getGameSource } from "./game-source"
import { gateCheckFor, runGateCheck } from "./journeys/app-open"
import { allPermissionsGranted, syncTelemetryGrant } from "./permissions"
import { devLog } from "./debug/log-store"

/** Returns whether the check has finished (so a later host dialog, such as
 *  the update check's grant, never competes with it). */
export function usePermissionGate(): boolean {
  const router = useRouter()
  const [done, setDone] = useState(false)
  useEffect(() => {
    let cancelled = false
    void getGameSource().then(async (source) => {
      if (cancelled) return
      // A null source returns silently and a remembered pass never re-asks.
      // Both look identical from the home screen, so each writes its line.
      const outcome = await runGateCheck(source !== null, gateCheckFor(SKIP_GATE, allPermissionsGranted))
      if (outcome === "no-source") return devLog("permissions", "gate skipped: no source")
      devLog("permissions", `gate: ${outcome === "ready" ? "already granted" : "→ /permissions"}`)
      if (outcome === "gate" && !cancelled) router.replace("/permissions")
      // The gate passed: ask for telemetry's grant for THIS open (never
      // stored, see lib/permissions.ts), never awaited by the gate.
      if (outcome === "ready") void syncTelemetryGrant()
    }).finally(() => {
      if (!cancelled) setDone(true)
    })
    return () => {
      cancelled = true
    }
  }, [router])
  return done
}
