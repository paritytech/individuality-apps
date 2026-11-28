// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// THE PERMISSION GATE, passed the way a player passes it (#284).
//
// `next dev` runs skip it (NEXT_PUBLIC_SKIP_PERMISSION_GATE, development builds
// only: lib/use-permission-gate.ts), but a DEPLOYED build has no such hatch, so
// the first open of every fresh host lands on /permissions. The bot taps
// "Allow access" and waits for the app to return home: the host's grants are
// auto-approved by the CLI, and the camera step uses the Chromium fake device
// the context already allows. First-time statement-store setup can take minutes,
// hence the long wait. A failed pass shows the failed rows and one line saying
// what fixes it, with no button, so the bot taps once and then only waits.
import type { Page } from "@playwright/test"
import { CAMERA_OFF_LINE, CAMERA_PERMISSION_COPY, NO_CAMERA_LINE } from "../../apps/jollity-app/lib/permission-copy"
import type { CameraUnavailableExpectation, CameraUnavailableReason } from "./profile"

export type PermissionGateResult =
  | { kind: "not-gate" }
  | { kind: "passed" }
  | { kind: "camera-unavailable"; reason: CameraUnavailableReason; helpShown: boolean; handedOver: boolean }

/** Is `url` the permission gate? (pure, vitest pins it) */
export function isGateUrl(url: string): boolean {
  try {
    return /^\/permissions\/?$/.test(new URL(url).pathname)
  } catch {
    return false
  }
}

export function cameraUnavailableOutcome(url: string, expected: CameraUnavailableExpectation, helpShown: boolean): Extract<PermissionGateResult, { kind: "camera-unavailable" }> {
  return { ...expected, helpShown, handedOver: !isGateUrl(url) }
}

/** Root decides the one-time redirect asynchronously. A terminal camera
 * profile must not call that briefly rendered home settled before it reaches
 * the gate whose failure UI it is here to prove. */
export function shouldWaitForExpectedPermissionGate(url: string, expected?: CameraUnavailableExpectation): boolean {
  if (!expected) return false
  try {
    return new URL(url).pathname === "/"
  } catch {
    return false
  }
}

/** The camera row and the footer line the gate shows for a terminal camera profile.
 *
 * The fixture-level camera denial of Chromium reaches the app as a blocked
 * browser permission, so a denied profile reads the Blocked row. */
export function expectedCameraHelp(reason: CameraUnavailableReason): { row: string; line: string } {
  return reason === "denied"
    ? { row: CAMERA_PERMISSION_COPY.blocked.row, line: CAMERA_OFF_LINE }
    : { row: CAMERA_PERMISSION_COPY["no-camera"].row, line: NO_CAMERA_LINE }
}

/** Taps Allow access once, then waits for the gate to let the page go.
 *
 * The result is `not-gate` when the page was not on the gate, `passed` when the
 * app left it, and `camera-unavailable` when an expected camera failure shows
 * its help or leaves the gate. It throws when the gate is still up after
 * `waitMs`, so a caller never waits forever. */
export async function passPermissionGate(
  page: Page,
  log: (line: string) => void = console.log,
  waitMs = 300_000,
  expected?: CameraUnavailableExpectation,
): Promise<PermissionGateResult> {
  if (!isGateUrl(page.url())) return { kind: "not-gate" }
  const started = Date.now()
  log("  permission gate: tapping Allow access")
  const button = page.getByRole("button", { name: /^Allow access$/ })
  await button.click({ timeout: 30_000 }).catch((error) => log(`  permission gate: tap failed (${String(error).split("\n")[0]})`))
  const ends = Date.now() + waitMs
  while (Date.now() < ends) {
    if (!isGateUrl(page.url())) {
      if (expected) return cameraUnavailableOutcome(page.url(), expected, false)
      log(`  permission gate: passed in ${((Date.now() - started) / 1000).toFixed(1)} s`)
      return { kind: "passed" }
    }
    if (expected) {
      const help = expectedCameraHelp(expected.reason)
      const [rowShown, lineShown] = await Promise.all([
        page.getByText(help.row, { exact: true }).isVisible().catch(() => false),
        page.getByRole("status").getByText(help.line, { exact: true }).isVisible().catch(() => false),
      ])
      if (rowShown && lineShown) {
        log(`  permission gate: expected ${expected.reason} help shown; staying on /permissions`)
        return cameraUnavailableOutcome(page.url(), expected, true)
      }
    }
    await page.waitForTimeout(Math.min(250, Math.max(1, ends - Date.now())))
  }
  const msg = `permission gate: still on /permissions after ${((Date.now() - started) / 1000).toFixed(0)} s`
  log(`  ${msg}`)
  throw new Error(msg)
}
