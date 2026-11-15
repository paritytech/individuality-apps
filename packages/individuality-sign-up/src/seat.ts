// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The seat, as the SDK decides it (`deriveSeat` / `readGameSeat` of
 * `@parity/product-sdk-individuality`: the route, and whether it can be
 * pressed now), with what Jollity adds on top: the name link (#456). A sign-up
 * never goes without the player's username linked, so while the link is on
 * its way no route is ready.
 */
import type { Seat } from "@parity/product-sdk-individuality"

/** The seat with the name link on top: not ready on any route while the link
 *  is on its way (`named: false`); absent, nothing waits on it. */
export function namedSeat(seat: Seat, named: boolean | undefined): Seat {
  return named === false ? { ...seat, ready: false } : seat
}

/** Thrown by `register()` when the account cannot pay the deposit route. */
export class SeatUnfundedError extends Error {
  constructor(
    readonly required: bigint,
    readonly free: bigint,
  ) {
    super(`account holds ${free} of the ${required} the deposit route needs`)
    this.name = "SeatUnfundedError"
  }
}
