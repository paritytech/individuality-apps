// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A PRIZE CLAIMED ONCE THE CHAIN WOULD PAY IT, with no button.
 *
 * `Game.claim_airdrop` pays a winner who is recognized or has reached
 * personhood, and whose last attended game is this one. The chain writes both
 * to `Score.Participants` when it applies the player's attendance: early, once
 * the votes still to come can no longer change it (#1096), or at the settle.
 * So the claim waits for that (`attendanceApplied`, ./attendance-watch.ts),
 * reads the draw again, and sends only when the read says the chain would pay:
 * a refused claim costs a fee.
 *
 * It says what happened, and the product says it in its own words.
 */

/** what the claim reads of one prize draw */
export interface PayableDraw {
  /** the prize is already claimed */
  claimed?: boolean
  /** the chain would pay a claim now */
  claimable: boolean
}

export type ClaimRun<D extends PayableDraw> =
  /** `now`: this run sent the claim; otherwise it was claimed already */
  | { kind: "claimed"; now: boolean }
  /** the chain would not pay it: the draw read says why */
  | { kind: "not-payable"; draw: D }
  /** the draw is not there to claim */
  | { kind: "no-draw" }
  /** the wait for the attendance gave up (the game never settled) */
  | { kind: "no-attendance"; error: unknown }
  /** the draw could not be read after the attendance landed */
  | { kind: "unreadable"; error: unknown }
  /** the claim was sent and did not land */
  | { kind: "not-claimed"; error: unknown }

export interface ClaimWhenPayableOptions<D extends PayableDraw> {
  /** resolves once the chain has applied the player's attendance in the draw's game */
  attendanceApplied(): Promise<void>
  /** the draw as the chain has it now; undefined when it is not there */
  readDraw(): Promise<D | undefined>
  claim(): Promise<void>
  /** the claim is about to be sent */
  onClaiming?(): void
}

/** Waits until the chain would pay the prize (the module header says when), then claims it once. */
export async function claimWhenPayable<D extends PayableDraw>(options: ClaimWhenPayableOptions<D>): Promise<ClaimRun<D>> {
  try {
    await options.attendanceApplied()
  } catch (error) {
    return { kind: "no-attendance", error }
  }
  let draw: D | undefined
  try {
    draw = await options.readDraw()
  } catch (error) {
    return { kind: "unreadable", error }
  }
  if (!draw) return { kind: "no-draw" }
  if (draw.claimed) return { kind: "claimed", now: false }
  if (!draw.claimable) return { kind: "not-payable", draw }
  options.onClaiming?.()
  try {
    await options.claim()
    return { kind: "claimed", now: true }
  } catch (error) {
    return { kind: "not-claimed", error }
  }
}
