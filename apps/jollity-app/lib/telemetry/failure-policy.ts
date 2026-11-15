// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Pure failure policy shared by production delivery and the test doorway. */

type ReasonDetails = { reason: string }
type ExpectedMarkable = { set(attrs: Record<string, string>): void }

/** permission reasons that are the player's (or their device's) answer */
const EXPECTED_PERMISSION = new Set(["denied", "blocked", "busy", "no-camera", "timeout"])

export function isExpected(kind: string, details: ReasonDetails): boolean {
  switch (kind) {
    case "permission-refused":
      return EXPECTED_PERMISSION.has(details.reason.slice(details.reason.lastIndexOf(".") + 1))
    case "camera-unavailable":
      return details.reason === "denied"
    case "signup-failed":
      return details.reason === "signing-refused" || details.reason === "not-eligible"
    case "claim-failed":
      return details.reason === "cancelled"
    // the sign-up itself went out: only its draw ticket is missing
    case "draw-skipped":
      return true
    // the player declined to sign, or the chain says nobody owns the name
    case "name-link-failed":
      return details.reason === "not-signed" || details.reason === "unowned"
    default:
      return false
  }
}

const unexpected = new WeakSet<object>()

/** `journey.expected` is "true" only while every failure on it was expected. */
export function markExpected(journey: ExpectedMarkable | undefined, expected: boolean): void {
  if (!journey) return
  if (!expected) unexpected.add(journey)
  journey.set({ "journey.expected": expected && !unexpected.has(journey) ? "true" : "false" })
}
