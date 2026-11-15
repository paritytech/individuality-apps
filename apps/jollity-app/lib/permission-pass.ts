// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * ONE PASS OF THE PERMISSION SCREEN — every prompt, one at a time (the host
 * shows one modal per request), measured as journey.permissions.
 *
 * A refusal is the player's answer: `permission-refused`, expected. A
 * `host-error` means the host call itself failed and nobody was asked:
 * `host-call-failed`, never expected (lib/permissions.ts DenialReason).
 * Framework-free: the page passes callbacks for its row states.
 *
 * An automatic pass (a camera grant change, the app back in front) is quiet. It
 * marks no row as asking, so the screen holds until an answer changes, and it
 * reports no refusal, since the player already gave that answer and every
 * return to the front would file it again.
 */
import type { DenialReason, PermissionId, PermissionResult } from "./permissions"
import { reportFailure, startJourney } from "./telemetry"

export async function runPermissionPass(options: {
  items: readonly PermissionId[]
  request(id: PermissionId): Promise<PermissionResult>
  /** the TURN credential fetch the network grant started, if any */
  turnIssue(): Promise<void> | null
  /** whether that fetch brought relays */
  turnReceived(): boolean
  onAsking(id: PermissionId): void
  onResult(id: PermissionId, result: PermissionResult): void
  /** telemetry's own grant (lib/permissions.ts requestTelemetryGrant), asked
   *  right after the network grant. Its answer never changes the pass. */
  requestTelemetry(): Promise<boolean>
  automatic?: boolean
}): Promise<{ allGranted: boolean; cameraBlocked: boolean }> {
  const journey = startJourney("permissions", { "permissions.trigger": options.automatic ? "auto" : "tap" })
  let allGranted = true
  let cameraBlocked = false
  let firstRefusal: { id: PermissionId; reason: DenialReason } | null = null
  let turnSettled: Promise<void> = Promise.resolve()

  for (const id of options.items) {
    if (!options.automatic) options.onAsking(id)
    const step = journey.step(id)
    const result = await options.request(id)
    const reason: DenialReason = result.reason ?? "denied"
    step.end({ "permissions.result": result.ok ? "granted" : reason })
    options.onResult(id, result)
    allGranted = allGranted && result.ok
    if (id === "camera" && !result.ok) cameraBlocked = reason === "blocked" || reason === "no-camera"
    if (id === "network" && result.ok) {
      const issuing = options.turnIssue()
      if (issuing) {
        const turn = journey.step("network.turn-receipt")
        turnSettled = issuing.then(
          () => turn.end({ "turn.received": options.turnReceived() ? "true" : "false" }),
          () => turn.end({ "turn.received": "false" }),
        )
      }
      // telemetry's own prompt: the host shows one modal at a time, so it is
      // awaited here. A "no" is the player's choice about telemetry, not a
      // refusal of the game: it fails nothing and is only an attribute.
      const telemetry = await options.requestTelemetry().catch(() => false)
      journey.set({ "telemetry.grant": telemetry ? "granted" : "refused" })
    }
    if (!result.ok) {
      firstRefusal ??= { id, reason }
      if (reason === "host-error")
        reportFailure(
          "host-call-failed",
          { reason: `${id}.${result.step ?? "permission"}`, ...(result.detail ? { context: { detail: result.detail } } : {}) },
          journey,
        )
      else if (!options.automatic) reportFailure("permission-refused", { reason: `${id}.${reason}`, context: { step: id } }, journey)
    }
  }

  const refusal = firstRefusal
  void turnSettled.then(() => {
    if (allGranted) journey.end("granted")
    else if (refusal) journey.end("refused", { "permissions.step": refusal.id, "permissions.reason": refusal.reason })
  })
  return { allGranted, cameraBlocked }
}

/** Runs `run` unless a run on the same flag is still in flight.
 *
 * The flag belongs to the caller, a React ref on the page. It is set before
 * the first await, so two events in one tick both see a pass in flight, where
 * a phase read from the render would let both start one. A call that lands
 * during a run is dropped, and the next return to the front checks again. */
export async function runAlone(flag: { current: boolean }, run: () => Promise<void>): Promise<void> {
  if (flag.current) return
  flag.current = true
  try {
    await run()
  } finally {
    flag.current = false
  }
}
